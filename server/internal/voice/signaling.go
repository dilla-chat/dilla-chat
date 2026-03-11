package voice

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

type peerState struct {
	pc          *webrtc.PeerConnection
	localTrack  *webrtc.TrackLocalStaticRTP
	screenTrack *webrtc.TrackLocalStaticRTP // nil unless this peer is screen sharing
	webcamTrack *webrtc.TrackLocalStaticRTP // nil unless this peer is sharing webcam
}

type SFU struct {
	mu           sync.RWMutex
	rooms        map[string]map[string]*peerState // channelID -> userID -> state
	api          *webrtc.API
	roomManager  *RoomManager
	OnEvent      func(channelID string, event interface{})
	cfTurnClient *CFTurnClient // nil if CF TURN not configured
}

func NewSFU(rm *RoomManager) *SFU {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		slog.Error("voice: failed to register opus codec", "error", err)
	}

	// Register VP8 video codec for screen sharing.
	if err := me.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeVP8,
			ClockRate:   90000,
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		slog.Error("voice: failed to register VP8 codec", "error", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(me))
	return &SFU{
		rooms:       make(map[string]map[string]*peerState),
		api:         api,
		roomManager: rm,
	}
}

// SetCFTurnClient configures the SFU to use Cloudflare TURN relay.
func (s *SFU) SetCFTurnClient(c *CFTurnClient) {
	s.cfTurnClient = c
}

func (s *SFU) iceConfig() webrtc.Configuration {
	if s.cfTurnClient != nil {
		iceServersJSON, err := s.cfTurnClient.GetICEServers()
		if err != nil {
			slog.Error("failed to get CF TURN credentials, falling back to STUN", "error", err)
		} else {
			var iceServers []webrtc.ICEServer
			if err := json.Unmarshal(iceServersJSON, &iceServers); err != nil {
				slog.Error("failed to parse CF TURN iceServers", "error", err)
			} else {
				return webrtc.Configuration{
					ICEServers:         iceServers,
					ICETransportPolicy: webrtc.ICETransportPolicyRelay,
				}
			}
		}
	}
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}
}

func (s *SFU) HandleJoin(channelID, userID string) (*webrtc.SessionDescription, error) {
	pc, err := s.api.NewPeerConnection(s.iceConfig())
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	// Create a local audio track for this peer so others can receive their audio.
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
		fmt.Sprintf("audio-%s", userID),
		fmt.Sprintf("stream-%s", userID),
	)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("create local track: %w", err)
	}

	ps := &peerState{pc: pc, localTrack: localTrack}

	s.mu.Lock()
	if s.rooms[channelID] == nil {
		s.rooms[channelID] = make(map[string]*peerState)
	}
	// Close existing connection if any.
	if old, ok := s.rooms[channelID][userID]; ok {
		old.pc.Close()
	}
	s.rooms[channelID][userID] = ps

	// Add existing peers' tracks to this new peer connection so they can hear others.
	for otherUID, otherPS := range s.rooms[channelID] {
		if otherUID == userID {
			continue
		}
		if _, err := pc.AddTrack(otherPS.localTrack); err != nil {
			slog.Error("voice: failed to add track to new peer", "error", err, "other", otherUID)
		}
		// Add the new peer's track to the existing peer so they can hear the newcomer.
		if _, err := otherPS.pc.AddTrack(localTrack); err != nil {
			slog.Error("voice: failed to add new track to existing peer", "error", err, "other", otherUID)
		}
	}
	s.mu.Unlock()

	// Route incoming tracks by track ID prefix instead of just kind.
	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		slog.Info("voice: track received", "channel", channelID, "user", userID, "codec", remoteTrack.Codec().MimeType, "kind", remoteTrack.Kind().String(), "id", remoteTrack.ID())

		s.mu.RLock()
		currentPS := s.getPeerState(channelID, userID)
		s.mu.RUnlock()
		if currentPS == nil {
			return
		}

		var targetTrack *webrtc.TrackLocalStaticRTP
		trackID := remoteTrack.ID()
		switch {
		case len(trackID) > 7 && trackID[:7] == "webcam-":
			targetTrack = currentPS.webcamTrack
		case len(trackID) > 7 && trackID[:7] == "screen-":
			targetTrack = currentPS.screenTrack
		case remoteTrack.Kind() == webrtc.RTPCodecTypeVideo:
			// Fallback: if video but no prefix match, try screen then webcam.
			if currentPS.screenTrack != nil {
				targetTrack = currentPS.screenTrack
			} else {
				targetTrack = currentPS.webcamTrack
			}
		default:
			targetTrack = currentPS.localTrack
		}
		if targetTrack == nil {
			slog.Warn("voice: no local track for incoming track", "kind", remoteTrack.Kind().String(), "id", trackID, "user", userID)
			return
		}

		go func() {
			buf := make([]byte, 1500)
			for {
				n, _, readErr := remoteTrack.Read(buf)
				if readErr != nil {
					if readErr != io.EOF {
						slog.Debug("voice: track read ended", "user", userID, "error", readErr)
					}
					return
				}
				if _, writeErr := targetTrack.Write(buf[:n]); writeErr != nil {
					if writeErr != io.ErrClosedPipe {
						slog.Debug("voice: track write error", "user", userID, "error", writeErr)
					}
					return
				}
			}
		}()
	})

	// Forward ICE candidates to the client.
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		if s.OnEvent != nil {
			s.OnEvent(channelID, &ICECandidateEvent{
				ChannelID: channelID,
				UserID:    userID,
				Candidate: c.ToJSON(),
			})
		}
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		slog.Info("voice: connection state changed", "channel", channelID, "user", userID, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			// Only clean up if this is still the active connection for this user.
			// A rejoin may have replaced this PC with a new one.
			s.mu.RLock()
			current := s.getPeerState(channelID, userID)
			s.mu.RUnlock()
			if current != nil && current.pc == pc {
				s.HandleLeave(channelID, userID)
			}
		}
	})

	// Create an offer to send to the client.
	// Add a recv-only transceiver so the server can receive audio from the client.
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		slog.Error("voice: failed to add recv transceiver", "error", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		return nil, fmt.Errorf("create offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		return nil, fmt.Errorf("set local description: %w", err)
	}

	// Renegotiate all existing peers so they receive the new peer's audio track.
	go s.RenegotiateAll(channelID)

	return &offer, nil
}

