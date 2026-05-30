# Dilla — secrets management playbook

Companion to:

- `deploy/systemd/HARDENING.md` (the `LoadCredential=` directive)
- `deploy/docker/compose.yml` (Docker `secrets:` block)
- `deploy/turn/README.md` (Cloudflare TURN token scope)
- `.security-hardening/09-infra-security.md`

Scope: where and how to store every secret Dilla touches. The right
answer scales with operator size — this doc tiers the choices.

---

## Inventory

Eleven secrets total. Six are server-side env vars (or `_FILE` files);
two live on the client; three are outbound credentials operators bring
themselves.

| # | Secret | Where it lives | Rotatable | Sensitive |
|---|---|---|---|---|
| 1 | `DILLA_DB_PASSPHRASE` (`_FILE`) | server env / file | yes (SQLCipher `PRAGMA rekey`) | critical |
| 2 | `DILLA_JWT_SECRET` (`_FILE`) | server env / file | yes (restart, all tokens invalid) | high |
| 3 | `DILLA_JOIN_SECRET` (`_FILE`) | server env / file | yes (restart, outstanding join tokens invalid) | high |
| 4 | `DILLA_CF_TURN_KEY_ID` + `DILLA_CF_TURN_API_TOKEN` (`_FILE`) | server env / file | yes (Cloudflare API) | medium |
| 5 | `DILLA_TLS_CERT` / `DILLA_TLS_KEY` | path on disk | yes (ACME/`certbot`) | high |
| 6 | Bootstrap token | `${DATA_DIR}/BOOTSTRAP_TOKEN` mode 0600 | self-expires (15 min) | high while live |
| 7 | Per-user Ed25519 identity private key | client (Tauri keychain / WebView IndexedDB, sessionStorage encrypted) | per-user | critical |
| 8 | Per-user Signal ratchet state | client (WebView IndexedDB) | per-message | critical |
| 9 | OTel exporter auth header (`DILLA_OTEL_API_KEY` (`_FILE`)) | server env / file | per provider | medium |
| 10 | `DILLA_SENTRY_DSN` (`_FILE`) | server env / file | per provider | medium (embeds ingest key) |
| 11 | Federation peer pubkeys (future, post VULN-002 redesign) | server config / DB | n/a (rotate the keypair) | low (public) |

Full rotation cadence and procedures in [`ROTATION.md`](./ROTATION.md).
Pre-flight checklist in [`CHECKLIST.md`](./CHECKLIST.md). Minimum-
privilege policy templates in [`IAM.md`](./IAM.md). Forward-looking
HSM / TPM notes in [`HSM.md`](./HSM.md).

---

## The `_FILE` convention

Every secret-bearing env var also accepts a `_FILE` variant. When the
`_FILE` variant is set, Dilla reads the secret from that path, trims
trailing whitespace (the classic `echo "x" > f` newline gotcha), and
ignores the non-`_FILE` env var. This matches the Docker secrets
convention used by the Postgres / Redis / MariaDB images.

Variables supported as of the change that introduced this guide:

```
DILLA_DB_PASSPHRASE      <-> DILLA_DB_PASSPHRASE_FILE
DILLA_JWT_SECRET         <-> DILLA_JWT_SECRET_FILE
DILLA_JOIN_SECRET        <-> DILLA_JOIN_SECRET_FILE
DILLA_CF_TURN_API_TOKEN  <-> DILLA_CF_TURN_API_TOKEN_FILE
DILLA_OTEL_API_KEY       <-> DILLA_OTEL_API_KEY_FILE
DILLA_SENTRY_DSN         <-> DILLA_SENTRY_DSN_FILE
```

Pick `_FILE` whenever the secret can be materialized to a path —
systemd `LoadCredential`, Docker secrets, Vault Agent templates,
sops-decrypted files, or a cloud secret manager mounted via tmpfs.

---

## Tier 1 — Single-box / hobby

> One operator, one VPS / home server, ~5 users.

