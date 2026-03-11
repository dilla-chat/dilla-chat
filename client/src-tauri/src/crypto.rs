//! E2E Encryption module (Signal Protocol)
//! Phase 3: X3DH key agreement, Double Ratchet, Sender Keys

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use hmac::digest::KeyInit as HmacKeyInit;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

type HmacSha256 = Hmac<Sha256>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Derive an X25519 StaticSecret from an Ed25519 SigningKey.
/// We hash the Ed25519 secret scalar with SHA-256 and clamp the result.
fn ed25519_signing_to_x25519_secret(sk: &SigningKey) -> StaticSecret {
    let hash = <sha2::Sha256 as sha2::Digest>::digest(sk.to_bytes());
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&hash);
    // clamp per X25519
    secret[0] &= 248;
    secret[31] &= 127;
    secret[31] |= 64;
    StaticSecret::from(secret)
}

/// Derive the corresponding X25519 public key for an Ed25519 identity.
fn ed25519_signing_to_x25519_public(sk: &SigningKey) -> X25519PublicKey {
    let secret = ed25519_signing_to_x25519_secret(sk);
    X25519PublicKey::from(&secret)
}

/// Derive X25519 public key from an Ed25519 *verifying* (public) key bytes.
/// We use the birational map approach: store the X25519 public alongside identity
/// in the prekey bundle (identity_dh_key field). For received bundles where we
/// only have the Ed25519 public key, the sender must include the DH public key.
fn hkdf_derive(ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut okm = vec![0u8; len];
    hk.expand(info, &mut okm)
        .expect("HKDF expand should not fail for valid length");
    okm
}

/// KDF for the root chain: input_key_material from DH, chain_key from previous root.
fn kdf_root(root_key: &[u8], dh_output: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let hk = Hkdf::<Sha256>::new(Some(root_key), dh_output);
    let mut new_root = [0u8; 32];
    let mut chain_key = [0u8; 32];
    hk.expand(b"SlimcordRootKey", &mut new_root)
        .expect("HKDF root expand fail");
    hk.expand(b"SlimcordChainKey", &mut chain_key)
        .expect("HKDF chain expand fail");
    (new_root.to_vec(), chain_key.to_vec())
}

/// KDF for the sending/receiving chain: derive message key + next chain key
fn kdf_chain(chain_key: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut mac: HmacSha256 =
        <HmacSha256 as HmacKeyInit>::new_from_slice(chain_key).expect("HMAC key length should be valid");
    mac.update(&[0x01]);
    let message_key = mac.finalize().into_bytes().to_vec();

    let mut mac2: HmacSha256 =
        <HmacSha256 as HmacKeyInit>::new_from_slice(chain_key).expect("HMAC key length should be valid");
    mac2.update(&[0x02]);
    let next_chain_key = mac2.finalize().into_bytes().to_vec();

    (next_chain_key, message_key)
}

fn aes_gcm_encrypt(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("AES key error: {e}"))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("AES encrypt error: {e}"))?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    Ok(out)
}

fn aes_gcm_decrypt(key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 {
        return Err("Ciphertext too short".into());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("AES key error: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES decrypt error: {e}"))
}

// ─── Prekey Bundle ────────────────────────────────────────────────────────────

/// Prekey bundle uploaded to the server (public parts only)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrekeyBundle {
    pub identity_key: Vec<u8>,
    pub identity_dh_key: Vec<u8>,
    pub signed_prekey: Vec<u8>,
    pub signed_prekey_signature: Vec<u8>,
    pub one_time_prekeys: Vec<Vec<u8>>,
}

/// Private parts of the prekey bundle, stored locally
#[derive(Serialize, Deserialize, Clone)]
pub struct PrekeySecrets {
    pub signed_prekey_secret: Vec<u8>,
    pub one_time_prekey_secrets: Vec<Vec<u8>>,
}

