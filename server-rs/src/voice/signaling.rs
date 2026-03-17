use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS, MIME_TYPE_VP8};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};

use super::turn::TURNCredentialProvider;

/// Events emitted by the SFU to be forwarded to clients via WebSocket.
#[derive(Debug, Clone)]
pub enum SFUEvent {
    ICECandidate {
        channel_id: String,
        user_id: String,
        candidate: RTCIceCandidateInit,
    },
    Renegotiate {
        channel_id: String,
        user_id: String,
        offer: RTCSessionDescription,
    },
}

/// Per-user WebRTC state within a voice channel.
struct PeerState {
    pc: Arc<RTCPeerConnection>,
    local_track: Arc<TrackLocalStaticRTP>,
    screen_track: Option<Arc<TrackLocalStaticRTP>>,
    webcam_track: Option<Arc<TrackLocalStaticRTP>>,
}

/// The SFU (Selective Forwarding Unit) manages WebRTC peer connections for voice channels.
pub struct SFU {
    /// channel_id -> user_id -> PeerState
    rooms: Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    api: webrtc::api::API,
    on_event: Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    turn_provider: Arc<RwLock<Option<Box<dyn TURNCredentialProvider>>>>,
}

impl SFU {
    /// Create a new SFU with Opus audio and VP8 video codecs registered.
    pub fn new() -> Self {
        let mut me = MediaEngine::default();

        // Register Opus audio codec (48kHz, 2ch, payload type 111).
        if let Err(e) = me.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        ) {
            tracing::error!("voice: failed to register opus codec: {}", e);
        }

