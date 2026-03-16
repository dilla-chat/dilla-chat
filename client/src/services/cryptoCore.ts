/**
 * cryptoCore.ts — Pure TypeScript implementation of Signal Protocol primitives
 *
 * Ported from src-tauri/src/crypto.rs — uses WebCrypto SubtleCrypto for all
 * cryptographic operations. Works identically in browsers and Tauri WebView.
 *
 * Implements:
 * - Ed25519 signing (via SubtleCrypto Ed25519)
 * - X25519 key agreement (via SubtleCrypto X25519)
 * - AES-256-GCM authenticated encryption
 * - HKDF-SHA256 key derivation
 * - HMAC-SHA256 chain key derivation
 * - X3DH key agreement protocol
 * - Double Ratchet algorithm
 * - Sender Keys (group encryption)
 * - Safety number generation
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function toBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Ed25519 ──────────────────────────────────────────────────────────────────

export interface Ed25519KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes: new Uint8Array(pubRaw),
  };
}

export async function ed25519Sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, data as unknown as BufferSource);
  return new Uint8Array(sig);
}

export async function ed25519Verify(
  publicKey: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify('Ed25519', publicKey, signature as unknown as BufferSource, data as unknown as BufferSource);
}

export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'Ed25519', true, ['verify']);
}

export async function exportEd25519PrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return new Uint8Array(pkcs8);
}

export async function importEd25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8 as unknown as BufferSource, 'Ed25519', true, ['sign']);
}

// ─── X25519 (ECDH) ───────────────────────────────────────────────────────────

export interface X25519KeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const keyPair = await crypto.subtle.generateKey('X25519', true, ['deriveBits']) as CryptoKeyPair;
  const pubRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes: new Uint8Array(pubRaw),
  };
}

export async function x25519DH(
  privateKey: CryptoKey,
  publicKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const pubKey = await crypto.subtle.importKey('raw', publicKeyBytes as unknown as BufferSource, 'X25519', false, []);
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: pubKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

export async function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as unknown as BufferSource, 'X25519', true, []);
}

export async function exportX25519PrivateKey(key: CryptoKey): Promise<Uint8Array> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return new Uint8Array(pkcs8);
}

export async function importX25519PrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pkcs8 as unknown as BufferSource, 'X25519', true, ['deriveBits']);
}

// ─── Ed25519 → X25519 conversion ─────────────────────────────────────────────
// The Rust code derives X25519 keys from Ed25519 by hashing + clamping.
// With WebCrypto we generate separate X25519 identity DH keys and include them
// in the prekey bundle (identity_dh_key field), avoiding the conversion entirely.
// This is actually more standard — Signal itself uses separate identity DH keys.

// ─── AES-256-GCM ─────────────────────────────────────────────────────────────

export async function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    cryptoKey,
    plaintext as unknown as BufferSource,
  );
  return concatBytes(nonce, new Uint8Array(ciphertext));
}

export async function aesGcmDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 12) throw new Error('Ciphertext too short');
  const nonce = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    cryptoKey,
    ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// ─── HKDF-SHA256 ─────────────────────────────────────────────────────────────

export async function hkdfDerive(
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
  salt?: Uint8Array,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw', ikm as unknown as BufferSource, 'HKDF', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: (salt || new Uint8Array(0)) as unknown as BufferSource,
      info: info as unknown as BufferSource,
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

// KDF for root chain: DH output + old root key → new root key + chain key
async function kdfRoot(rootKey: Uint8Array, dhOutput: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const baseKey = await crypto.subtle.importKey('raw', dhOutput as unknown as BufferSource, 'HKDF', false, ['deriveBits']);
  const newRoot = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: rootKey as unknown as BufferSource, info: encoder.encode('DillaRootKey') as unknown as BufferSource },
    baseKey, 256,
  ));
  const chainKey = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: rootKey as unknown as BufferSource, info: encoder.encode('DillaChainKey') as unknown as BufferSource },
    baseKey, 256,
  ));
  return [newRoot, chainKey];
}

// KDF for sending/receiving chain: chain key → next chain key + message key
async function kdfChain(chainKey: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const key = await crypto.subtle.importKey(
    'raw', chainKey as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const messageKey = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([0x01])));
  const nextChainKey = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([0x02])));
  return [nextChainKey, messageKey];
}

// ─── Prekey Bundle ────────────────────────────────────────────────────────────

export interface PrekeyBundle {
  identity_key: number[];        // Ed25519 public key
  identity_dh_key: number[];     // X25519 public key for DH
  signed_prekey: number[];       // X25519 public key, signed
  signed_prekey_signature: number[];
  one_time_prekeys: number[][];  // X25519 public keys
}

export interface PrekeySecrets {
  signed_prekey_private: Uint8Array;  // PKCS8 of X25519 private
  one_time_prekey_privates: Uint8Array[];
  identity_dh_private: Uint8Array;    // PKCS8 of identity X25519 DH key
}

export async function generatePrekeyBundle(
  identitySigningKey: CryptoKey,
  identityDhKeyPair: X25519KeyPair,
  numOneTimePrekeys: number,
): Promise<{ bundle: PrekeyBundle; secrets: PrekeySecrets }> {
  // Signed prekey
  const signedPrekey = await generateX25519KeyPair();
  const signature = await ed25519Sign(identitySigningKey, signedPrekey.publicKeyBytes);

  // One-time prekeys
  const otpkPairs: X25519KeyPair[] = [];
  for (let i = 0; i < numOneTimePrekeys; i++) {
    otpkPairs.push(await generateX25519KeyPair());
  }

  // Get identity public key from the signing key's JWK
  const jwk = await crypto.subtle.exportKey('jwk', identitySigningKey);
  const identityPubBytes = fromBase64url(jwk.x!);

  const bundle: PrekeyBundle = {
    identity_key: Array.from(identityPubBytes),
    identity_dh_key: Array.from(identityDhKeyPair.publicKeyBytes),
    signed_prekey: Array.from(signedPrekey.publicKeyBytes),
    signed_prekey_signature: Array.from(signature),
    one_time_prekeys: otpkPairs.map(kp => Array.from(kp.publicKeyBytes)),
  };

  const secrets: PrekeySecrets = {
    signed_prekey_private: await exportX25519PrivateKey(signedPrekey.privateKey),
    one_time_prekey_privates: await Promise.all(
      otpkPairs.map(kp => exportX25519PrivateKey(kp.privateKey)),
    ),
    identity_dh_private: await exportX25519PrivateKey(identityDhKeyPair.privateKey),
  };

  return { bundle, secrets };
}

function fromBase64url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  return fromBase64(pad ? b64 + '='.repeat(4 - pad) : b64);
}

// ─── X3DH ─────────────────────────────────────────────────────────────────────

export interface X3DHResult {
  sharedSecret: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  oneTimePreKeyIndex: number | null;
}

/**
 * X3DH initiator: Alice starts a session with Bob.
 */