impl PrekeySecrets {
    pub fn signed_prekey_static_secret(&self) -> StaticSecret {
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&self.signed_prekey_secret);
        StaticSecret::from(arr)
    }

    pub fn one_time_prekey_static_secret(&self, index: usize) -> Option<StaticSecret> {
        self.one_time_prekey_secrets.get(index).map(|bytes| {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(bytes);
            StaticSecret::from(arr)
        })
    }
}

pub fn generate_prekey_bundle(
    identity_key: &SigningKey,
    num_one_time_prekeys: usize,
) -> (PrekeyBundle, PrekeySecrets) {
    let identity_dh_public = ed25519_signing_to_x25519_public(identity_key);

    // Signed prekey
    let signed_prekey_secret = StaticSecret::random_from_rng(OsRng);
    let signed_prekey_public = X25519PublicKey::from(&signed_prekey_secret);
    let signature = identity_key.sign(signed_prekey_public.as_bytes());

    // One-time prekeys
    let mut otpk_secrets = Vec::with_capacity(num_one_time_prekeys);
    let mut otpk_publics = Vec::with_capacity(num_one_time_prekeys);
    for _ in 0..num_one_time_prekeys {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = X25519PublicKey::from(&secret);
        otpk_publics.push(public.as_bytes().to_vec());
        otpk_secrets.push(secret.to_bytes().to_vec());
    }

    let bundle = PrekeyBundle {
        identity_key: identity_key.verifying_key().to_bytes().to_vec(),
        identity_dh_key: identity_dh_public.as_bytes().to_vec(),
        signed_prekey: signed_prekey_public.as_bytes().to_vec(),
        signed_prekey_signature: signature.to_bytes().to_vec(),
        one_time_prekeys: otpk_publics,
    };

    let secrets = PrekeySecrets {
        signed_prekey_secret: signed_prekey_secret.to_bytes().to_vec(),
        one_time_prekey_secrets: otpk_secrets,
    };

    (bundle, secrets)
}

// ─── X3DH ─────────────────────────────────────────────────────────────────────

/// X3DH initiator: Alice starts a session with Bob.
/// Returns (shared_secret, ephemeral_public_key, one_time_prekey_index used).
pub fn x3dh_initiate(
    alice_identity: &SigningKey,
    bob_bundle: &PrekeyBundle,
) -> Result<(Vec<u8>, Vec<u8>, Option<usize>), String> {
    // Verify Bob's signed prekey signature
    let bob_verifying = VerifyingKey::from_bytes(
        bob_bundle
            .identity_key
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid Bob identity key length")?,
    )
    .map_err(|e| format!("Invalid Bob identity key: {e}"))?;

    let sig_bytes: [u8; 64] = bob_bundle
        .signed_prekey_signature
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid signature length")?;
    let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    bob_verifying
        .verify(&bob_bundle.signed_prekey, &sig)
        .map_err(|_| "Signed prekey signature verification failed")?;

    let alice_x25519_secret = ed25519_signing_to_x25519_secret(alice_identity);
    let ephemeral_secret = StaticSecret::random_from_rng(OsRng);
    let ephemeral_public = X25519PublicKey::from(&ephemeral_secret);

    let bob_signed_prekey = x25519_pub_from_bytes(&bob_bundle.signed_prekey)?;
    let bob_identity_dh = x25519_pub_from_bytes(&bob_bundle.identity_dh_key)?;

    // DH1: alice_identity × bob_signed_prekey
    let dh1 = alice_x25519_secret.diffie_hellman(&bob_signed_prekey);
    // DH2: alice_ephemeral × bob_identity_dh
    let dh2 = ephemeral_secret.diffie_hellman(&bob_identity_dh);
    // DH3: alice_ephemeral × bob_signed_prekey
    let dh3 = ephemeral_secret.diffie_hellman(&bob_signed_prekey);

    let mut ikm = Vec::with_capacity(128);
    ikm.extend_from_slice(dh1.as_bytes());
    ikm.extend_from_slice(dh2.as_bytes());
    ikm.extend_from_slice(dh3.as_bytes());

    let otpk_index = if !bob_bundle.one_time_prekeys.is_empty() {
        let idx = 0usize;
        let bob_otpk = x25519_pub_from_bytes(&bob_bundle.one_time_prekeys[idx])?;
        let dh4 = ephemeral_secret.diffie_hellman(&bob_otpk);
        ikm.extend_from_slice(dh4.as_bytes());
        Some(idx)
    } else {
        None
    };

    let shared_secret = hkdf_derive(&ikm, b"SlimcordX3DH", 32);
    Ok((shared_secret, ephemeral_public.as_bytes().to_vec(), otpk_index))
}

