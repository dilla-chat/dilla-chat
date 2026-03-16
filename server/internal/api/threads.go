package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/federation"
	"github.com/dilla/dilla-server/internal/ws"
)

type ThreadHandler struct {
	authSvc  *auth.AuthService
	db       *db.DB
	hub      *ws.Hub
	meshNode *federation.MeshNode
}

func NewThreadHandler(authSvc *auth.AuthService, database *db.DB, hub *ws.Hub, meshNode *federation.MeshNode) *ThreadHandler {
	return &ThreadHandler{authSvc: authSvc, db: database, hub: hub, meshNode: meshNode}
}

// POST /api/v1/teams/{teamId}/channels/{channelId}/threads — create thread from message
func (h *ThreadHandler) HandleCreateThread(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	teamID := r.PathValue("teamId")
	channelID := r.PathValue("channelId")
	if teamID == "" || channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "teamId and channelId are required"})
		return
	}

	var req struct {
		ParentMessageID string `json:"parent_message_id"`
		Title           string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.ParentMessageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "parent_message_id is required"})
		return
	}

	// Check if thread already exists for this message.
	existing, err := h.db.GetThreadByParentMessage(req.ParentMessageID)
	if err != nil {
		slog.Error("check existing thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if existing != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{"error": "thread already exists", "thread": existing})
		return
	}

	thread, err := h.db.CreateThread(channelID, req.ParentMessageID, teamID, userID, req.Title)
	if err != nil {
		slog.Error("create thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create thread"})
		return
	}

	// Broadcast thread:created via WebSocket.
	evt, err := ws.MakeEvent(ws.EventThreadCreated, ws.ThreadCreatedPayload{
		ID:              thread.ID,
		ChannelID:       thread.ChannelID,
		ParentMessageID: thread.ParentMessageID,
		TeamID:          thread.TeamID,
		CreatorID:       thread.CreatorID,
		Title:           thread.Title,
		CreatedAt:       thread.CreatedAt,
	})
	if err == nil {
		h.hub.BroadcastToChannel(channelID, evt, nil)
	}

	// Federation broadcast.
	if h.meshNode != nil {
		h.broadcastFedThreadCreated(thread)
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"thread": thread})
}

// GET /api/v1/teams/{teamId}/channels/{channelId}/threads — list channel threads
func (h *ThreadHandler) HandleListThreads(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channelId is required"})
		return
	}

	limit := 50
	offset := 0
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}
	if o, err := strconv.Atoi(r.URL.Query().Get("offset")); err == nil && o >= 0 {
		offset = o
	}

	threads, err := h.db.GetChannelThreads(channelID, limit, offset)
	if err != nil {
		slog.Error("list threads failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list threads"})
		return
	}
	if threads == nil {
		threads = []db.Thread{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"threads": threads})
}

// GET /api/v1/teams/{teamId}/threads/{threadId} — get thread details
func (h *ThreadHandler) HandleGetThread(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId is required"})
		return
	}

	thread, err := h.db.GetThread(threadID)
	if err != nil {
		slog.Error("get thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if thread == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "thread not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"thread": thread})
}

