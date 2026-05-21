//! In-process policy decision module. H10 / R-21.
//!
//! Centralizes the scattered authorization checks (`require_team_member`,
//! `user_can_access_channel`, `user_has_permission`) behind a single
//! typed API so every Deny flows through one place — gives us a hook
//! point for the future audit log + structured-deny telemetry.
//!
//! This is a thin façade for now. Existing call sites in `api/` and
//! `ws/handlers/` continue to use the underlying `db::*` helpers; new
//! code should call the `Decision` API. The intent is that future
//! refactors migrate call sites without changing semantics.

use rusqlite::Connection;

use crate::db;

/// Outcome of an authorization check.
#[derive(Debug)]
pub enum Decision {
    Allow,
    /// Static reason string keeps the decision space small and lets
    /// callers match on it. Avoid putting user-supplied data here.
    Deny(&'static str),
}

impl Decision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Decision::Allow)
    }
}

/// Context attached to a policy decision when we log a deny. Keeps
/// the structure of the trace consistent across call sites.
#[derive(Debug)]
pub struct DecisionContext<'a> {
    pub user_id: &'a str,
    pub target_kind: &'a str,
    pub target_id: &'a str,
    pub reason: &'a str,
}

/// Trace every Deny at INFO with a structured frame. Call this from
/// the caller after `Decision::Deny(...)`. Allow paths are not logged
/// from here — that's the responsibility of the caller's own success
/// telemetry.
pub fn log_decision(decision: &Decision, ctx: &DecisionContext<'_>) {
    if let Decision::Deny(reason) = decision {
        // INFO not WARN — denied access is usually a routine policy
        // outcome rather than a misconfiguration. The chosen reason
        // strings give the operator enough surface area to grep.
        tracing::info!(
            target: "policy",
            user_id = ctx.user_id,
            target_kind = ctx.target_kind,
            target_id = ctx.target_id,
            decision = "deny",
            reason = reason,
            ctx_reason = ctx.reason,
        );
    }
}

/// Authorize a WS subscribe (and equivalent paths) for a channel.
///
/// Today's rules: caller must either (a) be a team member with role
/// access to the text/voice channel, or (b) be in dm_members for a DM
/// channel. Unknown IDs deny.
pub fn can_subscribe_channel(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
    channel_id: &str,
) -> Decision {
    match db::get_channel_by_id(conn, channel_id) {
        Ok(Some(channel)) => {
            if channel.team_id != team_id {
                return Decision::Deny("channel.cross_team");
            }
            match db::user_can_access_channel(conn, user_id, team_id, channel_id) {
                Ok(true) => Decision::Allow,
                Ok(false) => Decision::Deny("channel.no_access"),
                Err(_) => Decision::Deny("channel.db_error"),
            }
        }
        Ok(None) => {
            // Could still be a DM channel.
            match db::is_dm_member(conn, channel_id, user_id) {
                Ok(true) => Decision::Allow,
                Ok(false) => Decision::Deny("channel.unknown"),
                Err(_) => Decision::Deny("channel.db_error"),
            }
        }
        Err(_) => Decision::Deny("channel.db_error"),
    }
}

/// Authorize a message send into a text channel. Equivalent to
/// can_subscribe_channel plus a team-scoped check the existing
/// `handle_message_send` path already does.
#[allow(dead_code)]
pub fn can_send_message(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
    channel_id: &str,
) -> Decision {
    // Membership is required to send even if the channel ACL is open
    // (defensive — outsiders should never reach this code path, but
    // the policy module is the right place to encode that invariant).
    match db::get_member_by_user_and_team(conn, user_id, team_id) {
        Ok(Some(_)) => {}
        Ok(None) => return Decision::Deny("team.not_member"),
        Err(_) => return Decision::Deny("team.db_error"),
    }
    can_subscribe_channel(conn, user_id, team_id, channel_id)
}

/// Authorize a team-management action (rename / role-edit / etc.).
/// Currently maps to PERM_MANAGE_TEAM; refactor target for future
/// fine-grained permissions.
#[allow(dead_code)]
pub fn can_manage_team(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
) -> Decision {
    match db::user_has_permission(conn, user_id, team_id, db::PERM_MANAGE_TEAM) {
        Ok(true) => Decision::Allow,
        Ok(false) => Decision::Deny("team.no_manage_permission"),
        Err(_) => Decision::Deny("team.db_error"),
    }
}

