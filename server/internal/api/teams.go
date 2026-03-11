package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
)

type TeamHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewTeamHandler(authSvc *auth.AuthService, database *db.DB) *TeamHandler {
	return &TeamHandler{authSvc: authSvc, db: database}
}

// GET /api/v1/teams/{teamId}
func (h *TeamHandler) HandleGetTeam(w http.ResponseWriter, r *http.Request) {
	teamId := r.PathValue("teamId")
	if teamId == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "team_id is required"})
		return
	}
	team, err := h.db.GetTeam(teamId)
	if err != nil || team == nil {
		slog.Error("get team failed", "error", err)
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "team not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"team": team})
}

// PATCH /api/v1/teams/{teamId}
func (h *TeamHandler) HandleUpdateTeam(w http.ResponseWriter, r *http.Request) {
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

	// Admin only.
	user, err := h.db.GetUserByID(userID)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}
	if !user.IsAdmin {
		hasPerm, err := h.db.UserHasPermission(team.ID, userID, db.PermAdmin)
		if err != nil || !hasPerm {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin permission required"})
			return
		}
	}

	var req struct {
		Name               *string `json:"name"`
		Description        *string `json:"description"`
		IconURL            *string `json:"icon_url"`
		MaxFileSize        *int64  `json:"max_file_size"`
		AllowMemberInvites *bool   `json:"allow_member_invites"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Name != nil {
		team.Name = *req.Name
	}
	if req.Description != nil {
		team.Description = *req.Description
	}
	if req.IconURL != nil {
		team.IconURL = *req.IconURL
	}
	if req.MaxFileSize != nil {
		team.MaxFileSize = *req.MaxFileSize
	}
	if req.AllowMemberInvites != nil {
		team.AllowMemberInvites = *req.AllowMemberInvites
	}

	if err := h.db.UpdateTeam(team); err != nil {
		slog.Error("update team failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update team"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"team": team})
}

// GET /api/v1/teams/{teamId}/members
func (h *TeamHandler) HandleListMembers(w http.ResponseWriter, r *http.Request) {
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

	members, err := h.db.GetMembersByTeam(team.ID)
	if err != nil {
		slog.Error("list members failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list members"})
		return
	}

	type memberResponse struct {
		ID          string   `json:"id"`
		UserID      string   `json:"user_id"`
		Username    string   `json:"username"`
		DisplayName string   `json:"display_name"`
		Nickname    string   `json:"nickname"`
		Roles       []db.Role `json:"roles"`
		JoinedAt    string   `json:"joined_at"`
	}

	var result []memberResponse
	for _, m := range members {
		user, err := h.db.GetUserByID(m.UserID)
		if err != nil || user == nil {
			continue
		}
		roles, err := h.db.GetMemberRoles(m.ID)
		if err != nil {
			roles = []db.Role{}
		}
		if roles == nil {
			roles = []db.Role{}
		}
		result = append(result, memberResponse{
			ID:          m.ID,
			UserID:      m.UserID,
			Username:    user.Username,
			DisplayName: user.DisplayName,
			Nickname:    m.Nickname,
			Roles:       roles,
			JoinedAt:    m.JoinedAt.UTC().Format("2006-01-02 15:04:05"),
		})
	}
	if result == nil {
		result = []memberResponse{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"members": result})
}

// PATCH /api/v1/teams/{teamId}/members/{user_id}
func (h *TeamHandler) HandleUpdateMember(w http.ResponseWriter, r *http.Request) {
	callerID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	targetUserID := r.PathValue("user_id")
	if targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
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

	// Require admin or PermManageMembers.
	hasPerm, err := h.db.UserHasPermission(team.ID, callerID, db.PermManageMembers)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage members permission required"})
		return
	}

	member, err := h.db.GetMemberByUserAndTeam(targetUserID, team.ID)
	if err != nil {
		slog.Error("get member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if member == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "member not found"})
		return
	}

	var req struct {
		Nickname *string  `json:"nickname"`
		RoleIDs  []string `json:"role_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if req.Nickname != nil {
		member.Nickname = *req.Nickname
		if err := h.db.UpdateMember(member); err != nil {
			slog.Error("update member failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update member"})
			return
		}
	}

	if req.RoleIDs != nil {
		// Clear existing roles and assign new ones.
		if err := h.db.ClearMemberRoles(member.ID); err != nil {
			slog.Error("clear member roles failed", "error", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update roles"})
			return
		}
		for _, roleID := range req.RoleIDs {
			if err := h.db.AssignRoleToMember(member.ID, roleID); err != nil {
				slog.Error("assign role failed", "error", err, "role_id", roleID)
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

// DELETE /api/v1/teams/{teamId}/members/{user_id}
func (h *TeamHandler) HandleKickMember(w http.ResponseWriter, r *http.Request) {
	callerID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	targetUserID := r.PathValue("user_id")
	if targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
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

	hasPerm, err := h.db.UserHasPermission(team.ID, callerID, db.PermManageMembers)
	if err != nil || !hasPerm {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "manage members permission required"})
		return
	}

	// Cannot kick yourself.
	if callerID == targetUserID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot kick yourself"})
		return
	}

	// Cannot kick the team owner.
	if team.CreatedBy == targetUserID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cannot kick the team owner"})
		return
	}

	if err := h.db.DeleteMember(team.ID, targetUserID); err != nil {
		slog.Error("kick member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to kick member"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "kicked"})
}

