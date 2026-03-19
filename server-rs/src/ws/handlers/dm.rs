use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;

pub(in crate::ws) async fn handle_dm_message_send(
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

pub(in crate::ws) async fn handle_dm_message_edit(hub: &Hub, user_id: &str, p: DMMessageEditPayload) {
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

pub(in crate::ws) async fn handle_dm_message_delete(hub: &Hub, user_id: &str, p: DMMessageDeletePayload) {
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
