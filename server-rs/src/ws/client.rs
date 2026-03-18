use super::events::*;
use super::hub::Hub;
use crate::db;
use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

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
                    if let Some(cb) = hub_read.on_client_activity.read().await.as_ref() {
                        cb(&uid);
                    }

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

async fn handle_event(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    event: Event,
) {
    match event.event_type.as_str() {
        EVENT_CHANNEL_JOIN => {
            match serde_json::from_value::<ChannelJoinPayload>(event.payload) {
                Ok(p) => hub.subscribe(client_id, &p.channel_id).await,
                Err(e) => tracing::warn!(error = %e, event = "channel:join", "failed to parse payload"),
            }
        }
        EVENT_CHANNEL_LEAVE => {
            match serde_json::from_value::<ChannelJoinPayload>(event.payload) {
                Ok(p) => hub.unsubscribe(client_id, &p.channel_id).await,
                Err(e) => tracing::warn!(error = %e, event = "channel:leave", "failed to parse payload"),
            }
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
            handle_typing(hub, client_id, user_id, username, event.payload).await;
        }
        EVENT_PRESENCE_UPDATE => {
            if let Ok(p) = serde_json::from_value::<PresenceUpdatePayload>(event.payload) {
                if let Some(cb) = hub.on_presence_update.read().await.as_ref() {
                    cb(user_id, &p.status_type, &p.status_text);
                }
            }
        }
        EVENT_PING => {
            let pong = Event::new(EVENT_PONG, serde_json::json!({}));
            if let Ok(evt) = pong {
                if let Ok(data) = evt.to_bytes() {
                    hub.send_to_user(user_id, data).await;
                }
            }
        }
        EVENT_REQUEST => {
            if let Ok(req) = serde_json::from_value::<RequestEvent>(event.payload) {
                handle_request(hub, user_id, team_id, req).await;
            }
        }
        // Reactions
        EVENT_REACTION_ADD => {
            if let Ok(p) = serde_json::from_value::<ReactionPayload>(event.payload) {
                handle_reaction_add(hub, user_id, p).await;
            }
        }
        EVENT_REACTION_REMOVE => {
            if let Ok(p) = serde_json::from_value::<ReactionPayload>(event.payload) {
                handle_reaction_remove(hub, user_id, p).await;
            }
        }
        // Threads
        EVENT_THREAD_MESSAGE_SEND => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageSendPayload>(event.payload) {
                handle_thread_message_send(hub, user_id, p).await;
            }
        }
        EVENT_THREAD_MESSAGE_EDIT => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageEditPayload>(event.payload) {
                handle_thread_message_edit(hub, user_id, p).await;
            }
        }
        EVENT_THREAD_MESSAGE_REMOVE => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageRemovePayload>(event.payload) {
                handle_thread_message_remove(hub, user_id, p).await;
            }
        }
        // Voice
        EVENT_VOICE_JOIN => {
            if let Ok(p) = serde_json::from_value::<VoiceJoinPayload>(event.payload) {
                handle_voice_join(hub, client_id, user_id, username, team_id, p).await;
            }
        }
        EVENT_VOICE_LEAVE => {
            if let Ok(p) = serde_json::from_value::<VoiceJoinPayload>(event.payload) {
                handle_voice_leave(hub, client_id, user_id, p).await;
            }
        }
        EVENT_VOICE_ANSWER => {
            if let Ok(p) = serde_json::from_value::<VoiceAnswerPayload>(event.payload) {
                handle_voice_answer(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_ICE_CANDIDATE => {
            if let Ok(p) = serde_json::from_value::<VoiceICECandidatePayload>(event.payload) {
                handle_voice_ice_candidate(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_MUTE => {
            if let Ok(p) = serde_json::from_value::<VoiceMutePayload>(event.payload) {
                handle_voice_mute(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_DEAFEN => {
            if let Ok(p) = serde_json::from_value::<VoiceDeafenPayload>(event.payload) {
                handle_voice_deafen(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_SCREEN_START => {
            if let Ok(p) = serde_json::from_value::<VoiceScreenPayload>(event.payload) {
                handle_voice_screen_start(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_SCREEN_STOP => {
            if let Ok(p) = serde_json::from_value::<VoiceScreenPayload>(event.payload) {
                handle_voice_screen_stop(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_WEBCAM_START => {
            if let Ok(p) = serde_json::from_value::<VoiceScreenPayload>(event.payload) {
                handle_voice_webcam_start(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_WEBCAM_STOP => {
            if let Ok(p) = serde_json::from_value::<VoiceScreenPayload>(event.payload) {
                handle_voice_webcam_stop(hub, user_id, p).await;
            }
        }
        EVENT_VOICE_KEY_DISTRIBUTE => {
            if let Ok(mut p) = serde_json::from_value::<VoiceKeyDistributePayload>(event.payload) {
                p.sender_id = user_id.to_string();
                let evt = Event::new(EVENT_VOICE_KEY_DISTRIBUTE, &p);
                if let Ok(evt) = evt {
                    if let Ok(data) = evt.to_bytes() {
                        hub.broadcast_to_channel(&p.channel_id, data, Some(client_id.to_string()))
                            .await;
                    }
                }
            }
        }
        // DM events
        EVENT_DM_MESSAGE_SEND => {
            match serde_json::from_value::<DMMessageSendPayload>(event.payload) {
                Ok(p) => handle_dm_message_send(hub, user_id, username, p).await,
                Err(e) => tracing::warn!(error = %e, event = "dm:message:send", "failed to parse payload"),
            }
        }
        EVENT_DM_MESSAGE_EDIT => {
            match serde_json::from_value::<DMMessageEditPayload>(event.payload) {
                Ok(p) => handle_dm_message_edit(hub, user_id, p).await,
                Err(e) => tracing::warn!(error = %e, event = "dm:message:edit", "failed to parse payload"),
            }
        }
        EVENT_DM_MESSAGE_DELETE => {
            match serde_json::from_value::<DMMessageDeletePayload>(event.payload) {
                Ok(p) => handle_dm_message_delete(hub, user_id, p).await,
                Err(e) => tracing::warn!(error = %e, event = "dm:message:delete", "failed to parse payload"),
            }
        }
        EVENT_DM_TYPING_START | EVENT_DM_TYPING_STOP => {
            if let Ok(p) = serde_json::from_value::<DMTypingPayload>(event.payload) {
                // Send typing indicator to all DM members.
                let evt = Event::new(
                    EVENT_TYPING_INDICATOR,
                    TypingPayload {
                        channel_id: p.dm_channel_id.clone(),
                        user_id: user_id.to_string(),
                        username: username.to_string(),
                    },
                );
                if let Ok(evt) = evt {
                    if let Ok(data) = evt.to_bytes() {
                        // Get DM members and send to each.
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
                }
            }
        }
        _ => {
            tracing::debug!(event_type = event.event_type, "unhandled event type");
        }
    }
}

// ── Message handlers ──────────────────────────────────────────────────────────

async fn handle_message_send(
    hub: &Hub,
    _client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    payload: serde_json::Value,
) {
    let p: MessageSendPayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "failed to parse message send payload");
            return;
        }
    };

    // Verify the channel belongs to the user's team before creating the message.
    let db = hub.db.clone();
    let cid = p.channel_id.clone();
    let tid = team_id.to_string();
    let channel_ok = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let channel = db::get_channel_by_id(conn, &cid)?;
            match channel {
                Some(ch) if ch.team_id == tid => Ok(true),
                Some(_) => Ok(false),
                None => Ok(false),
            }
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !channel_ok {
        tracing::warn!(
            user_id = user_id,
            channel_id = %p.channel_id,
            team_id = team_id,
            "message:send denied — channel does not belong to user's team"
        );
        return;
    }

    let msg_id = db::new_id();
    let now = db::now_str();
    let msg_type = if p.msg_type.is_empty() {
        "text".to_string()
    } else {
        p.msg_type
    };

    let msg = db::Message {
        id: msg_id.clone(),
        channel_id: p.channel_id.clone(),
        dm_channel_id: String::new(),
        author_id: user_id.to_string(),
        content: p.content.clone(),
        msg_type: msg_type.clone(),
        thread_id: p.thread_id.clone(),
        edited_at: None,
        deleted: false,
        lamport_ts: 0,
        created_at: now.clone(),
    };

    let db = hub.db.clone();
    let msg_clone = msg.clone();
    if let Err(e) =
        tokio::task::spawn_blocking(move || db.with_conn(|conn| db::create_message(conn, &msg_clone)))
            .await
            .unwrap()
    {
        tracing::error!("failed to create message: {}", e);
        return;
    }

    let new_event = Event::new(
        EVENT_MESSAGE_NEW,
        MessageNewPayload {
            id: msg_id,
            channel_id: p.channel_id.clone(),
            author_id: user_id.to_string(),
            username: username.to_string(),
            content: p.content,
            msg_type,
            thread_id: p.thread_id,
            created_at: now,
        },
    );

    if let Ok(evt) = new_event {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }

    if let Some(cb) = hub.on_message_send.read().await.as_ref() {
        cb(&msg, username);
    }
}

async fn handle_message_edit(hub: &Hub, user_id: &str, payload: serde_json::Value) {
    let p: MessageEditPayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "failed to parse message edit payload");
            return;
        }
    };

    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let content = p.content.clone();
    let uid = user_id.to_string();
    let edited = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if let Ok(Some(msg)) = db::get_message_by_id(conn, &mid) {
                if msg.author_id == uid {
                    db::update_message_content(conn, &mid, &content)?;
                    return Ok(true);
                }
            }
            Ok(false)
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !edited {
        return;
    }

    let evt = Event::new(EVENT_MESSAGE_UPDATED, &p);
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }

    if let Some(cb) = hub.on_message_edit.read().await.as_ref() {
        cb(&p.message_id, &p.channel_id, &p.content);
    }
}

async fn handle_message_delete(hub: &Hub, user_id: &str, payload: serde_json::Value) {
    let p: MessageDeletePayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "failed to parse message delete payload");
            return;
        }
    };

    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let deleted = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            if let Ok(Some(msg)) = db::get_message_by_id(conn, &mid) {
                if msg.author_id == uid {
                    db::soft_delete_message(conn, &mid)?;
                    return Ok(true);
                }
            }
            Ok(false)
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !deleted {
        return;
    }

    let evt = Event::new(EVENT_MESSAGE_DELETED, &p);
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }

    if let Some(cb) = hub.on_message_delete.read().await.as_ref() {
        cb(&p.message_id, &p.channel_id);
    }
}

async fn handle_typing(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    payload: serde_json::Value,
) {
    let p: ChannelJoinPayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(_) => return,
    };

    let throttle_key = format!("{}:{}", p.channel_id, user_id);
    let now = chrono::Utc::now().timestamp();
    {
        let throttle = hub.typing_throttle().read().await;
        if let Some(&last) = throttle.get(&throttle_key) {
            if now - last < 3 {
                return;
            }
        }
    }
    hub.typing_throttle()
        .write()
        .await
        .insert(throttle_key, now);

    let evt = Event::new(
        EVENT_TYPING_INDICATOR,
        TypingPayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            username: username.to_string(),
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, Some(client_id.to_string()))
                .await;
        }
    }
}

// ── Reaction handlers ─────────────────────────────────────────────────────────

async fn handle_reaction_add(hub: &Hub, user_id: &str, p: ReactionPayload) {
    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let emoji = p.emoji.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::add_reaction(conn, &mid, &uid, &emoji))
    })
    .await
    .unwrap();

    if let Err(e) = result {
        tracing::error!("reaction:add failed: {}", e);
        return;
    }

    let evt = Event::new(
        EVENT_REACTION_ADDED,
        ReactionEventPayload {
            message_id: p.message_id,
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            emoji: p.emoji,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }
}

async fn handle_reaction_remove(hub: &Hub, user_id: &str, p: ReactionPayload) {
    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let emoji = p.emoji.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::remove_reaction(conn, &mid, &uid, &emoji))
    })
    .await
    .unwrap();

    if let Err(e) = result {
        tracing::error!("reaction:remove failed: {}", e);
        return;
    }

    let evt = Event::new(
        EVENT_REACTION_REMOVED,
        ReactionEventPayload {
            message_id: p.message_id,
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            emoji: p.emoji,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }
}

// ── Thread handlers ───────────────────────────────────────────────────────────

async fn handle_thread_message_send(hub: &Hub, user_id: &str, p: ThreadMessageSendPayload) {
    let db = hub.db.clone();
    let tid = p.thread_id.clone();
    let uid = user_id.to_string();
    let content = p.content.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let thread = db::get_thread(conn, &tid)?;
            let thread = match thread {
                Some(t) => t,
                None => return Err(rusqlite::Error::QueryReturnedNoRows),
            };

            let msg = db::Message {
                id: db::new_id(),
                channel_id: thread.channel_id.clone(),
                dm_channel_id: String::new(),
                author_id: uid.clone(),
                content,
                msg_type: "text".to_string(),
                thread_id: tid.clone(),
                edited_at: None,
                deleted: false,
                lamport_ts: 0,
                created_at: db::now_str(),
            };
            db::create_thread_message(conn, &msg)?;

            // Get updated thread for message count.
            let updated_thread = db::get_thread(conn, &tid)?;
            Ok((msg, thread.channel_id, updated_thread))
        })
    })
    .await
    .unwrap();

    match result {
        Ok((msg, channel_id, updated_thread)) => {
            let evt = Event::new(
                EVENT_THREAD_MESSAGE_NEW,
                ThreadMessageNewPayload {
                    id: msg.id,
                    thread_id: p.thread_id.clone(),
                    channel_id: channel_id.clone(),
                    author_id: msg.author_id,
                    content: msg.content,
                    msg_type: msg.msg_type,
                    created_at: msg.created_at,
                },
            );
            if let Ok(evt) = evt {
                if let Ok(data) = evt.to_bytes() {
                    hub.broadcast_to_channel(&channel_id, data, None).await;
                }
            }

            if let Some(thread) = updated_thread {
                let uevt = Event::new(
                    EVENT_THREAD_UPDATED,
                    ThreadUpdatedPayload {
                        id: thread.id,
                        title: thread.title,
                        message_count: thread.message_count,
                        last_message_at: thread.last_message_at.unwrap_or_default(),
                    },
                );
                if let Ok(uevt) = uevt {
                    if let Ok(data) = uevt.to_bytes() {
                        hub.broadcast_to_channel(&channel_id, data, None).await;
                    }
                }
            }
        }
        Err(e) => {
            tracing::error!("thread:message:send failed: {}", e);
        }
    }
}

