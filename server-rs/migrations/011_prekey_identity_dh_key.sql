-- Store the X25519 identity DH public key alongside the Ed25519
-- identity signing key in prekey bundles. X3DH's DH2 step
-- (ephemeral × identity_dh) needs the X25519 public bytes; without
-- this column, the bundle the server returned had no X25519
-- identity material and every peer's session-init failed with
-- "Data provided to an operation does not meet requirements" in
-- WebCrypto. Default to an empty BLOB so existing rows still satisfy
-- the NOT NULL constraint — the prekey backfill on next app boot
-- re-uploads with the real key.

ALTER TABLE prekey_bundles
  ADD COLUMN identity_dh_key BLOB NOT NULL DEFAULT (x'');
