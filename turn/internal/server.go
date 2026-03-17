package internal

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"

	"github.com/pion/turn/v4"
)

// Server wraps a pion/turn server with health check HTTP.
type Server struct {
	turnServer *turn.Server
	udpConn    net.PacketConn
	tcpLn      net.Listener
	tlsLn      net.Listener
	healthSrv  *http.Server
}

// New creates and starts a TURN server with the given configuration.
func New(cfg *Config) (*Server, error) {
	s := &Server{}

	authHandler := NewAuthHandler(cfg.SharedSecret, cfg.Realm)

	relayGen := &turn.RelayAddressGeneratorPortRange{
		RelayAddress: net.ParseIP(cfg.PublicIP),
		Address:      cfg.ListenAddr,
		MinPort:      cfg.RelayMinPort,
		MaxPort:      cfg.RelayMaxPort,
	}

	listenAddr := fmt.Sprintf("%s:%d", cfg.ListenAddr, cfg.Port)

	// UDP listener
	udpConn, err := net.ListenPacket("udp4", listenAddr)
	if err != nil {
		return nil, fmt.Errorf("listen UDP %s: %w", listenAddr, err)
	}
	s.udpConn = udpConn
	slog.Info("TURN UDP listening", "addr", listenAddr)

	// TCP listener
	tcpLn, err := net.Listen("tcp4", listenAddr)
	if err != nil {
		udpConn.Close()
		return nil, fmt.Errorf("listen TCP %s: %w", listenAddr, err)
	}
	s.tcpLn = tcpLn
	slog.Info("TURN TCP listening", "addr", listenAddr)

	listenerConfigs := []turn.ListenerConfig{
		{
			Listener:              tcpLn,
			RelayAddressGenerator: relayGen,
		},
	}

	// Optional TLS listener for TURNS
	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			udpConn.Close()
			tcpLn.Close()
			return nil, fmt.Errorf("load TLS cert: %w", err)
		}
		tlsAddr := fmt.Sprintf("%s:%d", cfg.ListenAddr, cfg.TLSPort)
		tlsLn, err := tls.Listen("tcp4", tlsAddr, &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		})
		if err != nil {
			udpConn.Close()
			tcpLn.Close()
			return nil, fmt.Errorf("listen TLS %s: %w", tlsAddr, err)
		}
		s.tlsLn = tlsLn
		listenerConfigs = append(listenerConfigs, turn.ListenerConfig{
			Listener:              tlsLn,
			RelayAddressGenerator: relayGen,
		})
		slog.Info("TURNS TLS listening", "addr", tlsAddr)
	}

	turnServer, err := turn.NewServer(turn.ServerConfig{
		Realm:       cfg.Realm,
		AuthHandler: authHandler,
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn:            udpConn,
				RelayAddressGenerator: relayGen,
			},
		},
		ListenerConfigs: listenerConfigs,
	})
	if err != nil {
		s.closeListeners()
		return nil, fmt.Errorf("create TURN server: %w", err)
	}
	s.turnServer = turnServer

	// Start health check HTTP server
	healthAddr := fmt.Sprintf(":%d", cfg.HealthPort)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	s.healthSrv = &http.Server{Addr: healthAddr, Handler: mux}
	go func() {
		slog.Info("health check listening", "addr", healthAddr)
		if err := s.healthSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("health server error", "error", err)
		}
	}()

	return s, nil
}

// Close gracefully shuts down the TURN server.
func (s *Server) Close() error {
	var firstErr error

	if s.healthSrv != nil {
		if err := s.healthSrv.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	if s.turnServer != nil {
		if err := s.turnServer.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	s.closeListeners()
	return firstErr
}

func (s *Server) closeListeners() {
	if s.tlsLn != nil {
		s.tlsLn.Close()
	}
	if s.tcpLn != nil {
		s.tcpLn.Close()
	}
	if s.udpConn != nil {
		s.udpConn.Close()
	}
}
