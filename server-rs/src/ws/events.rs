use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Client → Server event types ─────────────────────────────────────────────
pub const EVENT_MESSAGE_SEND: &str = "message:send";
pub const EVENT_MESSAGE_EDIT: &str = "message:edit";
pub const EVENT_MESSAGE_DELETE: &str = "message:delete";
pub const EVENT_TYPING_START: &str = "typing:start";
pub const EVENT_TYPING_STOP: &str = "typing:stop";
pub const EVENT_PRESENCE_UPDATE: &str = "presence:update";
pub const EVENT_CHANNEL_JOIN: &str = "channel:join";
pub const EVENT_CHANNEL_LEAVE: &str = "channel:leave";
pub const EVENT_THREAD_MESSAGE_SEND: &str = "thread:message:send";
pub const EVENT_THREAD_MESSAGE_EDIT: &str = "thread:message:edit";
pub const EVENT_THREAD_MESSAGE_REMOVE: &str = "thread:message:remove";
pub const EVENT_VOICE_JOIN: &str = "voice:join";
pub const EVENT_VOICE_JOIN_DENIED: &str = "voice:join-denied";
pub const EVENT_VOICE_LEAVE: &str = "voice:leave";
pub const EVENT_VOICE_ANSWER: &str = "voice:answer";
pub const EVENT_VOICE_ICE_CANDIDATE: &str = "voice:ice-candidate";
pub const EVENT_VOICE_INVITE: &str = "voice:invite";
pub const EVENT_VOICE_MUTE: &str = "voice:mute";
pub const EVENT_VOICE_DEAFEN: &str = "voice:deafen";
pub const EVENT_VOICE_FORCE_MUTE: &str = "voice:force-mute";
pub const EVENT_VOICE_FORCE_DISCONNECT: &str = "voice:force-disconnect";
pub const EVENT_VOICE_LATENCY: &str = "voice:latency";
pub const EVENT_VOICE_LATENCY_UPDATE: &str = "voice:latency-update";
pub const EVENT_VOICE_SCREEN_START: &str = "voice:screen-start";
pub const EVENT_VOICE_SCREEN_STOP: &str = "voice:screen-stop";
pub const EVENT_VOICE_WEBCAM_START: &str = "voice:webcam-start";
pub const EVENT_VOICE_WEBCAM_STOP: &str = "voice:webcam-stop";
pub const EVENT_VOICE_KEY_DISTRIBUTE: &str = "voice:key-distribute";
pub const EVENT_CHANNEL_KEY_DISTRIBUTE: &str = "channel:key-distribute";
pub const EVENT_REQUEST: &str = "request";
pub const EVENT_PING: &str = "ping";
pub const EVENT_REACTION_ADD: &str = "reaction:add";
pub const EVENT_REACTION_REMOVE: &str = "reaction:remove";
pub const EVENT_TELEMETRY_ERROR: &str = "telemetry:error";
pub const EVENT_TELEMETRY_BREADCRUMB: &str = "telemetry:breadcrumb";

// DM events
pub const EVENT_DM_MESSAGE_SEND: &str = "dm:message:send";
pub const EVENT_DM_MESSAGE_EDIT: &str = "dm:message:edit";
pub const EVENT_DM_MESSAGE_DELETE: &str = "dm:message:delete";
pub const EVENT_DM_TYPING_START: &str = "dm:typing:start";
pub const EVENT_DM_TYPING_STOP: &str = "dm:typing:stop";

// ── Server → Client event types ─────────────────────────────────────────────
pub const EVENT_MESSAGE_NEW: &str = "message:new";
pub const EVENT_MESSAGE_UPDATED: &str = "message:updated";
pub const EVENT_MESSAGE_DELETED: &str = "message:deleted";
pub const EVENT_TYPING_INDICATOR: &str = "typing:indicator";
pub const EVENT_PRESENCE_CHANGED: &str = "presence:changed";
pub const EVENT_PONG: &str = "pong";

