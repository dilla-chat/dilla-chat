package voice

import (
	"sync"
	"time"
)

type VoicePeer struct {
	UserID        string `json:"user_id"`
	Username      string `json:"username"`
	Muted         bool   `json:"muted"`
	Deafened      bool   `json:"deafened"`
	Speaking      bool   `json:"speaking"`
	ScreenSharing bool   `json:"screen_sharing"`
	WebcamSharing bool   `json:"webcam_sharing"`
}

type VoiceRoom struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	TeamID    string `json:"team_id"`
	mu        sync.RWMutex
	Peers     map[string]*VoicePeer
	Created   time.Time `json:"created"`
}

func (r *VoiceRoom) AddPeer(userID, username string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Peers[userID] = &VoicePeer{UserID: userID, Username: username}
}

func (r *VoiceRoom) RemovePeer(userID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.Peers, userID)
}

func (r *VoiceRoom) GetPeer(userID string) *VoicePeer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if p, ok := r.Peers[userID]; ok {
		cp := *p
		return &cp
	}
	return nil
}

func (r *VoiceRoom) GetPeers() []*VoicePeer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	peers := make([]*VoicePeer, 0, len(r.Peers))
	for _, p := range r.Peers {
		cp := *p
		peers = append(peers, &cp)
	}
	return peers
}

func (r *VoiceRoom) SetMuted(userID string, muted bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.Peers[userID]; ok {
		p.Muted = muted
	}
}

func (r *VoiceRoom) SetDeafened(userID string, deafened bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.Peers[userID]; ok {
		p.Deafened = deafened
	}
}

func (r *VoiceRoom) SetSpeaking(userID string, speaking bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.Peers[userID]; ok {
		p.Speaking = speaking
	}
}

func (r *VoiceRoom) IsEmpty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.Peers) == 0
}

func (r *VoiceRoom) SetScreenSharing(userID string, sharing bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.Peers[userID]; ok {
		p.ScreenSharing = sharing
	}
}

func (r *VoiceRoom) SetWebcamSharing(userID string, sharing bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.Peers[userID]; ok {
		p.WebcamSharing = sharing
	}
}

// ScreenSharer returns the userID of the peer currently screen sharing, or "" if none.
func (r *VoiceRoom) ScreenSharer() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.Peers {
		if p.ScreenSharing {
			return p.UserID
		}
	}
	return ""
}

type RoomManager struct {
	mu    sync.RWMutex
	rooms map[string]*VoiceRoom
}

func NewRoomManager() *RoomManager {
	return &RoomManager{rooms: make(map[string]*VoiceRoom)}
}

func (rm *RoomManager) GetOrCreateRoom(channelID, teamID string) *VoiceRoom {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if r, ok := rm.rooms[channelID]; ok {
		return r
	}
	r := &VoiceRoom{
		ID:        channelID,
		ChannelID: channelID,
		TeamID:    teamID,
		Peers:     make(map[string]*VoicePeer),
		Created:   time.Now(),
	}
	rm.rooms[channelID] = r
	return r
}

func (rm *RoomManager) GetRoom(channelID string) *VoiceRoom {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	return rm.rooms[channelID]
}

func (rm *RoomManager) RemoveRoom(channelID string) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	delete(rm.rooms, channelID)
}

// GetRoomsByTeam returns all active voice rooms for a team.
// Returns a map of channelID → []VoicePeer.
func (rm *RoomManager) GetRoomsByTeam(teamID string) map[string][]VoicePeer {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	result := make(map[string][]VoicePeer)
	for chID, room := range rm.rooms {
		if room.TeamID != teamID {
			continue
		}
		peers := room.GetPeers()
		if len(peers) == 0 {
			continue
		}
		vp := make([]VoicePeer, len(peers))
		for i, p := range peers {
			vp[i] = *p
		}
		result[chID] = vp
	}
	return result
}
func (rm *RoomManager) GetRoomUsers(channelID string) []VoicePeer {
	rm.mu.RLock()
	r, ok := rm.rooms[channelID]
	rm.mu.RUnlock()
	if !ok {
		return nil
	}
	peers := r.GetPeers()
	result := make([]VoicePeer, len(peers))
	for i, p := range peers {
		result[i] = *p
	}
	return result
}
