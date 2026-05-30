-- Optional "hide if restricted" mode. When set, the channel is omitted
-- from a member's channel list when the access gate denies them — they
-- never see the channel at all instead of seeing a padlock they can't
-- open. Defaults to off so existing channels stay visible.

ALTER TABLE channels ADD COLUMN hidden_if_restricted INTEGER NOT NULL DEFAULT 0;
