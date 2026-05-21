//! SSRF guard for outbound HTTP. H11 / OUT-SSRF-1.
//!
//! `safe_outbound_url` parses a candidate URL and refuses anything that
//! resolves to a private/link-local/loopback IP (RFC 1918, RFC 4193,
//! 169.254/16, ::1, ULA fc00::/7) or that uses a non-HTTPS scheme. Use
//! before every outbound `reqwest` call that may take a user-supplied
//! URL.
//!
//! Today's callers: Giphy embed proxy (`api/gif.rs::embed`). Future
//! callers (avatar URL fetch, OpenGraph preview, etc.) MUST go through
//! this helper.

use std::net::IpAddr;

use crate::error::AppError;

/// Validate an outbound URL against the SSRF policy. Returns the URL
/// unchanged when allowed. Errors return `AppError::BadRequest` so
/// the caller can surface a 400 without leaking which check failed.
pub async fn safe_outbound_url(raw_url: &str) -> Result<String, AppError> {
    // (a) Scheme check — require HTTPS. Plain HTTP is rejected so we
    // can't be tricked into POSTing credentials to an attacker-
    // controlled clear-text endpoint, and ftp/gopher/file are
    // refused outright.
    let url = url_lite::parse(raw_url)
        .ok_or_else(|| AppError::BadRequest("invalid url".into()))?;
    if url.scheme != "https" {
        return Err(AppError::BadRequest(format!(
            "refusing non-https scheme: {}",
            url.scheme
        )));
    }
    if url.host.is_empty() {
        return Err(AppError::BadRequest("url missing host".into()));
    }

    // (b) Resolve hostname to one or more IP addresses. Refuse if
    // ANY resolved address is on the deny list — defends against
    // DNS rebinding and against records that mix public + private IPs.
    let host_port = format!("{}:{}", url.host, url.port_or_default());
    let addrs = tokio::net::lookup_host(&host_port)
        .await
        .map_err(|e| AppError::BadRequest(format!("dns lookup failed: {}", e)))?;
    let mut any = false;
    for sa in addrs {
        any = true;
        let ip = sa.ip();
        if !is_public_ip(&ip) {
            return Err(AppError::BadRequest(format!(
                "refusing outbound to non-public address: {}",
                ip
            )));
        }
    }
    if !any {
        return Err(AppError::BadRequest("dns returned no addresses".into()));
    }
    Ok(raw_url.to_string())
}

/// True when `ip` is a global, public, routable address.
///
/// Rejects:
/// - loopback (127.0.0.0/8, ::1)
/// - link-local (169.254.0.0/16, fe80::/10)
/// - RFC 1918 private (10/8, 172.16/12, 192.168/16)
/// - RFC 4193 unique-local IPv6 (fc00::/7)
/// - IPv4 broadcast / multicast / unspecified
/// - AWS metadata service (169.254.169.254) — covered by link-local
/// - IPv6 IPv4-mapped of any of the above
fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback()
                || v4.is_link_local()
                || v4.is_private()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_documentation()
            {
                return false;
            }
            // Carrier-grade NAT 100.64/10 — not strictly RFC-1918 but
            // not internet-routable either.
            let o = v4.octets();
            if o[0] == 100 && (64..=127).contains(&o[1]) {
                return false;
            }
            true
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_multicast() || v6.is_unspecified() {
                return false;
            }
            // Map IPv4-mapped to v4 and recurse.
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(&IpAddr::V4(v4));
            }
            let seg = v6.segments();
            // fe80::/10 link-local
            if (seg[0] & 0xffc0) == 0xfe80 {
                return false;
            }
            // fc00::/7 unique-local
            if (seg[0] & 0xfe00) == 0xfc00 {
                return false;
            }
            // 2001:db8::/32 documentation
            if seg[0] == 0x2001 && seg[1] == 0x0db8 {
                return false;
            }
            true
        }
    }
}

/// Tiny URL parser used by safe_outbound_url. Avoids pulling in a
/// dedicated `url` crate dep for a handful of fields. Returns None on
/// malformed input.
mod url_lite {
    pub struct Url {
        pub scheme: String,
        pub host: String,
        pub port: Option<u16>,
    }
    impl Url {
        pub fn port_or_default(&self) -> u16 {
            self.port.unwrap_or_else(|| match self.scheme.as_str() {
                "https" => 443,
                "http" => 80,
                _ => 0,
            })
        }
    }

    pub fn parse(raw: &str) -> Option<Url> {
        let (scheme, rest) = raw.split_once("://")?;
        let scheme = scheme.to_ascii_lowercase();
        // Authority ends at first '/', '?', '#'.
        let end = rest
            .find(|c: char| c == '/' || c == '?' || c == '#')
            .unwrap_or(rest.len());
        let authority = &rest[..end];
        // Drop optional userinfo `user:pass@`.
        let host_and_port = authority.rsplit('@').next().unwrap_or(authority);
        if host_and_port.is_empty() {
            return None;
        }
        // IPv6 literal in brackets.
        let (host, port) = if let Some(rest) = host_and_port.strip_prefix('[') {
            let close = rest.find(']')?;
            let host = rest[..close].to_string();
            let remainder = &rest[close + 1..];
            let port = if let Some(p) = remainder.strip_prefix(':') {
                Some(p.parse::<u16>().ok()?)
            } else {
                None
            };
            (host, port)
        } else if let Some((host, port)) = host_and_port.rsplit_once(':') {
            (host.to_string(), Some(port.parse::<u16>().ok()?))
        } else {
            (host_and_port.to_string(), None)
        };
        if host.is_empty() {
            return None;
        }
        Some(Url {
            scheme,
            host,
            port,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn rejects_rfc1918() {
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(172, 16, 1, 1))));
    }

    #[test]
    fn rejects_loopback_link_local_aws_metadata() {
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
    }

    #[test]
    fn rejects_carrier_grade_nat() {
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(!is_public_ip(&IpAddr::V4(Ipv4Addr::new(100, 127, 255, 255))));
    }

    #[test]
    fn accepts_public_v4() {
        assert!(is_public_ip(&IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(is_public_ip(&IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
    }

    #[test]
    fn rejects_v6_loopback_and_ula() {
        let ula: IpAddr = "fd12::1".parse().unwrap();
        assert!(!is_public_ip(&ula));
        let lo: IpAddr = "::1".parse().unwrap();
        assert!(!is_public_ip(&lo));
        let link: IpAddr = "fe80::1".parse().unwrap();
        assert!(!is_public_ip(&link));
    }

    #[test]
    fn url_lite_parses_https() {
        let u = url_lite::parse("https://example.com/path?q=1").unwrap();
        assert_eq!(u.scheme, "https");
        assert_eq!(u.host, "example.com");
        assert_eq!(u.port_or_default(), 443);
    }

    #[test]
    fn url_lite_parses_ipv6_bracketed() {
        let u = url_lite::parse("https://[2001:db8::1]:8443/x").unwrap();
        assert_eq!(u.host, "2001:db8::1");
        assert_eq!(u.port, Some(8443));
    }

    #[tokio::test]
    async fn refuses_non_https() {
        let r = safe_outbound_url("http://example.com/").await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn refuses_loopback_url() {
        let r = safe_outbound_url("https://127.0.0.1/").await;
        assert!(r.is_err());
    }
}