async fn handle_thread_message_edit(hub: &Hub, user_id: &str, p: ThreadMessageEditPayload) {
    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let tid = p.thread_id.clone();
    let content = p.content.clone();
    let uid = user_id.to_string();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let msg = db::get_message_by_id(conn, &mid)?;
            let _msg = match msg {
                Some(m) if m.thread_id == tid && m.author_id == uid => m,
                _ => return Err(rusqlite::Error::QueryReturnedNoRows),
            };
            db::update_message_content(conn, &mid, &content)?;
            let thread = db::get_thread(conn, &tid)?;
            Ok(thread.map(|t| t.channel_id).unwrap_or_default())
        })
    })
    .await
    .unwrap();

    if let Ok(channel_id) = result {
        let evt = Event::new(
            EVENT_THREAD_MESSAGE_UPDATED,
            ThreadMessageUpdatedPayload {
                id: p.message_id,
                thread_id: p.thread_id,
                content: p.content,
                edited_at: db::now_str(),
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_channel(&channel_id, data, None).await;
            }
        }
    }
}

async fn handle_thread_message_remove(hub: &Hub, user_id: &str, p: ThreadMessageRemovePayload) {
    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let tid = p.thread_id.clone();
    let uid = user_id.to_string();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let msg = db::get_message_by_id(conn, &mid)?;
            match msg {
                Some(m) if m.thread_id == tid && m.author_id == uid => {}
                _ => return Err(rusqlite::Error::QueryReturnedNoRows),
            };
            db::soft_delete_message(conn, &mid)?;
            let thread = db::get_thread(conn, &tid)?;
            Ok(thread.map(|t| t.channel_id).unwrap_or_default())
        })
    })
    .await
    .unwrap();

    if let Ok(channel_id) = result {
        let evt = Event::new(
            EVENT_THREAD_MESSAGE_DELETED,
            ThreadMessageDeletedPayload {
                id: p.message_id,
                thread_id: p.thread_id,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_channel(&channel_id, data, None).await;
            }
        }
    }
}