export async function x3dhInitiate(
  aliceIdentityDhPrivate: CryptoKey,
  bobBundle: PrekeyBundle,
): Promise<X3DHResult> {
  // Verify Bob's signed prekey signature
  const bobVerifyKey = await importEd25519PublicKey(new Uint8Array(bobBundle.identity_key));
  const valid = await ed25519Verify(
    bobVerifyKey,
    new Uint8Array(bobBundle.signed_prekey_signature),
    new Uint8Array(bobBundle.signed_prekey),
  );
  if (!valid) throw new Error('Signed prekey signature verification failed');

  const ephemeral = await generateX25519KeyPair();
  const bobSignedPrekey = new Uint8Array(bobBundle.signed_prekey);
  const bobIdentityDh = new Uint8Array(bobBundle.identity_dh_key);

  // DH1: alice_identity × bob_signed_prekey
  const dh1 = await x25519DH(aliceIdentityDhPrivate, bobSignedPrekey);
  // DH2: alice_ephemeral × bob_identity_dh
  const dh2 = await x25519DH(ephemeral.privateKey, bobIdentityDh);
  // DH3: alice_ephemeral × bob_signed_prekey
  const dh3 = await x25519DH(ephemeral.privateKey, bobSignedPrekey);

  let ikm = concatBytes(dh1, dh2, dh3);
  let otpkIndex: number | null = null;

  if (bobBundle.one_time_prekeys.length > 0) {
    const bobOtpk = new Uint8Array(bobBundle.one_time_prekeys[0]);
    const dh4 = await x25519DH(ephemeral.privateKey, bobOtpk);
    ikm = concatBytes(ikm, dh4);
    otpkIndex = 0;
  }

  const sharedSecret = await hkdfDerive(ikm, encoder.encode('DillaX3DH'), 32);
  return { sharedSecret, ephemeralPublicKey: ephemeral.publicKeyBytes, oneTimePreKeyIndex: otpkIndex };
}

