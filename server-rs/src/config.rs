use std::env;
use std::fmt;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub data_dir: String,
    pub db_passphrase: String,
    pub tls_cert: String,
    pub tls_key: String,
    pub peers: Vec<String>,
    pub team_name: String,
    pub federation_port: u16,
    pub node_name: String,
    pub join_secret: String,
    pub fed_bind_addr: String,
    pub fed_advert_addr: String,
    pub fed_advert_port: u16,
    pub max_upload_size: i64,
    pub upload_dir: String,
    pub log_level: String,
    pub log_format: String,
    pub rate_limit: f64,
    pub rate_burst: u32,
    pub domain: String,
    pub cf_turn_key_id: String,
    pub cf_turn_api_token: String,
    pub turn_mode: String,
    pub turn_shared_secret: String,
    pub turn_urls: String,
    pub turn_ttl: u64,
    pub allowed_origins: Vec<String>,
    pub trusted_proxies: Vec<String>,
    pub insecure: bool,

    // OpenTelemetry
    pub otel_enabled: bool,
    pub otel_protocol: String,
    pub otel_endpoint: String,
    pub otel_http_endpoint: String,
    pub otel_insecure: bool,
    pub otel_service_name: String,
    pub otel_api_key: String,
    pub otel_api_header: String,
}

