package config

import (
	"flag"
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Port           int
	DataDir        string
	DBPassphrase   string
	TLSCert        string
	TLSKey         string
	Peers          []string
	TeamName       string
	FederationPort int
	NodeName       string
	JoinSecret     string
	FedBindAddr    string
	FedAdvertAddr  string
	FedAdvertPort  int
	MaxUploadSize  int64
	UploadDir      string
	LogLevel       string
	LogFormat      string
	RateLimit      float64
	RateBurst      int
	Domain         string
	CFTurnKeyID    string
	CFTurnAPIToken string
}

func Load() *Config {
	// Load .env file if present (does not override existing env vars)
	if err := godotenv.Load(); err == nil {
		slog.Info("loaded .env file")
	}

	cfg := &Config{}

	flag.IntVar(&cfg.Port, "port", envInt("SLIMCORD_PORT", 8080), "HTTP listen port")
	flag.StringVar(&cfg.DataDir, "data-dir", envStr("SLIMCORD_DATA_DIR", "./data"), "Data directory path")
	flag.StringVar(&cfg.DBPassphrase, "db-passphrase", envStr("SLIMCORD_DB_PASSPHRASE", ""), "SQLCipher database passphrase")
	flag.StringVar(&cfg.TLSCert, "tls-cert", envStr("SLIMCORD_TLS_CERT", ""), "TLS certificate file path")
	flag.StringVar(&cfg.TLSKey, "tls-key", envStr("SLIMCORD_TLS_KEY", ""), "TLS key file path")
	flag.StringVar(&cfg.TeamName, "team", envStr("SLIMCORD_TEAM", ""), "Team name")
	flag.IntVar(&cfg.FederationPort, "federation-port", envInt("SLIMCORD_FEDERATION_PORT", 0), "Federation memberlist port (default: port+1)")
	flag.StringVar(&cfg.NodeName, "node-name", envStr("SLIMCORD_NODE_NAME", ""), "Node name for federation")
	flag.StringVar(&cfg.JoinSecret, "join-secret", envStr("SLIMCORD_JOIN_SECRET", ""), "HMAC secret for federation join tokens")
	flag.StringVar(&cfg.FedBindAddr, "fed-bind-addr", envStr("SLIMCORD_FED_BIND_ADDR", "0.0.0.0"), "Federation bind address")
	flag.StringVar(&cfg.FedAdvertAddr, "fed-advertise-addr", envStr("SLIMCORD_FED_ADVERTISE_ADDR", ""), "Federation advertise address")
	flag.IntVar(&cfg.FedAdvertPort, "fed-advertise-port", envInt("SLIMCORD_FED_ADVERTISE_PORT", 0), "Federation advertise port")
	flag.Int64Var(&cfg.MaxUploadSize, "max-upload-size", envInt64("SLIMCORD_MAX_UPLOAD_SIZE", 25*1024*1024), "Maximum upload file size in bytes")
	flag.StringVar(&cfg.UploadDir, "upload-dir", envStr("SLIMCORD_UPLOAD_DIR", ""), "Upload directory (default: {data-dir}/uploads)")
	flag.StringVar(&cfg.LogLevel, "log-level", envStr("SLIMCORD_LOG_LEVEL", "info"), "Log level (debug/info/warn/error)")
	flag.StringVar(&cfg.LogFormat, "log-format", envStr("SLIMCORD_LOG_FORMAT", "text"), "Log format (json/text)")
	flag.Float64Var(&cfg.RateLimit, "rate-limit", envFloat64("SLIMCORD_RATE_LIMIT", 100), "Rate limit requests per second per IP")
	flag.IntVar(&cfg.RateBurst, "rate-burst", envInt("SLIMCORD_RATE_BURST", 200), "Rate limit burst size per IP")
	flag.StringVar(&cfg.Domain, "domain", envStr("SLIMCORD_DOMAIN", ""), "Public domain for WebAuthn passkey RP ID")
	flag.StringVar(&cfg.CFTurnKeyID, "cf-turn-key-id", envStr("SLIMCORD_CF_TURN_KEY_ID", ""), "Cloudflare TURN key ID")
	flag.StringVar(&cfg.CFTurnAPIToken, "cf-turn-api-token", envStr("SLIMCORD_CF_TURN_API_TOKEN", ""), "Cloudflare TURN API token")

	var peers string
	flag.StringVar(&peers, "peers", envStr("SLIMCORD_PEERS", ""), "Comma-separated list of peer addresses")

	flag.Parse()

	if peers != "" {
		cfg.Peers = strings.Split(peers, ",")
	}

	if cfg.FederationPort == 0 {
		cfg.FederationPort = cfg.Port + 1
	}

	if cfg.UploadDir == "" {
		cfg.UploadDir = cfg.DataDir + "/uploads"
	}

	return cfg
}

func (c *Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("invalid port: %d", c.Port)
	}
	if c.DataDir == "" {
		return fmt.Errorf("data-dir is required")
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

func envInt64(key string, fallback int64) int64 {
	if v := os.Getenv(key); v != "" {
		var i int64
		if _, err := fmt.Sscanf(v, "%d", &i); err == nil {
			return i
		}
	}
	return fallback
}

func envFloat64(key string, fallback float64) float64 {
	if v := os.Getenv(key); v != "" {
		var f float64
		if _, err := fmt.Sscanf(v, "%f", &f); err == nil {
			return f
		}
	}
	return fallback
}
