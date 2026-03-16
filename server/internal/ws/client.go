package ws

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/voice"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 64 * 1024
	typingCooldown = 3 // seconds
)

type Client struct {
	hub            *Hub
	conn           *websocket.Conn
	send           chan []byte
	userID         string
	username       string
	teamID         string
	channels       map[string]bool
	voiceChannelID string // tracks active voice channel for cleanup on disconnect
}

func NewClient(hub *Hub, conn *websocket.Conn, userID, username, teamID string) *Client {
	return &Client{
		hub:      hub,
		conn:     conn,
		send:     make(chan []byte, 256),
		userID:   userID,
		username: username,
		teamID:   teamID,
		channels: make(map[string]bool),
	}
}

// SendEvent marshals an event and queues it for delivery.
func (c *Client) SendEvent(event Event) {
	data, err := json.Marshal(event)
	if err != nil {
		slog.Error("ws: marshal event failed", "error", err)
		return
	}
	select {
	case c.send <- data:
	default:
		slog.Warn("ws: send buffer full, dropping message", "user_id", c.userID)
	}
}

func (c *Client) sendError(msg string) {
	evt, err := MakeEvent(EventError, ErrorPayload{Message: msg})
	if err != nil {
		return
	}
	c.SendEvent(evt)
}

// ReadPump reads messages from the WebSocket connection.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Error("ws: read error", "error", err, "user_id", c.userID)
			}
			break
		}
		var event Event
		if err := json.Unmarshal(message, &event); err != nil {
			c.sendError("invalid event format")
			continue
		}
		c.handleEvent(event)
	}
}

// WritePump writes messages to the WebSocket connection.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleEvent(event Event) {
	// Track activity for presence idle detection.
	if c.hub.OnClientActivity != nil {
		c.hub.OnClientActivity(c.userID)
	}

	// Record WS message metric (event type only, never payload).
	if c.hub.Metrics != nil {
		c.hub.Metrics.WSMessageReceived(event.Type)
	}

	switch event.Type {
	case EventMessageSend:
		var p MessageSendPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid message:send payload")
			return
		}
		c.handleMessageSend(p)

	case EventMessageEdit:
		var p MessageEditPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid message:edit payload")
			return
		}
		c.handleMessageEdit(p)

	case EventMessageDelete:
		var p MessageDeletePayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid message:delete payload")
			return
		}
		c.handleMessageDelete(p)

	case EventThreadMessageSend:
		var p ThreadMessageSendPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid thread:message:send payload")
			return
		}
		c.handleThreadMessageSend(p)

	case EventThreadMessageEdit:
		var p ThreadMessageEditPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid thread:message:edit payload")
			return
		}
		c.handleThreadMessageEdit(p)

	case EventThreadMessageRemove:
		var p ThreadMessageRemovePayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid thread:message:remove payload")
			return
		}
		c.handleThreadMessageRemove(p)

	case EventTypingStart:
		var p TypingPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid typing payload")
			return
		}
		p.UserID = c.userID
		p.Username = c.username
		c.handleTypingStart(p)

	case EventChannelJoin:
		var p struct {
			ChannelID string `json:"channel_id"`
		}
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid channel:join payload")
			return
		}
		c.handleChannelJoin(p.ChannelID)

	case EventChannelLeave:
		var p struct {
			ChannelID string `json:"channel_id"`
		}
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid channel:leave payload")
			return
		}
		c.handleChannelLeave(p.ChannelID)

	case EventPresenceUpdate:
		var p PresenceUpdatePayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid presence:update payload")
			return
		}
		p.UserID = c.userID
		c.handlePresenceUpdate(p)

	case EventRequest:
		var req RequestEvent
		if err := json.Unmarshal(event.Payload, &req); err != nil {
			c.sendError("invalid request payload")
			return
		}
		c.handleRequest(req)

	case EventPing:
		// Echo back as pong with same payload for latency measurement
		evt, err := MakeEvent(EventPong, json.RawMessage(event.Payload))
		if err == nil {
			c.SendEvent(evt)
		}

	case EventReactionAdd:
		var p ReactionRequestPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid reaction:add payload")
			return
		}
		c.handleReactionAdd(p)

	case EventReactionRemove:
		var p ReactionRequestPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid reaction:remove payload")
			return
		}
		c.handleReactionRemove(p)

	default:
		// Check for voice events.
		if c.handleVoiceEvent(event) {
			return
		}
		c.sendError("unknown event type: " + event.Type)
	}
}