/// X3DH responder: Bob completes the handshake.
pub fn x3dh_respond(
    bob_identity: &SigningKey,
    bob_prekey_secrets: &PrekeySecrets,
    alice_identity_dh_key: &[u8],
    alice_ephemeral_key: &[u8],
    one_time_prekey_index: Option<usize>,
) -> Result<Vec<u8>, String> {
    let bob_x25519_secret = ed25519_signing_to_x25519_secret(bob_identity);
    let bob_signed_prekey_secret = bob_prekey_secrets.signed_prekey_static_secret();

    let alice_identity_dh = x25519_pub_from_bytes(alice_identity_dh_key)?;
    let alice_ephemeral = x25519_pub_from_bytes(alice_ephemeral_key)?;

    // DH1: bob_signed_prekey × alice_identity_dh
    let dh1 = bob_signed_prekey_secret.diffie_hellman(&alice_identity_dh);
    // DH2: bob_identity × alice_ephemeral
    let dh2 = bob_x25519_secret.diffie_hellman(&alice_ephemeral);
    // DH3: bob_signed_prekey × alice_ephemeral
    let dh3 = bob_signed_prekey_secret.diffie_hellman(&alice_ephemeral);

    let mut ikm = Vec::with_capacity(128);
    ikm.extend_from_slice(dh1.as_bytes());
    ikm.extend_from_slice(dh2.as_bytes());
    ikm.extend_from_slice(dh3.as_bytes());

    if let Some(idx) = one_time_prekey_index {
        let otpk_secret = bob_prekey_secrets
            .one_time_prekey_static_secret(idx)
            .ok_or_else(|| format!("No one-time prekey at index {idx}"))?;
        let dh4 = otpk_secret.diffie_hellman(&alice_ephemeral);
        ikm.extend_from_slice(dh4.as_bytes());
    }

    let shared_secret = hkdf_derive(&ikm, b"SlimcordX3DH", 32);
    Ok(shared_secret)
}

fn x25519_pub_from_bytes(bytes: &[u8]) -> Result<X25519PublicKey, String> {
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Invalid X25519 public key length")?;
    Ok(X25519PublicKey::from(arr))
}

// ─── Double Ratchet ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MessageHeader {
    pub dh_public_key: Vec<u8>,
    pub previous_chain_length: u32,
    pub message_number: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RatchetMessage {
    pub header: MessageHeader,
    pub ciphertext: Vec<u8>,
}

/// Serializable wrapper for X25519 keypair
#[derive(Serialize, Deserialize, Clone)]
struct DhKeypair {
    secret: Vec<u8>,
    public_key: Vec<u8>,
}

impl DhKeypair {
    fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = X25519PublicKey::from(&secret);
        Self {
            secret: secret.to_bytes().to_vec(),
            public_key: public.as_bytes().to_vec(),
        }
    }

    fn static_secret(&self) -> StaticSecret {
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&self.secret);
        StaticSecret::from(arr)
    }

    fn x25519_public(&self) -> X25519PublicKey {
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&self.public_key);
        X25519PublicKey::from(arr)
    }
}