// PUT /api/v1/teams/{teamId}/threads/{threadId} — update thread (title)
func (h *ThreadHandler) HandleUpdateThread(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	threadID := r.PathValue("threadId")
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId is required"})
		return
	}

	thread, err := h.db.GetThread(threadID)
	if err != nil {
		slog.Error("get thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if thread == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "thread not found"})
		return
	}

	// Only creator or admin can update.
	if thread.CreatorID != userID {
		user, err := h.db.GetUserByID(userID)
		if err != nil || user == nil || !user.IsAdmin {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the creator or an admin can update this thread"})
			return
		}
	}

	var req struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if err := h.db.UpdateThread(threadID, req.Title); err != nil {
		slog.Error("update thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update thread"})
		return
	}

	// Re-fetch to get updated state.
	updated, _ := h.db.GetThread(threadID)
	if updated != nil {
		evt, err := ws.MakeEvent(ws.EventThreadUpdated, ws.ThreadUpdatedPayload{
			ID:            updated.ID,
			Title:         updated.Title,
			MessageCount:  updated.MessageCount,
			LastMessageAt: updated.LastMessageAt,
		})
		if err == nil {
			h.hub.BroadcastToChannel(thread.ChannelID, evt, nil)
		}

		if h.meshNode != nil {
			h.broadcastFedThreadUpdated(updated)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DELETE /api/v1/teams/{teamId}/threads/{threadId} — delete thread (admin/creator)
func (h *ThreadHandler) HandleDeleteThread(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	threadID := r.PathValue("threadId")
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId is required"})
		return
	}

	thread, err := h.db.GetThread(threadID)
	if err != nil {
		slog.Error("get thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if thread == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "thread not found"})
		return
	}

	// Only creator or admin can delete.
	if thread.CreatorID != userID {
		user, err := h.db.GetUserByID(userID)
		if err != nil || user == nil || !user.IsAdmin {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only the creator or an admin can delete this thread"})
			return
		}
	}

	if err := h.db.DeleteThread(threadID); err != nil {
		slog.Error("delete thread failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete thread"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// POST /api/v1/teams/{teamId}/threads/{threadId}/messages — post message in thread
func (h *ThreadHandler) HandleCreateMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	threadID := r.PathValue("threadId")
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId is required"})
		return
	}

	var req struct {
		Content string `json:"content"`
		Nonce   string `json:"nonce"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "content is required"})
		return
	}

	msg, err := h.db.CreateThreadMessage(threadID, userID, req.Content, req.Nonce)
	if err != nil {
		slog.Error("create thread message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create message"})
		return
	}

	// Broadcast thread:message:new via WebSocket.
	thread, _ := h.db.GetThread(threadID)
	if thread != nil {
		evt, err := ws.MakeEvent(ws.EventThreadMessageNew, ws.ThreadMessageNewPayload{
			ID:        msg.ID,
			ThreadID:  threadID,
			ChannelID: msg.ChannelID,
			AuthorID:  msg.AuthorID,
			Content:   msg.Content,
			Type:      msg.Type,
			CreatedAt: msg.CreatedAt.Format(time.RFC3339),
		})
		if err == nil {
			h.hub.BroadcastToChannel(thread.ChannelID, evt, nil)
		}

		// Also broadcast thread:updated for message count change.
		updatedThread, _ := h.db.GetThread(threadID)
		if updatedThread != nil {
			uEvt, err := ws.MakeEvent(ws.EventThreadUpdated, ws.ThreadUpdatedPayload{
				ID:            updatedThread.ID,
				Title:         updatedThread.Title,
				MessageCount:  updatedThread.MessageCount,
				LastMessageAt: updatedThread.LastMessageAt,
			})
			if err == nil {
				h.hub.BroadcastToChannel(thread.ChannelID, uEvt, nil)
			}
		}

		if h.meshNode != nil {
			h.broadcastFedThreadMessageNew(msg, threadID)
		}
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"message": msg})
}

// GET /api/v1/teams/{teamId}/threads/{threadId}/messages — get thread messages (paginated)
func (h *ThreadHandler) HandleListMessages(w http.ResponseWriter, r *http.Request) {
	threadID := r.PathValue("threadId")
	if threadID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId is required"})
		return
	}

	before := r.URL.Query().Get("before")
	limit := 50
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 100 {
		limit = l
	}

	messages, err := h.db.GetThreadMessages(threadID, before, limit)
	if err != nil {
		slog.Error("get thread messages failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get messages"})
		return
	}
	if messages == nil {
		messages = []db.Message{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"messages": messages})
}

// PUT /api/v1/teams/{teamId}/threads/{threadId}/messages/{msgId} — edit thread message
func (h *ThreadHandler) HandleEditMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	threadID := r.PathValue("threadId")
	msgID := r.PathValue("msgId")
	if threadID == "" || msgID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId and msgId are required"})
		return
	}

	msg, err := h.db.GetMessageByID(msgID)
	if err != nil {
		slog.Error("get message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if msg == nil || msg.ThreadID != threadID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found in this thread"})
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
		slog.Error("update message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update message"})
		return
	}

	// Broadcast thread:message:updated.
	thread, _ := h.db.GetThread(threadID)
	if thread != nil {
		evt, err := ws.MakeEvent(ws.EventThreadMessageUpdated, ws.ThreadMessageUpdatedPayload{
			ID:       msgID,
			ThreadID: threadID,
			Content:  req.Content,
			EditedAt: time.Now().UTC().Format(time.RFC3339),
		})
		if err == nil {
			h.hub.BroadcastToChannel(thread.ChannelID, evt, nil)
		}

		if h.meshNode != nil {
			h.broadcastFedThreadMessageUpdated(msgID, threadID, req.Content)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DELETE /api/v1/teams/{teamId}/threads/{threadId}/messages/{msgId} — delete thread message
func (h *ThreadHandler) HandleDeleteMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	threadID := r.PathValue("threadId")
	msgID := r.PathValue("msgId")
	if threadID == "" || msgID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "threadId and msgId are required"})
		return
	}

	msg, err := h.db.GetMessageByID(msgID)
	if err != nil {
		slog.Error("get message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if msg == nil || msg.ThreadID != threadID {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found in this thread"})
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

	if err := h.db.SoftDeleteMessage(msgID); err != nil {
		slog.Error("delete message failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete message"})
		return
	}

	// Broadcast thread:message:deleted.
	thread, _ := h.db.GetThread(threadID)
	if thread != nil {
		evt, err := ws.MakeEvent(ws.EventThreadMessageDeleted, ws.ThreadMessageDeletedPayload{
			ID:       msgID,
			ThreadID: threadID,
		})
		if err == nil {
			h.hub.BroadcastToChannel(thread.ChannelID, evt, nil)
		}

		if h.meshNode != nil {
			h.broadcastFedThreadMessageDeleted(msgID, threadID)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// Federation broadcast helpers

func (h *ThreadHandler) broadcastFedThreadCreated(thread *db.Thread) {
	payload, _ := json.Marshal(map[string]interface{}{
		"thread_id":         thread.ID,
		"channel_id":        thread.ChannelID,
		"parent_message_id": thread.ParentMessageID,
		"team_id":           thread.TeamID,
		"creator_id":        thread.CreatorID,
		"title":             thread.Title,
		"created_at":        thread.CreatedAt,
	})

	evt := federation.FederationEvent{
		Type:    federation.FedEventThreadCreated,
		Payload: json.RawMessage(payload),
	}
	h.meshNode.BroadcastEvent(evt)
}

func (h *ThreadHandler) broadcastFedThreadUpdated(thread *db.Thread) {
	payload, _ := json.Marshal(map[string]interface{}{
		"thread_id":      thread.ID,
		"title":          thread.Title,
		"message_count":  thread.MessageCount,
		"last_message_at": thread.LastMessageAt,
	})

	evt := federation.FederationEvent{
		Type:    federation.FedEventThreadUpdated,
		Payload: json.RawMessage(payload),
	}
	h.meshNode.BroadcastEvent(evt)
}

func (h *ThreadHandler) broadcastFedThreadMessageNew(msg *db.Message, threadID string) {
	payload, _ := json.Marshal(map[string]interface{}{
		"message_id": msg.ID,
		"thread_id":  threadID,
		"channel_id": msg.ChannelID,
		"author_id":  msg.AuthorID,
		"content":    msg.Content,
		"type":       msg.Type,
		"created_at": msg.CreatedAt.Format(time.RFC3339),
	})

	evt := federation.FederationEvent{
		Type:    federation.FedEventThreadMessageNew,
		Payload: json.RawMessage(payload),
	}
	h.meshNode.BroadcastEvent(evt)
}

func (h *ThreadHandler) broadcastFedThreadMessageUpdated(msgID, threadID, content string) {
	payload, _ := json.Marshal(map[string]string{
		"message_id": msgID,
		"thread_id":  threadID,
		"content":    content,
	})

	evt := federation.FederationEvent{
		Type:    federation.FedEventThreadMessageUpdated,
		Payload: json.RawMessage(payload),
	}
	h.meshNode.BroadcastEvent(evt)
}

func (h *ThreadHandler) broadcastFedThreadMessageDeleted(msgID, threadID string) {
	payload, _ := json.Marshal(map[string]string{
		"message_id": msgID,
		"thread_id":  threadID,
	})

	evt := federation.FederationEvent{
		Type:    federation.FedEventThreadMessageDeleted,
		Payload: json.RawMessage(payload),
	}
	h.meshNode.BroadcastEvent(evt)
}