func (c *Client) handleVoiceEvent(event Event) bool {
	switch event.Type {
	case EventVoiceJoin:
		var p VoiceJoinPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:join payload")
			return true
		}
		c.handleVoiceJoin(p)
		return true

	case EventVoiceLeave:
		var p VoiceLeavePayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:leave payload")
			return true
		}
		c.handleVoiceLeave(p)
		return true

	case EventVoiceAnswer:
		var p VoiceAnswerPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:answer payload")
			return true
		}
		c.handleVoiceAnswer(p)
		return true

	case EventVoiceICECandidate:
		var p VoiceICECandidatePayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:ice-candidate payload")
			return true
		}
		c.handleVoiceICECandidate(p)
		return true

	case EventVoiceMute:
		var p VoiceMutePayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:mute payload")
			return true
		}
		c.handleVoiceMute(p)
		return true

	case EventVoiceDeafen:
		var p VoiceDeafenPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:deafen payload")
			return true
		}
		c.handleVoiceDeafen(p)
		return true

	case EventVoiceScreenStart:
		var p VoiceScreenStartPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:screen-start payload")
			return true
		}
		c.handleVoiceScreenStart(p)
		return true

	case EventVoiceScreenStop:
		var p VoiceScreenStopPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:screen-stop payload")
			return true
		}
		c.handleVoiceScreenStop(p)
		return true

	case EventVoiceWebcamStart:
		var p VoiceWebcamStartPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:webcam-start payload")
			return true
		}
		c.handleVoiceWebcamStart(p)
		return true

	case EventVoiceWebcamStop:
		var p VoiceWebcamStopPayload
		if err := json.Unmarshal(event.Payload, &p); err != nil {
			c.sendError("invalid voice:webcam-stop payload")
			return true
		}
		c.handleVoiceWebcamStop(p)
		return true
	}
	return false
}

func (c *Client) handleVoiceJoin(p VoiceJoinPayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil || c.hub.VoiceRoomManager == nil {
		c.sendError("voice is not enabled")
		return
	}

	// Leave any existing voice channel first
	if c.voiceChannelID != "" && c.voiceChannelID != p.ChannelID {
		c.handleVoiceLeave(VoiceLeavePayload{ChannelID: c.voiceChannelID})
	}

	room := c.hub.VoiceRoomManager.GetOrCreateRoom(p.ChannelID, c.teamID)
	room.AddPeer(c.userID, c.username)
	c.voiceChannelID = p.ChannelID

	// Subscribe to the voice channel so we receive peer updates.
	c.hub.Subscribe(c, p.ChannelID)

	peers := room.GetPeers()
	slog.Info("voice: join", "channel", p.ChannelID, "user", c.userID, "peer_count", len(peers))

	// Notify ALL team clients so they see voice occupancy in the channel list.
	peer := room.GetPeer(c.userID)
	joinPayload := VoiceUserJoinedPayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Username:  c.username,
	}
	if peer != nil {
		joinPayload.Muted = peer.Muted
		joinPayload.Deafened = peer.Deafened
		joinPayload.ScreenSharing = peer.ScreenSharing
		joinPayload.WebcamSharing = peer.WebcamSharing
	}
	joinEvt, err := MakeEvent(EventVoiceUserJoined, joinPayload)
	if err == nil {
		c.hub.BroadcastToAllClients(joinEvt)
	}

	// Send current voice state to the joining client.
	stateEvt, err := MakeEvent(EventVoiceState, VoiceStatePayload{
		ChannelID: p.ChannelID,
		Peers:     peers,
	})
	if err == nil {
		c.SendEvent(stateEvt)
	}

	// Call SFU to create a peer connection and get an offer.
	offer, err := c.hub.VoiceSFU.HandleJoin(p.ChannelID, c.userID)
	if err != nil {
		slog.Error("voice: join failed", "error", err)
		c.sendError("voice join failed: " + err.Error())
		return
	}

	// Send offer to the joining client.
	evt, err := MakeEvent(EventVoiceOffer, VoiceOfferPayload{
		ChannelID: p.ChannelID,
		SDP:       offer.SDP,
	})
	if err == nil {
		c.SendEvent(evt)
	}

	// Notify federation peers.
	if c.hub.OnVoiceJoin != nil {
		c.hub.OnVoiceJoin(p.ChannelID, c.userID, c.username)
	}
}

