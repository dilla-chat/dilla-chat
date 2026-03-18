import { describe, it, expect, beforeEach } from 'vitest';
import {
  createIdentity,
  createIdentityWithPassphrase,
  unlockWithPrf,
  unlockWithPassphrase,
  unlockWithRecovery,
  hasIdentity,
  getPublicKey,
  getCredentialInfo,
  addKeySlot,
  deleteIdentity,
  exportIdentityBlob,
  importIdentityBlob,
  saveSessions,
  loadSessions,
  encodeRecoveryKey,
  decodeRecoveryKey,
  generatePrfSalt,
  generateRecoveryKey,
  signChallenge,
} from './keyStore';
import { randomBytes, ed25519Verify, importEd25519PublicKey } from './cryptoCore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCredential(name = 'test-passkey') {
  return [{ id: 'cred-1', name, created_at: '2024-01-01T00:00:00Z' }];
}

// ─── Clean state ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  // Clear IndexedDB between tests
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

// ─── Identity creation and unlock ─────────────────────────────────────────────

describe('createIdentity (PRF-based)', () => {
  it('creates an identity and stores it in IndexedDB', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const creds = makeCredential();

    const result = await createIdentity('https://example.com', prfKey, prfSalt, creds);

    expect(result.publicKeyB64).toBeTruthy();
    expect(result.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.recoveryKey.length).toBe(32);
    expect(result.identity.publicKeyBytes.length).toBe(32);
    expect(result.identity.signingKey).toBeDefined();
    expect(result.identity.dhKeyPair).toBeDefined();

    // Verify it was stored
    expect(await hasIdentity()).toBe(true);
  });

  it('getPublicKey returns the public key without unlocking', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const result = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const pubKey = await getPublicKey();
    expect(pubKey).not.toBeNull();
    expect(Array.from(pubKey!)).toEqual(Array.from(result.identity.publicKeyBytes));
  });
});

describe('unlockWithPrf', () => {
  it('unlocks identity with the correct PRF key', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const original = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const unlocked = await unlockWithPrf(prfKey);

    expect(unlocked.publicKeyBytes.length).toBe(32);
    expect(Array.from(unlocked.publicKeyBytes)).toEqual(Array.from(original.identity.publicKeyBytes));
    expect(unlocked.signingKey).toBeDefined();
    expect(unlocked.dhKeyPair).toBeDefined();
    expect(unlocked.dhKeyPair.publicKeyBytes.length).toBe(32);
  });

  it('fails with wrong PRF key', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const wrongKey = randomBytes(32);
    await expect(unlockWithPrf(wrongKey)).rejects.toThrow();
  });

  it('fails when no identity exists', async () => {
    const prfKey = randomBytes(32);
    await expect(unlockWithPrf(prfKey)).rejects.toThrow('No identity found');
  });
});

describe('unlockWithRecovery', () => {
  it('unlocks identity with the correct recovery key', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const { recoveryKey, identity: original } = await createIdentity(
      'https://example.com',
      prfKey,
      prfSalt,
      makeCredential(),
    );

    const unlocked = await unlockWithRecovery(recoveryKey);

    expect(Array.from(unlocked.publicKeyBytes)).toEqual(Array.from(original.publicKeyBytes));
  });

  it('fails with wrong recovery key', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const wrongKey = randomBytes(32);
    await expect(unlockWithRecovery(wrongKey)).rejects.toThrow('Invalid recovery key');
  });
});

// ─── Passphrase-based identity ────────────────────────────────────────────────

describe('createIdentityWithPassphrase / unlockWithPassphrase', () => {
  it('creates and unlocks identity with passphrase', async () => {
    const { identity: original } = await createIdentityWithPassphrase(
      'https://example.com',
      'my-strong-passphrase',
      makeCredential(),
    );

    const unlocked = await unlockWithPassphrase('my-strong-passphrase');
    expect(Array.from(unlocked.publicKeyBytes)).toEqual(Array.from(original.publicKeyBytes));
  });

  it('fails with wrong passphrase', async () => {
    await createIdentityWithPassphrase('https://example.com', 'correct', makeCredential());
    await expect(unlockWithPassphrase('wrong')).rejects.toThrow('Wrong passphrase');
  });

  it('passphrase identity also has recovery slot', async () => {
    const { recoveryKey } = await createIdentityWithPassphrase(
      'https://example.com',
      'pass123',
      makeCredential(),
    );

    const unlocked = await unlockWithRecovery(recoveryKey);
    expect(unlocked.publicKeyBytes.length).toBe(32);
  });

  it('fails when no password slots exist', async () => {
    // Create a PRF-based identity (no password slots)
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    await expect(unlockWithPassphrase('anything')).rejects.toThrow('No password slots');
  });
});