/// Serializable key for the skipped_keys map
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash)]
struct SkippedKey {
    dh_public: Vec<u8>,
    message_number: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RatchetSession {
    dh_sending: Option<DhKeypair>,
    dh_receiving_key: Option<Vec<u8>>,
    root_key: Vec<u8>,
    sending_chain_key: Option<Vec<u8>>,
    receiving_chain_key: Option<Vec<u8>>,
    sending_message_number: u32,
    receiving_message_number: u32,
    previous_sending_chain_length: u32,
    skipped_keys: HashMap<SkippedKey, Vec<u8>>,
}

const MAX_SKIP: u32 = 256;

impl RatchetSession {
    /// Initialize as Alice (initiator) after X3DH
    pub fn init_alice(shared_secret: &[u8], bob_signed_prekey: &[u8]) -> Result<Self, String> {
        let bob_pub = x25519_pub_from_bytes(bob_signed_prekey)?;
        let dh_pair = DhKeypair::generate();
        let dh_output = dh_pair.static_secret().diffie_hellman(&bob_pub);
        let (root_key, chain_key) = kdf_root(shared_secret, dh_output.as_bytes());

        Ok(Self {
            dh_sending: Some(dh_pair),
            dh_receiving_key: Some(bob_signed_prekey.to_vec()),
            root_key,
            sending_chain_key: Some(chain_key),
            receiving_chain_key: None,
            sending_message_number: 0,
            receiving_message_number: 0,
            previous_sending_chain_length: 0,
            skipped_keys: HashMap::new(),
        })
    }

