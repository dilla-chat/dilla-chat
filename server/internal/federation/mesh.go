package federation

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/hashicorp/memberlist"
	"github.com/slimcord/slimcord-server/internal/db"
	"github.com/slimcord/slimcord-server/internal/ws"
)

var ErrPeerNotConnected = errors.New("peer not connected")

const (
	PeerStatusConnected    = "connected"
	PeerStatusDisconnected = "disconnected"
	PeerStatusSyncing      = "syncing"
)

// MeshConfig holds the configuration for a federation mesh node.
type MeshConfig struct {
	NodeName      string
	BindAddr      string
	BindPort      int
	AdvertiseAddr string
	AdvertisePort int
	Peers         []string
	TLSCert       string
	TLSKey        string
}

// Peer represents a remote node in the mesh.
type Peer struct {
	Name      string    `json:"name"`
	Address   string    `json:"address"`
	Status    string    `json:"status"`
	LastSeen  time.Time `json:"last_seen"`
	LamportTS uint64    `json:"lamport_ts"`
}

// MeshNode represents this server instance in the federation.
type MeshNode struct {
	config     *MeshConfig
	memberlist *memberlist.Memberlist
	transport  *Transport
	syncMgr    *SyncManager
	joinMgr    *JoinManager
	identity   *FederatedIdentity
	db         *db.DB
	hub        *ws.Hub
	peers      map[string]*Peer
	mu         sync.RWMutex
	stopCh     chan struct{}
}

// NewMeshNode creates a new federation mesh node.
func NewMeshNode(config *MeshConfig, database *db.DB, hub *ws.Hub) (*MeshNode, error) {
	if config.NodeName == "" {
		hostname, _ := os.Hostname()
		config.NodeName = hostname
	}
	if config.BindAddr == "" {
		config.BindAddr = "0.0.0.0"
	}
	if config.BindPort == 0 {
		config.BindPort = 7946
	}

	node := &MeshNode{
		config: config,
		db:     database,
		hub:    hub,
		peers:  make(map[string]*Peer),
		stopCh: make(chan struct{}),
	}

	node.transport = NewTransport(node)
	node.syncMgr = NewSyncManager(node)
	node.joinMgr = NewJoinManager(node)
	node.identity = NewFederatedIdentity(database)

	return node, nil
}

// Start initializes the memberlist gossip layer and connects to known peers.
func (m *MeshNode) Start() error {
	mlConfig := memberlist.DefaultLANConfig()
	mlConfig.Name = m.config.NodeName
	mlConfig.BindAddr = m.config.BindAddr
	mlConfig.BindPort = m.config.BindPort
	if m.config.AdvertiseAddr != "" {
		mlConfig.AdvertiseAddr = m.config.AdvertiseAddr
	}
	if m.config.AdvertisePort > 0 {
		mlConfig.AdvertisePort = m.config.AdvertisePort
	}
	mlConfig.Delegate = &meshDelegate{node: m}
	mlConfig.Events = &meshEventDelegate{node: m}
	mlConfig.LogOutput = &slogWriter{}

	list, err := memberlist.Create(mlConfig)
	if err != nil {
		return fmt.Errorf("federation: memberlist create failed: %w", err)
	}
	m.memberlist = list

	if len(m.config.Peers) > 0 {
		n, err := list.Join(m.config.Peers)
		if err != nil {
			slog.Warn("federation: initial join failed", "error", err, "peers", m.config.Peers)
		} else {
			slog.Info("federation: joined mesh", "contacted", n)
		}
	}

	go m.transport.reconnectLoop()
	go m.transport.pingLoop()

	slog.Info("federation: mesh node started",
		"name", m.config.NodeName,
		"bind", fmt.Sprintf("%s:%d", m.config.BindAddr, m.config.BindPort),
		"peers", len(m.config.Peers),
	)
	return nil
}

// Stop gracefully leaves the mesh.
func (m *MeshNode) Stop() error {
	close(m.stopCh)
	m.transport.Stop()

	if m.memberlist != nil {
		if err := m.memberlist.Leave(5 * time.Second); err != nil {
			slog.Warn("federation: leave failed", "error", err)
		}
		m.memberlist.Shutdown()
	}

	slog.Info("federation: mesh node stopped")
	return nil
}

// GetPeers returns all known peers and their status.
func (m *MeshNode) GetPeers() []Peer {
	m.mu.RLock()
	defer m.mu.RUnlock()
	peers := make([]Peer, 0, len(m.peers))
	for _, p := range m.peers {
		peers = append(peers, *p)
	}
	return peers
}

