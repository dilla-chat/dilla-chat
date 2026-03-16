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
	AllowedOrigins []string
	TrustedProxies []string
	Insecure       bool

	// OpenTelemetry
	OTelEnabled     bool
	OTelProtocol    string // "grpc" or "http" (default: "grpc")
	OTelEndpoint    string // OTLP endpoint (e.g. "api.honeycomb.io")
	OTelHTTPEndpoint string // dedicated HTTP endpoint (for browser telemetry proxy)
	OTelInsecure    bool
	OTelServiceName string
	OTelAPIKey      string
	OTelAPIHeader   string // auth header name (e.g. "x-honeycomb-team")
}

func Load() *Config {
	// Load .env file if present (does not override existing env vars)
	if err := godotenv.Load(); err == nil {
		slog.Info("loaded .env file")
	}

	cfg := &Config{}

	flag.IntVar(&cfg.Port, "port", envInt("DILLA_PORT", 8080), "HTTP listen port")
	flag.StringVar(&cfg.DataDir, "data-dir", envStr("DILLA_DATA_DIR", "./data"), "Data directory path")
	flag.StringVar(&cfg.DBPassphrase, "db-passphrase", envStr("DILLA_DB_PASSPHRASE", ""), "SQLCipher database passphrase")
	flag.StringVar(&cfg.TLSCert, "tls-cert", envStr("DILLA_TLS_CERT", ""), "TLS certificate file path")
	flag.StringVar(&cfg.TLSKey, "tls-key", envStr("DILLA_TLS_KEY", ""), "TLS key file path")
	flag.StringVar(&cfg.TeamName, "team", envStr("DILLA_TEAM", ""), "Team name")
	flag.IntVar(&cfg.FederationPort, "federation-port", envInt("DILLA_FEDERATION_PORT", 0), "Federation memberlist port (default: port+1)")
	flag.StringVar(&cfg.NodeName, "node-name", envStr("DILLA_NODE_NAME", ""), "Node name for federation")
	flag.StringVar(&cfg.JoinSecret, "join-secret", envStr("DILLA_JOIN_SECRET", ""), "HMAC secret for federation join tokens")
	flag.StringVar(&cfg.FedBindAddr, "fed-bind-addr", envStr("DILLA_FED_BIND_ADDR", "0.0.0.0"), "Federation bind address")
	flag.StringVar(&cfg.FedAdvertAddr, "fed-advertise-addr", envStr("DILLA_FED_ADVERTISE_ADDR", ""), "Federation advertise address")
	flag.IntVar(&cfg.FedAdvertPort, "fed-advertise-port", envInt("DILLA_FED_ADVERTISE_PORT", 0), "Federation advertise port")
	flag.Int64Var(&cfg.MaxUploadSize, "max-upload-size", envInt64("DILLA_MAX_UPLOAD_SIZE", 25*1024*1024), "Maximum upload file size in bytes")
	flag.StringVar(&cfg.UploadDir, "upload-dir", envStr("DILLA_UPLOAD_DIR", ""), "Upload directory (default: {data-dir}/uploads)")
	flag.StringVar(&cfg.LogLevel, "log-level", envStr("DILLA_LOG_LEVEL", "info"), "Log level (debug/info/warn/error)")
	flag.StringVar(&cfg.LogFormat, "log-format", envStr("DILLA_LOG_FORMAT", "text"), "Log format (json/text)")
	flag.Float64Var(&cfg.RateLimit, "rate-limit", envFloat64("DILLA_RATE_LIMIT", 100), "Rate limit requests per second per IP")
	flag.IntVar(&cfg.RateBurst, "rate-burst", envInt("DILLA_RATE_BURST", 200), "Rate limit burst size per IP")
	flag.StringVar(&cfg.Domain, "domain", envStr("DILLA_DOMAIN", ""), "Public domain for WebAuthn passkey RP ID")
	flag.StringVar(&cfg.CFTurnKeyID, "cf-turn-key-id", envStr("DILLA_CF_TURN_KEY_ID", ""), "Cloudflare TURN key ID")
	flag.StringVar(&cfg.CFTurnAPIToken, "cf-turn-api-token", envStr("DILLA_CF_TURN_API_TOKEN", ""), "Cloudflare TURN API token")
	flag.BoolVar(&cfg.Insecure, "insecure", false, "Allow running without DB passphrase (INSECURE)")

	// OpenTelemetry
	cfg.OTelEnabled = envBool("DILLA_OTEL_ENABLED", false)
	cfg.OTelProtocol = envStr("DILLA_OTEL_PROTOCOL", "http")
	cfg.OTelEndpoint = envStr("DILLA_OTEL_ENDPOINT", "localhost:4317")
	cfg.OTelHTTPEndpoint = envStr("DILLA_OTEL_HTTP_ENDPOINT", "")
	cfg.OTelInsecure = envBool("DILLA_OTEL_INSECURE", true)
	cfg.OTelServiceName = envStr("DILLA_OTEL_SERVICE_NAME", "dilla-server")
	cfg.OTelAPIKey = envStr("DILLA_OTEL_API_KEY", "")
	cfg.OTelAPIHeader = envStr("DILLA_OTEL_API_HEADER", "")

	var peers string
	var allowedOrigins string
	var trustedProxies string
	flag.StringVar(&peers, "peers", envStr("DILLA_PEERS", ""), "Comma-separated list of peer addresses")
	flag.StringVar(&allowedOrigins, "allowed-origins", envStr("DILLA_ALLOWED_ORIGINS", ""), "Comma-separated list of allowed CORS origins")
	flag.StringVar(&trustedProxies, "trusted-proxies", envStr("DILLA_TRUSTED_PROXIES", ""), "Comma-separated list of trusted proxy IPs")

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

	if allowedOrigins != "" {
		cfg.AllowedOrigins = strings.Split(allowedOrigins, ",")
		for i := range cfg.AllowedOrigins {
			cfg.AllowedOrigins[i] = strings.TrimSpace(cfg.AllowedOrigins[i])
		}
	}

	if trustedProxies != "" {
		cfg.TrustedProxies = strings.Split(trustedProxies, ",")
		for i := range cfg.TrustedProxies {
			cfg.TrustedProxies[i] = strings.TrimSpace(cfg.TrustedProxies[i])
		}
	}

	return cfg
}

// WarnInsecureDefaults logs warnings for insecure configuration.
func (c *Config) WarnInsecureDefaults() {
	if c.DBPassphrase == "" {
		if c.Insecure {
			slog.Warn("DATABASE IS UNENCRYPTED: running without DB passphrase (--insecure flag set)")
		} else {
			slog.Error("SECURITY: DB passphrase is empty — database will be unencrypted. Set DILLA_DB_PASSPHRASE or use --insecure to acknowledge this risk")
		}
	}
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

func envBool(key string, fallback bool) bool {
	if v := os.Getenv(key); v != "" {
		return strings.EqualFold(v, "true") || v == "1"
	}
	return fallback
}