// ── Voice handlers ────────────────────────────────────────────────────────────

async fn handle_voice_join(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    username: &str,
    team_id: &str,
    p: VoiceJoinPayload,
) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .add_peer(&p.channel_id, user_id, username, team_id)
            .await;

        hub.subscribe(client_id, &p.channel_id).await;

        // Notify all clients about the join.
        let evt = Event::new(
            EVENT_VOICE_USER_JOINED,
            VoiceUserJoinedPayload {
                channel_id: p.channel_id.clone(),
                user_id: user_id.to_string(),
                username: username.to_string(),
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }

        // Send current voice state to the joining client.
        if let Some(peers) = room_mgr.get_room(&p.channel_id).await {
            let evt = Event::new(
                EVENT_VOICE_STATE,
                VoiceStatePayload {
                    channel_id: p.channel_id.clone(),
                    peers,
                },
            );
            if let Ok(evt) = evt {
                if let Ok(data) = evt.to_bytes() {
                    hub.send_to_user(user_id, data).await;
                }
            }
        }

        // SFU join - create peer connection and send offer.
        if let Some(sfu) = &hub.voice_sfu {
            match sfu.handle_join(&p.channel_id, user_id).await {
                Ok(offer_sdp) => {
                    let evt = Event::new(
                        EVENT_VOICE_OFFER,
                        VoiceOfferPayload {
                            channel_id: p.channel_id.clone(),
                            sdp: offer_sdp,
                        },
                    );
                    if let Ok(evt) = evt {
                        if let Ok(data) = evt.to_bytes() {
                            hub.send_to_user(user_id, data).await;
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("voice join failed: {}", e);
                }
            }
        }

        if let Some(cb) = hub.on_voice_join.read().await.as_ref() {
            cb(&p.channel_id, user_id, username);
        }
    }
}

async fn handle_voice_leave(
    hub: &Hub,
    client_id: &str,
    user_id: &str,
    p: VoiceJoinPayload,
) {
    if let Some(sfu) = &hub.voice_sfu {
        sfu.handle_leave(&p.channel_id, user_id).await;
    }

    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr.remove_peer(&p.channel_id, user_id).await;
    }

    let evt = Event::new(
        EVENT_VOICE_USER_LEFT,
        VoiceUserLeftPayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    hub.unsubscribe(client_id, &p.channel_id).await;

    if let Some(cb) = hub.on_voice_leave.read().await.as_ref() {
        cb(&p.channel_id, user_id);
    }
}

async fn handle_voice_answer(hub: &Hub, user_id: &str, p: VoiceAnswerPayload) {
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu.handle_answer(&p.channel_id, user_id, &p.sdp).await {
            tracing::error!("voice answer failed: {}", e);
        }
    }
}

