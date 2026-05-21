# Dilla — hardware-backed key management

Forward-looking guidance. **None of this is required to ship Dilla
1.0.** Today's crypto stack (SQLCipher KDF, HMAC-SHA256 for JWTs,
Ed25519 for federation join + identity) runs comfortably in software
and benefits little from HSM offload at single-binary scale.

But for high-assurance deployments (regulated industry, multi-tenant
hosting, federation of mutually-distrusting nodes), here's where HSM
or TPM-backed sealing fits when the time comes.

---

## 1. Sealing the SQLCipher passphrase to a TPM (Linux)

**Pattern:** [Network-Bound Disk Encryption (NBDE)](https://access.redhat.com/articles/6987053)
via `clevis` + `tang`. Originally designed for LUKS; works identically
for any "decrypt at boot, never write the plaintext to disk"
workflow.

### Setup

```sh
# On the Tang server (a small, reachable host whose only job is to
# answer recovery requests — can be a Raspberry Pi on the LAN).
sudo apt install tang
sudo systemctl enable --now tangd.socket

# On the Dilla host.
sudo apt install clevis

# Encrypt the DB passphrase into a JWE that requires the Tang server
# AND the local TPM to decrypt. Either one alone won't work.
echo -n "$DB_PASSPHRASE_PLAINTEXT" \
  | clevis encrypt sss '{
      "t": 2,
      "pins": {
        "tpm2": [{"pcr_bank": "sha256", "pcr_ids": "7"}],
        "tang": [{"url": "http://tang.internal:7500"}]
      }
    }' > /etc/dilla/secrets/db_passphrase.jwe
sudo chmod 0400 /etc/dilla/secrets/db_passphrase.jwe

# Decrypt at boot via a one-shot systemd unit that writes plaintext to
# tmpfs only.
```

`/etc/systemd/system/dilla-clevis-unseal.service`:

```ini
[Unit]
Description=Unseal Dilla DB passphrase from TPM + Tang
Before=dilla-server.service
RequiresMountsFor=/run

[Service]
Type=oneshot
RemainAfterExit=yes
RuntimeDirectory=dilla-secrets
RuntimeDirectoryMode=0700
ExecStart=/bin/sh -c 'clevis decrypt < /etc/dilla/secrets/db_passphrase.jwe > ${RUNTIME_DIRECTORY}/db_passphrase'
ExecStart=/bin/chmod 0400 ${RUNTIME_DIRECTORY}/db_passphrase

[Install]
WantedBy=multi-user.target
```

Then in `dilla-server.service`:

```ini
[Unit]
Requires=dilla-clevis-unseal.service
After=dilla-clevis-unseal.service

[Service]
Environment=DILLA_DB_PASSPHRASE_FILE=/run/dilla-secrets/db_passphrase
```

Properties:

- The plaintext passphrase only exists in tmpfs (RAM) during runtime.
- Removing the disk from the host → no usable secret (host TPM
  required).
- Tang server going offline → no boot (deliberate; trades availability
  for confidentiality).
- An attacker who roots the running host can still read
  `/run/dilla-secrets/db_passphrase` — the threat model here is
  cold-boot disk theft, not live-host compromise.

Threshold scheme is configurable (`t: 1` would mean either TPM or
Tang is enough; `t: 2` requires both). Default to 2 for the threat
model above.

---

## 2. Sealing the Tauri identity blob to macOS Secure Enclave

Already provided by the Tauri keychain integration on macOS. The
`SecKey` API can request that a private key be generated *inside* the
Secure Enclave and never extracted — operations (signing) happen via
opaque handles.

The desktop client's identity keypair (`client/src-tauri/src/crypto.rs`)
uses `SecKey` with `kSecAttrTokenIDSecureEnclave` on macOS by default
when the OS supports it. On Linux + Windows, the equivalent is the
TPM2 NV index store (Linux) or DPAPI + TPM (Windows) — partially
implemented; tracking under a future hardening pass.

This is **user-side**, not operator-side, so it doesn't appear in the
Tier 1-4 storage matrix in `README.md`. Mentioned here because a
"hardware-backed key management" doc that doesn't acknowledge the
client side is incomplete.

---

## 3. HSM-backed Ed25519 signing for federation events (future)

Once VULN-002 is fixed (every replicated federation event is signed
by the originating node's Ed25519 key), the signing key becomes the
most critical secret on the box — equivalent in blast radius to
`DILLA_DB_PASSPHRASE` for one peer, but additionally letting an
attacker forge events as that peer for the entire mesh.

For deployments that justify it, that key should live in an HSM and
never leave it:

- **YubiHSM 2** — USB-connected HSM, ~$650, supports Ed25519 native.
  The Dilla server links against `libyubihsm` (or talks to a local
  `yubihsm-connector`) and submits sign requests; the private key
  never leaves the device.
- **AWS CloudHSM / Azure Dedicated HSM / GCP Cloud HSM** — cloud
  equivalents, ~$1.5/hour. Same pattern: PKCS#11 interface, private
  key never extractable.
- **Network HSMs (Thales Luna, Entrust nShield)** — on-prem, for
  organisations that already have one.

Server-side integration requires:

1. A PKCS#11 binding crate (e.g. `cryptoki`) in `server-rs`.
2. Replacing the `ed25519-dalek::SigningKey` direct calls in
   `federation/sign.rs` (post-VULN-002) with a trait-bound abstraction
   so the signing implementation can be swapped between software
   `SigningKey` and an HSM-backed implementation.
3. A `DILLA_FEDERATION_HSM_*` config block: PKCS#11 module path, slot
   id, pin file, key label.

Estimated effort: one focused engineering sprint. **Not on the
near-term roadmap** — VULN-002 fix lands first; HSM offload is a
cherry-on-top for the operators who need it.

---

## 4. Why this is "forward-looking" rather than "do it now"

| Concern | Software (today) | HSM (proposed) | Worth the cost? |
|---|---|---|---|
| Database passphrase leakage | Mitigated by `_FILE` + tmpfs + systemd `LoadCredential` | Stronger — sealed at rest, requires platform attestation | Only if cold-boot disk theft is in your threat model |
| JWT secret rotation | Restart the process | Restart + HSM re-key | Not enough wins to justify |
| Federation peer impersonation | Post-VULN-002: Ed25519 software signing | HSM-backed signing | Yes for multi-org federations; no for hobby / home server |
| Compliance (HIPAA / PCI / FedRAMP) | n/a | Required for certain levels | Driven by external policy, not threat model |

For the median Dilla operator (one host, one org, ≤100 users) the
"_FILE + systemd LoadCredential + offline-printed paper backup of the
DB passphrase" pattern in `README.md` Tier 1 is **already strong**.
HSMs harden the corner cases. Don't deploy one to feel safe; deploy
one when your threat model demands it.
