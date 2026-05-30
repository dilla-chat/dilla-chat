-- Mark teams that originated on (or have been replicated from) a federated peer.
-- Defaults to 0 = local-only. Federation sync flips this to 1 when a team
-- record is received from a peer rather than created locally.
ALTER TABLE teams ADD COLUMN federated INTEGER NOT NULL DEFAULT 0;