Goal: keep secrets off `ps`, journalctl, and shell history. Don't
deploy Vault to run a 5-person Discord clone.

### 1a. `.env` at `/etc/dilla/dilla.env`

```sh
sudo install -d -m 0750 -o root -g dilla /etc/dilla
sudo install -m 0640 -o root -g dilla /dev/null /etc/dilla/dilla.env
sudoedit /etc/dilla/dilla.env
```

`/etc/dilla/dilla.env`:

```env
DILLA_DOMAIN=chat.example.org
DILLA_DATA_DIR=/var/lib/dilla
DILLA_DB_PASSPHRASE_FILE=%d/db_passphrase
DILLA_JOIN_SECRET_FILE=%d/join_secret
DILLA_CF_TURN_KEY_ID=cf-key-id-here
DILLA_CF_TURN_API_TOKEN_FILE=%d/cf_turn_api_token
DILLA_ALLOWED_ORIGINS=https://chat.example.org
DILLA_TRUSTED_PROXIES=127.0.0.1/32,::1/128
DILLA_INSECURE=false
```

The `%d` placeholder is systemd's runtime credential directory (filled
in at unit start when the secret is loaded via `LoadCredential=`).
This keeps the secret values themselves out of the env file — the env
file just points at runtime credential paths.

### 1b. Bind it to the existing systemd unit

The `deploy/systemd/dilla-server.service` unit from §I3 already wires
`LoadCredential=db_passphrase:/etc/dilla/secrets/db_passphrase`. Add
one line per additional secret, then extend `EnvironmentFile=`:

```ini
[Service]
EnvironmentFile=/etc/dilla/dilla.env

LoadCredential=db_passphrase:/etc/dilla/secrets/db_passphrase
LoadCredential=join_secret:/etc/dilla/secrets/join_secret
LoadCredential=cf_turn_api_token:/etc/dilla/secrets/cf_turn_api_token
LoadCredential=jwt_secret:/etc/dilla/secrets/jwt_secret  # optional
LoadCredential=otel_api_key:/etc/dilla/secrets/otel_api_key  # optional
LoadCredential=sentry_dsn:/etc/dilla/secrets/sentry_dsn  # optional
```

Generate + place the secrets, mode 0400, owner `root` (systemd reads
them as root before dropping to `dilla`):

```sh
sudo install -d -m 0700 /etc/dilla/secrets
openssl rand -base64 48 | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/db_passphrase
openssl rand -base64 48 | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/join_secret
printf '%s' "$CF_TURN_API_TOKEN_FROM_DASHBOARD" \
  | sudo install -m 0400 /dev/stdin /etc/dilla/secrets/cf_turn_api_token
sudo systemctl daemon-reload && sudo systemctl restart dilla-server
```

`LoadCredential` copies the file into a tmpfs at `/run/credentials/
dilla-server.service/<name>` mode 0400 owned by `dilla` for the
lifetime of the process. Backups of `/etc/dilla` are still the source
of truth — encrypt them (see CHECKLIST §10).

### 1c. The simple-Docker variant

If you run Compose instead of native systemd, the
`deploy/docker/compose.yml` already declares Docker secrets. Each
`/run/secrets/<name>` is a tmpfs file mode 0400 owned by the
container user; point the `_FILE` env vars at those paths:

```yaml
services:
  dilla-server:
    image: ghcr.io/dilla-chat/server:latest
    secrets:
      - db_passphrase
      - join_secret
      - cf_turn_api_token
    environment:
      DILLA_DB_PASSPHRASE_FILE: /run/secrets/db_passphrase
      DILLA_JOIN_SECRET_FILE: /run/secrets/join_secret
      DILLA_CF_TURN_API_TOKEN_FILE: /run/secrets/cf_turn_api_token

secrets:
  db_passphrase:
    file: /etc/dilla/secrets/db_passphrase
  join_secret:
    file: /etc/dilla/secrets/join_secret
  cf_turn_api_token:
    file: /etc/dilla/secrets/cf_turn_api_token
```

