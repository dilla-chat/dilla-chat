# Dilla — least-privilege IAM templates

When you integrate Dilla with a secret manager (Tier 3 / 4 in
`README.md`), grant the **smallest possible** policy: read the
relevant secret paths only.

Each section below provides a copy-paste IaC snippet that can be
applied as-is to a real backend (sub the placeholders) without
granting any cross-secret or cross-account power.

---

## HashiCorp Vault OSS / OpenBao

Dilla needs to **read** its own secret bundle. Nothing else.

`policies/dilla-server.hcl`:

```hcl
# Read the Dilla secret bundle. KV v2 splits the path into
# `secret/data/<name>` for reads and `secret/metadata/<name>` for
# listing — we only grant the data path.
path "secret/data/dilla/*" {
  capabilities = ["read"]
}

# Required by Vault Agent for sink + token renewal. Standard.
path "auth/token/renew-self" {
  capabilities = ["update"]
}
path "auth/token/lookup-self" {
  capabilities = ["read"]
}

# Explicit deny for the wildcard fallbacks operators forget about.
path "secret/data/*" {
  capabilities = ["deny"]
}
path "sys/*" {
  capabilities = ["deny"]
}
```

Apply:

```sh
vault policy write dilla-server policies/dilla-server.hcl
```

Bind the policy to the Vault Agent's AppRole (AppRole is the
recommended auth method for an unattended server process):

```sh
vault auth enable approle  # idempotent

vault write auth/approle/role/dilla-server \
  token_policies="dilla-server" \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=0 \
  secret_id_num_uses=0

# Bootstrap role_id + secret_id into the Vault Agent host.
vault read -field=role_id auth/approle/role/dilla-server/role-id \
  | sudo install -m 0400 /dev/stdin /etc/vault-agent/role_id

vault write -force -field=secret_id auth/approle/role/dilla-server/secret-id \
  | sudo install -m 0400 /dev/stdin /etc/vault-agent/secret_id
```

The Vault Agent template config in `README.md` §3a uses this identity.
The policy grants **read only**: no write, no list, no delete, no
ability to mint child tokens with broader power.

> [!NOTE]
> Audit Vault with `vault audit enable file file_path=/var/log/
> vault-audit.log` and tail it during the first week of operation.
> Every secret read shows up; you'll catch a misconfigured Vault Agent
> immediately.

OpenBao is API-compatible — the same HCL works without modification.

---

## AWS Secrets Manager

The Pod / EC2 instance / Lambda running Dilla needs to call
`GetSecretValue` on **only** the `dilla/*` prefix. Nothing else.

`iam-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadDillaSecrets",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": [
        "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:dilla/*"
      ]
    },
    {
      "Sid": "DenyOtherSecrets",
      "Effect": "Deny",
      "Action": "secretsmanager:*",
      "NotResource": [
        "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:dilla/*"
      ]
    }
  ]
}
```

Apply via Terraform:

```hcl
resource "aws_iam_policy" "dilla_secrets_read" {
  name        = "dilla-server-secrets-read"
  description = "Dilla server: read its own secrets only"
  policy      = file("${path.module}/iam-policy.json")
}

resource "aws_iam_role_policy_attachment" "dilla_secrets_read" {
  role       = aws_iam_role.dilla_server_task_role.name
  policy_arn = aws_iam_policy.dilla_secrets_read.arn
}
```

Pair with the CSI driver to mount the secret as a file:

```yaml
# SecretProviderClass
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: dilla-secrets
spec:
  provider: aws
  parameters:
    objects: |
      - objectName: "dilla/db_passphrase"
        objectType: "secretsmanager"
        objectAlias: "db_passphrase"
      - objectName: "dilla/join_secret"
        objectType: "secretsmanager"
        objectAlias: "join_secret"
      - objectName: "dilla/cf_turn_api_token"
        objectType: "secretsmanager"
        objectAlias: "cf_turn_api_token"
```

Dilla container points `DILLA_*_FILE` env vars at the mount paths.

---

## GCP Secret Manager

Grant `roles/secretmanager.secretAccessor` on **each individual
secret**, not at project level.

```hcl
# terraform/dilla-secrets.tf

resource "google_secret_manager_secret" "db_passphrase" {
  secret_id = "dilla-db-passphrase"

  replication {
    user_managed {
      replicas { location = "europe-west1" }
      replicas { location = "europe-west4" }
    }
  }
}

resource "google_secret_manager_secret_iam_member" "dilla_server_db_passphrase" {
  project   = google_secret_manager_secret.db_passphrase.project
  secret_id = google_secret_manager_secret.db_passphrase.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.dilla_server.email}"
}

# Repeat for join_secret, cf_turn_api_token, jwt_secret, otel_api_key,
# sentry_dsn — one IAM member per (secret, principal) pair so a
# rotation of one secret doesn't leak access to another.
```

The Dilla service account gets `secretAccessor` on each Dilla secret
**individually** — never `roles/secretmanager.viewer` at the project
level, never `roles/secretmanager.admin`. The `secretAccessor` role
is `secretmanager.versions.access` only — no list, no destroy, no
update.

For Workload Identity in GKE:

```hcl
resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.dilla_server.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[dilla/dilla-server]"
}
```

Mount via the GCP provider for `secrets-store-csi-driver`. Same
filesystem pattern as AWS.

---

## Azure Key Vault

Use a Key Vault **access policy** (or RBAC, depending on your vault's
permission model) that grants `get` only on Dilla secrets.

```hcl
resource "azurerm_key_vault" "dilla" {
  name                = "kv-dilla-${var.environment}"
  resource_group_name = azurerm_resource_group.dilla.name
  location            = azurerm_resource_group.dilla.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  enable_rbac_authorization = true
  purge_protection_enabled  = true
}

resource "azurerm_role_assignment" "dilla_server_secrets_read" {
  scope                = azurerm_key_vault.dilla.id
  role_definition_name = "Key Vault Secrets User"  # get + list versions only
  principal_id         = azurerm_user_assigned_identity.dilla_server.principal_id
}
```

`Key Vault Secrets User` is the read-only role — `get` and `list
versions` of secret values, no `set`, no `delete`, no certificate
access, no key access.

For Workload Identity on AKS, mount via the Azure provider for
`secrets-store-csi-driver`. The DataActions narrow what the workload
can do beyond what the role grants.

---

## Common anti-patterns (avoid)

- **Granting `secretsmanager:*` or `*` to the workload identity.**
  Even "we'll restrict it later" is a footgun. Start at zero, add
  only what fails.
- **Sharing one IAM role across multiple services.** Each service —
  Dilla server, Vault Agent, backup job, telemetry collector — gets
  its own role with only the secrets it needs.
- **Leaving the human operator's role attached to the workload
  identity in dev.** Production workloads must run under a service
  account that no human can authenticate as.
- **Cross-account / cross-project secrets.** If you must, use
  Cross-Account access policies + sts:AssumeRole / Workload Identity
  Federation — never sharing static credentials between accounts.
- **`list` permissions where `get` would do.** `list` lets an
  attacker enumerate secret names; `get` requires the exact
  identifier. Dilla knows the exact paths at boot; it never needs to
  list.