func (c *Client) handleVoiceLeave(p VoiceLeavePayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil || c.hub.VoiceRoomManager == nil {
		return
	}

	// Clean up screen sharing if the leaving user was sharing.
	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room != nil {
		peer := room.GetPeer(c.userID)
		if peer != nil && peer.ScreenSharing {
			room.SetScreenSharing(c.userID, false)
			_ = c.hub.VoiceSFU.RemoveScreenTrack(p.ChannelID, c.userID)
			screenEvt, err := MakeEvent(EventVoiceScreenUpdate, VoiceScreenUpdatePayload{
				ChannelID: p.ChannelID,
				UserID:    c.userID,
				Sharing:   false,
			})
			if err == nil {
				c.hub.BroadcastToChannel(p.ChannelID, screenEvt, nil)
			}
		}
		if peer != nil && peer.WebcamSharing {
			room.SetWebcamSharing(c.userID, false)
			_ = c.hub.VoiceSFU.RemoveWebcamTrack(p.ChannelID, c.userID)
			webcamEvt, err := MakeEvent(EventVoiceWebcamUpdate, VoiceWebcamUpdatePayload{
				ChannelID: p.ChannelID,
				UserID:    c.userID,
				Sharing:   false,
			})
			if err == nil {
				c.hub.BroadcastToChannel(p.ChannelID, webcamEvt, nil)
			}
		}
	}

	c.hub.VoiceSFU.HandleLeave(p.ChannelID, c.userID)

	if room != nil {
		room.RemovePeer(c.userID)
		if room.IsEmpty() {
			c.hub.VoiceRoomManager.RemoveRoom(p.ChannelID)
		}
	}

	evt, err := MakeEvent(EventVoiceUserLeft, VoiceUserLeftPayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
	})
	if err == nil {
		c.hub.BroadcastToAllClients(evt)
	}

	// Unsubscribe from voice channel broadcasts.
	c.hub.Unsubscribe(c, p.ChannelID)
	c.voiceChannelID = ""

	// Notify federation peers.
	if c.hub.OnVoiceLeave != nil {
		c.hub.OnVoiceLeave(p.ChannelID, c.userID)
	}
}

func (c *Client) handleVoiceAnswer(p VoiceAnswerPayload) {
	if p.ChannelID == "" || p.SDP == "" {
		c.sendError("channel_id and sdp are required")
		return
	}
	if c.hub.VoiceSFU == nil {
		c.sendError("voice is not enabled")
		return
	}

	answer := webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  p.SDP,
	}
	if err := c.hub.VoiceSFU.HandleAnswer(p.ChannelID, c.userID, answer); err != nil {
		slog.Error("voice: answer failed", "error", err)
		c.sendError("voice answer failed: " + err.Error())
	}
}

func (c *Client) handleVoiceICECandidate(p VoiceICECandidatePayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil {
		c.sendError("voice is not enabled")
		return
	}

	sdpMid := p.SDPMid
	candidate := webrtc.ICECandidateInit{
		Candidate:     p.Candidate,
		SDPMid:        &sdpMid,
		SDPMLineIndex: &p.SDPMLine,
	}
	if err := c.hub.VoiceSFU.HandleICECandidate(p.ChannelID, c.userID, candidate); err != nil {
		slog.Error("voice: ice candidate failed", "error", err)
	}
}

func (c *Client) handleVoiceMute(p VoiceMutePayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceRoomManager == nil {
		return
	}

	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room == nil {
		return
	}
	room.SetMuted(c.userID, p.Muted)

	peer := room.GetPeer(c.userID)
	if peer == nil {
		return
	}
	evt, err := MakeEvent(EventVoiceMuteUpdate, VoiceMuteUpdatePayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Muted:     peer.Muted,
		Deafened:  peer.Deafened,
	})
	if err == nil {
		c.hub.BroadcastToAllClients(evt)
	}
}

func (c *Client) handleVoiceDeafen(p VoiceDeafenPayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceRoomManager == nil {
		return
	}

	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room == nil {
		return
	}
	room.SetDeafened(c.userID, p.Deafened)
	// Deafen also mutes
	if p.Deafened {
		room.SetMuted(c.userID, true)
	}

	peer := room.GetPeer(c.userID)
	if peer == nil {
		return
	}
	evt, err := MakeEvent(EventVoiceMuteUpdate, VoiceMuteUpdatePayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Muted:     peer.Muted,
		Deafened:  peer.Deafened,
	})
	if err == nil {
		c.hub.BroadcastToAllClients(evt)
	}
}

func (c *Client) handleVoiceScreenStart(p VoiceScreenStartPayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil || c.hub.VoiceRoomManager == nil {
		c.sendError("voice is not enabled")
		return
	}

	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room == nil {
		c.sendError("not in a voice channel")
		return
	}

	// Only one screen share per channel at a time.
	if existing := room.ScreenSharer(); existing != "" && existing != c.userID {
		c.sendError("another user is already sharing their screen")
		return
	}

	room.SetScreenSharing(c.userID, true)

	// Add video track in the SFU.
	if err := c.hub.VoiceSFU.AddScreenTrack(p.ChannelID, c.userID); err != nil {
		slog.Error("voice: screen start failed", "error", err)
		room.SetScreenSharing(c.userID, false)
		c.sendError("screen share failed: " + err.Error())
		return
	}

	slog.Info("voice: screen share started", "channel", p.ChannelID, "user", c.userID)

	// Broadcast screen update to all peers.
	evt2, err2 := MakeEvent(EventVoiceScreenUpdate, VoiceScreenUpdatePayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Sharing:   true,
	})
	if err2 == nil {
		c.hub.BroadcastToAllClients(evt2)
	}

	// Renegotiate with all peers to deliver the new video track.
	c.hub.VoiceSFU.RenegotiateAll(p.ChannelID)
}

