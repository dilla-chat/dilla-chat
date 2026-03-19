use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;

pub(in crate::ws) async fn handle_message_send(
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

    hub.emit_event(crate::ws::hub::HubEvent::MessageSent {
        message: msg,
        team_id: team_id.to_string(),
    });
}

pub(in crate::ws) async fn handle_message_edit(hub: &Hub, user_id: &str, payload: serde_json::Value) {
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

    hub.emit_event(crate::ws::hub::HubEvent::MessageEdited {
        message_id: p.message_id.clone(),
        channel_id: p.channel_id.clone(),
        content: p.content.clone(),
    });
}

pub(in crate::ws) async fn handle_message_delete(hub: &Hub, user_id: &str, payload: serde_json::Value) {
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

    hub.emit_event(crate::ws::hub::HubEvent::MessageDeleted {
        message_id: p.message_id.clone(),
        channel_id: p.channel_id.clone(),
    });
}

pub(in crate::ws) async fn handle_typing(
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
