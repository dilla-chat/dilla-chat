package api

import (
	_ "embed"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/slimcord/slimcord-server/internal/auth"
	"github.com/slimcord/slimcord-server/internal/db"
	"github.com/slimcord/slimcord-server/internal/federation"
	"github.com/slimcord/slimcord-server/internal/presence"
	"github.com/slimcord/slimcord-server/internal/voice"
	"github.com/slimcord/slimcord-server/internal/webapp"
	"github.com/slimcord/slimcord-server/internal/ws"
)

//go:embed auth_page.html
var authPageHTML string

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins (CORS handled elsewhere)
	},
}

// RouterConfig holds optional configuration for the router.
type RouterConfig struct {
	MaxUploadSize    int64
	UploadDir        string
	PresenceManager  *presence.PresenceManager
	VoiceRoomManager *voice.RoomManager
	RateLimit        float64
	RateBurst        int
	MaxBodySize      int64
	Domain           string
	TURNClient       *voice.CFTurnClient
}

// Version is set at build time via ldflags.
var Version = "dev"

// startTime records when the server started, used for uptime calculation.
var startTime = time.Now()

func NewRouter(database *db.DB, authSvc *auth.AuthService, hub *ws.Hub, meshNode ...*federation.MeshNode) http.Handler {
	return NewRouterWithConfig(database, authSvc, hub, RouterConfig{}, meshNode...)
}