func (c *Client) handleVoiceScreenStop(p VoiceScreenStopPayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil || c.hub.VoiceRoomManager == nil {
		return
	}

	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room == nil {
		return
	}

	room.SetScreenSharing(c.userID, false)

	// Remove video track from SFU.
	if err := c.hub.VoiceSFU.RemoveScreenTrack(p.ChannelID, c.userID); err != nil {
		slog.Error("voice: screen stop failed", "error", err)
	}

	slog.Info("voice: screen share stopped", "channel", p.ChannelID, "user", c.userID)

	// Broadcast screen update.
	evt2, err2 := MakeEvent(EventVoiceScreenUpdate, VoiceScreenUpdatePayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Sharing:   false,
	})
	if err2 == nil {
		c.hub.BroadcastToAllClients(evt2)
	}

	// Renegotiate to remove the video track from all peers.
	c.hub.VoiceSFU.RenegotiateAll(p.ChannelID)
}

func (c *Client) handleVoiceWebcamStart(p VoiceWebcamStartPayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil || c.hub.VoiceRoomManager == nil {
		c.sendError("voice is not enabled")
		return
	}

	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room == nil {
		c.sendError("not in a voice channel")
		return
	}

	room.SetWebcamSharing(c.userID, true)

	if err := c.hub.VoiceSFU.AddWebcamTrack(p.ChannelID, c.userID); err != nil {
		slog.Error("voice: webcam start failed", "error", err)
		room.SetWebcamSharing(c.userID, false)
		c.sendError("webcam share failed: " + err.Error())
		return
	}

	slog.Info("voice: webcam started", "channel", p.ChannelID, "user", c.userID)

	evt, err := MakeEvent(EventVoiceWebcamUpdate, VoiceWebcamUpdatePayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Sharing:   true,
	})
	if err == nil {
		c.hub.BroadcastToAllClients(evt)
	}

	c.hub.VoiceSFU.RenegotiateAll(p.ChannelID)
}

func (c *Client) handleVoiceWebcamStop(p VoiceWebcamStopPayload) {
	if p.ChannelID == "" {
		c.sendError("channel_id is required")
		return
	}
	if c.hub.VoiceSFU == nil || c.hub.VoiceRoomManager == nil {
		return
	}

	room := c.hub.VoiceRoomManager.GetRoom(p.ChannelID)
	if room == nil {
		return
	}

	room.SetWebcamSharing(c.userID, false)

	if err := c.hub.VoiceSFU.RemoveWebcamTrack(p.ChannelID, c.userID); err != nil {
		slog.Error("voice: webcam stop failed", "error", err)
	}

	slog.Info("voice: webcam stopped", "channel", p.ChannelID, "user", c.userID)

	evt, err := MakeEvent(EventVoiceWebcamUpdate, VoiceWebcamUpdatePayload{
		ChannelID: p.ChannelID,
		UserID:    c.userID,
		Sharing:   false,
	})
	if err == nil {
		c.hub.BroadcastToAllClients(evt)
	}

	c.hub.VoiceSFU.RenegotiateAll(p.ChannelID)
}

func (c *Client) handleMessageSend(p MessageSendPayload) {
	if p.ChannelID == "" || p.Content == "" {
		c.sendError("channel_id and content are required")
		return
	}
	if len(p.Content) > 16*1024 {
		c.sendError("content too long (max 16KB)")
		return
	}
	if p.Type == "" {
		p.Type = "text"
	}

	// Validate channel exists.
	ch, err := c.hub.DB.GetChannelByID(p.ChannelID)
	if err != nil || ch == nil {
		c.sendError("channel not found")
		return
	}

	// Persist message.
	msg := &db.Message{
		ChannelID: p.ChannelID,
		AuthorID:  c.userID,
		Content:   p.Content,
		Type:      p.Type,
		ThreadID:  p.ThreadID,
	}
	if err := c.hub.DB.CreateMessage(msg); err != nil {
		slog.Error("ws: create message failed", "error", err)
		c.sendError("failed to create message")
		return
	}

	newPayload := MessageNewPayload{
		ID:        msg.ID,
		ChannelID: msg.ChannelID,
		AuthorID:  msg.AuthorID,
		Username:  c.username,
		Content:   p.Content,
		Type:      msg.Type,
		ThreadID:  msg.ThreadID,
		CreatedAt: msg.CreatedAt.Format(time.RFC3339),
	}

	evt, err := MakeEvent(EventMessageNew, newPayload)
	if err != nil {
		slog.Error("ws: make event failed", "error", err)
		return
	}

	// Send to sender (with server-assigned ID).
	c.SendEvent(evt)
	// Broadcast to other channel subscribers.
	c.hub.BroadcastToChannel(p.ChannelID, evt, c)

	// Replicate to federation mesh.
	if c.hub.OnMessageSend != nil {
		c.hub.OnMessageSend(msg, c.username)
	}
}

