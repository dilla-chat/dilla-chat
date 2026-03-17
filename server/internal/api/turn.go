package api

import (
	"encoding/json"
	"net/http"

	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/voice"
)

type TURNHandler struct {
	auth *auth.AuthService
	turn voice.TURNCredentialProvider
}

func NewTURNHandler(authSvc *auth.AuthService, turnClient voice.TURNCredentialProvider) *TURNHandler {
	return &TURNHandler{auth: authSvc, turn: turnClient}
}

// HandleGetCredentials returns TURN ICE servers for the authenticated user.
func (h *TURNHandler) HandleGetCredentials(w http.ResponseWriter, r *http.Request) {
	userID, ok := r.Context().Value(auth.UserIDKey).(string)
	if !ok || userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	iceServers, err := h.turn.GetICEServers()
	if err != nil {
		http.Error(w, "failed to get TURN credentials", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(json.RawMessage(`{"iceServers":` + string(iceServers) + `}`))
}
