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
