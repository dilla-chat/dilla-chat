package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type RoleHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewRoleHandler(authSvc *auth.AuthService, database *db.DB) *RoleHandler {
	return &RoleHandler{authSvc: authSvc, db: database}
}

// GET /api/v1/teams/{teamId}/roles
func (h *RoleHandler) HandleList(w http.ResponseWriter, r *http.Request) {
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

	roles, err := h.db.GetRolesByTeam(team.ID)
	if err != nil {
		slog.Error("list roles failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list roles"})
		return
	}
	if roles == nil {
		roles = []db.Role{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"roles": roles})
}

// POST /api/v1/teams/{teamId}/roles
func (h *RoleHandler) HandleCreate(w http.ResponseWriter, r *http.Request) {
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

	hasPerm, err := h.db.UserHasPermission(team.ID, userID, db.PermManageRoles)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage roles permission required"})
		return
	}

	var req struct {
		Name        string `json:"name"`
		Color       string `json:"color"`
		Permissions int64  `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	if req.Color == "" {
		req.Color = "#99AAB5"
	}

	// Determine next position.
	existing, err := h.db.GetRolesByTeam(team.ID)
	if err != nil {
		slog.Error("get roles failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}

	role := &db.Role{
		TeamID:      team.ID,
		Name:        req.Name,
		Color:       req.Color,
		Position:    len(existing),
		Permissions: req.Permissions,
	}
	if err := h.db.CreateRole(role); err != nil {
		slog.Error("create role failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create role"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"role": role})
}

// PATCH /api/v1/roles/{role_id}
func (h *RoleHandler) HandleUpdate(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	roleID := r.PathValue("role_id")
	if roleID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role_id is required"})
		return
	}

	role, err := h.db.GetRoleByID(roleID)
	if err != nil {
		slog.Error("get role failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if role == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "role not found"})
		return
	}

	hasPerm, err := h.db.UserHasPermission(role.TeamID, userID, db.PermManageRoles)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage roles permission required"})
		return
	}

	var req struct {
		Name        *string `json:"name"`
		Color       *string `json:"color"`
		Permissions *int64  `json:"permissions"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Name != nil {
		role.Name = *req.Name
	}
	if req.Color != nil {
		role.Color = *req.Color
	}
	if req.Permissions != nil {
		role.Permissions = *req.Permissions
	}

	if err := h.db.UpdateRole(role); err != nil {
		slog.Error("update role failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update role"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"role": role})
}

// DELETE /api/v1/roles/{role_id}
func (h *RoleHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	roleID := r.PathValue("role_id")
	if roleID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role_id is required"})
		return
	}

	role, err := h.db.GetRoleByID(roleID)
	if err != nil {
		slog.Error("get role failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if role == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "role not found"})
		return
	}

	// Cannot delete the default role.
	if role.IsDefault {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete the default role"})
		return
	}

	hasPerm, err := h.db.UserHasPermission(role.TeamID, userID, db.PermManageRoles)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage roles permission required"})
		return
	}

	if err := h.db.DeleteRole(roleID); err != nil {
		slog.Error("delete role failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete role"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// PUT /api/v1/teams/{teamId}/roles/reorder
func (h *RoleHandler) HandleReorder(w http.ResponseWriter, r *http.Request) {
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

	hasPerm, err := h.db.UserHasPermission(team.ID, userID, db.PermManageRoles)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage roles permission required"})
		return
	}

	var req struct {
		RoleIDs []string `json:"role_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if len(req.RoleIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "role_ids is required"})
		return
	}

	for i, roleID := range req.RoleIDs {
		role, err := h.db.GetRoleByID(roleID)
		if err != nil || role == nil {
			continue
		}
		role.Position = i
		if err := h.db.UpdateRole(role); err != nil {
			slog.Error("reorder role failed", "error", err, "role_id", roleID)
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "reordered"})
}
