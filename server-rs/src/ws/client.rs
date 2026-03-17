use super::events::*;
use super::hub::{ClientHandle, Hub};
use crate::db::{self, Database};
use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

const WRITE_WAIT: Duration = Duration::from_secs(10);
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

    let client = ClientHandle {
        id: client_id.clone(),
        user_id: user_id.clone(),
        username: username.clone(),
        team_id: team_id.clone(),
        sender: tx,
    };

    hub.register(client).await;

    let (mut ws_sender, mut ws_receiver) = socket.split();

    let hub_write = hub.clone();
    let cid_write = client_id.clone();

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
                        handle_event(
                            &hub_read, &cid_read, &uid, &uname, &tid, event,
                        )
                        .await;
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
            if let Ok(p) = serde_json::from_value::<ChannelJoinPayload>(event.payload) {
                hub.subscribe(client_id, &p.channel_id).await;
            }
        }
        EVENT_CHANNEL_LEAVE => {
            if let Ok(p) = serde_json::from_value::<ChannelJoinPayload>(event.payload) {
                hub.unsubscribe(client_id, &p.channel_id).await;
            }
        }
        EVENT_MESSAGE_SEND => {
            if let Ok(p) = serde_json::from_value::<MessageSendPayload>(event.payload) {
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

                // Federation callback.
                if let Some(cb) = hub.on_message_send.read().await.as_ref() {
                    cb(&msg, username);
                }
            }
        }
        EVENT_MESSAGE_EDIT => {
            if let Ok(p) = serde_json::from_value::<MessageEditPayload>(event.payload) {
                let db = hub.db.clone();
                let mid = p.message_id.clone();
                let content = p.content.clone();
                let uid = user_id.to_string();
                let _ = tokio::task::spawn_blocking(move || {
                    db.with_conn(|conn| {
                        // Verify author.
                        if let Ok(Some(msg)) = db::get_message_by_id(conn, &mid) {
                            if msg.author_id == uid {
                                db::update_message_content(conn, &mid, &content)?;
                            }
                        }
                        Ok(())
                    })
                })
                .await;

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
        }
        EVENT_MESSAGE_DELETE => {
            if let Ok(p) = serde_json::from_value::<MessageDeletePayload>(event.payload) {
                let db = hub.db.clone();
                let mid = p.message_id.clone();
                let uid = user_id.to_string();
                let _ = tokio::task::spawn_blocking(move || {
                    db.with_conn(|conn| {
                        if let Ok(Some(msg)) = db::get_message_by_id(conn, &mid) {
                            if msg.author_id == uid {
                                db::soft_delete_message(conn, &mid)?;
                            }
                        }
                        Ok(())
                    })
                })
                .await;

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
        }
        EVENT_TYPING_START | EVENT_TYPING_STOP => {
            if let Ok(p) = serde_json::from_value::<ChannelJoinPayload>(event.payload) {
                // Throttle typing events (3 second cooldown per user/channel).
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
        // TODO: voice, DM, thread, reaction events
        _ => {
            tracing::debug!(event_type = event.event_type, "unhandled event type");
        }
    }
}

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

    let evt = Event::new(EVENT_PONG, &response); // Reuse pong type for responses.
    // Actually use "response" event type.
    let evt = Event {
        event_type: "response".to_string(),
        payload: serde_json::to_value(&response).unwrap_or_default(),
    };
    if let Ok(data) = serde_json::to_vec(&evt) {
        hub.send_to_user(user_id, data).await;
    }
}
