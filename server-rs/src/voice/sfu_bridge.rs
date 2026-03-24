use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use super::signaling::SFU;

#[async_trait::async_trait]
impl crate::ws::hub::VoiceSFU for SFU {
    async fn handle_join(&self, channel_id: &str, user_id: &str) -> Result<String, String> {
        let offer = self.handle_join(channel_id, user_id).await?;
        serde_json::to_string(&offer).map_err(|e| format!("serialize offer: {e}"))
    }

    async fn handle_leave(&self, channel_id: &str, user_id: &str) {
        self.handle_leave(channel_id, user_id).await;
    }

    async fn handle_answer(
        &self,
        channel_id: &str,
        user_id: &str,
        sdp: &str,
    ) -> Result<(), String> {
        let answer = RTCSessionDescription::answer(sdp.to_string())
            .map_err(|e| format!("parse answer SDP: {e}"))?;
        self.handle_answer(channel_id, user_id, answer).await
    }

    async fn handle_ice_candidate(
        &self,
        channel_id: &str,
        user_id: &str,
        candidate: &str,
        sdp_mid: &str,
        sdp_mline_index: u16,
    ) -> Result<(), String> {
        let init = RTCIceCandidateInit {
            candidate: candidate.to_string(),
            sdp_mid: Some(sdp_mid.to_string()),
            sdp_mline_index: Some(sdp_mline_index),
            username_fragment: None,
        };
        self.handle_ice_candidate(channel_id, user_id, init).await
    }

    async fn add_screen_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.add_screen_track(channel_id, user_id).await
    }

    async fn remove_screen_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.remove_screen_track(channel_id, user_id).await
    }

    async fn add_webcam_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.add_webcam_track(channel_id, user_id).await
    }

    async fn remove_webcam_track(&self, channel_id: &str, user_id: &str) -> Result<(), String> {
        self.remove_webcam_track(channel_id, user_id).await
    }

    async fn renegotiate_all(&self, channel_id: &str) {
        self.renegotiate_all(channel_id).await;
    }
}

/// Parse a JSON array of ICE servers into `Vec<RTCIceServer>`.
pub(crate) fn parse_ice_servers(json: &serde_json::Value) -> Result<Vec<RTCIceServer>, String> {
    let arr = json
        .as_array()
        .ok_or_else(|| "iceServers is not an array".to_string())?;

    let mut servers = Vec::new();
    for entry in arr {
        let urls: Vec<String> = entry
            .get("urls")
            .and_then(|v| {
                if let Some(arr) = v.as_array() {
                    Some(
                        arr.iter()
                            .filter_map(|u| u.as_str().map(String::from))
                            .collect(),
                    )
                } else if let Some(s) = v.as_str() {
                    Some(vec![s.to_string()])
                } else {
                    None
                }
            })
            .unwrap_or_default();

        let username = entry
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let credential = entry
            .get("credential")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        servers.push(RTCIceServer {
            urls,
            username,
            credential,
        });
    }

    Ok(servers)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_ice_servers tests ──────────────────────────────────────────

    #[test]
    fn parse_ice_servers_single_stun() {
        let json = serde_json::json!([
            {"urls": ["stun:stun.example.com:3478"]}
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].urls, vec!["stun:stun.example.com:3478"]);
        assert_eq!(servers[0].username, "");
        assert_eq!(servers[0].credential, "");
    }

    #[test]
    fn parse_ice_servers_with_credentials() {
        let json = serde_json::json!([
            {
                "urls": ["turn:turn.example.com:443?transport=tcp"],
                "username": "user123",
                "credential": "pass456"
            }
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].username, "user123");
        assert_eq!(servers[0].credential, "pass456");
    }

    #[test]
    fn parse_ice_servers_multiple_entries() {
        let json = serde_json::json!([
            {"urls": ["stun:stun1.example.com:3478"]},
            {"urls": ["stun:stun2.example.com:3478"]},
            {
                "urls": ["turn:turn.example.com:443"],
                "username": "u",
                "credential": "c"
            }
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert_eq!(servers.len(), 3);
    }

    #[test]
    fn parse_ice_servers_url_as_string_not_array() {
        let json = serde_json::json!([
            {"urls": "stun:stun.example.com:3478"}
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert_eq!(servers[0].urls, vec!["stun:stun.example.com:3478"]);
    }

    #[test]
    fn parse_ice_servers_empty_array() {
        let json = serde_json::json!([]);
        let servers = parse_ice_servers(&json).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn parse_ice_servers_not_array_returns_error() {
        let json = serde_json::json!({"urls": "stun:stun.example.com"});
        let result = parse_ice_servers(&json);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not an array"));
    }

    #[test]
    fn parse_ice_servers_missing_urls_gives_empty_vec() {
        let json = serde_json::json!([
            {"username": "u", "credential": "c"}
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert!(servers[0].urls.is_empty());
    }

    #[test]
    fn parse_ice_servers_multiple_urls_in_one_entry() {
        let json = serde_json::json!([
            {
                "urls": [
                    "stun:stun.example.com:3478",
                    "turn:turn.example.com:3478"
                ]
            }
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert_eq!(servers[0].urls.len(), 2);
    }

    #[test]
    fn parse_ice_servers_urls_as_number_gives_empty() {
        let json = serde_json::json!([
            {"urls": 12345}
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert!(servers[0].urls.is_empty());
    }

    #[test]
    fn parse_ice_servers_null_username_gives_empty_string() {
        let json = serde_json::json!([
            {"urls": ["stun:stun.example.com:3478"], "username": null, "credential": null}
        ]);
        let servers = parse_ice_servers(&json).unwrap();
        assert_eq!(servers[0].username, "");
        assert_eq!(servers[0].credential, "");
    }

    // ── VoiceSFU trait tests ─────────────────────────────────────────────

    #[tokio::test]
    async fn voice_sfu_trait_handle_ice_candidate_no_peer_returns_error() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::handle_ice_candidate(&sfu, "ch1", "u1", "candidate:...", "0", 0).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn voice_sfu_trait_handle_leave_no_peer() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        VoiceSFU::handle_leave(&sfu, "ch1", "u1").await;
        // Should not panic.
    }

    #[tokio::test]
    async fn voice_sfu_trait_handle_answer_no_peer_returns_error() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::handle_answer(
            &sfu,
            "ch1",
            "u1",
            "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n",
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn voice_sfu_trait_add_screen_track_no_room() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::add_screen_track(&sfu, "ch1", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn voice_sfu_trait_remove_screen_track_no_room() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::remove_screen_track(&sfu, "ch1", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn voice_sfu_trait_add_webcam_track_no_room() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::add_webcam_track(&sfu, "ch1", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn voice_sfu_trait_remove_webcam_track_no_room() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::remove_webcam_track(&sfu, "ch1", "u1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn voice_sfu_trait_renegotiate_all_empty() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        VoiceSFU::renegotiate_all(&sfu, "ch1").await;
        // Should not panic.
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn voice_sfu_trait_handle_join_returns_sdp_string() {
        use crate::ws::hub::VoiceSFU;
        let sfu = SFU::new();
        let result = VoiceSFU::handle_join(&sfu, "ch1", "u1").await;
        assert!(result.is_ok());
        let sdp_str = result.unwrap();
        assert!(!sdp_str.is_empty());
        // Should be valid JSON.
        let _: serde_json::Value = serde_json::from_str(&sdp_str).unwrap();
    }
}
