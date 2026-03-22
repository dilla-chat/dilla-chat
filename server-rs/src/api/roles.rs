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
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub permissions: i64,
}

fn default_color() -> String {
    "#99AAB5".into()
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    pub color: Option<String>,
    pub permissions: Option<i64>,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct ReorderRequest {
    pub role_ids: Vec<String>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let roles = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        db::get_roles_by_team(conn, &team_id)
    })
    .await?;

    json_ok(roles)
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<Json<Value>, AppError> {
    if body.name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }

    let role = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_ROLES)?;

        // Get current max position.
        let roles = db::get_roles_by_team(conn, &team_id)?;
        let max_pos = roles.iter().map(|r| r.position).max().unwrap_or(0);

        let role = db::Role {
            id: db::new_id(),
            team_id: team_id.clone(),
            name: body.name.clone(),
            color: body.color.clone(),
            position: max_pos + 1,
            permissions: body.permissions,
            is_default: false,
            created_at: db::now_str(),
            updated_at: String::new(),
        };
        db::create_role(conn, &role)?;
        Ok(role)
    })
    .await?;

    json_ok(role)
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, role_id)): Path<(String, String)>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<Json<Value>, AppError> {
    let role = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_ROLES)?;

        let mut role = get_role_for_team(conn, &role_id, &team_id)?;
        apply_role_updates(&mut role, &body);
        db::update_role(conn, &role)?;
        Ok(role)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("role not found".into()),
        other => other,
    })?;

    json_ok(role)
}

pub async fn delete_role(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, role_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_ROLES)?;

        let role = db::get_role_by_id(conn, &role_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;

        if role.team_id != team_id {
            return Err(rusqlite::Error::InvalidParameterName(
                "role does not belong to this team".into(),
            ));
        }

        if role.is_default {
            return Err(rusqlite::Error::InvalidParameterName(
                "cannot delete the default role".into(),
            ));
        }

        db::delete_role(conn, &role_id)?;
        Ok(())
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("role not found".into()),
        other => other,
    })?;

    json_ok_true()
}

pub async fn reorder(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<ReorderRequest>,
) -> Result<Json<Value>, AppError> {
    if body.role_ids.is_empty() {
        return Err(AppError::BadRequest("role_ids is required".into()));
    }

    let roles = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id, db::PERM_MANAGE_ROLES)?;

        for (i, role_id) in body.role_ids.iter().enumerate() {
            if let Some(mut role) = db::get_role_by_id(conn, role_id)? {
                if role.team_id == team_id {
                    role.position = i as i32;
                    db::update_role(conn, &role)?;
                }
            }
        }

        db::get_roles_by_team(conn, &team_id)
    })
    .await?;

    json_ok(roles)
}

/// Fetch a role by ID and verify it belongs to the given team.
fn get_role_for_team(
    conn: &rusqlite::Connection,
    role_id: &str,
    team_id: &str,
) -> Result<db::Role, rusqlite::Error> {
    let role = db::get_role_by_id(conn, role_id)?
        .ok_or(rusqlite::Error::QueryReturnedNoRows)?;

    if role.team_id != team_id {
        return Err(rusqlite::Error::InvalidParameterName(
            "role does not belong to this team".into(),
        ));
    }
    Ok(role)
}