func (c *Client) handleMessageEdit(p MessageEditPayload) {
	if p.MessageID == "" || p.Content == "" {
		c.sendError("message_id and content are required")
		return
	}

	msg, err := c.hub.DB.GetMessageByID(p.MessageID)
	if err != nil || msg == nil {
		c.sendError("message not found")
		return
	}
	if msg.AuthorID != c.userID {
		c.sendError("only the author can edit this message")
		return
	}

	if err := c.hub.DB.UpdateMessageContent(p.MessageID, p.Content); err != nil {
		slog.Error("ws: update message failed", "error", err)
		c.sendError("failed to update message")
		return
	}

	evt, err := MakeEvent(EventMessageUpdated, map[string]string{
		"message_id": p.MessageID,
		"channel_id": msg.ChannelID,
		"content":    p.Content,
		"edited_at":  time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return
	}
	c.hub.BroadcastToChannel(msg.ChannelID, evt, nil)

	// Replicate edit to federation mesh.
	if c.hub.OnMessageEdit != nil {
		c.hub.OnMessageEdit(p.MessageID, msg.ChannelID, p.Content)
	}
}

func (c *Client) handleMessageDelete(p MessageDeletePayload) {
	if p.MessageID == "" {
		c.sendError("message_id is required")
		return
	}

	msg, err := c.hub.DB.GetMessageByID(p.MessageID)
	if err != nil || msg == nil {
		c.sendError("message not found")
		return
	}

	// Author or admin can delete.
	if msg.AuthorID != c.userID {
		user, err := c.hub.DB.GetUserByID(c.userID)
		if err != nil || user == nil || !user.IsAdmin {
			c.sendError("only the author or an admin can delete this message")
			return
		}
	}

	if err := c.hub.DB.SoftDeleteMessage(p.MessageID); err != nil {
		slog.Error("ws: delete message failed", "error", err)
		c.sendError("failed to delete message")
		return
	}

	evt, err := MakeEvent(EventMessageDeleted, map[string]string{
		"message_id": p.MessageID,
		"channel_id": msg.ChannelID,
	})
	if err != nil {
		return
	}
	c.hub.BroadcastToChannel(msg.ChannelID, evt, nil)

	// Replicate deletion to federation mesh.
	if c.hub.OnMessageDelete != nil {
		c.hub.OnMessageDelete(p.MessageID, msg.ChannelID)
	}
}

func (c *Client) handleThreadMessageSend(p ThreadMessageSendPayload) {
	if p.ThreadID == "" || p.Content == "" {
		c.sendError("thread_id and content are required")
		return
	}

	thread, err := c.hub.DB.GetThread(p.ThreadID)
	if err != nil || thread == nil {
		c.sendError("thread not found")
		return
	}

	msg, err := c.hub.DB.CreateThreadMessage(p.ThreadID, c.userID, p.Content, p.Nonce)
	if err != nil {
		slog.Error("ws: create thread message failed", "error", err)
		c.sendError("failed to create thread message")
		return
	}

	evt, err := MakeEvent(EventThreadMessageNew, ThreadMessageNewPayload{
		ID:        msg.ID,
		ThreadID:  p.ThreadID,
		ChannelID: msg.ChannelID,
		AuthorID:  msg.AuthorID,
		Content:   msg.Content,
		Type:      msg.Type,
		CreatedAt: msg.CreatedAt.Format(time.RFC3339),
	})
	if err == nil {
		c.SendEvent(evt)
		c.hub.BroadcastToChannel(thread.ChannelID, evt, c)
	}

	// Broadcast thread:updated for message count change.
	updatedThread, _ := c.hub.DB.GetThread(p.ThreadID)
	if updatedThread != nil {
		uEvt, err := MakeEvent(EventThreadUpdated, ThreadUpdatedPayload{
			ID:            updatedThread.ID,
			Title:         updatedThread.Title,
			MessageCount:  updatedThread.MessageCount,
			LastMessageAt: updatedThread.LastMessageAt,
		})
		if err == nil {
			c.hub.BroadcastToChannel(thread.ChannelID, uEvt, nil)
		}
	}

	// Replicate to federation mesh.
	if c.hub.OnThreadMessageSend != nil {
		c.hub.OnThreadMessageSend(msg, p.ThreadID)
	}
}

func (c *Client) handleThreadMessageEdit(p ThreadMessageEditPayload) {
	if p.ThreadID == "" || p.MessageID == "" || p.Content == "" {
		c.sendError("thread_id, message_id and content are required")
		return
	}

	msg, err := c.hub.DB.GetMessageByID(p.MessageID)
	if err != nil || msg == nil || msg.ThreadID != p.ThreadID {
		c.sendError("message not found in this thread")
		return
	}
	if msg.AuthorID != c.userID {
		c.sendError("only the author can edit this message")
		return
	}

	if err := c.hub.DB.UpdateMessageContent(p.MessageID, p.Content); err != nil {
		slog.Error("ws: update thread message failed", "error", err)
		c.sendError("failed to update thread message")
		return
	}

	thread, _ := c.hub.DB.GetThread(p.ThreadID)
	if thread != nil {
		evt, err := MakeEvent(EventThreadMessageUpdated, ThreadMessageUpdatedPayload{
			ID:       p.MessageID,
			ThreadID: p.ThreadID,
			Content:  p.Content,
			EditedAt: time.Now().UTC().Format(time.RFC3339),
		})
		if err == nil {
			c.hub.BroadcastToChannel(thread.ChannelID, evt, nil)
		}

		if c.hub.OnThreadMessageEdit != nil {
			c.hub.OnThreadMessageEdit(p.MessageID, p.ThreadID, p.Content)
		}
	}
}

func (c *Client) handleThreadMessageRemove(p ThreadMessageRemovePayload) {
	if p.ThreadID == "" || p.MessageID == "" {
		c.sendError("thread_id and message_id are required")
		return
	}

	msg, err := c.hub.DB.GetMessageByID(p.MessageID)
	if err != nil || msg == nil || msg.ThreadID != p.ThreadID {
		c.sendError("message not found in this thread")
		return
	}

	// Author or admin can delete.
	if msg.AuthorID != c.userID {
		user, err := c.hub.DB.GetUserByID(c.userID)
		if err != nil || user == nil || !user.IsAdmin {
			c.sendError("only the author or an admin can delete this message")
			return
		}
	}

	if err := c.hub.DB.SoftDeleteMessage(p.MessageID); err != nil {
		slog.Error("ws: delete thread message failed", "error", err)
		c.sendError("failed to delete thread message")
		return
	}

	thread, _ := c.hub.DB.GetThread(p.ThreadID)
	if thread != nil {
		evt, err := MakeEvent(EventThreadMessageDeleted, ThreadMessageDeletedPayload{
			ID:       p.MessageID,
			ThreadID: p.ThreadID,
		})
		if err == nil {
			c.hub.BroadcastToChannel(thread.ChannelID, evt, nil)
		}

		if c.hub.OnThreadMessageDelete != nil {
			c.hub.OnThreadMessageDelete(p.MessageID, p.ThreadID)
		}
	}
}

func (c *Client) handleTypingStart(p TypingPayload) {
	if p.ChannelID == "" {
		return
	}

	// Throttle: at most once per typingCooldown seconds per user per channel.
	key := p.ChannelID + ":" + c.userID
	now := time.Now().Unix()

	c.hub.typingMu.Lock()
	last, ok := c.hub.typingThrottle[key]
	if ok && now-last < typingCooldown {
		c.hub.typingMu.Unlock()
		return
	}
	c.hub.typingThrottle[key] = now
	c.hub.typingMu.Unlock()

	evt, err := MakeEvent(EventTypingIndicator, p)
	if err != nil {
		return
	}
	c.hub.BroadcastToChannel(p.ChannelID, evt, c)
}

func (c *Client) handleChannelJoin(channelID string) {
	if channelID == "" {
		c.sendError("channel_id is required")
		return
	}
	// Verify the channel belongs to the user's team before subscribing.
	ch, err := c.hub.DB.GetChannelByID(channelID)
	if err != nil || ch == nil {
		c.sendError("channel not found")
		return
	}
	if ch.TeamID != c.teamID {
		c.sendError("channel does not belong to your team")
		return
	}
	c.hub.subscribe <- &Subscription{Client: c, ChannelID: channelID}
}

func (c *Client) handleChannelLeave(channelID string) {
	if channelID == "" {
		return
	}
	c.hub.unsubscribe <- &Subscription{Client: c, ChannelID: channelID}
}

func (c *Client) handlePresenceUpdate(p PresenceUpdatePayload) {
	valid := map[string]bool{"online": true, "idle": true, "dnd": true, "offline": true}
	if !valid[p.StatusType] {
		c.sendError("invalid status_type")
		return
	}

	// Always stamp the user_id from the authenticated connection
	p.UserID = c.userID

	// Delegate to the presence manager if wired up; otherwise fall back to direct DB + broadcast.
	if c.hub.OnPresenceUpdate != nil {
		c.hub.OnPresenceUpdate(c.userID, p.StatusType, p.StatusText)
		return
	}

	if err := c.hub.DB.UpdateUserStatus(c.userID, p.StatusType, p.StatusText); err != nil {
		slog.Error("ws: update presence failed", "error", err)
		c.sendError("failed to update presence")
		return
	}

	evt, err := MakeEvent(EventPresenceChanged, p)
	if err != nil {
		return
	}
	for client := range c.hub.clients {
		if client != c {
			client.SendEvent(evt)
		}
	}
	c.SendEvent(evt)
}

// handleRequest dispatches WS request/response data fetching.
func (c *Client) handleRequest(req RequestEvent) {
	slog.Info("ws: request received", "action", req.Action, "id", req.ID, "user_id", c.userID)
	switch req.Action {
	case ActionSyncInit:
		c.handleSyncInit(req)
	case ActionMessageList:
		c.handleMessagesList(req)
	case ActionThreadList:
		c.handleThreadsList(req)
	case ActionThreadMessages:
		c.handleThreadMessages(req)
	case ActionDMList:
		c.handleDMList(req)
	case ActionDMMessages:
		c.handleDMMessages(req)
	default:
		c.sendResponse(req.ID, req.Action, false, nil, "unknown action: "+req.Action)
	}
}

func (c *Client) sendResponse(id, action string, ok bool, payload interface{}, errMsg string) {
	resp := ResponseEvent{
		ID:      id,
		Action:  action,
		OK:      ok,
		Payload: payload,
		Error:   errMsg,
	}
	evt, err := MakeEvent(EventResponse, resp)
	if err != nil {
		slog.Error("ws: marshal response failed", "error", err)
		return
	}
	c.SendEvent(evt)
}

// handleSyncInit returns channels, members, roles, and presences in one response.
func (c *Client) handleSyncInit(req RequestEvent) {
	teamID := c.teamID
	if teamID == "" {
		c.sendResponse(req.ID, req.Action, false, nil, "no team context")
		return
	}

	channels, err := c.hub.DB.GetChannelsByTeam(teamID)
	if err != nil {
		slog.Error("ws: sync:init channels", "error", err)
		channels = nil
	}

	members, err := c.hub.DB.GetMembersByTeam(teamID)
	if err != nil {
		slog.Error("ws: sync:init members", "error", err)
		members = nil
	}

	// Enrich members with user data (username, display_name, roles)
	type enrichedMember struct {
		ID          string    `json:"id"`
		UserID      string    `json:"user_id"`
		Username    string    `json:"username"`
		DisplayName string    `json:"display_name"`
		Nickname    string    `json:"nickname"`
		Roles       []db.Role `json:"roles"`
		JoinedAt    string    `json:"joined_at"`
	}
	enrichedMembers := make([]enrichedMember, 0, len(members))
	for _, m := range members {
		user, err := c.hub.DB.GetUserByID(m.UserID)
		if err != nil || user == nil {
			continue
		}
		memberRoles, err := c.hub.DB.GetMemberRoles(m.ID)
		if err != nil || memberRoles == nil {
			memberRoles = []db.Role{}
		}
		enrichedMembers = append(enrichedMembers, enrichedMember{
			ID:          m.ID,
			UserID:      m.UserID,
			Username:    user.Username,
			DisplayName: user.DisplayName,
			Nickname:    m.Nickname,
			Roles:       memberRoles,
			JoinedAt:    m.JoinedAt.UTC().Format("2006-01-02 15:04:05"),
		})
	}

	roles, err := c.hub.DB.GetRolesByTeam(teamID)
	if err != nil {
		slog.Error("ws: sync:init roles", "error", err)
		roles = nil
	}

	team, err := c.hub.DB.GetTeam(teamID)
	if err != nil {
		slog.Error("ws: sync:init team", "error", err)
	}

	var presences interface{}
	if c.hub.GetAllPresences != nil {
		presences = c.hub.GetAllPresences()
	}

	// Collect voice channel occupants so clients can see who's in voice.
	var voiceStates map[string][]voice.VoicePeer
	if c.hub.VoiceRoomManager != nil {
		voiceStates = c.hub.VoiceRoomManager.GetRoomsByTeam(teamID)
	}

	slog.Info("ws: sync:init response", "channels", len(channels), "members", len(enrichedMembers), "team_id", teamID)
	c.sendResponse(req.ID, req.Action, true, map[string]interface{}{
		"channels":     channels,
		"members":      enrichedMembers,
		"roles":        roles,
		"team":         team,
		"presences":    presences,
		"voice_states": voiceStates,
	}, "")
}

// handleMessagesList returns paginated messages for a channel.
func (c *Client) handleMessagesList(req RequestEvent) {
	var p MessagesListRequest
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		c.sendResponse(req.ID, req.Action, false, nil, "invalid payload")
		return
	}
	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 50
	}
	messages, err := c.hub.DB.GetMessagesByChannel(p.ChannelID, p.Before, p.Limit)
	if err != nil {
		slog.Error("ws: messages:list", "error", err, "channel", p.ChannelID)
		c.sendResponse(req.ID, req.Action, false, nil, "failed to fetch messages")
		return
	}
	c.sendResponse(req.ID, req.Action, true, messages, "")
}

