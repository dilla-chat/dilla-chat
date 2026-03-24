use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocal;

use super::signaling::{PeerState, SFUEvent};

/// Create a new offer for an existing peer and emit a Renegotiate event.
pub(crate) async fn renegotiate_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    channel_id: &str,
    user_id: &str,
) -> Result<(), String> {
    let pc = {
        let rooms_guard = rooms.read().await;
        let ps = rooms_guard
            .get(channel_id)
            .and_then(|room| room.get(user_id))
            .ok_or_else(|| {
                format!(
                    "no peer connection for user {} in channel {}",
                    user_id, channel_id
                )
            })?;
        Arc::clone(&ps.pc)
    };

    let offer = pc
        .create_offer(None)
        .await
        .map_err(|e| format!("create offer: {e}"))?;

    pc.set_local_description(offer.clone())
        .await
        .map_err(|e| format!("set local description: {e}"))?;

    let handler = on_event.read().await;
    if let Some(ref f) = *handler {
        f(
            channel_id.to_string(),
            SFUEvent::Renegotiate {
                channel_id: channel_id.to_string(),
                user_id: user_id.to_string(),
                offer,
            },
        );
    }

    Ok(())
}

pub(crate) async fn renegotiate_all_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    channel_id: &str,
) {
    let user_ids: Vec<String> = {
        let rooms_guard = rooms.read().await;
        match rooms_guard.get(channel_id) {
            Some(room) => room.keys().cloned().collect(),
            None => return,
        }
    };

    for uid in user_ids {
        if let Err(e) = renegotiate_internal(rooms, on_event, channel_id, &uid).await {
            tracing::error!(
                "voice: renegotiate failed channel={} user={}: {}",
                channel_id,
                uid,
                e
            );
        }
    }
}

pub(crate) async fn renegotiate_all_except_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    channel_id: &str,
    exclude_user_id: &str,
) {
    let user_ids: Vec<String> = {
        let rooms_guard = rooms.read().await;
        match rooms_guard.get(channel_id) {
            Some(room) => room
                .keys()
                .filter(|uid| uid.as_str() != exclude_user_id)
                .cloned()
                .collect(),
            None => return,
        }
    };

    for uid in user_ids {
        if let Err(e) = renegotiate_internal(rooms, on_event, channel_id, &uid).await {
            tracing::error!(
                "voice: renegotiate failed channel={} user={}: {}",
                channel_id,
                uid,
                e
            );
        }
    }
}

pub(crate) async fn handle_leave_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    channel_id: &str,
    user_id: &str,
) {
    let is_empty = {
        let mut rooms_guard = rooms.write().await;
        let room = match rooms_guard.get_mut(channel_id) {
            Some(room) => room,
            None => return,
        };

        let ps = match room.remove(user_id) {
            Some(ps) => ps,
            None => return,
        };

        let _ = ps.pc.close().await;
        remove_peer_tracks_from_room(room, &ps).await;

        let empty = room.is_empty();
        if empty {
            rooms_guard.remove(channel_id);
        }
        empty
    };

    if !is_empty {
        renegotiate_all_internal(rooms, on_event, channel_id).await;
    }
}

/// Remove all tracks belonging to a departing peer from all remaining peers in a room.
pub(crate) async fn remove_peer_tracks_from_room(room: &HashMap<String, PeerState>, ps: &PeerState) {
    let local_track_id = ps.local_track.id().to_string();
    let screen_track_id = ps.screen_track.as_ref().map(|t| t.id().to_string());
    let webcam_track_id = ps.webcam_track.as_ref().map(|t| t.id().to_string());

    let track_ids = [
        Some(local_track_id),
        screen_track_id,
        webcam_track_id,
    ];

    for (_other_uid, other_ps) in room.iter() {
        let senders = other_ps.pc.get_senders().await;
        for sender in &senders {
            if let Some(track) = sender.track().await {
                let tid = track.id();
                if track_ids.iter().any(|id| id.as_deref() == Some(tid)) {
                    if let Err(e) = other_ps.pc.remove_track(sender).await {
                        tracing::error!("voice: failed to remove track on leave: {}", e);
                    }
                }
            }
        }
    }
}

/// Add all existing tracks from an existing peer to a new peer connection.
pub(crate) async fn add_existing_tracks_to_new_peer(
    pc: &Arc<RTCPeerConnection>,
    other_ps: &PeerState,
    other_uid: &str,
) {
    add_track_to_peer(pc, &other_ps.local_track, "audio", other_uid).await;

    if let Some(ref st) = other_ps.screen_track {
        add_track_to_peer(pc, st, "screen", other_uid).await;
    }
    if let Some(ref wt) = other_ps.webcam_track {
        add_track_to_peer(pc, wt, "webcam", other_uid).await;
    }
}

/// Add a single track to a peer connection, logging errors.
pub(crate) async fn add_track_to_peer(
    pc: &Arc<RTCPeerConnection>,
    track: &Arc<TrackLocalStaticRTP>,
    kind: &str,
    other_uid: &str,
) {
    if let Err(e) = pc
        .add_track(Arc::clone(track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
    {
        tracing::error!("voice: failed to add {} track to peer: {} (other={})", kind, e, other_uid);
    }
}

/// Remove a track by ID from all other peers in a room.
pub(crate) async fn remove_track_from_other_peers(
    room: &HashMap<String, PeerState>,
    user_id: &str,
    track_id: &str,
    kind: &str,
) {
    for (other_uid, other_ps) in room.iter() {
        if other_uid == user_id {
            continue;
        }
        remove_track_from_peer(other_ps, other_uid, track_id, kind).await;
    }
}

pub(crate) async fn remove_track_from_peer(
    peer: &PeerState,
    peer_uid: &str,
    track_id: &str,
    kind: &str,
) {
    let senders = peer.pc.get_senders().await;
    for sender in &senders {
        let Some(track) = sender.track().await else { continue };
        if track.id() != track_id { continue; }
        if let Err(e) = peer.pc.remove_track(sender).await {
            tracing::error!("voice: failed to remove {} track from peer: {} (other={})", kind, e, peer_uid);
        }
        break;
    }
}
