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

use super::sfu_bridge::parse_ice_servers;
use super::sfu_helpers::{
    add_existing_tracks_to_new_peer, add_track_to_peer, handle_leave_internal,
    renegotiate_all_except_internal, renegotiate_all_internal, renegotiate_internal,
    remove_track_from_other_peers,
};
use super::turn::TURNCredentialProvider;

/// Events emitted by the SFU to be forwarded to clients via WebSocket.
#[derive(Debug, Clone)]
#[allow(dead_code)]
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
pub(crate) struct PeerState {
    pub(crate) pc: Arc<RTCPeerConnection>,
    pub(crate) local_track: Arc<TrackLocalStaticRTP>,
    pub(crate) screen_track: Option<Arc<TrackLocalStaticRTP>>,
    pub(crate) webcam_track: Option<Arc<TrackLocalStaticRTP>>,
}

/// The SFU (Selective Forwarding Unit) manages WebRTC peer connections for voice channels.
pub struct SFU {
    /// channel_id -> user_id -> PeerState
    pub(crate) rooms: Arc<RwLock<HashMap<String, HashMap<String, PeerState>>>>,
    pub(crate) api: webrtc::api::API,
    pub(crate) on_event: Arc<RwLock<Option<Box<dyn Fn(String, SFUEvent) + Send + Sync>>>>,
    pub(crate) turn_provider: Arc<RwLock<Option<Box<dyn TURNCredentialProvider>>>>,
}