func NewRouterWithConfig(database *db.DB, authSvc *auth.AuthService, hub *ws.Hub, rcfg RouterConfig, meshNode ...*federation.MeshNode) http.Handler {
	if rcfg.MaxUploadSize <= 0 {
		rcfg.MaxUploadSize = 25 * 1024 * 1024
	}
	if rcfg.UploadDir == "" {
		rcfg.UploadDir = "./data/uploads"
	}

	mux := http.NewServeMux()

	authHandler := NewAuthHandler(authSvc, database)
	inviteHandler := NewInviteHandler(authSvc, database)
	prekeyHandler := NewPrekeyHandler(authSvc, database)
	messageHandler := NewMessageHandler(authSvc, database)
	teamHandler := NewTeamHandler(authSvc, database)
	channelHandler := NewChannelHandler(authSvc, database)
	roleHandler := NewRoleHandler(authSvc, database)

	// Resolve optional mesh node for DM handler.
	var mesh *federation.MeshNode
	if len(meshNode) > 0 {
		mesh = meshNode[0]
	}
	dmHandler := NewDMHandler(authSvc, database, hub, mesh)
	threadHandler := NewThreadHandler(authSvc, database, hub, mesh)
	reactionHandler := NewReactionHandler(authSvc, database, hub, mesh)
	uploadHandler := NewUploadHandler(authSvc, database, hub, mesh, rcfg.MaxUploadSize, rcfg.UploadDir)

	// Health check
	mux.HandleFunc("GET /api/v1/health", handleHealth)

	// WebAuthn passkey auth page (public, serves HTML)
	mux.HandleFunc("GET /auth", handleAuthPage(rcfg.Domain))

	// Version endpoint (unauthenticated)
	mux.HandleFunc("GET /api/v1/version", handleVersion)

	// Client config endpoint (unauthenticated) — provides WebAuthn rpId, etc.
	mux.HandleFunc("GET /api/v1/config", handleConfig(rcfg.Domain))

	// Auth routes (public)
	mux.HandleFunc("POST /api/v1/auth/challenge", authHandler.HandleChallenge)
	mux.HandleFunc("POST /api/v1/auth/verify", authHandler.HandleVerify)
	mux.HandleFunc("POST /api/v1/auth/register", authHandler.HandleRegister)
	mux.HandleFunc("POST /api/v1/auth/bootstrap", authHandler.HandleBootstrap)

	// Invite info (public)
	mux.HandleFunc("GET /api/v1/invites/{token}/info", inviteHandler.HandleInfo)

	// Identity blob routes — GET is public (for recovery), PUT is authenticated
	identityBlobHandler := NewIdentityBlobHandler(authSvc, database)
	mux.HandleFunc("GET /api/v1/identity/blob", identityBlobHandler.HandleGet)
	identityBlobMux := http.NewServeMux()
	identityBlobMux.HandleFunc("PUT /api/v1/identity/blob", identityBlobHandler.HandleUpload)
	mux.Handle("PUT /api/v1/identity/blob", authSvc.AuthMiddleware(identityBlobMux))

	// Protected prekey routes
	prekeyMux := http.NewServeMux()
	prekeyMux.HandleFunc("POST /api/v1/prekeys", prekeyHandler.HandleUpload)
	prekeyMux.HandleFunc("GET /api/v1/prekeys/{user_id}", prekeyHandler.HandleGet)
	prekeyMux.HandleFunc("DELETE /api/v1/prekeys", prekeyHandler.HandleDelete)
	mux.Handle("/api/v1/prekeys", authSvc.AuthMiddleware(prekeyMux))
	mux.Handle("/api/v1/prekeys/", authSvc.AuthMiddleware(prekeyMux))

	// All team-scoped routes live under /api/v1/teams/...
	dmMux := http.NewServeMux()

	// Team list / create
	dmMux.HandleFunc("GET /api/v1/teams", teamHandler.HandleListTeams)
	dmMux.HandleFunc("POST /api/v1/teams", teamHandler.HandleCreateTeam)

	// Team CRUD
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}", teamHandler.HandleGetTeam)
	dmMux.HandleFunc("PATCH /api/v1/teams/{teamId}", teamHandler.HandleUpdateTeam)

	// Team member routes
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/members", teamHandler.HandleListMembers)
	dmMux.HandleFunc("PATCH /api/v1/teams/{teamId}/members/{user_id}", teamHandler.HandleUpdateMember)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/members/{user_id}", teamHandler.HandleKickMember)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/members/{user_id}/ban", teamHandler.HandleBanMember)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/members/{user_id}/ban", teamHandler.HandleUnbanMember)

	// Channel routes
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/channels", channelHandler.HandleList)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/channels", channelHandler.HandleCreate)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/channels/{channel_id}", channelHandler.HandleGet)
	dmMux.HandleFunc("PATCH /api/v1/teams/{teamId}/channels/{channel_id}", channelHandler.HandleUpdate)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/channels/{channel_id}", channelHandler.HandleDelete)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/channels/{channel_id}/messages", messageHandler.HandleCreate)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/channels/{channel_id}/messages", messageHandler.HandleList)
	dmMux.HandleFunc("PATCH /api/v1/teams/{teamId}/channels/{channel_id}/messages/{message_id}", messageHandler.HandleEdit)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/channels/{channel_id}/messages/{message_id}", messageHandler.HandleDelete)

	// Role routes
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/roles", roleHandler.HandleList)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/roles", roleHandler.HandleCreate)
	dmMux.HandleFunc("PUT /api/v1/teams/{teamId}/roles/reorder", roleHandler.HandleReorder)
	dmMux.HandleFunc("PATCH /api/v1/teams/{teamId}/roles/{role_id}", roleHandler.HandleUpdate)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/roles/{role_id}", roleHandler.HandleDelete)

	// Invite routes
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/invites", inviteHandler.HandleCreate)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/invites", inviteHandler.HandleList)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/invites/{id}", inviteHandler.HandleRevoke)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/dms", dmHandler.HandleCreateOrGet)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/dms", dmHandler.HandleList)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/dms/{dmId}", dmHandler.HandleGet)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/dms/{dmId}/messages", dmHandler.HandleSendMessage)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/dms/{dmId}/messages", dmHandler.HandleListMessages)
	dmMux.HandleFunc("PUT /api/v1/teams/{teamId}/dms/{dmId}/messages/{msgId}", dmHandler.HandleEditMessage)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/dms/{dmId}/messages/{msgId}", dmHandler.HandleDeleteMessage)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/dms/{dmId}/members", dmHandler.HandleAddMembers)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/dms/{dmId}/members/{userId}", dmHandler.HandleRemoveMember)

	// Thread routes (create/edit/delete messages are WS-only; keep GET for fetching)
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/channels/{channelId}/threads", threadHandler.HandleCreateThread)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/channels/{channelId}/threads", threadHandler.HandleListThreads)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/threads/{threadId}", threadHandler.HandleGetThread)
	dmMux.HandleFunc("PUT /api/v1/teams/{teamId}/threads/{threadId}", threadHandler.HandleUpdateThread)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/threads/{threadId}", threadHandler.HandleDeleteThread)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/threads/{threadId}/messages", threadHandler.HandleListMessages)

	// Reaction routes
	dmMux.HandleFunc("PUT /api/v1/teams/{teamId}/channels/{channelId}/messages/{msgId}/reactions/{emoji}", reactionHandler.HandleAddReaction)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/channels/{channelId}/messages/{msgId}/reactions/{emoji}", reactionHandler.HandleRemoveReaction)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/channels/{channelId}/messages/{msgId}/reactions", reactionHandler.HandleGetReactions)

	// Upload / attachment routes
	dmMux.HandleFunc("POST /api/v1/teams/{teamId}/upload", uploadHandler.HandleUpload)
	dmMux.HandleFunc("GET /api/v1/teams/{teamId}/attachments/{attachmentId}", uploadHandler.HandleDownload)
	dmMux.HandleFunc("DELETE /api/v1/teams/{teamId}/attachments/{attachmentId}", uploadHandler.HandleDelete)

	// Presence routes
	if rcfg.PresenceManager != nil {
		presenceHandler := NewPresenceHandler(authSvc, database, rcfg.PresenceManager)
		dmMux.HandleFunc("GET /api/v1/teams/{teamId}/presence", presenceHandler.HandleGetAll)
		dmMux.HandleFunc("GET /api/v1/teams/{teamId}/presence/{userId}", presenceHandler.HandleGetUser)
		dmMux.HandleFunc("PUT /api/v1/teams/{teamId}/presence", presenceHandler.HandleUpdateOwn)
	}

	// Voice routes (GET room state only; join/leave is WS-only)
	if rcfg.VoiceRoomManager != nil {
		voiceHandler := NewVoiceHandler(rcfg.VoiceRoomManager)
		dmMux.HandleFunc("GET /api/v1/teams/{teamId}/voice/{channelId}", voiceHandler.HandleGetRoom)
	}

	// TURN credential endpoint
	if rcfg.TURNClient != nil {
		turnHandler := NewTURNHandler(authSvc, rcfg.TURNClient)
		turnMux := http.NewServeMux()
		turnMux.HandleFunc("GET /api/v1/voice/credentials", turnHandler.HandleGetCredentials)
		mux.Handle("/api/v1/voice/", authSvc.AuthMiddleware(turnMux))
	}

	mux.Handle("/api/v1/teams", authSvc.AuthMiddleware(dmMux))
	mux.Handle("/api/v1/teams/", authSvc.AuthMiddleware(dmMux))

	// Placeholder routes
	mux.HandleFunc("/api/v1/messages/", notImplemented)

	// WebSocket upgrade endpoint — authenticates via query param token.
	mux.HandleFunc("/ws", handleWebSocket(authSvc, database, hub))

	// Federation routes (if mesh node is configured).
	if len(meshNode) > 0 && meshNode[0] != nil {
		mesh := meshNode[0]

		// Federation WebSocket (node-to-node, no JWT auth).
		mux.HandleFunc("/federation/ws", mesh.FederationWSHandler())

		// Public join info endpoint.
		mux.HandleFunc("GET /api/v1/federation/join/{token}", NewFederationHandler(authSvc, mesh).HandleJoinInfo)

		// Protected federation API routes.
		fedHandler := NewFederationHandler(authSvc, mesh)
		fedMux := http.NewServeMux()
		fedMux.HandleFunc("GET /api/v1/federation/status", fedHandler.HandleStatus)
		fedMux.HandleFunc("GET /api/v1/federation/peers", fedHandler.HandlePeers)
		fedMux.HandleFunc("POST /api/v1/federation/join-token", fedHandler.HandleCreateJoinToken)
		mux.Handle("/api/v1/federation/", authSvc.AuthMiddleware(fedMux))
	}

	// Also add a top-level /health for Docker/k8s health checks.
	mux.HandleFunc("GET /health", handleHealth)

	// Serve embedded web client for all non-API routes (SPA fallback)
	mux.Handle("/", webapp.Handler())

	handler := corsMiddleware(jsonMiddleware(mux))

	// Apply content-type validation.
	handler = ContentTypeValidationMiddleware(handler)

	// Apply max body size middleware (default 1MB for non-upload routes).
	maxBody := rcfg.MaxBodySize
	if maxBody <= 0 {
		maxBody = 1 * 1024 * 1024
	}
	handler = MaxBodySizeMiddleware(maxBody)(handler)

	// Apply rate limiting if configured.
	if rcfg.RateLimit > 0 {
		rl := NewIPRateLimiter(rcfg.RateLimit, rcfg.RateBurst)
		handler = RateLimitMiddleware(rl)(handler)
	}

	// Apply request logging.
	handler = RequestLoggingMiddleware(handler)

	return handler
}

