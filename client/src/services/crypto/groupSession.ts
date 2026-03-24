// ─── Sender Keys (Group Encryption) ──────────────────────────────────────────

import { randomBytes } from './helpers';
import { generateEd25519KeyPair, exportEd25519PrivateKey, importEd25519PrivateKey, importEd25519PublicKey, ed25519Sign, ed25519Verify } from './ed25519';
import { kdfChain } from './hkdf';
import { aesGcmEncrypt, aesGcmDecrypt } from './aesGcm';

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
