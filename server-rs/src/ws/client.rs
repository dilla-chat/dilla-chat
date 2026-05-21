use super::events::*;
use super::hub::Hub;
use crate::db;
use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

use super::handlers::*;

const PONG_WAIT: Duration = Duration::from_secs(60);
const PING_PERIOD: Duration = Duration::from_secs(54);
const MAX_MESSAGE_SIZE: usize = 16 * 1024; // 16KB

pub async fn handle_ws_connection(
    socket: WebSocket,
    hub: Arc<Hub>,
    user_id: String,
    username: String,
    team_id: String,
) {
    let client_id = db::new_id();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();

    let client = super::hub::ClientHandle {
        id: client_id.clone(),
        user_id: user_id.clone(),
        username: username.clone(),
        team_id: team_id.clone(),
        sender: tx,
    };

    hub.register(client).await;

    // Push a voice:rooms-snapshot to the freshly-registered client so
    // they see who is already in voice on their team — without this,
    // a new login / reload only learns voice state from incremental
    // voice:user-joined / voice:user-left deltas going forward and
    // misses everyone who joined before they connected.
    if let Some(room_mgr) = &hub.voice_room_manager {
        let rooms = room_mgr.get_rooms_by_team(&team_id).await;
        let mut by_channel = serde_json::Map::new();
        for r in rooms {
            if let Ok(peers) = serde_json::to_value(&r.peers) {
                by_channel.insert(r.channel_id.clone(), peers);
            }
        }
        let payload = serde_json::json!({
            "team_id": team_id,
            "rooms": serde_json::Value::Object(by_channel),
        });
        if let Ok(evt) = crate::ws::events::Event::new(
            crate::ws::events::EVENT_VOICE_ROOMS_SNAPSHOT,
            payload,
        ) {
            if let Ok(bytes) = evt.to_bytes() {
                hub.send_to_user(&user_id, bytes).await;
            }
        }
    }

    let (mut ws_sender, mut ws_receiver) = socket.split();

    // Write pump: drain mpsc receiver and send to WebSocket.
    let write_task = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(PING_PERIOD);

        loop {
            tokio::select! {
                Some(data) = rx.recv() => {
                    if ws_sender.send(Message::Text(String::from_utf8_lossy(&data).to_string().into())).await.is_err() {
                        break;
                    }
                }
                _ = ping_interval.tick() => {
                    if ws_sender.send(Message::Ping(vec![].into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Read pump: read from WebSocket, dispatch events.
    let hub_read = hub.clone();
    let cid_read = client_id.clone();
    let uid = user_id.clone();
    let uname = username.clone();
    let tid = team_id.clone();

    let read_task = tokio::spawn(async move {
        let mut last_pong = Instant::now();

        while let Some(msg) = ws_receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if text.len() > MAX_MESSAGE_SIZE {
                        continue;
                    }

                    // Notify activity.
                    hub_read.emit_event(super::hub::HubEvent::ClientActivity { user_id: uid.clone() });

                    if let Ok(event) = serde_json::from_str::<Event>(&text) {
                        handle_event(&hub_read, &cid_read, &uid, &uname, &tid, event).await;
                    }
                }
                Ok(Message::Pong(_)) => {
                    last_pong = Instant::now();
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }

            if last_pong.elapsed() > PONG_WAIT {
                break;
            }
        }
    });

    // Wait for either pump to finish.
    tokio::select! {
        _ = write_task => {}
        _ = read_task => {}
    }

    hub.unregister(&client_id).await;
}

pub(crate) async fn handle_event(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    event: Event,
) {
    match event.event_type.as_str() {
        EVENT_CHANNEL_JOIN | EVENT_CHANNEL_LEAVE => {
            handle_channel_event(hub, client_id, user_id, team_id, &event.event_type, event.payload).await;
        }
        EVENT_MESSAGE_SEND => {
            handle_message_send(hub, client_id, user_id, username, team_id, event.payload).await;
        }
        EVENT_MESSAGE_EDIT => {
            handle_message_edit(hub, user_id, event.payload).await;
        }
        EVENT_MESSAGE_DELETE => {
            handle_message_delete(hub, user_id, event.payload).await;
        }
        EVENT_TYPING_START | EVENT_TYPING_STOP => {
            handle_typing(hub, client_id, user_id, username, team_id, event.payload).await;
        }
        EVENT_PRESENCE_UPDATE => {
            handle_presence_update(hub, user_id, event.payload);
        }
        EVENT_PING => {
            handle_ping(hub, user_id).await;
        }
        EVENT_REQUEST => {
            if let Ok(req) = serde_json::from_value::<RequestEvent>(event.payload) {
                handle_request(hub, user_id, team_id, req).await;
            }
        }
        EVENT_REACTION_ADD | EVENT_REACTION_REMOVE => {
            handle_reaction_event(hub, user_id, team_id, &event.event_type, event.payload).await;
        }
        EVENT_THREAD_MESSAGE_SEND | EVENT_THREAD_MESSAGE_EDIT | EVENT_THREAD_MESSAGE_REMOVE => {
            handle_thread_event(hub, user_id, team_id, &event.event_type, event.payload).await;
        }
        EVENT_CHANNEL_KEY_DISTRIBUTE => {
            handle_channel_key_distribute(hub, client_id, user_id, event.payload).await;
        }
        EVENT_VOICE_JOIN | EVENT_VOICE_LEAVE | EVENT_VOICE_ANSWER
        | EVENT_VOICE_ICE_CANDIDATE | EVENT_VOICE_MUTE | EVENT_VOICE_DEAFEN
        | EVENT_VOICE_FORCE_MUTE | EVENT_VOICE_FORCE_DISCONNECT
        | EVENT_VOICE_LATENCY
        | EVENT_VOICE_SCREEN_START | EVENT_VOICE_SCREEN_STOP
        | EVENT_VOICE_WEBCAM_START | EVENT_VOICE_WEBCAM_STOP
        | EVENT_VOICE_KEY_DISTRIBUTE | EVENT_VOICE_INVITE => {
            handle_voice_event(hub, client_id, user_id, username, team_id, &event.event_type, event.payload).await;
        }
        ACTION_CHANNEL_READ => {
            handle_channel_mark_read(hub, user_id, team_id, event.payload).await;
        }
        EVENT_DM_MESSAGE_SEND | EVENT_DM_MESSAGE_EDIT | EVENT_DM_MESSAGE_DELETE => {
            handle_dm_message_event(hub, user_id, username, &event.event_type, event.payload).await;
        }
        EVENT_DM_TYPING_START | EVENT_DM_TYPING_STOP => {
            handle_dm_typing(hub, user_id, username, event.payload).await;
        }
        EVENT_TELEMETRY_ERROR => {
            if let Some(ref relay) = hub.telemetry_relay {
                if let Ok(tel_event) = serde_json::from_value::<crate::telemetry::adapter::TelemetryEvent>(event.payload) {
                    let relay = relay.clone();
                    let uid = user_id.to_string();
                    tokio::spawn(async move {
                        relay.forward_error(&uid, tel_event).await;
                    });
                }
            }
        }
        EVENT_TELEMETRY_BREADCRUMB => {
            if let Some(ref relay) = hub.telemetry_relay {
                if let Ok(breadcrumb) = serde_json::from_value::<crate::telemetry::adapter::Breadcrumb>(event.payload) {
                    let relay = relay.clone();
                    let uid = user_id.to_string();
                    tokio::spawn(async move {
                        relay.forward_breadcrumb(&uid, breadcrumb).await;
                    });
                }
            }
        }
        _ => {
            tracing::debug!(event_type = event.event_type, "unhandled event type");
        }
    }
}

pub(crate) async fn handle_channel_event(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    team_id: &str,
    event_type: &str,
    payload: serde_json::Value,
) {
    let p = match serde_json::from_value::<ChannelJoinPayload>(payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, event = event_type, "failed to parse payload");
            return;
        }
    };

    // Unsubscribe is always permitted — it only removes the caller from
    // an existing subscription. The expensive part is the access check
    // on subscribe, where we have to confirm the channel actually
    // belongs to the user's team AND the caller can read it (text
    // channels + DM channels are mixed in the same subscriber map).
    if event_type != EVENT_CHANNEL_JOIN {
        hub.unsubscribe(client_id, &p.channel_id).await;
        return;
    }

    if !user_can_subscribe_to_channel(hub, user_id, team_id, &p.channel_id).await {
        tracing::debug!(
            user_id = user_id,
            channel_id = %p.channel_id,
            team_id = team_id,
            "channel:join denied — access check failed"
        );
        return;
    }

    hub.subscribe(client_id, &p.channel_id).await;
}

/// Authorize a WebSocket subscriber for a channel ID.
///
/// The hub uses a single namespaced subscriber map for text channels,
/// thread IDs, DM channels and a few federation IDs. We don't trust the
/// client to tell us the channel type — instead, look the ID up in
/// every table that might own it and apply the matching ACL:
///
/// 1. If a row exists in `channels` and `channel.team_id == team_id`,
///    fall through to `user_can_access_channel`.
/// 2. If a row exists in `dm_members` for this channel, require the
///    caller to be in the member list.
/// 3. Otherwise — unknown channel — deny.
pub(crate) async fn user_can_subscribe_to_channel(
    hub: &Hub,
    user_id: &str,
    team_id: &str,
    channel_id: &str,
) -> bool {
    let db = hub.db.clone();
    let cid = channel_id.to_string();
    let uid = user_id.to_string();
    let tid = team_id.to_string();
    let allowed = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| -> Result<bool, rusqlite::Error> {
            // (1) Text / voice channel path — must belong to caller's
            // team AND pass the role-gated access check.
            if let Some(channel) = db::get_channel_by_id(conn, &cid)? {
                if channel.team_id != tid {
                    return Ok(false);
                }
                return db::user_can_access_channel(conn, &uid, &tid, &cid);
            }
            // (2) DM channel path — caller must appear in dm_members.
            // is_dm_member returns false when the row set is empty.
            if db::is_dm_member(conn, &cid, &uid)? {
                return Ok(true);
            }
            Ok(false)
        })
    })
    .await;

    match allowed {
        Ok(Ok(true)) => true,
        Ok(Ok(false)) => false,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, channel_id = channel_id, "channel access check failed");
            false
        }
        Err(e) => {
            tracing::warn!(error = %e, "channel access check task join failed");
            false
        }
    }
}