func handleAuthPage(domain string) http.HandlerFunc {
	// Inject the RP ID into the HTML at serve time.
	// The template uses {{RP_ID}} as a placeholder.
	rpID := domain
	if rpID == "" {
		rpID = "localhost"
	}
	// Strip port if present (RP ID is just the hostname)
	if idx := strings.Index(rpID, ":"); idx != -1 {
		rpID = rpID[:idx]
	}
	rendered := strings.ReplaceAll(authPageHTML, "{{RP_ID}}", rpID)

	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(rendered))
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	uptime := time.Since(startTime).Truncate(time.Second).String()
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
		"uptime": uptime,
	})
}

func handleVersion(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"version":    Version,
		"go_version": runtime.Version(),
	})
}

func handleConfig(domain string) http.HandlerFunc {
	rpID := domain
	if rpID == "" {
		rpID = "localhost"
	}
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{
			"rp_id":   rpID,
			"rp_name": "Slimcord",
			"domain":  domain,
		})
	}
}

func notImplemented(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNotImplemented)
	json.NewEncoder(w).Encode(map[string]string{"error": "not implemented"})
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Error("failed to write json response", "error", err)
	}
}

func jsonMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func handleWebSocket(authSvc *auth.AuthService, database *db.DB, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		if token == "" {
			http.Error(w, `{"error":"token query parameter is required"}`, http.StatusUnauthorized)
			return
		}

		userID, err := authSvc.ValidateJWT(token)
		if err != nil {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		user, err := database.GetUserByID(userID)
		if err != nil || user == nil {
			http.Error(w, `{"error":"user not found"}`, http.StatusUnauthorized)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			slog.Error("ws: upgrade failed", "error", err)
			return
		}

			// Get team context from query param.
		teamID := r.URL.Query().Get("team")
		if teamID == "" {
			http.Error(w, `{"error":"team query parameter is required"}`, http.StatusBadRequest)
			return
		}
		team, err := database.GetTeam(teamID)
		if err != nil || team == nil {
			http.Error(w, `{"error":"team not found"}`, http.StatusNotFound)
			return
		}
		member, err := database.GetMemberByUserAndTeam(user.ID, teamID)
		if err != nil || member == nil {
			http.Error(w, `{"error":"not a member of this team"}`, http.StatusForbidden)
			return
		}

		client := ws.NewClient(hub, conn, user.ID, user.Username, teamID)
		hub.Register(client)

		// Auto-subscribe to all channels the user has access to.
		channels, err := database.GetChannelsByTeam(teamID)
		if err == nil {
			for _, ch := range channels {
				hub.Subscribe(client, ch.ID)
			}
		}
		// Also subscribe to DM channels.
		dmChannels, err := database.GetUserDMChannels(teamID, user.ID)
		if err == nil {
			for _, dm := range dmChannels {
				hub.Subscribe(client, dm.ID)
			}
		}

		go client.WritePump()
		go client.ReadPump()
	}
}
