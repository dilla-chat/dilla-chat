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

    // Verify the channel belongs to the user's team AND the user's roles
    // intersect the channel's access list. user_can_access_channel covers
    // both: it short-circuits on team-owner, returns true when the channel
    // grants the everyone role, and otherwise checks per-role membership.
    let db = hub.db.clone();
    let cid = p.channel_id.clone();
    let tid = team_id.to_string();
    let uid = user_id.to_string();
    let channel_ok = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let channel = db::get_channel_by_id(conn, &cid)?;
            let belongs = matches!(channel, Some(ref ch) if ch.team_id == tid);
            if !belongs {
                return Ok::<bool, rusqlite::Error>(false);
            }
            db::user_can_access_channel(conn, &uid, &tid, &cid)
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
            "message:send denied — access denied for channel"
        );
        return;
    }

    // Slow-mode gate: when channel.slow_mode_seconds > 0, look up the
    // user's most recent message in this channel and reject if the delta
    // is shorter than the configured minimum. Users in a role with
    // PERM_BYPASS_SLOW_MODE (Admin gets it implicitly via PERM_ADMIN)
    // skip the check entirely; the default "everyone" role is rate-
    // limited by absence of that perm.
    let db_sm = hub.db.clone();
    let cid_sm = p.channel_id.clone();
    let uid_sm = user_id.to_string();
    let tid_sm = team_id.to_string();
    let slow_mode_block: Option<i64> = tokio::task::spawn_blocking(move || -> Option<i64> {
        db_sm.with_read(|conn| {
            let secs: i32 = conn
                .query_row(
                    "SELECT slow_mode_seconds FROM channels WHERE id = ?1",
                    rusqlite::params![cid_sm],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            if secs <= 0 { return Ok::<_, rusqlite::Error>(None); }
            // Bypass-permission shortcut.
            let bypass = db::user_has_permission(conn, &uid_sm, &tid_sm, db::PERM_BYPASS_SLOW_MODE)
                .unwrap_or(false);
            if bypass { return Ok::<_, rusqlite::Error>(None); }
            // strftime('%s', ...) gives unix seconds for the stored UTC text.
            let last_ts: Option<i64> = conn
                .query_row(
                    "SELECT strftime('%s', created_at) FROM messages
                     WHERE channel_id = ?1 AND author_id = ?2 AND deleted = 0
                     ORDER BY created_at DESC LIMIT 1",
                    rusqlite::params![cid_sm, uid_sm],
                    |row| row.get::<_, Option<String>>(0).map(|s| s.and_then(|x| x.parse::<i64>().ok())),
                )
                .unwrap_or(None);
            let now_ts: i64 = conn
                .query_row("SELECT strftime('%s','now')", [], |row| {
                    row.get::<_, String>(0).map(|s| s.parse::<i64>().unwrap_or(0))
                })
                .unwrap_or(0);
            if let Some(last) = last_ts {
                let delta = now_ts - last;
                let remaining = secs as i64 - delta;
                if remaining > 0 { return Ok::<_, rusqlite::Error>(Some(remaining)); }
            }
            Ok::<_, rusqlite::Error>(None)
        })
        .unwrap_or(None)
    })
    .await
    .unwrap_or(None);

    if let Some(remaining) = slow_mode_block {
        tracing::info!(user_id, channel_id = %p.channel_id, "message:send denied — slow mode active");
        if let Ok(evt) = Event::new(
            "message:rejected",
            serde_json::json!({
                "channel_id": p.channel_id,
                "reason": "slow_mode",
                "retry_in": remaining,
            }),
        ) {
            if let Ok(bytes) = evt.to_bytes() {
                hub.send_to_user(user_id, bytes).await;
            }
        }
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
        thread_id: p.thread_id.clone().unwrap_or_default(),
        edited_at: None,
        deleted: false,
        lamport_ts: 0,
        reply_to_message_id: p.reply_to_message_id.clone(),
        created_at: now.clone(),
    };

    let db = hub.db.clone();
    let msg_clone = msg.clone();
    let attachment_ids = p.attachment_ids.clone();
    let mid_for_attach = msg_id.clone();
    if let Err(e) =
        tokio::task::spawn_blocking(move || {
            db.with_conn(|conn| {
                db::create_message(conn, &msg_clone)?;
                // Link uploaded attachments to this message
                for att_id in &attachment_ids {
                    conn.execute(
                        "UPDATE attachments SET message_id = ?1 WHERE id = ?2",
                        rusqlite::params![mid_for_attach, att_id],
                    )?;
                }
                Ok::<(), rusqlite::Error>(())
            })
        })
            .await
            .unwrap()
    {
        tracing::error!("failed to create message: {}", e);
        return;
    }

    // Fetch linked attachments for the broadcast payload
    let db = hub.db.clone();
    let mid_for_query = msg_id.clone();
    let attachments = tokio::task::spawn_blocking(move || {
        db.with_read(|conn| db::get_message_attachments(conn, &mid_for_query))
    })
    .await
    .unwrap_or(Ok(vec![]))
    .unwrap_or_default();

    let attachment_payloads: Vec<AttachmentPayload> = attachments
        .iter()
        .map(|a| AttachmentPayload {
            id: a.id.clone(),
            filename: String::from_utf8_lossy(&a.filename_encrypted).to_string(),
            content_type: String::from_utf8_lossy(&a.content_type_encrypted).to_string(),
            size: a.size,
            url: format!("/api/v1/teams/{}/attachments/{}", team_id, a.id),
        })
        .collect();

    let new_event = Event::new(
        EVENT_MESSAGE_NEW,
        MessageNewPayload {
            id: msg_id,
            channel_id: p.channel_id.clone(),
            author_id: user_id.to_string(),
            username: username.to_string(),
            content: p.content,
            msg_type,
            thread_id: p.thread_id.unwrap_or_default(),
            reply_to_message_id: p.reply_to_message_id.clone(),
            created_at: now,
            attachments: attachment_payloads,
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
                    // Skip the audit row on a no-op same-content edit
                    // to keep the audit log clean. H5 / MSG-AUDIT-1.
                    let is_noop = msg.content == content;
                    db::update_message_content(conn, &mid, &content)?;
                    if !is_noop {
                        // Resolve team via channel to populate the audit
                        // row. DM-channel edits skip the audit log —
                        // dm_channels has its own audit story.
                        if let Ok(Some(channel)) = db::get_channel_by_id(conn, &msg.channel_id) {
                            let details = serde_json::json!({
                                "channel_id": msg.channel_id,
                                "edited_at": db::now_str(),
                            });
                            let _ = db::insert_audit_event(
                                conn,
                                &channel.team_id,
                                Some(&uid),
                                "message.edit",
                                Some("message"),
                                Some(&mid),
                                Some(&details),
                            );
                        }
                    }
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
                // Idempotence — don't double-log a soft-delete. H5 /
                // MSG-AUDIT-1.
                if msg.deleted {
                    return Ok(false);
                }
                if msg.author_id == uid {
                    db::soft_delete_message(conn, &mid)?;
                    if let Ok(Some(channel)) = db::get_channel_by_id(conn, &msg.channel_id) {
                        let details = serde_json::json!({
                            "channel_id": msg.channel_id,
                            "deleted_at": db::now_str(),
                        });
                        let _ = db::insert_audit_event(
                            conn,
                            &channel.team_id,
                            Some(&uid),
                            "message.delete",
                            Some("message"),
                            Some(&mid),
                            Some(&details),
                        );
                    }
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
    team_id: &str,
    payload: serde_json::Value,
) {
    let p: ChannelJoinPayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(_) => return,
    };

    // Same authorization gate as channel:join. Without this, an attacker
    // with a valid JWT could spray typing indicators into private
    // channels they can't read, leaking who-is-watching-what.
    if !crate::ws::client::user_can_subscribe_to_channel(hub, user_id, team_id, &p.channel_id)
        .await
    {
        tracing::debug!(
            user_id = user_id,
            channel_id = %p.channel_id,
            "typing event denied — access check failed"
        );
        return;
    }

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
