mod dm;
mod message;
mod reaction;
mod read;
mod request;
mod thread;
mod voice;

pub(in crate::ws) use dm::*;
pub(in crate::ws) use message::*;
pub(in crate::ws) use reaction::*;
pub(in crate::ws) use read::*;
pub(in crate::ws) use request::*;
pub(in crate::ws) use thread::*;
pub(in crate::ws) use voice::*;

use crate::db;

/// Synchronously verify that a channel belongs to the given team (for use
/// inside `spawn_blocking` closures).
pub(in crate::ws) fn channel_belongs_to_team(conn: &rusqlite::Connection, channel_id: &str, team_id: &str) -> bool {
    db::get_channel_by_id(conn, channel_id)
        .ok()
        .flatten()
        .map_or(false, |ch| ch.team_id == team_id)
}

/// Verify that a channel belongs to the given team.
///
/// Returns `true` when the channel exists and its `team_id` matches, `false`
/// otherwise (including on DB errors).
pub(in crate::ws) async fn verify_channel_team(database: &db::Database, channel_id: &str, team_id: &str) -> bool {
    let db = database.clone();
    let cid = channel_id.to_string();
    let tid = team_id.to_string();
    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let channel = db::get_channel_by_id(conn, &cid)?;
            Ok(channel.map_or(false, |ch| ch.team_id == tid))
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false)
}

/// Verify that a thread's parent channel belongs to the given team.
///
/// Looks up the thread, then checks that its parent channel's `team_id`
/// matches.  Returns `false` when the thread or channel does not exist, or
/// on DB errors.
pub(in crate::ws) async fn verify_thread_channel_team(database: &db::Database, thread_id: &str, team_id: &str) -> bool {
    let db = database.clone();
    let thid = thread_id.to_string();
    let tid = team_id.to_string();
    tokio::task::spawn_blocking(move || {
        db.with_conn(|conn| {
            let thread = db::get_thread(conn, &thid)?;
            match thread {
                Some(t) => {
                    let channel = db::get_channel_by_id(conn, &t.channel_id)?;
                    Ok(channel.map_or(false, |ch| ch.team_id == tid))
                }
                None => Ok(false),
            }
        })
    })
    .await
    .unwrap_or(Ok(false))
    .unwrap_or(false)
}
