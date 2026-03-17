use std::sync::Arc;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use sha1::Sha1;
use tokio::sync::RwLock;

/// TURNCredentialProvider generates ICE server credentials for WebRTC clients.
#[async_trait::async_trait]
pub trait TURNCredentialProvider: Send + Sync {
    async fn get_ice_servers(&self) -> Result<serde_json::Value, String>;
}

// ---------------------------------------------------------------------------
// Cloudflare TURN
// ---------------------------------------------------------------------------

/// CFTurnConfig holds Cloudflare TURN API credentials.
#[derive(Clone)]
pub struct CFTurnConfig {
    pub key_id: String,
    pub api_token: String,
}

/// CFTurnClient fetches short-lived TURN credentials from Cloudflare.
pub struct CFTurnClient {
    config: CFTurnConfig,
    client: reqwest::Client,
    cache: Arc<RwLock<Option<CachedCredentials>>>,
}

struct CachedCredentials {
    ice_servers: serde_json::Value,
    valid_until: Instant,
}

impl CFTurnClient {
    pub fn new(config: CFTurnConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        CFTurnClient {
            config,
            client,
            cache: Arc::new(RwLock::new(None)),
        }
    }
}

#[async_trait::async_trait]
impl TURNCredentialProvider for CFTurnClient {
    async fn get_ice_servers(&self) -> Result<serde_json::Value, String> {
        // Check cache (read lock).
        {
            let cache = self.cache.read().await;
            if let Some(ref cached) = *cache {
                if Instant::now() < cached.valid_until {
                    return Ok(cached.ice_servers.clone());
                }
            }
        }

        // Acquire write lock and double-check.
        let mut cache = self.cache.write().await;
        if let Some(ref cached) = *cache {
            if Instant::now() < cached.valid_until {
                return Ok(cached.ice_servers.clone());
            }
        }

        let url = format!(
            "https://rtc.live.cloudflare.com/v1/turn/keys/{}/credentials/generate-ice-servers",
            self.config.key_id
        );

        let body = serde_json::json!({"ttl": 86400});

        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.config.api_token))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("cloudflare TURN API request failed: {e}"))?;

        let status = resp.status();
        if status != reqwest::StatusCode::CREATED && status != reqwest::StatusCode::OK {
            let resp_body = resp
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable>".to_string());
            return Err(format!(
                "cloudflare TURN API returned {}: {}",
                status, resp_body
            ));
        }

        let result: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("decode CF TURN response: {e}"))?;

        let ice_servers = result
            .get("iceServers")
            .cloned()
            .ok_or_else(|| "missing iceServers in CF response".to_string())?;

        *cache = Some(CachedCredentials {
            ice_servers: ice_servers.clone(),
            valid_until: Instant::now() + Duration::from_secs(3600),
        });

        tracing::debug!("fetched fresh Cloudflare TURN credentials");
        Ok(ice_servers)
    }
}

// ---------------------------------------------------------------------------
// Self-hosted TURN (HMAC-SHA1 credentials)
// ---------------------------------------------------------------------------

/// SelfHostedTurnClient generates HMAC-SHA1 credentials for a self-hosted TURN server.
pub struct SelfHostedTurnClient {
    shared_secret: String,
    turn_urls: Vec<String>,
    ttl: Duration,
}

impl SelfHostedTurnClient {
    pub fn new(shared_secret: String, turn_urls: Vec<String>, ttl: Duration) -> Self {
        SelfHostedTurnClient {
            shared_secret,
            turn_urls,
            ttl,
        }
    }
}

#[async_trait::async_trait]
impl TURNCredentialProvider for SelfHostedTurnClient {
    async fn get_ice_servers(&self) -> Result<serde_json::Value, String> {
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + self.ttl.as_secs();

        let short_id = &uuid::Uuid::new_v4().to_string()[..8];
        let username = format!("{}:{}", expiry, short_id);

        let mut mac = Hmac::<Sha1>::new_from_slice(self.shared_secret.as_bytes())
            .map_err(|e| format!("HMAC key error: {e}"))?;
        mac.update(username.as_bytes());
        let password = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            mac.finalize().into_bytes(),
        );

        let ice_server = serde_json::json!([{
            "urls": self.turn_urls,
            "username": username,
            "credential": password,
        }]);

        Ok(ice_server)
    }
}
