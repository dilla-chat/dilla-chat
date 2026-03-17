package internal

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// Config holds all configuration for the TURN server.
type Config struct {
	ListenAddr   string
	Port         int
	TLSPort      int
	TLSCert      string
	TLSKey       string
	Realm        string
	SharedSecret string
	RelayMinPort uint16
	RelayMaxPort uint16
	PublicIP     string
	HealthPort   int
	LogLevel     string
}

// Load reads configuration from environment variables and CLI flags.
func Load() *Config {
	cfg := &Config{}

	flag.StringVar(&cfg.ListenAddr, "listen-addr", envStr("DILLA_TURN_LISTEN_ADDR", "0.0.0.0"), "Listen address")
	flag.IntVar(&cfg.Port, "port", envInt("DILLA_TURN_PORT", 3478), "TURN UDP/TCP port")
	flag.IntVar(&cfg.TLSPort, "tls-port", envInt("DILLA_TURN_TLS_PORT", 5349), "TURNS TLS port")
	flag.StringVar(&cfg.TLSCert, "tls-cert", envStr("DILLA_TURN_TLS_CERT", ""), "TLS certificate path")
	flag.StringVar(&cfg.TLSKey, "tls-key", envStr("DILLA_TURN_TLS_KEY", ""), "TLS key path")
	flag.StringVar(&cfg.Realm, "realm", envStr("DILLA_TURN_REALM", "dilla"), "TURN realm")
	flag.StringVar(&cfg.SharedSecret, "shared-secret", envStr("DILLA_TURN_SHARED_SECRET", ""), "HMAC shared secret for credential validation")
	flag.StringVar(&cfg.PublicIP, "public-ip", envStr("DILLA_TURN_PUBLIC_IP", ""), "Public IP for relay address allocation")
	flag.IntVar(&cfg.HealthPort, "health-port", envInt("DILLA_TURN_HEALTH_PORT", 8081), "Health check HTTP port")
	flag.StringVar(&cfg.LogLevel, "log-level", envStr("DILLA_TURN_LOG_LEVEL", "info"), "Log level (debug/info/warn/error)")

	var relayMin, relayMax int
	flag.IntVar(&relayMin, "relay-min-port", envInt("DILLA_TURN_RELAY_MIN_PORT", 49152), "Relay port range minimum")
	flag.IntVar(&relayMax, "relay-max-port", envInt("DILLA_TURN_RELAY_MAX_PORT", 65535), "Relay port range maximum")

	flag.Parse()

	cfg.RelayMinPort = uint16(relayMin)
	cfg.RelayMaxPort = uint16(relayMax)

	return cfg
}

// Validate checks that required configuration is present.
func (c *Config) Validate() error {
	if c.SharedSecret == "" {
		return fmt.Errorf("shared secret is required (set DILLA_TURN_SHARED_SECRET)")
	}
	if c.PublicIP == "" {
		return fmt.Errorf("public IP is required (set DILLA_TURN_PUBLIC_IP)")
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("invalid port: %d", c.Port)
	}
	if c.RelayMinPort >= c.RelayMaxPort {
		return fmt.Errorf("relay-min-port must be less than relay-max-port")
	}
	return nil
}

func envStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		var i int
		if _, err := fmt.Sscanf(v, "%d", &i); err == nil {
			return i
		}
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		return strings.EqualFold(v, "true") || v == "1"
	}
	return fallback
}
