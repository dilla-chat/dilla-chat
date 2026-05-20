// ─── Sender Keys (Group Encryption) ──────────────────────────────────────────

import { randomBytes } from './helpers';
import { generateEd25519KeyPair, exportEd25519PrivateKey, importEd25519PrivateKey, importEd25519PublicKey, ed25519Sign, ed25519Verify } from './ed25519';
import { kdfChain } from './hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';

export interface SenderKeyDistribution {
  sender_id: string;
  chain_key: number[];
  signing_public_key: number[];
  /** The sender's chain position when this distribution was generated.
   *  Defaults to 0 for older clients that omit the field. Without this,
   *  a re-distribute after the sender has already encrypted N messages
   *  leaves the recipient out of sync — they'd advance their chain from
   *  0 to N+1 on the next message, overshooting by N steps and deriving
   *  a key that does not match the sender's. */
  message_number?: number;
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
      message_number: this.mySenderKey.messageNumber,
    };
  }

  processDistribution(distribution: SenderKeyDistribution): void {
    // Treat the sender's distribute as authoritative — always overwrite.
    // Previously this had a "skip if our messageNumber is already at or
    // past the incoming one" dedup, but that was a foot-gun: if our local
    // chain advanced past the sender's actual state (e.g. from a bug in
    // an earlier version of decrypt, or from corrupted persistence), we'd
    // refuse the *correct* fresh state and stay stuck. Loop prevention is
    // now done at the useChannelEvents echo layer via a distribute-payload
    // fingerprint, not here.
    this.memberSenderKeys.set(distribution.sender_id, {
      senderId: distribution.sender_id,
      chainKey: new Uint8Array(distribution.chain_key),
      signingPrivatePkcs8: null,
      signingPublicKey: new Uint8Array(distribution.signing_public_key),
      messageNumber: distribution.message_number ?? 0,
    });
  }

  /** Remove a member's sender key (e.g. when they leave or are kicked). */
  removeMember(senderId: string): void {
    this.memberSenderKeys.delete(senderId);
  }

  /** Rotate our own sender key — generates new chain key and signing key.
   *  Call this when a member leaves so they can't decrypt future messages. */
  async rotateMyKey(): Promise<void> {
    const signingKey = await generateEd25519KeyPair();
    const chainKey = randomBytes(32);
    const signingPrivatePkcs8 = await exportEd25519PrivateKey(signingKey.privateKey);

    this.mySenderKey = {
      senderId: this.mySenderKey.senderId,
      chainKey,
      signingPrivatePkcs8,
      signingPublicKey: signingKey.publicKeyBytes,
      messageNumber: 0,
    };

    // Update our own entry in memberSenderKeys for self-decryption
    this.memberSenderKeys.set(this.mySenderKey.senderId, {
      senderId: this.mySenderKey.senderId,
      chainKey: new Uint8Array(chainKey),
      signingPrivatePkcs8: null,
      signingPublicKey: new Uint8Array(signingKey.publicKeyBytes),
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

    // Reject messages whose chain position we've already moved past. A
    // simple sender-key chain has no out-of-order delivery support — old
    // message keys aren't retained. Returning here is critical: if we
    // tried to derive a key from the CURRENT chainKey and decrypt failed,
    // we'd still have mutated state forward by one kdf step, breaking
    // every legitimate future decrypt. (This was the bug behind the
    // "OperationError" cascade on eager-loaded history.)
    if (message.message_number < state.messageNumber) {
      throw new Error(
        `Message from chain position ${message.message_number} predates current state ${state.messageNumber}`,
      );
    }

    // Advance chain to correct message number
    const MAX_CHAIN_ADVANCE = 2000;
    if (message.message_number - state.messageNumber > MAX_CHAIN_ADVANCE) {
      throw new Error('Message gap too large — possible corruption or attack');
    }
    // Mutate to a *copy* of chainKey while advancing, then commit only on
    // a successful AES-GCM open. Without this, an auth failure (wrong key)
    // would still leave the chain advanced and desync us from the sender
    // forever.
    let workingChain = state.chainKey;
    for (let i = state.messageNumber; i < message.message_number; i++) {
      const [nextChain] = await kdfChain(workingChain);
      workingChain = nextChain;
    }

    const [nextChain, messageKey] = await kdfChain(workingChain);
    const plaintext = await aesGcmDecrypt(messageKey, new Uint8Array(message.ciphertext));
    // Decrypt succeeded — commit advanced state.
    state.chainKey = nextChain;
    state.messageNumber = message.message_number + 1;
    return plaintext;
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
