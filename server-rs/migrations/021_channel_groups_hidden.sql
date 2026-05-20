-- channel_groups gain hidden_if_restricted, mirroring the same column
-- on channels. When true *and* the group's role list excludes the
-- caller, the server omits every channel in the group from listings
-- instead of showing a padlock. Channels still own their own
-- hidden_if_restricted for the ungrouped case (channels without a
-- group_id).
ALTER TABLE channel_groups
    ADD COLUMN hidden_if_restricted INTEGER NOT NULL DEFAULT 0;