// ─── Key slot management ──────────────────────────────────────────────────────

describe('addKeySlot', () => {
  it('adds a new key slot to existing identity', async () => {
    const prfKey1 = randomBytes(32);
    const prfSalt1 = randomBytes(32);
    await createIdentity('https://server1.com', prfKey1, prfSalt1, makeCredential('passkey-1'));

    const prfKey2 = randomBytes(32);
    const prfSalt2 = randomBytes(32);
    await addKeySlot(prfKey1, 'https://server2.com', prfKey2, prfSalt2, makeCredential('passkey-2'));

    // Both keys should work
    const unlocked1 = await unlockWithPrf(prfKey1);
    expect(unlocked1.publicKeyBytes.length).toBe(32);

    const unlocked2 = await unlockWithPrf(prfKey2);
    expect(unlocked2.publicKeyBytes.length).toBe(32);

    // Same identity
    expect(Array.from(unlocked1.publicKeyBytes)).toEqual(Array.from(unlocked2.publicKeyBytes));
  });

  it('fails when existing key is wrong', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://server1.com', prfKey, prfSalt, makeCredential());

    const wrongKey = randomBytes(32);
    const newKey = randomBytes(32);
    const newSalt = randomBytes(32);
    await expect(
      addKeySlot(wrongKey, 'https://server2.com', newKey, newSalt, makeCredential()),
    ).rejects.toThrow();
  });
});

// ─── getCredentialInfo ────────────────────────────────────────────────────────

describe('getCredentialInfo', () => {
  it('returns null when no identity exists', async () => {
    const info = await getCredentialInfo();
    expect(info).toBeNull();
  });

  it('returns credential info for PRF-based identity', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential('my-key'));

    const info = await getCredentialInfo();
    expect(info).not.toBeNull();
    expect(info!.credentials.length).toBe(1);
    expect(info!.credentials[0].name).toBe('my-key');
    expect(info!.prfSalt.length).toBe(32);
    expect(info!.keySlots.length).toBe(1);
    expect(info!.hasPasswordSlots).toBe(false);
  });

  it('returns credential info for passphrase-based identity', async () => {
    await createIdentityWithPassphrase('https://example.com', 'pass', makeCredential('pw-key'));

    const info = await getCredentialInfo();
    expect(info).not.toBeNull();
    expect(info!.hasPasswordSlots).toBe(true);
    expect(info!.passwordSlots.length).toBe(1);
  });
});

// ─── Export/import identity blob ─────────────────────────────────────────────

describe('exportIdentityBlob / importIdentityBlob', () => {
  it('export/import roundtrip preserves identity', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const { identity: original } = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const blob = await exportIdentityBlob();
    expect(blob).not.toBeNull();

    // Delete and re-import
    await deleteIdentity();
    expect(await hasIdentity()).toBe(false);

    await importIdentityBlob(blob!);
    expect(await hasIdentity()).toBe(true);

    const unlocked = await unlockWithPrf(prfKey);
    expect(Array.from(unlocked.publicKeyBytes)).toEqual(Array.from(original.publicKeyBytes));
  });

  it('returns null when no identity exists', async () => {
    const blob = await exportIdentityBlob();
    expect(blob).toBeNull();
  });

  it('rejects invalid version', async () => {
    await expect(importIdentityBlob(JSON.stringify({ version: 99 }))).rejects.toThrow(
      'Unsupported key file version',
    );
  });
});

// ─── deleteIdentity ──────────────────────────────────────────────────────────

describe('deleteIdentity', () => {
  it('removes the stored identity', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    expect(await hasIdentity()).toBe(true);
    await deleteIdentity();
    expect(await hasIdentity()).toBe(false);
  });
});