        // Register VP8 video codec (90kHz, payload type 96).
        if let Err(e) = me.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_VP8.to_owned(),
                    clock_rate: 90000,
                    channels: 0,
                    sdp_fmtp_line: String::new(),
                    rtcp_feedback: vec![],
                },
                payload_type: 96,
                ..Default::default()
            },
            RTPCodecType::Video,
        ) {
            tracing::error!("voice: failed to register VP8 codec: {}", e);
        }

        let api = APIBuilder::new().with_media_engine(me).build();

        SFU {
            rooms: Arc::new(RwLock::new(HashMap::new())),
            api,
            on_event: Arc::new(RwLock::new(None)),
            turn_provider: Arc::new(RwLock::new(None)),
        }
    }

    /// Set the callback invoked when the SFU needs to send an event to a client.
    pub async fn set_on_event<F>(&self, f: F)
    where
        F: Fn(String, SFUEvent) + Send + Sync + 'static,
    {
        let mut handler = self.on_event.write().await;
        *handler = Some(Box::new(f));
    }

    /// Configure a TURN credential provider for ICE relay.
    pub async fn set_turn_provider(&self, provider: Box<dyn TURNCredentialProvider>) {
        let mut tp = self.turn_provider.write().await;
        *tp = Some(provider);
    }

    /// Build the ICE configuration, using TURN relay if a provider is set.
    async fn ice_config(&self) -> RTCConfiguration {
        let tp = self.turn_provider.read().await;
        if let Some(ref provider) = *tp {
            match provider.get_ice_servers().await {
                Ok(ice_servers_json) => {
                    // Parse the JSON array of ICE servers into RTCIceServer structs.
                    match parse_ice_servers(&ice_servers_json) {
                        Ok(ice_servers) => {
                            return RTCConfiguration {
                                ice_servers,
                                ice_transport_policy:
                                    webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy::Relay,
                                ..Default::default()
                            };
                        }
                        Err(e) => {
                            tracing::error!("failed to parse TURN iceServers: {}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(
                        "failed to get TURN credentials, falling back to STUN: {}",
                        e
                    );
                }
            }
        }

        // Fallback: public STUN server.
        RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    /// Handle a user joining a voice channel. Returns an SDP offer for the client.
    pub async fn handle_join(
        &self,
        channel_id: &str,
        user_id: &str,
    ) -> Result<RTCSessionDescription, String> {
        let config = self.ice_config().await;
        let pc = self
            .api
            .new_peer_connection(config)
            .await
            .map_err(|e| format!("create peer connection: {e}"))?;

        let pc = Arc::new(pc);

        // Create a local audio track for this peer so others can receive their audio.
        let local_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48000,
                channels: 2,
                sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                rtcp_feedback: vec![],
            },
            format!("audio-{}", user_id),
            format!("stream-{}", user_id),
        ));

        let ps = PeerState {
            pc: Arc::clone(&pc),
            local_track: Arc::clone(&local_track),
            screen_track: None,
            webcam_track: None,
        };

        // Lock rooms and set up track routing.
        {
            let mut rooms = self.rooms.write().await;
            let room = rooms
                .entry(channel_id.to_string())
                .or_insert_with(HashMap::new);

            // Close existing connection if any (rejoin).
            if let Some(old) = room.remove(user_id) {
                let _ = old.pc.close().await;
            }

            // Add existing peers' tracks to this new peer so they can hear/see others.
            for (other_uid, other_ps) in room.iter() {
                if other_uid == user_id {
                    continue;
                }

                // Add other's audio track to new peer.
                if let Err(e) = pc
                    .add_track(Arc::clone(&other_ps.local_track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                {
                    tracing::error!(
                        "voice: failed to add audio track to new peer: {} (other={})",
                        e,
                        other_uid
                    );
                }

                // Add existing screen share track so late joiners can see it.
                if let Some(ref st) = other_ps.screen_track {
                    if let Err(e) = pc
                        .add_track(Arc::clone(st) as Arc<dyn TrackLocal + Send + Sync>)
                        .await
                    {
                        tracing::error!(
                            "voice: failed to add screen track to new peer: {} (other={})",
                            e,
                            other_uid
                        );
                    }
                }

                // Add existing webcam track so late joiners can see it.
                if let Some(ref wt) = other_ps.webcam_track {
                    if let Err(e) = pc
                        .add_track(Arc::clone(wt) as Arc<dyn TrackLocal + Send + Sync>)
                        .await
                    {
                        tracing::error!(
                            "voice: failed to add webcam track to new peer: {} (other={})",
                            e,
                            other_uid
                        );
                    }
                }

                // Add the new peer's audio track to the existing peer so they hear the newcomer.
                if let Err(e) = other_ps
                    .pc
                    .add_track(Arc::clone(&local_track) as Arc<dyn TrackLocal + Send + Sync>)
                    .await
                {
                    tracing::error!(
                        "voice: failed to add new track to existing peer: {} (other={})",
                        e,
                        other_uid
                    );
                }
            }

            room.insert(user_id.to_string(), ps);
        }

        // Set up OnTrack handler: route incoming RTP by track ID prefix.
        {
            let rooms_ref = Arc::clone(&self.rooms);
            let ch_id = channel_id.to_string();
            let u_id = user_id.to_string();

            pc.on_track(Box::new(move |remote_track, _receiver, _transceiver| {
                let rooms_ref = Arc::clone(&rooms_ref);
                let ch_id = ch_id.clone();
                let u_id = u_id.clone();

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

                    // Determine which local track to forward to.
                    let target_track: Option<Arc<TrackLocalStaticRTP>> = {
                        let rooms = rooms_ref.read().await;
                        let ps = rooms
                            .get(&ch_id)
                            .and_then(|room| room.get(&u_id));

                        match ps {
                            Some(ps) => {
                                if track_id.starts_with("webcam-") {
                                    ps.webcam_track.clone()
                                } else if track_id.starts_with("screen-") {
                                    ps.screen_track.clone()
                                } else if kind == RTPCodecType::Video {
                                    // Fallback for video without prefix.
                                    ps.screen_track
                                        .clone()
                                        .or_else(|| ps.webcam_track.clone())
                                } else {
                                    Some(Arc::clone(&ps.local_track))
                                }
                            }
                            None => None,
                        }
                    };

                    let target = match target_track {
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

                    // Forward RTP packets from remote track to local track.
                    tokio::spawn(async move {
                        let mut buf = vec![0u8; 1500];
                        loop {
                            match remote_track.read(&mut buf).await {
                                Ok((rtp_packet, _attributes)) => {
                                    if let Err(e) = target.write_rtp(&rtp_packet).await {
                                        let err_str = format!("{}", e);
                                        if err_str.contains("ErrClosedPipe")
                                            || err_str.contains("closed pipe")
                                        {
                                            return;
                                        }
                                        tracing::debug!(
                                            "voice: track write error user={}: {}",
                                            u_id,
                                            err_str
                                        );
                                        return;
                                    }
                                }
                                Err(e) => {
                                    let err_str = e.to_string();
                                    if !err_str.contains("EOF") {
                                        tracing::debug!(
                                            "voice: track read ended user={}: {}",
                                            u_id,
                                            e
                                        );
                                    }
                                    return;
                                }
                            }
                        }
                    });
                })
            }));
        }

        // Forward ICE candidates to the client.
        {
            let on_event = Arc::clone(&self.on_event);
            let ch_id = channel_id.to_string();
            let u_id = user_id.to_string();

            pc.on_ice_candidate(Box::new(move |candidate| {
                let on_event = Arc::clone(&on_event);
                let ch_id = ch_id.clone();
                let u_id = u_id.clone();

                Box::pin(async move {
                    let candidate = match candidate {
                        Some(c) => c,
                        None => return,
                    };

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
                            ch_id.clone(),
                            SFUEvent::ICECandidate {
                                channel_id: ch_id,
                                user_id: u_id,
                                candidate: candidate_init,
                            },
                        );
                    }
                })
            }));
        }

        // Handle connection state changes.
        {
            let rooms_ref = Arc::clone(&self.rooms);
            let ch_id = channel_id.to_string();
            let u_id = user_id.to_string();
            let pc_weak = Arc::downgrade(&pc);
            let on_event = Arc::clone(&self.on_event);

            pc.on_peer_connection_state_change(Box::new(move |state| {
                let rooms_ref = Arc::clone(&rooms_ref);
                let ch_id = ch_id.clone();
                let u_id = u_id.clone();
                let pc_weak = pc_weak.clone();
                let on_event = Arc::clone(&on_event);

                Box::pin(async move {
                    tracing::info!(
                        "voice: connection state changed channel={} user={} state={:?}",
                        ch_id,
                        u_id,
                        state
                    );

                    if state == RTCPeerConnectionState::Failed
                        || state == RTCPeerConnectionState::Closed
                    {
                        // Only clean up if this is still the active connection for this user.
                        let should_cleanup = {
                            let rooms = rooms_ref.read().await;
                            if let Some(room) = rooms.get(&ch_id) {
                                if let Some(ps) = room.get(&u_id) {
                                    if let Some(current_pc) = pc_weak.upgrade() {
                                        Arc::ptr_eq(&ps.pc, &current_pc)
                                    } else {
                                        false
                                    }
                                } else {
                                    false
                                }
                            } else {
                                false
                            }
                        };

                        if should_cleanup {
                            handle_leave_internal(&rooms_ref, &on_event, &ch_id, &u_id).await;
                        }
                    }
                })
            }));
        }

        // Add a recv-only audio transceiver so the server can receive audio from the client.
        if let Err(e) = pc
            .add_transceiver_from_kind(
                RTPCodecType::Audio,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    send_encodings: vec![],
                }),
            )
            .await
        {
            tracing::error!("voice: failed to add recv transceiver: {}", e);
        }

        // Create an offer to send to the client.
        let offer = pc
            .create_offer(None)
            .await
            .map_err(|e| format!("create offer: {e}"))?;

        pc.set_local_description(offer.clone())
            .await
            .map_err(|e| format!("set local description: {e}"))?;

        // Renegotiate existing peers (not the new one) so they receive the new peer's audio track.
        let rooms_ref = Arc::clone(&self.rooms);
        let on_event = Arc::clone(&self.on_event);
        let ch_id = channel_id.to_string();
        let u_id = user_id.to_string();
        tokio::spawn(async move {
            renegotiate_all_except_internal(&rooms_ref, &on_event, &ch_id, &u_id).await;
        });

        Ok(offer)
    }

    /// Handle an SDP answer from a client.
    pub async fn handle_answer(
        &self,
        channel_id: &str,
        user_id: &str,
        answer: RTCSessionDescription,
    ) -> Result<(), String> {
        let rooms = self.rooms.read().await;
        let ps = rooms
            .get(channel_id)
            .and_then(|room| room.get(user_id))
            .ok_or_else(|| {
                format!(
                    "no peer connection for user {} in channel {}",
                    user_id, channel_id
                )
            })?;

        ps.pc
            .set_remote_description(answer)
            .await
            .map_err(|e| format!("set remote description: {e}"))
    }

    /// Handle an ICE candidate from a client.
    pub async fn handle_ice_candidate(
        &self,
        channel_id: &str,
        user_id: &str,
        candidate: RTCIceCandidateInit,
    ) -> Result<(), String> {
        let rooms = self.rooms.read().await;
        let ps = rooms
            .get(channel_id)
            .and_then(|room| room.get(user_id))
            .ok_or_else(|| {
                format!(
                    "no peer connection for user {} in channel {}",
                    user_id, channel_id
                )
            })?;

        ps.pc
            .add_ice_candidate(candidate)
            .await
            .map_err(|e| format!("add ICE candidate: {e}"))
    }

    /// Handle a user leaving a voice channel.
    pub async fn handle_leave(&self, channel_id: &str, user_id: &str) {
        handle_leave_internal(&self.rooms, &self.on_event, channel_id, user_id).await;
    }

    /// Add a screen-sharing video track for the given user and distribute to all other peers.
    pub async fn add_screen_track(
        &self,
        channel_id: &str,
        user_id: &str,
    ) -> Result<(), String> {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .get_mut(channel_id)
            .ok_or_else(|| format!("no room for channel {}", channel_id))?;
        let ps = room
            .get_mut(user_id)
            .ok_or_else(|| format!("no peer state for user {}", user_id))?;

        // Create a VP8 video track for screen sharing.
        let screen_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_VP8.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: vec![],
            },
            format!("screen-{}", user_id),
            format!("screen-stream-{}", user_id),
        ));
        ps.screen_track = Some(Arc::clone(&screen_track));

        // Add a recv-only video transceiver to the sharer's PC so we receive their screen.
        if let Err(e) = ps
            .pc
            .add_transceiver_from_kind(
                RTPCodecType::Video,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    send_encodings: vec![],
                }),
            )
            .await
        {
            tracing::error!("voice: failed to add screen recv transceiver: {}", e);
        }

        // Add the screen track to all OTHER peers so they can see the screen.
        for (other_uid, other_ps) in room.iter() {
            if other_uid == user_id {
                continue;
            }
            if let Err(e) = other_ps
                .pc
                .add_track(Arc::clone(&screen_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
            {
                tracing::error!(
                    "voice: failed to add screen track to peer: {} (other={})",
                    e,
                    other_uid
                );
            }
        }

        Ok(())
    }

    /// Remove a screen-sharing track from all peers.
    pub async fn remove_screen_track(
        &self,
        channel_id: &str,
        user_id: &str,
    ) -> Result<(), String> {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .get_mut(channel_id)
            .ok_or_else(|| format!("no room for channel {}", channel_id))?;

        let screen_track_id = {
            let ps = room
                .get_mut(user_id)
                .ok_or_else(|| format!("no peer state for user {}", user_id))?;

            let st = match ps.screen_track.take() {
                Some(st) => st,
                None => return Ok(()), // No screen track to remove.
            };
            st.id().to_string()
        };

        // Remove the screen track from all other peers' connections.
        for (other_uid, other_ps) in room.iter() {
            if other_uid == user_id {
                continue;
            }
            let senders = other_ps.pc.get_senders().await;
            for sender in &senders {
                if let Some(track) = sender.track().await {
                    if track.id() == screen_track_id {
                        if let Err(e) = other_ps.pc.remove_track(sender).await {
                            tracing::error!(
                                "voice: failed to remove screen track from peer: {} (other={})",
                                e,
                                other_uid
                            );
                        }
                        break;
                    }
                }
            }
        }

        Ok(())
    }

    /// Add a webcam video track for the given user and distribute to all other peers.
    pub async fn add_webcam_track(
        &self,
        channel_id: &str,
        user_id: &str,
    ) -> Result<(), String> {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .get_mut(channel_id)
            .ok_or_else(|| format!("no room for channel {}", channel_id))?;
        let ps = room
            .get_mut(user_id)
            .ok_or_else(|| format!("no peer state for user {}", user_id))?;

        let webcam_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_VP8.to_owned(),
                clock_rate: 90000,
                channels: 0,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: vec![],
            },
            format!("webcam-{}", user_id),
            format!("webcam-stream-{}", user_id),
        ));
        ps.webcam_track = Some(Arc::clone(&webcam_track));

        // Add a recv-only video transceiver so we receive the webcam feed.
        if let Err(e) = ps
            .pc
            .add_transceiver_from_kind(
                RTPCodecType::Video,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Recvonly,
                    send_encodings: vec![],
                }),
            )
            .await
        {
            tracing::error!("voice: failed to add webcam recv transceiver: {}", e);
        }

        // Add the webcam track to all OTHER peers.
        for (other_uid, other_ps) in room.iter() {
            if other_uid == user_id {
                continue;
            }
            if let Err(e) = other_ps
                .pc
                .add_track(Arc::clone(&webcam_track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
            {
                tracing::error!(
                    "voice: failed to add webcam track to peer: {} (other={})",
                    e,
                    other_uid
                );
            }
        }

        Ok(())
    }

    /// Remove a webcam track from all peers.
    pub async fn remove_webcam_track(
        &self,
        channel_id: &str,
        user_id: &str,
    ) -> Result<(), String> {
        let mut rooms = self.rooms.write().await;
        let room = rooms
            .get_mut(channel_id)
            .ok_or_else(|| format!("no room for channel {}", channel_id))?;

        let webcam_track_id = {
            let ps = room
                .get_mut(user_id)
                .ok_or_else(|| format!("no peer state for user {}", user_id))?;

            let wt = match ps.webcam_track.take() {
                Some(wt) => wt,
                None => return Ok(()),
            };
            wt.id().to_string()
        };

        for (other_uid, other_ps) in room.iter() {
            if other_uid == user_id {
                continue;
            }
            let senders = other_ps.pc.get_senders().await;
            for sender in &senders {
                if let Some(track) = sender.track().await {
                    if track.id() == webcam_track_id {
                        if let Err(e) = other_ps.pc.remove_track(sender).await {
                            tracing::error!(
                                "voice: failed to remove webcam track from peer: {} (other={})",
                                e,
                                other_uid
                            );
                        }
                        break;
                    }
                }
            }
        }

        Ok(())
    }

    /// Create a new offer for an existing peer and emit a RenegotiateEvent.
    pub async fn renegotiate(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        renegotiate_internal(&self.rooms, &self.on_event, channel_id, user_id).await
    }

    /// Renegotiate all peers in a room.
    pub async fn renegotiate_all(&self, channel_id: &str) {
        renegotiate_all_internal(&self.rooms, &self.on_event, channel_id).await;
    }

    /// Renegotiate all peers in a room except the specified user.
    pub async fn renegotiate_all_except(&self, channel_id: &str, exclude_user_id: &str) {
        renegotiate_all_except_internal(&self.rooms, &self.on_event, channel_id, exclude_user_id)
            .await;
    }
}