/// Apply optional update fields to a role.
fn apply_role_updates(role: &mut db::Role, body: &UpdateRoleRequest) {
    if let Some(ref name) = body.name {
        role.name = name.clone();
    }
    if let Some(ref color) = body.color {
        role.color = color.clone();
    }
    if let Some(perms) = body.permissions {
        role.permissions = perms;
    }
    if let Some(pos) = body.position {
        role.position = pos;
    }
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

    fn make_role(id: &str, team_id: &str) -> db::Role {
        db::Role {
            id: id.into(),
            team_id: team_id.into(),
            name: "moderator".into(),
            color: "#FF0000".into(),
            position: 0,
            permissions: db::PERM_SEND_MESSAGES,
            is_default: false,
            created_at: db::now_str(),
            updated_at: String::new(),
        }
    }

    fn seed_team_and_role(db: &Database) {
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
                updated_at: now.clone(),
            })?;
            db::create_role(conn, &make_role("r1", "t1"))
        })
        .unwrap();
    }

    // ── get_role_for_team tests ─────────────────────────────────────────

    #[test]
    fn get_role_for_team_success() {
        let (db, _tmp) = test_db();
        seed_team_and_role(&db);

        let role = db
            .with_conn(|conn| get_role_for_team(conn, "r1", "t1"))
            .unwrap();
        assert_eq!(role.id, "r1");
        assert_eq!(role.team_id, "t1");
        assert_eq!(role.name, "moderator");
    }

    #[test]
    fn get_role_for_team_wrong_team() {
        let (db, _tmp) = test_db();
        seed_team_and_role(&db);

        let result = db.with_conn(|conn| get_role_for_team(conn, "r1", "other_team"));
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::InvalidParameterName(msg) => {
                assert!(msg.contains("does not belong"));
            }
            other => panic!("expected InvalidParameterName, got {:?}", other),
        }
    }

    #[test]
    fn get_role_for_team_not_found() {
        let (db, _tmp) = test_db();
        seed_team_and_role(&db);

        let result = db.with_conn(|conn| get_role_for_team(conn, "nonexistent", "t1"));
        assert!(result.is_err());
        match result.unwrap_err() {
            rusqlite::Error::QueryReturnedNoRows => {}
            other => panic!("expected QueryReturnedNoRows, got {:?}", other),
        }
    }

    // ── apply_role_updates tests ────────────────────────────────────────

    #[test]
    fn apply_role_updates_all_fields() {
        let mut role = make_role("r1", "t1");

        let body = UpdateRoleRequest {
            name: Some("admin".into()),
            color: Some("#00FF00".into()),
            permissions: Some(db::PERM_ADMIN),
            position: Some(10),
        };

        apply_role_updates(&mut role, &body);

        assert_eq!(role.name, "admin");
        assert_eq!(role.color, "#00FF00");
        assert_eq!(role.permissions, db::PERM_ADMIN);
        assert_eq!(role.position, 10);
    }

    #[test]
    fn apply_role_updates_no_fields() {
        let mut role = make_role("r1", "t1");
        let original_name = role.name.clone();
        let original_color = role.color.clone();
        let original_perms = role.permissions;
        let original_pos = role.position;

        let body = UpdateRoleRequest {
            name: None,
            color: None,
            permissions: None,
            position: None,
        };

        apply_role_updates(&mut role, &body);

        assert_eq!(role.name, original_name);
        assert_eq!(role.color, original_color);
        assert_eq!(role.permissions, original_perms);
        assert_eq!(role.position, original_pos);
    }

    #[test]
    fn apply_role_updates_partial_name_only() {
        let mut role = make_role("r1", "t1");

        let body = UpdateRoleRequest {
            name: Some("new-name".into()),
            color: None,
            permissions: None,
            position: None,
        };

        apply_role_updates(&mut role, &body);

        assert_eq!(role.name, "new-name");
        assert_eq!(role.color, "#FF0000");
    }

    #[test]
    fn apply_role_updates_partial_permissions_only() {
        let mut role = make_role("r1", "t1");

        let body = UpdateRoleRequest {
            name: None,
            color: None,
            permissions: Some(db::PERM_MANAGE_CHANNELS | db::PERM_MANAGE_ROLES),
            position: None,
        };

        apply_role_updates(&mut role, &body);

        assert_eq!(role.permissions, db::PERM_MANAGE_CHANNELS | db::PERM_MANAGE_ROLES);
        assert_eq!(role.name, "moderator");
    }

    #[test]
    fn apply_role_updates_partial_color_only() {
        let mut role = make_role("r1", "t1");

        let body = UpdateRoleRequest {
            name: None,
            color: Some("#0000FF".into()),
            permissions: None,
            position: None,
        };

        apply_role_updates(&mut role, &body);

        assert_eq!(role.color, "#0000FF");
        assert_eq!(role.name, "moderator");
        assert_eq!(role.permissions, db::PERM_SEND_MESSAGES);
    }

    #[test]
    fn apply_role_updates_partial_position_only() {
        let mut role = make_role("r1", "t1");

        let body = UpdateRoleRequest {
            name: None,
            color: None,
            permissions: None,
            position: Some(99),
        };

        apply_role_updates(&mut role, &body);

        assert_eq!(role.position, 99);
        assert_eq!(role.name, "moderator");
    }

    #[test]
    fn get_role_for_team_verifies_team_membership() {
        let (db, _tmp) = test_db();
        seed_team_and_role(&db);

        // Create a second team
        let now = db::now_str();
        db.with_conn(|conn| {
            db::create_team(conn, &db::Team {
                id: "t2".into(),
                name: "Other".into(),
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

        // r1 belongs to t1, not t2
        let result = db.with_conn(|conn| get_role_for_team(conn, "r1", "t2"));
        assert!(result.is_err());
    }

    #[test]
    fn default_color_is_grey() {
        assert_eq!(default_color(), "#99AAB5");
    }
}