// ─── Session storage ──────────────────────────────────────────────────────────

describe('saveSessions / loadSessions', () => {
  it('roundtrips session data with encryption', async () => {
    const data = { sessions: { peer1: { key: 'value' } }, count: 42 };
    await saveSessions(data, 'session-pass');

    const loaded = await loadSessions('session-pass');
    expect(loaded).toEqual(data);
  });

  it('fails with wrong passphrase', async () => {
    await saveSessions({ x: 1 }, 'correct');
    await expect(loadSessions('wrong')).rejects.toThrow();
  });

  it('returns null when no sessions stored', async () => {
    const result = await loadSessions('any-pass');
    expect(result).toBeNull();
  });
});

// ─── Recovery key encoding ────────────────────────────────────────────────────

describe('encodeRecoveryKey / decodeRecoveryKey', () => {
  it('roundtrips a 32-byte key', () => {
    const key = randomBytes(32);
    const encoded = encodeRecoveryKey(key);
    const decoded = decodeRecoveryKey(encoded);

    expect(Array.from(decoded)).toEqual(Array.from(key));
  });

  it('produces human-readable dash-separated format', () => {
    const key = randomBytes(32);
    const encoded = encodeRecoveryKey(key);
    expect(encoded).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{1,4})+$/);
  });

  it('handles Crockford confusables (O->0, I->1, L->1)', () => {
    const key = randomBytes(32);
    const encoded = encodeRecoveryKey(key);
    // Replace valid chars with confusables
    const mangled = encoded.replace(/0/g, 'O').replace(/1/g, 'I');
    const decoded = decodeRecoveryKey(mangled);

    expect(Array.from(decoded)).toEqual(Array.from(key));
  });

  it('rejects invalid characters', () => {
    expect(() => decodeRecoveryKey('ZZZZ-!!!!')).toThrow('Invalid character');
  });
});

// ─── Utility functions ────────────────────────────────────────────────────────

describe('generatePrfSalt / generateRecoveryKey', () => {
  it('generatePrfSalt returns 32 random bytes', () => {
    const salt = generatePrfSalt();
    expect(salt.length).toBe(32);
  });

  it('generateRecoveryKey returns 32 random bytes', () => {
    const key = generateRecoveryKey();
    expect(key.length).toBe(32);
  });

  it('consecutive calls produce different values', () => {
    const k1 = generateRecoveryKey();
    const k2 = generateRecoveryKey();
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });
});

// ─── signChallenge ────────────────────────────────────────────────────────────

describe('signChallenge', () => {
  it('signs a challenge that can be verified with the public key', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const { identity } = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const challenge = randomBytes(32);
    const sig = await signChallenge(identity.signingKey, challenge);

    expect(sig.length).toBe(64);

    const pubKey = await importEd25519PublicKey(identity.publicKeyBytes);
    const valid = await ed25519Verify(pubKey, sig, challenge);
    expect(valid).toBe(true);
  });
});

// ─── Tampered key file rejection ─────────────────────────────────────────────

describe('corrupt key file handling', () => {
  it('rejects tampered MEK ciphertext', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    // Export, tamper, re-import
    const blob = JSON.parse((await exportIdentityBlob())!);
    blob.mek_ciphertext[0] ^= 0xff;
    await importIdentityBlob(JSON.stringify(blob));

    // Unlock should fail because decrypted payload is garbage
    await expect(unlockWithPrf(prfKey)).rejects.toThrow();
  });

  it('rejects tampered wrapped MEK in key slot', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const blob = JSON.parse((await exportIdentityBlob())!);
    blob.key_slots[0].wrapped_mek[0] ^= 0xff;
    await importIdentityBlob(JSON.stringify(blob));

    await expect(unlockWithPrf(prfKey)).rejects.toThrow();
  });
});

// ─── hasIdentity ─────────────────────────────────────────────────────────────

describe('hasIdentity', () => {
  it('returns false when no identity exists', async () => {
    expect(await hasIdentity()).toBe(false);
  });

  it('returns true after creating identity', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());
    expect(await hasIdentity()).toBe(true);
  });
});