---

## Tier 2 — Small team / single org

> Two-or-three-person ops team, possibly multiple hosts.

Goal: avoid plaintext secrets in `/etc/dilla/secrets`. Use the OS
keystore for the operator's seed material, fetch on unit start, hand
to systemd via `LoadCredential`.

### 2a. macOS Keychain (operator workstation, single Mac mini)

Stash:

```sh
security add-generic-password \
  -s dilla.db_passphrase \
  -a dilla \
  -w "$(openssl rand -base64 48)" \
  -U
```

Read at unit start (wrap a shell helper in a `LoadCredentialEncrypted=`
script):

```sh
#!/bin/sh
# /usr/local/libexec/dilla-fetch-secret
set -eu
name="$1"
security find-generic-password -s "dilla.$name" -a dilla -w
```

systemd unit (or launchd `KeepAlive` wrapper) calls
`dilla-fetch-secret db_passphrase` → writes to the runtime credential
directory → `_FILE` env points there.

### 2b. Linux Secret Service (`secret-tool`)

GNOME Keyring / KeePassXC both expose `org.freedesktop.secrets`:

```sh
echo -n "$(openssl rand -base64 48)" \
  | secret-tool store --label='Dilla DB passphrase' service dilla key db_passphrase
```

Fetch helper:

```sh
#!/bin/sh
# /usr/local/libexec/dilla-fetch-secret
set -eu
name="$1"
secret-tool lookup service dilla key "$name"
```

Plug into the systemd unit as a one-shot `ExecStartPre=`:

```ini
[Service]
ExecStartPre=/bin/sh -c '/usr/local/libexec/dilla-fetch-secret db_passphrase > ${RUNTIME_DIRECTORY}/db_passphrase'
ExecStartPre=/bin/chmod 0400 ${RUNTIME_DIRECTORY}/db_passphrase
RuntimeDirectory=dilla-server
Environment=DILLA_DB_PASSPHRASE_FILE=%t/dilla-server/db_passphrase
```

`%t` resolves to `/run` so the resulting path is
`/run/dilla-server/db_passphrase`. `RuntimeDirectory=` is a tmpfs and
is unlinked on stop.

### 2c. Windows Credential Manager (rare for Dilla, but documented)

`cmdkey /generic:dilla.db_passphrase /user:dilla /pass:...` — use
`Get-Credential` from a wrapper service that writes the secret to the
service's working directory at start.

---

## Tier 3 — Serious self-host

> A few hosts, multiple operators, GitOps, you want audit trails.

Pick one: **Vault OSS** (or its fork **OpenBao**) for centralized
secret storage with leases + audit logs, *or* **sops + age** for
GitOps-friendly encrypted-at-rest files.

### 3a. Vault OSS / OpenBao with Vault Agent templates

Stash:

```sh
vault kv put secret/dilla/server \
  db_passphrase="$(openssl rand -base64 48)" \
  join_secret="$(openssl rand -base64 48)" \
  cf_turn_api_token="$CF_TURN_API_TOKEN"
```

`/etc/vault-agent/dilla.hcl`:

```hcl
pid_file = "/run/vault-agent-dilla.pid"

vault {
  address = "${VAULT_ADDR}"
  retry { num_retries = 5 }
}

auto_auth {
  method "approle" {
    config = {
      role_id_file_path   = "/etc/vault-agent/role_id"
      secret_id_file_path = "/etc/vault-agent/secret_id"
      remove_secret_id_file_after_reading = false
    }
  }
  sink "file" {
    config = { path = "/run/vault-agent/.vault-token" }
  }
}

# Render each secret to a tmpfs path under /run/dilla/secrets/.
# Restart the dilla-server unit on every change so PRAGMA rekey /
# join_secret rotation kicks in without manual intervention.
template {
  destination = "/run/dilla/secrets/db_passphrase"
  perms       = "0400"
  contents    = <<-EOT
    {{ with secret "secret/data/dilla/server" }}{{ .Data.data.db_passphrase }}{{ end }}
  EOT
  exec {
    command = ["systemctl", "restart", "dilla-server.service"]
  }
}

template {
  destination = "/run/dilla/secrets/join_secret"
  perms       = "0400"
  contents    = <<-EOT
    {{ with secret "secret/data/dilla/server" }}{{ .Data.data.join_secret }}{{ end }}
  EOT
  exec {
    command = ["systemctl", "restart", "dilla-server.service"]
  }
}

template {
  destination = "/run/dilla/secrets/cf_turn_api_token"
  perms       = "0400"
  contents    = <<-EOT
    {{ with secret "secret/data/dilla/server" }}{{ .Data.data.cf_turn_api_token }}{{ end }}
  EOT
  exec {
    command = ["systemctl", "restart", "dilla-server.service"]
  }
}
```

Point Dilla at the rendered paths:

```env
DILLA_DB_PASSPHRASE_FILE=/run/dilla/secrets/db_passphrase
DILLA_JOIN_SECRET_FILE=/run/dilla/secrets/join_secret
DILLA_CF_TURN_API_TOKEN_FILE=/run/dilla/secrets/cf_turn_api_token
```

Vault Agent inherits the AppRole identity. See [`IAM.md`](./IAM.md) for
the read-only policy template (`path "secret/data/dilla/*" { capabilities
= ["read"] }`). OpenBao is API-compatible — same HCL works.

### 3b. sops + age (GitOps without a server)

`secrets.enc.yaml` lives in your IaC repo, encrypted at rest with one
or more age recipients (each operator and each host's age key). At
deploy time you decrypt to tmpfs and start Dilla.

Generate keys:

```sh
# operator key
age-keygen -o ~/.config/sops/age/keys.txt

# host key (kept on the host)
sudo install -d -m 0700 /etc/dilla/age
age-keygen -o /etc/dilla/age/keys.txt
sudo chmod 0400 /etc/dilla/age/keys.txt
```

`.sops.yaml` at the repo root:

```yaml
creation_rules:
  - path_regex: deploy/secrets/dilla\..*\.enc\.yaml$
    age: >-
      age1operator...,
      age1host...
```

Create the secrets file:

```sh
cat > /tmp/dilla.prod.yaml <<'EOF'
db_passphrase: REPLACE_ME_WITH_RAND
join_secret: REPLACE_ME_WITH_RAND
cf_turn_api_token: REPLACE_ME
EOF
sops --encrypt --in-place /tmp/dilla.prod.yaml
mv /tmp/dilla.prod.yaml deploy/secrets/dilla.prod.enc.yaml
git add deploy/secrets/dilla.prod.enc.yaml && git commit -m 'chore(secrets): prod'
```

Decrypt at boot via a one-shot systemd unit:

```ini
# /etc/systemd/system/dilla-secrets.service
[Unit]
Description=Render Dilla secrets from sops
Before=dilla-server.service

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=SOPS_AGE_KEY_FILE=/etc/dilla/age/keys.txt
RuntimeDirectory=dilla-server-secrets
RuntimeDirectoryMode=0700
ExecStart=/bin/sh -c '\
  sops --decrypt /etc/dilla/secrets/dilla.prod.enc.yaml \
    | yq -r .db_passphrase     > ${RUNTIME_DIRECTORY}/db_passphrase && \
  sops --decrypt /etc/dilla/secrets/dilla.prod.enc.yaml \
    | yq -r .join_secret       > ${RUNTIME_DIRECTORY}/join_secret && \
  sops --decrypt /etc/dilla/secrets/dilla.prod.enc.yaml \
    | yq -r .cf_turn_api_token > ${RUNTIME_DIRECTORY}/cf_turn_api_token && \
  chmod 0400 ${RUNTIME_DIRECTORY}/*'

[Install]
WantedBy=multi-user.target
```

Then in `dilla-server.service`:

```ini
[Unit]
Requires=dilla-secrets.service
After=dilla-secrets.service

[Service]
Environment=DILLA_DB_PASSPHRASE_FILE=/run/dilla-server-secrets/db_passphrase
Environment=DILLA_JOIN_SECRET_FILE=/run/dilla-server-secrets/join_secret
Environment=DILLA_CF_TURN_API_TOKEN_FILE=/run/dilla-server-secrets/cf_turn_api_token
```

Rotate by re-encrypting the file (`sops deploy/secrets/dilla.prod.enc.yaml`),
committing, deploying, restarting. No long-running secret server.

---

## Tier 4 — Cloud / multi-region

> AWS / GCP / Azure-native; you already have a KMS + Secrets Manager.

Dilla doesn't ship provider-specific IaC for this tier — the `_FILE`
convention means any provider's CSI driver / sidecar / init container
works without code changes.

### Pattern (provider-agnostic)

1. Stash the secret in the provider's secret store (AWS Secrets
   Manager / GCP Secret Manager / Azure Key Vault).