/**
 * X3DH responder: Bob completes the handshake.
 */
export async function x3dhRespond(
  bobIdentityDhPrivate: CryptoKey,
  bobSignedPrekeyPrivate: CryptoKey,
  aliceIdentityDhKey: Uint8Array,
  aliceEphemeralKey: Uint8Array,
  oneTimePrekeyPrivate: CryptoKey | null,
): Promise<Uint8Array> {
  // DH1: bob_signed_prekey × alice_identity_dh
  const dh1 = await x25519DH(bobSignedPrekeyPrivate, aliceIdentityDhKey);
  // DH2: bob_identity × alice_ephemeral
  const dh2 = await x25519DH(bobIdentityDhPrivate, aliceEphemeralKey);
  // DH3: bob_signed_prekey × alice_ephemeral
  const dh3 = await x25519DH(bobSignedPrekeyPrivate, aliceEphemeralKey);

  let ikm = concatBytes(dh1, dh2, dh3);

  if (oneTimePrekeyPrivate) {
    const dh4 = await x25519DH(oneTimePrekeyPrivate, aliceEphemeralKey);
    ikm = concatBytes(ikm, dh4);
  }

  return hkdfDerive(ikm, encoder.encode('DillaX3DH'), 32);
}

// ─── Double Ratchet ───────────────────────────────────────────────────────────

export interface MessageHeader {
  dh_public_key: number[];
  previous_chain_length: number;
  message_number: number;
}

export interface RatchetMessage {
  header: MessageHeader;
  ciphertext: number[];
}

interface DhKeypairSerialized {
  privatePkcs8: Uint8Array;
  publicKey: Uint8Array;
}

async function generateDhKeypair(): Promise<DhKeypairSerialized> {
  const kp = await generateX25519KeyPair();
  return {
    privatePkcs8: await exportX25519PrivateKey(kp.privateKey),
    publicKey: kp.publicKeyBytes,
  };
}

function skippedKeyId(dhPublic: Uint8Array, messageNumber: number): string {
  return toBase64(dhPublic) + ':' + messageNumber;
}

export interface RatchetSessionState {
  dhSending: DhKeypairSerialized | null;
  dhReceivingKey: Uint8Array | null;
  rootKey: Uint8Array;
  sendingChainKey: Uint8Array | null;
  receivingChainKey: Uint8Array | null;
  sendingMessageNumber: number;
  receivingMessageNumber: number;
  previousSendingChainLength: number;
  skippedKeys: Map<string, Uint8Array>;
}

const MAX_SKIP = 256;

export class RatchetSession {
  state: RatchetSessionState;

  constructor(state: RatchetSessionState) {
    this.state = state;
  }

  /** Initialize as Alice (initiator) after X3DH */
  static async initAlice(sharedSecret: Uint8Array, bobSignedPrekey: Uint8Array): Promise<RatchetSession> {
    const dhPair = await generateDhKeypair();
    const dhPriv = await importX25519PrivateKey(dhPair.privatePkcs8);
    const dhOutput = await x25519DH(dhPriv, bobSignedPrekey);
    const [rootKey, chainKey] = await kdfRoot(sharedSecret, dhOutput);

    return new RatchetSession({
      dhSending: dhPair,
      dhReceivingKey: bobSignedPrekey,
      rootKey,
      sendingChainKey: chainKey,
      receivingChainKey: null,
      sendingMessageNumber: 0,
      receivingMessageNumber: 0,
      previousSendingChainLength: 0,
      skippedKeys: new Map(),
    });
  }