    /// Initialize as Bob (responder) after X3DH
    pub fn init_bob(shared_secret: &[u8], bob_signed_prekey_secret: &[u8]) -> Result<Self, String> {
        let mut secret_arr = [0u8; 32];
        if bob_signed_prekey_secret.len() != 32 {
            return Err("Invalid signed prekey secret length".into());
        }
        secret_arr.copy_from_slice(bob_signed_prekey_secret);
        let ss = StaticSecret::from(secret_arr);
        let pub_key = X25519PublicKey::from(&ss);

        Ok(Self {
            dh_sending: Some(DhKeypair {
                secret: ss.to_bytes().to_vec(),
                public_key: pub_key.as_bytes().to_vec(),
            }),
            dh_receiving_key: None,
            root_key: shared_secret.to_vec(),
            sending_chain_key: None,
            receiving_chain_key: None,
            sending_message_number: 0,
            receiving_message_number: 0,
            previous_sending_chain_length: 0,
            skipped_keys: HashMap::new(),
        })
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<RatchetMessage, String> {
        let chain_key = self
            .sending_chain_key
            .as_ref()
            .ok_or("No sending chain key — session not fully initialized")?
            .clone();

        let (next_chain, message_key) = kdf_chain(&chain_key);
        self.sending_chain_key = Some(next_chain);

        let dh_sending = self
            .dh_sending
            .as_ref()
            .ok_or("No DH sending keypair")?;

        let header = MessageHeader {
            dh_public_key: dh_sending.public_key.clone(),
            previous_chain_length: self.previous_sending_chain_length,
            message_number: self.sending_message_number,
        };

        self.sending_message_number += 1;
        let ciphertext = aes_gcm_encrypt(&message_key, plaintext)?;

        Ok(RatchetMessage { header, ciphertext })
    }

    pub fn decrypt(&mut self, message: &RatchetMessage) -> Result<Vec<u8>, String> {
        // Check skipped keys first
        let sk = SkippedKey {
            dh_public: message.header.dh_public_key.clone(),
            message_number: message.header.message_number,
        };
        if let Some(mk) = self.skipped_keys.remove(&sk) {
            return aes_gcm_decrypt(&mk, &message.ciphertext);
        }

        // Check if we need a DH ratchet step
        let need_ratchet = match &self.dh_receiving_key {
            Some(k) => k != &message.header.dh_public_key,
            None => true,
        };

        if need_ratchet {
            // Skip any remaining messages in the old receiving chain
            if self.receiving_chain_key.is_some() {
                self.skip_message_keys(message.header.previous_chain_length)?;
            }
            self.dh_ratchet(&message.header.dh_public_key)?;
        }

        self.skip_message_keys(message.header.message_number)?;

        let chain_key = self
            .receiving_chain_key
            .as_ref()
            .ok_or("No receiving chain key")?
            .clone();
        let (next_chain, message_key) = kdf_chain(&chain_key);
        self.receiving_chain_key = Some(next_chain);
        self.receiving_message_number += 1;

        aes_gcm_decrypt(&message_key, &message.ciphertext)
    }

    fn skip_message_keys(&mut self, until: u32) -> Result<(), String> {
        if self.receiving_message_number > until {
            return Ok(());
        }
        if until - self.receiving_message_number > MAX_SKIP {
            return Err("Too many skipped messages".into());
        }
        if let Some(chain_key) = self.receiving_chain_key.clone() {
            let mut ck = chain_key;
            while self.receiving_message_number < until {
                let (next_chain, message_key) = kdf_chain(&ck);
                let sk = SkippedKey {
                    dh_public: self
                        .dh_receiving_key
                        .clone()
                        .unwrap_or_default(),
                    message_number: self.receiving_message_number,
                };
                self.skipped_keys.insert(sk, message_key);
                ck = next_chain;
                self.receiving_message_number += 1;
            }
            self.receiving_chain_key = Some(ck);
        }
        Ok(())
    }

    fn dh_ratchet(&mut self, new_remote_key: &[u8]) -> Result<(), String> {
        self.previous_sending_chain_length = self.sending_message_number;
        self.sending_message_number = 0;
        self.receiving_message_number = 0;
        self.dh_receiving_key = Some(new_remote_key.to_vec());

        let remote_pub = x25519_pub_from_bytes(new_remote_key)?;

        // Receiving chain
        let dh_sending = self.dh_sending.as_ref().ok_or("No DH sending keypair")?;
        let dh_output = dh_sending.static_secret().diffie_hellman(&remote_pub);
        let (new_root, recv_chain) = kdf_root(&self.root_key, dh_output.as_bytes());
        self.root_key = new_root;
        self.receiving_chain_key = Some(recv_chain);

        // New sending keypair
        let new_dh = DhKeypair::generate();
        let dh_output2 = new_dh.static_secret().diffie_hellman(&remote_pub);
        let (new_root2, send_chain) = kdf_root(&self.root_key, dh_output2.as_bytes());
        self.root_key = new_root2;
        self.sending_chain_key = Some(send_chain);
        self.dh_sending = Some(new_dh);

        Ok(())
    }
}

// ─── Sender Keys (Group Encryption) ──────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct SenderKeyState {
    pub sender_id: String,
    pub chain_key: Vec<u8>,
    pub signing_key: Vec<u8>,
    pub signing_public_key: Vec<u8>,
    pub message_number: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SenderKeyDistribution {
    pub sender_id: String,
    pub chain_key: Vec<u8>,
    pub signing_public_key: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GroupMessage {
    pub sender_id: String,
    pub ciphertext: Vec<u8>,
    pub message_number: u32,
    pub signature: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct GroupSession {
    pub channel_id: String,
    pub my_sender_key: SenderKeyState,
    pub member_sender_keys: HashMap<String, SenderKeyState>,
}

impl GroupSession {
    pub fn new(channel_id: &str, sender_id: &str) -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let signing_public = signing_key.verifying_key();
        let mut chain_key = [0u8; 32];
        OsRng.fill_bytes(&mut chain_key);

        Self {
            channel_id: channel_id.to_string(),
            my_sender_key: SenderKeyState {
                sender_id: sender_id.to_string(),
                chain_key: chain_key.to_vec(),
                signing_key: signing_key.to_bytes().to_vec(),
                signing_public_key: signing_public.to_bytes().to_vec(),
                message_number: 0,
            },
            member_sender_keys: HashMap::new(),
        }
    }

    pub fn create_distribution_message(&self) -> SenderKeyDistribution {
        SenderKeyDistribution {
            sender_id: self.my_sender_key.sender_id.clone(),
            chain_key: self.my_sender_key.chain_key.clone(),
            signing_public_key: self.my_sender_key.signing_public_key.clone(),
        }
    }

    pub fn process_distribution(&mut self, distribution: &SenderKeyDistribution) {
        let state = SenderKeyState {
            sender_id: distribution.sender_id.clone(),
            chain_key: distribution.chain_key.clone(),
            signing_key: Vec::new(),
            signing_public_key: distribution.signing_public_key.clone(),
            message_number: 0,
        };
        self.member_sender_keys
            .insert(distribution.sender_id.clone(), state);
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<GroupMessage, String> {
        let (next_chain, message_key) = kdf_chain(&self.my_sender_key.chain_key);
        self.my_sender_key.chain_key = next_chain;

        let ciphertext = aes_gcm_encrypt(&message_key, plaintext)?;

        let sk_bytes: [u8; 32] = self
            .my_sender_key
            .signing_key
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid signing key length")?;
        let sk = SigningKey::from_bytes(&sk_bytes);
        let signature = sk.sign(&ciphertext);

        let msg = GroupMessage {
            sender_id: self.my_sender_key.sender_id.clone(),
            ciphertext,
            message_number: self.my_sender_key.message_number,
            signature: signature.to_bytes().to_vec(),
        };
        self.my_sender_key.message_number += 1;

        Ok(msg)
    }

    pub fn decrypt(&mut self, message: &GroupMessage) -> Result<Vec<u8>, String> {
        let state = self
            .member_sender_keys
            .get_mut(&message.sender_id)
            .ok_or_else(|| format!("No sender key for {}", message.sender_id))?;

        // Verify signature
        let vk_bytes: [u8; 32] = state
            .signing_public_key
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid signing public key length")?;
        let vk =
            VerifyingKey::from_bytes(&vk_bytes).map_err(|e| format!("Invalid verifying key: {e}"))?;
        let sig_bytes: [u8; 64] = message
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| "Invalid signature length")?;
        let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
        vk.verify(&message.ciphertext, &sig)
            .map_err(|_| "Group message signature verification failed")?;

        // Advance chain to the correct message number
        while state.message_number < message.message_number {
            let (next_chain, _) = kdf_chain(&state.chain_key);
            state.chain_key = next_chain;
            state.message_number += 1;
        }

        let (next_chain, message_key) = kdf_chain(&state.chain_key);
        state.chain_key = next_chain;
        state.message_number += 1;

        aes_gcm_decrypt(&message_key, &message.ciphertext)
    }
}

// ─── Safety Numbers ───────────────────────────────────────────────────────────

pub fn generate_safety_number(
    our_identity_key: &[u8],
    our_id: &str,
    their_identity_key: &[u8],
    their_id: &str,
) -> String {
    fn fingerprint(identity_key: &[u8], stable_id: &str) -> Vec<u8> {
        use sha2::Digest;
        let mut result = Vec::new();
        let mut data = Vec::new();
        data.extend_from_slice(b"SlimcordFingerprint");
        data.extend_from_slice(identity_key);
        data.extend_from_slice(stable_id.as_bytes());
        // Iterate hash 5200 times as Signal does
        for _ in 0..5200 {
            let mut hasher = Sha256::new();
            hasher.update(&data);
            hasher.update(identity_key);
            data = hasher.finalize().to_vec();
        }
        result.extend_from_slice(&data);
        result
    }

    let our_fp = fingerprint(our_identity_key, our_id);
    let their_fp = fingerprint(their_identity_key, their_id);

    // Combine in deterministic order (lower id first)
    let (first, second) = if our_id < their_id {
        (&our_fp, &their_fp)
    } else {
        (&their_fp, &our_fp)
    };

    // Generate 60-digit numeric string from the fingerprints
    let mut digits = String::new();
    for chunk_idx in 0..12 {
        let fp = if chunk_idx < 6 { first } else { second };
        let offset = (chunk_idx % 6) * 5;
        if offset + 5 <= fp.len() {
            let bytes = &fp[offset..offset + 5];
            let num = u64::from_be_bytes([0, 0, 0, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]])
                % 100000;
            digits.push_str(&format!("{num:05}"));
        }
    }

    digits
}

// ─── Crypto Manager ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct CryptoManager {
    prekey_secrets: Option<PrekeySecrets>,
    pairwise_sessions: HashMap<String, RatchetSession>,
    group_sessions: HashMap<String, GroupSession>,
    #[serde(skip)]
    identity_key: Option<SigningKey>,
}

/// Serialized form for saving to disk
#[derive(Serialize, Deserialize)]
struct CryptoManagerSerialized {
    prekey_secrets: Option<PrekeySecrets>,
    pairwise_sessions: HashMap<String, RatchetSession>,
    group_sessions: HashMap<String, GroupSession>,
}

impl CryptoManager {
    pub fn new(identity_key: SigningKey) -> Self {
        Self {
            prekey_secrets: None,
            pairwise_sessions: HashMap::new(),
            group_sessions: HashMap::new(),
            identity_key: Some(identity_key),
        }
    }

