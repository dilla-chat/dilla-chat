use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;

pub(in crate::ws) async fn handle_thread_message_send(hub: &Hub, user_id: &str, p: ThreadMessageSendPayload) {
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

pub(in crate::ws) async fn handle_thread_message_edit(hub: &Hub, user_id: &str, p: ThreadMessageEditPayload) {
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

pub(in crate::ws) async fn handle_thread_message_remove(hub: &Hub, user_id: &str, p: ThreadMessageRemovePayload) {
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
