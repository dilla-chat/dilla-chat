use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use webrtc::ice_transport::ice_candidate::RTCIceCandidate;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::track::track_remote::TrackRemote;

use super::signaling::{PeerState, SFUEvent, SfuEventCallback};

/// Send RTCP PictureLossIndication to all incoming video tracks on a peer
/// connection. Used when a new subscriber joins so the publisher resends a
/// keyframe immediately instead of waiting for the next periodic one.
#[cfg(not(tarpaulin_include))]
pub(crate) async fn request_video_keyframes(pc: &Arc<RTCPeerConnection>) {
    let receivers = pc.get_receivers().await;
    for receiver in &receivers {
        for track in receiver.tracks().await {
            if track.kind() != RTPCodecType::Video {
                continue;
            }
            let pli = PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: track.ssrc(),
            };
            let _ = pc.write_rtcp(&[Box::new(pli)]).await;
        }
    }
}

/// Nudge a SPECIFIC publisher (the user who just started a cam or
/// screen track) for a fresh keyframe so existing subscribers in
/// the room start decoding immediately. Without this, when peer A
/// starts a track that gets added to peer B mid-call, B receives
/// only P-frames after the last A-side keyframe — bytes pile up
/// but the decoder produces zero frames until the next periodic
/// keyframe arrives (multi-second wait, sometimes never if the
/// stream is steady).
#[cfg(not(tarpaulin_include))]
pub(crate) fn spawn_keyframe_burst_for_publisher(
    rooms: Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    channel_id: String,
    publisher_user_id: String,
) {
    tokio::spawn(async move {
        for delay_ms in [150u64, 500, 1200, 2500] {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let pc: Option<Arc<RTCPeerConnection>> = {
                let rooms_guard = rooms.read().await;
                rooms_guard
                    .get(&channel_id)
                    .and_then(|room| room.get(&publisher_user_id))
                    .map(|ps| Arc::clone(&ps.pc))
            };
            if let Some(pc) = pc {
                request_video_keyframes(&pc).await;
            }
        }
    });
}

/// Spawn a task that nudges existing video publishers in the room for fresh
/// keyframes after a new peer joins, so the new subscriber sees video without
/// the multi-second wait for the next periodic keyframe.
#[cfg(not(tarpaulin_include))]
pub(crate) fn spawn_keyframe_burst(
    rooms: Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    channel_id: String,
    joining_user_id: String,
) {
    tokio::spawn(async move {
        // Repeat a few times because the first PLI may arrive before the
        // joining peer's ICE/DTLS is fully established, and we want to cover
        // the window during which the subscriber is actually ready.
        for delay_ms in [150u64, 500, 1200, 2500] {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let pcs: Vec<Arc<RTCPeerConnection>> = {
                let rooms_guard = rooms.read().await;
                let Some(room) = rooms_guard.get(&channel_id) else {
                    return;
                };
                room.iter()
                    .filter(|(uid, _)| uid.as_str() != joining_user_id)
                    .map(|(_, ps)| Arc::clone(&ps.pc))
                    .collect()
            };
            for pc in pcs {
                request_video_keyframes(&pc).await;
            }
        }
    });
}

/// Create a new offer for an existing peer and emit a Renegotiate event.
pub(crate) async fn renegotiate_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &SfuEventCallback,
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

    let mline_summary: String = offer
        .sdp
        .lines()
        .filter(|l| {
            l.starts_with("m=")
                || l.starts_with("a=mid")
                || l.starts_with("a=sendrecv")
                || l.starts_with("a=sendonly")
                || l.starts_with("a=recvonly")
                || l.starts_with("a=inactive")
                || l.starts_with("a=msid")
        })
        .collect::<Vec<_>>()
        .join(" | ");
    tracing::info!(
        target: "voice_sdp",
        "renegotiate offer channel={} user={} sdp_mlines={}",
        channel_id,
        user_id,
        mline_summary
    );

    let handler = on_event.read().await;
    if let Some(ref f) = *handler {
        f(
            channel_id.to_string(),
            SFUEvent::Renegotiate {
                channel_id: channel_id.to_string(),
                user_id: user_id.to_string(),
                offer: Box::new(offer),
            },
        );
    }

    Ok(())
}

pub(crate) async fn renegotiate_all_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &SfuEventCallback,
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

    // Every renegotiation can stall existing subscribers' decoders —
    // when A toggles cam (while still sharing screen), B's screen
    // receiver gets a new SDP version but no fresh I-frame, so the
    // decoder shows `framesDecoded:0` until the next periodic
    // keyframe (multi-second wait, sometimes never). Burst PLIs at
    // EVERY active video publisher so all subscribers immediately
    // pick up a keyframe on every stream they're already receiving.
    let publishers: Vec<String> = {
        let rooms_guard = rooms.read().await;
        match rooms_guard.get(channel_id) {
            Some(room) => room
                .iter()
                .filter(|(_, ps)| ps.webcam_track.is_some() || ps.screen_track.is_some())
                .map(|(uid, _)| uid.clone())
                .collect(),
            None => return,
        }
    };
    for publisher_uid in publishers {
        spawn_keyframe_burst_for_publisher(
            Arc::clone(rooms),
            channel_id.to_string(),
            publisher_uid,
        );
    }
}

