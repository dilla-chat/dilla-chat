-- Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    public_key BLOB NOT NULL UNIQUE,
    avatar_url TEXT DEFAULT '',
    status_text TEXT DEFAULT '',
    status_type TEXT DEFAULT 'online' CHECK(status_type IN ('online', 'idle', 'dnd', 'offline')),
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Teams table (each server instance hosts one team)
CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    icon_url TEXT DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    max_file_size INTEGER NOT NULL DEFAULT 10485760,
    allow_member_invites INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Roles
CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#99AAB5',
    position INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Team members
CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT DEFAULT '',
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    invited_by TEXT REFERENCES users(id),
    UNIQUE(team_id, user_id)
);

-- Member roles (many-to-many)
CREATE TABLE IF NOT EXISTS member_roles (
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (member_id, role_id)
);

-- Channels
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    topic TEXT DEFAULT '',
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'voice', 'dm', 'group_dm')),
    position INTEGER NOT NULL DEFAULT 0,
    category TEXT DEFAULT '',
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Messages (stores E2E encrypted ciphertext)
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    content BLOB NOT NULL,
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'system', 'file')),
    thread_id TEXT REFERENCES messages(id),
    edited_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    lamport_ts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

-- Reactions
CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id, emoji)
);

-- File attachments (E2E encrypted blobs)
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    filename_encrypted BLOB NOT NULL,
    content_type_encrypted BLOB,
    size INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invites
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id),
    token TEXT NOT NULL UNIQUE,
    max_uses INTEGER DEFAULT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Invite usage log
CREATE TABLE IF NOT EXISTS invite_uses (
    id TEXT PRIMARY KEY,
    invite_id TEXT NOT NULL REFERENCES invites(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Prekey bundles for E2E encryption
CREATE TABLE IF NOT EXISTS prekey_bundles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identity_key BLOB NOT NULL,
    signed_prekey BLOB NOT NULL,
    signed_prekey_signature BLOB NOT NULL,
    one_time_prekeys BLOB,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bootstrap tokens (for first-user setup)
CREATE TABLE IF NOT EXISTS bootstrap_tokens (
    token TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Direct message channels
CREATE TABLE IF NOT EXISTS dm_channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'dm' CHECK(type IN ('dm', 'group_dm')),
    name TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dm_members (
    channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, user_id)
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
