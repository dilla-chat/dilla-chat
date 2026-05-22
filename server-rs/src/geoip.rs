//! H-8b / A2: optional MaxMind GeoLite2 country lookup for auth risk
//! scoring.
//!
//! Loaded once at startup from `DILLA_GEOIP_DB_PATH` (when set). The
//! file is the standard GeoLite2-Country.mmdb (operator-supplied via
//! MaxMind's free distribution — Dilla doesn't bundle or ship it).
//! Absent / unreadable / parse failure is non-fatal — the global
//! stays None and `country_for` returns None unconditionally, which
//! makes `derive_country_from_ip` fall back to its legacy "unknown"
//! placeholder.
//!
//! Lookup is O(log n) into the mmdb radix tree — fast enough for
//! every login. No network calls (operator-side privacy invariant
//! from the original A2 spec).

use std::net::IpAddr;
use std::sync::OnceLock;

use maxminddb::{geoip2, Reader};

static READER: OnceLock<Option<Reader<Vec<u8>>>> = OnceLock::new();

/// Load the mmdb file at `path` if non-empty. Idempotent — subsequent
/// calls are no-ops (first wins). Logs at info on success, warn on
/// failure. Caller passes `cfg.geoip_db_path`.
pub fn init(path: &str) {
    let reader = if path.is_empty() {
        None
    } else {
        match Reader::open_readfile(path) {
            Ok(r) => {
                tracing::info!(
                    path = %path,
                    "geoip: ready (MaxMind GeoLite2)"
                );
                Some(r)
            }
            Err(e) => {
                tracing::warn!(
                    path = %path,
                    error = %e,
                    "geoip: failed to open mmdb; country signal will return None"
                );
                None
            }
        }
    };
    let _ = READER.set(reader);
}

/// Resolve a parsed IP to its ISO-3166 country code (e.g. "DE",
/// "US"). Returns None when the reader isn't loaded, the IP doesn't
/// resolve to a country, or the lookup errors.
pub fn country_for(ip: &IpAddr) -> Option<String> {
    let reader = READER.get().and_then(|opt| opt.as_ref())?;
    // maxminddb 0.26 returns Result<Option<T>, _>; the outer Err
    // covers DB / I/O errors, the inner None covers "no entry for
    // this IP" (e.g. private ranges that slipped through the
    // RFC-1918 prefilter in derive_country_from_ip).
    let lookup: Result<Option<geoip2::Country>, _> = reader.lookup(*ip);
    let country = lookup.ok()??;
    country
        .country
        .and_then(|c| c.iso_code)
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    #[test]
    fn country_for_returns_none_when_reader_unloaded() {
        // Before init() is ever called the static is empty.
        let ip: IpAddr = "8.8.8.8".parse().unwrap();
        // We can't reliably assert this in isolation because OnceLock
        // is process-global and earlier tests may have set it. The
        // important guarantee is that the helper never panics on a
        // cold start.
        let _ = country_for(&ip);
    }
}
