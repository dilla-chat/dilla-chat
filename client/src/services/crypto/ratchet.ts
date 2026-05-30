// ─── Double Ratchet ───────────────────────────────────────────────────────────

import { bytesEqual, toBase64, fromBase64url } from './helpers';
import { generateX25519KeyPair, exportX25519PrivateKey, importX25519PrivateKey, x25519DH } from './x25519';
import { kdfRoot, kdfChain } from './hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';

/** X3DH bootstrap info, attached only to the FIRST message of a new
 *  session so the receiver can run x3dhRespond and derive the same
 *  initial shared secret as the sender's x3dhInitiate. Without this,
 *  the receiver has no way to construct a matching Bob-side session
 *  and decryption silently fails with `OperationError`. */
export interface X3DHBootstrap {
  identity_dh_key: number[];
  ephemeral_key: number[];
  one_time_prekey_index: number | null;
}

export interface MessageHeader {
  dh_public_key: number[];
  previous_chain_length: number;
  message_number: number;
  /** Present on the first message of a fresh Alice-initiated session;
   *  absent on subsequent messages and on Bob-side sends. */
  x3dh?: X3DHBootstrap;
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
  /** Set on Alice-side sessions until the first outbound message
   *  consumes it; attached to that message's header so the receiver
   *  can run x3dhRespond. Cleared after first encrypt(). */
  pendingBootstrap: X3DHBootstrap | null;
}

export const MAX_SKIP = 256;

export class RatchetSession {
  state: RatchetSessionState;

  constructor(state: RatchetSessionState) {
    this.state = state;
  }

  /** Initialize as Alice (initiator) after X3DH.
   *
   *  `bootstrap` is the X3DH handshake info that must be attached to
   *  the FIRST outbound message so the receiver can run x3dhRespond
   *  and derive the same initial shared secret. The session consumes
   *  it on the first encrypt() and clears it. */
  static async initAlice(
    sharedSecret: Uint8Array,
    bobSignedPrekey: Uint8Array,
    bootstrap: X3DHBootstrap | null = null,
  ): Promise<RatchetSession> {
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
      pendingBootstrap: bootstrap,
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
      pendingBootstrap: null,
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
    // Attach X3DH bootstrap on the first outbound message of an
    // Alice-initiated session, then clear it. The receiver uses it to
    // run x3dhRespond + initBob on demand without a pre-existing
    // session.
    if (this.state.pendingBootstrap) {
      header.x3dh = this.state.pendingBootstrap;
      this.state.pendingBootstrap = null;
    }
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
      pendingBootstrap: this.state.pendingBootstrap,
    };
  }

  /** Deserialize from storage */
  static fromJSON(obj: Record<string, unknown>): RatchetSession {
    const s = obj;
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
      pendingBootstrap: (s.pendingBootstrap as X3DHBootstrap | null | undefined) ?? null,
    });
  }
}
