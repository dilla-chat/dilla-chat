-- VULN-009: bootstrap tokens were stored without an expiry column and
-- emitted via stderr forever. Add expires_at so consume_bootstrap_token
-- can refuse stale tokens. Existing rows get a 15-minute window from
-- "now" so an in-flight first-time-setup browser tab still works after
-- the upgrade — operators with a pre-rotation token simply restart.
ALTER TABLE bootstrap_tokens ADD COLUMN expires_at TEXT NOT NULL DEFAULT '';
UPDATE bootstrap_tokens
SET expires_at = strftime('%Y-%m-%d %H:%M:%S', datetime('now', '+15 minutes'))
WHERE expires_at = '';