// Not yet referenced in Rust handlers but part of the WS protocol definition.
#[allow(dead_code)]
pub const EVENT_MEMBER_JOINED: &str = "member:joined";
#[allow(dead_code)]
pub const EVENT_MEMBER_LEFT: &str = "member:left";
#[allow(dead_code)]
pub const EVENT_CHANNEL_CREATED: &str = "channel:created";
#[allow(dead_code)]
pub const EVENT_CHANNEL_UPDATED: &str = "channel:updated";
#[allow(dead_code)]
pub const EVENT_CHANNEL_DELETED: &str = "channel:deleted";
#[allow(dead_code)]
pub const EVENT_ERROR: &str = "error";

// Thread server events
pub const EVENT_THREAD_MESSAGE_NEW: &str = "thread:message:new";
pub const EVENT_THREAD_MESSAGE_UPDATED: &str = "thread:message:updated";
pub const EVENT_THREAD_MESSAGE_DELETED: &str = "thread:message:deleted";
pub const EVENT_THREAD_UPDATED: &str = "thread:updated";
#[allow(dead_code)]
pub const EVENT_THREAD_CREATED: &str = "thread:created";

// Reaction server events
pub const EVENT_REACTION_ADDED: &str = "reaction:added";
pub const EVENT_REACTION_REMOVED: &str = "reaction:removed";

// Voice server events
pub const EVENT_VOICE_INCOMING_CALL: &str = "voice:incoming-call";
pub const EVENT_VOICE_OFFER: &str = "voice:offer";
pub const EVENT_VOICE_USER_JOINED: &str = "voice:user-joined";
pub const EVENT_VOICE_USER_LEFT: &str = "voice:user-left";
pub const EVENT_VOICE_STATE: &str = "voice:state";
/// Server pushes a snapshot of every active voice room on the user's
/// team(s) when their WS connects. Lets a fresh client see who is
/// already in voice without having to enter the channel first.
pub const EVENT_VOICE_ROOMS_SNAPSHOT: &str = "voice:rooms-snapshot";
pub const EVENT_VOICE_MUTE_UPDATE: &str = "voice:mute-update";
pub const EVENT_VOICE_SCREEN_UPDATE: &str = "voice:screen-update";
pub const EVENT_VOICE_WEBCAM_UPDATE: &str = "voice:webcam-update";
#[allow(dead_code)]
pub const EVENT_VOICE_ICE_OUT: &str = "voice:ice-candidate";
#[allow(dead_code)]
pub const EVENT_VOICE_SPEAKING: &str = "voice:speaking";

// DM server events
pub const EVENT_DM_MESSAGE_NEW: &str = "dm:message:new";
pub const EVENT_DM_MESSAGE_UPDATED: &str = "dm:message:updated";
pub const EVENT_DM_MESSAGE_DELETED: &str = "dm:message:deleted";
#[allow(dead_code)]
pub const EVENT_DM_CREATED: &str = "dm:created";

// Federation server events (broadcast to all subscribed clients)
#[allow(dead_code)]
pub const EVENT_FEDERATION_PEER_STATUS: &str = "federation:peer-status";
#[allow(dead_code)]
pub const EVENT_FEDERATION_LAMPORT: &str = "federation:lamport";
#[allow(dead_code)]
pub const EVENT_FEDERATION_LATENCY: &str = "federation:latency";

// ── Channel read event types ─────────────────────────────────────────────────
pub const ACTION_CHANNEL_READ: &str = "channel:mark-read";
#[allow(dead_code)]
pub const EVENT_CHANNEL_READ: &str = "channel:read";

// ── Request/Response action types ───────────────────────────────────────────
pub const ACTION_SYNC_INIT: &str = "sync:init";
pub const ACTION_MESSAGE_LIST: &str = "messages:list";
pub const ACTION_THREAD_LIST: &str = "threads:list";
pub const ACTION_THREAD_MESSAGES: &str = "threads:messages";
pub const ACTION_DM_LIST: &str = "dms:list";
pub const ACTION_DM_MESSAGES: &str = "dms:messages";

// ── Event struct ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
}

