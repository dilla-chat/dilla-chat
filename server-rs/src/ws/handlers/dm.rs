use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;

/// Verify that `user_id` is a member of the given DM channel.
/// Returns `true` if the user is a member, `false` otherwise.
async fn verify_dm_membership(hub: &Hub, dm_channel_id: &str, user_id: &str) -> bool {
    let db = hub.db.clone();
    let dm_id = dm_channel_id.to_string();
    let uid = user_id.to_string();
    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::is_dm_member(conn, &dm_id, &uid))
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false)
}

/// Run a blocking database closure via `spawn_blocking`, flattening the join error.
async fn dm_spawn_db<F, T>(hub: &Hub, f: F) -> Result<T, rusqlite::Error>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, rusqlite::Error> + Send + 'static,
    T: Send + 'static,
{
    let db = hub.db.clone();
    tokio::task::spawn_blocking(move || db.with_conn(f))
        .await
        .unwrap()
}

/// Send an event to all members of a DM channel.
async fn broadcast_to_dm_members(hub: &Hub, members: &[db::DMMember], data: Vec<u8>) {
    for member in members {
        hub.send_to_user(&member.user_id, data.clone()).await;
    }
}

/// Log a DM access denial warning.
fn log_dm_denied(user_id: &str, dm_channel_id: &str, action: &str) {
    tracing::warn!(
        user_id = user_id,
        dm_channel_id = %dm_channel_id,
        "{} denied — user is not a member of this DM channel",
        action
    );
}

pub(in crate::ws) async fn handle_dm_message_send(
    hub: &Hub,
    user_id: &str,
    username: &str,
    p: DMMessageSendPayload,
) {
    if !verify_dm_membership(hub, &p.dm_channel_id, user_id).await {
        log_dm_denied(user_id, &p.dm_channel_id, "dm:message:send");
        return;
    }

    let dm_id = p.dm_channel_id.clone();
    let uid = user_id.to_string();
    let content = p.content.clone();
    let msg_type = if p.msg_type.is_empty() {
        "text".to_string()
    } else {
        p.msg_type.clone()
    };

    let result = dm_spawn_db(hub, move |conn| {
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
    .await;

    match result {
        Ok((msg, members)) => {
            let dm_cid = p.dm_channel_id.clone();
            let evt = Event::new(
                EVENT_DM_MESSAGE_NEW,
                DMMessageNewPayload {
                    id: msg.id,
                    dm_channel_id: dm_cid,
                    author_id: msg.author_id.clone(),
                    username: username.to_string(),
                    content: msg.content,
                    msg_type: msg.msg_type,
                    created_at: msg.created_at,
                },
            );
            if let Ok(evt) = evt {
                if let Ok(data) = evt.to_bytes() {
                    broadcast_to_dm_members(hub, &members, data).await;
                }
            }
        }
        Err(e) => {
            tracing::error!("dm:message:send failed: {}", e);
        }
    }
}

pub(in crate::ws) async fn handle_dm_message_edit(hub: &Hub, user_id: &str, p: DMMessageEditPayload) {
    if !verify_dm_membership(hub, &p.dm_channel_id, user_id).await {
        log_dm_denied(user_id, &p.dm_channel_id, "dm:message:edit");
        return;
    }

    let mid = p.message_id.clone();
    let content = p.content.clone();
    let uid = user_id.to_string();
    let dm_id = p.dm_channel_id.clone();

    let result = dm_spawn_db(hub, move |conn| {
        let msg = db::get_message_by_id(conn, &mid)?;
        match msg {
            Some(m) if m.author_id == uid => {}
            _ => return Err(rusqlite::Error::QueryReturnedNoRows),
        };
        db::update_message_content(conn, &mid, &content)?;
        let members = db::get_dm_members(conn, &dm_id)?;
        Ok(members)
    })
    .await;

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
                broadcast_to_dm_members(hub, &members, data).await;
            }
        }
    }
}

pub(in crate::ws) async fn handle_dm_message_delete(hub: &Hub, user_id: &str, p: DMMessageDeletePayload) {
    if !verify_dm_membership(hub, &p.dm_channel_id, user_id).await {
        log_dm_denied(user_id, &p.dm_channel_id, "dm:message:delete");
        return;
    }

    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let dm_id = p.dm_channel_id.clone();

    let result = dm_spawn_db(hub, move |conn| {
        let msg = db::get_message_by_id(conn, &mid)?;
        match msg {
            Some(m) if m.author_id == uid => {}
            _ => return Err(rusqlite::Error::QueryReturnedNoRows),
        };
        db::soft_delete_message(conn, &mid)?;
        let members = db::get_dm_members(conn, &dm_id)?;
        Ok(members)
    })
    .await;

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
                broadcast_to_dm_members(hub, &members, data).await;
            }
        }
    }
}
