//! VULN-002 Phase 3 step 4: per-event authority matrix.
//!
//! A signed event's Ed25519 signature only proves *who* sent it. The
//! authority check answers *whether the sender was allowed to send
//! THAT event*. Without this layer, peer A can sign a perfectly valid
//! envelope that grants admin in peer B's team — the signature alone
//! doesn't refute it.
//!
//! Per `.security-hardening/14-federation-phase3-design.md` §4.3,
//! each event variant has a defined authoritative node:
//!
//! | Event | Authoritative node |
//! |-------|--------------------|
//! | `channel.*` | Team's owning peer |
//! | `role.*` | Team's owning peer |
//! | `member.*` | Team's owning peer OR user's home peer (mutual sig) |
//! | `message.create` | Author's home peer |
//! | `message.edit/delete` | Author's home peer only |
//! | state-sync responses | Team's owning peer for replicated state |
//!
//! Today: pure decision logic — no DB writes. Callers run
//! `authority::check(conn, signed)` after `wire::verify` succeeds and
//! before applying the merge. A `Denied` outcome is audit-logged and
//! the event is dropped.
//!
//! The `team_authority` table is populated lazily at team creation
//! (the originating node writes itself in) and at federation-join
//! (the join payload carries it). Pre-existing teams that predate
//! the migration have NULL `owner_node_id` and are treated as
//! `LegacyTeam` — accepted during the rolling-upgrade window per
//! Phase 3 §6 release N+1, rejected at release N+2.

use rusqlite::{params, Connection, OptionalExtension};

use super::wire::SignedFederationEvent;

/// Outcome of an authority check.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Originating node is authoritative for this event variant.
    Allow,
    /// Originating node is not authoritative. The string is an audit-
    /// friendly reason ("channel.not_team_owner",
    /// "message.author_home_peer_mismatch", ...).
    Denied(&'static str),
    /// Pre-existing team with no `team_authority` row. Accepted in
    /// release N+1 of the rolling upgrade; rejected in N+2. Caller
    /// audit-logs as `federation.legacy_team`.
    LegacyTeam,
}

/// Run the authority check. `signed` is assumed to have already
/// passed wire::verify (signature + event_id are valid).
pub fn check(
    conn: &Connection,
    signed: &SignedFederationEvent,
) -> Result<Decision, rusqlite::Error> {
    let event_type = signed.event.event_type.as_str();
    let payload = &signed.event.payload;
    let origin = signed.origin_node_id.as_str();

    // Owner-keyed events: channel.*, role.*, member.*
    if event_type.starts_with("channel.")
        || event_type.starts_with("role.")
        || event_type.starts_with("member.")
    {
        let team_id = payload
            .get("team_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if team_id.is_empty() {
            return Ok(Decision::Denied("missing_team_id"));
        }
        return check_team_authority(conn, origin, team_id);
    }

    // Message events: author's home peer.
    if matches!(
        event_type,
        "message.create" | "message:new" | "message.edit" | "message:edit" | "message.delete" | "message:delete"
    ) {
        let author_home = payload
            .get("home_node_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if author_home.is_empty() {
            // Legacy event without home_node_id — treat like
            // LegacyTeam during the rolling upgrade. Future release
            // requires the field and falls through to Denied.
            return Ok(Decision::LegacyTeam);
        }
        if author_home == origin {
            return Ok(Decision::Allow);
        }
        return Ok(Decision::Denied("message.author_home_peer_mismatch"));
    }

    // State-sync responses: same rule as owner-keyed (the bulk pull
    // carries a team_id and the response must come from the owner).
    if event_type == "state.sync" || event_type == "state.sync.response" {
        let team_id = payload
            .get("team_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if team_id.is_empty() {
            return Ok(Decision::Denied("missing_team_id"));
        }
        return check_team_authority(conn, origin, team_id);
    }

    // Unknown variants: deny by default. Conservative — a future
    // event variant must be explicitly enumerated here before it can
    // ride the federation wire.
    Ok(Decision::Denied("unknown_event_type"))
}

fn check_team_authority(
    conn: &Connection,
    origin: &str,
    team_id: &str,
) -> Result<Decision, rusqlite::Error> {
    let row: Option<String> = conn
        .query_row(
            "SELECT owner_node_id FROM team_authority WHERE team_id = ?1",
            params![team_id],
            |r| r.get(0),
        )
        .optional()?;
    match row {
        None => Ok(Decision::LegacyTeam),
        Some(owner) if owner == origin => Ok(Decision::Allow),
        Some(_) => Ok(Decision::Denied("team.not_team_owner")),
    }
}