/// Authorize an attachment read. Linked attachments inherit the
/// channel ACL; unlinked attachments inherit the team membership +
/// per-team grace window enforced upstream.
#[allow(dead_code)]
pub fn can_read_attachment(
    conn: &Connection,
    user_id: &str,
    attachment_id: &str,
) -> Decision {
    let attachment = match db::get_attachment(conn, attachment_id) {
        Ok(Some(a)) => a,
        Ok(None) => return Decision::Deny("attachment.not_found"),
        Err(_) => return Decision::Deny("attachment.db_error"),
    };
    if attachment.message_id.is_empty() {
        // Unlinked → policy can't decide without team+grace context.
        // Caller (uploads.rs::download) is still authoritative on the
        // grace window; this policy module deliberately abstains.
        return Decision::Deny("attachment.unlinked_policy_undefined");
    }
    let msg = match db::get_message_by_id(conn, &attachment.message_id) {
        Ok(Some(m)) => m,
        Ok(None) => return Decision::Deny("attachment.message_missing"),
        Err(_) => return Decision::Deny("attachment.db_error"),
    };
    let channel = match db::get_channel_by_id(conn, &msg.channel_id) {
        Ok(Some(c)) => c,
        Ok(None) => return Decision::Deny("attachment.channel_missing"),
        Err(_) => return Decision::Deny("attachment.db_error"),
    };
    match db::user_can_access_channel(conn, user_id, &channel.team_id, &msg.channel_id) {
        Ok(true) => Decision::Allow,
        Ok(false) => Decision::Deny("attachment.no_channel_access"),
        Err(_) => Decision::Deny("attachment.db_error"),
    }
}

/// Authorize a federation peer call. Today the only state we have on a
/// peer is its node_name; this policy returns Allow whenever the name
/// is non-empty. Hook point for the future per-node Ed25519 trust
/// store (Phase 3, R-30..R-34).
#[allow(dead_code)]
pub fn can_call_federation(
    _conn: &Connection,
    peer_node_id: &str,
) -> Decision {
    if peer_node_id.is_empty() {
        Decision::Deny("federation.unknown_peer")
    } else {
        Decision::Allow
    }
}

// ── A6: integration helpers wrapping the existing helpers::* shape ──────

/// A6: typed wrapper for the membership check. Replaces direct calls to
/// `helpers::require_team_member` inside REST handlers so every Deny
/// flows through `log_decision` and a future audit pipeline can hook
/// off this module.
pub fn require_team_member(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
) -> Result<(), rusqlite::Error> {
    let decision = match db::get_member_by_user_and_team(conn, user_id, team_id) {
        Ok(Some(_)) => Decision::Allow,
        Ok(None) => Decision::Deny("team.not_member"),
        Err(_) => Decision::Deny("team.db_error"),
    };
    log_decision(
        &decision,
        &DecisionContext {
            user_id,
            target_kind: "team",
            target_id: team_id,
            reason: "rest_handler",
        },
    );
    match decision {
        Decision::Allow => Ok(()),
        Decision::Deny(_) => Err(rusqlite::Error::InvalidParameterName(
            "not a member of this team".into(),
        )),
    }
}

/// A6: typed wrapper for permission-bit checks. Same shape as
/// `helpers::require_permission` but routes every deny through
/// `log_decision`.
pub fn require_permission(
    conn: &Connection,
    user_id: &str,
    team_id: &str,
    perm: i64,
) -> Result<(), rusqlite::Error> {
    let decision = match db::user_has_permission(conn, user_id, team_id, perm) {
        Ok(true) => Decision::Allow,
        Ok(false) => Decision::Deny("team.insufficient_permission"),
        Err(_) => Decision::Deny("team.db_error"),
    };
    log_decision(
        &decision,
        &DecisionContext {
            user_id,
            target_kind: "team",
            target_id: team_id,
            reason: "rest_handler",
        },
    );
    match decision {
        Decision::Allow => Ok(()),
        Decision::Deny(_) => Err(rusqlite::Error::InvalidParameterName(
            "insufficient permissions".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn test_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        std::mem::forget(tmp);
        db
    }

    #[test]
    fn deny_for_unknown_channel() {
        let db = test_db();
        db.with_conn(|c| {
            let d = can_subscribe_channel(c, "u", "t", "missing");
            assert!(!d.is_allowed());
            match d {
                Decision::Deny(r) => assert_eq!(r, "channel.unknown"),
                _ => panic!("expected Deny"),
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn federation_empty_peer_denied() {
        let db = test_db();
        db.with_conn(|c| {
            let d = can_call_federation(c, "");
            assert!(!d.is_allowed());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn log_decision_does_not_panic_on_allow() {
        // log_decision is a no-op on Allow; trace it as a smoke test.
        log_decision(
            &Decision::Allow,
            &DecisionContext {
                user_id: "u",
                target_kind: "channel",
                target_id: "c",
                reason: "test",
            },
        );
    }
}
