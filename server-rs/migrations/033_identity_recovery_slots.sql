-- Passkey-recoverable identity escrow (design doc:
-- .security-hardening/15-passkey-recoverable-identity-escrow.md).
--
-- One row per (user, WebAuthn credential). The on-device `identity.key`
-- blob is re-encrypted with the PRF-derived wrap key for each of the
-- user's passkeys and the result is stored here. Recovery on a fresh
-- device re-runs the WebAuthn ceremony to derive the same PRF output,
-- decrypts the row's `encrypted_blob`, and rehydrates IndexedDB —
-- no recovery key required.
--
-- Server cannot decrypt the blob (PRF output never travels). The
-- per-row `prf_salt` is opaque to the server too; it's just the input
-- to the client-side PRF derivation. `rp_id` is pinned at insert time
-- to the server's `state.config.domain` to make tampering loud during
-- review.

CREATE TABLE IF NOT EXISTS identity_recovery_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  -- base64url-encoded WebAuthn credentialId. Bounded by handler to
  -- 1024 chars to defang absurd uploads while comfortably fitting
  -- every real authenticator's credential ID.
  credential_id TEXT NOT NULL,
  -- The relying-party ID the credential was registered against,
  -- pinned at insert time to state.config.domain.
  rp_id TEXT NOT NULL,
  -- 32-byte PRF salt that was paired with this credential when the
  -- on-device key_slot was created. Required input for the WebAuthn
  -- PRF extension during recovery.
  prf_salt BLOB NOT NULL,
  -- AES-GCM(wrap_key, identity.key). The wrap_key is HKDF-SHA256 of
  -- the WebAuthn PRF output. Server cannot derive or read this.
  encrypted_blob BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, credential_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_recovery_slots_user
  ON identity_recovery_slots(user_id);
