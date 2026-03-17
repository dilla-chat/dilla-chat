package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/dilla/dilla-turn/internal"
)

func main() {
	cfg := internal.Load()

	// Configure structured logging.
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
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})))

	if err := cfg.Validate(); err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}

	slog.Info("starting dilla-turn",
		"port", cfg.Port,
		"realm", cfg.Realm,
		"public_ip", cfg.PublicIP,
		"relay_ports", [2]uint16{cfg.RelayMinPort, cfg.RelayMaxPort},
	)

	srv, err := internal.New(cfg)
	if err != nil {
		slog.Error("failed to start TURN server", "error", err)
		os.Exit(1)
	}

	// Wait for shutdown signal.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	<-ctx.Done()
	slog.Info("shutting down TURN server")

	if err := srv.Close(); err != nil {
		slog.Error("shutdown error", "error", err)
	}

	slog.Info("TURN server stopped")
}