async fn handle_voice_ice_candidate(hub: &Hub, user_id: &str, p: VoiceICECandidatePayload) {
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu
            .handle_ice_candidate(&p.channel_id, user_id, &p.candidate, &p.sdp_mid, p.sdp_mline_index)
            .await
        {
            tracing::error!("voice ice candidate failed: {}", e);
        }
    }
}

async fn handle_voice_mute(hub: &Hub, user_id: &str, p: VoiceMutePayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr.set_muted(&p.channel_id, user_id, p.muted).await;

        let deafened = room_mgr
            .get_room(&p.channel_id)
            .await
            .and_then(|peers| peers.iter().find(|peer| peer.user_id == user_id).map(|peer| peer.deafened))
            .unwrap_or(false);

        let evt = Event::new(
            EVENT_VOICE_MUTE_UPDATE,
            VoiceMuteUpdatePayload {
                channel_id: p.channel_id,
                user_id: user_id.to_string(),
                muted: p.muted,
                deafened,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }
    }
}

async fn handle_voice_deafen(hub: &Hub, user_id: &str, p: VoiceDeafenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_deafened(&p.channel_id, user_id, p.deafened)
            .await;
        if p.deafened {
            room_mgr.set_muted(&p.channel_id, user_id, true).await;
        }

        let muted = if p.deafened {
            true
        } else {
            room_mgr
                .get_room(&p.channel_id)
                .await
                .and_then(|peers| peers.iter().find(|peer| peer.user_id == user_id).map(|peer| peer.muted))
                .unwrap_or(false)
        };

        let evt = Event::new(
            EVENT_VOICE_MUTE_UPDATE,
            VoiceMuteUpdatePayload {
                channel_id: p.channel_id,
                user_id: user_id.to_string(),
                muted,
                deafened: p.deafened,
            },
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                hub.broadcast_to_all(data).await;
            }
        }
    }
}

