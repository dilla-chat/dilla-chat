use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;

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
        ACTION_THREAD_LIST => {
            let channel_id = req
                .payload
                .get("channel_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            tokio::task::spawn_blocking(move || {
                db.with_conn(|conn| {
                    let threads = db::get_channel_threads(conn, &channel_id)?;
                    Ok(serde_json::to_value(threads).unwrap())
                })
            })
            .await
            .unwrap()
        }
        ACTION_THREAD_MESSAGES => {
            let thread_id = req
                .payload
                .get("thread_id")
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
                    let messages = db::get_thread_messages(conn, &thread_id, &before, limit)?;
                    Ok(serde_json::to_value(messages).unwrap())
                })
            })
            .await
            .unwrap()
        }
        ACTION_DM_LIST => {
            let db2 = db.clone();
            let tid2 = tid.clone();
            let uid2 = uid.clone();
            tokio::task::spawn_blocking(move || {
                db2.with_conn(|conn| {
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
            })
            .await
            .unwrap()
        }
        ACTION_DM_MESSAGES => {
            let dm_id = req
                .payload
                .get("dm_id")
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
                    let messages = db::get_dm_messages(conn, &dm_id, &before, limit)?;
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

    let evt = Event {
        event_type: "response".to_string(),
        payload: serde_json::to_value(&response).unwrap_or_default(),
    };
    if let Ok(data) = serde_json::to_vec(&evt) {
        hub.send_to_user(user_id, data).await;
    }
}
