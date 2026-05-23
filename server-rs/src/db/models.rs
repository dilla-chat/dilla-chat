use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Per-user quiet-hours window for desktop notifications. Times are
    /// stored as "HH:MM" strings in local time and the client decides
    /// when "now" falls inside the window (server is timezone-agnostic).
    #[serde(default)]
    pub quiet_hours_enabled: bool,
    #[serde(default)]
    pub quiet_hours_from: String,
    #[serde(default)]
    pub quiet_hours_to: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon_url: String,
    pub created_by: String,
    pub max_file_size: i64,
    pub allow_member_invites: bool,
    #[serde(default)]
    pub federated: bool,
    /// SFU-IP-1 mitigation. When true, the client must set
    /// `RTCConfiguration.iceTransportPolicy = "relay"` for voice
    /// calls in this team so host/srflx ICE candidates are filtered
    /// out — only TURN-relayed candidates cross the wire, so peer
    /// IPs aren't leaked to other channel members. Off by default;
    /// operator opt-in for high-privacy teams. Surfaced via team
    /// payloads + voice:rooms-snapshot for client enforcement.
    #[serde(default)]
    pub force_turn_relay: bool,
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
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub id: String,
    pub team_id: String,
    pub user_id: String,
    pub nickname: String,
    pub joined_at: String,
    pub invited_by: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    #[serde(default)]
    pub locked: bool,
    /// When true and the user can't access the channel, omit it entirely
    /// from their channel list instead of showing a locked indicator.
    #[serde(default)]
    pub hidden_if_restricted: bool,
    /// Minimum seconds between consecutive messages from the same user.
    /// 0 disables slow mode. Enforced by message:send.
    #[serde(default)]
    pub slow_mode_seconds: i32,
    /// Owning channel-group id; None means the channel sits in the default
    /// bucket. Pure-inheritance access: channels with a group_id resolve
    /// access via the group's role list, not their own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// When set, this message is a reply to the referenced message id.
    /// Client renders the original above the body as a reply-ref preview.
    /// Stays None for top-level messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub message_id: String,
    pub filename_encrypted: Vec<u8>,
    #[serde(default)]
    pub content_type_encrypted: Vec<u8>,
    pub size: i64,
    pub storage_path: String,
    /// H-7: uploader provenance. Populated on every new upload so
    /// the in-grace (unlinked) download window can scope to the
    /// actual uploader rather than the storage_path team trick.
    /// Pre-existing rows are NULL; download falls back to the
    /// storage_path check for those.
    #[serde(default)]
    pub uploader_id: Option<String>,
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
#[allow(dead_code)]
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
    /// X25519 public DH key. Used in X3DH's DH2 step
    /// (ephemeral × identity_dh). The Ed25519 `identity_key` above is
    /// for signed-prekey signature verification only — it's NOT
    /// suitable for raw X25519 DH operations.
    pub identity_dh_key: Vec<u8>,
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
    /// UTC "%Y-%m-%d %H:%M:%S" string after which the token must be
    /// rejected even if still unused. See VULN-009 — bootstrap tokens
    /// used to live forever.
    pub expires_at: String,
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
#[allow(dead_code)]
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
/// Roles with this permission bypass per-channel slow mode. The default
/// "everyone" role does NOT have it (so regular members are rate-limited);
/// the Admin role gets it implicitly via PERM_ADMIN.
pub const PERM_BYPASS_SLOW_MODE: i64 = 1 << 8;
/// Force-mute another participant in a voice channel. The server enforces
/// the mute by broadcasting voice:mute-update; the target client kills
/// its mic locally on receipt. Server-side action is audit-logged.
pub const PERM_MUTE_VOICE: i64 = 1 << 9;
/// Mint federation join tokens, list peers, mutate federation config.
/// Split out from PERM_ADMIN so a team admin who manages members
/// cannot also add a foreign Dilla node to the trust mesh (a different
/// privilege class — see architecture review §6.2 + A3 in
/// .security-hardening/08-auth-enhancement.md). PERM_ADMIN still
/// implies this bit via the bitmask short-circuit in
/// `user_has_permission`.
pub const PERM_MANAGE_FEDERATION: i64 = 1 << 10;
/// Read the team audit log. Split out from PERM_ADMIN so a "team
/// safety officer" can review the log without holding member/role
/// mutation rights. PERM_ADMIN still implies this bit.
pub const PERM_VIEW_AUDIT_LOG: i64 = 1 << 11;

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

