package api

import (
	"encoding/json"
	"net/http"

	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/federation"
)

// FederationHandler handles federation-related API endpoints.
type FederationHandler struct {
	authSvc *auth.AuthService
	mesh    *federation.MeshNode
}

// NewFederationHandler creates a new federation API handler.
func NewFederationHandler(authSvc *auth.AuthService, mesh *federation.MeshNode) *FederationHandler {
	return &FederationHandler{authSvc: authSvc, mesh: mesh}
}

// HandleStatus returns the current federation status.
// GET /api/v1/federation/status
func (h *FederationHandler) HandleStatus(w http.ResponseWriter, r *http.Request) {
	peers := h.mesh.GetPeers()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"node_name":  h.mesh.NodeName(),
		"peers":      peers,
		"peer_count": len(peers),
		"lamport_ts": h.mesh.SyncMgr().Current(),
	})
}

// HandlePeers lists all known peers.
// GET /api/v1/federation/peers
func (h *FederationHandler) HandlePeers(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"peers": h.mesh.GetPeers(),
	})
}

// HandleCreateJoinToken generates a join token for a new node.
// POST /api/v1/federation/join-token
func (h *FederationHandler) HandleCreateJoinToken(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value(auth.UserIDKey).(string)

	// Check if user is admin.
	db := h.authSvc.GetDB()
	user, err := db.GetUserByID(userID)
	if err != nil || user == nil || !user.IsAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin access required"})
		return
	}

	token, err := h.mesh.JoinMgr().GenerateJoinToken(userID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to generate join token"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"token":        token,
		"join_command": "slimcord-server --join-token " + token,
	})
}

// HandleJoinInfo serves join info for a given token (public endpoint).
// GET /api/v1/federation/join/{token}
func (h *FederationHandler) HandleJoinInfo(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token is required"})
		return
	}

	info, err := h.mesh.JoinMgr().ValidateJoinToken(token)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired token"})
		return
	}

	data, _ := json.Marshal(info)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write(data)
}
