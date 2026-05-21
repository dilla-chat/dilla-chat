use super::models::*;
use rusqlite::{params, Connection, OptionalExtension};

// ── Prekey bundle queries ───────────────────────────────────────────────────

pub fn save_prekey_bundle(
    conn: &Connection,
    bundle: &PrekeyBundle,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR REPLACE INTO prekey_bundles (id, user_id, identity_key, identity_dh_key, signed_prekey, signed_prekey_signature, one_time_prekeys, uploaded_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            bundle.id,
            bundle.user_id,
            bundle.identity_key,
            bundle.identity_dh_key,
            bundle.signed_prekey,
            bundle.signed_prekey_signature,
            bundle.one_time_prekeys,
            bundle.uploaded_at,
        ],
    )?;
    Ok(())
}

pub fn get_prekey_bundle(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<PrekeyBundle>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, user_id, identity_key, identity_dh_key, signed_prekey, signed_prekey_signature, one_time_prekeys, uploaded_at
         FROM prekey_bundles WHERE user_id = ?1",
        [user_id],
        |row| {
            Ok(PrekeyBundle {
                id: row.get(0)?,
                user_id: row.get(1)?,
                identity_key: row.get(2)?,
                identity_dh_key: row.get(3)?,
                signed_prekey: row.get(4)?,
                signed_prekey_signature: row.get(5)?,
                one_time_prekeys: row.get::<_, Option<Vec<u8>>>(6)?.unwrap_or_default(),
                uploaded_at: row.get(7)?,
            })
        },
    )
    .optional()
}

pub fn delete_prekey_bundle(conn: &Connection, user_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM prekey_bundles WHERE user_id = ?1",
        [user_id],
    )?;
    Ok(())
}

pub fn consume_one_time_prekey(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<Vec<u8>>, rusqlite::Error> {
    let bundle = get_prekey_bundle(conn, user_id)?;
    if let Some(bundle) = bundle {
        if bundle.one_time_prekeys.is_empty() {
            return Ok(None);
        }
        // Parse JSON array of base64-encoded prekeys, pop the first one.
        let keys: Vec<String> = serde_json::from_slice(&bundle.one_time_prekeys).unwrap_or_default();
        if keys.is_empty() {
            return Ok(None);
        }
        let consumed = keys[0].clone();
        let remaining = &keys[1..];
        let remaining_json = serde_json::to_vec(remaining).unwrap_or_default();
        conn.execute(
            "UPDATE prekey_bundles SET one_time_prekeys = ?1 WHERE user_id = ?2",
            params![remaining_json, user_id],
        )?;
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&consumed)
            .unwrap_or_default();
        Ok(Some(decoded))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::*;

    // ── Prekey bundle tests ─────────────────────────────────────────────

    #[test]
    fn test_save_and_get_prekey_bundle() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let bundle = PrekeyBundle {
            id: "pk1".into(), user_id: "u1".into(),
            identity_key: vec![1, 2, 3], identity_dh_key: vec![10, 11, 12], signed_prekey: vec![4, 5, 6],
            signed_prekey_signature: vec![7, 8, 9],
            one_time_prekeys: vec![], uploaded_at: crate::db::now_str(),
        };
        db.with_conn(|c| save_prekey_bundle(c, &bundle)).unwrap();

        let fetched = db.with_conn(|c| get_prekey_bundle(c, "u1")).unwrap().unwrap();
        assert_eq!(fetched.identity_key, vec![1, 2, 3]);
    }

    #[test]
    fn test_delete_prekey_bundle() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        let bundle = PrekeyBundle {
            id: "pk1".into(), user_id: "u1".into(),
            identity_key: vec![1], identity_dh_key: vec![10], signed_prekey: vec![2],
            signed_prekey_signature: vec![3],
            one_time_prekeys: vec![], uploaded_at: crate::db::now_str(),
        };
        db.with_conn(|c| save_prekey_bundle(c, &bundle)).unwrap();
        db.with_conn(|c| delete_prekey_bundle(c, "u1")).unwrap();

        let result = db.with_conn(|c| get_prekey_bundle(c, "u1")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_consume_one_time_prekey() {
        let db = test_db();
        let user = make_user("u1", "owner", &[1u8; 32]);
        db.with_conn(|c| crate::db::create_user(c, &user)).unwrap();

        use base64::Engine;
        let key1 = base64::engine::general_purpose::STANDARD.encode([10u8, 20, 30]);
        let key2 = base64::engine::general_purpose::STANDARD.encode([40u8, 50, 60]);
        let prekeys_json = serde_json::to_vec(&vec![key1, key2]).unwrap();

        let bundle = PrekeyBundle {
            id: "pk1".into(), user_id: "u1".into(),
            identity_key: vec![1], identity_dh_key: vec![10], signed_prekey: vec![2],
            signed_prekey_signature: vec![3],
            one_time_prekeys: prekeys_json, uploaded_at: crate::db::now_str(),
        };
        db.with_conn(|c| save_prekey_bundle(c, &bundle)).unwrap();

        let consumed = db.with_conn(|c| consume_one_time_prekey(c, "u1")).unwrap().unwrap();
        assert_eq!(consumed, vec![10u8, 20, 30]);

        let consumed2 = db.with_conn(|c| consume_one_time_prekey(c, "u1")).unwrap().unwrap();
        assert_eq!(consumed2, vec![40u8, 50, 60]);

        let consumed3 = db.with_conn(|c| consume_one_time_prekey(c, "u1")).unwrap();
        assert!(consumed3.is_none());
    }
}
