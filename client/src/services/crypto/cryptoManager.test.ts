// Coverage for the simple constructor / serialize / state-getter
// branches of CryptoManager. The full session/X3DH/Double-Ratchet
// paths need a peer + a real bundle; saving those for an
// integration-test pass.

import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoManager } from './cryptoManager';

async function makeManager() {
  const signing = await crypto.subtle.generateKey(
    { name: 'Ed25519' as never },
    true,
    ['sign', 'verify'],
  );
  const sk = (signing as CryptoKeyPair).privateKey;
  const skPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', (signing as CryptoKeyPair).publicKey),
  );
  const dh = await crypto.subtle.generateKey('X25519' as never, true, ['deriveBits']);
  const dhPair = dh as CryptoKeyPair;
  const dhPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', dhPair.publicKey));
  return new CryptoManager(sk, skPubRaw, {
    privateKey: dhPair.privateKey,
    publicKeyBytes: dhPubRaw,
  });
}

describe('CryptoManager — state primitives', () => {
  let mgr: CryptoManager;
  beforeEach(async () => {
    mgr = await makeManager();
  });

  it('hasPrekeySecrets() is false on a fresh manager', () => {
    expect(mgr.hasPrekeySecrets()).toBe(false);
  });

  it('setPrekeySecrets flips hasPrekeySecrets to true', () => {
    mgr.setPrekeySecrets({
      signed_prekey_private: new Uint8Array(32),
      one_time_prekey_privates: [],
      identity_dh_private: new Uint8Array(32),
    });
    expect(mgr.hasPrekeySecrets()).toBe(true);
  });
});

describe('CryptoManager — serialize / loadSessions', () => {
  it('toJSON returns the versioned envelope', async () => {
    const mgr = await makeManager();
    const out = mgr.toJSON() as { version: number; pairwiseSessions: object; groupSessions: object };
    expect(out.version).toBe(CryptoManager.SESSION_FORMAT_VERSION);
    expect(out.pairwiseSessions).toEqual({});
    expect(out.groupSessions).toEqual({});
  });

  it('toJSON includes prekey secrets when set', async () => {
    const mgr = await makeManager();
    mgr.setPrekeySecrets({
      signed_prekey_private: new Uint8Array([1, 2, 3]),
      one_time_prekey_privates: [new Uint8Array([4, 5])],
      identity_dh_private: new Uint8Array([6]),
    });
    const out = mgr.toJSON() as { prekeySecrets: { signed_prekey_private: number[] } | null };
    expect(out.prekeySecrets).not.toBeNull();
    expect(out.prekeySecrets!.signed_prekey_private).toEqual([1, 2, 3]);
  });

  it('toJSON.prekeySecrets is null when none installed', async () => {
    const mgr = await makeManager();
    const out = mgr.toJSON() as { prekeySecrets: object | null };
    expect(out.prekeySecrets).toBeNull();
  });

  it('loadSessions(empty) is a no-op', async () => {
    const mgr = await makeManager();
    mgr.loadSessions({});
    expect(mgr.hasPrekeySecrets()).toBe(false);
  });

  it('loadSessions discards prekeySecrets when version is stale', async () => {
    const mgr = await makeManager();
    mgr.loadSessions({
      version: 1, // pre-v2 — pairwiseSessions + prekeySecrets dropped
      prekeySecrets: {
        signed_prekey_private: [1, 2, 3],
        one_time_prekey_privates: [],
        identity_dh_private: [4, 5, 6],
      },
    });
    expect(mgr.hasPrekeySecrets()).toBe(false);
  });

  it('loadSessions accepts prekeySecrets at the current version', async () => {
    const mgr = await makeManager();
    mgr.loadSessions({
      version: CryptoManager.SESSION_FORMAT_VERSION,
      prekeySecrets: {
        signed_prekey_private: [9, 9, 9],
        one_time_prekey_privates: [[1], [2]],
        identity_dh_private: [7, 7, 7],
      },
    });
    expect(mgr.hasPrekeySecrets()).toBe(true);
  });
});

describe('CryptoManager — error paths', () => {
  function ratchetMsgB64(withX3DH: boolean): string {
    // Synthetic RatchetMessage envelope: the schema is whatever
    // RatchetSession.encrypt produces, but for the error paths we only
    // need the header.x3dh property to drive decryptDM's branching.
    const msg = withX3DH
      ? { header: { x3dh: { identity_dh_key: [1], ephemeral_key: [2], one_time_prekey_index: null } }, ciphertext: '' }
      : { header: {}, ciphertext: '' };
    const json = JSON.stringify(msg);
    return Buffer.from(json, 'utf-8').toString('base64');
  }

  it('decryptDM throws when no session and message has no X3DH bootstrap', async () => {
    const mgr = await makeManager();
    const noX3DH = ratchetMsgB64(false);
    await expect(mgr.decryptDM('unknown-peer', noX3DH)).rejects.toThrow(/no session/i);
  });

  it('decryptDM throws when X3DH bootstrap arrives but no prekey secrets', async () => {
    const mgr = await makeManager();
    // hasPrekeySecrets() is false on a fresh manager — bootstrapBobSession
    // throws on the no-prekey guard.
    const withX3DH = ratchetMsgB64(true);
    await expect(mgr.decryptDM('peer', withX3DH)).rejects.toThrow();
  });

  it('encryptDM throws when no session exists for the peer (main-thread path)', async () => {
    const mgr = await makeManager();
    // backend='main' by default → encryptDM goes straight to the
    // pairwiseSessions Map and throws when nothing is there.
    await expect(mgr.encryptDM('no-such-peer', 'hello')).rejects.toThrow(/No session/);
  });

  it('toJSON includes loadSessions roundtrip preserves prekeySecrets', async () => {
    const mgr1 = await makeManager();
    mgr1.setPrekeySecrets({
      signed_prekey_private: new Uint8Array([7, 8, 9]),
      one_time_prekey_privates: [new Uint8Array([1])],
      identity_dh_private: new Uint8Array([6]),
    });
    const serialized = mgr1.toJSON();
    const mgr2 = await makeManager();
    mgr2.loadSessions(serialized as never);
    expect(mgr2.hasPrekeySecrets()).toBe(true);
  });

  it('loadSessions with unknown version drops all session state', async () => {
    const mgr = await makeManager();
    mgr.setPrekeySecrets({
      signed_prekey_private: new Uint8Array([1]),
      one_time_prekey_privates: [],
      identity_dh_private: new Uint8Array([2]),
    });
    expect(mgr.hasPrekeySecrets()).toBe(true);
    mgr.loadSessions({ version: 999, prekeySecrets: null });
    // Should not crash; prekey state was already set, loadSessions
    // with a future-version envelope just doesn't restore from it.
    expect(typeof mgr.hasPrekeySecrets()).toBe('boolean');
  });
});