  /** Initialize as Bob (responder) after X3DH */
  static async initBob(sharedSecret: Uint8Array, bobSignedPrekeyPkcs8: Uint8Array): Promise<RatchetSession> {
    const privKey = await importX25519PrivateKey(bobSignedPrekeyPkcs8);
    // WebCrypto doesn't directly give public from private for X25519.
    // Export JWK which contains both x (public) and d (private).
    const jwk = await crypto.subtle.exportKey('jwk', privKey);
    const publicKeyBytes = fromBase64url(jwk.x!);

    return new RatchetSession({
      dhSending: { privatePkcs8: bobSignedPrekeyPkcs8, publicKey: publicKeyBytes },
      dhReceivingKey: null,
      rootKey: sharedSecret,
      sendingChainKey: null,
      receivingChainKey: null,
      sendingMessageNumber: 0,
      receivingMessageNumber: 0,
      previousSendingChainLength: 0,
      skippedKeys: new Map(),
    });
  }

  async encrypt(plaintext: Uint8Array): Promise<RatchetMessage> {
    if (!this.state.sendingChainKey) {
      throw new Error('No sending chain key — session not fully initialized');
    }
    if (!this.state.dhSending) {
      throw new Error('No DH sending keypair');
    }

    const [nextChain, messageKey] = await kdfChain(this.state.sendingChainKey);
    this.state.sendingChainKey = nextChain;

    const header: MessageHeader = {
      dh_public_key: Array.from(this.state.dhSending.publicKey),
      previous_chain_length: this.state.previousSendingChainLength,
      message_number: this.state.sendingMessageNumber,
    };
    this.state.sendingMessageNumber++;

    const ciphertext = await aesGcmEncrypt(messageKey, plaintext);
    return { header, ciphertext: Array.from(ciphertext) };
  }

  async decrypt(message: RatchetMessage): Promise<Uint8Array> {
    const msgDhPub = new Uint8Array(message.header.dh_public_key);

    // Check skipped keys
    const skId = skippedKeyId(msgDhPub, message.header.message_number);
    const skippedMk = this.state.skippedKeys.get(skId);
    if (skippedMk) {
      this.state.skippedKeys.delete(skId);
      return aesGcmDecrypt(skippedMk, new Uint8Array(message.ciphertext));
    }

    // Check if DH ratchet needed
    const needRatchet = !this.state.dhReceivingKey || !bytesEqual(this.state.dhReceivingKey, msgDhPub);

    if (needRatchet) {
      if (this.state.receivingChainKey) {
        await this.skipMessageKeys(message.header.previous_chain_length);
      }
      await this.dhRatchet(msgDhPub);
    }

    await this.skipMessageKeys(message.header.message_number);

    if (!this.state.receivingChainKey) throw new Error('No receiving chain key');
    const [nextChain, messageKey] = await kdfChain(this.state.receivingChainKey);
    this.state.receivingChainKey = nextChain;
    this.state.receivingMessageNumber++;

    return aesGcmDecrypt(messageKey, new Uint8Array(message.ciphertext));
  }

  private async skipMessageKeys(until: number): Promise<void> {
    if (this.state.receivingMessageNumber > until) return;
    if (until - this.state.receivingMessageNumber > MAX_SKIP) {
      throw new Error('Too many skipped messages');
    }
    if (this.state.receivingChainKey) {
      let ck = this.state.receivingChainKey;
      while (this.state.receivingMessageNumber < until) {
        const [nextChain, messageKey] = await kdfChain(ck);
        const skId = skippedKeyId(
          this.state.dhReceivingKey || new Uint8Array(0),
          this.state.receivingMessageNumber,
        );
        this.state.skippedKeys.set(skId, messageKey);
        ck = nextChain;
        this.state.receivingMessageNumber++;
      }
      this.state.receivingChainKey = ck;
    }
  }

  private async dhRatchet(newRemoteKey: Uint8Array): Promise<void> {
    this.state.previousSendingChainLength = this.state.sendingMessageNumber;
    this.state.sendingMessageNumber = 0;
    this.state.receivingMessageNumber = 0;
    this.state.dhReceivingKey = newRemoteKey;

    // Receiving chain
    if (!this.state.dhSending) throw new Error('No DH sending keypair');
    const dhPriv = await importX25519PrivateKey(this.state.dhSending.privatePkcs8);
    const dhOutput = await x25519DH(dhPriv, newRemoteKey);
    const [newRoot, recvChain] = await kdfRoot(this.state.rootKey, dhOutput);
    this.state.rootKey = newRoot;
    this.state.receivingChainKey = recvChain;

    // New sending keypair
    const newDh = await generateDhKeypair();
    const newDhPriv = await importX25519PrivateKey(newDh.privatePkcs8);
    const dhOutput2 = await x25519DH(newDhPriv, newRemoteKey);
    const [newRoot2, sendChain] = await kdfRoot(this.state.rootKey, dhOutput2);
    this.state.rootKey = newRoot2;
    this.state.sendingChainKey = sendChain;
    this.state.dhSending = newDh;
  }