    pub fn identity_key(&self) -> Result<&SigningKey, String> {
        self.identity_key
            .as_ref()
            .ok_or_else(|| "Identity key not set".into())
    }

    pub fn set_prekey_secrets(&mut self, secrets: PrekeySecrets) {
        self.prekey_secrets = Some(secrets);
    }

    pub fn get_or_create_session(
        &mut self,
        peer_id: &str,
        peer_bundle: &PrekeyBundle,
    ) -> Result<&mut RatchetSession, String> {
        if !self.pairwise_sessions.contains_key(peer_id) {
            let ik = self.identity_key()?.clone();
            let (shared_secret, _ephemeral_pub, _otpk_idx) = x3dh_initiate(&ik, peer_bundle)?;
            let session = RatchetSession::init_alice(&shared_secret, &peer_bundle.signed_prekey)?;
            self.pairwise_sessions.insert(peer_id.to_string(), session);
        }
        Ok(self.pairwise_sessions.get_mut(peer_id).unwrap())
    }

    pub fn encrypt_dm(&mut self, peer_id: &str, plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let session = self
            .pairwise_sessions
            .get_mut(peer_id)
            .ok_or_else(|| format!("No session for peer {peer_id}"))?;
        let msg = session.encrypt(plaintext)?;
        serde_json::to_vec(&msg).map_err(|e| format!("Serialize error: {e}"))
    }

