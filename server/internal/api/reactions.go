package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/federation"
	"github.com/dilla/dilla-server/internal/ws"
)

type ReactionHandler struct {
	authSvc  *auth.AuthService
	db       *db.DB
	hub      *ws.Hub
	meshNode *federation.MeshNode
}

func NewReactionHandler(authSvc *auth.AuthService, database *db.DB, hub *ws.Hub, meshNode *federation.MeshNode) *ReactionHandler {
	return &ReactionHandler{authSvc: authSvc, db: database, hub: hub, meshNode: meshNode}
}

// HandleAddReaction handles PUT /api/v1/teams/{teamId}/channels/{channelId}/messages/{msgId}/reactions/{emoji}
func (h *ReactionHandler) HandleAddReaction(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(string)
	if userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	channelID := r.PathValue("channelId")
	msgID := r.PathValue("msgId")
	emoji := r.PathValue("emoji")
	if channelID == "" || msgID == "" || emoji == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path parameters"})
		return
	}

	reaction, err := h.db.AddReaction(msgID, userID, emoji)
	if err != nil {
		slog.Error("failed to add reaction", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to add reaction"})
		return
	}

	// Broadcast via WebSocket
	payload := ws.ReactionPayload{
		MessageID: msgID,
		UserID:    userID,
		Emoji:     emoji,
		ChannelID: channelID,
	}
	if evt, err := ws.MakeEvent(ws.EventReactionAdded, payload); err == nil {
		h.hub.BroadcastToChannel(channelID, evt, nil)
	}

	// Broadcast via federation
	if h.meshNode != nil {
		h.broadcastFedReaction(federation.FedEventReactionAdded, payload)
	}

	writeJSON(w, http.StatusOK, reaction)
}

// HandleRemoveReaction handles DELETE /api/v1/teams/{teamId}/channels/{channelId}/messages/{msgId}/reactions/{emoji}
func (h *ReactionHandler) HandleRemoveReaction(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(string)
	if userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	channelID := r.PathValue("channelId")
	msgID := r.PathValue("msgId")
	emoji := r.PathValue("emoji")
	if channelID == "" || msgID == "" || emoji == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing path parameters"})
		return
	}

	if err := h.db.RemoveReaction(msgID, userID, emoji); err != nil {
		slog.Error("failed to remove reaction", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to remove reaction"})
		return
	}

	// Broadcast via WebSocket
	payload := ws.ReactionPayload{
		MessageID: msgID,
		UserID:    userID,
		Emoji:     emoji,
		ChannelID: channelID,
	}
	if evt, err := ws.MakeEvent(ws.EventReactionRemoved, payload); err == nil {
		h.hub.BroadcastToChannel(channelID, evt, nil)
	}

	// Broadcast via federation
	if h.meshNode != nil {
		h.broadcastFedReaction(federation.FedEventReactionRemoved, payload)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// HandleGetReactions handles GET /api/v1/teams/{teamId}/channels/{channelId}/messages/{msgId}/reactions
func (h *ReactionHandler) HandleGetReactions(w http.ResponseWriter, r *http.Request) {
	msgID := r.PathValue("msgId")
	if msgID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing message id"})
		return
	}

	groups, err := h.db.GetMessageReactions(msgID)
	if err != nil {
		slog.Error("failed to get reactions", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get reactions"})
		return
	}

	writeJSON(w, http.StatusOK, groups)
}

func (h *ReactionHandler) broadcastFedReaction(eventType string, payload ws.ReactionPayload) {
	data, err := json.Marshal(payload)
	if err != nil {
		slog.Error("failed to marshal federation reaction event", "error", err)
		return
	}
	h.meshNode.BroadcastEvent(federation.FederationEvent{
		Type:    eventType,
		Payload: data,
	})
}