2. Mount as a file on tmpfs via the provider's CSI driver / sidecar:
   - **AWS:** `secrets-store-csi-driver` + `aws-provider` mounts to
     `/mnt/secrets-store/db_passphrase`. EKS Pod Identity grants
     `secretsmanager:GetSecretValue` on the matching ARN only.
   - **GCP:** `secrets-store-csi-driver-provider-gcp` + Workload
     Identity. IAM grants `roles/secretmanager.secretAccessor` on the
     matching secret only.
   - **Azure:** `secrets-store-csi-driver-provider-azure` + Workload
     Identity + a Key Vault access policy with `get` only.
3. Point Dilla at the mounted path:
   ```yaml
   env:
     - name: DILLA_DB_PASSPHRASE_FILE
       value: /mnt/secrets-store/db_passphrase
   ```

Rotation is the provider's job — when the underlying secret rotates,
the CSI driver re-renders the file. Combine with the k8s rollout
restart from `deploy/k8s/podsecurity.yaml` (`kubectl rollout restart
deployment/dilla-server`) to pick up new values.

### Minimum-privilege policy templates

See [`IAM.md`](./IAM.md). Highlights:

- AWS: `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:*:*:secret:dilla/*` only.
- GCP: `roles/secretmanager.secretAccessor` on `projects/<id>/secrets/dilla-*` only.
- Azure: Key Vault access policy with `get` permission only, no `list`.

---

## Backups and disaster recovery

The SQLCipher passphrase is the single most important secret. Lose it
and the database is permanently unrecoverable. Recommendations:

- Store at least one offline copy of the passphrase (paper, hardware
  token, sealed envelope) **outside** any encrypted backup that uses
  the same passphrase.
- Backups of `${DATA_DIR}` must themselves be encrypted (e.g.
  `restic`, `borg`) with a *different* key, because the SQLCipher DB
  file plus a leaked passphrase is full game-over.
- The bootstrap token file `${DATA_DIR}/BOOTSTRAP_TOKEN` should be
  removed from any image / template / golden snapshot you take of a
  live host — it self-expires in 15 min but shouldn't end up in
  long-lived artifacts.

See `deploy/secrets/CHECKLIST.md` items 9-11.

---

## What this doc deliberately doesn't cover

- **Paid SaaS secret managers (Doppler, Infisical, 1Password Connect)** —
  fine if you already have them; the `_FILE` convention works with
  their CLI fetch + write-to-tmpfs patterns. Not documented as a
  default because we recommend OSS first.
- **AWS KMS / Cloud HSM-backed envelope encryption of the SQLCipher
  passphrase** — see [`HSM.md`](./HSM.md) for the forward-looking
  recommendation.
- **Per-user identity keys** — handled by the Tauri keychain on
  desktop and the encrypted sessionStorage layer in the WebView
  (`06-frontend-hardening.md` F4). The operator can't and shouldn't
  see these.