// ---------------------------------------------------------------------------
// Internal helpers (free functions to avoid borrow issues with &self)
// ---------------------------------------------------------------------------

async fn renegotiate_internal(
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

async fn renegotiate_all_internal(
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

async fn renegotiate_all_except_internal(
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

async fn handle_leave_internal(
    rooms: &Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    on_event: &Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    channel_id: &str,
    user_id: &str,
) {
    let (removed_ps, is_empty) = {
        let mut rooms_guard = rooms.write().await;
        let room = match rooms_guard.get_mut(channel_id) {
            Some(room) => room,
            None => return,
        };

        let ps = match room.remove(user_id) {
            Some(ps) => ps,
            None => return,
        };

        // Close the peer connection.
        let _ = ps.pc.close().await;

        // Collect track IDs to remove from other peers.
        let local_track_id = ps.local_track.id().to_string();
        let screen_track_id = ps.screen_track.as_ref().map(|t| t.id().to_string());
        let webcam_track_id = ps.webcam_track.as_ref().map(|t| t.id().to_string());

        // Remove the leaving peer's tracks from all remaining peers.
        for (_other_uid, other_ps) in room.iter() {
            let senders = other_ps.pc.get_senders().await;
            for sender in &senders {
                if let Some(track) = sender.track().await {
                    let tid = track.id();
                    if tid == local_track_id
                        || screen_track_id.as_deref() == Some(tid)
                        || webcam_track_id.as_deref() == Some(tid)
                    {
                        if let Err(e) = other_ps.pc.remove_track(sender).await {
                            tracing::error!(
                                "voice: failed to remove track on leave: {}",
                                e
                            );
                        }
                    }
                }
            }
        }

        let empty = room.is_empty();
        if empty {
            rooms_guard.remove(channel_id);
        }

        (true, empty)
    };

    if !removed_ps {
        return;
    }

    if !is_empty {
        // Renegotiate remaining peers so they get updated SDP without the removed tracks.
        renegotiate_all_internal(rooms, on_event, channel_id).await;
    }
}

// ---------------------------------------------------------------------------
// VoiceSFU trait implementation (bridge for ws::Hub)
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
impl crate::ws::hub::VoiceSFU for SFU {
    async fn handle_join(&self, channel_id: &str, user_id: &str) -> Result<String, String> {
        let offer = self.handle_join(channel_id, user_id).await?;
        serde_json::to_string(&offer).map_err(|e| format!("serialize offer: {e}"))
    }

    async fn handle_leave(&self, channel_id: &str, user_id: &str) {
        self.handle_leave(channel_id, user_id).await;
    }

    async fn handle_answer(
        &self,
        channel_id: &str,
        user_id: &str,
        sdp: &str,
    ) -> Result<(), String> {
        let answer = RTCSessionDescription::answer(sdp.to_string())
            .map_err(|e| format!("parse answer SDP: {e}"))?;
        self.handle_answer(channel_id, user_id, answer).await
    }

    async fn handle_ice_candidate(
        &self,
        channel_id: &str,
        user_id: &str,
        candidate: &str,
        sdp_mid: &str,
        sdp_mline_index: u16,
    ) -> Result<(), String> {
        let init = RTCIceCandidateInit {
            candidate: candidate.to_string(),
            sdp_mid: Some(sdp_mid.to_string()),
            sdp_mline_index: Some(sdp_mline_index),
            username_fragment: None,
        };
        self.handle_ice_candidate(channel_id, user_id, init).await
    }

    async fn add_screen_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.add_screen_track(channel_id, user_id).await
    }

    async fn remove_screen_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.remove_screen_track(channel_id, user_id).await
    }

    async fn add_webcam_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.add_webcam_track(channel_id, user_id).await
    }

    async fn remove_webcam_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.remove_webcam_track(channel_id, user_id).await
    }

    async fn renegotiate_all(&self, channel_id: &str) {
        self.renegotiate_all(channel_id).await;
    }
}

/// Parse a JSON array of ICE servers into `Vec<RTCIceServer>`.
fn parse_ice_servers(json: &serde_json::Value) -> Result<Vec<RTCIceServer>, String> {
    let arr = json
        .as_array()
        .ok_or_else(|| "iceServers is not an array".to_string())?;

    let mut servers = Vec::new();
    for entry in arr {
        let urls: Vec<String> = entry
            .get("urls")
            .and_then(|v| {
                if let Some(arr) = v.as_array() {
                    Some(
                        arr.iter()
                            .filter_map(|u| u.as_str().map(String::from))
                            .collect(),
                    )
                } else if let Some(s) = v.as_str() {
                    Some(vec![s.to_string()])
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let username = entry
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let credential = entry
            .get("credential")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        servers.push(RTCIceServer {
            urls,
            username,
            credential,
            ..Default::default()
        });
    }

    Ok(servers)
}
