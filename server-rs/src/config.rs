use std::env;
use std::fmt;

#[derive(Clone)]
#[allow(dead_code)]
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
    pub theme_file: String,

    // Client telemetry relay
    pub telemetry_adapter: String,
    pub sentry_dsn: String,
    pub environment: String,

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
            theme_file: env_str("DILLA_THEME_FILE", ""),
            telemetry_adapter: env_str("DILLA_TELEMETRY_ADAPTER", "none"),
            sentry_dsn: env_str("DILLA_SENTRY_DSN", ""),
            environment: env_str("DILLA_ENVIRONMENT", "production"),
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
    use std::sync::Mutex;

    // Global mutex to prevent env var test races (env vars are process-global).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Helper to set env vars, run a closure, then clean up.
    fn with_env_vars<F: FnOnce()>(vars: &[(&str, &str)], f: F) {
        let _guard = ENV_LOCK.lock().unwrap();
        // Set vars
        for (k, v) in vars {
            env::set_var(k, v);
        }
        f();
        // Clean up
        for (k, _) in vars {
            env::remove_var(k);
        }
    }

    // --- env helper function tests (tested indirectly through Config::load) ---

    #[test]
    fn env_str_returns_value_when_set() {
        with_env_vars(&[("DILLA_TEAM", "my-team")], || {
            let cfg = Config::load();
            assert_eq!(cfg.team_name, "my-team");
        });
    }

    #[test]
    fn env_str_returns_fallback_when_unset() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            assert_eq!(cfg.data_dir, "./data");
            assert_eq!(cfg.log_level, "info");
            assert_eq!(cfg.log_format, "text");
        });
    }

    #[test]
    fn env_u16_parses_valid_value() {
        with_env_vars(&[("DILLA_PORT", "9090")], || {
            let cfg = Config::load();
            assert_eq!(cfg.port, 9090);
        });
    }

    #[test]
    fn env_u16_falls_back_on_invalid() {
        with_env_vars(&[("DILLA_PORT", "not_a_number")], || {
            let cfg = Config::load();
            assert_eq!(cfg.port, 8080); // default
        });
    }

    #[test]
    fn env_u16_falls_back_on_overflow() {
        with_env_vars(&[("DILLA_PORT", "99999")], || {
            let cfg = Config::load();
            assert_eq!(cfg.port, 8080);
        });
    }

    #[test]
    fn env_u32_parses_valid_value() {
        with_env_vars(&[("DILLA_RATE_BURST", "500")], || {
            let cfg = Config::load();
            assert_eq!(cfg.rate_burst, 500);
        });
    }

    #[test]
    fn env_u32_falls_back_on_invalid() {
        with_env_vars(&[("DILLA_RATE_BURST", "xyz")], || {
            let cfg = Config::load();
            assert_eq!(cfg.rate_burst, 200);
        });
    }

    #[test]
    fn env_u64_parses_valid_value() {
        with_env_vars(&[("DILLA_TURN_TTL", "3600")], || {
            let cfg = Config::load();
            assert_eq!(cfg.turn_ttl, 3600);
        });
    }

    #[test]
    fn env_i64_parses_valid_value() {
        with_env_vars(&[("DILLA_MAX_UPLOAD_SIZE", "1048576")], || {
            let cfg = Config::load();
            assert_eq!(cfg.max_upload_size, 1048576);
        });
    }

    #[test]
    fn env_i64_parses_negative() {
        with_env_vars(&[("DILLA_MAX_UPLOAD_SIZE", "-1")], || {
            let cfg = Config::load();
            assert_eq!(cfg.max_upload_size, -1);
        });
    }

    #[test]
    fn env_f64_parses_valid_value() {
        with_env_vars(&[("DILLA_RATE_LIMIT", "50.5")], || {
            let cfg = Config::load();
            assert!((cfg.rate_limit - 50.5).abs() < f64::EPSILON);
        });
    }

    #[test]
    fn env_f64_falls_back_on_invalid() {
        with_env_vars(&[("DILLA_RATE_LIMIT", "abc")], || {
            let cfg = Config::load();
            assert!((cfg.rate_limit - 100.0).abs() < f64::EPSILON);
        });
    }

    #[test]
    fn env_bool_true_values() {
        with_env_vars(&[("DILLA_INSECURE", "true")], || {
            let cfg = Config::load();
            assert!(cfg.insecure);
        });
    }

    #[test]
    fn env_bool_true_uppercase() {
        with_env_vars(&[("DILLA_INSECURE", "TRUE")], || {
            let cfg = Config::load();
            assert!(cfg.insecure);
        });
    }

    #[test]
    fn env_bool_true_as_1() {
        with_env_vars(&[("DILLA_INSECURE", "1")], || {
            let cfg = Config::load();
            assert!(cfg.insecure);
        });
    }

    #[test]
    fn env_bool_false_values() {
        with_env_vars(&[("DILLA_INSECURE", "false")], || {
            let cfg = Config::load();
            assert!(!cfg.insecure);
        });
    }

    #[test]
    fn env_bool_false_on_arbitrary_string() {
        with_env_vars(&[("DILLA_INSECURE", "yes")], || {
            let cfg = Config::load();
            assert!(!cfg.insecure);
        });
    }

    #[test]
    fn env_bool_fallback_when_unset() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            assert!(!cfg.insecure); // default false
        });
    }

    // --- Peers parsing ---

    #[test]
    fn peers_parsed_from_comma_separated() {
        with_env_vars(&[("DILLA_PEERS", "ws://a:8081,ws://b:8082")], || {
            let cfg = Config::load();
            assert_eq!(cfg.peers, vec!["ws://a:8081", "ws://b:8082"]);
        });
    }

    #[test]
    fn peers_empty_when_unset() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            assert!(cfg.peers.is_empty());
        });
    }

    #[test]
    fn peers_trims_whitespace() {
        with_env_vars(&[("DILLA_PEERS", " ws://a:8081 , ws://b:8082 ")], || {
            let cfg = Config::load();
            assert_eq!(cfg.peers, vec!["ws://a:8081", "ws://b:8082"]);
        });
    }

    // --- Allowed origins parsing ---

    #[test]
    fn allowed_origins_parsed() {
        with_env_vars(
            &[("DILLA_ALLOWED_ORIGINS", "http://localhost:8888,https://example.com")],
            || {
                let cfg = Config::load();
                assert_eq!(cfg.allowed_origins.len(), 2);
                assert_eq!(cfg.allowed_origins[0], "http://localhost:8888");
                assert_eq!(cfg.allowed_origins[1], "https://example.com");
            },
        );
    }

    // --- Federation port defaults ---

    #[test]
    fn federation_port_defaults_to_port_plus_one() {
        with_env_vars(&[("DILLA_PORT", "3000")], || {
            let cfg = Config::load();
            assert_eq!(cfg.federation_port, 3001);
        });
    }

    #[test]
    fn federation_port_explicit() {
        with_env_vars(
            &[("DILLA_PORT", "3000"), ("DILLA_FEDERATION_PORT", "5000")],
            || {
                let cfg = Config::load();
                assert_eq!(cfg.federation_port, 5000);
            },
        );
    }

    // --- Upload dir defaults ---

    #[test]
    fn upload_dir_defaults_to_data_dir_slash_uploads() {
        with_env_vars(&[("DILLA_DATA_DIR", "/tmp/dilla")], || {
            let cfg = Config::load();
            assert_eq!(cfg.upload_dir, "/tmp/dilla/uploads");
        });
    }

    #[test]
    fn upload_dir_explicit() {
        with_env_vars(&[("DILLA_UPLOAD_DIR", "/custom/uploads")], || {
            let cfg = Config::load();
            assert_eq!(cfg.upload_dir, "/custom/uploads");
        });
    }

    // --- Validate ---

    #[test]
    fn validate_ok_for_defaults() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            assert!(cfg.validate().is_ok());
        });
    }

    #[test]
    fn validate_rejects_port_zero() {
        let mut cfg = Config::load();
        cfg.port = 0;
        assert!(cfg.validate().is_err());
        assert!(cfg.validate().unwrap_err().contains("invalid port"));
    }

    #[test]
    fn validate_rejects_port_65535() {
        let mut cfg = Config::load();
        cfg.port = 65535;
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_data_dir() {
        let mut cfg = Config::load();
        cfg.data_dir = String::new();
        assert!(cfg.validate().is_err());
        assert!(cfg.validate().unwrap_err().contains("data-dir"));
    }

    // --- Debug redaction / Clone ---

    #[test]
    fn config_is_cloneable() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            let cfg2 = cfg.clone();
            assert_eq!(cfg.port, cfg2.port);
            assert_eq!(cfg.data_dir, cfg2.data_dir);
        });
    }

    #[test]
    fn config_debug_output_exists() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            let debug = format!("{:?}", cfg);
            assert!(debug.contains("Config"));
        });
    }

    // --- theme_file ---

    #[test]
    fn theme_file_defaults_to_empty() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            assert!(cfg.theme_file.is_empty());
        });
    }

    #[test]
    fn theme_file_from_env() {
        with_env_vars(&[("DILLA_THEME_FILE", "/etc/dilla/custom.css")], || {
            let cfg = Config::load();
            assert_eq!(cfg.theme_file, "/etc/dilla/custom.css");
        });
    }

    // --- warn_insecure_defaults (just verify it doesn't panic) ---

    #[test]
    fn warn_insecure_defaults_no_panic_empty_passphrase() {
        with_env_vars(&[], || {
            let cfg = Config::load();
            cfg.warn_insecure_defaults(); // should not panic
        });
    }

    #[test]
    fn warn_insecure_defaults_no_panic_with_passphrase() {
        with_env_vars(&[("DILLA_DB_PASSPHRASE", "secret123")], || {
            let cfg = Config::load();
            cfg.warn_insecure_defaults();
        });
    }

    #[test]
    fn warn_insecure_defaults_no_panic_insecure_mode() {
        with_env_vars(
            &[("DILLA_INSECURE", "true"), ("DILLA_ALLOWED_ORIGINS", "http://localhost")],
            || {
                let cfg = Config::load();
                cfg.warn_insecure_defaults();
            },
        );
    }

    // --- Direct helper function tests ---

    #[test]
    fn env_str_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_STR", "hello");
        assert_eq!(env_str("_TEST_STR", "default"), "hello");
        env::remove_var("_TEST_STR");
        assert_eq!(env_str("_TEST_STR", "default"), "default");
    }

    #[test]
    fn env_u16_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_U16", "1234");
        assert_eq!(env_u16("_TEST_U16", 0), 1234);
        env::set_var("_TEST_U16", "bad");
        assert_eq!(env_u16("_TEST_U16", 42), 42);
        env::remove_var("_TEST_U16");
        assert_eq!(env_u16("_TEST_U16", 99), 99);
    }

    #[test]
    fn env_u32_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_U32", "100000");
        assert_eq!(env_u32("_TEST_U32", 0), 100000);
        env::remove_var("_TEST_U32");
        assert_eq!(env_u32("_TEST_U32", 5), 5);
    }

    #[test]
    fn env_u64_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_U64", "18446744073709551615");
        assert_eq!(env_u64("_TEST_U64", 0), u64::MAX);
        env::remove_var("_TEST_U64");
    }

    #[test]
    fn env_i64_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_I64", "-9999");
        assert_eq!(env_i64("_TEST_I64", 0), -9999);
        env::remove_var("_TEST_I64");
    }

    #[test]
    fn env_f64_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_F64", "3.14");
        assert!((env_f64("_TEST_F64", 0.0) - 3.14).abs() < f64::EPSILON);
        env::set_var("_TEST_F64", "NaN");
        // "NaN" parses to f64::NAN
        assert!(env_f64("_TEST_F64", 0.0).is_nan());
        env::remove_var("_TEST_F64");
    }

    #[test]
    fn env_bool_direct() {
        let _guard = ENV_LOCK.lock().unwrap();
        env::set_var("_TEST_BOOL", "true");
        assert!(env_bool("_TEST_BOOL", false));
        env::set_var("_TEST_BOOL", "TRUE");
        assert!(env_bool("_TEST_BOOL", false));
        env::set_var("_TEST_BOOL", "True");
        assert!(env_bool("_TEST_BOOL", false));
        env::set_var("_TEST_BOOL", "1");
        assert!(env_bool("_TEST_BOOL", false));
        env::set_var("_TEST_BOOL", "0");
        assert!(!env_bool("_TEST_BOOL", true));
        env::set_var("_TEST_BOOL", "false");
        assert!(!env_bool("_TEST_BOOL", true));
        env::set_var("_TEST_BOOL", "anything");
        assert!(!env_bool("_TEST_BOOL", true));
        env::remove_var("_TEST_BOOL");
        assert!(env_bool("_TEST_BOOL", true)); // fallback
        assert!(!env_bool("_TEST_BOOL", false)); // fallback
    }
}
