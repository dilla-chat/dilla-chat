package federation

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Federation event types for node-to-node communication.
const (
	FedEventMessageNew    = "fed:message:new"
	FedEventMessageEdit   = "fed:message:edit"
	FedEventMessageDelete = "fed:message:delete"
	FedEventMemberJoined  = "fed:member:joined"
	FedEventMemberLeft    = "fed:member:left"
	FedEventPrekeyBundle  = "fed:prekey:bundle"
	FedEventStateSync     = "fed:state:sync"
	FedEventStateSyncReq  = "fed:state:sync:request"
	FedEventPresence      = "fed:presence"
	FedEventPresenceChanged = "fed:presence:changed"
	FedEventPing          = "fed:ping"
	FedEventPong          = "fed:pong"

	// Thread federation events
	FedEventThreadCreated        = "fed:thread:created"
	FedEventThreadMessageNew     = "fed:thread:message:new"
	FedEventThreadMessageUpdated = "fed:thread:message:updated"
	FedEventThreadMessageDeleted = "fed:thread:message:deleted"
	FedEventThreadUpdated        = "fed:thread:updated"

	// Reaction federation events
	FedEventReactionAdded   = "fed:reaction:added"
	FedEventReactionRemoved = "fed:reaction:removed"

	// Voice federation events
	FedEventVoiceUserJoined = "fed:voice:user-joined"
	FedEventVoiceUserLeft   = "fed:voice:user-left"
)

// FederationEvent is the wire format for inter-node messages.
type FederationEvent struct {
	Type      string          `json:"type"`
	NodeName  string          `json:"node_name"`
	Timestamp uint64          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

// ReplicationMessage represents a message being replicated across the mesh.
type ReplicationMessage struct {
	MessageID string `json:"message_id"`
	ChannelID string `json:"channel_id"`
	AuthorID  string `json:"author_id"`
	Username  string `json:"username"`
	Content   string `json:"content"`
	Type      string `json:"type"`
	ThreadID  string `json:"thread_id"`
	LamportTS uint64 `json:"lamport_ts"`
	CreatedAt string `json:"created_at"`
}

// Transport handles WebSocket connections between federation nodes.
type Transport struct {
	node   *MeshNode
	conns  map[string]*websocket.Conn
	mu     sync.RWMutex
	stopCh chan struct{}
}

var fedUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func NewTransport(node *MeshNode) *Transport {
	return &Transport{
		node:   node,
		conns:  make(map[string]*websocket.Conn),
		stopCh: make(chan struct{}),
	}
}

// ConnectToPeer establishes a WebSocket connection to a peer node.
func (t *Transport) ConnectToPeer(address string) error {
	t.mu.RLock()
	_, exists := t.conns[address]
	t.mu.RUnlock()
	if exists {
		return nil
	}

	url := "ws://" + address + "/federation/ws"
	if t.node.config.TLSCert != "" {
		url = "wss://" + address + "/federation/ws"
	}

	headers := http.Header{
		"X-Node-Name": []string{t.node.config.NodeName},
	}
	if t.node.config.JoinSecret != "" {
		headers.Set("Authorization", "Bearer "+t.node.config.JoinSecret)
	}

	conn, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		return err
	}

	t.mu.Lock()
	t.conns[address] = conn
	t.mu.Unlock()

	go t.readPump(address, conn)

	slog.Info("federation: connected to peer", "address", address)
	return nil
}

// HandleIncoming handles an incoming federation WebSocket connection.
func (t *Transport) HandleIncoming(w http.ResponseWriter, r *http.Request) {
	// Validate federation auth using the JoinSecret as a shared bearer token.
	if t.node.config.JoinSecret != "" {
		authHeader := r.Header.Get("Authorization")
		expected := "Bearer " + t.node.config.JoinSecret
		if authHeader != expected {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			slog.Warn("federation: rejected unauthenticated peer", "addr", r.RemoteAddr)
			return
		}
	}

	conn, err := fedUpgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("federation: ws upgrade failed", "error", err)
		return
	}

	peerName := r.Header.Get("X-Node-Name")
	peerAddr := r.RemoteAddr
	slog.Info("federation: incoming peer connection", "name", peerName, "addr", peerAddr)

	t.mu.Lock()
	t.conns[peerAddr] = conn
	t.mu.Unlock()

	go t.readPump(peerAddr, conn)
}

func (t *Transport) readPump(peerAddr string, conn *websocket.Conn) {
	defer func() {
		t.mu.Lock()
		delete(t.conns, peerAddr)
		t.mu.Unlock()
		conn.Close()
		slog.Info("federation: peer disconnected", "address", peerAddr)
	}()

	conn.SetReadLimit(512 * 1024)
	conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Error("federation: read error", "peer", peerAddr, "error", err)
			}
			return
		}

		var event FederationEvent
		if err := json.Unmarshal(message, &event); err != nil {
			slog.Warn("federation: invalid event from peer", "peer", peerAddr, "error", err)
			continue
		}

		t.node.handleFederationEvent(peerAddr, event)
	}
}

// Send sends an event to a specific peer.
func (t *Transport) Send(peerAddr string, event FederationEvent) error {
	t.mu.RLock()
	conn, ok := t.conns[peerAddr]
	t.mu.RUnlock()
	if !ok {
		return ErrPeerNotConnected
	}

	data, err := json.Marshal(event)
	if err != nil {
		return err
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	return conn.WriteMessage(websocket.TextMessage, data)
}

// Broadcast sends an event to all connected peers.
func (t *Transport) Broadcast(event FederationEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		slog.Error("federation: marshal broadcast failed", "error", err)
		return
	}

	t.mu.RLock()
	peers := make(map[string]*websocket.Conn, len(t.conns))
	for addr, conn := range t.conns {
		peers[addr] = conn
	}
	t.mu.RUnlock()

	for addr, conn := range peers {
		t.mu.Lock()
		err := conn.WriteMessage(websocket.TextMessage, data)
		t.mu.Unlock()
		if err != nil {
			slog.Warn("federation: broadcast to peer failed", "peer", addr, "error", err)
		}
	}
}

func (t *Transport) reconnectLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-t.stopCh:
			return
		case <-ticker.C:
			t.node.mu.RLock()
			peers := make([]string, 0, len(t.node.peers))
			for addr := range t.node.peers {
				peers = append(peers, addr)
			}
			t.node.mu.RUnlock()

			for _, addr := range peers {
				t.mu.RLock()
				_, connected := t.conns[addr]
				t.mu.RUnlock()
				if !connected {
					if err := t.ConnectToPeer(addr); err != nil {
						slog.Debug("federation: reconnect failed", "peer", addr, "error", err)
					}
				}
			}
		}
	}
}

func (t *Transport) pingLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-t.stopCh:
			return
		case <-ticker.C:
			t.mu.RLock()
			for _, conn := range t.conns {
				conn.WriteMessage(websocket.PingMessage, nil)
			}
			t.mu.RUnlock()
		}
	}
}

// Stop closes all peer connections.
func (t *Transport) Stop() {
	close(t.stopCh)

	t.mu.Lock()
	defer t.mu.Unlock()
	for addr, conn := range t.conns {
		conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "node shutting down"))
		conn.Close()
		delete(t.conns, addr)
	}
}

// ConnectedPeers returns the number of connected peers.
func (t *Transport) ConnectedPeers() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.conns)
}
