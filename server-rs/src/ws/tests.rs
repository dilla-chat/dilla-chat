use crate::db::{self, Database};
use crate::voice::RoomManager;
use crate::ws::events::*;
use crate::ws::hub::{ClientHandle, Hub, VoiceSFU};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

// ── Test helpers ─────────────────────────────────────────────────────────

/// Create a Database backed by a temporary in-memory-ish SQLite database.
fn test_db() -> Database {
    let tmp = tempfile::tempdir().unwrap();
    let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
    db.run_migrations().unwrap();
    db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
    std::mem::forget(tmp);
    db
}

/// Create a fresh Hub backed by a temporary database.
fn test_hub() -> Arc<Hub> {
    Arc::new(Hub::new(test_db()))
}

/// Create a Hub with voice room manager attached.
fn test_hub_with_voice() -> Arc<Hub> {
    let mut hub = Hub::new(test_db());
    hub.voice_room_manager = Some(Arc::new(RoomManager::new()));
    Arc::new(hub)
}

/// Mock VoiceSFU for testing voice handlers without real WebRTC.
struct MockVoiceSFU {
    join_result: tokio::sync::Mutex<Result<String, String>>,
}

impl MockVoiceSFU {
    fn new_ok() -> Self {
        MockVoiceSFU {
            join_result: tokio::sync::Mutex::new(Ok(r#"{"type":"offer","sdp":"mock-sdp"}"#.to_string())),
        }
    }

    fn new_err() -> Self {
        MockVoiceSFU {
            join_result: tokio::sync::Mutex::new(Err("mock error".to_string())),
        }
    }
}

#[async_trait::async_trait]
impl VoiceSFU for MockVoiceSFU {
    async fn handle_join(&self, _channel_id: &str, _user_id: &str) -> Result<String, String> {
        self.join_result.lock().await.clone()
    }
    async fn handle_leave(&self, _channel_id: &str, _user_id: &str) {}
    async fn handle_answer(&self, _channel_id: &str, _user_id: &str, _sdp: &str) -> Result<(), String> { Ok(()) }
    async fn handle_ice_candidate(&self, _channel_id: &str, _user_id: &str, _candidate: &str, _sdp_mid: &str, _sdp_mline_index: u16) -> Result<(), String> { Ok(()) }
    async fn add_screen_track(&self, _channel_id: &str, _user_id: &str) -> Result<(), String> { Ok(()) }
    async fn remove_screen_track(&self, _channel_id: &str, _user_id: &str) -> Result<(), String> { Ok(()) }
    async fn add_webcam_track(&self, _channel_id: &str, _user_id: &str) -> Result<(), String> { Ok(()) }
    async fn remove_webcam_track(&self, _channel_id: &str, _user_id: &str) -> Result<(), String> { Ok(()) }
    async fn renegotiate_all(&self, _channel_id: &str) {}
}

/// Create a Hub with voice room manager and mock SFU attached.
fn test_hub_with_voice_and_sfu() -> Arc<Hub> {
    let mut hub = Hub::new(test_db());
    hub.voice_room_manager = Some(Arc::new(RoomManager::new()));
    hub.voice_sfu = Some(Arc::new(MockVoiceSFU::new_ok()));
    Arc::new(hub)
}

fn test_hub_with_voice_and_failing_sfu() -> Arc<Hub> {
    let mut hub = Hub::new(test_db());
    hub.voice_room_manager = Some(Arc::new(RoomManager::new()));
    hub.voice_sfu = Some(Arc::new(MockVoiceSFU::new_err()));
    Arc::new(hub)
}

fn spawn_hub(hub: &Arc<Hub>) -> tokio::task::JoinHandle<()> {
    let hub = Arc::clone(hub);
    tokio::spawn(async move { hub.run().await })
}

fn make_client(
    id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
) -> (ClientHandle, mpsc::UnboundedReceiver<Vec<u8>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = ClientHandle {
        id: id.to_string(),
        user_id: user_id.to_string(),
        username: username.to_string(),
        team_id: team_id.to_string(),
        sender: tx,
    };
    (handle, rx)
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(30)).await;
}

/// Seed a team + user + channel in the DB for testing handlers that verify ownership.
fn seed_team_channel(db: &Database, team_id: &str, user_id: &str, channel_id: &str) {
    db.with_conn(|conn| {
        db::create_user(conn, &make_test_user(user_id, "testuser", "Test User", &[0u8; 32]))?;
        db::create_team(
            conn,
            &db::Team {
                id: team_id.to_string(),
                name: "Test Team".to_string(),
                description: String::new(),
                icon_url: String::new(),
                created_by: user_id.to_string(),
                max_file_size: 10_000_000,
                allow_member_invites: true,
                created_at: db::now_str(),
                updated_at: db::now_str(),
            },
        )?;
        db::create_channel(
            conn,
            &db::Channel {
                id: channel_id.to_string(),
                team_id: team_id.to_string(),
                name: "general".to_string(),
                topic: String::new(),
                channel_type: "text".to_string(),
                position: 0,
                category: String::new(),
                created_by: user_id.to_string(),
                created_at: db::now_str(),
                updated_at: db::now_str(),
            },
        )?;
        db::create_member(
            conn,
            &db::Member {
                id: db::new_id(),
                team_id: team_id.to_string(),
                user_id: user_id.to_string(),
                nickname: String::new(),
                joined_at: db::now_str(),
                invited_by: String::new(),
                updated_at: db::now_str(),
            },
        )?;
        Ok(())
    })
    .unwrap();
}

/// Seed a DM channel with two members.
fn seed_dm_channel(db: &Database, team_id: &str, dm_id: &str, user1: &str, user2: &str) {
    db.with_conn(|conn| {
        db::create_dm_channel(
            conn,
            &db::DMChannel {
                id: dm_id.to_string(),
                team_id: team_id.to_string(),
                dm_type: "dm".to_string(),
                name: String::new(),
                created_at: db::now_str(),
            },
        )?;
        db::add_dm_members(conn, dm_id, &[user1.to_string(), user2.to_string()])?;
        Ok(())
    })
    .unwrap();
}

/// Seed a thread in the DB.
fn seed_thread(db: &Database, thread_id: &str, channel_id: &str, team_id: &str, creator_id: &str, parent_msg_id: &str) {
    db.with_conn(|conn| {
        db::create_thread(
            conn,
            &db::Thread {
                id: thread_id.to_string(),
                channel_id: channel_id.to_string(),
                parent_message_id: parent_msg_id.to_string(),
                team_id: team_id.to_string(),
                creator_id: creator_id.to_string(),
                title: "Test Thread".to_string(),
                message_count: 0,
                last_message_at: None,
                created_at: db::now_str(),
            },
        )?;
        Ok(())
    })
    .unwrap();
}

/// Build a test user struct.
fn make_test_user(id: &str, username: &str, display_name: &str, public_key: &[u8]) -> db::User {
    db::User {
        id: id.to_string(),
        username: username.to_string(),
        display_name: display_name.to_string(),
        public_key: public_key.to_vec(),
        avatar_url: String::new(),
        status_text: String::new(),
        status_type: "online".to_string(),
        is_admin: false,
        created_at: db::now_str(),
        updated_at: db::now_str(),
    }
}

/// Build a test message struct.
fn make_test_msg(id: &str, channel_id: &str, dm_channel_id: &str, author_id: &str, content: &str, thread_id: &str) -> db::Message {
    db::Message {
        id: id.to_string(),
        channel_id: channel_id.to_string(),
        dm_channel_id: dm_channel_id.to_string(),
        author_id: author_id.to_string(),
        content: content.to_string(),
        msg_type: "text".to_string(),
        thread_id: thread_id.to_string(),
        edited_at: None,
        deleted: false,
        lamport_ts: 0,
        created_at: db::now_str(),
    }
}

/// Insert a channel message into the DB, returning the message ID.
fn insert_channel_msg(db: &Database, channel_id: &str, author_id: &str, content: &str) -> String {
    let id = db::new_id();
    db.with_conn(|conn| db::create_message(conn, &make_test_msg(&id, channel_id, "", author_id, content, ""))).unwrap();
    id
}

/// Insert a DM message into the DB, returning the message ID.
fn insert_dm_msg(db: &Database, dm_channel_id: &str, author_id: &str, content: &str) -> String {
    let id = db::new_id();
    db.with_conn(|conn| db::create_message(conn, &make_test_msg(&id, "", dm_channel_id, author_id, content, ""))).unwrap();
    id
}

/// Insert a thread message into the DB, returning the message ID.
fn insert_thread_msg(db: &Database, channel_id: &str, thread_id: &str, author_id: &str, content: &str) -> String {
    let id = db::new_id();
    db.with_conn(|conn| db::create_thread_message(conn, &make_test_msg(&id, channel_id, "", author_id, content, thread_id))).unwrap();
    id
}

/// Seed a second user "u2"/"bob" used in many DM tests.
fn seed_bob(db: &Database) {
    db.with_conn(|conn| db::create_user(conn, &make_test_user("u2", "bob", "Bob", &[1u8; 32]))).unwrap();
}

/// Seed a parent message + thread, returning (parent_msg_id, thread_id).
fn seed_parent_and_thread(db: &Database, channel_id: &str, team_id: &str, creator_id: &str) -> (String, String) {
    let parent_msg_id = insert_channel_msg(db, channel_id, creator_id, "parent");
    let thread_id = db::new_id();
    seed_thread(db, &thread_id, channel_id, team_id, creator_id, &parent_msg_id);
    (parent_msg_id, thread_id)
}

/// Common DM setup: seed team+channel, bob, DM channel.
fn seed_dm_fixture(db: &Database) {
    seed_team_channel(db, "t1", "u1", "ch-ignore");
    seed_bob(db);
    seed_dm_channel(db, "t1", "dm1", "u1", "u2");
}

/// Register client and settle.
async fn register(hub: &Arc<Hub>, client: ClientHandle) {
    hub.register(client).await;
    settle().await;
}

/// Subscribe client to channel and settle.
async fn subscribe(hub: &Arc<Hub>, client_id: &str, channel: &str) {
    hub.subscribe(client_id, channel).await;
    settle().await;
}

/// Register + subscribe helper.
async fn register_and_subscribe(hub: &Arc<Hub>, client: ClientHandle, channel: &str) {
    let id = client.id.clone();
    register(hub, client).await;
    subscribe(hub, &id, channel).await;
}

/// Receive and parse a single event from the receiver within a timeout.
async fn recv_event(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Event {
    let msg = timeout(Duration::from_millis(200), rx.recv())
        .await
        .expect("timed out waiting for event")
        .expect("channel closed");
    parse_event(&msg)
}

/// Assert that no message is received within the timeout.
async fn assert_no_recv(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, context: &str) {
    let result = timeout(Duration::from_millis(100), rx.recv()).await;
    assert!(result.is_err(), "{}", context);
}

/// Collect all events received within a short window.
async fn drain_events(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, max: usize) -> Vec<Event> {
    let mut events = Vec::new();
    for _ in 0..max {
        match timeout(Duration::from_millis(100), rx.recv()).await {
            Ok(Some(data)) => events.push(parse_event(&data)),
            _ => break,
        }
    }
    events
}

/// Helper to parse a received event from raw bytes.
fn parse_event(data: &[u8]) -> Event {
    serde_json::from_slice(data).expect("failed to parse event from bytes")
}

/// Drain hub events looking for a match, using a predicate.
async fn find_hub_event<F: Fn(&super::hub::HubEvent) -> bool>(
    event_rx: &mut tokio::sync::broadcast::Receiver<super::hub::HubEvent>,
    pred: F,
    desc: &str,
) -> super::hub::HubEvent {
    for _ in 0..10 {
        match timeout(Duration::from_millis(100), event_rx.recv()).await {
            Ok(Ok(evt)) if pred(&evt) => return evt,
            _ => continue,
        }
    }
    panic!("{} hub event was not found", desc);
}

// =========================================================================
// Event serialization/deserialization tests
// =========================================================================

#[test]
fn event_new_creates_valid_event() {
    let evt = Event::new("test:event", serde_json::json!({"key": "val"})).unwrap();
    assert_eq!(evt.event_type, "test:event");
    assert_eq!(evt.payload["key"], "val");
}

#[test]
fn event_to_bytes_roundtrips() {
    let evt = Event::new("ping", serde_json::json!({})).unwrap();
    let bytes = evt.to_bytes().unwrap();
    let parsed: Event = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed.event_type, "ping");
}

#[test]
fn event_deserializes_with_type_field() {
    let json = r#"{"type":"message:send","payload":{"channel_id":"ch1","content":"hi"}}"#;
    let evt: Event = serde_json::from_str(json).unwrap();
    assert_eq!(evt.event_type, "message:send");
    assert_eq!(evt.payload["channel_id"], "ch1");
}

#[test]
fn event_payload_defaults_to_null_when_missing() {
    let json = r#"{"type":"ping"}"#;
    let evt: Event = serde_json::from_str(json).unwrap();
    assert_eq!(evt.event_type, "ping");
    assert!(evt.payload.is_null());
}

// =========================================================================
// Payload parsing tests
// =========================================================================

#[test]
fn channel_join_payload_parses() {
    let json = r#"{"channel_id":"ch123"}"#;
    let p: ChannelJoinPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.channel_id, "ch123");
}