async fn handle_voice_screen_start(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_screen_sharing(&p.channel_id, user_id, true)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu.add_screen_track(&p.channel_id, user_id).await {
            tracing::error!("voice screen start failed: {}", e);
            if let Some(room_mgr) = &hub.voice_room_manager {
                room_mgr
                    .set_screen_sharing(&p.channel_id, user_id, false)
                    .await;
            }
            return;
        }
    }

    let evt = Event::new(
        EVENT_VOICE_SCREEN_UPDATE,
        VoiceScreenUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: true,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

async fn handle_voice_screen_stop(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_screen_sharing(&p.channel_id, user_id, false)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        let _ = sfu.remove_screen_track(&p.channel_id, user_id).await;
    }

    let evt = Event::new(
        EVENT_VOICE_SCREEN_UPDATE,
        VoiceScreenUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: false,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

async fn handle_voice_webcam_start(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_webcam_sharing(&p.channel_id, user_id, true)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        if let Err(e) = sfu.add_webcam_track(&p.channel_id, user_id).await {
            tracing::error!("voice webcam start failed: {}", e);
            if let Some(room_mgr) = &hub.voice_room_manager {
                room_mgr
                    .set_webcam_sharing(&p.channel_id, user_id, false)
                    .await;
            }
            return;
        }
    }

    let evt = Event::new(
        EVENT_VOICE_WEBCAM_UPDATE,
        VoiceWebcamUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: true,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

async fn handle_voice_webcam_stop(hub: &Hub, user_id: &str, p: VoiceScreenPayload) {
    if let Some(room_mgr) = &hub.voice_room_manager {
        room_mgr
            .set_webcam_sharing(&p.channel_id, user_id, false)
            .await;
    }
    if let Some(sfu) = &hub.voice_sfu {
        let _ = sfu.remove_webcam_track(&p.channel_id, user_id).await;
    }

    let evt = Event::new(
        EVENT_VOICE_WEBCAM_UPDATE,
        VoiceWebcamUpdatePayload {
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            sharing: false,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_all(data).await;
        }
    }

    if let Some(sfu) = &hub.voice_sfu {
        sfu.renegotiate_all(&p.channel_id).await;
    }
}

// ── DM handlers ───────────────────────────────────────────────────────────────

async fn handle_dm_message_send(
    hub: &Hub,
    user_id: &str,
    username: &str,
    p: DMMessageSendPayload,
) {
    // Verify the user is a member of the DM channel.
    let db = hub.db.clone();
    let dm_id_check = p.dm_channel_id.clone();
    let uid_check = user_id.to_string();
    let is_member = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::is_dm_member(conn, &dm_id_check, &uid_check))
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !is_member {
        tracing::warn!(
            user_id = user_id,
            dm_channel_id = %p.dm_channel_id,
            "dm:message:send denied — user is not a member of this DM channel"
        );
        return;
    }

    let db = hub.db.clone();
    let dm_id = p.dm_channel_id.clone();
    let uid = user_id.to_string();
    let content = p.content.clone();
    let msg_type = if p.msg_type.is_empty() {
        "text".to_string()
    } else {
        p.msg_type.clone()
    };

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let msg = db::Message {
                id: db::new_id(),
                channel_id: String::new(),
                dm_channel_id: dm_id.clone(),
                author_id: uid,
                content,
                msg_type,
                thread_id: String::new(),
                edited_at: None,
                deleted: false,
                lamport_ts: 0,
                created_at: db::now_str(),
            };
            db::create_message(conn, &msg)?;
            let members = db::get_dm_members(conn, &dm_id)?;
            Ok((msg, members))
        })
    })
    .await
    .unwrap();

    match result {
        Ok((msg, members)) => {
            let evt = Event::new(
                EVENT_DM_MESSAGE_NEW,
                DMMessageNewPayload {
                    id: msg.id,
                    dm_channel_id: p.dm_channel_id,
                    author_id: msg.author_id.clone(),
                    username: username.to_string(),
                    content: msg.content,
                    msg_type: msg.msg_type,
                    created_at: msg.created_at,
                },
            );
            if let Ok(evt) = evt {
                if let Ok(data) = evt.to_bytes() {
                    for member in members {
                        hub.send_to_user(&member.user_id, data.clone()).await;
                    }
                }
            }
        }
        Err(e) => {
            tracing::error!("dm:message:send failed: {}", e);
        }
    }
}

