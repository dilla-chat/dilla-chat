use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;
use super::channel_belongs_to_team;

/// Run a blocking database closure via `spawn_blocking`, flattening the join error.
async fn ws_spawn_db<F>(db: db::Database, f: F) -> Result<serde_json::Value, rusqlite::Error>
where
    F: FnOnce(&rusqlite::Connection) -> Result<serde_json::Value, rusqlite::Error> + Send + 'static,
{
    tokio::task::spawn_blocking(move || db.with_conn(f))
        .await
        .unwrap()
}

/// Look up a user's display name by their ID.
fn lookup_username(conn: &rusqlite::Connection, author_id: &str) -> String {
    db::get_user_by_id(conn, author_id)
        .ok()
        .flatten()
        .map_or_else(String::new, |u| u.username)
}

/// Extract a string field from a JSON payload, defaulting to "".
fn payload_str(payload: &serde_json::Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract pagination parameters (before cursor + limit) from a JSON payload.
fn payload_pagination(payload: &serde_json::Value) -> (String, i32) {
    let before = payload_str(payload, "before");
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(50) as i32;
    (before, limit)
}

pub(in crate::ws) async fn handle_request(hub: &Hub, user_id: &str, team_id: &str, req: RequestEvent) {
    let db = hub.db.clone();
    let uid = user_id.to_string();
    let tid = team_id.to_string();
    let req_id = req.id.clone();
    let action = req.action.clone();

    let result = match action.as_str() {
        ACTION_SYNC_INIT => {
            let db2 = db.clone();
            let tid2 = tid.clone();
            let uid2 = uid.clone();
            let mut result = ws_spawn_db(db2, move |conn| {
                let channels_raw = db::get_channels_by_team(conn, &tid2)?;
                // Enrich each channel with its role-access list, and drop
                // channels that are marked hidden_if_restricted when the
                // current user can't access them — they should never see
                // the channel exists.
                let channels: Vec<serde_json::Value> = channels_raw
                    .iter()
                    .filter_map(|ch| {
                        let access = db::get_channel_access_roles(conn, &ch.id).unwrap_or_default();
                        if ch.hidden_if_restricted {
                            let allowed = db::user_can_access_channel(conn, &uid2, &tid2, &ch.id).unwrap_or(false);
                            if !allowed {
                                return None;
                            }
                        }
                        let mut v = serde_json::to_value(ch).unwrap_or_else(|_| serde_json::Value::Null);
                        if let serde_json::Value::Object(ref mut m) = v {
                            m.insert("access_role_ids".to_string(), serde_json::json!(access));
                        }
                        Some(v)
                    })
                    .collect();
                let members = db::get_members_by_team(conn, &tid2)?;
                let roles = db::get_roles_by_team(conn, &tid2)?;
                let team = db::get_team(conn, &tid2)?;
                let unread_pairs = db::get_unread_counts_for_team(conn, &uid2, &tid2)?;
                let unread_counts: serde_json::Map<String, serde_json::Value> = unread_pairs
                    .into_iter()
                    .map(|(cid, count)| (cid, serde_json::json!(count)))
                    .collect();
                let members_json: Vec<serde_json::Value> = members
                    .iter()
                    .map(|(m, u)| {
                        let role_ids: Vec<String> = db::get_member_roles(conn, &m.id)
                            .unwrap_or_default()
                            .into_iter()
                            .map(|r| r.id)
                            .collect();
                        serde_json::json!({
                            "member": m,
                            "user": u,
                            "role_ids": role_ids,
                        })
                    })
                    .collect();
                Ok(serde_json::json!({
                    "team": team,
                    "channels": channels,
                    "members": members_json,
                    "roles": roles,
                    "unread_counts": unread_counts,
                    "muted_channels": db::get_muted_channels(conn, &uid2)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(cid, until)| serde_json::json!({ "channel_id": cid, "muted_until": until }))
                        .collect::<Vec<_>>(),
                }))
            })
            .await;

            // Enrich with current voice rooms for the team so a fresh
            // client (login, reload, or page navigation) sees who's
            // already active in voice channels. Without this, the
            // sidebar shows empty voice rooms until someone joins/
            // leaves and a delta event fires.
            if let (Ok(ref mut value), Some(room_mgr)) =
                (&mut result, hub.voice_room_manager.as_ref())
            {
                let rooms = room_mgr.get_rooms_by_team(&tid).await;
                let mut by_channel = serde_json::Map::new();
                for r in rooms {
                    by_channel.insert(r.channel_id.clone(), serde_json::json!(r.peers));
                }
                if let Some(obj) = value.as_object_mut() {
                    // Client field name is `voice_states` — see
                    // applySyncData in useTeamSync.ts.
                    obj.insert("voice_states".to_string(), serde_json::Value::Object(by_channel));
                }
            }

            result
        }
        ACTION_MESSAGE_LIST => {
            let channel_id = payload_str(&req.payload, "channel_id");
            let (before, limit) = payload_pagination(&req.payload);

            ws_spawn_db(db, move |conn| {
                if !channel_belongs_to_team(conn, &channel_id, &tid) {
                    return Ok(serde_json::json!([]));
                }
                let messages = db::get_messages_by_channel(conn, &channel_id, &before, limit)?;
                // Enrich each message with the author's username and attachments
                let enriched: Vec<serde_json::Value> = messages
                    .into_iter()
                    .map(|msg| {
                        let name = lookup_username(conn, &msg.author_id);
                        let attachments = db::get_message_attachments(conn, &msg.id)
                            .unwrap_or_default();
                        let attachment_payloads: Vec<serde_json::Value> = attachments
                            .iter()
                            .map(|a| serde_json::json!({
                                "id": a.id,
                                "filename": String::from_utf8_lossy(&a.filename_encrypted),
                                "content_type": String::from_utf8_lossy(&a.content_type_encrypted),
                                "size": a.size,
                                "url": format!("/api/v1/teams/{}/attachments/{}", tid, a.id),
                            }))
                            .collect();
                        let mut val = serde_json::to_value(&msg).unwrap();
                        val.as_object_mut().unwrap().insert("username".to_string(), serde_json::json!(name));
                        val.as_object_mut().unwrap().insert("attachments".to_string(), serde_json::json!(attachment_payloads));
                        val
                    })
                    .collect();
                Ok(serde_json::json!(enriched))
            })
            .await
        }
        ACTION_THREAD_LIST => {
            let channel_id = payload_str(&req.payload, "channel_id");

            ws_spawn_db(db, move |conn| {
                if !channel_belongs_to_team(conn, &channel_id, &tid) {
                    return Ok(serde_json::json!([]));
                }
                let threads = db::get_channel_threads(conn, &channel_id)?;
                Ok(serde_json::to_value(threads).unwrap())
            })
            .await
        }
        ACTION_THREAD_MESSAGES => {
            let thread_id = payload_str(&req.payload, "thread_id");
            let (before, limit) = payload_pagination(&req.payload);

            ws_spawn_db(db, move |conn| {
                let thread = db::get_thread(conn, &thread_id)?;
                match thread {
                    Some(ref t) if channel_belongs_to_team(conn, &t.channel_id, &tid) => {}
                    _ => return Ok(serde_json::json!([])),
                }
                let messages = db::get_thread_messages(conn, &thread_id, &before, limit)?;
                Ok(serde_json::to_value(messages).unwrap())
            })
            .await
        }
        ACTION_DM_LIST => {
            let db2 = db.clone();
            let tid2 = tid.clone();
            let uid2 = uid.clone();
            ws_spawn_db(db2, move |conn| {
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
            .await
        }
        ACTION_DM_MESSAGES => {
            let dm_id = payload_str(&req.payload, "dm_id");
            let (before, limit) = payload_pagination(&req.payload);

            ws_spawn_db(db, move |conn| {
                if !db::is_dm_member(conn, &dm_id, &uid)? {
                    return Ok(serde_json::json!([]));
                }
                let messages = db::get_dm_messages(conn, &dm_id, &before, limit)?;
                Ok(serde_json::to_value(messages).unwrap())
            })
            .await
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