// POST /api/v1/teams/{teamId}/members/{user_id}/ban
func (h *TeamHandler) HandleBanMember(w http.ResponseWriter, r *http.Request) {
	callerID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	targetUserID := r.PathValue("user_id")
	if targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
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

	// Admin only for bans.
	caller, err := h.db.GetUserByID(callerID)
	if err != nil || caller == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}
	if !caller.IsAdmin {
		hasPerm, err := h.db.UserHasPermission(team.ID, callerID, db.PermManageMembers)
		if err != nil || !hasPerm {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin permission required"})
			return
		}
	}

	if callerID == targetUserID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot ban yourself"})
		return
	}
	if team.CreatedBy == targetUserID {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "cannot ban the team owner"})
		return
	}

	var req struct {
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	if err := h.db.CreateBan(team.ID, targetUserID, callerID, req.Reason); err != nil {
		slog.Error("ban member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to ban member"})
		return
	}

	// Also remove from team.
	_ = h.db.DeleteMember(team.ID, targetUserID)

	writeJSON(w, http.StatusOK, map[string]string{"status": "banned"})
}

// DELETE /api/v1/teams/{teamId}/members/{user_id}/ban
func (h *TeamHandler) HandleUnbanMember(w http.ResponseWriter, r *http.Request) {
	callerID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	targetUserID := r.PathValue("user_id")
	if targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "user_id is required"})
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

	// Admin only for unbans.
	caller, err := h.db.GetUserByID(callerID)
	if err != nil || caller == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user not found"})
		return
	}
	if !caller.IsAdmin {
		hasPerm, err := h.db.UserHasPermission(team.ID, callerID, db.PermManageMembers)
		if err != nil || !hasPerm {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin permission required"})
			return
		}
	}

	if err := h.db.DeleteBan(team.ID, targetUserID); err != nil {
		slog.Error("unban member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to unban member"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "unbanned"})
}

// POST /api/v1/teams
func (h *TeamHandler) HandleCreateTeam(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}

	team := &db.Team{Name: body.Name, Description: body.Description, CreatedBy: userID}
	if err := h.db.CreateTeam(team); err != nil {
		slog.Error("create team failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create team"})
		return
	}

	// Add creator as member.
	if err := h.db.CreateMember(&db.Member{TeamID: team.ID, UserID: userID, Nickname: ""}); err != nil {
		slog.Error("create team member failed", "error", err)
	}

	// Create default #general channel.
	if err := h.db.CreateChannel(&db.Channel{TeamID: team.ID, Name: "general", Type: "text"}); err != nil {
		slog.Error("create team default channel failed", "error", err)
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{"team": team})
}

// GET /api/v1/teams
func (h *TeamHandler) HandleListTeams(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	teams, err := h.db.GetTeamsByUser(userID)
	if err != nil {
		slog.Error("list teams failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to list teams"})
		return
	}
	if teams == nil {
		teams = []db.Team{}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{"teams": teams})
}