#[test]
fn message_send_payload_defaults_type_and_thread() {
    let json = r#"{"channel_id":"ch1","content":"hello"}"#;
    let p: MessageSendPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.msg_type, "");
    assert_eq!(p.thread_id, None);
}

#[test]
fn voice_join_payload_parses() {
    let json = r#"{"channel_id":"voice-1"}"#;
    let p: VoiceJoinPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.channel_id, "voice-1");
}

#[test]
fn voice_mute_payload_parses() {
    let json = r#"{"channel_id":"v1","muted":true}"#;
    let p: VoiceMutePayload = serde_json::from_str(json).unwrap();
    assert!(p.muted);
}

#[test]
fn voice_deafen_payload_parses() {
    let json = r#"{"channel_id":"v1","deafened":true}"#;
    let p: VoiceDeafenPayload = serde_json::from_str(json).unwrap();
    assert!(p.deafened);
}

#[test]
fn reaction_payload_parses() {
    let json = r#"{"message_id":"m1","channel_id":"ch1","emoji":"👍"}"#;
    let p: ReactionPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.emoji, "\u{1f44d}");
}

#[test]
fn thread_message_send_payload_parses() {
    let json = r#"{"thread_id":"t1","content":"reply"}"#;
    let p: ThreadMessageSendPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.thread_id, "t1");
    assert_eq!(p.content, "reply");
    assert_eq!(p.nonce, "");
}

#[test]
fn dm_message_send_payload_defaults_type() {
    let json = r#"{"dm_channel_id":"dm1","content":"hey"}"#;
    let p: DMMessageSendPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.msg_type, "");
}

#[test]
fn request_event_parses() {
    let json = r#"{"id":"req1","action":"sync:init","payload":{}}"#;
    let r: RequestEvent = serde_json::from_str(json).unwrap();
    assert_eq!(r.id, "req1");
    assert_eq!(r.action, "sync:init");
}

#[test]
fn response_event_serializes_without_none_fields() {
    let r = ResponseEvent {
        id: "r1".to_string(),
        action: "test".to_string(),
        ok: true,
        payload: None,
        error: None,
    };
    let json = serde_json::to_string(&r).unwrap();
    assert!(!json.contains("payload"));
    assert!(!json.contains("error"));
}

#[test]
fn voice_key_distribute_payload_parses() {
    let json = r#"{"channel_id":"v1","sender_id":"","key_id":42,"encrypted_keys":{"u1":"abc"}}"#;
    let p: VoiceKeyDistributePayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.key_id, 42);
    assert_eq!(p.encrypted_keys.get("u1").unwrap(), "abc");
}

#[test]
fn dm_typing_payload_parses() {
    let json = r#"{"dm_channel_id":"dm1"}"#;
    let p: DMTypingPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.dm_channel_id, "dm1");
}

// =========================================================================
// client.rs dispatch: handle_event tests
// =========================================================================

// ── handle_channel_event ─────────────────────────────────────────────────

#[tokio::test]
async fn handle_channel_join_subscribes_client() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (client, mut rx) = make_client("c1", "u1", "alice", "t1");
    register(&hub, client).await;

    hub.subscribe("c1", "chan-test").await;
    settle().await;

    hub.broadcast_to_channel("chan-test", b"verify".to_vec(), None).await;
    settle().await;

    let msg = timeout(Duration::from_millis(100), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(msg, b"verify");
}

// ── handle_ping ──────────────────────────────────────────────────────────

#[tokio::test]
async fn handle_ping_sends_pong_to_user() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (client, mut rx) = make_client("c1", "u1", "alice", "t1");
    register(&hub, client).await;

    let pong = Event::new(EVENT_PONG, serde_json::json!({})).unwrap();
    hub.send_to_user("u1", pong.to_bytes().unwrap()).await;
    settle().await;

    let evt = recv_event(&mut rx).await;
    assert_eq!(evt.event_type, "pong");
}

// ── handle_presence_update ───────────────────────────────────────────────

#[tokio::test]
async fn handle_presence_update_emits_hub_event() {
    let hub = test_hub();
    let mut event_rx = hub.event_tx().subscribe();

    let payload = serde_json::json!({
        "user_id": "u1",
        "status_type": "dnd",
        "status_text": "busy"
    });

    if let Ok(p) = serde_json::from_value::<PresenceUpdatePayload>(payload) {
        hub.emit_event(super::hub::HubEvent::PresenceUpdate {
            user_id: "u1".to_string(),
            status: p.status_type,
            custom_status: p.status_text,
        });
    }

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::PresenceUpdate { .. }), "PresenceUpdate").await;
    match evt {
        super::hub::HubEvent::PresenceUpdate { user_id, status, custom_status } => {
            assert_eq!(user_id, "u1");
            assert_eq!(status, "dnd");
            assert_eq!(custom_status, "busy");
        }
        _ => unreachable!(),
    }
}