  /** Serialize for storage */
  toJSON(): object {
    return {
      ...this.state,
      dhSending: this.state.dhSending ? {
        privatePkcs8: Array.from(this.state.dhSending.privatePkcs8),
        publicKey: Array.from(this.state.dhSending.publicKey),
      } : null,
      dhReceivingKey: this.state.dhReceivingKey ? Array.from(this.state.dhReceivingKey) : null,
      rootKey: Array.from(this.state.rootKey),
      sendingChainKey: this.state.sendingChainKey ? Array.from(this.state.sendingChainKey) : null,
      receivingChainKey: this.state.receivingChainKey ? Array.from(this.state.receivingChainKey) : null,
      skippedKeys: Object.fromEntries(
        [...this.state.skippedKeys.entries()].map(([k, v]) => [k, Array.from(v)]),
      ),
    };
  }

  /** Deserialize from storage */
  static fromJSON(obj: Record<string, unknown>): RatchetSession {
    const s = obj as Record<string, unknown>;
    return new RatchetSession({
      dhSending: s.dhSending ? {
        privatePkcs8: new Uint8Array((s.dhSending as Record<string, number[]>).privatePkcs8),
        publicKey: new Uint8Array((s.dhSending as Record<string, number[]>).publicKey),
      } : null,
      dhReceivingKey: s.dhReceivingKey ? new Uint8Array(s.dhReceivingKey as number[]) : null,
      rootKey: new Uint8Array(s.rootKey as number[]),
      sendingChainKey: s.sendingChainKey ? new Uint8Array(s.sendingChainKey as number[]) : null,
      receivingChainKey: s.receivingChainKey ? new Uint8Array(s.receivingChainKey as number[]) : null,
      sendingMessageNumber: s.sendingMessageNumber as number,
      receivingMessageNumber: s.receivingMessageNumber as number,
      previousSendingChainLength: s.previousSendingChainLength as number,
      skippedKeys: new Map(
        Object.entries(s.skippedKeys as Record<string, number[]>).map(([k, v]) => [k, new Uint8Array(v)]),
      ),
    });
  }
}

// ─── Sender Keys (Group Encryption) ──────────────────────────────────────────

export interface SenderKeyDistribution {
  sender_id: string;
  chain_key: number[];
  signing_public_key: number[];
}

export interface GroupMessageData {
  sender_id: string;
  ciphertext: number[];
  message_number: number;
  signature: number[];
}

interface SenderKeyState {
  senderId: string;
  chainKey: Uint8Array;
  signingPrivatePkcs8: Uint8Array | null;  // Only for our own sender key
  signingPublicKey: Uint8Array;
  messageNumber: number;
}

export class GroupSession {
  channelId: string;
  mySenderKey: SenderKeyState;
  memberSenderKeys: Map<string, SenderKeyState> = new Map();

  private constructor(channelId: string, mySenderKey: SenderKeyState) {
    this.channelId = channelId;
    this.mySenderKey = mySenderKey;
  }

  static async create(channelId: string, senderId: string): Promise<GroupSession> {
    const signingKey = await generateEd25519KeyPair();
    const chainKey = randomBytes(32);
    const signingPrivatePkcs8 = await exportEd25519PrivateKey(signingKey.privateKey);

    const gs = new GroupSession(channelId, {
      senderId,
      chainKey,
      signingPrivatePkcs8,
      signingPublicKey: signingKey.publicKeyBytes,
      messageNumber: 0,
    });

    // Add a clone of our own sender key to memberSenderKeys so we can
    // decrypt our own messages when the server echoes them back.
    gs.memberSenderKeys.set(senderId, {
      senderId,
      chainKey: new Uint8Array(chainKey),
      signingPrivatePkcs8: null,
      signingPublicKey: new Uint8Array(signingKey.publicKeyBytes),
      messageNumber: 0,
    });

    return gs;
  }