/// Record (or refresh) the authoritative node for a team. Called at
/// team creation and on legitimate ownership transfer. Idempotent.
pub fn record_team_owner(
    conn: &Connection,
    team_id: &str,
    owner_node_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO team_authority (team_id, owner_node_id, created_at) \
         VALUES (?1, ?2, datetime('now')) \
         ON CONFLICT(team_id) DO UPDATE SET owner_node_id = excluded.owner_node_id",
        params![team_id, owner_node_id],
    )?;
    Ok(())
}

/// Lookup helper for the operator CLI / admin API.
pub fn get_team_owner(
    conn: &Connection,
    team_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT owner_node_id FROM team_authority WHERE team_id = ?1",
        params![team_id],
        |r| r.get(0),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::federation::identity;
    use crate::federation::wire;
    use crate::federation::FederationEvent;

    fn fresh_db() -> Database {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;"))
            .unwrap();
        db.run_migrations().unwrap();
        Box::leak(Box::new(tmp));
        db
    }

    fn build_signed(
        identity: &identity::NodeIdentity,
        event_type: &str,
        payload: serde_json::Value,
    ) -> SignedFederationEvent {
        let event = FederationEvent {
            event_type: event_type.into(),
            node_name: identity.node_id.clone(),
            timestamp: 1_700_000_000,
            payload,
        };
        wire::sign(identity, event, 1).unwrap()
    }

    #[test]
    fn channel_create_allowed_when_origin_is_team_owner() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(
            &id,
            "channel.create",
            serde_json::json!({ "team_id": "t1", "name": "general" }),
        );
        db.with_conn(|c| {
            record_team_owner(c, "t1", &id.node_id).unwrap();
            assert_eq!(check(c, &signed).unwrap(), Decision::Allow);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn channel_create_denied_when_origin_not_team_owner() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(
            &id,
            "channel.create",
            serde_json::json!({ "team_id": "t1" }),
        );
        db.with_conn(|c| {
            record_team_owner(c, "t1", "some-other-node").unwrap();
            assert!(matches!(
                check(c, &signed).unwrap(),
                Decision::Denied("team.not_team_owner")
            ));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn legacy_team_returned_when_team_authority_row_missing() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(
            &id,
            "role.update",
            serde_json::json!({ "team_id": "t-legacy" }),
        );
        db.with_conn(|c| {
            assert_eq!(check(c, &signed).unwrap(), Decision::LegacyTeam);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn member_event_with_missing_team_id_is_denied() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(&id, "member.add", serde_json::json!({}));
        db.with_conn(|c| {
            assert!(matches!(
                check(c, &signed).unwrap(),
                Decision::Denied("missing_team_id")
            ));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn message_create_allowed_when_home_peer_matches_origin() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(
            &id,
            "message.create",
            serde_json::json!({
                "message_id": "m1",
                "home_node_id": id.node_id,
            }),
        );
        db.with_conn(|c| {
            assert_eq!(check(c, &signed).unwrap(), Decision::Allow);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn message_create_denied_when_home_peer_does_not_match() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(
            &id,
            "message.create",
            serde_json::json!({
                "message_id": "m1",
                "home_node_id": "different-node",
            }),
        );
        db.with_conn(|c| {
            assert!(matches!(
                check(c, &signed).unwrap(),
                Decision::Denied("message.author_home_peer_mismatch")
            ));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn message_with_no_home_node_id_falls_back_to_legacy_team() {
        // Legacy unsigned-era events lack home_node_id. The rolling
        // upgrade window accepts them; release N+2 will harden this.
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(
            &id,
            "message:new",
            serde_json::json!({ "message_id": "m1" }),
        );
        db.with_conn(|c| {
            assert_eq!(check(c, &signed).unwrap(), Decision::LegacyTeam);
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn unknown_event_type_is_denied() {
        let db = fresh_db();
        let id = identity::ensure(&db).unwrap();
        let signed = build_signed(&id, "wildcat.something", serde_json::json!({}));
        db.with_conn(|c| {
            assert!(matches!(
                check(c, &signed).unwrap(),
                Decision::Denied("unknown_event_type")
            ));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }

    #[test]
    fn record_team_owner_is_idempotent_and_updates_ownership() {
        let db = fresh_db();
        db.with_conn(|c| {
            record_team_owner(c, "t1", "alpha").unwrap();
            assert_eq!(get_team_owner(c, "t1").unwrap(), Some("alpha".into()));
            // Transfer ownership.
            record_team_owner(c, "t1", "beta").unwrap();
            assert_eq!(get_team_owner(c, "t1").unwrap(), Some("beta".into()));
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    }
}