func (s *SFU) HandleAnswer(channelID, userID string, answer webrtc.SessionDescription) error {
	s.mu.RLock()
	ps := s.getPeerState(channelID, userID)
	s.mu.RUnlock()
	if ps == nil {
		return fmt.Errorf("no peer connection for user %s in channel %s", userID, channelID)
	}
	return ps.pc.SetRemoteDescription(answer)
}

func (s *SFU) HandleICECandidate(channelID, userID string, candidate webrtc.ICECandidateInit) error {
	s.mu.RLock()
	ps := s.getPeerState(channelID, userID)
	s.mu.RUnlock()
	if ps == nil {
		return fmt.Errorf("no peer connection for user %s in channel %s", userID, channelID)
	}
	return ps.pc.AddICECandidate(candidate)
}

func (s *SFU) HandleLeave(channelID, userID string) {
	s.mu.Lock()

	room, ok := s.rooms[channelID]
	if !ok {
		s.mu.Unlock()
		return
	}
	ps, ok := room[userID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(room, userID)
	ps.pc.Close()

	// Remove the leaving peer's tracks from all remaining peers.
	for _, otherPS := range room {
		for _, sender := range otherPS.pc.GetSenders() {
			t := sender.Track()
			if t == nil {
				continue
			}
			if t.ID() == ps.localTrack.ID() ||
				(ps.screenTrack != nil && t.ID() == ps.screenTrack.ID()) ||
				(ps.webcamTrack != nil && t.ID() == ps.webcamTrack.ID()) {
				if err := otherPS.pc.RemoveTrack(sender); err != nil {
					slog.Error("voice: failed to remove track on leave", "error", err)
				}
			}
		}
	}

	empty := len(room) == 0
	s.mu.Unlock()

	if empty {
		s.mu.Lock()
		delete(s.rooms, channelID)
		s.mu.Unlock()
	} else {
		// Renegotiate remaining peers so they get updated SDP without the removed tracks.
		s.RenegotiateAll(channelID)
	}
}

func (s *SFU) getPeerState(channelID, userID string) *peerState {
	room, ok := s.rooms[channelID]
	if !ok {
		return nil
	}
	return room[userID]
}

// ICECandidateEvent is emitted via OnEvent when the SFU has an ICE candidate for a peer.
type ICECandidateEvent struct {
	ChannelID string                  `json:"channel_id"`
	UserID    string                  `json:"user_id"`
	Candidate webrtc.ICECandidateInit `json:"candidate"`
}

// RenegotiateEvent is emitted when a peer needs a new offer (e.g. screen track added/removed).
type RenegotiateEvent struct {
	ChannelID string                    `json:"channel_id"`
	UserID    string                    `json:"user_id"`
	Offer     webrtc.SessionDescription `json:"offer"`
}

// Renegotiate creates a new offer for an existing peer and emits a RenegotiateEvent.
func (s *SFU) Renegotiate(channelID, userID string) error {
	s.mu.RLock()
	ps := s.getPeerState(channelID, userID)
	s.mu.RUnlock()
	if ps == nil {
		return fmt.Errorf("no peer connection for user %s in channel %s", userID, channelID)
	}

	offer, err := ps.pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("create offer: %w", err)
	}
	if err := ps.pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("set local description: %w", err)
	}

	if s.OnEvent != nil {
		s.OnEvent(channelID, &RenegotiateEvent{
			ChannelID: channelID,
			UserID:    userID,
			Offer:     offer,
		})
	}
	return nil
}