#[allow(dead_code)]
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

            // Wire tracks between existing peers and the new peer.
            for (other_uid, other_ps) in room.iter() {
                if other_uid == user_id {
                    continue;
                }
                add_existing_tracks_to_new_peer(&pc, other_ps, other_uid).await;
                add_track_to_peer(&other_ps.pc, &local_track, "new audio", other_uid).await;
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

        let track_id = {
            let ps = room
                .get_mut(user_id)
                .ok_or_else(|| format!("no peer state for user {}", user_id))?;
            match ps.screen_track.take() {
                Some(st) => st.id().to_string(),
                None => return Ok(()),
            }
        };

        remove_track_from_other_peers(room, user_id, &track_id, "screen").await;
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

        let track_id = {
            let ps = room
                .get_mut(user_id)
                .ok_or_else(|| format!("no peer state for user {}", user_id))?;
            match ps.webcam_track.take() {
                Some(wt) => wt.id().to_string(),
                None => return Ok(()),
            }
        };

        remove_track_from_other_peers(room, user_id, &track_id, "webcam").await;
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── SFU construction and basic operation tests ───────────────────────

    #[test]
    fn sfu_new_creates_valid_instance() {
        let sfu = SFU::new();
        // The SFU should be constructable without panic
        drop(sfu);
    }

    #[tokio::test]
    async fn sfu_set_on_event_callback() {
        let sfu = SFU::new();
        let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called_clone = called.clone();
        sfu.set_on_event(move |_ch, _evt| {
            called_clone.store(true, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
        // Callback stored without panic
    }

    #[tokio::test]
    async fn sfu_handle_leave_nonexistent_channel() {
        let sfu = SFU::new();
        // Should not panic for non-existent channel
        sfu.handle_leave("no-such-channel", "u1").await;
    }

    #[tokio::test]
    async fn sfu_handle_leave_nonexistent_user() {
        let sfu = SFU::new();
        sfu.handle_leave("ch1", "no-such-user").await;
    }

    #[tokio::test]
    async fn sfu_renegotiate_all_empty_room() {
        let sfu = SFU::new();
        sfu.renegotiate_all("nonexistent").await;
    }

    #[tokio::test]
    async fn sfu_renegotiate_all_except_empty_room() {
        let sfu = SFU::new();
        sfu.renegotiate_all_except("nonexistent", "u1").await;
    }

    #[tokio::test]
    async fn sfu_remove_screen_track_no_room_returns_error() {
        let sfu = SFU::new();
        let result = sfu.remove_screen_track("no-room", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_remove_webcam_track_no_room_returns_error() {
        let sfu = SFU::new();
        let result = sfu.remove_webcam_track("no-room", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_add_screen_track_no_room_returns_error() {
        let sfu = SFU::new();
        let result = sfu.add_screen_track("no-room", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_add_webcam_track_no_room_returns_error() {
        let sfu = SFU::new();
        let result = sfu.add_webcam_track("no-room", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_handle_answer_no_room_returns_error() {
        let sfu = SFU::new();
        // Use a minimal valid SDP for an answer
        let sdp = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n".to_string();
        let answer = RTCSessionDescription::answer(sdp).unwrap();
        let result = sfu.handle_answer("no-room", "u1", answer).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_handle_ice_candidate_no_room_returns_error() {
        let sfu = SFU::new();
        let candidate = RTCIceCandidateInit {
            candidate: "candidate:...".to_string(),
            sdp_mid: Some("0".to_string()),
            sdp_mline_index: Some(0),
            username_fragment: None,
        };
        let result = sfu.handle_ice_candidate("no-room", "u1", candidate).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_renegotiate_no_room_returns_error() {
        let sfu = SFU::new();
        let result = sfu.renegotiate("no-room", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn sfu_ice_config_defaults_to_stun() {
        let sfu = SFU::new();
        let config = sfu.ice_config().await;
        assert!(!config.ice_servers.is_empty());
        assert!(config.ice_servers[0].urls[0].contains("stun"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sfu_handle_join_creates_peer_and_returns_offer() {
        let sfu = SFU::new();
        let result = sfu.handle_join("ch1", "u1").await;
        assert!(result.is_ok(), "join should succeed: {:?}", result.err());
        let offer = result.unwrap();
        assert!(!offer.sdp.is_empty(), "offer SDP should not be empty");
    }

    // NOTE: Tests involving sfu.handle_join followed by sfu.handle_leave or
    // re-join are skipped because webrtc-rs pc.close() can hang in test
    // environments. The SFU join/leave logic is covered via the MockVoiceSFU
    // in ws::tests instead.

    #[tokio::test]
    async fn sfu_set_turn_provider_changes_ice_config() {
        use crate::voice::turn::TURNCredentialProvider;

        struct MockTurnProvider;

        #[async_trait::async_trait]
        impl TURNCredentialProvider for MockTurnProvider {
            async fn get_ice_servers(&self) -> Result<serde_json::Value, String> {
                Ok(serde_json::json!([
                    {
                        "urls": ["turn:mock-turn.example.com:3478"],
                        "username": "mock-user",
                        "credential": "mock-pass"
                    }
                ]))
            }
        }

        let sfu = SFU::new();
        sfu.set_turn_provider(Box::new(MockTurnProvider)).await;

        let config = sfu.ice_config().await;
        assert!(!config.ice_servers.is_empty());
        assert!(config.ice_servers[0].urls[0].contains("mock-turn"));
        assert_eq!(config.ice_servers[0].username, "mock-user");
        assert_eq!(config.ice_servers[0].credential, "mock-pass");
    }

    #[tokio::test]
    async fn sfu_ice_config_fallback_on_provider_error() {
        use crate::voice::turn::TURNCredentialProvider;

        struct FailingTurnProvider;

        #[async_trait::async_trait]
        impl TURNCredentialProvider for FailingTurnProvider {
            async fn get_ice_servers(&self) -> Result<serde_json::Value, String> {
                Err("provider error".to_string())
            }
        }

        let sfu = SFU::new();
        sfu.set_turn_provider(Box::new(FailingTurnProvider)).await;

        // Should fall back to STUN.
        let config = sfu.ice_config().await;
        assert!(!config.ice_servers.is_empty());
        assert!(config.ice_servers[0].urls[0].contains("stun"));
    }

    #[tokio::test]
    async fn sfu_ice_config_fallback_on_invalid_json() {
        use crate::voice::turn::TURNCredentialProvider;

        struct BadJsonTurnProvider;

        #[async_trait::async_trait]
        impl TURNCredentialProvider for BadJsonTurnProvider {
            async fn get_ice_servers(&self) -> Result<serde_json::Value, String> {
                // Return a non-array JSON value.
                Ok(serde_json::json!({"not": "an array"}))
            }
        }

        let sfu = SFU::new();
        sfu.set_turn_provider(Box::new(BadJsonTurnProvider)).await;

        // Should fall back to STUN because parse_ice_servers returns error.
        let config = sfu.ice_config().await;
        assert!(!config.ice_servers.is_empty());
        assert!(config.ice_servers[0].urls[0].contains("stun"));
    }
}
