use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;

/// Run a blocking database closure via `spawn_blocking`, flattening the join error.
async fn ws_spawn_db<F>(db: db::Database, f: F) -> Result<serde_json::Value, rusqlite::Error>
where
    F: FnOnce(&rusqlite::Connection) -> Result<serde_json::Value, rusqlite::Error> + Send + 'static,
{
    tokio::task::spawn_blocking(move || db.with_conn(f))
        .await
        .unwrap()
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
            ws_spawn_db(db2, move |conn| {
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
            .await
        }
        ACTION_MESSAGE_LIST => {
            let channel_id = payload_str(&req.payload, "channel_id");
            let (before, limit) = payload_pagination(&req.payload);

            ws_spawn_db(db, move |conn| {
                let messages = db::get_messages_by_channel(conn, &channel_id, &before, limit)?;
                // Enrich each message with the author's username
                let enriched: Vec<serde_json::Value> = messages
                    .into_iter()
                    .map(|msg| {
                        let username = db::get_user_by_id(conn, &msg.author_id)
                            .ok()
                            .flatten()
                            .map(|u| u.username)
                            .unwrap_or_default();
                        let mut val = serde_json::to_value(&msg).unwrap();
                        val.as_object_mut().unwrap().insert("username".to_string(), serde_json::json!(username));
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
                let threads = db::get_channel_threads(conn, &channel_id)?;
                Ok(serde_json::to_value(threads).unwrap())
            })
            .await
        }
        ACTION_THREAD_MESSAGES => {
            let thread_id = payload_str(&req.payload, "thread_id");
            let (before, limit) = payload_pagination(&req.payload);

            ws_spawn_db(db, move |conn| {
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
