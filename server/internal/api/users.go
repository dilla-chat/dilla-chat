package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
)

type UserHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewUserHandler(authSvc *auth.AuthService, database *db.DB) *UserHandler {
	return &UserHandler{authSvc: authSvc, db: database}
}

// GET /api/v1/users/me
func (h *UserHandler) HandleGetMe(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		slog.Error("get user failed", "error", err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"user": user})
}

// PATCH /api/v1/users/me
func (h *UserHandler) HandleUpdateUser(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		slog.Error("get user failed", "error", err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}

	var req struct {
		DisplayName *string `json:"display_name"`
		AvatarURL   *string `json:"avatar_url"`
		StatusText  *string `json:"status_text"`
		StatusType  *string `json:"status_type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.DisplayName != nil {
		if len(*req.DisplayName) < 1 || len(*req.DisplayName) > 64 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "display_name must be 1-64 characters"})
			return
		}
		user.DisplayName = *req.DisplayName
	}
	if req.AvatarURL != nil {
		user.AvatarURL = *req.AvatarURL
	}
	if req.StatusText != nil {
		user.StatusText = *req.StatusText
	}
	if req.StatusType != nil {
		switch *req.StatusType {
		case "online", "idle", "dnd", "offline":
			user.StatusType = *req.StatusType
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "status_type must be online, idle, dnd, or offline"})
			return
		}
	}

	if err := h.db.UpdateUser(user); err != nil {
		slog.Error("update user failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update user"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"user": user})
}
