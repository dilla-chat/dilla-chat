#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crypto;
mod db;
mod keystore;
mod auth_server;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crypto::{CryptoManager, PrekeyBundle};
use ed25519_dalek::Signature;
use keystore::{KeyPair, PasskeyCredential};
use std::path::PathBuf;
use std::sync::Mutex;

fn keypair_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("identity.key")
}

fn sessions_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("sessions.enc")
}

fn prekey_secrets_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("prekey_secrets.json")
}

#[tauri::command]
fn generate_keypair(passphrase: String, data_dir: String) -> Result<String, String> {
    let kp = KeyPair::generate_keypair();
    kp.save_encrypted(&keypair_path(&data_dir), &passphrase)?;
    Ok(B64.encode(kp.export_public_key()))
}

#[tauri::command]
fn load_keypair(passphrase: String, data_dir: String) -> Result<String, String> {
    let kp = KeyPair::load_encrypted(&keypair_path(&data_dir), &passphrase)?;
    Ok(B64.encode(kp.export_public_key()))
}

#[tauri::command]
fn sign_challenge(nonce_b64: String, passphrase: String, data_dir: String) -> Result<String, String> {
    let nonce_bytes = B64.decode(&nonce_b64).map_err(|e| format!("Invalid base64 nonce: {e}"))?;
    let kp = KeyPair::load_encrypted(&keypair_path(&data_dir), &passphrase)?;
    let sig: Signature = kp.sign_message(&nonce_bytes);
    Ok(B64.encode(sig.to_bytes()))
}

#[tauri::command]
fn has_keypair(data_dir: String) -> bool {
    keypair_path(&data_dir).exists()
}

#[tauri::command]
fn get_public_key(passphrase: String, data_dir: String) -> Result<String, String> {
    let kp = KeyPair::load_encrypted(&keypair_path(&data_dir), &passphrase)?;
    Ok(B64.encode(kp.export_public_key()))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to Dilla.", name)
}

// ─── V2: Passkey/PRF-based commands ──────────────────────────────────────────

fn decode_key_b64(key_b64: &str) -> Result<[u8; 32], String> {
    let bytes = B64.decode(key_b64).map_err(|e| format!("Invalid base64 key: {e}"))?;
    bytes.try_into().map_err(|_| "Key must be exactly 32 bytes".to_string())
}

#[tauri::command]
fn generate_keypair_with_key(
    derived_key_b64: String,
    prf_salt_b64: String,
    credential_id: String,
    credential_name: String,
    recovery_key_b64: Option<String>,
    data_dir: String,
) -> Result<String, String> {
    let derived_key = decode_key_b64(&derived_key_b64)?;
    let prf_salt = B64.decode(&prf_salt_b64).map_err(|e| format!("Invalid prf_salt: {e}"))?;

    let recovery_key = match &recovery_key_b64 {
        Some(rk) => Some(decode_key_b64(rk)?),
        None => None,
    };

    let kp = KeyPair::generate_keypair();
    let credentials = vec![PasskeyCredential {
        id: credential_id,
        name: credential_name,
        created_at: chrono_now(),
    }];

    kp.save_with_raw_key(
        &keypair_path(&data_dir),
        &derived_key,
        &prf_salt,
        credentials,
        recovery_key.as_ref(),
    )?;

    Ok(B64.encode(kp.export_public_key()))
}

#[tauri::command]
fn load_keypair_with_key(derived_key_b64: String, data_dir: String) -> Result<String, String> {
    let derived_key = decode_key_b64(&derived_key_b64)?;
    let path = keypair_path(&data_dir);
    let version = keystore::detect_key_version(&path)?;
    let kp = if version >= 3 {
        KeyPair::load_v3_with_prf(&path, &derived_key)?
    } else {
        KeyPair::load_with_raw_key(&path, &derived_key)?
    };
    Ok(B64.encode(kp.export_public_key()))
}