    pub fn decrypt_dm(&mut self, peer_id: &str, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        let session = self
            .pairwise_sessions
            .get_mut(peer_id)
            .ok_or_else(|| format!("No session for peer {peer_id}"))?;
        let msg: RatchetMessage =
            serde_json::from_slice(ciphertext).map_err(|e| format!("Deserialize error: {e}"))?;
        session.decrypt(&msg)
    }

    pub fn encrypt_channel(
        &mut self,
        channel_id: &str,
        plaintext: &[u8],
    ) -> Result<Vec<u8>, String> {
        let session = self
            .group_sessions
            .get_mut(channel_id)
            .ok_or_else(|| format!("No group session for channel {channel_id}"))?;
        let msg = session.encrypt(plaintext)?;
        serde_json::to_vec(&msg).map_err(|e| format!("Serialize error: {e}"))
    }

    pub fn decrypt_channel(
        &mut self,
        channel_id: &str,
        _sender_id: &str,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, String> {
        let session = self
            .group_sessions
            .get_mut(channel_id)
            .ok_or_else(|| format!("No group session for channel {channel_id}"))?;
        let msg: GroupMessage =
            serde_json::from_slice(ciphertext).map_err(|e| format!("Deserialize error: {e}"))?;
        session.decrypt(&msg)
    }

    pub fn get_or_create_group_session(
        &mut self,
        channel_id: &str,
        sender_id: &str,
    ) -> &mut GroupSession {
        if !self.group_sessions.contains_key(channel_id) {
            let gs = GroupSession::new(channel_id, sender_id);
            self.group_sessions.insert(channel_id.to_string(), gs);
        }
        self.group_sessions.get_mut(channel_id).unwrap()
    }

    pub fn save_sessions(&self, path: &PathBuf, passphrase: &str) -> Result<(), String> {
        let serialized = CryptoManagerSerialized {
            prekey_secrets: self.prekey_secrets.clone(),
            pairwise_sessions: self.pairwise_sessions.clone(),
            group_sessions: self.group_sessions.clone(),
        };
        let json =
            serde_json::to_vec(&serialized).map_err(|e| format!("Serialize error: {e}"))?;
        let encrypted = aes_gcm_encrypt(
            &passphrase_to_key(passphrase)?,
            &json,
        )?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(path, encrypted).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_sessions(
        path: &PathBuf,
        passphrase: &str,
        identity_key: SigningKey,
    ) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new(identity_key));
        }
        let data = fs::read(path).map_err(|e| format!("Read error: {e}"))?;
        let json = aes_gcm_decrypt(&passphrase_to_key(passphrase)?, &data)?;
        let serialized: CryptoManagerSerialized =
            serde_json::from_slice(&json).map_err(|e| format!("Deserialize error: {e}"))?;
        Ok(Self {
            prekey_secrets: serialized.prekey_secrets,
            pairwise_sessions: serialized.pairwise_sessions,
            group_sessions: serialized.group_sessions,
            identity_key: Some(identity_key),
        })
    }
}

