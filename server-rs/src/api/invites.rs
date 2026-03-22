use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, json_ok_true, require_permission, require_team_member, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct CreateInviteRequest {
    #[serde(default)]
    pub max_uses: Option<i32>,
    #[serde(default)]
    pub expires_in_hours: Option<i64>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let invites = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_active_invites_by_team(conn, &team_id)
    })
    .await?;

    json_ok(invites)
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateInviteRequest>,
) -> Result<Json<Value>, AppError> {
    let auth = state.auth.clone();

    let invite = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_CREATE_INVITES)?;

        let now = db::now_str();
        let token = auth.generate_invite_token();

        let expires_at = body.expires_in_hours.map(|hours| {
            let expires = chrono::Utc::now() + chrono::Duration::hours(hours);
            expires.format("%Y-%m-%d %H:%M:%S").to_string()
        });

        let invite = db::Invite {
            id: db::new_id(),
            team_id: team_id.clone(),
            created_by: user_id.clone(),
            token,
            max_uses: body.max_uses,
            uses: 0,
            expires_at,
            revoked: false,
            created_at: now,
        };
        db::create_invite(conn, &invite)?;
        Ok(invite)
    })
    .await?;

    json_ok(invite)
}

pub async fn revoke(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, invite_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_CREATE_INVITES)?;

        let invite = db::get_invite_by_id(conn, &invite_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

        if invite.team_id != team_id {
            return Err(rusqlite::Error::InvalidParameterName(
                "invite does not belong to this team".into(),
            ));
        }

        db::revoke_invite(conn, &invite_id)?;
        Ok(())
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("invite not found".into()),
        other => other,
    })?;

    json_ok_true()
}