// AddScreenTrack creates a video track for the sharing peer and adds it to all other peers.
// Returns the created track. The caller must trigger renegotiation after this.
func (s *SFU) AddScreenTrack(channelID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	room, ok := s.rooms[channelID]
	if !ok {
		return fmt.Errorf("no room for channel %s", channelID)
	}
	ps, ok := room[userID]
	if !ok {
		return fmt.Errorf("no peer state for user %s", userID)
	}

	// Create a video local track for the screen sharer.
	screenTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		fmt.Sprintf("screen-%s", userID),
		fmt.Sprintf("screen-stream-%s", userID),
	)
	if err != nil {
		return fmt.Errorf("create screen track: %w", err)
	}
	ps.screenTrack = screenTrack

	// Add a recv-only video transceiver to the sharer's PC so we receive their screen.
	if _, err := ps.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		slog.Error("voice: failed to add screen recv transceiver", "error", err)
	}

	// Add the screen track to all OTHER peers so they can see the screen.
	for otherUID, otherPS := range room {
		if otherUID == userID {
			continue
		}
		if _, err := otherPS.pc.AddTrack(screenTrack); err != nil {
			slog.Error("voice: failed to add screen track to peer", "error", err, "other", otherUID)
		}
	}

	return nil
}

// RemoveScreenTrack removes the screen track from all peers and cleans up.
// The caller must trigger renegotiation after this.
func (s *SFU) RemoveScreenTrack(channelID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	room, ok := s.rooms[channelID]
	if !ok {
		return fmt.Errorf("no room for channel %s", channelID)
	}
	ps, ok := room[userID]
	if !ok {
		return fmt.Errorf("no peer state for user %s", userID)
	}

	if ps.screenTrack == nil {
		return nil // No screen track to remove
	}

	// Remove the screen track from all other peers' connections.
	for otherUID, otherPS := range room {
		if otherUID == userID {
			continue
		}
		for _, sender := range otherPS.pc.GetSenders() {
			if sender.Track() != nil && sender.Track().ID() == ps.screenTrack.ID() {
				if err := otherPS.pc.RemoveTrack(sender); err != nil {
					slog.Error("voice: failed to remove screen track from peer", "error", err, "other", otherUID)
				}
				break
			}
		}
	}

	ps.screenTrack = nil
	return nil
}

// AddWebcamTrack creates a video track for the peer's webcam and adds it to all other peers.
func (s *SFU) AddWebcamTrack(channelID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	room, ok := s.rooms[channelID]
	if !ok {
		return fmt.Errorf("no room for channel %s", channelID)
	}
	ps, ok := room[userID]
	if !ok {
		return fmt.Errorf("no peer state for user %s", userID)
	}

	webcamTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		fmt.Sprintf("webcam-%s", userID),
		fmt.Sprintf("webcam-stream-%s", userID),
	)
	if err != nil {
		return fmt.Errorf("create webcam track: %w", err)
	}
	ps.webcamTrack = webcamTrack

	// Add a recv-only video transceiver so we receive the webcam feed.
	if _, err := ps.pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		slog.Error("voice: failed to add webcam recv transceiver", "error", err)
	}

	// Add the webcam track to all OTHER peers.
	for otherUID, otherPS := range room {
		if otherUID == userID {
			continue
		}
		if _, err := otherPS.pc.AddTrack(webcamTrack); err != nil {
			slog.Error("voice: failed to add webcam track to peer", "error", err, "other", otherUID)
		}
	}

	return nil
}

// RemoveWebcamTrack removes the webcam track from all peers.
func (s *SFU) RemoveWebcamTrack(channelID, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	room, ok := s.rooms[channelID]
	if !ok {
		return fmt.Errorf("no room for channel %s", channelID)
	}
	ps, ok := room[userID]
	if !ok {
		return fmt.Errorf("no peer state for user %s", userID)
	}

	if ps.webcamTrack == nil {
		return nil
	}

	for otherUID, otherPS := range room {
		if otherUID == userID {
			continue
		}
		for _, sender := range otherPS.pc.GetSenders() {
			if sender.Track() != nil && sender.Track().ID() == ps.webcamTrack.ID() {
				if err := otherPS.pc.RemoveTrack(sender); err != nil {
					slog.Error("voice: failed to remove webcam track from peer", "error", err, "other", otherUID)
				}
				break
			}
		}
	}

	ps.webcamTrack = nil
	return nil
}

// RenegotiateAll creates new offers for all peers in a room. Each triggers a RenegotiateEvent.
func (s *SFU) RenegotiateAll(channelID string) {
	s.mu.RLock()
	room, ok := s.rooms[channelID]
	if !ok {
		s.mu.RUnlock()
		return
	}
	userIDs := make([]string, 0, len(room))
	for uid := range room {
		userIDs = append(userIDs, uid)
	}
	s.mu.RUnlock()

	for _, uid := range userIDs {
		if err := s.Renegotiate(channelID, uid); err != nil {
			slog.Error("voice: renegotiate failed", "channel", channelID, "user", uid, "error", err)
		}
	}
}
