package federation

import (
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/dilla/dilla-server/internal/db"
)

// SyncManager handles state synchronization between nodes using Lamport clocks.
type SyncManager struct {
	node      *MeshNode
	lamportTS uint64
}

func NewSyncManager(node *MeshNode) *SyncManager {
	return &SyncManager{node: node}
}

// Tick increments and returns the Lamport timestamp.
func (s *SyncManager) Tick() uint64 {
	return atomic.AddUint64(&s.lamportTS, 1)
}

// Update updates the Lamport timestamp based on a received timestamp.
func (s *SyncManager) Update(received uint64) uint64 {
	for {
		current := atomic.LoadUint64(&s.lamportTS)
		newTS := received
		if current > newTS {
			newTS = current
		}
		newTS++
		if atomic.CompareAndSwapUint64(&s.lamportTS, current, newTS) {
			return newTS
		}
	}
}

// Current returns the current Lamport timestamp without incrementing.
func (s *SyncManager) Current() uint64 {
	return atomic.LoadUint64(&s.lamportTS)
}

// RequestStateSync asks a peer for its full state.
func (s *SyncManager) RequestStateSync(peerAddr string) error {
	evt := FederationEvent{
		Type:      FedEventStateSyncReq,
		NodeName:  s.node.config.NodeName,
		Timestamp: s.Tick(),
		Payload:   json.RawMessage(`{}`),
	}
	return s.node.transport.Send(peerAddr, evt)
}

// HandleStateSyncRequest responds to a sync request by sending full state.
func (s *SyncManager) HandleStateSyncRequest(peerAddr string) error {
	database := s.node.db

	team, err := database.GetFirstTeam()
	if err != nil || team == nil {
		slog.Warn("federation: no team found for state sync")
		return s.sendEmptySync(peerAddr)
	}

	channels, _ := database.GetChannelsByTeam(team.ID)
	members, _ := database.GetMembersByTeam(team.ID)
	roles, _ := database.GetRolesByTeam(team.ID)

	var messages []db.Message
	for _, ch := range channels {
		msgs, err := database.GetMessagesByChannel(ch.ID, "", 500)
		if err == nil {
			messages = append(messages, msgs...)
		}
	}

	data := &StateSyncData{
		Channels: channels,
		Messages: messages,
		Members:  members,
		Roles:    roles,
	}

	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}

	evt := FederationEvent{
		Type:      FedEventStateSync,
		NodeName:  s.node.config.NodeName,
		Timestamp: s.Tick(),
		Payload:   json.RawMessage(payload),
	}
	return s.node.transport.Send(peerAddr, evt)
}

func (s *SyncManager) sendEmptySync(peerAddr string) error {
	data := &StateSyncData{}
	payload, _ := json.Marshal(data)
	evt := FederationEvent{
		Type:      FedEventStateSync,
		NodeName:  s.node.config.NodeName,
		Timestamp: s.Tick(),
		Payload:   json.RawMessage(payload),
	}
	return s.node.transport.Send(peerAddr, evt)
}

// HandleStateSyncResponse merges received state into the local database.
func (s *SyncManager) HandleStateSyncResponse(data *StateSyncData) error {
	database := s.node.db

	for i := range data.Channels {
		ch := &data.Channels[i]
		existing, err := database.GetChannelByID(ch.ID)
		if err != nil || existing == nil {
			if err := database.CreateChannel(ch); err != nil {
				slog.Warn("federation: sync create channel failed", "id", ch.ID, "error", err)
			}
		}
	}

	for i := range data.Roles {
		r := &data.Roles[i]
		existing, err := database.GetRoleByID(r.ID)
		if err != nil || existing == nil {
			if err := database.CreateRole(r); err != nil {
				slog.Warn("federation: sync create role failed", "id", r.ID, "error", err)
			}
		}
	}

	for i := range data.Members {
		m := &data.Members[i]
		existing, err := database.GetMemberByUserAndTeam(m.UserID, m.TeamID)
		if err != nil || existing == nil {
			if err := database.CreateMember(m); err != nil {
				slog.Warn("federation: sync create member failed", "id", m.ID, "error", err)
			}
		}
	}

	for i := range data.Messages {
		msg := &data.Messages[i]
		existing, err := database.GetMessageByID(msg.ID)
		if err != nil || existing == nil {
			if err := database.CreateMessage(msg); err != nil {
				slog.Warn("federation: sync create message failed", "id", msg.ID, "error", err)
			}
		}
	}

	slog.Info("federation: state sync complete",
		"channels", len(data.Channels),
		"messages", len(data.Messages),
		"members", len(data.Members),
		"roles", len(data.Roles),
	)
	return nil
}

// StateSyncData holds the full state transferred between nodes.
type StateSyncData struct {
	Users    []db.User    `json:"users,omitempty"`
	Channels []db.Channel `json:"channels,omitempty"`
	Messages []db.Message `json:"messages,omitempty"`
	Members  []db.Member  `json:"members,omitempty"`
	Roles    []db.Role    `json:"roles,omitempty"`
	SentAt   time.Time    `json:"sent_at"`
}
