use crate::db;
use crate::ws::events::*;
use crate::ws::hub::Hub;
use super::verify_channel_team;

pub(in crate::ws) async fn handle_reaction_add(hub: &Hub, user_id: &str, team_id: &str, p: ReactionPayload) {
    // Verify the channel (from message) belongs to the user's team.
    if !verify_channel_team(&hub.db, &p.channel_id, team_id).await {
        tracing::warn!(user_id = user_id, channel_id = %p.channel_id, "reaction:add denied — channel does not belong to user's team");
        return;
    }

    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let emoji = p.emoji.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::add_reaction(conn, &mid, &uid, &emoji))
    })
    .await
    .unwrap();

    if let Err(e) = result {
        tracing::error!("reaction:add failed: {}", e);
        return;
    }

    let evt = Event::new(
        EVENT_REACTION_ADDED,
        ReactionEventPayload {
            message_id: p.message_id,
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            emoji: p.emoji,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }
}

pub(in crate::ws) async fn handle_reaction_remove(hub: &Hub, user_id: &str, team_id: &str, p: ReactionPayload) {
    // Verify the channel (from message) belongs to the user's team.
    if !verify_channel_team(&hub.db, &p.channel_id, team_id).await {
        tracing::warn!(user_id = user_id, channel_id = %p.channel_id, "reaction:remove denied — channel does not belong to user's team");
        return;
    }

    let db = hub.db.clone();
    let mid = p.message_id.clone();
    let uid = user_id.to_string();
    let emoji = p.emoji.clone();

    let result = tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| db::remove_reaction(conn, &mid, &uid, &emoji))
    })
    .await
    .unwrap();

    if let Err(e) = result {
        tracing::error!("reaction:remove failed: {}", e);
        return;
    }

    let evt = Event::new(
        EVENT_REACTION_REMOVED,
        ReactionEventPayload {
            message_id: p.message_id,
            channel_id: p.channel_id.clone(),
            user_id: user_id.to_string(),
            emoji: p.emoji,
        },
    );
    if let Ok(evt) = evt {
        if let Ok(data) = evt.to_bytes() {
            hub.broadcast_to_channel(&p.channel_id, data, None).await;
        }
    }
}