impl Event {
    pub fn new(event_type: &str, payload: impl Serialize) -> Result<Self, serde_json::Error> {
        Ok(Event {
            event_type: event_type.to_string(),
            payload: serde_json::to_value(payload)?,
        })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

// ── Payload types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSendPayload {
    pub channel_id: String,
    pub content: String,
    #[serde(rename = "type", default)]
    pub msg_type: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    /// When set, this message is a reply to the referenced message id.
    /// Server stores it on messages.reply_to_message_id; the broadcast
    /// echo carries it back so other clients render the reply-ref.
    #[serde(default)]
    pub reply_to_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEditPayload {
    pub message_id: String,
    pub channel_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDeletePayload {
    pub message_id: String,
    pub channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AttachmentPayload {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageNewPayload {
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub username: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypingPayload {
    pub channel_id: String,
    pub user_id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceUpdatePayload {
    pub user_id: String,
    pub status_type: String,
    pub status_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberJoinedPayload {
    pub team_id: String,
    pub user: serde_json::Value,
    pub member: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelJoinPayload {
    pub channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceJoinPayload {
    pub channel_id: String,
}

/// Client → server: invite a specific user to join a voice channel (1:1 ring).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceInvitePayload {
    pub target_user_id: String,
    pub channel_id: String,
}

/// Server → invited client: notify them of an incoming voice call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceIncomingCallPayload {
    pub caller_user_id: String,
    pub caller_username: String,
    pub channel_id: String,
    pub channel_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAnswerPayload {
    pub channel_id: String,
    pub sdp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceICECandidatePayload {
    pub channel_id: String,
    pub candidate: String,
    #[serde(default)]
    pub sdp_mid: String,
    #[serde(default)]
    pub sdp_mline_index: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceOfferPayload {
    pub channel_id: String,
    pub sdp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceMutePayload {
    pub channel_id: String,
    pub muted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceForceMutePayload {
    pub channel_id: String,
    pub target_user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceForceDisconnectPayload {
    pub channel_id: String,
    pub target_user_id: String,
}

/// Client → server: I am publishing my current RTT to the SFU so peers
/// can render real per-user latency. Tiny payload (~30 bytes) so the
/// poll cadence (~1 Hz) costs nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceLatencyPayload {
    pub channel_id: String,
    pub latency_ms: u32,
}

/// Server → all: peer published a new latency sample. Receivers cache
/// it keyed by user_id and use it to drive their own UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceLatencyUpdatePayload {
    pub channel_id: String,
    pub user_id: String,
    pub latency_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceDeafenPayload {
    pub channel_id: String,
    pub deafened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceUserJoinedPayload {
    pub channel_id: String,
    pub user_id: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceUserLeftPayload {
    pub channel_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceKeyDistributePayload {
    pub channel_id: String,
    /// Stamped by the server from the authenticated user_id before
    /// rebroadcast — clients can't forge another peer's identity.
    /// Default-empty on the inbound parse so the client doesn't need
    /// to send a redundant field.
    #[serde(default)]
    pub sender_id: String,
    pub key_id: u32,
    pub encrypted_keys: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelKeyDistributePayload {
    pub channel_id: String,
    #[serde(default)]
    pub sender_id: String,
    pub distribution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionPayload {
    pub message_id: String,
    pub channel_id: String,
    pub emoji: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionEventPayload {
    pub message_id: String,
    pub channel_id: String,
    pub user_id: String,
    pub emoji: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMMessageNewPayload {
    pub id: String,
    pub dm_channel_id: String,
    pub author_id: String,
    pub username: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub created_at: String,
}

// Thread payloads
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessageSendPayload {
    pub thread_id: String,
    pub content: String,
    #[serde(default)]
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessageEditPayload {
    pub thread_id: String,
    pub message_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessageRemovePayload {
    pub thread_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessageNewPayload {
    pub id: String,
    pub thread_id: String,
    pub channel_id: String,
    pub author_id: String,
    pub content: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadUpdatedPayload {
    pub id: String,
    pub title: String,
    pub message_count: i32,
    pub last_message_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessageUpdatedPayload {
    pub id: String,
    pub thread_id: String,
    pub content: String,
    pub edited_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessageDeletedPayload {
    pub id: String,
    pub thread_id: String,
}

// Voice broadcast payloads
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceScreenPayload {
    pub channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceScreenUpdatePayload {
    pub channel_id: String,
    pub user_id: String,
    pub sharing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceWebcamUpdatePayload {
    pub channel_id: String,
    pub user_id: String,
    pub sharing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceMuteUpdatePayload {
    pub channel_id: String,
    pub user_id: String,
    pub muted: bool,
    pub deafened: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceStatePayload {
    pub channel_id: String,
    pub peers: Vec<crate::voice::VoicePeer>,
}

// DM payloads
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMMessageSendPayload {
    pub dm_channel_id: String,
    pub content: String,
    #[serde(rename = "type", default)]
    pub msg_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMMessageEditPayload {
    pub dm_channel_id: String,
    pub message_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMMessageDeletePayload {
    pub dm_channel_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DMTypingPayload {
    pub dm_channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMarkReadPayload {
    pub channel_id: String,
    pub message_id: String,
}

// Request/Response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestEvent {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseEvent {
    pub id: String,
    pub action: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_new_wraps_payload_and_preserves_type() {
        let ev = Event::new("test:event", serde_json::json!({"x": 1})).unwrap();
        assert_eq!(ev.event_type, "test:event");
        assert_eq!(ev.payload, serde_json::json!({"x": 1}));
    }

    #[test]
    fn event_new_accepts_unit_payload() {
        let ev = Event::new("ping", ()).unwrap();
        assert_eq!(ev.event_type, "ping");
        assert_eq!(ev.payload, serde_json::json!(null));
    }

    #[test]
    fn event_to_bytes_roundtrips_through_serde() {
        let ev = Event::new("greeting", serde_json::json!({"hi": "world"})).unwrap();
        let bytes = ev.to_bytes().unwrap();
        let parsed: Event = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed.event_type, "greeting");
        assert_eq!(parsed.payload, serde_json::json!({"hi": "world"}));
    }

    #[test]
    fn event_type_constants_match_protocol_names() {
        // Lock the wire format — if any of these change, every client
        // breaks. Treat these constants as part of the public API.
        assert_eq!(EVENT_MESSAGE_SEND, "message:send");
        assert_eq!(EVENT_MESSAGE_NEW, "message:new");
        assert_eq!(EVENT_TYPING_START, "typing:start");
        assert_eq!(EVENT_TYPING_INDICATOR, "typing:indicator");
        assert_eq!(EVENT_PRESENCE_CHANGED, "presence:changed");
        assert_eq!(EVENT_PING, "ping");
        assert_eq!(EVENT_PONG, "pong");
        assert_eq!(ACTION_SYNC_INIT, "sync:init");
    }

    #[test]
    fn event_deserialize_treats_missing_payload_as_null() {
        let ev: Event = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert_eq!(ev.event_type, "ping");
        assert_eq!(ev.payload, serde_json::json!(null));
    }

    #[test]
    fn message_send_payload_defaults_unset_fields() {
        let s = r#"{"channel_id":"c1","content":"hi"}"#;
        let p: MessageSendPayload = serde_json::from_str(s).unwrap();
        assert_eq!(p.channel_id, "c1");
        assert_eq!(p.content, "hi");
        assert_eq!(p.msg_type, "");
        assert!(p.thread_id.is_none());
        assert!(p.attachment_ids.is_empty());
        assert!(p.reply_to_message_id.is_none());
    }

    #[test]
    fn message_send_payload_renames_msg_type_to_type() {
        let p = MessageSendPayload {
            channel_id: "c".into(),
            content: "x".into(),
            msg_type: "system".into(),
            thread_id: None,
            attachment_ids: vec![],
            reply_to_message_id: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        // Wire field is `type`, not `msg_type`.
        assert!(s.contains("\"type\":\"system\""));
        assert!(!s.contains("msg_type"));
    }

    #[test]
    fn attachment_payload_default_is_empty() {
        let a = AttachmentPayload::default();
        assert_eq!(a.id, "");
        assert_eq!(a.filename, "");
        assert_eq!(a.content_type, "");
        assert_eq!(a.size, 0);
        assert_eq!(a.url, "");
    }
}
