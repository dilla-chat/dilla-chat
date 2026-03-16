package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/federation"
	"github.com/dilla/dilla-server/internal/ws"
)

type UploadHandler struct {
	authSvc       *auth.AuthService
	db            *db.DB
	hub           *ws.Hub
	meshNode      *federation.MeshNode
	maxUploadSize int64
	uploadDir     string
}

func NewUploadHandler(authSvc *auth.AuthService, database *db.DB, hub *ws.Hub, meshNode *federation.MeshNode, maxUploadSize int64, uploadDir string) *UploadHandler {
	return &UploadHandler{
		authSvc:       authSvc,
		db:            database,
		hub:           hub,
		meshNode:      meshNode,
		maxUploadSize: maxUploadSize,
		uploadDir:     uploadDir,
	}
}

// HandleUpload handles POST /api/v1/teams/{teamId}/upload
// Accepts multipart form with fields: file (the blob), message_id, filename_encrypted, content_type_encrypted
func (h *UploadHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(string)
	if userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	teamID := r.PathValue("teamId")
	if teamID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing team id"})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxUploadSize)
	if err := r.ParseMultipartForm(h.maxUploadSize); err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large"})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing file field"})
		return
	}
	defer file.Close()

	messageID := r.FormValue("message_id")
	if messageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing message_id"})
		return
	}

	filenameEncrypted := []byte(r.FormValue("filename_encrypted"))
	contentTypeEncrypted := []byte(r.FormValue("content_type_encrypted"))

	// Generate a temporary attachment ID for storage path.
	attachmentID := db.ExportNewID()
	dir := filepath.Join(h.uploadDir, teamID, attachmentID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		slog.Error("failed to create upload dir", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage error"})
		return
	}

	// Sanitize filename: strip directory components to prevent path traversal.
	storedName := filepath.Base(header.Filename)
	if storedName == "" || storedName == "." || storedName == ".." || strings.HasPrefix(storedName, ".") {
		storedName = "blob"
	}
	storagePath := filepath.Join(dir, storedName)
	dst, err := os.Create(storagePath)
	if err != nil {
		slog.Error("failed to create file", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage error"})
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		slog.Error("failed to write file", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "storage error"})
		return
	}

	attachment, err := h.db.CreateAttachmentWithID(attachmentID, messageID, filenameEncrypted, contentTypeEncrypted, written, storagePath)
	if err != nil {
		slog.Error("failed to save attachment record", "error", err)
		// Clean up stored file on DB error.
		os.RemoveAll(dir)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save attachment"})
		return
	}

	writeJSON(w, http.StatusCreated, attachment)
}

// HandleDownload handles GET /api/v1/teams/{teamId}/attachments/{attachmentId}
func (h *UploadHandler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(string)
	if userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	teamID := r.PathValue("teamId")
	attachmentID := r.PathValue("attachmentId")
	if attachmentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing attachment id"})
		return
	}

	// Verify the user is a member of this team.
	member, err := h.db.GetMemberByUserAndTeam(userID, teamID)
	if err != nil || member == nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a member of this team"})
		return
	}

	attachment, err := h.db.GetAttachment(attachmentID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "attachment not found"})
		return
	}

	// Serve the raw encrypted blob.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment")
	http.ServeFile(w, r, attachment.StoragePath)
}

// HandleDelete handles DELETE /api/v1/teams/{teamId}/attachments/{attachmentId}
func (h *UploadHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(auth.UserIDKey).(string)
	if userID == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	attachmentID := r.PathValue("attachmentId")
	if attachmentID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing attachment id"})
		return
	}

	attachment, err := h.db.GetAttachment(attachmentID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "attachment not found"})
		return
	}

	// Check that the user is the message author or an admin.
	msg, err := h.db.GetMessageByID(attachment.MessageID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify ownership"})
		return
	}

	user, err := h.db.GetUserByID(userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to get user"})
		return
	}

	if msg.AuthorID != userID && !user.IsAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}

	// Remove file from disk.
	dir := filepath.Dir(attachment.StoragePath)
	os.RemoveAll(dir)

	if err := h.db.DeleteAttachment(attachmentID); err != nil {
		slog.Error("failed to delete attachment", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete attachment"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// broadcastFedFileEvent broadcasts a federation file event (unused for now, placeholder for future).
func (h *UploadHandler) broadcastFedFileEvent(eventType string, payload interface{}) {
	if h.meshNode == nil {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		slog.Error("failed to marshal federation file event", "error", err)
		return
	}
	h.meshNode.BroadcastEvent(federation.FederationEvent{
		Type:    eventType,
		Payload: data,
	})
}
