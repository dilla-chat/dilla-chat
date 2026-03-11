package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
	"github.com/slimcord/slimcord-server/internal/federation"
	"github.com/slimcord/slimcord-server/internal/ws"
)

type DMHandler struct {
	authSvc  *auth.AuthService
	db       *db.DB
	hub      *ws.Hub
	meshNode *federation.MeshNode
}

func NewDMHandler(authSvc *auth.AuthService, database *db.DB, hub *ws.Hub, meshNode *federation.MeshNode) *DMHandler {
	return &DMHandler{authSvc: authSvc, db: database, hub: hub, meshNode: meshNode}
}

// POST /api/v1/teams/{teamId}/dms — create or get existing DM
func (h *DMHandler) HandleCreateOrGet(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	teamID := r.PathValue("teamId")
	if teamID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "teamId is required"})
		return
	}

	var req struct {
		MemberIDs []string `json:"member_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Ensure the requesting user is included in the member list.
	found := false
	for _, id := range req.MemberIDs {
		if id == userID {
			found = true
			break
		}
	}
	if !found {
		req.MemberIDs = append(req.MemberIDs, userID)
	}

	if len(req.MemberIDs) < 2 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "DM requires at least 2 members"})
		return
	}

	// For 1-on-1 DMs, check if one already exists.
	if len(req.MemberIDs) == 2 {
		existing, err := h.db.GetDMChannelByMembers(teamID, req.MemberIDs)
		if err != nil {
			slog.Error("get DM channel by members failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
			return
		}
		if existing != nil {
			members, _ := h.db.GetDMMembers(existing.ID)
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"dm_channel": existing,
				"members":    members,
				"created":    false,
			})
			return
		}
	}

	ch, err := h.db.CreateDMChannel(teamID, req.MemberIDs)
	if err != nil {
		slog.Error("create DM channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create DM channel"})
		return
	}

	members, _ := h.db.GetDMMembers(ch.ID)

	// Notify all members via WebSocket.
	memberIDs := make([]string, len(members))
	for i, m := range members {
		memberIDs[i] = m.UserID
	}
	evt, err := ws.MakeEvent(ws.EventDMCreated, ws.DMCreatedPayload{
		ID:        ch.ID,
		TeamID:    teamID,
		Type:      ch.Type,
		MemberIDs: memberIDs,
		CreatedAt: ch.CreatedAt.Format(time.RFC3339),
	})
	if err == nil {
		for _, mid := range memberIDs {
			h.hub.SendToUser(mid, evt)
		}
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"dm_channel": ch,
		"members":    members,
		"created":    true,
	})
}

// GET /api/v1/teams/{teamId}/dms — list user's DM channels
func (h *DMHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	teamID := r.PathValue("teamId")
	if teamID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "teamId is required"})
		return
	}

	channels, err := h.db.GetUserDMChannels(teamID, userID)
	if err != nil {
		slog.Error("get user DM channels failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get DM channels"})
		return
	}
	if channels == nil {
		channels = []db.DMChannel{}
	}

	// Enrich with members and last message preview.
	type dmChannelResponse struct {
		db.DMChannel
		Members     []db.DMMember `json:"members"`
		LastMessage *db.Message   `json:"last_message,omitempty"`
	}

	results := make([]dmChannelResponse, 0, len(channels))
	for _, ch := range channels {
		resp := dmChannelResponse{DMChannel: ch}
		resp.Members, _ = h.db.GetDMMembers(ch.ID)
		resp.LastMessage, _ = h.db.GetLastDMMessage(ch.ID)
		results = append(results, resp)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"dm_channels": results,
	})
}

// GET /api/v1/teams/{teamId}/dms/{dmId} — get DM channel details
func (h *DMHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	if dmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId is required"})
		return
	}

	ch, err := h.db.GetDMChannel(dmID)
	if err != nil {
		slog.Error("get DM channel failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if ch == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "DM channel not found"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
		return
	}

	members, _ := h.db.GetDMMembers(dmID)

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"dm_channel": ch,
		"members":    members,
	})
}

// POST /api/v1/teams/{teamId}/dms/{dmId}/messages — send DM message
func (h *DMHandler) HandleSendMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	if dmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId is required"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
		return
	}

	var req struct {
		Content string `json:"content"`
		Type    string `json:"type"`
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

	msg := &db.Message{
		DMChannelID: dmID,
		AuthorID:    userID,
		Content:     req.Content,
		Type:        req.Type,
	}
	if err := h.db.CreateDMMessage(msg); err != nil {
		slog.Error("create DM message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create message"})
		return
	}

	// Get author username for the event.
	author, _ := h.db.GetUserByID(userID)
	username := ""
	if author != nil {
		username = author.Username
	}

	// Notify DM members via WebSocket.
	members, _ := h.db.GetDMMembers(dmID)
	evt, err := ws.MakeEvent(ws.EventDMMessageNew, ws.DMMessageNewPayload{
		ID:          msg.ID,
		DMChannelID: dmID,
		AuthorID:    userID,
		Username:    username,
		Content:     req.Content,
		Type:        req.Type,
		CreatedAt:   msg.CreatedAt.Format(time.RFC3339),
	})
	if err == nil {
		for _, m := range members {
			if m.UserID != userID {
				h.hub.SendToUser(m.UserID, evt)
			}
		}
	}

	// Federation: broadcast DM message to peers.
	if h.meshNode != nil {
		h.broadcastDMMessageFederation(msg, username)
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"message": msg,
	})
}

// GET /api/v1/teams/{teamId}/dms/{dmId}/messages — get DM message history
func (h *DMHandler) HandleListMessages(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	if dmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId is required"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
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

	messages, err := h.db.GetDMMessages(dmID, before, limit)
	if err != nil {
		slog.Error("get DM messages failed", "error", err)
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

// PUT /api/v1/teams/{teamId}/dms/{dmId}/messages/{msgId} — edit DM message
func (h *DMHandler) HandleEditMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	msgID := r.PathValue("msgId")
	if dmID == "" || msgID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId and msgId are required"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
		return
	}

	msg, err := h.db.GetMessageByID(msgID)
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

	if err := h.db.UpdateMessageContent(msgID, req.Content); err != nil {
		slog.Error("update DM message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update message"})
		return
	}

	// Notify DM members.
	members, _ := h.db.GetDMMembers(dmID)
	evt, err := ws.MakeEvent(ws.EventDMMessageUpdated, ws.DMMessageUpdatedPayload{
		ID:          msgID,
		DMChannelID: dmID,
		Content:     req.Content,
		EditedAt:    time.Now().UTC().Format(time.RFC3339),
	})
	if err == nil {
		for _, m := range members {
			if m.UserID != userID {
				h.hub.SendToUser(m.UserID, evt)
			}
		}
	}

	// Federation
	if h.meshNode != nil {
		h.meshNode.BroadcastMessageEdit(msgID, dmID, req.Content)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DELETE /api/v1/teams/{teamId}/dms/{dmId}/messages/{msgId} — delete DM message
func (h *DMHandler) HandleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	msgID := r.PathValue("msgId")
	if dmID == "" || msgID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId and msgId are required"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
		return
	}

	msg, err := h.db.GetMessageByID(msgID)
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
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the author can delete this message"})
		return
	}

	if err := h.db.SoftDeleteMessage(msgID); err != nil {
		slog.Error("delete DM message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete message"})
		return
	}

	// Notify DM members.
	members, _ := h.db.GetDMMembers(dmID)
	evt, err := ws.MakeEvent(ws.EventDMMessageDeleted, ws.DMMessageDeletedPayload{
		ID:          msgID,
		DMChannelID: dmID,
	})
	if err == nil {
		for _, m := range members {
			if m.UserID != userID {
				h.hub.SendToUser(m.UserID, evt)
			}
		}
	}

	// Federation
	if h.meshNode != nil {
		h.meshNode.BroadcastMessageDelete(msgID, dmID)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// POST /api/v1/teams/{teamId}/dms/{dmId}/members — add members to group DM
func (h *DMHandler) HandleAddMembers(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	if dmID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId is required"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
		return
	}

	ch, err := h.db.GetDMChannel(dmID)
	if err != nil || ch == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "DM channel not found"})
		return
	}

	// Only group DMs allow adding members; upgrade 1-on-1 to group_dm.
	var req struct {
		UserIDs []string `json:"user_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if len(req.UserIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_ids is required"})
		return
	}

	if err := h.db.AddDMMembers(dmID, req.UserIDs); err != nil {
		slog.Error("add DM members failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to add members"})
		return
	}

	members, _ := h.db.GetDMMembers(dmID)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"members": members,
	})
}

// DELETE /api/v1/teams/{teamId}/dms/{dmId}/members/{userId} — leave/remove from group DM
func (h *DMHandler) HandleRemoveMember(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	dmID := r.PathValue("dmId")
	targetUserID := r.PathValue("userId")
	if dmID == "" || targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "dmId and userId are required"})
		return
	}

	// Users can only remove themselves from group DMs.
	if targetUserID != userID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "can only remove yourself from a DM"})
		return
	}

	isMember, err := h.db.IsDMMember(dmID, userID)
	if err != nil || !isMember {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this DM"})
		return
	}

	if err := h.db.RemoveDMMember(dmID, targetUserID); err != nil {
		slog.Error("remove DM member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to remove member"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// broadcastDMMessageFederation sends a DM message to federation peers.
func (h *DMHandler) broadcastDMMessageFederation(msg *db.Message, username string) {
	repMsg := &federation.ReplicationMessage{
		MessageID: msg.ID,
		ChannelID: msg.DMChannelID,
		AuthorID:  msg.AuthorID,
		Username:  username,
		Content:   msg.Content,
		Type:      msg.Type,
		CreatedAt: msg.CreatedAt.Format(time.RFC3339),
	}
	h.meshNode.BroadcastMessage(repMsg)
}