pub(crate) fn handle_presence_update(hub: &Hub, user_id: &str, payload: serde_json::Value) {
    if let Ok(p) = serde_json::from_value::<PresenceUpdatePayload>(payload) {
        hub.emit_event(super::hub::HubEvent::PresenceUpdate {
            user_id: user_id.to_string(),
            status: p.status_type.clone(),
            custom_status: p.status_text.clone(),
        });
    }
}

pub(crate) async fn handle_ping(hub: &Hub, user_id: &str) {
    let pong = Event::new(EVENT_PONG, serde_json::json!({}));
    if let Ok(evt) = pong {
        if let Ok(data) = evt.to_bytes() {
            hub.send_to_user(user_id, data).await;
        }
    }
}

pub(crate) async fn handle_reaction_event(hub: &Hub, user_id: &str, team_id: &str, event_type: &str, payload: serde_json::Value) {
    if let Ok(p) = serde_json::from_value::<ReactionPayload>(payload) {
        if event_type == EVENT_REACTION_ADD {
            handle_reaction_add(hub, user_id, team_id, p).await;
        } else {
            handle_reaction_remove(hub, user_id, team_id, p).await;
        }
    }
}

pub(crate) async fn handle_thread_event(hub: &Hub, user_id: &str, team_id: &str, event_type: &str, payload: serde_json::Value) {
    match event_type {
        EVENT_THREAD_MESSAGE_SEND => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageSendPayload>(payload) {
                handle_thread_message_send(hub, user_id, team_id, p).await;
            }
        }
        EVENT_THREAD_MESSAGE_EDIT => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageEditPayload>(payload) {
                handle_thread_message_edit(hub, user_id, p).await;
            }
        }
        EVENT_THREAD_MESSAGE_REMOVE => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageRemovePayload>(payload) {
                handle_thread_message_remove(hub, user_id, p).await;
            }
        }
        _ => {}
    }
}

