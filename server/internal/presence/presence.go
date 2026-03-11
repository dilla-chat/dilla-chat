package presence

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// Status represents a user's presence status.
type Status string

const (
	StatusOnline  Status = "online"
	StatusIdle    Status = "idle"
	StatusDND     Status = "dnd"
	StatusOffline Status = "offline"

	defaultIdleTimeout = 5 * time.Minute
)

// UserPresence holds the current presence state for a user.
type UserPresence struct {
	UserID       string    `json:"user_id"`
	Status       Status    `json:"status"`
	CustomStatus string    `json:"custom_status"`
	LastActive   time.Time `json:"last_active"`
}

// Broadcaster is the interface the presence manager uses to send events.
type Broadcaster interface {
	BroadcastToAll(event interface{ MarshalableEvent() })
}

// PresenceEvent is the payload broadcast when presence changes.
type PresenceEvent struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// PresenceChangedPayload is the payload for presence:changed events.
type PresenceChangedPayload struct {
	UserID       string `json:"user_id"`
	StatusType   string `json:"status_type"`
	CustomStatus string `json:"custom_status"`
}

// BroadcastFunc is called when presence changes; set by the hub/main wiring.
type BroadcastFunc func(userID string, statusType string, customStatus string)

// FederationFunc is called to broadcast presence changes to federation peers.
type FederationFunc func(userID string, statusType string, customStatus string)

// PresenceManager tracks user presence in-memory.
type PresenceManager struct {
	mu        sync.RWMutex
	presences map[string]*UserPresence

	OnBroadcast  BroadcastFunc
	OnFederation FederationFunc

	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewPresenceManager creates a new PresenceManager.
func NewPresenceManager() *PresenceManager {
	return &PresenceManager{
		presences: make(map[string]*UserPresence),
		stopCh:    make(chan struct{}),
	}
}

// SetOnline marks a user as online and broadcasts the change.
// If the user already has an explicit status (DND, idle, etc.), it is preserved.
func (pm *PresenceManager) SetOnline(userID string) {
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		p = &UserPresence{
			UserID: userID,
			Status: StatusOnline,
		}
		pm.presences[userID] = p
	} else if p.Status == StatusOffline || p.Status == "" {
		// Only override if currently offline/unset — preserve DND, idle, etc.
		p.Status = StatusOnline
	}
	p.LastActive = time.Now()
	status := string(p.Status)
	customStatus := p.CustomStatus
	pm.mu.Unlock()

	pm.broadcastChange(userID, status, customStatus)
}

// SetOffline marks a user as offline and broadcasts the change.
func (pm *PresenceManager) SetOffline(userID string) {
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		pm.mu.Unlock()
		return
	}
	p.Status = StatusOffline
	p.LastActive = time.Now()
	customStatus := p.CustomStatus
	pm.mu.Unlock()

	pm.broadcastChange(userID, string(StatusOffline), customStatus)
}

// SetStatus sets an explicit status for a user.
func (pm *PresenceManager) SetStatus(userID string, status Status) {
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		p = &UserPresence{
			UserID: userID,
		}
		pm.presences[userID] = p
	}
	p.Status = status
	p.LastActive = time.Now()
	customStatus := p.CustomStatus
	pm.mu.Unlock()

	pm.broadcastChange(userID, string(status), customStatus)
}

// SetCustomStatus sets the custom status text for a user.
func (pm *PresenceManager) SetCustomStatus(userID string, text string) {
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		p = &UserPresence{
			UserID: userID,
			Status: StatusOnline,
		}
		pm.presences[userID] = p
	}
	p.CustomStatus = text
	p.LastActive = time.Now()
	status := p.Status
	pm.mu.Unlock()

	pm.broadcastChange(userID, string(status), text)
}

