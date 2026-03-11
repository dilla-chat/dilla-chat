package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type MessageHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewMessageHandler(authSvc *auth.AuthService, database *db.DB) *MessageHandler {
	return &MessageHandler{authSvc: authSvc, db: database}
}

// POST /api/v1/channels/{channel_id}/messages — Send encrypted message (auth required)
func (h *MessageHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
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

	var req struct {
		Content  string `json:"content"`
		Type     string `json:"type"`
		ThreadID string `json:"thread_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content is required"})
		return
	}
	if req.Type == "" {
		req.Type = "text"
	}
	if req.Type != "text" && req.Type != "file" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "type must be 'text' or 'file'"})
		return
	}

	msg := &db.Message{
		ChannelID: channelID,
		AuthorID:  userID,
		Content:   req.Content,
		Type:      req.Type,
		ThreadID:  req.ThreadID,
	}
	if err := h.db.CreateMessage(msg); err != nil {
		slog.Error("create message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create message"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"message": msg,
	})
}

// GET /api/v1/channels/{channel_id}/messages — Get message history (auth required)
func (h *MessageHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channel_id")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id is required"})
		return
	}

	before := r.URL.Query().Get("before")
	limitStr := r.URL.Query().Get("limit")
	limit := 50
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	messages, err := h.db.GetMessagesByChannel(channelID, before, limit)
	if err != nil {
		slog.Error("get messages failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get messages"})
		return
	}
	if messages == nil {
		messages = []db.Message{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"messages": messages,
	})
}

// PATCH /api/v1/channels/{channel_id}/messages/{message_id} — Edit message (auth required, author only)
func (h *MessageHandler) HandleEdit(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	messageID := r.PathValue("message_id")
	if messageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message_id is required"})
		return
	}

	msg, err := h.db.GetMessageByID(messageID)
	if err != nil {
		slog.Error("get message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if msg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found"})
		return
	}
	if msg.AuthorID != userID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the author can edit this message"})
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content is required"})
		return
	}

	if err := h.db.UpdateMessageContent(messageID, req.Content); err != nil {
		slog.Error("update message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update message"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DELETE /api/v1/channels/{channel_id}/messages/{message_id} — Delete message (auth required, author or admin)
func (h *MessageHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	messageID := r.PathValue("message_id")
	if messageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message_id is required"})
		return
	}

	msg, err := h.db.GetMessageByID(messageID)
	if err != nil {
		slog.Error("get message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if msg == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found"})
		return
	}

	// Author or admin can delete.
	if msg.AuthorID != userID {
		user, err := h.db.GetUserByID(userID)
		if err != nil || user == nil || !user.IsAdmin {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the author or an admin can delete this message"})
			return
		}
	}

	if err := h.db.SoftDeleteMessage(messageID); err != nil {
		slog.Error("delete message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete message"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