impl Config {
    pub fn load() -> Self {
        // Load .env file if present.
        if dotenvy::dotenv().is_ok() {
            tracing::info!("loaded .env file");
        }

        let port = env_u16("DILLA_PORT", 8080);

        let data_dir = env_str("DILLA_DATA_DIR", "./data");

        let federation_port = env_u16("DILLA_FEDERATION_PORT", 0);
        let federation_port = if federation_port == 0 {
            port + 1
        } else {
            federation_port
        };

        let upload_dir = env_str("DILLA_UPLOAD_DIR", "");
        let upload_dir = if upload_dir.is_empty() {
            format!("{}/uploads", data_dir)
        } else {
            upload_dir
        };

        let peers_str = env_str("DILLA_PEERS", "");
        let peers: Vec<String> = if peers_str.is_empty() {
            Vec::new()
        } else {
            peers_str.split(',').map(|s| s.trim().to_string()).collect()
        };

        let allowed_str = env_str("DILLA_ALLOWED_ORIGINS", "");
        let allowed_origins: Vec<String> = if allowed_str.is_empty() {
            Vec::new()
        } else {
            allowed_str
                .split(',')
                .map(|s| s.trim().to_string())
                .collect()
        };

        let proxies_str = env_str("DILLA_TRUSTED_PROXIES", "");
        let trusted_proxies: Vec<String> = if proxies_str.is_empty() {
            Vec::new()
        } else {
            proxies_str
                .split(',')
                .map(|s| s.trim().to_string())
                .collect()
        };

        Config {
            port,
            data_dir,
            db_passphrase: env_str("DILLA_DB_PASSPHRASE", ""),
            tls_cert: env_str("DILLA_TLS_CERT", ""),
            tls_key: env_str("DILLA_TLS_KEY", ""),
            peers,
            team_name: env_str("DILLA_TEAM", ""),
            federation_port,
            node_name: env_str("DILLA_NODE_NAME", ""),
            join_secret: env_str("DILLA_JOIN_SECRET", ""),
            fed_bind_addr: env_str("DILLA_FED_BIND_ADDR", "0.0.0.0"),
            fed_advert_addr: env_str("DILLA_FED_ADVERTISE_ADDR", ""),
            fed_advert_port: env_u16("DILLA_FED_ADVERTISE_PORT", 0),
            max_upload_size: env_i64("DILLA_MAX_UPLOAD_SIZE", 25 * 1024 * 1024),
            upload_dir,
            log_level: env_str("DILLA_LOG_LEVEL", "info"),
            log_format: env_str("DILLA_LOG_FORMAT", "text"),
            rate_limit: env_f64("DILLA_RATE_LIMIT", 100.0),
            rate_burst: env_u32("DILLA_RATE_BURST", 200),
            domain: env_str("DILLA_DOMAIN", ""),
            cf_turn_key_id: env_str("DILLA_CF_TURN_KEY_ID", ""),
            cf_turn_api_token: env_str("DILLA_CF_TURN_API_TOKEN", ""),
            turn_mode: env_str("DILLA_TURN_MODE", ""),
            turn_shared_secret: env_str("DILLA_TURN_SHARED_SECRET", ""),
            turn_urls: env_str("DILLA_TURN_URLS", ""),
            turn_ttl: env_u64("DILLA_TURN_TTL", 86400),
            allowed_origins,
            trusted_proxies,
            insecure: env_bool("DILLA_INSECURE", false),
            otel_enabled: env_bool("DILLA_OTEL_ENABLED", false),
            otel_protocol: env_str("DILLA_OTEL_PROTOCOL", "http"),
            otel_endpoint: env_str("DILLA_OTEL_ENDPOINT", "localhost:4317"),
            otel_http_endpoint: env_str("DILLA_OTEL_HTTP_ENDPOINT", ""),
            otel_insecure: env_bool("DILLA_OTEL_INSECURE", false),
            otel_service_name: env_str("DILLA_OTEL_SERVICE_NAME", "dilla-server"),
            otel_api_key: env_str("DILLA_OTEL_API_KEY", ""),
            otel_api_header: env_str("DILLA_OTEL_API_HEADER", ""),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 || self.port > 65534 {
            return Err(format!("invalid port: {}", self.port));
        }
        if self.data_dir.is_empty() {
            return Err("data-dir is required".into());
        }
        Ok(())
    }

    pub fn warn_insecure_defaults(&self) {
        if self.db_passphrase.is_empty() {
            if self.insecure {
                tracing::warn!(
                    "DATABASE IS UNENCRYPTED: running without DB passphrase (--insecure flag set)"
                );
            } else {
                tracing::error!("SECURITY: DB passphrase is empty — database will be unencrypted. Set DILLA_DB_PASSPHRASE or use --insecure to acknowledge this risk");
            }
        }
        if self.allowed_origins.is_empty() {
            tracing::warn!(
                "SECURITY: CORS allows all origins — set DILLA_ALLOWED_ORIGINS for production"
            );
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("port", &self.port)
            .field("data_dir", &self.data_dir)
            .field("db_passphrase", &if self.db_passphrase.is_empty() { "<empty>" } else { "<redacted>" })
            .field("tls_cert", &self.tls_cert)
            .field("tls_key", &if self.tls_key.is_empty() { "<empty>" } else { "<redacted>" })
            .field("peers", &self.peers)
            .field("team_name", &self.team_name)
            .field("federation_port", &self.federation_port)
            .field("node_name", &self.node_name)
            .field("join_secret", &if self.join_secret.is_empty() { "<empty>" } else { "<redacted>" })
            .field("domain", &self.domain)
            .field("cf_turn_key_id", &self.cf_turn_key_id)
            .field("cf_turn_api_token", &if self.cf_turn_api_token.is_empty() { "<empty>" } else { "<redacted>" })
            .field("turn_mode", &self.turn_mode)
            .field("turn_shared_secret", &if self.turn_shared_secret.is_empty() { "<empty>" } else { "<redacted>" })
            .field("allowed_origins", &self.allowed_origins)
            .field("insecure", &self.insecure)
            .field("otel_enabled", &self.otel_enabled)
            .field("otel_api_key", &if self.otel_api_key.is_empty() { "<empty>" } else { "<redacted>" })
            .finish_non_exhaustive()
    }
}

fn env_str(key: &str, fallback: &str) -> String {
    env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn env_u16(key: &str, fallback: u16) -> u16 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn env_u32(key: &str, fallback: u32) -> u32 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn env_u64(key: &str, fallback: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn env_i64(key: &str, fallback: i64) -> i64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn env_f64(key: &str, fallback: f64) -> f64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn env_bool(key: &str, fallback: bool) -> bool {
    env::var(key)
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build a Config with sensible defaults for testing.
    fn test_config() -> Config {
        Config {
            port: 8080,
            data_dir: "./data".into(),
            db_passphrase: "super-secret-passphrase".into(),
            tls_cert: "cert.pem".into(),
            tls_key: "private-key-material".into(),
            peers: vec![],
            team_name: "test-team".into(),
            federation_port: 8081,
            node_name: "node1".into(),
            join_secret: "join-secret-value".into(),
            fed_bind_addr: "0.0.0.0".into(),
            fed_advert_addr: "".into(),
            fed_advert_port: 0,
            max_upload_size: 25 * 1024 * 1024,
            upload_dir: "./data/uploads".into(),
            log_level: "info".into(),
            log_format: "text".into(),
            rate_limit: 100.0,
            rate_burst: 200,
            domain: "example.com".into(),
            cf_turn_key_id: "key-id-123".into(),
            cf_turn_api_token: "cf-turn-token-secret".into(),
            turn_mode: "cloudflare".into(),
            turn_shared_secret: "turn-shared-secret-value".into(),
            turn_urls: "".into(),
            turn_ttl: 86400,
            allowed_origins: vec![],
            trusted_proxies: vec![],
            insecure: false,
            otel_enabled: false,
            otel_protocol: "http".into(),
            otel_endpoint: "localhost:4317".into(),
            otel_http_endpoint: "".into(),
            otel_insecure: false,
            otel_service_name: "dilla-server".into(),
            otel_api_key: "otel-api-key-secret".into(),
            otel_api_header: "x-api-key".into(),
        }
    }

    #[test]
    fn test_config_debug_redacts_secrets() {
        let cfg = test_config();
        let debug_output = format!("{:?}", cfg);

        // The debug output must contain <redacted> for all secret fields.
        assert!(
            debug_output.contains("<redacted>"),
            "debug output should contain <redacted>"
        );

        // The actual secret values must NOT appear in the debug output.
        let secrets = [
            "super-secret-passphrase",
            "private-key-material",
            "join-secret-value",
            "cf-turn-token-secret",
            "turn-shared-secret-value",
            "otel-api-key-secret",
        ];
        for secret in &secrets {
            assert!(
                !debug_output.contains(secret),
                "debug output must not contain secret value: {}",
                secret
            );
        }

        // Non-secret fields should still appear.
        assert!(debug_output.contains("8080"), "port should be visible");
        assert!(
            debug_output.contains("example.com"),
            "domain should be visible"
        );
    }

    #[test]
    fn test_config_debug_shows_empty_for_unset_secrets() {
        let mut cfg = test_config();
        cfg.db_passphrase = String::new();
        cfg.tls_key = String::new();
        cfg.join_secret = String::new();
        cfg.cf_turn_api_token = String::new();
        cfg.turn_shared_secret = String::new();
        cfg.otel_api_key = String::new();

        let debug_output = format!("{:?}", cfg);

        // When secrets are empty, they should show <empty> instead of <redacted>.
        assert!(
            debug_output.contains("<empty>"),
            "debug output should contain <empty> for unset secrets"
        );
    }

    #[test]
    fn test_config_validate_valid() {
        let cfg = test_config();
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn test_config_validate_invalid_port() {
        let mut cfg = test_config();
        cfg.port = 0;
        assert!(cfg.validate().is_err());
    }
}
