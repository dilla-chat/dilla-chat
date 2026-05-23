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
            .expect("reqwest Client::builder should not fail with default TLS");

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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn self_hosted_turn_returns_one_ice_server_object() {
        let c = SelfHostedTurnClient::new(
            "shared".into(),
            vec!["turn:turn.example:3478?transport=udp".into()],
            Duration::from_secs(3600),
        );
        let v = c.get_ice_servers().await.unwrap();
        let arr = v.as_array().expect("expected array");
        assert_eq!(arr.len(), 1);
        let server = &arr[0];
        assert!(server.get("urls").is_some());
        assert!(server.get("username").is_some());
        assert!(server.get("credential").is_some());
    }

    #[tokio::test]
    async fn self_hosted_turn_username_encodes_expiry_and_short_id() {
        let c = SelfHostedTurnClient::new(
            "secret".into(),
            vec!["turn:t".into()],
            Duration::from_secs(60),
        );
        let v = c.get_ice_servers().await.unwrap();
        let username = v[0]["username"].as_str().unwrap().to_string();
        // Format: "<expiry-seconds>:<8-char hex>"
        let mut parts = username.splitn(2, ':');
        let expiry: u64 = parts.next().unwrap().parse().unwrap();
        let short_id = parts.next().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert!(expiry >= now + 55 && expiry <= now + 65);
        assert_eq!(short_id.len(), 8);
    }

    #[tokio::test]
    async fn self_hosted_turn_password_is_base64() {
        let c = SelfHostedTurnClient::new(
            "secret".into(),
            vec!["turn:t".into()],
            Duration::from_secs(60),
        );
        let v = c.get_ice_servers().await.unwrap();
        let pw = v[0]["credential"].as_str().unwrap();
        // Standard base64 produces only [A-Za-z0-9+/=].
        assert!(pw.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
        // HMAC-SHA1 = 20 bytes → base64 = 28 chars with one '=' pad.
        assert_eq!(pw.len(), 28);
    }

    #[tokio::test]
    async fn self_hosted_turn_distinct_short_ids_each_call() {
        // The short id is a random UUID prefix — two consecutive calls
        // should almost never collide.
        let c = SelfHostedTurnClient::new(
            "secret".into(),
            vec!["turn:t".into()],
            Duration::from_secs(60),
        );
        let v1 = c.get_ice_servers().await.unwrap();
        let v2 = c.get_ice_servers().await.unwrap();
        let u1 = v1[0]["username"].as_str().unwrap().to_string();
        let u2 = v2[0]["username"].as_str().unwrap().to_string();
        assert_ne!(u1.split(':').nth(1).unwrap(), u2.split(':').nth(1).unwrap());
    }

    #[tokio::test]
    async fn self_hosted_turn_preserves_provided_url_list() {
        let urls = vec![
            "turn:turn1.example:3478?transport=udp".to_string(),
            "turns:turn2.example:5349?transport=tcp".to_string(),
        ];
        let c = SelfHostedTurnClient::new("k".into(), urls.clone(), Duration::from_secs(60));
        let v = c.get_ice_servers().await.unwrap();
        let returned: Vec<String> = v[0]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect();
        assert_eq!(returned, urls);
    }

    #[test]
    fn cf_turn_client_constructs_without_error() {
        let _c = CFTurnClient::new(CFTurnConfig {
            key_id: "key".into(),
            api_token: "tok".into(),
        });
        // Construction should not panic; further behaviour requires a
        // mock HTTP server and isn't tested at the unit level.
    }
}
