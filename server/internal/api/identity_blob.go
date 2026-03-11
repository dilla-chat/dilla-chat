package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type IdentityBlobHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewIdentityBlobHandler(authSvc *auth.AuthService, database *db.DB) *IdentityBlobHandler {
	return &IdentityBlobHandler{authSvc: authSvc, db: database}
}

// PUT /api/v1/identity/blob — Upload or update encrypted identity blob (authenticated).
func (h *IdentityBlobHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req struct {
		Blob string `json:"blob"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Blob == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "blob is required"})
		return
	}

	if err := h.db.UpsertIdentityBlob(userID, req.Blob); err != nil {
		slog.Error("failed to save identity blob", "error", err, "user_id", userID)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save blob"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GET /api/v1/identity/blob?username=X — Fetch encrypted identity blob by username (public, rate-limited).
func (h *IdentityBlobHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username query parameter is required"})
		return
	}

	blob, err := h.db.GetIdentityBlobByUsername(username)
	if err != nil {
		slog.Error("failed to get identity blob", "error", err, "username", username)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if blob == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no identity blob found for this user"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"blob":       blob.Blob,
		"updated_at": blob.UpdatedAt,
	})
}