// =========================================================================
// handlers/message.rs tests
// =========================================================================

#[tokio::test]
async fn message_send_creates_and_broadcasts() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "ch1").await;
    subscribe(&hub, "c2", "ch1").await;

    let payload = serde_json::json!({"channel_id": "ch1", "content": "hello world"});
    super::handlers::handle_message_send(&hub, "c1", "u1", "alice", "t1", payload).await;
    settle().await;

    let evt1 = recv_event(&mut rx1).await;
    assert_eq!(evt1.event_type, EVENT_MESSAGE_NEW);
    assert_eq!(evt1.payload["content"], "hello world");
    assert_eq!(evt1.payload["author_id"], "u1");

    let evt2 = recv_event(&mut rx2).await;
    assert_eq!(evt2.event_type, EVENT_MESSAGE_NEW);
}

#[tokio::test]
async fn message_send_rejects_wrong_team() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let payload = serde_json::json!({"channel_id": "ch1", "content": "should not work"});
    super::handlers::handle_message_send(&hub, "c1", "u1", "alice", "wrong-team", payload).await;
    settle().await;

    assert_no_recv(&mut rx1, "no message should be sent for wrong team").await;
}

#[tokio::test]
async fn message_send_with_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::handlers::handle_message_send(&hub, "c1", "u1", "alice", "t1", serde_json::json!({"invalid": true})).await;
}

#[tokio::test]
async fn message_edit_updates_and_broadcasts() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "original");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let payload = serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "content": "edited"});
    super::handlers::handle_message_edit(&hub, "u1", payload).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_MESSAGE_UPDATED);
}

#[tokio::test]
async fn message_edit_by_non_author_is_rejected() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "original");

    let (c1, mut rx1) = make_client("c1", "u2", "eve", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let payload = serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "content": "hacked"});
    super::handlers::handle_message_edit(&hub, "u2", payload).await;
    settle().await;

    assert_no_recv(&mut rx1, "non-author should not be able to edit").await;
}

#[tokio::test]
async fn message_delete_soft_deletes_and_broadcasts() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "to delete");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let payload = serde_json::json!({"message_id": msg_id, "channel_id": "ch1"});
    super::handlers::handle_message_delete(&hub, "u1", payload).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_MESSAGE_DELETED);
}

// =========================================================================
// handlers/typing tests
// =========================================================================

#[tokio::test]
async fn typing_broadcasts_to_channel_excluding_sender() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "ch1").await;
    subscribe(&hub, "c2", "ch1").await;

    super::handlers::handle_typing(&hub, "c1", "u1", "alice", serde_json::json!({"channel_id": "ch1"})).await;
    settle().await;

    let evt = recv_event(&mut rx2).await;
    assert_eq!(evt.event_type, EVENT_TYPING_INDICATOR);
    assert_eq!(evt.payload["user_id"], "u1");

    assert_no_recv(&mut rx1, "sender should be excluded from typing indicator").await;
}

#[tokio::test]
async fn typing_is_throttled() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "ch1").await;
    subscribe(&hub, "c2", "ch1").await;

    // First typing event should go through
    super::handlers::handle_typing(&hub, "c1", "u1", "alice", serde_json::json!({"channel_id": "ch1"})).await;
    settle().await;

    let msg = timeout(Duration::from_millis(200), rx2.recv()).await;
    assert!(msg.is_ok(), "first typing event should be received");

    // Second typing event within throttle period should be dropped
    super::handlers::handle_typing(&hub, "c1", "u1", "alice", serde_json::json!({"channel_id": "ch1"})).await;
    settle().await;

    assert_no_recv(&mut rx2, "throttled typing event should not be received").await;
}

// =========================================================================
// handlers/reaction.rs tests
// =========================================================================

#[tokio::test]
async fn reaction_add_stores_and_broadcasts() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "react to me");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let p = ReactionPayload { message_id: msg_id, channel_id: "ch1".to_string(), emoji: "thumbsup".to_string() };
    super::handlers::handle_reaction_add(&hub, "u1", "t1", p).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_REACTION_ADDED);
    assert_eq!(evt.payload["emoji"], "thumbsup");
}

#[tokio::test]
async fn reaction_remove_deletes_and_broadcasts() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "react");
    hub.db.with_conn(|conn| db::add_reaction(conn, &msg_id, "u1", "thumbsup")).unwrap();

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let p = ReactionPayload { message_id: msg_id, channel_id: "ch1".to_string(), emoji: "thumbsup".to_string() };
    super::handlers::handle_reaction_remove(&hub, "u1", "t1", p).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_REACTION_REMOVED);
}

// =========================================================================
// handlers/thread.rs tests
// =========================================================================

#[tokio::test]
async fn thread_message_send_creates_and_broadcasts() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (_parent_msg_id, thread_id) = seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let p = ThreadMessageSendPayload { thread_id: thread_id.clone(), content: "thread reply".to_string(), nonce: String::new() };
    super::handlers::handle_thread_message_send(&hub, "u1", "t1", p).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_THREAD_MESSAGE_NEW);
    assert_eq!(evt.payload["content"], "thread reply");
    assert_eq!(evt.payload["thread_id"], thread_id);

    let evt2 = recv_event(&mut rx1).await;
    assert_eq!(evt2.event_type, EVENT_THREAD_UPDATED);
}

#[tokio::test]
async fn thread_message_edit_broadcasts_update() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (_parent_msg_id, thread_id) = seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");
    let thread_msg_id = insert_thread_msg(&hub.db, "ch1", &thread_id, "u1", "original");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let p = ThreadMessageEditPayload { thread_id, message_id: thread_msg_id, content: "edited thread msg".to_string() };
    super::handlers::handle_thread_message_edit(&hub, "u1", p).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_THREAD_MESSAGE_UPDATED);
    assert_eq!(evt.payload["content"], "edited thread msg");
}

#[tokio::test]
async fn thread_message_remove_broadcasts_deletion() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (_parent_msg_id, thread_id) = seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");
    let thread_msg_id = insert_thread_msg(&hub.db, "ch1", &thread_id, "u1", "to delete");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let p = ThreadMessageRemovePayload { thread_id, message_id: thread_msg_id };
    super::handlers::handle_thread_message_remove(&hub, "u1", p).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_THREAD_MESSAGE_DELETED);
}

// =========================================================================
// handlers/dm.rs tests
// =========================================================================

#[tokio::test]
async fn dm_message_send_delivers_to_members() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    let p = DMMessageSendPayload { dm_channel_id: "dm1".to_string(), content: "hey bob".to_string(), msg_type: String::new() };
    super::handlers::handle_dm_message_send(&hub, "u1", "alice", p).await;
    settle().await;

    let evt1 = recv_event(&mut rx1).await;
    assert_eq!(evt1.event_type, EVENT_DM_MESSAGE_NEW);
    assert_eq!(evt1.payload["content"], "hey bob");

    let evt2 = recv_event(&mut rx2).await;
    assert_eq!(evt2.event_type, EVENT_DM_MESSAGE_NEW);
}

#[tokio::test]
async fn dm_message_send_rejects_non_member() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c3, mut rx3) = make_client("c3", "u3", "eve", "t1");
    register(&hub, c3).await;

    let p = DMMessageSendPayload { dm_channel_id: "dm1".to_string(), content: "hacked".to_string(), msg_type: String::new() };
    super::handlers::handle_dm_message_send(&hub, "u3", "eve", p).await;
    settle().await;

    assert_no_recv(&mut rx3, "non-member should not be able to send DM").await;
}

#[tokio::test]
async fn dm_message_edit_broadcasts_update() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let msg_id = insert_dm_msg(&hub.db, "dm1", "u1", "original dm");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    let p = DMMessageEditPayload { dm_channel_id: "dm1".to_string(), message_id: msg_id, content: "edited dm".to_string() };
    super::handlers::handle_dm_message_edit(&hub, "u1", p).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_DM_MESSAGE_UPDATED);
    assert_eq!(recv_event(&mut rx2).await.event_type, EVENT_DM_MESSAGE_UPDATED);
}

#[tokio::test]
async fn dm_message_delete_broadcasts_deletion() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let msg_id = insert_dm_msg(&hub.db, "dm1", "u1", "delete me");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    let p = DMMessageDeletePayload { dm_channel_id: "dm1".to_string(), message_id: msg_id };
    super::handlers::handle_dm_message_delete(&hub, "u1", p).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_DM_MESSAGE_DELETED);
    assert_eq!(recv_event(&mut rx2).await.event_type, EVENT_DM_MESSAGE_DELETED);
}