// UpdatePresence sets both status and custom status atomically with a single broadcast.
func (pm *PresenceManager) UpdatePresence(userID string, status Status, customStatus string) {
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		p = &UserPresence{
			UserID: userID,
		}
		pm.presences[userID] = p
	}
	p.Status = status
	p.CustomStatus = customStatus
	p.LastActive = time.Now()
	pm.mu.Unlock()

	pm.broadcastChange(userID, string(status), customStatus)
}

// GetPresence returns the current presence for a user, or nil if unknown.
func (pm *PresenceManager) GetPresence(userID string) *UserPresence {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	p, ok := pm.presences[userID]
	if !ok {
		return nil
	}
	cp := *p
	return &cp
}

// GetAllPresences returns a copy of all presences.
func (pm *PresenceManager) GetAllPresences() map[string]*UserPresence {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	result := make(map[string]*UserPresence, len(pm.presences))
	for k, v := range pm.presences {
		cp := *v
		result[k] = &cp
	}
	return result
}

// GetOnlineUsers returns user IDs with a non-offline status.
func (pm *PresenceManager) GetOnlineUsers() []string {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	var users []string
	for uid, p := range pm.presences {
		if p.Status != StatusOffline {
			users = append(users, uid)
		}
	}
	return users
}

// UpdateActivity updates the last active time for a user, promoting idle users back to online.
func (pm *PresenceManager) UpdateActivity(userID string) {
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		pm.mu.Unlock()
		return
	}
	wasIdle := p.Status == StatusIdle
	p.LastActive = time.Now()
	if wasIdle {
		p.Status = StatusOnline
	}
	customStatus := p.CustomStatus
	pm.mu.Unlock()

	if wasIdle {
		pm.broadcastChange(userID, string(StatusOnline), customStatus)
	}
}

// StartIdleChecker starts a goroutine that marks users idle after the default timeout.
func (pm *PresenceManager) StartIdleChecker(interval time.Duration) {
	pm.wg.Add(1)
	go func() {
		defer pm.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-pm.stopCh:
				return
			case <-ticker.C:
				pm.checkIdle()
			}
		}
	}()
}

func (pm *PresenceManager) checkIdle() {
	now := time.Now()
	pm.mu.Lock()
	var idled []struct {
		userID       string
		customStatus string
	}
	for uid, p := range pm.presences {
		if p.Status == StatusOnline && now.Sub(p.LastActive) > defaultIdleTimeout {
			p.Status = StatusIdle
			idled = append(idled, struct {
				userID       string
				customStatus string
			}{uid, p.CustomStatus})
		}
	}
	pm.mu.Unlock()

	for _, u := range idled {
		slog.Debug("presence: user went idle", "user_id", u.userID)
		pm.broadcastChange(u.userID, string(StatusIdle), u.customStatus)
	}
}

// Stop shuts down the idle checker goroutine.
func (pm *PresenceManager) Stop() {
	close(pm.stopCh)
	pm.wg.Wait()
}

func (pm *PresenceManager) broadcastChange(userID, statusType, customStatus string) {
	if pm.OnBroadcast != nil {
		pm.OnBroadcast(userID, statusType, customStatus)
	}
	if pm.OnFederation != nil {
		pm.OnFederation(userID, statusType, customStatus)
	}
}

// HandleFederatedPresence processes a presence change received from a federation peer.
// It updates the local presence map and broadcasts to local WS clients only (no re-federation).
func (pm *PresenceManager) HandleFederatedPresence(userID, statusType, customStatus string) {
	status := Status(statusType)
	pm.mu.Lock()
	p, ok := pm.presences[userID]
	if !ok {
		p = &UserPresence{UserID: userID}
		pm.presences[userID] = p
	}
	p.Status = status
	p.CustomStatus = customStatus
	p.LastActive = time.Now()
	pm.mu.Unlock()

	// Broadcast to local clients only (no federation callback to avoid loops).
	if pm.OnBroadcast != nil {
		pm.OnBroadcast(userID, statusType, customStatus)
	}
}