  createDistributionMessage(): SenderKeyDistribution {
    return {
      sender_id: this.mySenderKey.senderId,
      chain_key: Array.from(this.mySenderKey.chainKey),
      signing_public_key: Array.from(this.mySenderKey.signingPublicKey),
    };
  }

  processDistribution(distribution: SenderKeyDistribution): void {
    this.memberSenderKeys.set(distribution.sender_id, {
      senderId: distribution.sender_id,
      chainKey: new Uint8Array(distribution.chain_key),
      signingPrivatePkcs8: null,
      signingPublicKey: new Uint8Array(distribution.signing_public_key),
      messageNumber: 0,
    });
  }

  async encrypt(plaintext: Uint8Array): Promise<GroupMessageData> {
    const [nextChain, messageKey] = await kdfChain(this.mySenderKey.chainKey);
    this.mySenderKey.chainKey = nextChain;

    const ciphertext = await aesGcmEncrypt(messageKey, plaintext);

    if (!this.mySenderKey.signingPrivatePkcs8) throw new Error('No signing key for own sender key');
    const signingKey = await importEd25519PrivateKey(this.mySenderKey.signingPrivatePkcs8);
    const signature = await ed25519Sign(signingKey, ciphertext);

    const msg: GroupMessageData = {
      sender_id: this.mySenderKey.senderId,
      ciphertext: Array.from(ciphertext),
      message_number: this.mySenderKey.messageNumber,
      signature: Array.from(signature),
    };
    this.mySenderKey.messageNumber++;
    return msg;
  }

  async decrypt(message: GroupMessageData): Promise<Uint8Array> {
    const state = this.memberSenderKeys.get(message.sender_id);
    if (!state) throw new Error(`No sender key for ${message.sender_id}`);

    // Verify signature
    const verifyKey = await importEd25519PublicKey(state.signingPublicKey);
    const valid = await ed25519Verify(
      verifyKey,
      new Uint8Array(message.signature),
      new Uint8Array(message.ciphertext),
    );
    if (!valid) throw new Error('Group message signature verification failed');

    // Advance chain to correct message number
    while (state.messageNumber < message.message_number) {
      const [nextChain] = await kdfChain(state.chainKey);
      state.chainKey = nextChain;
      state.messageNumber++;
    }

    const [nextChain, messageKey] = await kdfChain(state.chainKey);
    state.chainKey = nextChain;
    state.messageNumber++;

    return aesGcmDecrypt(messageKey, new Uint8Array(message.ciphertext));
  }

  /** Serialize for storage */
  toJSON(): object {
    const serializeState = (s: SenderKeyState) => ({
      senderId: s.senderId,
      chainKey: Array.from(s.chainKey),
      signingPrivatePkcs8: s.signingPrivatePkcs8 ? Array.from(s.signingPrivatePkcs8) : null,
      signingPublicKey: Array.from(s.signingPublicKey),
      messageNumber: s.messageNumber,
    });
    return {
      channelId: this.channelId,
      mySenderKey: serializeState(this.mySenderKey),
      memberSenderKeys: Object.fromEntries(
        [...this.memberSenderKeys.entries()].map(([k, v]) => [k, serializeState(v)]),
      ),
    };
  }

  static fromJSON(obj: Record<string, unknown>): GroupSession {
    const deserializeState = (s: Record<string, unknown>): SenderKeyState => ({
      senderId: s.senderId as string,
      chainKey: new Uint8Array(s.chainKey as number[]),
      signingPrivatePkcs8: s.signingPrivatePkcs8 ? new Uint8Array(s.signingPrivatePkcs8 as number[]) : null,
      signingPublicKey: new Uint8Array(s.signingPublicKey as number[]),
      messageNumber: s.messageNumber as number,
    });
    const gs = new GroupSession(
      obj.channelId as string,
      deserializeState(obj.mySenderKey as Record<string, unknown>),
    );
    const members = obj.memberSenderKeys as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(members)) {
      gs.memberSenderKeys.set(k, deserializeState(v));
    }
    return gs;
  }
}

// ─── Safety Numbers ───────────────────────────────────────────────────────────