// =========================================================================
// handlers/voice.rs tests
// =========================================================================

#[tokio::test]
async fn voice_join_without_room_manager_returns_early() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    let p = VoiceJoinPayload { channel_id: "voice-ch".to_string() };
    super::handlers::handle_voice_join(&hub, "c1", "u1", "alice", "t1", p).await;
}

#[tokio::test]
async fn voice_join_adds_peer_and_broadcasts() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "voice-ch");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    let p = VoiceJoinPayload { channel_id: "voice-ch".to_string() };
    super::handlers::handle_voice_join(&hub, "c1", "u1", "alice", "t1", p).await;
    settle().await;

    let rm = hub.voice_room_manager.as_ref().unwrap();
    let peers = rm.get_room("voice-ch").await.unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].user_id, "u1");

    let c1_events = drain_events(&mut rx1, 10).await;
    let c2_events = drain_events(&mut rx2, 10).await;

    let c1_types: Vec<&str> = c1_events.iter().map(|e| e.event_type.as_str()).collect();
    let c2_types: Vec<&str> = c2_events.iter().map(|e| e.event_type.as_str()).collect();
    assert!(c1_types.contains(&EVENT_VOICE_USER_JOINED), "c1 should get voice:user-joined, got {:?}", c1_types);
    assert!(c2_types.contains(&EVENT_VOICE_USER_JOINED), "c2 should get voice:user-joined, got {:?}", c2_types);
}

#[tokio::test]
async fn voice_join_sends_voice_state_to_joiner() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "voice-ch");

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u-existing", "existing-user", "t1").await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let p = VoiceJoinPayload { channel_id: "voice-ch".to_string() };
    super::handlers::handle_voice_join(&hub, "c1", "u1", "alice", "t1", p).await;
    settle().await;

    let events = drain_events(&mut rx1, 10).await;
    let event_types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert!(event_types.contains(&EVENT_VOICE_USER_JOINED), "should have voice:user-joined, got {:?}", event_types);
    assert!(event_types.contains(&EVENT_VOICE_STATE), "should have voice:state, got {:?}", event_types);
    assert!(event_types.contains(&EVENT_VOICE_OFFER), "should have voice:offer, got {:?}", event_types);
}

#[tokio::test]
async fn voice_join_with_failing_sfu_does_not_crash() {
    let hub = test_hub_with_voice_and_failing_sfu();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "voice-ch");

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let p = VoiceJoinPayload { channel_id: "voice-ch".to_string() };
    super::handlers::handle_voice_join(&hub, "c1", "u1", "alice", "t1", p).await;
}

#[tokio::test]
async fn voice_leave_removes_peer_and_broadcasts() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "voice-ch").await;

    let p = VoiceJoinPayload { channel_id: "voice-ch".to_string() };
    super::handlers::handle_voice_leave(&hub, "c1", "u1", p).await;
    settle().await;

    assert!(rm.get_room("voice-ch").await.is_none(), "room should be empty after last peer leaves");

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_USER_LEFT);
    assert_eq!(evt.payload["user_id"], "u1");
}

#[tokio::test]
async fn voice_mute_updates_state_and_broadcasts() {
    let hub = test_hub_with_voice();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let p = VoiceMutePayload { channel_id: "voice-ch".to_string(), muted: true };
    super::handlers::handle_voice_mute(&hub, "u1", p).await;
    settle().await;

    assert!(rm.get_room("voice-ch").await.unwrap()[0].muted);

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_MUTE_UPDATE);
    assert_eq!(evt.payload["muted"], true);
}

#[tokio::test]
async fn voice_deafen_also_mutes() {
    let hub = test_hub_with_voice();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let p = VoiceDeafenPayload { channel_id: "voice-ch".to_string(), deafened: true };
    super::handlers::handle_voice_deafen(&hub, "u1", p).await;
    settle().await;

    let peers = rm.get_room("voice-ch").await.unwrap();
    assert!(peers[0].deafened);
    assert!(peers[0].muted, "deafening should also mute");

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_MUTE_UPDATE);
    assert_eq!(evt.payload["deafened"], true);
    assert_eq!(evt.payload["muted"], true);
}

#[tokio::test]
async fn voice_screen_start_sets_sharing_and_broadcasts() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_screen_start(&hub, "u1", VoiceScreenPayload { channel_id: "voice-ch".to_string() }).await;
    settle().await;

    assert!(rm.get_room("voice-ch").await.unwrap()[0].screen_sharing);

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_SCREEN_UPDATE);
    assert_eq!(evt.payload["sharing"], true);
}

#[tokio::test]
async fn voice_screen_stop_clears_sharing_and_broadcasts() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;
    rm.set_screen_sharing("voice-ch", "u1", true).await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_screen_stop(&hub, "u1", VoiceScreenPayload { channel_id: "voice-ch".to_string() }).await;
    settle().await;

    assert!(!rm.get_room("voice-ch").await.unwrap()[0].screen_sharing);

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_SCREEN_UPDATE);
    assert_eq!(evt.payload["sharing"], false);
}

#[tokio::test]
async fn voice_webcam_start_sets_sharing_and_broadcasts() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_webcam_start(&hub, "u1", VoiceScreenPayload { channel_id: "voice-ch".to_string() }).await;
    settle().await;

    assert!(rm.get_room("voice-ch").await.unwrap()[0].webcam_sharing);

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_WEBCAM_UPDATE);
    assert_eq!(evt.payload["sharing"], true);
}

#[tokio::test]
async fn voice_webcam_stop_clears_sharing_and_broadcasts() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;
    rm.set_webcam_sharing("voice-ch", "u1", true).await;

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_webcam_stop(&hub, "u1", VoiceScreenPayload { channel_id: "voice-ch".to_string() }).await;
    settle().await;

    assert!(!rm.get_room("voice-ch").await.unwrap()[0].webcam_sharing);

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_VOICE_WEBCAM_UPDATE);
    assert_eq!(evt.payload["sharing"], false);
}

#[tokio::test]
async fn voice_answer_without_sfu_does_not_panic() {
    let hub = test_hub();
    super::handlers::handle_voice_answer(&hub, "u1", VoiceAnswerPayload { channel_id: "voice-ch".to_string(), sdp: "mock-sdp".to_string() }).await;
}

#[tokio::test]
async fn voice_ice_candidate_without_sfu_does_not_panic() {
    let hub = test_hub();
    super::handlers::handle_voice_ice_candidate(&hub, "u1", VoiceICECandidatePayload {
        channel_id: "voice-ch".to_string(), candidate: "candidate:...".to_string(),
        sdp_mid: "0".to_string(), sdp_mline_index: 0,
    }).await;
}

// =========================================================================
// client.rs: handle_voice_key_distribute (tested via its inner logic)
// =========================================================================

#[tokio::test]
async fn voice_key_distribute_broadcasts_to_channel_excluding_sender() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "voice-ch").await;
    subscribe(&hub, "c2", "voice-ch").await;

    let mut p = VoiceKeyDistributePayload {
        channel_id: "voice-ch".to_string(), sender_id: String::new(), key_id: 1,
        encrypted_keys: { let mut m = HashMap::new(); m.insert("u2".to_string(), "encrypted-key-data".to_string()); m },
    };
    p.sender_id = "u1".to_string();
    let evt = Event::new(EVENT_VOICE_KEY_DISTRIBUTE, &p).unwrap();
    hub.broadcast_to_channel(&p.channel_id, evt.to_bytes().unwrap(), Some("c1".to_string())).await;
    settle().await;

    let evt = recv_event(&mut rx2).await;
    assert_eq!(evt.event_type, EVENT_VOICE_KEY_DISTRIBUTE);
    assert_eq!(evt.payload["sender_id"], "u1");

    assert_no_recv(&mut rx1, "sender should not receive key distribute").await;
}

// =========================================================================
// handlers/request.rs tests
// =========================================================================

/// Helper to send a request and receive the response event.
async fn send_request_and_recv(hub: &Arc<Hub>, user_id: &str, team_id: &str, req: RequestEvent, rx: &mut mpsc::UnboundedReceiver<Vec<u8>>) -> Event {
    super::handlers::handle_request(hub, user_id, team_id, req).await;
    settle().await;
    recv_event(rx).await
}

#[tokio::test]
async fn request_sync_init_returns_team_data() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req1".to_string(), action: ACTION_SYNC_INIT.to_string(), payload: serde_json::json!({}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.event_type, "response");
    assert_eq!(evt.payload["ok"], true);
    assert_eq!(evt.payload["action"], "sync:init");
    assert!(evt.payload["payload"]["channels"].is_array());
}

#[tokio::test]
async fn request_message_list_returns_messages() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    for i in 0..3 {
        insert_channel_msg(&hub.db, "ch1", "u1", &format!("msg {}", i));
    }

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req2".to_string(), action: ACTION_MESSAGE_LIST.to_string(), payload: serde_json::json!({"channel_id": "ch1"}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.payload["ok"], true);
    assert!(evt.payload["payload"].is_array());
}

