package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type InviteHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewInviteHandler(authSvc *auth.AuthService, database *db.DB) *InviteHandler {
	return &InviteHandler{authSvc: authSvc, db: database}
}

// POST /api/v1/teams/{teamId}/invites
func (h *InviteHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req struct {
		MaxUses       *int `json:"max_uses"`
		ExpiresInHours *int `json:"expires_in_hours"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	teamId := r.PathValue("teamId")
	if teamId == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "team_id is required"})
		return
	}
	team, err := h.db.GetTeam(teamId)
	if err != nil || team == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "team not found"})
		return
	}

	// Check if user is admin or if member invites are allowed.
	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}
	if !user.IsAdmin && !team.AllowMemberInvites {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only admins can create invites"})
		return
	}

	invite := &db.Invite{
		TeamID:    team.ID,
		CreatedBy: userID,
		Token:     h.authSvc.GenerateInviteToken(),
		MaxUses:   req.MaxUses,
	}
	if req.ExpiresInHours != nil {
		exp := time.Now().UTC().Add(time.Duration(*req.ExpiresInHours) * time.Hour)
		invite.ExpiresAt = &exp
	}

	if err := h.db.CreateInvite(invite); err != nil {
		slog.Error("create invite failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create invite"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"invite": invite,
		"link":   fmt.Sprintf("/invite/%s", invite.Token),
	})
}

// GET /api/v1/teams/{teamId}/invites
func (h *InviteHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}

	teamId := r.PathValue("teamId")
	if teamId == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "team_id is required"})
		return
	}
	team, err := h.db.GetTeam(teamId)
	if err != nil || team == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "team not found"})
		return
	}

	invites, err := h.db.GetActiveInvitesByTeam(team.ID)
	if err != nil {
		slog.Error("list invites failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list invites"})
		return
	}

	// Non-admins only see their own invites.
	if !user.IsAdmin {
		var filtered []db.Invite
		for _, inv := range invites {
			if inv.CreatedBy == userID {
				filtered = append(filtered, inv)
			}
		}
		invites = filtered
	}

	if invites == nil {
		invites = []db.Invite{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"invites": invites,
	})
}

// DELETE /api/v1/invites/{id}
func (h *InviteHandler) HandleRevoke(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	inviteID := r.PathValue("id")
	if inviteID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invite id is required"})
		return
	}

	invite, err := h.db.GetInviteByID(inviteID)
	if err != nil {
		slog.Error("get invite failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if invite == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invite not found"})
		return
	}

	// Only creator or admin can revoke.
	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}
	if invite.CreatedBy != userID && !user.IsAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not authorized to revoke this invite"})
		return
	}

	if err := h.db.RevokeInvite(inviteID); err != nil {
		slog.Error("revoke invite failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to revoke invite"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// GET /api/v1/invites/{token}/info
func (h *InviteHandler) HandleInfo(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is required"})
		return
	}

	invite, err := h.db.GetInviteByToken(token)
	if err != nil {
		slog.Error("get invite failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if invite == nil || invite.Revoked {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "invite not found or revoked"})
		return
	}
	if invite.ExpiresAt != nil && invite.ExpiresAt.Before(time.Now()) {
		writeJSON(w, http.StatusGone, map[string]string{"error": "invite has expired"})
		return
	}
	if invite.MaxUses != nil && invite.Uses >= *invite.MaxUses {
		writeJSON(w, http.StatusGone, map[string]string{"error": "invite has been fully used"})
		return
	}

	team, err := h.db.GetTeam(invite.TeamID)
	if err != nil || team == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "team not found"})
		return
	}

	creator, err := h.db.GetUserByID(invite.CreatedBy)
	creatorName := "Unknown"
	if err == nil && creator != nil {
		creatorName = creator.Username
	}

	resp := map[string]interface{}{
		"team_id":    team.ID,
		"team_name":  team.Name,
		"created_by": creatorName,
	}
	if invite.ExpiresAt != nil {
		resp["expires_at"] = invite.ExpiresAt
	}

	writeJSON(w, http.StatusOK, resp)
}