pub(crate) async fn renegotiate_all_except_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &SfuEventCallback,
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
    on_event: &SfuEventCallback,
    channel_id: &str,
    user_id: &str,
) {
    // Remove the peer from the rooms map and capture its state, then drop the
    // write lock BEFORE closing the PC. pc.close() awaits the
    // on_peer_connection_state_change handler, which acquires a read lock via
    // is_active_connection — holding the write lock here would deadlock.
    let (ps, is_empty) = {
        let mut rooms_guard = rooms.write().await;
        let room = match rooms_guard.get_mut(channel_id) {
            Some(room) => room,
            None => return,
        };

        let ps = match room.remove(user_id) {
            Some(ps) => ps,
            None => return,
        };

        let empty = room.is_empty();
        if empty {
            rooms_guard.remove(channel_id);
        }
        (ps, empty)
    };

    let _ = ps.pc.close().await;

    if !is_empty {
        let rooms_guard = rooms.read().await;
        if let Some(room) = rooms_guard.get(channel_id) {
            remove_peer_tracks_from_room(room, &ps).await;
        }
    }

    // Notify the WS bridge that this peer dropped — used by the
    // setup_connection_state_handler ICE-failed path so RoomManager
    // and other clients learn the user is no longer in the room.
    // (Explicit voice:leave goes through handle_voice_leave which
    // does its own broadcast; this is the autonomous-drop path.)
    {
        let handler = on_event.read().await;
        if let Some(ref f) = *handler {
            f(
                channel_id.to_string(),
                SFUEvent::PeerDropped {
                    channel_id: channel_id.to_string(),
                    user_id: user_id.to_string(),
                },
            );
        }
    }

    if !is_empty {
        renegotiate_all_internal(rooms, on_event, channel_id).await;
    }
}

/// Remove all tracks belonging to a departing peer from all remaining peers in a room.
pub(crate) async fn remove_peer_tracks_from_room(
    room: &HashMap<String, PeerState>,
    ps: &PeerState,
) {
    let local_track_id = ps.local_track.id().to_string();
    let screen_track_id = ps.screen_track.as_ref().map(|t| t.id().to_string());
    let webcam_track_id = ps.webcam_track.as_ref().map(|t| t.id().to_string());

    let track_ids = [Some(local_track_id), screen_track_id, webcam_track_id];

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
        tracing::error!(
            "voice: failed to add {} track to peer: {} (other={})",
            kind,
            e,
            other_uid
        );
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
    // We need to STOP the transceiver, not just remove its track. Pion's
    // `pc.remove_track(sender)` deactivates the sender but leaves the
    // transceiver alive in the SDP with the original msid still embedded —
    // and because `add_track` for the next round only reuses a slot when
    // `initial_track_id` matches (and our restart uses a fresh UUID), every
    // restart appends a NEW m-line while the old one lingers as a recvonly
    // ghost with stale msid. After a handful of cam toggles the SDP
    // contains 10+ orphan m-lines all keyed to `webcam-stream-X` /
    // `screen-stream-X`, which is what wedges Chrome's decoder on the
    // current m-line.
    //
    // Stopping the transceiver makes Pion emit `m=video 0` (port 0) for
    // that slot, which Chrome treats as permanently rejected — no msid,
    // no receiver allocated, no decoder confusion.
    let transceivers = peer.pc.get_transceivers().await;
    for tx in &transceivers {
        let sender = tx.sender().await;
        let Some(track) = sender.track().await else {
            continue;
        };
        if track.id() != track_id {
            continue;
        }
        if let Err(e) = tx.stop().await {
            tracing::error!(
                "voice: failed to stop {} transceiver on peer: {} (other={})",
                kind,
                e,
                peer_uid
            );
        }
        return;
    }
}

/// Set up the `on_track` handler on a peer connection to route incoming RTP.
#[cfg(not(tarpaulin_include))]
pub(crate) fn setup_on_track_handler(
    pc: &Arc<RTCPeerConnection>,
    rooms_ref: Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    channel_id: String,
    user_id: String,
) {
    pc.on_track(Box::new(move |remote_track, _receiver, _transceiver| {
        let rooms_ref = Arc::clone(&rooms_ref);
        let ch_id = channel_id.clone();
        let u_id = user_id.clone();

        Box::pin(async move {
            let track_id = remote_track.id();
            let codec_mime = remote_track.codec().capability.mime_type.clone();
            let kind = remote_track.kind();

            tracing::info!(
                "voice: track received channel={} user={} codec={} kind={:?} id={}",
                ch_id,
                u_id,
                codec_mime,
                kind,
                track_id
            );

            let target =
                match resolve_target_track(&rooms_ref, &ch_id, &u_id, &track_id, kind).await {
                    Some(t) => t,
                    None => {
                        tracing::warn!(
                            "voice: no local track for incoming track kind={:?} id={} user={}",
                            kind,
                            track_id,
                            u_id
                        );
                        return;
                    }
                };

            spawn_rtp_forwarder(remote_track, target, u_id);
        })
    }));
}