pub(crate) async fn handle_voice_event(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    event_type: &str,
    payload: serde_json::Value,
) {
    match event_type {
        EVENT_VOICE_JOIN | EVENT_VOICE_LEAVE => {
            handle_voice_join_leave(hub, client_id, user_id, username, team_id, event_type, payload).await;
        }
        EVENT_VOICE_ANSWER | EVENT_VOICE_ICE_CANDIDATE | EVENT_VOICE_MUTE | EVENT_VOICE_DEAFEN => {
            handle_voice_signaling(hub, user_id, event_type, payload).await;
        }
        EVENT_VOICE_FORCE_MUTE => {
            if let Ok(p) = serde_json::from_value::<VoiceForceMutePayload>(payload) {
                handle_voice_force_mute(hub, user_id, team_id, p).await;
            }
        }
        EVENT_VOICE_FORCE_DISCONNECT => {
            if let Ok(p) = serde_json::from_value::<VoiceForceDisconnectPayload>(payload) {
                handle_voice_force_disconnect(hub, user_id, team_id, p).await;
            }
        }
        EVENT_VOICE_LATENCY => {
            if let Ok(p) = serde_json::from_value::<VoiceLatencyPayload>(payload) {
                handle_voice_latency(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_SCREEN_START | EVENT_VOICE_SCREEN_STOP |
        EVENT_VOICE_WEBCAM_START | EVENT_VOICE_WEBCAM_STOP => {
            handle_voice_media(hub, user_id, event_type, payload).await;
        }
        EVENT_VOICE_KEY_DISTRIBUTE => {
            handle_voice_key_distribute(hub, client_id, user_id, payload).await;
        }
        EVENT_VOICE_INVITE => {
            if let Ok(p) = serde_json::from_value::<VoiceInvitePayload>(payload) {
                handle_voice_invite(hub, user_id, username, team_id, p).await;
            }
        }
        _ => {}
    }
}

pub(crate) async fn handle_voice_join_leave(
    hub: &Hub, client_id: &str, user_id: &str, username: &str, team_id: &str,
    event_type: &str, payload: serde_json::Value,
) {
    tracing::info!(
        "voice dispatch: {} from user={} client={} team={} payload={}",
        event_type,
        user_id,
        client_id,
        team_id,
        payload
    );
    match serde_json::from_value::<VoiceJoinPayload>(payload.clone()) {
        Ok(p) => {
            if event_type == EVENT_VOICE_JOIN {
                handle_voice_join(hub, client_id, user_id, username, team_id, p).await;
            } else {
                handle_voice_leave(hub, client_id, user_id, p).await;
            }
        }
        Err(e) => {
            tracing::warn!(
                "voice dispatch: failed to parse {} payload: {} (raw={})",
                event_type,
                e,
                payload
            );
        }
    }
}

pub(crate) async fn handle_voice_signaling(hub: &Hub, user_id: &str, event_type: &str, payload: serde_json::Value) {
    match event_type {
        EVENT_VOICE_ANSWER => { if let Ok(p) = serde_json::from_value(payload) { handle_voice_answer(hub, user_id, p).await; } }
        EVENT_VOICE_ICE_CANDIDATE => { if let Ok(p) = serde_json::from_value(payload) { handle_voice_ice_candidate(hub, user_id, p).await; } }
        EVENT_VOICE_MUTE => { if let Ok(p) = serde_json::from_value(payload) { handle_voice_mute(hub, user_id, p).await; } }
        EVENT_VOICE_DEAFEN => { if let Ok(p) = serde_json::from_value(payload) { handle_voice_deafen(hub, user_id, p).await; } }
        _ => {}
    }
}

pub(crate) async fn handle_voice_media(hub: &Hub, user_id: &str, event_type: &str, payload: serde_json::Value) {
    if let Ok(p) = serde_json::from_value::<VoiceScreenPayload>(payload) {
        match event_type {
            EVENT_VOICE_SCREEN_START => handle_voice_screen_start(hub, user_id, p).await,
            EVENT_VOICE_SCREEN_STOP => handle_voice_screen_stop(hub, user_id, p).await,
            EVENT_VOICE_WEBCAM_START => handle_voice_webcam_start(hub, user_id, p).await,
            EVENT_VOICE_WEBCAM_STOP => handle_voice_webcam_stop(hub, user_id, p).await,
            _ => {}
        }
    }
}

pub(crate) async fn handle_voice_key_distribute(hub: &Hub, client_id: &str, user_id: &str, payload: serde_json::Value) {
    match serde_json::from_value::<VoiceKeyDistributePayload>(payload.clone()) {
        Ok(mut p) => {
            p.sender_id = user_id.to_string();
            let recipients: Vec<&str> = p.encrypted_keys.keys().map(|s| s.as_str()).collect();
            tracing::info!(
                target: "dilla_server::voice",
                "voice:key-distribute from user={user_id} client={client_id} channel={} key_id={} recipients={:?}",
                p.channel_id, p.key_id, recipients,
            );
            let evt = Event::new(EVENT_VOICE_KEY_DISTRIBUTE, &p);
            if let Ok(evt) = evt {
                if let Ok(data) = evt.to_bytes() {
                    hub.broadcast_to_channel(&p.channel_id, data, Some(client_id.to_string()))
                        .await;
                }
            }
        }
        Err(err) => {
            tracing::warn!(
                target: "dilla_server::voice",
                "voice:key-distribute parse failed: {err} payload={}",
                payload,
            );
        }
    }
}

pub(crate) async fn handle_channel_key_distribute(hub: &Hub, _client_id: &str, user_id: &str, payload: serde_json::Value) {
    if let Ok(mut p) = serde_json::from_value::<ChannelKeyDistributePayload>(payload) {
        p.sender_id = user_id.to_string();
        let evt = Event::new(EVENT_CHANNEL_KEY_DISTRIBUTE, &p);
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                // Broadcast to all channel subscribers INCLUDING the sender
                // so they get confirmation their distribution was received
                hub.broadcast_to_channel(&p.channel_id, data, None).await;
            }
        }
    }
}

pub(crate) async fn handle_dm_message_event(hub: &Hub, user_id: &str, username: &str, event_type: &str, payload: serde_json::Value) {
    match event_type {
        EVENT_DM_MESSAGE_SEND => {
            match serde_json::from_value::<DMMessageSendPayload>(payload) {
                Ok(p) => handle_dm_message_send(hub, user_id, username, p).await,
                Err(e) => tracing::warn!(error = %e, event = "dm:message:send", "failed to parse payload"),
            }
        }
        EVENT_DM_MESSAGE_EDIT => {
            match serde_json::from_value::<DMMessageEditPayload>(payload) {
                Ok(p) => handle_dm_message_edit(hub, user_id, p).await,
                Err(e) => tracing::warn!(error = %e, event = "dm:message:edit", "failed to parse payload"),
            }
        }
        EVENT_DM_MESSAGE_DELETE => {
            match serde_json::from_value::<DMMessageDeletePayload>(payload) {
                Ok(p) => handle_dm_message_delete(hub, user_id, p).await,
                Err(e) => tracing::warn!(error = %e, event = "dm:message:delete", "failed to parse payload"),
            }
        }
        _ => {}
    }
}

pub(crate) async fn handle_dm_typing(hub: &Hub, user_id: &str, username: &str, payload: serde_json::Value) {
    let p = match serde_json::from_value::<DMTypingPayload>(payload) {
        Ok(p) => p,
        Err(_) => return,
    };

    let evt = match Event::new(
        EVENT_TYPING_INDICATOR,
        TypingPayload {
            channel_id: p.dm_channel_id.clone(),
            user_id: user_id.to_string(),
            username: username.to_string(),
        },
    ) {
        Ok(evt) => evt,
        Err(_) => return,
    };

    let data = match evt.to_bytes() {
        Ok(data) => data,
        Err(_) => return,
    };

    let db = hub.db.clone();
    let dm_id = p.dm_channel_id.clone();
    let uid = user_id.to_string();
    if let Ok(members) = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::get_dm_members(conn, &dm_id))
    })
    .await
    .unwrap()
    {
        for member in members {
            if member.user_id != uid {
                hub.send_to_user(&member.user_id, data.clone()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::ws::hub::Hub;

    fn test_hub() -> Hub {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        // Leak the tempdir so the DB stays around for the test.
        std::mem::forget(tmp);
        Hub::new(db)
    }

    fn now() -> String {
        db::now_str()
    }

    fn seed_team_with_default_role(
        db: &Database,
        team_id: &str,
        owner_id: &str,
    ) -> String {
        let role_id = db::new_id();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: owner_id.into(),
                username: format!("user-{}", owner_id),
                display_name: owner_id.into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now(),
                updated_at: now(),
                quiet_hours_enabled: false,
                quiet_hours_from: String::new(),
                quiet_hours_to: String::new(),
            })?;
            db::create_team(conn, &db::Team {
                id: team_id.into(),
                name: team_id.into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: owner_id.into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                federated: false,
                created_at: now(),
                updated_at: now(),
            })?;
            db::create_member(conn, &db::Member {
                id: db::new_id(),
                team_id: team_id.into(),
                user_id: owner_id.into(),
                nickname: String::new(),
                joined_at: now(),
                invited_by: String::new(),
                updated_at: String::new(),
            })?;
            conn.execute(
                "INSERT INTO roles (id, team_id, name, color, position, permissions, is_default, created_at, updated_at) VALUES (?1, ?2, 'everyone', '#ccc', 0, 0, 1, ?3, ?3)",
                rusqlite::params![role_id, team_id, now()],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();
        role_id
    }

    #[tokio::test]
    async fn channel_join_denied_when_user_not_a_team_member() {
        let hub = test_hub();
        let db = hub.db.clone();
        let _everyone = seed_team_with_default_role(&db, "team1", "owner1");

        // Create a non-default role and put it on a private channel.
        // user_can_access_channel returns true when access_roles is empty,
        // so we need a private gated channel to make the access check
        // meaningful.
        let private_role = db::new_id();
        let channel_id = "channel1".to_string();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO roles (id, team_id, name, color, position, permissions, is_default, created_at, updated_at) VALUES (?1, ?2, 'mods', '#f00', 1, 0, 0, ?3, ?3)",
                rusqlite::params![private_role, "team1", now()],
            )?;
            db::create_channel(conn, &db::Channel {
                id: channel_id.clone(),
                team_id: "team1".into(),
                name: "private".into(),
                topic: String::new(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: "owner1".into(),
                created_at: now(),
                updated_at: now(),
                locked: false,
                hidden_if_restricted: false,
                slow_mode_seconds: 0,
                group_id: None,
            })?;
            conn.execute(
                "INSERT INTO channel_role_access (channel_id, role_id) VALUES (?1, ?2)",
                rusqlite::params![channel_id, private_role],
            )?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();

        // outsider — has a valid JWT, but no team membership at all.
        let allowed = user_can_subscribe_to_channel(&hub, "outsider", "team1", &channel_id).await;
        assert!(!allowed, "outsider must not be allowed to subscribe to a private channel");
    }

    #[tokio::test]
    async fn channel_join_denied_when_channel_belongs_to_another_team() {
        let hub = test_hub();
        let db = hub.db.clone();
        let _everyone = seed_team_with_default_role(&db, "team1", "owner1");
        let _everyone2 = seed_team_with_default_role(&db, "team2", "owner2");

        db.with_conn(|conn| {
            db::create_channel(conn, &db::Channel {
                id: "ch-in-t2".into(),
                team_id: "team2".into(),
                name: "general".into(),
                topic: String::new(),
                channel_type: "text".into(),
                position: 0,
                category: String::new(),
                created_by: "owner2".into(),
                created_at: now(),
                updated_at: now(),
                locked: false,
                hidden_if_restricted: false,
                slow_mode_seconds: 0,
                group_id: None,
            })
        })
        .unwrap();

        // owner1 is the team owner of team1 — would normally bypass
        // every channel check — but the channel belongs to team2, so
        // the cross-team boundary must reject the subscribe.
        let allowed = user_can_subscribe_to_channel(&hub, "owner1", "team1", "ch-in-t2").await;
        assert!(!allowed, "must not subscribe to a channel that doesn't belong to caller's team");
    }

    #[tokio::test]
    async fn dm_subscribe_requires_dm_membership() {
        let hub = test_hub();
        let db = hub.db.clone();
        let _everyone = seed_team_with_default_role(&db, "team1", "owner1");

        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "alice".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now(),
                updated_at: now(),
                quiet_hours_enabled: false,
                quiet_hours_from: String::new(),
                quiet_hours_to: String::new(),
            })?;
            db::create_user(conn, &db::User {
                id: "eve".into(),
                username: "eve".into(),
                display_name: "Eve".into(),
                public_key: vec![2u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now(),
                updated_at: now(),
                quiet_hours_enabled: false,
                quiet_hours_from: String::new(),
                quiet_hours_to: String::new(),
            })?;
            conn.execute(
                "INSERT INTO dm_channels (id, team_id, type, name, created_at) VALUES (?1, ?2, 'dm', '', ?3)",
                rusqlite::params!["dm-alice-owner1", "team1", now()],
            )?;
            db::add_dm_members(conn, "dm-alice-owner1", &["alice".into(), "owner1".into()])?;
            Ok::<(), rusqlite::Error>(())
        })
        .unwrap();

        // Alice and owner1 are members — both must be allowed.
        assert!(user_can_subscribe_to_channel(&hub, "alice", "team1", "dm-alice-owner1").await);
        assert!(user_can_subscribe_to_channel(&hub, "owner1", "team1", "dm-alice-owner1").await);
        // Eve is in the team but not in the DM — must be denied.
        assert!(!user_can_subscribe_to_channel(&hub, "eve", "team1", "dm-alice-owner1").await);
    }

    #[tokio::test]
    async fn channel_join_denied_for_unknown_channel_id() {
        let hub = test_hub();
        let db = hub.db.clone();
        let _everyone = seed_team_with_default_role(&db, "team1", "owner1");

        // Channel ID that doesn't exist in channels OR dm_members → deny.
        let allowed = user_can_subscribe_to_channel(&hub, "owner1", "team1", "bogus-id").await;
        assert!(!allowed);
    }
}