#[tauri::command]
fn load_keypair_with_recovery(recovery_key_b64: String, data_dir: String) -> Result<String, String> {
    let recovery_key = decode_key_b64(&recovery_key_b64)?;
    let path = keypair_path(&data_dir);
    let version = keystore::detect_key_version(&path)?;
    let kp = if version >= 3 {
        KeyPair::load_v3_with_recovery(&path, &recovery_key)?
    } else {
        KeyPair::load_with_recovery_key(&path, &recovery_key)?
    };
    Ok(B64.encode(kp.export_public_key()))
}

#[tauri::command]
fn sign_challenge_with_key(
    nonce_b64: String,
    derived_key_b64: String,
    data_dir: String,
) -> Result<String, String> {
    let nonce_bytes = B64.decode(&nonce_b64).map_err(|e| format!("Invalid base64 nonce: {e}"))?;
    let derived_key = decode_key_b64(&derived_key_b64)?;
    let path = keypair_path(&data_dir);
    let version = keystore::detect_key_version(&path)?;
    let kp = if version >= 3 {
        KeyPair::load_v3_with_prf(&path, &derived_key)?
    } else {
        KeyPair::load_with_raw_key(&path, &derived_key)?
    };
    let sig: Signature = kp.sign_message(&nonce_bytes);
    Ok(B64.encode(sig.to_bytes()))
}

#[tauri::command]
fn get_credential_info(data_dir: String) -> Result<serde_json::Value, String> {
    let path = keypair_path(&data_dir);
    let version = keystore::detect_key_version(&path)?;

    let (credentials, prf_salt) = if version >= 3 {
        keystore::read_credentials_v3(&path)?
    } else if version >= 2 {
        keystore::read_credentials(&path)?
    } else {
        return Ok(serde_json::json!({
            "version": 1,
            "credentials": [],
            "prf_salt": null
        }));
    };

    let key_slots = if version >= 3 {
        let slots = keystore::read_key_slots(&path)?;
        serde_json::to_value(&slots).unwrap_or(serde_json::json!([]))
    } else {
        serde_json::json!([])
    };

    Ok(serde_json::json!({
        "version": version,
        "credentials": credentials,
        "prf_salt": B64.encode(&prf_salt),
        "key_slots": key_slots
    }))
}

#[tauri::command]
fn generate_recovery_key_cmd() -> String {
    let key = keystore::generate_recovery_key();
    B64.encode(key)
}

/// Regenerate recovery key: loads identity with current derived key, generates new recovery key,
/// re-saves identity.key with new recovery encryption, returns new recovery key as base64.
#[tauri::command]
fn regenerate_recovery_key(derived_key_b64: String, data_dir: String) -> Result<String, String> {
    let derived_key = decode_key_b64(&derived_key_b64)?;
    let path = keypair_path(&data_dir);

    // Load keypair and credential info
    let kp = KeyPair::load_with_raw_key(&path, &derived_key)?;
    let (credentials, prf_salt) = keystore::read_credentials(&path)?;

    // Generate new recovery key
    let new_recovery_key = keystore::generate_recovery_key();

    // Re-save with new recovery key
    kp.save_with_raw_key(&path, &derived_key, &prf_salt, credentials, Some(&new_recovery_key))?;

    Ok(B64.encode(new_recovery_key))
}

#[tauri::command]
fn generate_prf_salt_cmd() -> String {
    let salt = keystore::generate_prf_salt();
    B64.encode(salt)
}

