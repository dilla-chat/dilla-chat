use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;
use serde_json::Value;

pub(in crate::ws) async fn handle_channel_mark_read(
    hub: &Hub,
    user_id: &str,
    team_id: &str,
    payload: Value,
) {
    let p: ChannelMarkReadPayload = match serde_json::from_value(payload) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "failed to parse channel:mark-read payload");
            return;
        }
    };

    let db = hub.db.clone();
    let uid = user_id.to_string();
    let tid = team_id.to_string();
    let cid = p.channel_id.clone();
    let mid = p.message_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            // Verify channel belongs to the user's team
            let channel = db::get_channel_by_id(conn, &cid)?;
            match channel {
                Some(ch) if ch.team_id == tid => {}
                _ => return Ok(false),
            }
            db::mark_channel_read(conn, &uid, &cid, &mid)?;
            Ok(true)
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false);

    if !result {
        tracing::warn!(
            user_id = user_id,
            channel_id = %p.channel_id,
            "channel:mark-read denied — channel not found or wrong team"
        );
        return;
    }

    // Broadcast channel:read event back to the user's other sessions
    let evt = Event::new(
        EVENT_CHANNEL_READ,
        serde_json::json!({
            "channel_id": p.channel_id,
            "message_id": p.message_id,
            "user_id": user_id,
        }),
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.send_to_user(user_id, data).await;
        }
    }
}