#[tokio::test]
async fn request_unknown_action_returns_null_payload() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req3".to_string(), action: "nonexistent:action".to_string(), payload: serde_json::json!({}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.payload["ok"], true);
    assert!(evt.payload["payload"].is_null());
}

#[tokio::test]
async fn request_dm_list_returns_channels() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req4".to_string(), action: ACTION_DM_LIST.to_string(), payload: serde_json::json!({}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.payload["ok"], true);
    assert!(evt.payload["payload"]["dm_channels"].is_array());
}

#[tokio::test]
async fn request_thread_list_returns_threads() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req5".to_string(), action: ACTION_THREAD_LIST.to_string(), payload: serde_json::json!({"channel_id": "ch1"}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.payload["ok"], true);
    assert!(evt.payload["payload"].is_array());
}

#[tokio::test]
async fn request_thread_messages_returns_messages() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (_parent_msg_id, thread_id) = seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");
    insert_thread_msg(&hub.db, "ch1", &thread_id, "u1", "thread reply");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req-tm".to_string(), action: ACTION_THREAD_MESSAGES.to_string(), payload: serde_json::json!({"thread_id": thread_id}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.payload["ok"], true);
    assert!(evt.payload["payload"].is_array());
}

#[tokio::test]
async fn request_dm_messages_returns_messages() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    insert_dm_msg(&hub.db, "dm1", "u1", "dm content");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let req = RequestEvent { id: "req-dm-msgs".to_string(), action: ACTION_DM_MESSAGES.to_string(), payload: serde_json::json!({"dm_id": "dm1"}) };
    let evt = send_request_and_recv(&hub, "u1", "t1", req, &mut rx1).await;

    assert_eq!(evt.payload["ok"], true);
    assert!(evt.payload["payload"].is_array());
}

// =========================================================================
// Voice RoomManager unit tests
// =========================================================================

#[tokio::test]
async fn room_manager_add_and_remove_peer() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;

    let peers = rm.get_room("ch1").await.unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].user_id, "u1");
    assert!(!peers[0].muted);

    rm.remove_peer("ch1", "u1").await;
    assert!(rm.get_room("ch1").await.is_none());
}

#[tokio::test]
async fn room_manager_set_muted() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;
    rm.set_muted("ch1", "u1", true).await;
    assert!(rm.get_room("ch1").await.unwrap()[0].muted);
}

#[tokio::test]
async fn room_manager_set_deafened() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;
    rm.set_deafened("ch1", "u1", true).await;
    assert!(rm.get_room("ch1").await.unwrap()[0].deafened);
}

#[tokio::test]
async fn room_manager_screen_sharing() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;

    assert!(rm.screen_sharer("ch1").await.is_none());
    rm.set_screen_sharing("ch1", "u1", true).await;
    assert_eq!(rm.screen_sharer("ch1").await, Some("u1".to_string()));
    rm.set_screen_sharing("ch1", "u1", false).await;
    assert!(rm.screen_sharer("ch1").await.is_none());
}

#[tokio::test]
async fn room_manager_webcam_sharing() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;
    rm.set_webcam_sharing("ch1", "u1", true).await;
    assert!(rm.get_room("ch1").await.unwrap()[0].webcam_sharing);
}

#[tokio::test]
async fn room_manager_get_rooms_by_team() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;
    rm.add_peer("ch2", "u2", "bob", "t1").await;
    rm.add_peer("ch3", "u3", "charlie", "t2").await;

    let rooms = rm.get_rooms_by_team("t1").await;
    assert_eq!(rooms.len(), 2);

    let rooms_t2 = rm.get_rooms_by_team("t2").await;
    assert_eq!(rooms_t2.len(), 1);
}

#[tokio::test]
async fn room_manager_multiple_peers_in_room() {
    let rm = RoomManager::new();
    rm.add_peer("ch1", "u1", "alice", "t1").await;
    rm.add_peer("ch1", "u2", "bob", "t1").await;

    assert_eq!(rm.get_room("ch1").await.unwrap().len(), 2);

    rm.remove_peer("ch1", "u1").await;
    let peers = rm.get_room("ch1").await.unwrap();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].user_id, "u2");
}

#[tokio::test]
async fn room_manager_get_nonexistent_room() {
    let rm = RoomManager::new();
    assert!(rm.get_room("nonexistent").await.is_none());
}

// =========================================================================
// voice/signaling.rs: SFU creation and parse_ice_servers
// =========================================================================

#[test]
fn sfu_new_creates_instance() {
    use crate::voice::signaling::SFU;
    let _sfu = SFU::new();
}

#[tokio::test]
async fn sfu_set_on_event_stores_callback() {
    use crate::voice::signaling::SFU;
    let sfu = SFU::new();
    sfu.set_on_event(|_channel_id, _event| {}).await;
}

#[tokio::test]
async fn sfu_handle_leave_on_empty_room_does_not_panic() {
    use crate::voice::signaling::SFU;
    let sfu = SFU::new();
    sfu.handle_leave("nonexistent", "u1").await;
}

#[tokio::test]
async fn sfu_renegotiate_all_on_empty_room_does_not_panic() {
    use crate::voice::signaling::SFU;
    let sfu = SFU::new();
    sfu.renegotiate_all("nonexistent").await;
}

#[tokio::test]
async fn sfu_renegotiate_all_except_on_empty_room_does_not_panic() {
    use crate::voice::signaling::SFU;
    let sfu = SFU::new();
    sfu.renegotiate_all_except("nonexistent", "u1").await;
}

// =========================================================================
// client.rs dispatch tests (Event -> handler routing)
// =========================================================================

#[tokio::test]
async fn dispatch_channel_join_event_subscribes() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let payload = serde_json::json!({"channel_id": "test-chan"});
    if let Ok(p) = serde_json::from_value::<ChannelJoinPayload>(payload) {
        hub.subscribe("c1", &p.channel_id).await;
    }
    settle().await;

    hub.broadcast_to_channel("test-chan", b"verify".to_vec(), None).await;
    settle().await;

    let msg = timeout(Duration::from_millis(100), rx1.recv()).await.unwrap().unwrap();
    assert_eq!(msg, b"verify");
}

#[tokio::test]
async fn dispatch_channel_leave_event_unsubscribes() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;
    subscribe(&hub, "c1", "test-chan").await;

    hub.unsubscribe("c1", "test-chan").await;
    settle().await;

    hub.broadcast_to_channel("test-chan", b"should-not-recv".to_vec(), None).await;
    settle().await;

    assert_no_recv(&mut rx1, "unsubscribed client should not receive broadcast").await;
}

// =========================================================================
// Edge case tests
// =========================================================================

#[tokio::test]
async fn voice_mute_without_room_manager_does_not_panic() {
    let hub = test_hub();
    super::handlers::handle_voice_mute(&hub, "u1", VoiceMutePayload { channel_id: "voice-ch".to_string(), muted: true }).await;
}

#[tokio::test]
async fn voice_deafen_without_room_manager_does_not_panic() {
    let hub = test_hub();
    super::handlers::handle_voice_deafen(&hub, "u1", VoiceDeafenPayload { channel_id: "voice-ch".to_string(), deafened: true }).await;
}

#[tokio::test]
async fn voice_screen_start_without_room_manager_does_not_panic() {
    let hub = test_hub();
    super::handlers::handle_voice_screen_start(&hub, "u1", VoiceScreenPayload { channel_id: "voice-ch".to_string() }).await;
}

#[tokio::test]
async fn voice_leave_without_sfu_and_room_manager() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_leave(&hub, "c1", "u1", VoiceJoinPayload { channel_id: "voice-ch".to_string() }).await;
}

#[tokio::test]
async fn dm_typing_delivers_to_other_member() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    let payload = serde_json::json!({"dm_channel_id": "dm1"});
    let p: DMTypingPayload = serde_json::from_value(payload).unwrap();

    let typing_evt = Event::new(
        EVENT_TYPING_INDICATOR,
        TypingPayload { channel_id: p.dm_channel_id.clone(), user_id: "u1".to_string(), username: "alice".to_string() },
    ).unwrap();
    let data = typing_evt.to_bytes().unwrap();

    let db = hub.db.clone();
    let dm_id = p.dm_channel_id.clone();
    let members = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_dm_members(conn, &dm_id))
    }).await.unwrap().unwrap();

    for member in &members {
        if member.user_id != "u1" {
            hub.send_to_user(&member.user_id, data.clone()).await;
        }
    }
    settle().await;

    let evt = recv_event(&mut rx2).await;
    assert_eq!(evt.event_type, EVENT_TYPING_INDICATOR);

    assert_no_recv(&mut rx1, "sender should not get own typing indicator").await;
}