async fn handle_dm_message_edit(hub: &Hub, user_id: &str, p: DMMessageEditPayload) {
    // Verify the user is a member of the DM channel.
    let db = hub.db.clone();
    let dm_id_check = p.dm_channel_id.clone();
    let uid_check = user_id.to_string();
    let is_member = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::is_dm_member(conn, &dm_id_check, &uid_check))
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !is_member {
        tracing::warn!(
            user_id = user_id,
            dm_channel_id = %p.dm_channel_id,
            "dm:message:edit denied — user is not a member of this DM channel"
        );
        return;
    }

    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let content = p.content.clone();
    let uid = user_id.to_string();
    let dm_id = p.dm_channel_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let msg = db::get_message_by_id(conn, &mid)?;
            match msg {
                Some(m) if m.author_id == uid => {}
                _ => return Err(rusqlite::Error::QueryReturnedNoRows),
            };
            db::update_message_content(conn, &mid, &content)?;
            let members = db::get_dm_members(conn, &dm_id)?;
            Ok(members)
        })
    })
    .await
    .unwrap();

    if let Ok(members) = result {
        let evt = Event::new(
            EVENT_DM_MESSAGE_UPDATED,
            serde_json::json!({
                "message_id": p.message_id,
                "dm_channel_id": p.dm_channel_id,
                "content": p.content,
                "edited_at": db::now_str(),
            }),
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                for member in members {
                    hub.send_to_user(&member.user_id, data.clone()).await;
                }
            }
        }
    }
}

