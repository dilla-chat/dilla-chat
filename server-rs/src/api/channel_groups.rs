// CRUD + access endpoints for channel_groups. Groups own the role-based
// access list and channels inherit; the resolver lives in
// db::channel_access_queries.
//
// Routes (registered in api/mod.rs):
//   GET    /api/v1/teams/{tid}/groups                — list
//   POST   /api/v1/teams/{tid}/groups                — create
//   PUT    /api/v1/teams/{tid}/groups/{gid}          — rename / reposition
//   DELETE /api/v1/teams/{tid}/groups/{gid}          — delete (channels unset)
//   GET    /api/v1/teams/{tid}/groups/{gid}/access   — role-id list
//   PUT    /api/v1/teams/{tid}/groups/{gid}/access   — replace role-id list

use axum::extract::{Path, State};
use axum::{Extension, Json};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;

use crate::api::helpers::{json_ok, json_ok_true, require_permission, require_team_member, spawn_db};
use crate::api::AppState;
use crate::auth::UserId;
use crate::db;
use crate::error::AppError;
use crate::ws::events::Event;

#[derive(Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
}

#[derive(Deserialize)]
pub struct UpdateGroupRequest {
    pub name: Option<String>,
    pub position: Option<i32>,
}

#[derive(Deserialize)]
pub struct SetAccessRequest {
    pub role_ids: Vec<String>,
}

pub async fn list(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let groups = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id)?;
        let groups = db::get_groups_by_team(conn, &team_id)?;
        let mut out: Vec<Value> = Vec::with_capacity(groups.len());
        for g in groups {
            let access = db::get_group_access_roles(conn, &g.id).unwrap_or_default();
            let mut v = serde_json::to_value(&g).unwrap_or(Value::Null);
            if let Value::Object(ref mut m) = v {
                m.insert("access_role_ids".into(), serde_json::json!(access));
            }
            out.push(v);
        }
        Ok::<_, rusqlite::Error>(out)
    })
    .await?;
    json_ok(groups)
}

pub async fn create(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Json(body): Json<CreateGroupRequest>,
) -> Result<Json<Value>, AppError> {
    let trimmed = body.name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    if trimmed.chars().count() > 100 {
        return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
    }
    let team_id_clone = team_id.clone();
    let group = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id_clone, db::PERM_MANAGE_CHANNELS)?;
        if db::group_name_exists(conn, &team_id_clone, &trimmed, None)? {
            return Err(rusqlite::Error::InvalidParameterName(
                "group_name_conflict".into(),
            ));
        }
        // Position = next slot at the end of the existing list.
        let max_pos: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM channel_groups WHERE team_id = ?1",
                rusqlite::params![team_id_clone],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(-1);
        let now = db::now_str();
        let group = db::ChannelGroup {
            id: db::new_id(),
            team_id: team_id_clone.clone(),
            name: trimmed.clone(),
            position: max_pos + 1,
            created_at: now.clone(),
            updated_at: now,
        };
        db::create_group(conn, &group)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id),
            "group.create",
            Some("group"),
            Some(&group.id),
            Some(&serde_json::json!({ "name": group.name })),
        );
        Ok(group)
    })
    .await
    .map_err(map_group_name_conflict)?;

    broadcast(&state, &team_id, "group:created", &group, &[]).await;
    json_ok(group)
}

pub async fn update(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, group_id)): Path<(String, String)>,
    Json(body): Json<UpdateGroupRequest>,
) -> Result<Json<Value>, AppError> {
    if let Some(ref n) = body.name {
        let t = n.trim();
        if t.is_empty() {
            return Err(AppError::BadRequest("name cannot be empty".into()));
        }
        if t.chars().count() > 100 {
            return Err(AppError::BadRequest("name too long (max 100 chars)".into()));
        }
    }
    let team_id_clone = team_id.clone();
    let group_id_clone = group_id.clone();
    let group = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id_clone, db::PERM_MANAGE_CHANNELS)?;
        let mut g = db::get_group_by_id(conn, &group_id_clone)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if g.team_id != team_id_clone {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        if let Some(name) = body.name {
            let trimmed = name.trim().to_string();
            if db::group_name_exists(conn, &team_id_clone, &trimmed, Some(&group_id_clone))? {
                return Err(rusqlite::Error::InvalidParameterName(
                    "group_name_conflict".into(),
                ));
            }
            g.name = trimmed;
        }
        if let Some(pos) = body.position {
            g.position = pos;
        }
        g.updated_at = db::now_str();
        db::update_group(conn, &g)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id),
            "group.update",
            Some("group"),
            Some(&g.id),
            Some(&serde_json::json!({ "name": g.name, "position": g.position })),
        );
        Ok(g)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("group not found".into()),
        other => map_group_name_conflict(other),
    })?;

    broadcast(&state, &team_id, "group:updated", &group, &[]).await;
    json_ok(group)
}

