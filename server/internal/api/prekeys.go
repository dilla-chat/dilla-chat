package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type PrekeyHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewPrekeyHandler(authSvc *auth.AuthService, database *db.DB) *PrekeyHandler {
	return &PrekeyHandler{authSvc: authSvc, db: database}
}

// POST /api/v1/prekeys — Upload prekey bundle (auth required)
func (h *PrekeyHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req struct {
		IdentityKey          string   `json:"identity_key"`
		SignedPrekey         string   `json:"signed_prekey"`
		SignedPrekeySignature string  `json:"signed_prekey_signature"`
		OneTimePrekeys       []string `json:"one_time_prekeys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.IdentityKey == "" || req.SignedPrekey == "" || req.SignedPrekeySignature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "identity_key, signed_prekey, and signed_prekey_signature are required"})
		return
	}

	// Serialize one_time_prekeys as JSON array.
	otpJSON, err := json.Marshal(req.OneTimePrekeys)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to encode one_time_prekeys"})
		return
	}

	bundle := &db.PrekeyBundle{
		UserID:                userID,
		IdentityKey:           []byte(req.IdentityKey),
		SignedPrekey:          []byte(req.SignedPrekey),
		SignedPrekeySignature: []byte(req.SignedPrekeySignature),
		OneTimePrekeys:        otpJSON,
	}
	if err := h.db.SavePrekeyBundle(bundle); err != nil {
		slog.Error("save prekey bundle failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to save prekey bundle"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// GET /api/v1/prekeys/{user_id} — Download a user's prekey bundle (auth required)
func (h *PrekeyHandler) HandleGet(w http.ResponseWriter, r *http.Request) {
	targetUserID := r.PathValue("user_id")
	if targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
		return
	}

	bundle, err := h.db.GetPrekeyBundle(targetUserID)
	if err != nil {
		slog.Error("get prekey bundle failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if bundle == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "prekey bundle not found"})
		return
	}

	// Consume one one-time prekey.
	var oneTimePrekeys []string
	otp, err := h.db.ConsumeOneTimePrekey(targetUserID)
	if err != nil {
		slog.Warn("consume one-time prekey failed", "error", err)
	}
	if otp != nil {
		oneTimePrekeys = []string{string(otp)}
	}

	resp := map[string]interface{}{
		"identity_key":           string(bundle.IdentityKey),
		"signed_prekey":          string(bundle.SignedPrekey),
		"signed_prekey_signature": string(bundle.SignedPrekeySignature),
		"one_time_prekeys":       oneTimePrekeys,
	}
	if oneTimePrekeys == nil {
		resp["one_time_prekeys"] = []string{}
	}

	writeJSON(w, http.StatusOK, resp)
}

// DELETE /api/v1/prekeys — Delete your prekey bundle (auth required)
func (h *PrekeyHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	if err := h.db.DeletePrekeyBundle(userID); err != nil {
		slog.Error("delete prekey bundle failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete prekey bundle"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