// handleThreadsList returns threads for a channel.
func (c *Client) handleThreadsList(req RequestEvent) {
	var p ThreadsListRequest
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		c.sendResponse(req.ID, req.Action, false, nil, "invalid payload")
		return
	}
	threads, err := c.hub.DB.GetChannelThreads(p.ChannelID, 50, 0)
	if err != nil {
		slog.Error("ws: threads:list", "error", err, "channel", p.ChannelID)
		c.sendResponse(req.ID, req.Action, false, nil, "failed to fetch threads")
		return
	}
	c.sendResponse(req.ID, req.Action, true, threads, "")
}

func (c *Client) handleThreadMessages(req RequestEvent) {
	var p ThreadMessagesRequest
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		c.sendResponse(req.ID, req.Action, false, nil, "invalid payload")
		return
	}
	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 50
	}
	messages, err := c.hub.DB.GetThreadMessages(p.ThreadID, p.Before, p.Limit)
	if err != nil {
		slog.Error("ws: threads:messages", "error", err, "thread", p.ThreadID)
		c.sendResponse(req.ID, req.Action, false, nil, "failed to fetch thread messages")
		return
	}
	if messages == nil {
		messages = []db.Message{}
	}
	c.sendResponse(req.ID, req.Action, true, messages, "")
}

