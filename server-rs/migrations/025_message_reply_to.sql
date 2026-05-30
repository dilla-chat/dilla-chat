-- Reply threading. A message that's a reply to another stores the
-- original's id here; the client renders a reply-ref preview above the
-- message body. ON DELETE SET NULL because hard-deleting the original
-- shouldn't cascade-delete every reply — the reply still has its own
-- content, we just lose the link.

ALTER TABLE messages
    ADD COLUMN reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to
    ON messages (reply_to_message_id);