pub async fn delete(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, group_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let group_id_clone = group_id.clone();
    let (group, affected_channels) = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id_clone, db::PERM_MANAGE_CHANNELS)?;
        let g = db::get_group_by_id(conn, &group_id_clone)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if g.team_id != team_id_clone {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        // Collect affected channel ids so the WS broadcast can wake clients
        // that subscribe per-channel (ws clients only subscribe to channels,
        // not arbitrary group ids).
        let mut stmt = conn.prepare(
            "SELECT id FROM channels WHERE group_id = ?1",
        )?;
        let channels: Vec<String> = stmt
            .query_map([&group_id_clone], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        db::delete_group(conn, &group_id_clone)?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id),
            "group.delete",
            Some("group"),
            Some(&group_id_clone),
            Some(&serde_json::json!({ "name": g.name })),
        );
        Ok::<_, rusqlite::Error>((g, channels))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("group not found".into()),
        other => other,
    })?;

    broadcast(&state, &team_id, "group:deleted", &group, &affected_channels).await;
    json_ok_true()
}

pub async fn get_access(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, group_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let group_id_clone = group_id.clone();
    let role_ids = spawn_db(state.db.clone(), move |conn| {
        require_team_member(conn, &user_id, &team_id_clone)?;
        let g = db::get_group_by_id(conn, &group_id_clone)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if g.team_id != team_id_clone {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        db::get_group_access_roles(conn, &group_id_clone)
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("group not found".into()),
        other => other,
    })?;
    json_ok(serde_json::json!({ "role_ids": role_ids }))
}

pub async fn set_access(
    Extension(UserId(user_id)): Extension<UserId>,
    State(state): State<AppState>,
    Path((team_id, group_id)): Path<(String, String)>,
    Json(body): Json<SetAccessRequest>,
) -> Result<Json<Value>, AppError> {
    let team_id_clone = team_id.clone();
    let group_id_clone = group_id.clone();
    let (group, role_ids, affected_channels) = spawn_db(state.db.clone(), move |conn| {
        require_permission(conn, &user_id, &team_id_clone, db::PERM_MANAGE_CHANNELS)?;
        let g = db::get_group_by_id(conn, &group_id_clone)?
            .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        if g.team_id != team_id_clone {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        }
        db::set_group_access_roles(conn, &group_id_clone, &body.role_ids)?;
        let mut stmt = conn.prepare(
            "SELECT id FROM channels WHERE group_id = ?1",
        )?;
        let channels: Vec<String> = stmt
            .query_map([&group_id_clone], |row| row.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;
        let _ = db::insert_audit_event(
            conn,
            &team_id_clone,
            Some(&user_id),
            "group.access",
            Some("group"),
            Some(&group_id_clone),
            Some(&serde_json::json!({ "name": g.name, "role_ids": &body.role_ids })),
        );
        Ok::<_, rusqlite::Error>((g, body.role_ids, channels))
    })
    .await
    .map_err(|e| match e {
        AppError::NotFound(_) => AppError::NotFound("group not found".into()),
        other => other,
    })?;

    // Push the access-update event so sidebar restriction state and the
    // server-driven "channel hidden" recompute can run client-side without
    // a full re-sync. Carries the group's id, name, role list, and the
    // ids of every channel that inherits this list.
    let payload = serde_json::json!({
        "group_id": group.id,
        "team_id": group.team_id,
        "name": group.name,
        "role_ids": role_ids,
        "channel_ids": affected_channels,
    });
    if let Ok(evt) = Event::new("group:access-update", payload.clone()) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.broadcast_to_all(bytes).await;
        }
    }
    json_ok(payload)
}

fn map_group_name_conflict(e: AppError) -> AppError {
    match e {
        AppError::Forbidden(msg) if msg == "group_name_conflict" => AppError::Conflict(
            "a group with that name already exists in this team".into(),
        ),
        other => other,
    }
}

async fn broadcast(
    state: &AppState,
    team_id: &str,
    kind: &str,
    group: &db::ChannelGroup,
    affected_channels: &[String],
) {
    let payload = serde_json::json!({
        "group": group,
        "team_id": team_id,
        "channel_ids": affected_channels,
    });
    if let Ok(evt) = Event::new(kind, payload) {
        if let Ok(bytes) = evt.to_bytes() {
            state.hub.broadcast_to_all(bytes).await;
        }
    }
}