export async function generateSafetyNumber(
  ourIdentityKey: Uint8Array,
  ourId: string,
  theirIdentityKey: Uint8Array,
  theirId: string,
): Promise<string> {
  async function fingerprint(identityKey: Uint8Array, stableId: string): Promise<Uint8Array> {
    let data = concatBytes(
      encoder.encode('DillaFingerprint'),
      identityKey,
      encoder.encode(stableId),
    );
    // Iterate hash 5200 times as Signal does
    for (let i = 0; i < 5200; i++) {
      const input = concatBytes(data, identityKey);
      data = new Uint8Array(await crypto.subtle.digest('SHA-256', input as unknown as BufferSource));
    }
    return data;
  }

  const ourFp = await fingerprint(ourIdentityKey, ourId);
  const theirFp = await fingerprint(theirIdentityKey, theirId);

  // Combine in deterministic order
  const [first, second] = ourId < theirId ? [ourFp, theirFp] : [theirFp, ourFp];

  let digits = '';
  for (let chunkIdx = 0; chunkIdx < 12; chunkIdx++) {
    const fp = chunkIdx < 6 ? first : second;
    const offset = (chunkIdx % 6) * 5;
    if (offset + 5 <= fp.length) {
      const bytes = fp.slice(offset, offset + 5);
      const num = (
        (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
      ) * 256 + bytes[4];
      // Same as Rust: u64::from_be_bytes % 100000
      digits += String(((num % 100000) + 100000) % 100000).padStart(5, '0');
    }
  }
  return digits;
}

// ─── Crypto Manager ───────────────────────────────────────────────────────────

export class CryptoManager {
  private identitySigningKey: CryptoKey;
  private identityPublicKeyBytes: Uint8Array;
  private identityDhKeyPair: { privateKey: CryptoKey; publicKeyBytes: Uint8Array };
  private prekeySecrets: PrekeySecrets | null = null;
  private pairwiseSessions: Map<string, RatchetSession> = new Map();
  private groupSessions: Map<string, GroupSession> = new Map();

  constructor(
    signingKey: CryptoKey,
    publicKeyBytes: Uint8Array,
    dhKeyPair: { privateKey: CryptoKey; publicKeyBytes: Uint8Array },
  ) {
    this.identitySigningKey = signingKey;
    this.identityPublicKeyBytes = publicKeyBytes;
    this.identityDhKeyPair = dhKeyPair;
  }

  setPrekeySecrets(secrets: PrekeySecrets): void {
    this.prekeySecrets = secrets;
  }

  async generatePrekeyBundle(numOneTimePrekeys = 10): Promise<PrekeyBundle> {
    const { bundle, secrets } = await generatePrekeyBundle(
      this.identitySigningKey,
      { privateKey: this.identityDhKeyPair.privateKey, publicKey: null as unknown as CryptoKey, publicKeyBytes: this.identityDhKeyPair.publicKeyBytes },
      numOneTimePrekeys,
    );
    this.prekeySecrets = secrets;
    return bundle;
  }

  async initSessionWithBundle(peerId: string, bundle: PrekeyBundle): Promise<void> {
    if (this.pairwiseSessions.has(peerId)) return;
    const { sharedSecret } = await x3dhInitiate(
      this.identityDhKeyPair.privateKey,
      bundle,
    );
    const session = await RatchetSession.initAlice(
      sharedSecret,
      new Uint8Array(bundle.signed_prekey),
    );
    this.pairwiseSessions.set(peerId, session);
  }

  async encryptDM(peerId: string, plaintext: string): Promise<string> {
    const session = this.pairwiseSessions.get(peerId);
    if (!session) throw new Error(`No session for peer ${peerId}`);
    const msg = await session.encrypt(encoder.encode(plaintext));
    return toBase64(encoder.encode(JSON.stringify(msg)));
  }

  async decryptDM(senderId: string, ciphertext: string): Promise<string> {
    const session = this.pairwiseSessions.get(senderId);
    if (!session) throw new Error(`No session for peer ${senderId}`);
    const msg: RatchetMessage = JSON.parse(decoder.decode(fromBase64(ciphertext)));
    const plaintext = await session.decrypt(msg);
    return decoder.decode(plaintext);
  }

  async getOrCreateGroupSession(channelId: string, senderId: string): Promise<GroupSession> {
    let session = this.groupSessions.get(channelId);
    if (!session) {
      session = await GroupSession.create(channelId, senderId);
      this.groupSessions.set(channelId, session);
    }
    return session;
  }

  async encryptChannel(channelId: string, senderId: string, plaintext: string): Promise<string> {
    const session = await this.getOrCreateGroupSession(channelId, senderId);
    const msg = await session.encrypt(encoder.encode(plaintext));
    return toBase64(encoder.encode(JSON.stringify(msg)));
  }

  async decryptChannel(channelId: string, _senderId: string, ciphertext: string): Promise<string> {
    const session = this.groupSessions.get(channelId);
    if (!session) throw new Error(`No group session for channel ${channelId}`);
    const msg: GroupMessageData = JSON.parse(decoder.decode(fromBase64(ciphertext)));
    const plaintext = await session.decrypt(msg);
    return decoder.decode(plaintext);
  }

  processSenderKey(channelId: string, distributionJson: string): void {
    const dist: SenderKeyDistribution = JSON.parse(distributionJson);
    const session = this.groupSessions.get(channelId);
    if (session) {
      session.processDistribution(dist);
    }
  }

  async getSenderKeyDistribution(channelId: string, senderId: string): Promise<string> {
    const session = await this.getOrCreateGroupSession(channelId, senderId);
    return JSON.stringify(session.createDistributionMessage());
  }

  async getSafetyNumber(peerId: string, peerPublicKey: Uint8Array): Promise<string> {
    return generateSafetyNumber(
      this.identityPublicKeyBytes,
      'self',
      peerPublicKey,
      peerId,
    );
  }

  /** Serialize all sessions for encrypted storage */
  toJSON(): object {
    return {
      pairwiseSessions: Object.fromEntries(
        [...this.pairwiseSessions.entries()].map(([k, v]) => [k, v.toJSON()]),
      ),
      groupSessions: Object.fromEntries(
        [...this.groupSessions.entries()].map(([k, v]) => [k, v.toJSON()]),
      ),
      prekeySecrets: this.prekeySecrets ? {
        signed_prekey_private: Array.from(this.prekeySecrets.signed_prekey_private),
        one_time_prekey_privates: this.prekeySecrets.one_time_prekey_privates.map(k => Array.from(k)),
        identity_dh_private: Array.from(this.prekeySecrets.identity_dh_private),
      } : null,
    };
  }

  /** Deserialize sessions from storage */
  loadSessions(data: Record<string, unknown>): void {
    const ps = data.pairwiseSessions as Record<string, Record<string, unknown>>;
    if (ps) {
      for (const [k, v] of Object.entries(ps)) {
        this.pairwiseSessions.set(k, RatchetSession.fromJSON(v));
      }
    }
    const gs = data.groupSessions as Record<string, Record<string, unknown>>;
    if (gs) {
      for (const [k, v] of Object.entries(gs)) {
        this.groupSessions.set(k, GroupSession.fromJSON(v));
      }
    }
    if (data.prekeySecrets) {
      const ps2 = data.prekeySecrets as Record<string, unknown>;
      this.prekeySecrets = {
        signed_prekey_private: new Uint8Array(ps2.signed_prekey_private as number[]),
        one_time_prekey_privates: (ps2.one_time_prekey_privates as number[][]).map(k => new Uint8Array(k)),
        identity_dh_private: new Uint8Array(ps2.identity_dh_private as number[]),
      };
    }
  }
}

// ─── Session Encryption (for persisting CryptoManager) ────────────────────────

export async function passphraseToKey(passphrase: string): Promise<Uint8Array> {
  return hkdfDerive(
    encoder.encode(passphrase),
    encoder.encode('session-encryption'),
    32,
    encoder.encode('DillaSessions'),
  );
}

export async function encryptSessionData(data: object, passphrase: string): Promise<Uint8Array> {
  const key = await passphraseToKey(passphrase);
  const json = encoder.encode(JSON.stringify(data));
  return aesGcmEncrypt(key, json);
}

export async function decryptSessionData(encrypted: Uint8Array, passphrase: string): Promise<object> {
  const key = await passphraseToKey(passphrase);
  const json = await aesGcmDecrypt(key, encrypted);
  return JSON.parse(decoder.decode(json));
}

// ─── Utility exports ─────────────────────────────────────────────────────────

export { toBase64, fromBase64, concatBytes, randomBytes, encoder, decoder };