/// Resolve which local track should receive forwarded RTP for a given remote track.
#[cfg(not(tarpaulin_include))]
async fn resolve_target_track(
    rooms_ref: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    channel_id: &str,
    user_id: &str,
    track_id: &str,
    kind: RTPCodecType,
) -> Option<Arc<TrackLocalStaticRTP>> {
    let rooms = rooms_ref.read().await;
    let ps = rooms.get(channel_id).and_then(|room| room.get(user_id))?;

    if track_id.starts_with("webcam-") {
        return ps.webcam_track.clone();
    }
    if track_id.starts_with("screen-") {
        return ps.screen_track.clone();
    }
    if kind == RTPCodecType::Video {
        return ps
            .screen_track
            .clone()
            .or_else(|| ps.webcam_track.clone());
    }
    Some(Arc::clone(&ps.local_track))
}

/// Spawn a task that forwards RTP packets from a remote track to a local track.
#[cfg(not(tarpaulin_include))]
fn spawn_rtp_forwarder(
    remote_track: Arc<TrackRemote>,
    target: Arc<TrackLocalStaticRTP>,
    user_id: String,
) {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 1500];
        loop {
            match remote_track.read(&mut buf).await {
                Ok((rtp_packet, _attributes)) => {
                    if let Err(e) = target.write_rtp(&rtp_packet).await {
                        let err_str = format!("{}", e);
                        if err_str.contains("ErrClosedPipe") || err_str.contains("closed pipe") {
                            return;
                        }
                        tracing::debug!("voice: track write error user={}: {}", user_id, err_str);
                        return;
                    }
                }
                Err(e) => {
                    if !e.to_string().contains("EOF") {
                        tracing::debug!("voice: track read ended user={}: {}", user_id, e);
                    }
                    return;
                }
            }
        }
    });
}

/// Set up the `on_ice_candidate` handler to forward ICE candidates via the event callback.
#[cfg(not(tarpaulin_include))]
pub(crate) fn setup_ice_candidate_handler(
    pc: &Arc<RTCPeerConnection>,
    on_event: SfuEventCallback,
    channel_id: String,
    user_id: String,
) {
    pc.on_ice_candidate(Box::new(move |candidate| {
        let on_event = Arc::clone(&on_event);
        let ch_id = channel_id.clone();
        let u_id = user_id.clone();

        Box::pin(async move {
            if let Some(candidate) = candidate {
                emit_ice_candidate(&on_event, candidate, ch_id, u_id).await;
            }
        })
    }));
}

/// Serialize and emit a single ICE candidate event.
#[cfg(not(tarpaulin_include))]
async fn emit_ice_candidate(
    on_event: &SfuEventCallback,
    candidate: RTCIceCandidate,
    channel_id: String,
    user_id: String,
) {
    let candidate_init = match candidate.to_json() {
        Ok(init) => init,
        Err(e) => {
            tracing::error!("voice: failed to serialize ICE candidate: {}", e);
            return;
        }
    };

    let handler = on_event.read().await;
    if let Some(ref f) = *handler {
        f(
            channel_id.clone(),
            SFUEvent::ICECandidate {
                channel_id,
                user_id,
                candidate: Box::new(candidate_init),
            },
        );
    }
}

/// Set up the `on_peer_connection_state_change` handler for cleanup on disconnect.
#[cfg(not(tarpaulin_include))]
pub(crate) fn setup_connection_state_handler(
    pc: &Arc<RTCPeerConnection>,
    rooms_ref: Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: SfuEventCallback,
    channel_id: String,
    user_id: String,
) {
    let pc_weak = Arc::downgrade(pc);

    pc.on_peer_connection_state_change(Box::new(move |state| {
        let rooms_ref = Arc::clone(&rooms_ref);
        let ch_id = channel_id.clone();
        let u_id = user_id.clone();
        let pc_weak = pc_weak.clone();
        let on_event = Arc::clone(&on_event);

        Box::pin(async move {
            tracing::info!(
                "voice: connection state changed channel={} user={} state={:?}",
                ch_id,
                u_id,
                state
            );

            if state != RTCPeerConnectionState::Failed
                && state != RTCPeerConnectionState::Closed
            {
                return;
            }

            if is_active_connection(&rooms_ref, &ch_id, &u_id, &pc_weak).await {
                handle_leave_internal(&rooms_ref, &on_event, &ch_id, &u_id).await;
            }
        })
    }));
}

/// Check if the weak reference still points to the active peer connection for this user.
#[cfg(not(tarpaulin_include))]
async fn is_active_connection(
    rooms_ref: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    channel_id: &str,
    user_id: &str,
    pc_weak: &std::sync::Weak<RTCPeerConnection>,
) -> bool {
    let current_pc = match pc_weak.upgrade() {
        Some(pc) => pc,
        None => return false,
    };
    let rooms = rooms_ref.read().await;
    rooms
        .get(channel_id)
        .and_then(|room| room.get(user_id))
        .is_some_and(|ps| Arc::ptr_eq(&ps.pc, &current_pc))
}
