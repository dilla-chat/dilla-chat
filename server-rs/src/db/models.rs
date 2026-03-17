use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    #[serde(with = "base64_bytes")]
    pub public_key: Vec<u8>,
    pub avatar_url: String,
    pub status_text: String,
    pub status_type: String,
    pub is_admin: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon_url: String,
    pub created_by: String,
    pub max_file_size: i64,
    pub allow_member_invites: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Role {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub color: String,
    pub position: i32,
    pub permissions: i64,
    pub is_default: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub id: String,
    pub team_id: String,
    pub user_id: String,
    pub nickname: String,
    pub joined_at: String,
    pub invited_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub topic: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub position: i32,
    pub category: String,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub dm_channel_id: String,
    pub author_id: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<String>,
    pub deleted: bool,
    pub lamport_ts: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reaction {
    pub id: String,
    pub message_id: String,
    pub user_id: String,
    pub emoji: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub count: i64,
    pub users: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub message_id: String,
    pub filename_encrypted: Vec<u8>,
    #[serde(default)]
    pub content_type_encrypted: Vec<u8>,
    pub size: i64,
    pub storage_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Invite {
    pub id: String,
    pub team_id: String,
    pub created_by: String,
    pub token: String,
    pub max_uses: Option<i32>,
    pub uses: i32,
    pub expires_at: Option<String>,
    pub revoked: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteUse {
    pub id: String,
    pub invite_id: String,
    pub user_id: String,
    pub used_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrekeyBundle {
    pub id: String,
    pub user_id: String,
    pub identity_key: Vec<u8>,
    pub signed_prekey: Vec<u8>,
    pub signed_prekey_signature: Vec<u8>,
    pub one_time_prekeys: Vec<u8>,
    pub uploaded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapToken {
    pub token: String,
    pub used: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMChannel {
    pub id: String,
    #[serde(default)]
    pub team_id: String,
    #[serde(rename = "type")]
    pub dm_type: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMMember {
    pub channel_id: String,
    pub user_id: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ban {
    pub team_id: String,
    pub user_id: String,
    pub banned_by: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub channel_id: String,
    pub parent_message_id: String,
    pub team_id: String,
    pub creator_id: String,
    pub title: String,
    pub message_count: i32,
    pub last_message_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityBlob {
    pub user_id: String,
    pub blob: String,
    pub updated_at: String,
}

// Permission constants (bitmask).
pub const PERM_ADMIN: i64 = 1 << 0;
pub const PERM_MANAGE_CHANNELS: i64 = 1 << 1;
pub const PERM_MANAGE_MEMBERS: i64 = 1 << 2;
pub const PERM_MANAGE_ROLES: i64 = 1 << 3;
pub const PERM_SEND_MESSAGES: i64 = 1 << 4;
pub const PERM_MANAGE_MESSAGES: i64 = 1 << 5;
pub const PERM_CREATE_INVITES: i64 = 1 << 6;
pub const PERM_MANAGE_TEAM: i64 = 1 << 7;

mod base64_bytes {
    use base64::Engine;
    use serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S>(bytes: &Vec<u8>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        serializer.serialize_str(&encoded)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Vec<u8>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        base64::engine::general_purpose::STANDARD
            .decode(&s)
            .map_err(serde::de::Error::custom)
    }
}