#[test]
fn message_send_payload_preserves_explicit_type() {
    let json = r#"{"channel_id":"ch1","content":"an image","type":"image"}"#;
    let p: MessageSendPayload = serde_json::from_str(json).unwrap();
    assert_eq!(p.msg_type, "image");
    assert_eq!(p.content, "an image");
}

#[tokio::test]
async fn dm_message_send_defaults_to_text_type() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let p = DMMessageSendPayload { dm_channel_id: "dm1".to_string(), content: "hello".to_string(), msg_type: String::new() };
    super::handlers::handle_dm_message_send(&hub, "u1", "alice", p).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.payload["type"], "text");
}

// =========================================================================
// Hub event emission tests for message handlers
// =========================================================================

#[tokio::test]
async fn message_send_emits_message_sent_hub_event() {
    let hub = test_hub();
    let mut event_rx = hub.event_tx().subscribe();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    super::handlers::handle_message_send(&hub, "c1", "u1", "alice", "t1", serde_json::json!({"channel_id": "ch1", "content": "test event"})).await;
    settle().await;

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::MessageSent { .. }), "MessageSent").await;
    match evt {
        super::hub::HubEvent::MessageSent { message, team_id } => {
            assert_eq!(message.content, "test event");
            assert_eq!(team_id, "t1");
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn message_edit_emits_message_edited_hub_event() {
    let hub = test_hub();
    let mut event_rx = hub.event_tx().subscribe();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "original");

    super::handlers::handle_message_edit(&hub, "u1", serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "content": "edited"})).await;
    settle().await;

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::MessageEdited { .. }), "MessageEdited").await;
    match evt {
        super::hub::HubEvent::MessageEdited { content, .. } => assert_eq!(content, "edited"),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn message_delete_emits_message_deleted_hub_event() {
    let hub = test_hub();
    let mut event_rx = hub.event_tx().subscribe();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "to delete");

    super::handlers::handle_message_delete(&hub, "u1", serde_json::json!({"message_id": msg_id, "channel_id": "ch1"})).await;
    settle().await;

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::MessageDeleted { .. }), "MessageDeleted").await;
    match evt {
        super::hub::HubEvent::MessageDeleted { message_id, .. } => assert_eq!(message_id, msg_id),
        _ => unreachable!(),
    }
}

// =========================================================================
// Voice join/leave hub event tests
// =========================================================================

#[tokio::test]
async fn voice_join_emits_voice_joined_hub_event() {
    let hub = test_hub_with_voice_and_sfu();
    let mut event_rx = hub.event_tx().subscribe();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "voice-ch");

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_join(&hub, "c1", "u1", "alice", "t1", VoiceJoinPayload { channel_id: "voice-ch".to_string() }).await;
    settle().await;

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::VoiceJoined { .. }), "VoiceJoined").await;
    match evt {
        super::hub::HubEvent::VoiceJoined { channel_id, user_id, team_id } => {
            assert_eq!(channel_id, "voice-ch");
            assert_eq!(user_id, "u1");
            assert_eq!(team_id, "t1");
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn voice_leave_emits_voice_left_hub_event() {
    let hub = test_hub_with_voice_and_sfu();
    let mut event_rx = hub.event_tx().subscribe();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::handlers::handle_voice_leave(&hub, "c1", "u1", VoiceJoinPayload { channel_id: "voice-ch".to_string() }).await;
    settle().await;

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::VoiceLeft { .. }), "VoiceLeft").await;
    match evt {
        super::hub::HubEvent::VoiceLeft { channel_id, user_id } => {
            assert_eq!(channel_id, "voice-ch");
            assert_eq!(user_id, "u1");
        }
        _ => unreachable!(),
    }
}

// =========================================================================
// client.rs: direct dispatch function tests
// =========================================================================

#[tokio::test]
async fn dispatch_handle_event_message_send() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let event = Event { event_type: EVENT_MESSAGE_SEND.to_string(), payload: serde_json::json!({"channel_id": "ch1", "content": "dispatched"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, EVENT_MESSAGE_NEW);
    assert_eq!(evt.payload["content"], "dispatched");
}

#[tokio::test]
async fn dispatch_handle_event_message_edit() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "original");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let event = Event { event_type: EVENT_MESSAGE_EDIT.to_string(), payload: serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "content": "via dispatch"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_MESSAGE_UPDATED);
}

#[tokio::test]
async fn dispatch_handle_event_message_delete() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "to delete");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let event = Event { event_type: EVENT_MESSAGE_DELETE.to_string(), payload: serde_json::json!({"message_id": msg_id, "channel_id": "ch1"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_MESSAGE_DELETED);
}

#[tokio::test]
async fn dispatch_handle_event_channel_join() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let event = Event { event_type: EVENT_CHANNEL_JOIN.to_string(), payload: serde_json::json!({"channel_id": "dispatched-chan"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    hub.broadcast_to_channel("dispatched-chan", b"check".to_vec(), None).await;
    settle().await;

    let msg = timeout(Duration::from_millis(100), rx1.recv()).await.unwrap().unwrap();
    assert_eq!(msg, b"check");
}

#[tokio::test]
async fn dispatch_handle_event_channel_leave() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;
    subscribe(&hub, "c1", "leave-chan").await;

    let event = Event { event_type: EVENT_CHANNEL_LEAVE.to_string(), payload: serde_json::json!({"channel_id": "leave-chan"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    hub.broadcast_to_channel("leave-chan", b"should-not-recv".to_vec(), None).await;
    settle().await;

    assert_no_recv(&mut rx1, "should not receive after channel:leave dispatch").await;
}

#[tokio::test]
async fn dispatch_handle_event_typing_start() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "ch1").await;
    subscribe(&hub, "c2", "ch1").await;

    let event = Event { event_type: EVENT_TYPING_START.to_string(), payload: serde_json::json!({"channel_id": "ch1"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx2).await.event_type, EVENT_TYPING_INDICATOR);
}

#[tokio::test]
async fn dispatch_handle_event_presence_update() {
    let hub = test_hub();
    let mut event_rx = hub.event_tx().subscribe();

    let event = Event {
        event_type: EVENT_PRESENCE_UPDATE.to_string(),
        payload: serde_json::json!({"user_id": "u1", "status_type": "idle", "status_text": "brb"}),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::PresenceUpdate { .. }), "PresenceUpdate").await;
    match evt {
        super::hub::HubEvent::PresenceUpdate { user_id, status, custom_status } => {
            assert_eq!(user_id, "u1");
            assert_eq!(status, "idle");
            assert_eq!(custom_status, "brb");
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn dispatch_handle_event_ping() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let event = Event { event_type: EVENT_PING.to_string(), payload: serde_json::json!({}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, "pong");
}

#[tokio::test]
async fn dispatch_handle_event_request() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let event = Event {
        event_type: EVENT_REQUEST.to_string(),
        payload: serde_json::json!({"id": "req-dispatch", "action": ACTION_SYNC_INIT, "payload": {}}),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    let evt = recv_event(&mut rx1).await;
    assert_eq!(evt.event_type, "response");
    assert_eq!(evt.payload["ok"], true);
}

#[tokio::test]
async fn dispatch_handle_event_unknown_type_does_not_panic() {
    let hub = test_hub();
    let event = Event { event_type: "totally:unknown:event".to_string(), payload: serde_json::json!({}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
}

#[tokio::test]
async fn dispatch_handle_event_request_with_invalid_payload_does_not_panic() {
    let hub = test_hub();
    let event = Event { event_type: EVENT_REQUEST.to_string(), payload: serde_json::json!("not an object") };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
}

// ── handle_channel_event direct tests ────────────────────────────────────

#[tokio::test]
async fn handle_channel_event_join_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_channel_event(&hub, "c1", EVENT_CHANNEL_JOIN, serde_json::json!({"channel_id": "direct-chan"})).await;
    settle().await;

    hub.broadcast_to_channel("direct-chan", b"hello".to_vec(), None).await;
    settle().await;

    let msg = timeout(Duration::from_millis(100), rx1.recv()).await.unwrap().unwrap();
    assert_eq!(msg, b"hello");
}

#[tokio::test]
async fn handle_channel_event_leave_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;
    subscribe(&hub, "c1", "direct-chan").await;

    super::client::handle_channel_event(&hub, "c1", EVENT_CHANNEL_LEAVE, serde_json::json!({"channel_id": "direct-chan"})).await;
    settle().await;

    hub.broadcast_to_channel("direct-chan", b"should-not-recv".to_vec(), None).await;
    settle().await;

    assert_no_recv(&mut rx1, "should not receive after leave").await;
}

#[tokio::test]
async fn handle_channel_event_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_channel_event(&hub, "c1", EVENT_CHANNEL_JOIN, serde_json::json!("not an object")).await;
}

// ── handle_presence_update direct test ───────────────────────────────────

#[tokio::test]
async fn handle_presence_update_directly() {
    let hub = test_hub();
    let mut event_rx = hub.event_tx().subscribe();

    super::client::handle_presence_update(&hub, "u1", serde_json::json!({"user_id": "u1", "status_type": "online", "status_text": ""}));

    let evt = find_hub_event(&mut event_rx, |e| matches!(e, super::hub::HubEvent::PresenceUpdate { .. }), "PresenceUpdate").await;
    match evt {
        super::hub::HubEvent::PresenceUpdate { user_id, .. } => assert_eq!(user_id, "u1"),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn handle_presence_update_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_presence_update(&hub, "u1", serde_json::json!(42));
}

// ── handle_ping direct test ──────────────────────────────────────────────

#[tokio::test]
async fn handle_ping_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_ping(&hub, "u1").await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, "pong");
}

// ── handle_reaction_event direct tests ───────────────────────────────────

#[tokio::test]
async fn handle_reaction_event_add_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "react");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    super::client::handle_reaction_event(&hub, "u1", "t1", EVENT_REACTION_ADD, serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "emoji": "heart"})).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_REACTION_ADDED);
}

