package api

import (
	"net/http"

	"github.com/slimcord/slimcord-server/internal/voice"
)

type VoiceHandler struct {
	roomManager *voice.RoomManager
}

func NewVoiceHandler(rm *voice.RoomManager) *VoiceHandler {
	return &VoiceHandler{roomManager: rm}
}

// HandleGetRoom returns the current voice state of a channel.
func (h *VoiceHandler) HandleGetRoom(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("channelId")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channelId is required"})
		return
	}

	room := h.roomManager.GetRoom(channelID)
	if room == nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"channel_id": channelID,
			"peers":      []interface{}{},
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"channel_id": channelID,
		"peers":      room.GetPeers(),
	})
}

// HandleJoin and HandleLeave removed — voice join/leave is WS-only via voice:join/voice:leave events.