// BroadcastMessage sends a replicated message to all peers.
func (m *MeshNode) BroadcastMessage(msg *ReplicationMessage) {
	msg.LamportTS = m.syncMgr.Tick()

	payload, err := json.Marshal(msg)
	if err != nil {
		slog.Error("federation: marshal replication message failed", "error", err)
		return
	}

	evt := FederationEvent{
		Type:      FedEventMessageNew,
		NodeName:  m.config.NodeName,
		Timestamp: msg.LamportTS,
		Payload:   json.RawMessage(payload),
	}
	m.transport.Broadcast(evt)
}

// BroadcastMessageEdit sends a message edit to all peers.
func (m *MeshNode) BroadcastMessageEdit(messageID, channelID, content string) {
	payload, _ := json.Marshal(map[string]interface{}{
		"message_id": messageID,
		"channel_id": channelID,
		"content":    content,
		"lamport_ts": m.syncMgr.Tick(),
	})

	evt := FederationEvent{
		Type:      FedEventMessageEdit,
		NodeName:  m.config.NodeName,
		Timestamp: m.syncMgr.Current(),
		Payload:   json.RawMessage(payload),
	}
	m.transport.Broadcast(evt)
}

// BroadcastMessageDelete sends a message deletion to all peers.
func (m *MeshNode) BroadcastMessageDelete(messageID, channelID string) {
	payload, _ := json.Marshal(map[string]string{
		"message_id": messageID,
		"channel_id": channelID,
	})

	evt := FederationEvent{
		Type:      FedEventMessageDelete,
		NodeName:  m.config.NodeName,
		Timestamp: m.syncMgr.Tick(),
		Payload:   json.RawMessage(payload),
	}
	m.transport.Broadcast(evt)
}

// BroadcastEvent sends a generic federation event to all peers.
func (m *MeshNode) BroadcastEvent(evt FederationEvent) {
	evt.NodeName = m.config.NodeName
	evt.Timestamp = m.syncMgr.Tick()
	m.transport.Broadcast(evt)
}

// FederationWSHandler returns the HTTP handler for federation WebSocket connections.
func (m *MeshNode) FederationWSHandler() http.HandlerFunc {
	return m.transport.HandleIncoming
}

// JoinMgr returns the join manager.
func (m *MeshNode) JoinMgr() *JoinManager {
	return m.joinMgr
}

// SyncMgr returns the sync manager.
func (m *MeshNode) SyncMgr() *SyncManager {
	return m.syncMgr
}

// NodeName returns this node's name.
func (m *MeshNode) NodeName() string {
	return m.config.NodeName
}

// OnFederatedPresence is set by main to handle incoming federated presence changes.
var OnFederatedPresence func(userID, statusType, customStatus string)

// BroadcastVoiceUserJoined notifies all federation peers that a user joined a voice channel.
func (m *MeshNode) BroadcastVoiceUserJoined(channelID, userID, username string) {
	payload, err := json.Marshal(map[string]string{
		"channel_id": channelID,
		"user_id":    userID,
		"username":   username,
	})
	if err != nil {
		slog.Error("federation: marshal voice user joined failed", "error", err)
		return
	}

	evt := FederationEvent{
		Type:      FedEventVoiceUserJoined,
		NodeName:  m.config.NodeName,
		Timestamp: m.syncMgr.Tick(),
		Payload:   json.RawMessage(payload),
	}
	m.transport.Broadcast(evt)
}

// BroadcastVoiceUserLeft notifies all federation peers that a user left a voice channel.
func (m *MeshNode) BroadcastVoiceUserLeft(channelID, userID string) {
	payload, err := json.Marshal(map[string]string{
		"channel_id": channelID,
		"user_id":    userID,
	})
	if err != nil {
		slog.Error("federation: marshal voice user left failed", "error", err)
		return
	}

	evt := FederationEvent{
		Type:      FedEventVoiceUserLeft,
		NodeName:  m.config.NodeName,
		Timestamp: m.syncMgr.Tick(),
		Payload:   json.RawMessage(payload),
	}
	m.transport.Broadcast(evt)
}

// OnFederatedVoiceUserJoined is set by main to handle incoming federated voice join events.
var OnFederatedVoiceUserJoined func(channelID, userID, username string)

// OnFederatedVoiceUserLeft is set by main to handle incoming federated voice leave events.
var OnFederatedVoiceUserLeft func(channelID, userID string)

// BroadcastPresenceChanged sends a presence change to all federation peers.
func (m *MeshNode) BroadcastPresenceChanged(userID, statusType, customStatus string) {
	payload, err := json.Marshal(map[string]string{
		"user_id":       userID,
		"status_type":   statusType,
		"custom_status": customStatus,
	})
	if err != nil {
		slog.Error("federation: marshal presence change failed", "error", err)
		return
	}

	evt := FederationEvent{
		Type:      FedEventPresenceChanged,
		NodeName:  m.config.NodeName,
		Timestamp: m.syncMgr.Tick(),
		Payload:   json.RawMessage(payload),
	}
	m.transport.Broadcast(evt)
}

