package api

import (
	_ "embed"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/federation"
	"github.com/dilla/dilla-server/internal/observability"
	"github.com/dilla/dilla-server/internal/presence"
	"github.com/dilla/dilla-server/internal/voice"
	"github.com/dilla/dilla-server/internal/webapp"
	"github.com/dilla/dilla-server/internal/ws"
)

//go:embed auth_page.html
var authPageHTML string

// newUpgrader creates a WebSocket upgrader with origin checking based on allowed origins.
func newUpgrader(allowedOrigins []string) websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			if len(allowedOrigins) == 0 {
				return true
			}
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			for _, allowed := range allowedOrigins {
				if allowed == "*" || allowed == origin {
					return true
				}
			}
			return false
		},
	}
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
	AllowedOrigins   []string
	TrustedProxies   []string
	TLSEnabled       bool
	OTelMetrics      *observability.Metrics
	OTelEndpoint     string
	OTelInsecure     bool
	OTelAPIKey       string
	OTelAPIHeader    string
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

	// Set OTLP proxy endpoint for browser telemetry forwarding.
	otelProxyEndpoint = rcfg.OTelEndpoint
	otelProxyInsecure = rcfg.OTelInsecure
	otelProxyAPIKey = rcfg.OTelAPIKey
	otelProxyAPIHeader = rcfg.OTelAPIHeader

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

	// User profile routes
	userHandler := NewUserHandler(authSvc, database)
	userMux := http.NewServeMux()
	userMux.HandleFunc("GET /api/v1/users/me", userHandler.HandleGetMe)
	userMux.HandleFunc("PATCH /api/v1/users/me", userHandler.HandleUpdateUser)
	mux.Handle("/api/v1/users/", authSvc.AuthMiddleware(userMux))

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
	wsUpgrader := newUpgrader(rcfg.AllowedOrigins)
	mux.HandleFunc("/ws", handleWebSocket(authSvc, database, hub, wsUpgrader))

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

	// OTLP proxy — forwards browser telemetry to the OTel collector.
	mux.HandleFunc("POST /api/v1/telemetry", handleTelemetryProxy)

	// Also add a top-level /health for Docker/k8s health checks.
	mux.HandleFunc("GET /health", handleHealth)

	// Serve embedded web client for all non-API routes (SPA fallback)
	mux.Handle("/", webapp.Handler())

	handler := corsMiddleware(rcfg.AllowedOrigins)(securityHeadersMiddleware(rcfg.TLSEnabled)(jsonMiddleware(mux)))

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
		rl := NewIPRateLimiter(rcfg.RateLimit, rcfg.RateBurst, rcfg.TrustedProxies)
		handler = RateLimitMiddleware(rl)(handler)
	}

	// Apply request logging (or OTel middleware when metrics are available).
	if rcfg.OTelMetrics != nil {
		handler = observability.HTTPMiddleware(rcfg.OTelMetrics)(handler)
	} else {
		handler = RequestLoggingMiddleware(handler)
	}

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
			"rp_name": "Dilla",
			"domain":  domain,
		})
	}
}

// handleTelemetryProxy forwards OTLP/HTTP payloads from browser clients to the
// configured OTel collector. This keeps the collector endpoint private.
func handleTelemetryProxy(w http.ResponseWriter, r *http.Request) {
	// Read the OTel endpoint from context or config; for simplicity, use env var.
	endpoint := otelProxyEndpoint
	if endpoint == "" {
		http.Error(w, `{"error":"telemetry not configured"}`, http.StatusServiceUnavailable)
		return
	}

	// Limit body size to 1MB.
	body, err := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err != nil {
		http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
		return
	}

	// Determine the target path based on content: traces or metrics.
	targetPath := "/v1/traces"
	if strings.Contains(r.URL.Query().Get("type"), "metrics") {
		targetPath = "/v1/metrics"
	}

	scheme := "https"
	if otelProxyInsecure {
		scheme = "http"
	}
	proxyURL := scheme + "://" + endpoint + targetPath
	proxyReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, proxyURL, strings.NewReader(string(body)))
	if err != nil {
		http.Error(w, `{"error":"proxy error"}`, http.StatusInternalServerError)
		return
	}
	proxyReq.Header.Set("Content-Type", r.Header.Get("Content-Type"))
	if otelProxyAPIHeader != "" && otelProxyAPIKey != "" {
		proxyReq.Header.Set(otelProxyAPIHeader, otelProxyAPIKey)
	}

	resp, err := http.DefaultClient.Do(proxyReq)
	if err != nil {
		slog.Error("telemetry proxy failed", "error", err)
		http.Error(w, `{"error":"proxy error"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// otelProxyEndpoint is set by NewRouterWithConfig when OTel is enabled.
var otelProxyEndpoint string
var otelProxyInsecure bool
var otelProxyAPIKey string
var otelProxyAPIHeader string

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

func corsMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			allowOrigin := ""

			if len(allowedOrigins) == 0 {
				allowOrigin = "*"
			} else {
				for _, ao := range allowedOrigins {
					if ao == "*" {
						allowOrigin = "*"
						break
					}
					if ao == origin {
						allowOrigin = origin
						break
					}
				}
			}

			if allowOrigin != "" {
				w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
				if allowOrigin != "*" {
					w.Header().Set("Vary", "Origin")
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func securityHeadersMiddleware(tlsEnabled bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
			if tlsEnabled {
				w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			}
			next.ServeHTTP(w, r)
		})
	}
}

func handleWebSocket(authSvc *auth.AuthService, database *db.DB, hub *ws.Hub, wsUpgrader websocket.Upgrader) http.HandlerFunc {
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

		conn, err := wsUpgrader.Upgrade(w, r, nil)
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