fn chrono_now() -> String {
    // Simple ISO 8601 timestamp
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

// ─── Identity Blob Escrow Commands ───────────────────────────────────────────

#[tauri::command]
fn upload_identity_blob(
    server_url: String,
    jwt: String,
    servers: Vec<String>,
    data_dir: String,
) -> Result<(), String> {
    let path = keypair_path(&data_dir);
    let blob = keystore::read_recovery_blob(&path, &servers)?
        .ok_or("No recovery data in identity file — cannot upload blob")?;

    let url = format!("{}/api/v1/identity/blob", server_url.trim_end_matches('/'));
    let resp = ureq::put(&url)
        .set("Authorization", &format!("Bearer {jwt}"))
        .set("Content-Type", "application/json")
        .send_string(&serde_json::json!({"blob": blob}).to_string())
        .map_err(|e| format!("Upload failed: {e}"))?;

    if resp.status() != 200 {
        return Err(format!("Server returned status {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
fn recover_identity_from_server(
    server_url: String,
    username: String,
    recovery_key_b64: String,
    data_dir: String,
) -> Result<RecoverResult, String> {
    let recovery_key = decode_key_b64(&recovery_key_b64)?;

    // Fetch encrypted blob from server
    let url = format!(
        "{}/api/v1/identity/blob?username={}",
        server_url.trim_end_matches('/'),
        username
    );
    let resp = ureq::get(&url)
        .call()
        .map_err(|e| format!("Failed to fetch blob: {e}"))?;

    if resp.status() != 200 {
        return Err(format!("Server returned status {}", resp.status()));
    }

    let body: serde_json::Value = resp.into_json().map_err(|e| format!("Invalid response: {e}"))?;
    let blob_str = body["blob"]
        .as_str()
        .ok_or("No blob field in response")?;

    // Decrypt blob to get signing key and server list
    let (signing_key, servers) = keystore::decrypt_identity_blob(blob_str, &recovery_key)?;
    let verifying_key = signing_key.verifying_key();
    let pub_key_b64 = B64.encode(verifying_key.as_bytes());

    // Save locally as a new identity file (encrypted with recovery key)
    let kp = KeyPair::from_signing_key(signing_key);
    let path = keypair_path(&data_dir);
    let prf_salt = keystore::generate_prf_salt();
    kp.save_with_raw_key(
        &path,
        &recovery_key,    // Use recovery key as the raw key for now
        &prf_salt,
        vec![],           // No passkey credentials yet
        Some(&recovery_key),
    )?;

    Ok(RecoverResult {
        public_key: pub_key_b64,
        servers,
    })
}

#[derive(serde::Serialize)]
struct RecoverResult {
    public_key: String,
    servers: Vec<String>,
}

// ─── Phase 3: E2E Encryption Commands ────────────────────────────────────────

fn load_crypto_manager(passphrase: &str, data_dir: &str) -> Result<CryptoManager, String> {
    let kp = KeyPair::load_encrypted(&keypair_path(data_dir), passphrase)?;
    load_crypto_manager_inner(kp, passphrase, data_dir)
}

fn load_crypto_manager_with_key(derived_key_b64: &str, data_dir: &str) -> Result<CryptoManager, String> {
    let derived_key = decode_key_b64(derived_key_b64)?;
    let kp = KeyPair::load_with_raw_key(&keypair_path(data_dir), &derived_key)?;
    // For session encryption, use the derived key as the "passphrase" (base64 form)
    load_crypto_manager_inner(kp, derived_key_b64, data_dir)
}

fn load_crypto_manager_inner(kp: KeyPair, session_key: &str, data_dir: &str) -> Result<CryptoManager, String> {
    let mut mgr = CryptoManager::load_sessions(
        &sessions_path(data_dir),
        session_key,
        kp.signing_key().clone(),
    )?;

    // Load prekey secrets if they exist
    let pks_path = prekey_secrets_path(data_dir);
    if pks_path.exists() {
        let data = std::fs::read_to_string(&pks_path).map_err(|e| e.to_string())?;
        let secrets: crypto::PrekeySecrets =
            serde_json::from_str(&data).map_err(|e| e.to_string())?;
        mgr.set_prekey_secrets(secrets);
    }

    Ok(mgr)
}

fn save_crypto_manager(mgr: &CryptoManager, passphrase: &str, data_dir: &str) -> Result<(), String> {
    mgr.save_sessions(&sessions_path(data_dir), passphrase)
}

#[tauri::command]
fn generate_prekey_bundle_cmd(
    passphrase: String,
    data_dir: String,
) -> Result<String, String> {
    let kp = KeyPair::load_encrypted(&keypair_path(&data_dir), &passphrase)?;
    let (bundle, secrets) = crypto::generate_prekey_bundle(kp.signing_key(), 10);

    // Save prekey secrets locally
    let secrets_json = serde_json::to_string_pretty(&secrets).map_err(|e| e.to_string())?;
    let pks_path = prekey_secrets_path(&data_dir);
    if let Some(parent) = pks_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&pks_path, &secrets_json).map_err(|e| e.to_string())?;

    serde_json::to_string(&bundle).map_err(|e| e.to_string())
}

#[tauri::command]
fn init_session_with_bundle(
    peer_id: String,
    bundle_json: String,
    passphrase: String,
    data_dir: String,
) -> Result<(), String> {
    let bundle: PrekeyBundle =
        serde_json::from_str(&bundle_json).map_err(|e| format!("Invalid bundle JSON: {e}"))?;
    let mut mgr = load_crypto_manager(&passphrase, &data_dir)?;
    mgr.get_or_create_session(&peer_id, &bundle)?;
    save_crypto_manager(&mgr, &passphrase, &data_dir)
}

#[tauri::command]
fn encrypt_message(
    peer_id: String,
    plaintext: String,
    is_dm: bool,
    channel_id: String,
    passphrase: String,
    data_dir: String,
) -> Result<String, String> {
    let mut mgr = load_crypto_manager(&passphrase, &data_dir)?;
    let ciphertext = if is_dm {
        mgr.encrypt_dm(&peer_id, plaintext.as_bytes())?
    } else {
        mgr.encrypt_channel(&channel_id, plaintext.as_bytes())?
    };
    save_crypto_manager(&mgr, &passphrase, &data_dir)?;
    Ok(B64.encode(ciphertext))
}

#[tauri::command]
fn decrypt_message(
    sender_id: String,
    ciphertext: String,
    is_dm: bool,
    channel_id: String,
    passphrase: String,
    data_dir: String,
) -> Result<String, String> {
    let ct_bytes = B64.decode(&ciphertext).map_err(|e| format!("Invalid base64: {e}"))?;
    let mut mgr = load_crypto_manager(&passphrase, &data_dir)?;
    let plaintext = if is_dm {
        mgr.decrypt_dm(&sender_id, &ct_bytes)?
    } else {
        mgr.decrypt_channel(&channel_id, &sender_id, &ct_bytes)?
    };
    save_crypto_manager(&mgr, &passphrase, &data_dir)?;
    String::from_utf8(plaintext).map_err(|e| format!("Invalid UTF-8: {e}"))
}

#[tauri::command]
fn get_safety_number(
    peer_id: String,
    peer_public_key: String,
    passphrase: String,
    data_dir: String,
) -> Result<String, String> {
    let kp = KeyPair::load_encrypted(&keypair_path(&data_dir), &passphrase)?;
    let our_pub = kp.export_public_key();
    let their_pub = B64.decode(&peer_public_key).map_err(|e| format!("Invalid base64: {e}"))?;
    // Use a stable identifier: we don't have user_id here so use "self" / peer_id
    Ok(crypto::generate_safety_number(
        &our_pub, "self", &their_pub, &peer_id,
    ))
}

#[tauri::command]
fn process_sender_key(
    channel_id: String,
    distribution_json: String,
    passphrase: String,
    data_dir: String,
) -> Result<(), String> {
    let dist: crypto::SenderKeyDistribution =
        serde_json::from_str(&distribution_json).map_err(|e| format!("Invalid JSON: {e}"))?;
    let mut mgr = load_crypto_manager(&passphrase, &data_dir)?;
    let session = mgr.get_or_create_group_session(&channel_id, &dist.sender_id);
    session.process_distribution(&dist);
    save_crypto_manager(&mgr, &passphrase, &data_dir)
}

#[tauri::command]
fn get_sender_key_distribution(
    channel_id: String,
    passphrase: String,
    data_dir: String,
) -> Result<String, String> {
    let mut mgr = load_crypto_manager(&passphrase, &data_dir)?;
    let kp = KeyPair::load_encrypted(&keypair_path(&data_dir), &passphrase)?;
    let our_id = B64.encode(kp.export_public_key());
    let session = mgr.get_or_create_group_session(&channel_id, &our_id);
    let dist = session.create_distribution_message();
    save_crypto_manager(&mgr, &passphrase, &data_dir)?;
    serde_json::to_string(&dist).map_err(|e| e.to_string())
}

// ─── Phase 4: Server-Hosted Passkey Commands ──────────────────────────────────

#[derive(serde::Serialize)]
struct BridgeRegisterResult {
    public_key: String,
    recovery_key: String,
    derived_key: String,
}

#[tauri::command]
async fn passkey_register_via_browser(
    window: tauri::Window,
    server_url: String,
    username: Option<String>,
    data_dir: String,
) -> Result<BridgeRegisterResult, String> {
    let passkey_username = username.unwrap_or_else(|| "dilla-user".to_string());
    let prf_salt = keystore::generate_prf_salt();
    let recovery_key_bytes = keystore::generate_recovery_key();
    let prf_salt_b64 = B64.encode(&prf_salt);
    let recovery_key_b64 = B64.encode(recovery_key_bytes);

    // Start callback-only listener
    let session = auth_server::start_callback_listener()?;

    // Build URL on the remote server
    let url = auth_server::build_register_url(
        &server_url,
        session.callback_port,
        &session.nonce,
        &passkey_username,
        &prf_salt_b64,
    );

    // Keep app window accessible while browser is open
    open::that(&url).map_err(|e| format!("Failed to open browser: {e}"))?;

    // Wait on a blocking thread so the UI stays responsive
    let result = tokio::task::spawn_blocking(move || {
        auth_server::parse_register_result(&session)
    }).await.map_err(|e| format!("Task failed: {e}"))??;

    let _ = window.set_focus();

    let prf_bytes = B64.decode(&result.prf_output)
        .map_err(|e| format!("Invalid PRF output: {e}"))?;
    let prf_key: [u8; 32] = prf_bytes.try_into()
        .map_err(|_| "PRF output must be 32 bytes")?;

    let kp = KeyPair::generate_keypair();
    let path = keypair_path(&data_dir);

    let credential = PasskeyCredential {
        id: result.credential_id,
        name: result.credential_name,
        created_at: {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            format!("{now}")
        },
    };

    kp.save_v3(
        &path,
        &server_url,
        &prf_key,
        &prf_salt,
        vec![credential],
        Some(&recovery_key_bytes),
    )?;

    let pub_key_b64 = B64.encode(kp.export_public_key());

    Ok(BridgeRegisterResult {
        public_key: pub_key_b64,
        recovery_key: recovery_key_b64,
        derived_key: result.prf_output,
    })
}

#[tauri::command]
async fn passkey_login_via_browser(
    window: tauri::Window,
    server_url: String,
    data_dir: String,
) -> Result<String, String> {
    let path = keypair_path(&data_dir);
    let version = keystore::detect_key_version(&path)?;

    // Read credentials based on version
    let (credentials, prf_salt) = if version >= 3 {
        keystore::read_credentials_v3(&path)?
    } else {
        keystore::read_credentials(&path)?
    };
    let credential_ids: Vec<String> = credentials.iter().map(|c| c.id.clone()).collect();
    let prf_salt_b64 = B64.encode(&prf_salt);

    if credential_ids.is_empty() {
        return Err("No passkey credentials found in identity file".into());
    }

    // Start callback-only listener
    let session = auth_server::start_callback_listener()?;

    // Build URL on the remote server
    let url = auth_server::build_login_url(
        &server_url,
        session.callback_port,
        &session.nonce,
        &prf_salt_b64,
        &credential_ids,
    );

    open::that(&url).map_err(|e| format!("Failed to open browser: {e}"))?;

    // Wait on a blocking thread so the UI stays responsive
    let result = tokio::task::spawn_blocking(move || {
        auth_server::parse_login_result(&session)
    }).await.map_err(|e| format!("Task failed: {e}"))??;

    let _ = window.set_focus();

    let prf_bytes = B64.decode(&result.prf_output)
        .map_err(|e| format!("Invalid PRF output: {e}"))?;
    let prf_key: [u8; 32] = prf_bytes.try_into()
        .map_err(|_| "PRF output must be 32 bytes")?;

    // Load keypair based on version (V3 tries all key slots)
    if version >= 3 {
        let _kp = KeyPair::load_v3_with_prf(&path, &prf_key)?;
    } else {
        let _kp = KeyPair::load_with_raw_key(&path, &prf_key)?;
        // Auto-migrate V2 → V3
        keystore::migrate_v2_to_v3(&path, &prf_key, &server_url)?;
    }

    Ok(result.prf_output)
}

/// Register a new passkey on an additional server, adding a key slot to the V3 identity file.
/// Requires the current derived key (from an existing passkey) to unwrap MEK.
#[tauri::command]
async fn add_server_passkey(
    window: tauri::Window,
    server_url: String,
    existing_derived_key_b64: String,
    data_dir: String,
) -> Result<(), String> {
    let existing_key = decode_key_b64(&existing_derived_key_b64)?;
    let path = keypair_path(&data_dir);
    let version = keystore::detect_key_version(&path)?;
    if version < 3 {
        return Err("Identity must be V3 format. Please login first to auto-migrate.".into());
    }

    let prf_salt = keystore::generate_prf_salt();
    let prf_salt_b64 = B64.encode(&prf_salt);

    // Start callback-only listener
    let session = auth_server::start_callback_listener()?;

    // Build register URL on the new server
    let url = auth_server::build_register_url(
        &server_url,
        session.callback_port,
        &session.nonce,
        "dilla-user",
        &prf_salt_b64,
    );

    open::that(&url).map_err(|e| format!("Failed to open browser: {e}"))?;

    let result = tokio::task::spawn_blocking(move || {
        auth_server::parse_register_result(&session)
    }).await.map_err(|e| format!("Task failed: {e}"))??;

    let _ = window.set_focus();

    let prf_bytes = B64.decode(&result.prf_output)
        .map_err(|e| format!("Invalid PRF output: {e}"))?;
    let new_prf_key: [u8; 32] = prf_bytes.try_into()
        .map_err(|_| "PRF output must be 32 bytes")?;

    let credential = PasskeyCredential {
        id: result.credential_id,
        name: result.credential_name,
        created_at: {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            format!("{now}")
        },
    };

    keystore::add_key_slot(
        &path,
        &existing_key,
        &server_url,
        &new_prf_key,
        &prf_salt,
        vec![credential],
    )?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            generate_keypair,
            load_keypair,
            sign_challenge,
            has_keypair,
            get_public_key,
            // V2: Passkey/PRF-based
            generate_keypair_with_key,
            load_keypair_with_key,
            load_keypair_with_recovery,
            sign_challenge_with_key,
            get_credential_info,
            generate_recovery_key_cmd,
            regenerate_recovery_key,
            generate_prf_salt_cmd,
            // E2E Encryption
            generate_prekey_bundle_cmd,
            init_session_with_bundle,
            encrypt_message,
            decrypt_message,
            get_safety_number,
            process_sender_key,
            get_sender_key_distribution,
            // Browser bridge passkey
            passkey_register_via_browser,
            passkey_login_via_browser,
            add_server_passkey,
            // Identity blob escrow
            upload_identity_blob,
            recover_identity_from_server,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