#[tokio::test]
async fn handle_reaction_event_remove_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "react");
    hub.db.with_conn(|conn| db::add_reaction(conn, &msg_id, "u1", "heart")).unwrap();

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    super::client::handle_reaction_event(&hub, "u1", "t1", EVENT_REACTION_REMOVE, serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "emoji": "heart"})).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_REACTION_REMOVED);
}

#[tokio::test]
async fn handle_reaction_event_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_reaction_event(&hub, "u1", "t1", EVENT_REACTION_ADD, serde_json::json!("invalid")).await;
}

// ── handle_thread_event direct tests ─────────────────────────────────────

#[tokio::test]
async fn handle_thread_event_send_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (_parent_msg_id, thread_id) = seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    super::client::handle_thread_event(&hub, "u1", "t1", EVENT_THREAD_MESSAGE_SEND, serde_json::json!({"thread_id": thread_id, "content": "via dispatch"})).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_THREAD_MESSAGE_NEW);
}

#[tokio::test]
async fn handle_thread_event_unknown_type_does_not_panic() {
    let hub = test_hub();
    super::client::handle_thread_event(&hub, "u1", "t1", "thread:unknown:action", serde_json::json!({"thread_id": "t1", "content": "test"})).await;
}

#[tokio::test]
async fn handle_thread_event_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_thread_event(&hub, "u1", "t1", EVENT_THREAD_MESSAGE_SEND, serde_json::json!(42)).await;
}

// ── handle_voice_event direct tests ──────────────────────────────────────

#[tokio::test]
async fn handle_voice_event_join_directly() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "voice-dispatch");

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_JOIN, serde_json::json!({"channel_id": "voice-dispatch"})).await;
    settle().await;

    assert!(hub.voice_room_manager.as_ref().unwrap().get_room("voice-dispatch").await.is_some());
}

#[tokio::test]
async fn handle_voice_event_leave_directly() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-dispatch", "u1", "alice", "t1").await;

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_LEAVE, serde_json::json!({"channel_id": "voice-dispatch"})).await;
    settle().await;

    assert!(rm.get_room("voice-dispatch").await.is_none());
}

#[tokio::test]
async fn handle_voice_event_mute_directly() {
    let hub = test_hub_with_voice();
    let _h = spawn_hub(&hub);

    hub.voice_room_manager.as_ref().unwrap().add_peer("voice-ch", "u1", "alice", "t1").await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_MUTE, serde_json::json!({"channel_id": "voice-ch", "muted": true})).await;
    settle().await;

    assert!(hub.voice_room_manager.as_ref().unwrap().get_room("voice-ch").await.unwrap()[0].muted);
}

#[tokio::test]
async fn handle_voice_event_deafen_directly() {
    let hub = test_hub_with_voice();
    let _h = spawn_hub(&hub);

    hub.voice_room_manager.as_ref().unwrap().add_peer("voice-ch", "u1", "alice", "t1").await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_DEAFEN, serde_json::json!({"channel_id": "voice-ch", "deafened": true})).await;
    settle().await;

    assert!(hub.voice_room_manager.as_ref().unwrap().get_room("voice-ch").await.unwrap()[0].deafened);
}

#[tokio::test]
async fn handle_voice_event_answer_directly() {
    let hub = test_hub();
    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_ANSWER, serde_json::json!({"channel_id": "voice-ch", "sdp": "mock"})).await;
}

#[tokio::test]
async fn handle_voice_event_ice_candidate_directly() {
    let hub = test_hub();
    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_ICE_CANDIDATE, serde_json::json!({
        "channel_id": "voice-ch", "candidate": "candidate:...", "sdp_mid": "0", "sdp_mline_index": 0,
    })).await;
}

#[tokio::test]
async fn handle_voice_event_screen_start_directly() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    hub.voice_room_manager.as_ref().unwrap().add_peer("voice-ch", "u1", "alice", "t1").await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_SCREEN_START, serde_json::json!({"channel_id": "voice-ch"})).await;
    settle().await;

    assert!(hub.voice_room_manager.as_ref().unwrap().get_room("voice-ch").await.unwrap()[0].screen_sharing);
}

#[tokio::test]
async fn handle_voice_event_screen_stop_directly() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;
    rm.set_screen_sharing("voice-ch", "u1", true).await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_SCREEN_STOP, serde_json::json!({"channel_id": "voice-ch"})).await;
    settle().await;

    assert!(!rm.get_room("voice-ch").await.unwrap()[0].screen_sharing);
}

#[tokio::test]
async fn handle_voice_event_webcam_start_directly() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    hub.voice_room_manager.as_ref().unwrap().add_peer("voice-ch", "u1", "alice", "t1").await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_WEBCAM_START, serde_json::json!({"channel_id": "voice-ch"})).await;
    settle().await;

    assert!(hub.voice_room_manager.as_ref().unwrap().get_room("voice-ch").await.unwrap()[0].webcam_sharing);
}

#[tokio::test]
async fn handle_voice_event_webcam_stop_directly() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);

    let rm = hub.voice_room_manager.as_ref().unwrap();
    rm.add_peer("voice-ch", "u1", "alice", "t1").await;
    rm.set_webcam_sharing("voice-ch", "u1", true).await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_WEBCAM_STOP, serde_json::json!({"channel_id": "voice-ch"})).await;
    settle().await;

    assert!(!rm.get_room("voice-ch").await.unwrap()[0].webcam_sharing);
}

#[tokio::test]
async fn handle_voice_event_key_distribute_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "voice-ch").await;
    subscribe(&hub, "c2", "voice-ch").await;

    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_KEY_DISTRIBUTE, serde_json::json!({
        "channel_id": "voice-ch", "sender_id": "", "key_id": 42, "encrypted_keys": {"u2": "key-data"},
    })).await;
    settle().await;

    let evt = recv_event(&mut rx2).await;
    assert_eq!(evt.event_type, EVENT_VOICE_KEY_DISTRIBUTE);
    assert_eq!(evt.payload["sender_id"], "u1");
    assert_eq!(evt.payload["key_id"], 42);

    assert_no_recv(&mut rx1, "sender should not receive key distribute").await;
}

#[tokio::test]
async fn handle_voice_event_unknown_type_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_event(&hub, "c1", "u1", "alice", "t1", "voice:unknown", serde_json::json!({"channel_id": "voice-ch"})).await;
}

// ── handle_dm_message_event direct tests ─────────────────────────────────

#[tokio::test]
async fn handle_dm_message_event_send_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_dm_message_event(&hub, "u1", "alice", EVENT_DM_MESSAGE_SEND, serde_json::json!({"dm_channel_id": "dm1", "content": "via dispatch"})).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_DM_MESSAGE_NEW);
}

#[tokio::test]
async fn handle_dm_message_event_edit_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let msg_id = insert_dm_msg(&hub.db, "dm1", "u1", "orig dm");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_dm_message_event(&hub, "u1", "alice", EVENT_DM_MESSAGE_EDIT, serde_json::json!({
        "dm_channel_id": "dm1", "message_id": msg_id, "content": "edited via dispatch",
    })).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_DM_MESSAGE_UPDATED);
}

#[tokio::test]
async fn handle_dm_message_event_delete_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let msg_id = insert_dm_msg(&hub.db, "dm1", "u1", "delete me");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    super::client::handle_dm_message_event(&hub, "u1", "alice", EVENT_DM_MESSAGE_DELETE, serde_json::json!({
        "dm_channel_id": "dm1", "message_id": msg_id,
    })).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_DM_MESSAGE_DELETED);
}

#[tokio::test]
async fn handle_dm_message_event_unknown_type_does_not_panic() {
    let hub = test_hub();
    super::client::handle_dm_message_event(&hub, "u1", "alice", "dm:unknown", serde_json::json!({"dm_channel_id": "dm1", "content": "test"})).await;
}

#[tokio::test]
async fn handle_dm_message_event_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_dm_message_event(&hub, "u1", "alice", EVENT_DM_MESSAGE_SEND, serde_json::json!("invalid")).await;
}

