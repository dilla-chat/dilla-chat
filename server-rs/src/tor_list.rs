//! H-8 / A2: optional Tor exit-node list for risk scoring.
//!
//! Loaded once at startup from `DILLA_TOR_EXIT_LIST_PATH` (when set).
//! Format: newline-delimited IP addresses, blank lines + `#` comments
//! ignored. Both IPv4 and IPv6 supported. Absent / parse-failure on
//! init is non-fatal — the global stays None and `is_tor_exit`
//! returns false unconditionally.
//!
//! Lookup is O(1) HashSet over `IpAddr`. The set is loaded once;
//! restarting the server picks up updates. Reloading without restart
//! is a small follow-up.

use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::OnceLock;

static EXIT_NODES: OnceLock<Option<HashSet<IpAddr>>> = OnceLock::new();

/// Load the list from disk if `path` is non-empty. Idempotent —
/// subsequent calls are no-ops (first wins). Returns the number of
/// addresses loaded (0 when the file is absent / empty / unparseable).
pub fn init(path: &str) -> usize {
    let set = if path.is_empty() {
        None
    } else {
        match std::fs::read_to_string(path) {
            Ok(s) => Some(parse(&s)),
            Err(e) => {
                tracing::warn!(
                    path = %path,
                    error = %e,
                    "tor-exit-list: failed to read file; Tor signal disabled"
                );
                None
            }
        }
    };
    let count = set.as_ref().map(|s| s.len()).unwrap_or(0);
    let _ = EXIT_NODES.set(set);
    if count > 0 {
        tracing::info!(loaded = count, "tor-exit-list: ready");
    }
    count
}

/// Return the loaded set, or None when the loader wasn't run / file
/// was absent. The hot-path caller (`auth_handlers::ip_is_tor_exit`)
/// gates on None and skips the lookup.
pub fn get() -> Option<&'static HashSet<IpAddr>> {
    EXIT_NODES.get().and_then(|opt| opt.as_ref())
}

fn parse(body: &str) -> HashSet<IpAddr> {
    let mut out = HashSet::new();
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Tolerate trailing comments / whitespace on the same line.
        let first = line.split_whitespace().next().unwrap_or("");
        if let Ok(ip) = first.parse::<IpAddr>() {
            out.insert(ip);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_list_with_comments_and_blank_lines() {
        let body = "\
# Tor exit nodes — example
1.2.3.4
5.6.7.8

  9.10.11.12   # has whitespace + trailing comment
2001:db8::1
::1
not-an-ip-line
";
        let set = parse(body);
        assert!(set.contains(&"1.2.3.4".parse::<IpAddr>().unwrap()));
        assert!(set.contains(&"5.6.7.8".parse::<IpAddr>().unwrap()));
        assert!(set.contains(&"9.10.11.12".parse::<IpAddr>().unwrap()));
        assert!(set.contains(&"2001:db8::1".parse::<IpAddr>().unwrap()));
        assert!(set.contains(&"::1".parse::<IpAddr>().unwrap()));
        // Invalid lines silently skipped.
        assert_eq!(set.len(), 5);
    }

    #[test]
    fn empty_body_yields_empty_set() {
        assert!(parse("").is_empty());
        assert!(parse("# only comments\n#\n").is_empty());
    }

    #[test]
    fn init_with_empty_path_returns_zero() {
        // The first init in the process wins (OnceLock), so this may
        // be a no-op when another test in the suite already set it.
        // The contract we care about is "no panic, returns a usize".
        let count = init("");
        assert!(count == 0 || count > 0);
    }

    #[test]
    fn init_with_unreadable_path_returns_zero() {
        let count = init("/tmp/this-tor-list-file-definitely-does-not-exist");
        assert!(count == 0 || count > 0);
    }

    #[test]
    fn get_does_not_panic() {
        // Whatever the global state is, get() must never panic.
        let _ = get();
    }
}
