package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
)

type AuthHandler struct {
	authSvc *auth.AuthService
	db      *db.DB
}

func NewAuthHandler(authSvc *auth.AuthService, database *db.DB) *AuthHandler {
	return &AuthHandler{authSvc: authSvc, db: database}
}

// POST /api/v1/auth/challenge
func (h *AuthHandler) HandleChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PublicKey string `json:"public_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.PublicKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "public_key is required"})
		return
	}

	nonce, challengeID, err := h.authSvc.GenerateChallenge()
	if err != nil {
		slog.Error("generate challenge failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"challenge_id": challengeID,
		"nonce":        base64.StdEncoding.EncodeToString(nonce),
	})
}

// POST /api/v1/auth/verify
func (h *AuthHandler) HandleVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChallengeID string `json:"challenge_id"`
		PublicKey    string `json:"public_key"`
		Signature    string `json:"signature"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.ChallengeID == "" || req.PublicKey == "" || req.Signature == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "challenge_id, public_key, and signature are required"})
		return
	}

	pubKeyBytes, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid public key"})
		return
	}
	sigBytes, err := base64.StdEncoding.DecodeString(req.Signature)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid signature"})
		return
	}

	valid, err := h.authSvc.VerifyChallenge(req.ChallengeID, ed25519.PublicKey(pubKeyBytes), sigBytes)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	if !valid {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid signature"})
		return
	}

	user, err := h.db.GetUserByPublicKey(pubKeyBytes)
	if err != nil {
		slog.Error("get user by public key failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found, please register first"})
		return
	}

	token, err := h.authSvc.GenerateJWT(user.ID)
	if err != nil {
		slog.Error("generate jwt failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"token": token,
		"user":  user,
	})
}

// POST /api/v1/auth/register
func (h *AuthHandler) HandleRegister(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		PublicKey   string `json:"public_key"`
		InviteToken string `json:"invite_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Username == "" || req.PublicKey == "" || req.InviteToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username, public_key, and invite_token are required"})
		return
	}

	pubKeyBytes, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid public key"})
		return
	}

	// Validate invite token.
	invite, err := h.db.GetInviteByToken(req.InviteToken)
	if err != nil {
		slog.Error("get invite failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if invite == nil || invite.Revoked {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid or revoked invite token"})
		return
	}
	if invite.ExpiresAt != nil && invite.ExpiresAt.Before(time.Now()) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invite token has expired"})
		return
	}
	if invite.MaxUses != nil && invite.Uses >= *invite.MaxUses {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invite token has been fully used"})
		return
	}

	// Check for existing user.
	existing, err := h.db.GetUserByUsername(req.Username)
	if err != nil {
		slog.Error("check existing user failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if existing != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "username already taken"})
		return
	}

	user := &db.User{
		Username:    req.Username,
		DisplayName: req.DisplayName,
		PublicKey:   pubKeyBytes,
		StatusType:  "online",
	}
	if err := h.db.CreateUser(user); err != nil {
		slog.Error("create user failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create user"})
		return
	}

	// Add user as team member.
	member := &db.Member{
		TeamID:    invite.TeamID,
		UserID:    user.ID,
		InvitedBy: invite.CreatedBy,
	}
	if err := h.db.CreateMember(member); err != nil {
		slog.Error("create member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to add to team"})
		return
	}

	// Update invite usage.
	if err := h.db.IncrementInviteUses(invite.ID); err != nil {
		slog.Error("increment invite uses failed", "error", err)
	}
	_ = h.db.LogInviteUse(&db.InviteUse{InviteID: invite.ID, UserID: user.ID})

	token, err := h.authSvc.GenerateJWT(user.ID)
	if err != nil {
		slog.Error("generate jwt failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}

	team, _ := h.db.GetTeam(invite.TeamID)

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user":  user,
		"token": token,
		"team":  team,
	})
}

// POST /api/v1/auth/bootstrap
func (h *AuthHandler) HandleBootstrap(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username       string `json:"username"`
		DisplayName    string `json:"display_name"`
		PublicKey      string `json:"public_key"`
		BootstrapToken string `json:"bootstrap_token"`
		TeamName       string `json:"team_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if req.Username == "" || req.PublicKey == "" || req.BootstrapToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username, public_key, and bootstrap_token are required"})
		return
	}
	if req.TeamName == "" {
		req.TeamName = "My Team"
	}

	pubKeyBytes, err := base64.StdEncoding.DecodeString(req.PublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid public key"})
		return
	}

	// Validate bootstrap token.
	bt, err := h.db.GetBootstrapToken(req.BootstrapToken)
	if err != nil {
		slog.Error("get bootstrap token failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}
	if bt == nil || bt.Used {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid or already used bootstrap token"})
		return
	}
	// Reject bootstrap tokens older than 24 hours.
	if time.Since(bt.CreatedAt) > 24*time.Hour {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bootstrap token has expired"})
		return
	}

	// Create admin user.
	user := &db.User{
		Username:    req.Username,
		DisplayName: req.DisplayName,
		PublicKey:   pubKeyBytes,
		StatusType:  "online",
		IsAdmin:     true,
	}
	if err := h.db.CreateUser(user); err != nil {
		slog.Error("create user failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create user"})
		return
	}

	// Create team.
	team := &db.Team{
		Name:               req.TeamName,
		CreatedBy:          user.ID,
		MaxFileSize:        10485760,
		AllowMemberInvites: true,
	}
	if err := h.db.CreateTeam(team); err != nil {
		slog.Error("create team failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create team"})
		return
	}

	// Add user as first member.
	member := &db.Member{
		TeamID: team.ID,
		UserID: user.ID,
	}
	if err := h.db.CreateMember(member); err != nil {
		slog.Error("create member failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to add to team"})
		return
	}

	// Create default #general text channel.
	channel := &db.Channel{
		TeamID:    team.ID,
		Name:      "general",
		Topic:     "General discussion",
		Type:      "text",
		Position:  0,
		Category:  "General",
		CreatedBy: user.ID,
	}
	if err := h.db.CreateChannel(channel); err != nil {
		slog.Error("create default text channel failed", "error", err)
	}

	// Create default General voice channel.
	voiceChannel := &db.Channel{
		TeamID:    team.ID,
		Name:      "General",
		Type:      "voice",
		Position:  1,
		Category:  "General",
		CreatedBy: user.ID,
	}
	if err := h.db.CreateChannel(voiceChannel); err != nil {
		slog.Error("create default voice channel failed", "error", err)
	}

	// Create default @everyone role with basic permissions.
	role := &db.Role{
		TeamID:      team.ID,
		Name:        "everyone",
		IsDefault:   true,
		Permissions: int64(db.DefaultEveryonePerms),
	}
	if err := h.db.CreateRole(role); err != nil {
		slog.Error("create default role failed", "error", err)
	}

	// Mark bootstrap token as used.
	if err := h.db.UseBootstrapToken(req.BootstrapToken); err != nil {
		slog.Error("use bootstrap token failed", "error", err)
	}

	token, err := h.authSvc.GenerateJWT(user.ID)
	if err != nil {
		slog.Error("generate jwt failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"user":  user,
		"token": token,
		"team":  team,
	})
}