async fn handle_dm_message_delete(hub: &Hub, user_id: &str, p: DMMessageDeletePayload) {
    // Verify the user is a member of the DM channel.
    let db = hub.db.clone();
    let dm_id_check = p.dm_channel_id.clone();
    let uid_check = user_id.to_string();
    let is_member = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::is_dm_member(conn, &dm_id_check, &uid_check))
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !is_member {
        tracing::warn!(
            user_id = user_id,
            dm_channel_id = %p.dm_channel_id,
            "dm:message:delete denied — user is not a member of this DM channel"
        );
        return;
    }

    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let dm_id = p.dm_channel_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let msg = db::get_message_by_id(conn, &mid)?;
            match msg {
                Some(m) if m.author_id == uid => {}
                _ => return Err(rusqlite::Error::QueryReturnedNoRows),
            };
            db::soft_delete_message(conn, &mid)?;
            let members = db::get_dm_members(conn, &dm_id)?;
            Ok(members)
        })
    })
    .await
    .unwrap();

    if let Ok(members) = result {
        let evt = Event::new(
            EVENT_DM_MESSAGE_DELETED,
            serde_json::json!({
                "message_id": p.message_id,
                "dm_channel_id": p.dm_channel_id,
            }),
        );
        if let Ok(evt) = evt {
            if let Ok(data) = evt.to_bytes() {
                for member in members {
                    hub.send_to_user(&member.user_id, data.clone()).await;
                }
            }
        }
    }
}

// ── Request handlers ──────────────────────────────────────────────────────────