/// Public re-export of the base64-bytes serde adapter so other model
/// types (e.g. `UserDevice` in `device_queries.rs`) can serialize raw
/// public keys consistently with `User`.
pub mod base64_bytes_pub {
    pub use super::base64_bytes::*;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_bits_are_distinct_powers_of_two() {
        let bits = [
            PERM_ADMIN,
            PERM_MANAGE_CHANNELS,
            PERM_MANAGE_MEMBERS,
            PERM_MANAGE_ROLES,
            PERM_SEND_MESSAGES,
            PERM_MANAGE_MESSAGES,
            PERM_CREATE_INVITES,
            PERM_MANAGE_TEAM,
            PERM_BYPASS_SLOW_MODE,
            PERM_MUTE_VOICE,
            PERM_MANAGE_FEDERATION,
            PERM_VIEW_AUDIT_LOG,
        ];
        for &b in &bits {
            assert!(b > 0 && (b & (b - 1)) == 0, "bit {b} is not a power of two");
        }
        // No two share a value.
        for i in 0..bits.len() {
            for j in (i + 1)..bits.len() {
                assert_ne!(bits[i], bits[j], "duplicate permission bit");
            }
        }
    }

    #[test]
    fn permission_bits_are_in_ascending_order() {
        // The constants are declared in PERM_* order — keeping them in
        // ascending bit order matches the canonical table that the
        // client mirrors in TeamSettings/types.ts.
        assert!(PERM_ADMIN < PERM_MANAGE_CHANNELS);
        assert!(PERM_MANAGE_CHANNELS < PERM_MANAGE_MEMBERS);
        assert!(PERM_MANAGE_MEMBERS < PERM_MANAGE_ROLES);
        assert!(PERM_MANAGE_ROLES < PERM_SEND_MESSAGES);
        assert!(PERM_SEND_MESSAGES < PERM_MANAGE_MESSAGES);
        assert!(PERM_MANAGE_MESSAGES < PERM_CREATE_INVITES);
        assert!(PERM_CREATE_INVITES < PERM_MANAGE_TEAM);
        assert!(PERM_MANAGE_TEAM < PERM_BYPASS_SLOW_MODE);
        assert!(PERM_BYPASS_SLOW_MODE < PERM_MUTE_VOICE);
        assert!(PERM_MUTE_VOICE < PERM_MANAGE_FEDERATION);
        assert!(PERM_MANAGE_FEDERATION < PERM_VIEW_AUDIT_LOG);
    }

    #[test]
    fn base64_bytes_roundtrip() {
        // Serialise+deserialise a User with non-trivial public_key bytes
        // through the base64_bytes serde adapter.
        let u = User {
            id: "u1".into(),
            username: "alice".into(),
            display_name: "Alice".into(),
            public_key: vec![0xde, 0xad, 0xbe, 0xef],
            ..Default::default()
        };
        let s = serde_json::to_string(&u).unwrap();
        assert!(s.contains("\"3q2+7w==\""), "expected base64 of DEADBEEF, got {s}");
        let back: User = serde_json::from_str(&s).unwrap();
        assert_eq!(back.public_key, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn base64_bytes_rejects_invalid_input() {
        let bad = r#"{"id":"u","username":"u","display_name":"u","public_key":"@@@not base64@@@","avatar_url":"","status_text":"","status_type":"","is_admin":false,"created_at":"","updated_at":""}"#;
        assert!(serde_json::from_str::<User>(bad).is_err());
    }

    #[test]
    fn team_force_turn_relay_defaults_to_false_on_deserialize() {
        // Older Team payloads without `force_turn_relay` must still
        // deserialise (#[serde(default)]) to preserve forward-compat.
        let s = r#"{"id":"t1","name":"T","description":"","icon_url":"","created_by":"u","max_file_size":0,"allow_member_invites":true,"created_at":"","updated_at":""}"#;
        let t: Team = serde_json::from_str(s).unwrap();
        assert_eq!(t.force_turn_relay, false);
        assert_eq!(t.federated, false);
    }

    #[test]
    fn user_default_quiet_hours_disabled() {
        let u = User::default();
        assert_eq!(u.quiet_hours_enabled, false);
        assert_eq!(u.quiet_hours_from, "");
        assert_eq!(u.quiet_hours_to, "");
    }

    #[test]
    fn full_admin_mask_covers_all_12_perm_bits() {
        // The "every permission" mask is the OR of all known bits.
        // Keeps as a single contiguous block 0..=11.
        let mask = PERM_ADMIN
            | PERM_MANAGE_CHANNELS
            | PERM_MANAGE_MEMBERS
            | PERM_MANAGE_ROLES
            | PERM_SEND_MESSAGES
            | PERM_MANAGE_MESSAGES
            | PERM_CREATE_INVITES
            | PERM_MANAGE_TEAM
            | PERM_BYPASS_SLOW_MODE
            | PERM_MUTE_VOICE
            | PERM_MANAGE_FEDERATION
            | PERM_VIEW_AUDIT_LOG;
        assert_eq!(mask, 0x0FFF);
    }
}