func (c *Client) handleDMList(req RequestEvent) {
	teamID := c.teamID
	if teamID == "" {
		c.sendResponse(req.ID, req.Action, false, nil, "no team context")
		return
	}
	channels, err := c.hub.DB.GetUserDMChannels(teamID, c.userID)
	if err != nil {
		slog.Error("ws: dms:list", "error", err, "user", c.userID)
		c.sendResponse(req.ID, req.Action, false, nil, "failed to fetch DM channels")
		return
	}
	if channels == nil {
		channels = []db.DMChannel{}
	}

	type dmChannelResponse struct {
		db.DMChannel
		Members     []db.DMMember `json:"members"`
		LastMessage *db.Message   `json:"last_message,omitempty"`
	}
	results := make([]dmChannelResponse, 0, len(channels))
	for _, ch := range channels {
		resp := dmChannelResponse{DMChannel: ch}
		resp.Members, _ = c.hub.DB.GetDMMembers(ch.ID)
		resp.LastMessage, _ = c.hub.DB.GetLastDMMessage(ch.ID)
		results = append(results, resp)
	}
	c.sendResponse(req.ID, req.Action, true, map[string]interface{}{
		"dm_channels": results,
	}, "")
}

func (c *Client) handleDMMessages(req RequestEvent) {
	var p DMMessagesRequest
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		c.sendResponse(req.ID, req.Action, false, nil, "invalid payload")
		return
	}
	if p.Limit <= 0 || p.Limit > 100 {
		p.Limit = 50
	}
	messages, err := c.hub.DB.GetDMMessages(p.DMID, p.Before, p.Limit)
	if err != nil {
		slog.Error("ws: dms:messages", "error", err, "dm", p.DMID)
		c.sendResponse(req.ID, req.Action, false, nil, "failed to fetch DM messages")
		return
	}
	if messages == nil {
		messages = []db.Message{}
	}
	c.sendResponse(req.ID, req.Action, true, messages, "")
}