// ── handle_dm_typing direct test ─────────────────────────────────────────

#[tokio::test]
async fn handle_dm_typing_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    super::client::handle_dm_typing(&hub, "u1", "alice", serde_json::json!({"dm_channel_id": "dm1"})).await;
    settle().await;

    assert_eq!(recv_event(&mut rx2).await.event_type, EVENT_TYPING_INDICATOR);
    assert_no_recv(&mut rx1, "sender should not get own dm typing").await;
}

#[tokio::test]
async fn handle_dm_typing_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_dm_typing(&hub, "u1", "alice", serde_json::json!("not valid")).await;
}

// ── handle_voice_key_distribute direct test ──────────────────────────────

#[tokio::test]
async fn handle_voice_key_distribute_directly() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;
    subscribe(&hub, "c1", "voice-ch").await;
    subscribe(&hub, "c2", "voice-ch").await;

    super::client::handle_voice_key_distribute(&hub, "c1", "u1", serde_json::json!({
        "channel_id": "voice-ch", "sender_id": "", "key_id": 7, "encrypted_keys": {"u2": "enc-key"},
    })).await;
    settle().await;

    let evt = recv_event(&mut rx2).await;
    assert_eq!(evt.event_type, EVENT_VOICE_KEY_DISTRIBUTE);
    assert_eq!(evt.payload["sender_id"], "u1");
    assert_eq!(evt.payload["key_id"], 7);

    assert_no_recv(&mut rx1, "sender should not receive key distribute").await;
}

#[tokio::test]
async fn handle_voice_key_distribute_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_key_distribute(&hub, "c1", "u1", serde_json::json!("invalid")).await;
}

// ── Full handle_event dispatch for DM events ─────────────────────────────

#[tokio::test]
async fn dispatch_handle_event_dm_message_send() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let event = Event { event_type: EVENT_DM_MESSAGE_SEND.to_string(), payload: serde_json::json!({"dm_channel_id": "dm1", "content": "full dispatch dm"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_DM_MESSAGE_NEW);
}

#[tokio::test]
async fn dispatch_handle_event_dm_typing_start() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_dm_fixture(&hub.db);

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    let (c2, mut rx2) = make_client("c2", "u2", "bob", "t1");
    register(&hub, c1).await;
    register(&hub, c2).await;

    let event = Event { event_type: EVENT_DM_TYPING_START.to_string(), payload: serde_json::json!({"dm_channel_id": "dm1"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx2).await.event_type, EVENT_TYPING_INDICATOR);
}

#[tokio::test]
async fn dispatch_handle_event_reaction_add() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let msg_id = insert_channel_msg(&hub.db, "ch1", "u1", "react me");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let event = Event { event_type: EVENT_REACTION_ADD.to_string(), payload: serde_json::json!({"message_id": msg_id, "channel_id": "ch1", "emoji": "fire"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_REACTION_ADDED);
}

#[tokio::test]
async fn dispatch_handle_event_thread_message_send() {
    let hub = test_hub();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "ch1");

    let (_parent_msg_id, thread_id) = seed_parent_and_thread(&hub.db, "ch1", "t1", "u1");

    let (c1, mut rx1) = make_client("c1", "u1", "alice", "t1");
    register_and_subscribe(&hub, c1, "ch1").await;

    let event = Event { event_type: EVENT_THREAD_MESSAGE_SEND.to_string(), payload: serde_json::json!({"thread_id": thread_id, "content": "dispatch thread"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert_eq!(recv_event(&mut rx1).await.event_type, EVENT_THREAD_MESSAGE_NEW);
}

#[tokio::test]
async fn dispatch_handle_event_voice_join() {
    let hub = test_hub_with_voice_and_sfu();
    let _h = spawn_hub(&hub);
    seed_team_channel(&hub.db, "t1", "u1", "dispatch-voice");

    let (c1, _rx1) = make_client("c1", "u1", "alice", "t1");
    register(&hub, c1).await;

    let event = Event { event_type: EVENT_VOICE_JOIN.to_string(), payload: serde_json::json!({"channel_id": "dispatch-voice"}) };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;

    assert!(hub.voice_room_manager.as_ref().unwrap().get_room("dispatch-voice").await.is_some());
}

// ── handle_voice_signaling direct tests ──────────────────────────────────

#[tokio::test]
async fn handle_voice_signaling_answer_directly() {
    let hub = test_hub_with_voice_and_sfu();
    super::client::handle_voice_signaling(&hub, "u1", EVENT_VOICE_ANSWER, serde_json::json!({"channel_id": "voice-ch", "sdp": "mock"})).await;
}

#[tokio::test]
async fn handle_voice_signaling_ice_candidate_directly() {
    let hub = test_hub_with_voice_and_sfu();
    super::client::handle_voice_signaling(&hub, "u1", EVENT_VOICE_ICE_CANDIDATE, serde_json::json!({
        "channel_id": "voice-ch", "candidate": "candidate:...", "sdp_mid": "0", "sdp_mline_index": 0,
    })).await;
}

#[tokio::test]
async fn handle_voice_signaling_unknown_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_signaling(&hub, "u1", "voice:unknown-signaling", serde_json::json!({"channel_id": "voice-ch"})).await;
}

// ── handle_voice_media direct tests ──────────────────────────────────────

#[tokio::test]
async fn handle_voice_media_unknown_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_media(&hub, "u1", "voice:unknown-media", serde_json::json!({"channel_id": "voice-ch"})).await;
}

#[tokio::test]
async fn handle_voice_media_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_media(&hub, "u1", EVENT_VOICE_SCREEN_START, serde_json::json!(42)).await;
}

// ── handle_voice_join_leave direct tests ─────────────────────────────────

#[tokio::test]
async fn handle_voice_join_leave_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_join_leave(&hub, "c1", "u1", "alice", "t1", EVENT_VOICE_JOIN, serde_json::json!("invalid")).await;
}

// ── handle_voice_signaling invalid payload ───────────────────────────────

#[tokio::test]
async fn handle_voice_signaling_invalid_payload_does_not_panic() {
    let hub = test_hub();
    super::client::handle_voice_signaling(&hub, "u1", EVENT_VOICE_ANSWER, serde_json::json!("invalid")).await;
}

// ── Telemetry dispatch tests ─────────────────────────────────────────────

fn test_hub_with_telemetry() -> Arc<Hub> {
    let mut hub = Hub::new(test_db());
    hub.telemetry_relay = Some(Arc::new(crate::telemetry::TelemetryRelay::new(
        None,
        "test-node".into(),
        "0.0.0-test".into(),
        "test".into(),
    )));
    Arc::new(hub)
}

#[tokio::test]
async fn dispatch_telemetry_error_forwards_to_relay() {
    let hub = test_hub_with_telemetry();
    let event = Event {
        event_type: EVENT_TELEMETRY_ERROR.to_string(),
        payload: serde_json::json!({
            "level": "error",
            "message": "test crash",
            "stack": "",
            "url": "",
            "user_agent": "",
            "viewport": "",
            "breadcrumbs": [],
            "extra": {}
        }),
    };
    // Should not panic; relay is present but has no adapter so it drops silently.
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;
}

#[tokio::test]
async fn dispatch_telemetry_breadcrumb_forwards_to_relay() {
    let hub = test_hub_with_telemetry();
    let event = Event {
        event_type: EVENT_TELEMETRY_BREADCRUMB.to_string(),
        payload: serde_json::json!({
            "type": "navigation",
            "message": "/channels → /settings",
            "timestamp": 1234567890
        }),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
    settle().await;
}

#[tokio::test]
async fn dispatch_telemetry_error_without_relay_does_not_panic() {
    let hub = test_hub(); // no telemetry_relay
    let event = Event {
        event_type: EVENT_TELEMETRY_ERROR.to_string(),
        payload: serde_json::json!({"level": "error", "message": "oops"}),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
}

#[tokio::test]
async fn dispatch_telemetry_breadcrumb_without_relay_does_not_panic() {
    let hub = test_hub(); // no telemetry_relay
    let event = Event {
        event_type: EVENT_TELEMETRY_BREADCRUMB.to_string(),
        payload: serde_json::json!({"type": "click", "message": "button"}),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
}

#[tokio::test]
async fn dispatch_telemetry_error_invalid_payload_does_not_panic() {
    let hub = test_hub_with_telemetry();
    let event = Event {
        event_type: EVENT_TELEMETRY_ERROR.to_string(),
        payload: serde_json::json!("invalid"),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
}

#[tokio::test]
async fn dispatch_telemetry_breadcrumb_invalid_payload_does_not_panic() {
    let hub = test_hub_with_telemetry();
    let event = Event {
        event_type: EVENT_TELEMETRY_BREADCRUMB.to_string(),
        payload: serde_json::json!(42),
    };
    super::client::handle_event(&hub, "c1", "u1", "alice", "t1", event).await;
}
