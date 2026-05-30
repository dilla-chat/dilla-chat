# 15 · Passkey-recoverable identity escrow

**Status:** design proposal · not implemented
**Tracking issue:** (none yet)
**Author note:** scoped during the 2026-05-30 reload-bounce debugging session, after a user wiped Dilla's IndexedDB and discovered the only documented recovery path (`recovery key`) was a one-shot value they hadn't saved.

## Problem

Dilla today encrypts the on-device `identity.key` blob with one of two wrap keys:

- **PRF-derived** — the AES-GCM wrap key is HKDF'd from a WebAuthn PRF output, which is in turn derived from the user's passkey and a per-slot 32-byte `prf_salt`.
- **PBKDF2-derived** — the AES-GCM wrap key is PBKDF2'd from the user's passphrase + a per-slot salt.

Either way the encrypted blob lives in IndexedDB on the device. After every successful login the same blob is escrowed to the server at `PUT /api/v1/identity/blob`, but **the server-side copy is encrypted with a separate one-shot `recovery_key`**, not the PRF / PBKDF2 wrap keys.

That means losing the device's IndexedDB requires one of:

1. The 32-byte recovery key (shown to the user exactly once at bootstrap; almost nobody remembers to save it during dev iteration).
2. An invite link from an admin (re-creates the *user*, not the original identity).
3. A full server reset (only acceptable on a fresh deploy).

The passkey alone is **not** enough, even though:

- The user clearly has the passkey (it's still sitting in Proton Pass / Apple Passwords / etc.)
- The same passkey can re-derive the same PRF output given the same `prf_salt`
- The server has an escrowed copy of `identity.key`

We're asking the user to remember a one-shot 32-byte secret when their passkey already proves their identity. That's the design gap this proposal closes.

## Goal

A user who:

- has lost their device, reinstalled the browser, cleared site data, or simply blew away the `dilla-keystore` IDB
- still has access to their original passkey (it's in Proton Pass / Apple Passwords / etc., possibly synced via their password manager's cloud)

should be able to recover their Dilla identity by re-doing the passkey ceremony — no recovery key required.

The existing recovery-key flow stays as a fallback for users who genuinely lose their passkey too (the "I lost both" case).

## Threat model

What changes vs. today:

- Server gains an additional encrypted blob per `(user_id, credential_id)` tuple. The blob's plaintext is identical to the existing PRF-encrypted on-device blob; the server can't decrypt either.
- Server gains a new unauthenticated lookup endpoint that returns credential descriptors (rp_id, credential_id, prf_salt) keyed by username. These three fields are not secrets — `rp_id` is the server's own domain, `credential_id` is what the browser hands back during every WebAuthn ceremony, and `prf_salt` is mixed with the passkey's internal secret material so leaking it alone gives an attacker nothing.

What stays the same:

- The server never sees the user's passphrase, PRF output, identity private key, or recovery key.
- An attacker who compromises the server gets the encrypted blobs but cannot decrypt without the corresponding passkey.

New risks worth calling out:

- **Username enumeration.** A `POST /api/v1/identity/recovery/lookup {username}` endpoint that returns credential descriptors for known users vs. a uniform empty response for unknowns leaks user existence. Mitigation: always return a synthetic descriptor set for unknown usernames (constant-time) and rate-limit per source IP. Tradeoff: false-credential ceremonies waste the user's time but don't reveal anything they couldn't already infer from the public login surface.
- **Credential-descriptor harvesting.** An attacker with a list of usernames can build a mapping `username → credential_id`. The credential ID itself isn't a secret (browsers send it during every authentication ceremony anyway) but the linkage may matter for fingerprinting. Rate limiting is the standard mitigation.

## Design

### New table

```sql
CREATE TABLE identity_recovery_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,           -- base64url of WebAuthn credentialId
  rp_id TEXT NOT NULL,                   -- pinned to state.config.domain
  prf_salt BLOB NOT NULL,                -- 32 bytes, same as the on-device slot
  encrypted_blob BLOB NOT NULL,          -- AES-GCM(PRF-wrap-key, identity.key)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, credential_id)
);

CREATE INDEX idx_identity_recovery_slots_user ON identity_recovery_slots(user_id);
```

`credential_id` is opaque to the server; we just store and return it. `prf_salt` is the same 32-byte value already stored in the local `key_slots[].prf_salt` so the same PRF-derived wrap key reproduces the same plaintext.

### New endpoints

#### `PUT /api/v1/identity/recovery/passkey` — store / refresh an escrowed slot

Authenticated. Upserts a slot for the caller's `(user_id, credential_id)`:

```json
{
  "credential_id": "base64url",
  "prf_salt": "base64",
  "encrypted_blob": "base64"
}
```

Server validates: `rp_id` pulled from server config (clients can't influence), `credential_id` is base64url and ≤ 1024 chars, `prf_salt` is exactly 32 bytes, `encrypted_blob` ≤ 64 KiB.

Idempotent; updates `encrypted_blob` + `updated_at` when the same `(user_id, credential_id)` pair already exists.

#### `POST /api/v1/identity/recovery/lookup` — unauthenticated descriptor lookup

```json
{ "username": "thim" }
```

Returns:

```json
{
  "rp_id": "dilla.thim.dev",
  "credentials": [
    { "credential_id": "base64url", "prf_salt": "base64" }
  ]
}
```

If the username is unknown, return a synthetic descriptor set (one fake credential, random prf_salt seeded from `HMAC(server_secret, username)` so it's deterministic per-username) so the request takes the same wall-clock time and looks indistinguishable to an attacker.

Rate limit: existing `DILLA_RATELIMIT_PER_SECOND` applies; additionally cap to N lookups per source IP per hour.

#### `GET /api/v1/identity/recovery/passkey/{credential_id}` — fetch encrypted blob

Authenticated via a fresh **passkey assertion** (challenge-response) rather than JWT. Flow:

1. Client `POST /api/v1/identity/recovery/challenge {credential_id}` → server returns a nonce + the matching slot's `prf_salt` if it exists (or a synthetic one for unknown credentials). Single-use, 5-minute expiry.
2. Client runs `navigator.credentials.get({allowCredentials:[{id: credential_id}], extensions:{prf:{eval:{first: prf_salt}}}})`, signs the challenge.
3. Client `POST /api/v1/identity/recovery/verify {credential_id, challenge_id, signature}` → server verifies the assertion against the credential's stored public key (which is in `user_devices`; we already register each WebAuthn credential's public key during device enrollment).
4. On success, server returns `{ encrypted_blob }`.

The verify step gives us authentication-via-passkey for the recovery endpoint itself, so a leaked-cookie attacker can't pull other users' blobs.

### Client flow

#### At identity creation (new branch in `createIdentity`):

```ts
// existing — write local IndexedDB blob
await idbPut('identity.key', keyFile);

// NEW — escrow PRF-encrypted copy to server
const passkeyEncryptedBlob = await encryptKeyFileWithPrfWrapKey(keyFile, prfDerivedKey);
await api.uploadPasskeyRecoverySlot(teamId, {
  credential_id: passkey.credentialId,
  prf_salt: prfSalt,
  encrypted_blob: passkeyEncryptedBlob,
});
```

#### At `addKeySlot` time:

Same as above but for the new slot's credential_id + prf_salt.

#### On "Already enrolled" with empty IDB (new "Recover with passkey" link):

```ts
const { rp_id, credentials } = await api.identityRecoveryLookup(username);
// Build allowCredentials
const allowCredentials = credentials.map(c => ({
  id: fromBase64Url(c.credential_id), type: 'public-key',
}));
// One passkey ceremony for both auth + PRF
const { challenge_id, nonce } = await api.identityRecoveryChallenge(credentials[0].credential_id);
const auth = await navigator.credentials.get({
  publicKey: {
    challenge: nonceBytes,
    rpId: rp_id,
    allowCredentials,
    extensions: { prf: { eval: { first: credentials[0].prf_salt } } },
  },
});
const sig = extractSignature(auth);
const { encrypted_blob } = await api.identityRecoveryVerify({
  credential_id: auth.id, challenge_id, signature: sig,
});
const prfOutput = auth.getClientExtensionResults().prf.results.first;
const wrap_key = await deriveAesGcmFromPrf(prfOutput);
const keyFile = await aesGcmDecrypt(wrap_key, encrypted_blob);
await idbPut('identity.key', keyFile);
// User is now exactly where they would be after a successful normal unlock.
```

### Migration

Existing users get the new slot lazily — on next successful login (when both `identity.key` is decrypted and a connected server is available), the client uploads a passkey-encrypted copy of the current blob for each `key_slots[].credentials[]` entry. This is opportunistic and doesn't break anyone.

After the migration window we can consider deprecating the recovery-key path entirely, but keep it for now as the "I lost ALL passkeys" fallback.

## API surface summary

| Method | Path | Auth | Purpose |
|--|--|--|--|
| `PUT` | `/api/v1/identity/recovery/passkey` | JWT | upsert escrowed PRF-encrypted blob |
| `POST` | `/api/v1/identity/recovery/lookup` | none (rate-limited) | descriptor lookup by username |
| `POST` | `/api/v1/identity/recovery/challenge` | none | start passkey-assertion recovery flow |
| `POST` | `/api/v1/identity/recovery/verify` | challenge | finish flow, return encrypted blob |
| `GET` | `/api/v1/identity/recovery/passkey/{credential_id}` | challenge | alternative direct fetch after a verified challenge |

(The `GET` is convenience; the `POST verify` already returns the blob.)

## Open questions

- **Per-server escrow vs. cross-server.** Today the recovery-key blob is uploaded to *every* server the user belongs to. For passkey-escrow, do we replicate or pick a primary? Recommend: replicate, so any server the user has previously talked to can serve the recovery flow.
- **Federation.** A user enrolled on node A could recover on node B if B holds an escrowed copy. Federation already replicates user rows; we'd need a `federation::sync` extension to replicate `identity_recovery_slots`. Out of scope for v1 — start with single-server.
- **Username enumeration tolerance.** The synthetic-descriptor mitigation is best-effort. If the security review later decides even that's too leaky, we can require the user to first provide a Cookie / valid invite link to start the recovery flow — at the cost of breaking the "totally fresh device" scenario. Recommend ship as-is and revisit.
- **Credential rotation.** When a user revokes a passkey via the Settings UI, we already delete the slot from `key_slots` locally. The recovery slot needs the same lifecycle — `DELETE /api/v1/identity/recovery/passkey/{credential_id}` on revoke.
- **Storage size.** Each escrowed blob is the size of `identity.key` (typically 1–2 KiB) per credential per server. A user with 3 passkeys on 2 servers = 6 rows × 2 KiB = 12 KiB. Negligible.

## Implementation plan (when this is approved)

1. **Server migration + handlers** (`server-rs/src/db/migrations.rs`, `server-rs/src/api/identity_recovery.rs`, `server-rs/src/api/mod.rs` for routing). Tests: round-trip per endpoint, rate-limit gate on lookup, synthetic-descriptor stability.
2. **Client API client** (`client/src/services/api.ts`) — five new methods matching the table above.
3. **Client recovery hook** (`client/src/pages/Onboarding/Onboarding.tsx`) — new "Recover with passkey" link on the "Already enrolled" tab, only shown when `getCredentialInfo()` returns null AND a server URL is set.
4. **Auto-escrow on login + addKeySlot** — both call points already exist; add the upload alongside.
5. **Migration write-back** — `restoreEncryptedAuthData` already runs after login; add a "if no recovery slot present for this credential, upload one now" check.
6. **Tests** — unit on encryption round-trip, integration on the four-step recovery flow, jsdom test on the new Onboarding link being shown only when conditions are right.

Estimated effort: 2–3 days of focused work, including tests.