// handleReactionAdd adds a reaction via WS.
func (c *Client) handleReactionAdd(p ReactionRequestPayload) {
	_, err := c.hub.DB.AddReaction(p.MessageID, c.userID, p.Emoji)
	if err != nil {
		slog.Error("ws: reaction:add failed", "error", err)
		c.sendError("failed to add reaction")
		return
	}
	payload := ReactionPayload{
		MessageID: p.MessageID,
		UserID:    c.userID,
		Emoji:     p.Emoji,
		ChannelID: p.ChannelID,
	}
	evt, err := MakeEvent(EventReactionAdded, payload)
	if err != nil {
		return
	}
	c.hub.BroadcastToChannel(p.ChannelID, evt, nil)
}

// handleReactionRemove removes a reaction via WS.
func (c *Client) handleReactionRemove(p ReactionRequestPayload) {
	if err := c.hub.DB.RemoveReaction(p.MessageID, c.userID, p.Emoji); err != nil {
		slog.Error("ws: reaction:remove failed", "error", err)
		c.sendError("failed to remove reaction")
		return
	}
	payload := ReactionPayload{
		MessageID: p.MessageID,
		UserID:    c.userID,
		Emoji:     p.Emoji,
		ChannelID: p.ChannelID,
	}
	evt, err := MakeEvent(EventReactionRemoved, payload)
	if err != nil {
		return
	}
	c.hub.BroadcastToChannel(p.ChannelID, evt, nil)
}