/// Public endpoint (no auth required) -- returns invite info for a token.
pub async fn get_invite_info(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>, AppError> {
    let info = spawn_db(state.db.clone(), move |conn| {
        let invite = validate_invite_token(conn, &token)?;
        let team = db::get_team(conn, &invite.team_id)?;

        Ok(serde_json::json!({
            "team_id": invite.team_id,
            "team_name": team.map(|t| t.name).unwrap_or_default(),
            "token": invite.token,
        }))
    })
    .await
    .map_err(|e| match e {
        AppError::Forbidden(msg) => AppError::BadRequest(msg),
        AppError::NotFound(_) => AppError::NotFound("invite not found".into()),
        other => other,
    })?;

    Ok(Json(info))
}

/// Validate an invite token: check existence, revocation, max uses, and expiry.
fn validate_invite_token(
    conn: &rusqlite::Connection,
    token: &str,
) -> Result<db::Invite, rusqlite::Error> {
    let invite = db::get_invite_by_token(conn, token)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    if invite.revoked {
        return Err(rusqlite::Error::InvalidParameterName("invite has been revoked".into()));
    }
    if let Some(max) = invite.max_uses {
        if invite.uses >= max {
            return Err(rusqlite::Error::InvalidParameterName("invite max uses reached".into()));
        }
    }
    if let Some(ref expires) = invite.expires_at {
        if db::now_str() > *expires {
            return Err(rusqlite::Error::InvalidParameterName("invite has expired".into()));
        }
    }
    Ok(invite)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Database};

    fn test_db() -> (Database, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = Database::open(tmp.path().to_str().unwrap(), "").unwrap();
        db.with_conn(|c| c.execute_batch("PRAGMA foreign_keys = OFF;")).unwrap();
        db.run_migrations().unwrap();
        (db, tmp)
    }

    fn seed_team(db: &Database) {
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_user(conn, &db::User {
                id: "u1".into(),
                username: "alice".into(),
                display_name: "Alice".into(),
                public_key: vec![1u8; 32],
                avatar_url: String::new(),
                status_text: String::new(),
                status_type: "online".into(),
                is_admin: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })?;
            db::create_team(conn, &db::Team {
                id: "t1".into(),
                name: "Team".into(),
                description: String::new(),
                icon_url: String::new(),
                created_by: "u1".into(),
                max_file_size: 25 * 1024 * 1024,
                allow_member_invites: true,
                created_at: now.clone(),
                updated_at: now,
            })
        })
        .unwrap();
    }

    // ── validate_invite_token tests ─────────────────────────────────────

    #[test]
    fn validate_invite_token_success() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "valid-token".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            let invite = validate_invite_token(conn, "valid-token")?;
            assert_eq!(invite.token, "valid-token");
            assert_eq!(invite.team_id, "t1");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn validate_invite_token_not_found() {
        let (db, _tmp) = test_db();
        let result = db.with_conn(|conn| validate_invite_token(conn, "nonexistent"));
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::QueryReturnedNoRows => {}
            other => panic!("expected QueryReturnedNoRows, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_token_revoked() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        let result = db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "revoked".into(),
                max_uses: None,
                uses: 0,
                expires_at: None,
                revoked: true,
                created_at: db::now_str(),
            })?;
            validate_invite_token(conn, "revoked")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => assert!(msg.contains("revoked")),
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_token_max_uses_reached() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        let result = db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "maxed".into(),
                max_uses: Some(3),
                uses: 3,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            validate_invite_token(conn, "maxed")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => assert!(msg.contains("max uses")),
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_token_uses_below_max_ok() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "under-max".into(),
                max_uses: Some(5),
                uses: 4,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            let invite = validate_invite_token(conn, "under-max")?;
            assert_eq!(invite.uses, 4);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn validate_invite_token_expired() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        let result = db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "expired".into(),
                max_uses: None,
                uses: 0,
                expires_at: Some("2000-01-01 00:00:00".into()),
                revoked: false,
                created_at: db::now_str(),
            })?;
            validate_invite_token(conn, "expired")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => assert!(msg.contains("expired")),
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_token_not_yet_expired_ok() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "future".into(),
                max_uses: None,
                uses: 0,
                expires_at: Some("2099-12-31 23:59:59".into()),
                revoked: false,
                created_at: db::now_str(),
            })?;
            let invite = validate_invite_token(conn, "future")?;
            assert_eq!(invite.token, "future");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn validate_invite_token_no_max_uses_unlimited() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "unlimited".into(),
                max_uses: None,
                uses: 9999,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            let invite = validate_invite_token(conn, "unlimited")?;
            assert_eq!(invite.uses, 9999);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn validate_invite_token_max_uses_zero_reached() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        let result = db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "zero-max".into(),
                max_uses: Some(0),
                uses: 0,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            validate_invite_token(conn, "zero-max")
        });
        assert!(result.is_err());
    }

    #[test]
    fn validate_invite_revoked_and_expired_checks_revoked_first() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        let result = db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "both-bad".into(),
                max_uses: None,
                uses: 0,
                expires_at: Some("2000-01-01 00:00:00".into()),
                revoked: true,
                created_at: db::now_str(),
            })?;
            validate_invite_token(conn, "both-bad")
        });
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => assert!(msg.contains("revoked")),
            other => panic!("expected revoked error, got {:?}", other),
        }
    }

    #[test]
    fn validate_invite_token_uses_exactly_at_max() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        let result = db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "exact-max".into(),
                max_uses: Some(5),
                uses: 5,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            validate_invite_token(conn, "exact-max")
        });
        assert!(result.is_err());
    }

    #[test]
    fn validate_invite_token_uses_one_below_max() {
        let (db, _tmp) = test_db();
        seed_team(&db);

        db.with_conn(|conn| {
            db::create_invite(conn, &db::Invite {
                id: "inv1".into(),
                team_id: "t1".into(),
                created_by: "u1".into(),
                token: "one-below".into(),
                max_uses: Some(5),
                uses: 4,
                expires_at: None,
                revoked: false,
                created_at: db::now_str(),
            })?;
            let invite = validate_invite_token(conn, "one-below")?;
            assert_eq!(invite.uses, 4);
            Ok(())
        })
        .unwrap();
    }
}