// handleFederationEvent processes an event received from a peer.
func (m *MeshNode) handleFederationEvent(peerAddr string, event FederationEvent) {
	m.syncMgr.Update(event.Timestamp)

	m.mu.Lock()
	if p, ok := m.peers[peerAddr]; ok {
		p.LastSeen = time.Now()
		p.LamportTS = event.Timestamp
	}
	m.mu.Unlock()

	switch event.Type {
	case FedEventMessageNew:
		m.handleReplicatedMessage(event)
	case FedEventMessageEdit:
		m.handleReplicatedEdit(event)
	case FedEventMessageDelete:
		m.handleReplicatedDelete(event)
	case FedEventStateSyncReq:
		m.syncMgr.HandleStateSyncRequest(peerAddr)
	case FedEventStateSync:
		var data StateSyncData
		if err := json.Unmarshal(event.Payload, &data); err != nil {
			slog.Error("federation: unmarshal state sync failed", "error", err)
			return
		}
		m.syncMgr.HandleStateSyncResponse(&data)
	case FedEventPing:
		pong := FederationEvent{
			Type:      FedEventPong,
			NodeName:  m.config.NodeName,
			Timestamp: m.syncMgr.Tick(),
			Payload:   json.RawMessage(`{}`),
		}
		m.transport.Send(peerAddr, pong)
	case FedEventPong:
		// Already updated LastSeen above.
	case FedEventPresenceChanged:
		m.handleFederatedPresenceChanged(event)
	case FedEventVoiceUserJoined:
		m.handleFederatedVoiceUserJoined(event)
	case FedEventVoiceUserLeft:
		m.handleFederatedVoiceUserLeft(event)
	default:
		slog.Debug("federation: unknown event type", "type", event.Type, "from", event.NodeName)
	}
}

func (m *MeshNode) handleReplicatedMessage(event FederationEvent) {
	var msg ReplicationMessage
	if err := json.Unmarshal(event.Payload, &msg); err != nil {
		slog.Error("federation: unmarshal replicated message failed", "error", err)
		return
	}

	existing, err := m.db.GetMessageByID(msg.MessageID)
	if err == nil && existing != nil {
		return
	}

	dbMsg := &db.Message{
		ID:        msg.MessageID,
		ChannelID: msg.ChannelID,
		AuthorID:  msg.AuthorID,
		Content:   msg.Content,
		Type:      msg.Type,
		ThreadID:  msg.ThreadID,
		LamportTS: int64(msg.LamportTS),
	}
	if err := m.db.CreateMessage(dbMsg); err != nil {
		slog.Warn("federation: create replicated message failed", "id", msg.MessageID, "error", err)
		return
	}

	if m.hub != nil {
		newPayload := ws.MessageNewPayload{
			ID:        msg.MessageID,
			ChannelID: msg.ChannelID,
			AuthorID:  msg.AuthorID,
			Username:  msg.Username,
			Content:   msg.Content,
			Type:      msg.Type,
			ThreadID:  msg.ThreadID,
			CreatedAt: msg.CreatedAt,
		}
		evt, err := ws.MakeEvent(ws.EventMessageNew, newPayload)
		if err == nil {
			m.hub.BroadcastToChannel(msg.ChannelID, evt, nil)
		}
	}
}

func (m *MeshNode) handleReplicatedEdit(event FederationEvent) {
	var data struct {
		MessageID string `json:"message_id"`
		ChannelID string `json:"channel_id"`
		Content   string `json:"content"`
	}
	if err := json.Unmarshal(event.Payload, &data); err != nil {
		return
	}

	if err := m.db.UpdateMessageContent(data.MessageID, data.Content); err != nil {
		slog.Warn("federation: replicated edit failed", "id", data.MessageID, "error", err)
		return
	}

	if m.hub != nil {
		evt, err := ws.MakeEvent(ws.EventMessageUpdated, map[string]string{
			"message_id": data.MessageID,
			"channel_id": data.ChannelID,
			"content":    data.Content,
			"edited_at":  time.Now().UTC().Format(time.RFC3339),
		})
		if err == nil {
			m.hub.BroadcastToChannel(data.ChannelID, evt, nil)
		}
	}
}

func (m *MeshNode) handleReplicatedDelete(event FederationEvent) {
	var data struct {
		MessageID string `json:"message_id"`
		ChannelID string `json:"channel_id"`
	}
	if err := json.Unmarshal(event.Payload, &data); err != nil {
		return
	}

	if err := m.db.SoftDeleteMessage(data.MessageID); err != nil {
		slog.Warn("federation: replicated delete failed", "id", data.MessageID, "error", err)
		return
	}

	if m.hub != nil {
		evt, err := ws.MakeEvent(ws.EventMessageDeleted, map[string]string{
			"message_id": data.MessageID,
			"channel_id": data.ChannelID,
		})
		if err == nil {
			m.hub.BroadcastToChannel(data.ChannelID, evt, nil)
		}
	}
}

