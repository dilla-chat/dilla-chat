package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dilla/dilla-server/internal/api"
	"github.com/dilla/dilla-server/internal/auth"
	"github.com/dilla/dilla-server/internal/config"
	"github.com/dilla/dilla-server/internal/db"
	"github.com/dilla/dilla-server/internal/federation"
	"github.com/dilla/dilla-server/internal/observability"
	"github.com/dilla/dilla-server/internal/presence"
	"github.com/dilla/dilla-server/internal/voice"
	"github.com/dilla/dilla-server/internal/ws"
)

// version is set at build time via -ldflags.
var version = "dev"

func main() {
	cfg := config.Load()

	// Configure structured logging (initial stdout-only handler for startup).
	var logLevel slog.Level
	switch strings.ToLower(cfg.LogLevel) {
	case "debug":
		logLevel = slog.LevelDebug
	case "warn":
		logLevel = slog.LevelWarn
	case "error":
		logLevel = slog.LevelError
	default:
		logLevel = slog.LevelInfo
	}

	handlerOpts := &slog.HandlerOptions{Level: logLevel}
	var logHandler slog.Handler
	if strings.ToLower(cfg.LogFormat) == "json" {
		logHandler = slog.NewJSONHandler(os.Stdout, handlerOpts)
	} else {
		logHandler = slog.NewTextHandler(os.Stdout, handlerOpts)
	}
	slog.SetDefault(slog.New(logHandler))

	// Propagate build-time version to the API package.
	api.Version = version
	if err := cfg.Validate(); err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	cfg.WarnInsecureDefaults()

	// Initialize observability (tracing, metrics, logs).
	otelProviders, err := observability.Init(context.Background(), observability.Config{
		Enabled:        cfg.OTelEnabled,
		Protocol:       cfg.OTelProtocol,
		Endpoint:       cfg.OTelEndpoint,
		HTTPEndpoint:   cfg.OTelHTTPEndpoint,
		Insecure:       cfg.OTelInsecure,
		ServiceName:    cfg.OTelServiceName,
		ServiceVersion: version,
		APIKey:         cfg.OTelAPIKey,
		APIHeader:      cfg.OTelAPIHeader,
		LogFormat:      cfg.LogFormat,
		LogLevel:       logLevel,
	})
	if err != nil {
		slog.Error("failed to initialize observability", "error", err)
		os.Exit(1)
	}
	defer otelProviders.Shutdown(context.Background())

	// Replace slog default with dual handler (stdout + OTel) when enabled.
	slog.SetDefault(slog.New(observability.NewSlogHandler(otelProviders, observability.Config{
		LogFormat: cfg.LogFormat,
		LogLevel:  logLevel,
	})))

	metrics := observability.NewMetrics()

	// Create data directory if it does not exist.
	if err := db.EnsureDataDir(cfg.DataDir); err != nil {
		slog.Error("failed to create data directory", "error", err)
		os.Exit(1)
	}

	// Open database.
	database, err := db.Open(cfg.DataDir, cfg.DBPassphrase)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	// Run migrations.
	if err := database.RunMigrations(); err != nil {
		slog.Error("failed to run migrations", "error", err)
		os.Exit(1)
	}

	// Create auth service.
	authSvc := auth.NewAuthService(database)

	// Check for first start (no users) and print bootstrap link.
	hasUsers, err := database.HasUsers()
	if err != nil {
		slog.Error("failed to check users", "error", err)
		os.Exit(1)
	}
	if !hasUsers {
		token, err := authSvc.GenerateBootstrapToken()
		if err != nil {
			slog.Error("failed to generate bootstrap token", "error", err)
			os.Exit(1)
		}
		fmt.Printf("\n  *** First-time setup ***\n")
		fmt.Printf("  Open your client UI and navigate to /setup, or use this link:\n")
		fmt.Printf("  http://localhost:5173/setup?token=%s\n", token)
		fmt.Printf("  Bootstrap token: %s\n\n", token)
	}

	// Set up WebSocket hub.
	hub := ws.NewHub(database)
	if cfg.OTelEnabled {
		hub.Metrics = metrics
	}
	go hub.Run()

	// Set up voice subsystem.
	voiceRM := voice.NewRoomManager()
	voiceSFU := voice.NewSFU(voiceRM)
	hub.VoiceRoomManager = voiceRM
	hub.VoiceSFU = voiceSFU

	// Wire SFU ICE candidate and renegotiation events back to the hub.
	voiceSFU.OnEvent = func(channelID string, event interface{}) {
		switch e := event.(type) {
		case *voice.ICECandidateEvent:
			sdpMid := ""
			if e.Candidate.SDPMid != nil {
				sdpMid = *e.Candidate.SDPMid
			}
			var sdpMLine uint16
			if e.Candidate.SDPMLineIndex != nil {
				sdpMLine = *e.Candidate.SDPMLineIndex
			}
			evt, err := ws.MakeEvent(ws.EventVoiceICEOut, ws.VoiceICECandidatePayload{
				ChannelID: e.ChannelID,
				Candidate: e.Candidate.Candidate,
				SDPMid:    sdpMid,
				SDPMLine:  sdpMLine,
			})
			if err == nil {
				hub.SendToUser(e.UserID, evt)
			}
		case *voice.RenegotiateEvent:
			evt, err := ws.MakeEvent(ws.EventVoiceOffer, ws.VoiceOfferPayload{
				ChannelID: e.ChannelID,
				SDP:       e.Offer.SDP,
			})
			if err == nil {
				hub.SendToUser(e.UserID, evt)
			}
		}
	}

	// Set up Cloudflare TURN client for voice relay.
	var cfTurnClient *voice.CFTurnClient
	if cfg.CFTurnKeyID != "" && cfg.CFTurnAPIToken != "" {
		cfTurnClient = voice.NewCFTurnClient(voice.CFTurnConfig{
			KeyID:    cfg.CFTurnKeyID,
			APIToken: cfg.CFTurnAPIToken,
		})
		voiceSFU.SetCFTurnClient(cfTurnClient)
		slog.Info("Cloudflare TURN enabled for voice relay")
	} else {
		slog.Warn("Cloudflare TURN disabled: set DILLA_CF_TURN_KEY_ID and DILLA_CF_TURN_API_TOKEN to enable voice relay")
	}

	// Set up presence manager.
	presenceMgr := presence.NewPresenceManager()
	presenceMgr.OnBroadcast = func(userID, statusType, customStatus string) {
		evt, err := ws.MakeEvent(ws.EventPresenceChanged, ws.PresenceUpdatePayload{
			UserID:     userID,
			StatusType: statusType,
			StatusText: customStatus,
		})
		if err != nil {
			return
		}
		hub.BroadcastToAllClients(evt)
	}
	presenceMgr.StartIdleChecker(30 * time.Second)

	// Wire hub presence callbacks to the presence manager.
	hub.OnClientConnect = func(userID string) {
		presenceMgr.SetOnline(userID)
	}
	hub.OnClientDisconnect = func(userID string) {
		presenceMgr.SetOffline(userID)
	}
	hub.OnClientActivity = func(userID string) {
		presenceMgr.UpdateActivity(userID)
	}
	hub.OnPresenceUpdate = func(userID, statusType, customStatus string) {
		presenceMgr.UpdatePresence(userID, presence.Status(statusType), customStatus)
		_ = database.UpdateUserStatus(userID, statusType, customStatus)
	}
	hub.GetAllPresences = func() interface{} {
		return presenceMgr.GetAllPresences()
	}

	// Set up federation mesh (if peers configured or federation port set).
	var meshNode *federation.MeshNode
	meshCfg := &federation.MeshConfig{
		NodeName:      cfg.NodeName,
		BindAddr:      cfg.FedBindAddr,
		BindPort:      cfg.FederationPort,
		AdvertiseAddr: cfg.FedAdvertAddr,
		AdvertisePort: cfg.FedAdvertPort,
		Peers:         cfg.Peers,
		TLSCert:       cfg.TLSCert,
		TLSKey:        cfg.TLSKey,
		JoinSecret:    cfg.JoinSecret,
	}

	meshNode, err = federation.NewMeshNode(meshCfg, database, hub)
	if err != nil {
		slog.Error("failed to create mesh node", "error", err)
		os.Exit(1)
	}

	// Wire federation callbacks into the hub.
	hub.OnMessageSend = func(msg *db.Message, username string) {
		meshNode.BroadcastMessage(&federation.ReplicationMessage{
			MessageID: msg.ID,
			ChannelID: msg.ChannelID,
			AuthorID:  msg.AuthorID,
			Username:  username,
			Content:   string(msg.Content),
			Type:      msg.Type,
			ThreadID:  msg.ThreadID,
			LamportTS: uint64(msg.LamportTS),
			CreatedAt: msg.CreatedAt.Format(time.RFC3339),
		})
	}
	hub.OnMessageEdit = func(messageID, channelID, content string) {
		meshNode.BroadcastMessageEdit(messageID, channelID, content)
	}
	hub.OnMessageDelete = func(messageID, channelID string) {
		meshNode.BroadcastMessageDelete(messageID, channelID)
	}

	// Wire presence federation.
	presenceMgr.OnFederation = func(userID, statusType, customStatus string) {
		meshNode.BroadcastPresenceChanged(userID, statusType, customStatus)
	}
	federation.OnFederatedPresence = func(userID, statusType, customStatus string) {
		presenceMgr.HandleFederatedPresence(userID, statusType, customStatus)
	}

	// Wire voice federation: sync room state (who's in which voice channel) across nodes.
	hub.OnVoiceJoin = func(channelID, userID, username string) {
		meshNode.BroadcastVoiceUserJoined(channelID, userID, username)
	}
	hub.OnVoiceLeave = func(channelID, userID string) {
		meshNode.BroadcastVoiceUserLeft(channelID, userID)
	}
	federation.OnFederatedVoiceUserJoined = func(channelID, userID, username string) {
		// Broadcast to local WS clients so they see remote voice state.
		evt, err := ws.MakeEvent(ws.EventVoiceUserJoined, ws.VoiceUserJoinedPayload{
			ChannelID: channelID,
			UserID:    userID,
			Username:  username,
		})
		if err == nil {
			hub.BroadcastToChannel(channelID, evt, nil)
		}
	}
	federation.OnFederatedVoiceUserLeft = func(channelID, userID string) {
		evt, err := ws.MakeEvent(ws.EventVoiceUserLeft, ws.VoiceUserLeftPayload{
			ChannelID: channelID,
			UserID:    userID,
		})
		if err == nil {
			hub.BroadcastToChannel(channelID, evt, nil)
		}
	}

	if len(cfg.Peers) > 0 {
		if err := meshNode.Start(); err != nil {
			slog.Error("failed to start federation mesh", "error", err)
			os.Exit(1)
		}
		slog.Info("federation mesh started", "node", meshCfg.NodeName, "peers", len(cfg.Peers))
	}

	// Set up HTTP router.
	rcfg := api.RouterConfig{
		MaxUploadSize:    cfg.MaxUploadSize,
		UploadDir:        cfg.UploadDir,
		PresenceManager:  presenceMgr,
		VoiceRoomManager: voiceRM,
		RateLimit:        cfg.RateLimit,
		RateBurst:        cfg.RateBurst,
		Domain:           cfg.Domain,
		TURNClient:       cfTurnClient,
		AllowedOrigins:   cfg.AllowedOrigins,
		TrustedProxies:   cfg.TrustedProxies,
		TLSEnabled:       cfg.TLSCert != "",
	}
	if cfg.OTelEnabled {
		rcfg.OTelMetrics = metrics
		rcfg.OTelInsecure = cfg.OTelInsecure
		// Browser telemetry proxy always forwards via OTLP/HTTP.
		// Use the dedicated HTTP endpoint if set, otherwise derive from gRPC endpoint.
		rcfg.OTelEndpoint = cfg.OTelHTTPEndpoint
		if rcfg.OTelEndpoint == "" {
			rcfg.OTelEndpoint = cfg.OTelEndpoint
		}
		rcfg.OTelAPIKey = cfg.OTelAPIKey
		rcfg.OTelAPIHeader = cfg.OTelAPIHeader
	}
	router := api.NewRouterWithConfig(database, authSvc, hub, rcfg, meshNode)

	addr := fmt.Sprintf(":%d", cfg.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("server starting", "addr", addr, "team", cfg.TeamName)
		var listenErr error
		if cfg.TLSCert != "" && cfg.TLSKey != "" {
			listenErr = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			listenErr = srv.ListenAndServe()
		}
		if listenErr != nil && listenErr != http.ErrServerClosed {
			slog.Error("server error", "error", listenErr)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down server")

	// Flush OTel before shutting down HTTP server.
	otelProviders.Shutdown(context.Background())

	// Stop federation mesh before HTTP server.
	if meshNode != nil {
		meshNode.Stop()
	}

	// Stop presence manager.
	presenceMgr.Stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}

	slog.Info("server stopped")
}