async fn handle_request(hub: &Hub, user_id: &str, team_id: &str, req: RequestEvent) {
    let db = hub.db.clone();
    let uid = user_id.to_string();
    let tid = team_id.to_string();
    let req_id = req.id.clone();
    let action = req.action.clone();

    let result = match action.as_str() {
        ACTION_SYNC_INIT => {
            let db2 = db.clone();
            let tid2 = tid.clone();
            tokio::task::spawn_blocking(move || {
                db2.with_conn(|conn| {
                    let channels = db::get_channels_by_team(conn, &tid2)?;
                    let members = db::get_members_by_team(conn, &tid2)?;
                    let roles = db::get_roles_by_team(conn, &tid2)?;
                    let team = db::get_team(conn, &tid2)?;
                    Ok(serde_json::json!({
                        "team": team,
                        "channels": channels,
                        "members": members.iter().map(|(m, u)| {
                            serde_json::json!({
                                "member": m,
                                "user": u,
                            })
                        }).collect::<Vec<_>>(),
                        "roles": roles,
                    }))
                })
            })
            .await
            .unwrap()
        }
        ACTION_MESSAGE_LIST => {
            let channel_id = req
                .payload
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let before = req
                .payload
                .get("before")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let limit = req
                .payload
                .get("limit")
                .and_then(|v| v.as_i64())
                .unwrap_or(50) as i32;

            tokio::task::spawn_blocking(move || {
                db.with_conn(|conn| {
                    let messages = db::get_messages_by_channel(conn, &channel_id, &before, limit)?;
                    Ok(serde_json::to_value(messages).unwrap())
                })
            })
            .await
            .unwrap()
        }
        ACTION_THREAD_LIST => {
            let channel_id = req
                .payload
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            tokio::task::spawn_blocking(move || {
                db.with_conn(|conn| {
                    let threads = db::get_channel_threads(conn, &channel_id)?;
                    Ok(serde_json::to_value(threads).unwrap())
                })
            })
            .await
            .unwrap()
        }
        ACTION_THREAD_MESSAGES => {
            let thread_id = req
                .payload
                .get("thread_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let before = req
                .payload
                .get("before")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let limit = req
                .payload
                .get("limit")
                .and_then(|v| v.as_i64())
                .unwrap_or(50) as i32;

            tokio::task::spawn_blocking(move || {
                db.with_conn(|conn| {
                    let messages = db::get_thread_messages(conn, &thread_id, &before, limit)?;
                    Ok(serde_json::to_value(messages).unwrap())
                })
            })
            .await
            .unwrap()
        }
        ACTION_DM_LIST => {
            let db2 = db.clone();
            let tid2 = tid.clone();
            let uid2 = uid.clone();
            tokio::task::spawn_blocking(move || {
                db2.with_conn(|conn| {
                    let channels = db::get_user_dm_channels(conn, &tid2, &uid2)?;
                    let mut results = Vec::new();
                    for ch in &channels {
                        let members = db::get_dm_members(conn, &ch.id)?;
                        let last_msg = db::get_last_dm_message(conn, &ch.id)?;
                        results.push(serde_json::json!({
                            "id": ch.id,
                            "team_id": ch.team_id,
                            "name": ch.name,
                            "created_at": ch.created_at,
                            "members": members,
                            "last_message": last_msg,
                        }));
                    }
                    Ok(serde_json::json!({ "dm_channels": results }))
                })
            })
            .await
            .unwrap()
        }
        ACTION_DM_MESSAGES => {
            let dm_id = req
                .payload
                .get("dm_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let before = req
                .payload
                .get("before")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let limit = req
                .payload
                .get("limit")
                .and_then(|v| v.as_i64())
                .unwrap_or(50) as i32;

            tokio::task::spawn_blocking(move || {
                db.with_conn(|conn| {
                    let messages = db::get_dm_messages(conn, &dm_id, &before, limit)?;
                    Ok(serde_json::to_value(messages).unwrap())
                })
            })
            .await
            .unwrap()
        }
        _ => Ok(serde_json::json!(null)),
    };

    let response = match result {
        Ok(payload) => ResponseEvent {
            id: req_id,
            action,
            ok: true,
            payload: Some(payload),
            error: None,
        },
        Err(e) => ResponseEvent {
            id: req_id,
            action,
            ok: false,
            payload: None,
            error: Some(format!("{}", e)),
        },
    };

    let evt = Event {
        event_type: "response".to_string(),
        payload: serde_json::to_value(&response).unwrap_or_default(),
    };
    if let Ok(data) = serde_json::to_vec(&evt) {
        hub.send_to_user(user_id, data).await;
    }
}