func (m *MeshNode) handleFederatedPresenceChanged(event FederationEvent) {
	var data struct {
		UserID       string `json:"user_id"`
		StatusType   string `json:"status_type"`
		CustomStatus string `json:"custom_status"`
	}
	if err := json.Unmarshal(event.Payload, &data); err != nil {
		slog.Warn("federation: unmarshal presence change failed", "error", err)
		return
	}

	if OnFederatedPresence != nil {
		OnFederatedPresence(data.UserID, data.StatusType, data.CustomStatus)
	}
}

func (m *MeshNode) handleFederatedVoiceUserJoined(event FederationEvent) {
	var data struct {
		ChannelID string `json:"channel_id"`
		UserID    string `json:"user_id"`
		Username  string `json:"username"`
	}
	if err := json.Unmarshal(event.Payload, &data); err != nil {
		slog.Warn("federation: unmarshal voice user joined failed", "error", err)
		return
	}

	if OnFederatedVoiceUserJoined != nil {
		OnFederatedVoiceUserJoined(data.ChannelID, data.UserID, data.Username)
	}
}

func (m *MeshNode) handleFederatedVoiceUserLeft(event FederationEvent) {
	var data struct {
		ChannelID string `json:"channel_id"`
		UserID    string `json:"user_id"`
	}
	if err := json.Unmarshal(event.Payload, &data); err != nil {
		slog.Warn("federation: unmarshal voice user left failed", "error", err)
		return
	}

	if OnFederatedVoiceUserLeft != nil {
		OnFederatedVoiceUserLeft(data.ChannelID, data.UserID)
	}
}

// --- memberlist.Delegate implementation ---

type meshDelegate struct {
	node *MeshNode
}

func (d *meshDelegate) NodeMeta(limit int) []byte {
	meta := map[string]string{"name": d.node.config.NodeName}
	data, _ := json.Marshal(meta)
	if len(data) > limit {
		return nil
	}
	return data
}

func (d *meshDelegate) NotifyMsg([]byte) {}

func (d *meshDelegate) GetBroadcasts(overhead, limit int) [][]byte {
	return nil
}

func (d *meshDelegate) LocalState(join bool) []byte {
	state := map[string]interface{}{
		"lamport_ts": d.node.syncMgr.Current(),
		"node_name":  d.node.config.NodeName,
	}
	data, _ := json.Marshal(state)
	return data
}

func (d *meshDelegate) MergeRemoteState(buf []byte, join bool) {
	var state map[string]interface{}
	if err := json.Unmarshal(buf, &state); err != nil {
		return
	}
	if ts, ok := state["lamport_ts"].(float64); ok {
		d.node.syncMgr.Update(uint64(ts))
	}
}

// --- memberlist.EventDelegate implementation ---

type meshEventDelegate struct {
	node *MeshNode
}

func (d *meshEventDelegate) NotifyJoin(n *memberlist.Node) {
	if n.Name == d.node.config.NodeName {
		return
	}

	addr := n.Address()
	slog.Info("federation: node joined", "name", n.Name, "addr", addr)

	d.node.mu.Lock()
	d.node.peers[addr] = &Peer{
		Name:     n.Name,
		Address:  addr,
		Status:   PeerStatusConnected,
		LastSeen: time.Now(),
	}
	d.node.mu.Unlock()

	go func() {
		if err := d.node.transport.ConnectToPeer(addr); err != nil {
			slog.Warn("federation: connect to new peer failed", "addr", addr, "error", err)
		} else {
			d.node.syncMgr.RequestStateSync(addr)
		}
	}()
}

func (d *meshEventDelegate) NotifyLeave(n *memberlist.Node) {
	if n.Name == d.node.config.NodeName {
		return
	}

	addr := n.Address()
	slog.Info("federation: node left", "name", n.Name, "addr", addr)

	d.node.mu.Lock()
	if p, ok := d.node.peers[addr]; ok {
		p.Status = PeerStatusDisconnected
		p.LastSeen = time.Now()
	}
	d.node.mu.Unlock()
}

func (d *meshEventDelegate) NotifyUpdate(n *memberlist.Node) {
	if n.Name == d.node.config.NodeName {
		return
	}
	addr := n.Address()
	d.node.mu.Lock()
	if p, ok := d.node.peers[addr]; ok {
		p.LastSeen = time.Now()
	}
	d.node.mu.Unlock()
}

// slogWriter adapts slog for memberlist's io.Writer log output.
type slogWriter struct{}

func (w *slogWriter) Write(p []byte) (int, error) {
	slog.Debug("memberlist", "msg", string(p))
	return len(p), nil
}