/// Simple passphrase-to-key for session file encryption (uses HKDF, not Argon2, for speed)
fn passphrase_to_key(passphrase: &str) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(Some(b"SlimcordSessions"), passphrase.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"session-encryption", &mut key)
        .map_err(|e| format!("HKDF error: {e}"))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_x3dh_and_ratchet_roundtrip() {
        let alice_sk = SigningKey::generate(&mut OsRng);
        let bob_sk = SigningKey::generate(&mut OsRng);

        let (bundle, secrets) = generate_prekey_bundle(&bob_sk, 1);
        let (alice_shared, _eph_pub, otpk_idx) = x3dh_initiate(&alice_sk, &bundle).unwrap();

        let alice_identity_dh = ed25519_signing_to_x25519_public(&alice_sk);
        let bob_shared = x3dh_respond(
            &bob_sk,
            &secrets,
            alice_identity_dh.as_bytes(),
            &_eph_pub,
            otpk_idx,
        )
        .unwrap();

        assert_eq!(alice_shared, bob_shared);

        // Double Ratchet
        let mut alice_session =
            RatchetSession::init_alice(&alice_shared, &bundle.signed_prekey).unwrap();
        let mut bob_session =
            RatchetSession::init_bob(&bob_shared, &secrets.signed_prekey_secret).unwrap();

        let plaintext = b"Hello Bob!";
        let encrypted = alice_session.encrypt(plaintext).unwrap();
        let decrypted = bob_session.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);

        // Bob replies
        let reply = b"Hi Alice!";
        let encrypted2 = bob_session.encrypt(reply).unwrap();
        let decrypted2 = alice_session.decrypt(&encrypted2).unwrap();
        assert_eq!(decrypted2, reply);
    }

    #[test]
    fn test_group_session_roundtrip() {
        let mut alice_group = GroupSession::new("channel1", "alice");
        let mut bob_group = GroupSession::new("channel1", "bob");

        let alice_dist = alice_group.create_distribution_message();
        let bob_dist = bob_group.create_distribution_message();

        alice_group.process_distribution(&bob_dist);
        bob_group.process_distribution(&alice_dist);

        let plaintext = b"Hello group!";
        let encrypted = alice_group.encrypt(plaintext).unwrap();
        let decrypted = bob_group.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_safety_number() {
        let sn = generate_safety_number(b"key1_aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "alice", b"key2_bbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bob");
        assert_eq!(sn.len(), 60);
        assert!(sn.chars().all(|c| c.is_ascii_digit()));

        // Symmetric
        let sn2 = generate_safety_number(b"key2_bbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bob", b"key1_aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "alice");
        assert_eq!(sn, sn2);
    }
}
