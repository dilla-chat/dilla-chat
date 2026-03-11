package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type ChannelHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewChannelHandler(authSvc *auth.AuthService, database *db.DB) *ChannelHandler {
	return &ChannelHandler{authSvc: authSvc, db: database}
}

// GET /api/v1/teams/{teamId}/channels
func (h *ChannelHandler) HandleList(w http.ResponseWriter, r *http.Request) {
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

	channels, err := h.db.GetChannelsByTeam(team.ID)
	if err != nil {
		slog.Error("list channels failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list channels"})
		return
	}
	if channels == nil {
		channels = []db.Channel{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"channels": channels})
}

// POST /api/v1/teams/{teamId}/channels
func (h *ChannelHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
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

	hasPerm, err := h.db.UserHasPermission(team.ID, userID, db.PermManageChannels)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage channels permission required"})
		return
	}

	var req struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		Topic    string `json:"topic"`
		Category string `json:"category"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	if req.Type == "" {
		req.Type = "text"
	}
	if req.Type != "text" && req.Type != "voice" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type must be 'text' or 'voice'"})
		return
	}

	channel := &db.Channel{
		TeamID:    team.ID,
		Name:      req.Name,
		Topic:     req.Topic,
		Type:      req.Type,
		Category:  req.Category,
		CreatedBy: userID,
	}
	if err := h.db.CreateChannel(channel); err != nil {
		slog.Error("create channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create channel"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"channel": channel})
}

// GET /api/v1/channels/{channel_id}
func (h *ChannelHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channel_id")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id is required"})
		return
	}

	channel, err := h.db.GetChannelByID(channelID)
	if err != nil {
		slog.Error("get channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if channel == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "channel not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"channel": channel})
}

// PATCH /api/v1/channels/{channel_id}
func (h *ChannelHandler) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	channelID := r.PathValue("channel_id")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id is required"})
		return
	}

	channel, err := h.db.GetChannelByID(channelID)
	if err != nil {
		slog.Error("get channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if channel == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "channel not found"})
		return
	}

	hasPerm, err := h.db.UserHasPermission(channel.TeamID, userID, db.PermManageChannels)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage channels permission required"})
		return
	}

	var req struct {
		Name     *string `json:"name"`
		Topic    *string `json:"topic"`
		Position *int    `json:"position"`
		Category *string `json:"category"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Name != nil {
		channel.Name = *req.Name
	}
	if req.Topic != nil {
		channel.Topic = *req.Topic
	}
	if req.Position != nil {
		channel.Position = *req.Position
	}
	if req.Category != nil {
		channel.Category = *req.Category
	}

	if err := h.db.UpdateChannel(channel); err != nil {
		slog.Error("update channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update channel"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"channel": channel})
}

// DELETE /api/v1/channels/{channel_id}
func (h *ChannelHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	channelID := r.PathValue("channel_id")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id is required"})
		return
	}

	channel, err := h.db.GetChannelByID(channelID)
	if err != nil {
		slog.Error("get channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if channel == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "channel not found"})
		return
	}

	// Admin only for channel deletion.
	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}
	if !user.IsAdmin {
		hasPerm, err := h.db.UserHasPermission(channel.TeamID, userID, db.PermAdmin)
		if err != nil || !hasPerm {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin permission required"})
			return
		}
	}

	if err := h.db.DeleteChannel(channelID); err != nil {
		slog.Error("delete channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete channel"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
