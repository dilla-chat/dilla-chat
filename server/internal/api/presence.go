package api

import (
	"encoding/json"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
	"github.com/slimcord/slimcord-server/internal/presence"
)

// PresenceHandler handles presence-related HTTP endpoints.
type PresenceHandler struct {
	authSvc  *auth.AuthService
	db       *db.DB
	presence *presence.PresenceManager
}

// NewPresenceHandler creates a new PresenceHandler.
func NewPresenceHandler(authSvc *auth.AuthService, database *db.DB, pm *presence.PresenceManager) *PresenceHandler {
	return &PresenceHandler{
		authSvc:  authSvc,
		db:       database,
		presence: pm,
	}
}

// HandleGetAll returns presences for all team members.
// GET /api/v1/teams/{teamId}/presence
func (h *PresenceHandler) HandleGetAll(w http.ResponseWriter, r *http.Request) {
	teamID := r.PathValue("teamId")
	if teamID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "team_id is required"})
		return
	}

	members, err := h.db.GetMembersByTeam(teamID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to fetch members"})
		return
	}

	type presenceResponse struct {
		UserID       string `json:"user_id"`
		StatusType   string `json:"status_type"`
		CustomStatus string `json:"custom_status"`
		LastActive   string `json:"last_active"`
	}

	results := make([]presenceResponse, 0, len(members))
	for _, m := range members {
		p := h.presence.GetPresence(m.UserID)
		pr := presenceResponse{
			UserID:     m.UserID,
			StatusType: string(presence.StatusOffline),
		}
		if p != nil {
			pr.StatusType = string(p.Status)
			pr.CustomStatus = p.CustomStatus
			pr.LastActive = p.LastActive.UTC().Format("2006-01-02T15:04:05Z")
		}
		results = append(results, pr)
	}

	writeJSON(w, http.StatusOK, results)
}

// HandleGetUser returns the presence for a single user.
// GET /api/v1/teams/{teamId}/presence/{userId}
func (h *PresenceHandler) HandleGetUser(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
		return
	}

	p := h.presence.GetPresence(userID)
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"user_id":       userID,
			"status_type":   string(presence.StatusOffline),
			"custom_status": "",
			"last_active":   "",
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"user_id":       p.UserID,
		"status_type":   string(p.Status),
		"custom_status": p.CustomStatus,
		"last_active":   p.LastActive.UTC().Format("2006-01-02T15:04:05Z"),
	})
}

// HandleUpdateOwn updates the authenticated user's own presence.
// PUT /api/v1/teams/{teamId}/presence
func (h *PresenceHandler) HandleUpdateOwn(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok || userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req struct {
		StatusType   string `json:"status_type"`
		CustomStatus string `json:"custom_status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	valid := map[string]bool{"online": true, "idle": true, "dnd": true, "offline": true}
	if req.StatusType != "" && !valid[req.StatusType] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid status_type"})
		return
	}

	if req.StatusType != "" {
		h.presence.SetStatus(userID, presence.Status(req.StatusType))
		// Persist to DB.
		_ = h.db.UpdateUserStatus(userID, req.StatusType, req.CustomStatus)
	}

	if req.CustomStatus != "" || req.StatusType == "" {
		h.presence.SetCustomStatus(userID, req.CustomStatus)
		// Persist to DB — use existing status type if not provided.
		if req.StatusType == "" {
			p := h.presence.GetPresence(userID)
			if p != nil {
				_ = h.db.UpdateUserStatus(userID, string(p.Status), req.CustomStatus)
			}
		}
	}

	p := h.presence.GetPresence(userID)
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"user_id":       p.UserID,
		"status_type":   string(p.Status),
		"custom_status": p.CustomStatus,
		"last_active":   p.LastActive.UTC().Format("2006-01-02T15:04:05Z"),
	})
}
