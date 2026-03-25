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
            handle_channel_event(hub, client_id, &event.event_type, event.payload).await;
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
            handle_reaction_event(hub, user_id, &event.event_type, event.payload).await;
        }
        EVENT_THREAD_MESSAGE_SEND | EVENT_THREAD_MESSAGE_EDIT | EVENT_THREAD_MESSAGE_REMOVE => {
            handle_thread_event(hub, user_id, &event.event_type, event.payload).await;
        }
        EVENT_VOICE_JOIN | EVENT_VOICE_LEAVE | EVENT_VOICE_ANSWER
        | EVENT_VOICE_ICE_CANDIDATE | EVENT_VOICE_MUTE | EVENT_VOICE_DEAFEN
        | EVENT_VOICE_SCREEN_START | EVENT_VOICE_SCREEN_STOP
        | EVENT_VOICE_WEBCAM_START | EVENT_VOICE_WEBCAM_STOP
        | EVENT_VOICE_KEY_DISTRIBUTE => {
            handle_voice_event(hub, client_id, user_id, username, team_id, &event.event_type, event.payload).await;
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

pub(crate) async fn handle_channel_event(hub: &Hub, client_id: &str, event_type: &str, payload: serde_json::Value) {
    match serde_json::from_value::<ChannelJoinPayload>(payload) {
        Ok(p) => {
            if event_type == EVENT_CHANNEL_JOIN {
                hub.subscribe(client_id, &p.channel_id).await;
            } else {
                hub.unsubscribe(client_id, &p.channel_id).await;
            }
        }
        Err(e) => tracing::warn!(error = %e, event = event_type, "failed to parse payload"),
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

pub(crate) async fn handle_reaction_event(hub: &Hub, user_id: &str, event_type: &str, payload: serde_json::Value) {
    if let Ok(p) = serde_json::from_value::<ReactionPayload>(payload) {
        if event_type == EVENT_REACTION_ADD {
            handle_reaction_add(hub, user_id, p).await;
        } else {
            handle_reaction_remove(hub, user_id, p).await;
        }
    }
}

pub(crate) async fn handle_thread_event(hub: &Hub, user_id: &str, event_type: &str, payload: serde_json::Value) {
    match event_type {
        EVENT_THREAD_MESSAGE_SEND => {
            if let Ok(p) = serde_json::from_value::<ThreadMessageSendPayload>(payload) {
                handle_thread_message_send(hub, user_id, p).await;
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
        EVENT_VOICE_SCREEN_START | EVENT_VOICE_SCREEN_STOP |
        EVENT_VOICE_WEBCAM_START | EVENT_VOICE_WEBCAM_STOP => {
            handle_voice_media(hub, user_id, event_type, payload).await;
        }
        EVENT_VOICE_KEY_DISTRIBUTE => {
            handle_voice_key_distribute(hub, client_id, user_id, payload).await;
        }
        _ => {}
    }
}

pub(crate) async fn handle_voice_join_leave(
    hub: &Hub, client_id: &str, user_id: &str, username: &str, team_id: &str,
    event_type: &str, payload: serde_json::Value,
) {
    if let Ok(p) = serde_json::from_value::<VoiceJoinPayload>(payload) {
        if event_type == EVENT_VOICE_JOIN {
            handle_voice_join(hub, client_id, user_id, username, team_id, p).await;
        } else {
            handle_voice_leave(hub, client_id, user_id, p).await;
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
    if let Ok(mut p) = serde_json::from_value::<VoiceKeyDistributePayload>(payload) {
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
