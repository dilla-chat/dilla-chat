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
  hasPasskeyKeySlot,
  hasPasswordSlot,
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
    expect(Array.from(pubKey as Uint8Array)).toEqual(Array.from(result.identity.publicKeyBytes));
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

    await importIdentityBlob(blob as string);
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
    const mangled = encoded.replaceAll('0', 'O').replaceAll('1', 'I');
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

// ─── signEnrollmentChallenge (SECREVIEW-VULN-1) ──────────────────────────────

describe('signEnrollmentChallenge', () => {
  // Mirror of server `enrollment_signing_digest` — used to verify the
  // signature was produced over the right bytes.
  async function expectedDigest(
    userId: string,
    newPk: Uint8Array,
    nonce: Uint8Array,
  ): Promise<Uint8Array> {
    const label = new TextEncoder().encode('dilla-device-enroll-v1');
    const userBytes = new TextEncoder().encode(userId);
    const sep = new Uint8Array([0]);
    const buf = new Uint8Array(
      label.length + 1 + userBytes.length + 1 + 32 + 1 + 32,
    );
    let o = 0;
    buf.set(label, o); o += label.length;
    buf.set(sep, o); o += 1;
    buf.set(userBytes, o); o += userBytes.length;
    buf.set(sep, o); o += 1;
    buf.set(newPk, o); o += 32;
    buf.set(sep, o); o += 1;
    buf.set(nonce, o);
    const h = await crypto.subtle.digest('SHA-256', buf);
    return new Uint8Array(h);
  }

  it('produces a signature that verifies against the bound (user_id, new_pk, nonce) digest', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const { identity } = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const nonce = randomBytes(32);
    const newPk = randomBytes(32);
    const { signEnrollmentChallenge } = await import('./keyStore');
    const sig = await signEnrollmentChallenge(identity.signingKey, nonce, 'alice', newPk);

    expect(sig.length).toBe(64);

    const pubKey = await importEd25519PublicKey(identity.publicKeyBytes);
    const digest = await expectedDigest('alice', newPk, nonce);
    const valid = await ed25519Verify(pubKey, sig, digest);
    expect(valid).toBe(true);

    // Sanity: the bare nonce is NOT what's signed — verifying against
    // the nonce alone must fail.
    const valid2 = await ed25519Verify(pubKey, sig, nonce);
    expect(valid2).toBe(false);
  });

  it('rejects a non-32-byte new device public key', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const { identity } = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());
    const { signEnrollmentChallenge } = await import('./keyStore');
    await expect(
      signEnrollmentChallenge(identity.signingKey, randomBytes(32), 'alice', randomBytes(16)),
    ).rejects.toThrow(/32 bytes/);
  });

  it('rejects a non-32-byte nonce', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    const { identity } = await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());
    const { signEnrollmentChallenge } = await import('./keyStore');
    await expect(
      signEnrollmentChallenge(identity.signingKey, randomBytes(16), 'alice', randomBytes(32)),
    ).rejects.toThrow(/nonce/);
  });
});

// ─── Passkey-recoverable identity escrow (design doc 15) ────────────────────

describe('buildRecoveryEscrowBlob + restoreFromRecoveryEscrowBlob', () => {
  it('round-trips identity.key through PRF-derived AES-GCM', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const {
      buildRecoveryEscrowBlob,
      restoreFromRecoveryEscrowBlob,
      deleteIdentity,
      hasIdentity,
      getPublicKey,
    } = await import('./keyStore');

    const beforePub = await getPublicKey();
    expect(beforePub).not.toBeNull();

    const escrow = await buildRecoveryEscrowBlob(prfKey);
    expect(escrow.length).toBeGreaterThan(12 + 16); // nonce + GCM tag floor

    // Wipe the local identity and rehydrate from the escrow blob.
    await deleteIdentity();
    expect(await hasIdentity()).toBe(false);
    await restoreFromRecoveryEscrowBlob(prfKey, escrow);
    expect(await hasIdentity()).toBe(true);
    const afterPub = await getPublicKey();
    expect(Array.from(afterPub!)).toEqual(Array.from(beforePub!));
  });

  it('rejects decryption with a different PRF output', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const {
      buildRecoveryEscrowBlob,
      restoreFromRecoveryEscrowBlob,
      deleteIdentity,
    } = await import('./keyStore');

    const escrow = await buildRecoveryEscrowBlob(prfKey);
    await deleteIdentity();
    const wrongKey = randomBytes(32);
    await expect(
      restoreFromRecoveryEscrowBlob(wrongKey, escrow),
    ).rejects.toThrow();
  });

  it('throws when no identity exists', async () => {
    const { buildRecoveryEscrowBlob, deleteIdentity } = await import('./keyStore');
    await deleteIdentity();
    await expect(buildRecoveryEscrowBlob(randomBytes(32))).rejects.toThrow(/No identity to escrow/);
  });
});

describe('listEscrowableCredentialDescriptors', () => {
  it('returns one descriptor per (slot, credential) pair', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, [
      { id: 'cred-1', name: 'Yubikey', created_at: new Date().toISOString() },
      { id: 'cred-2', name: 'Backup', created_at: new Date().toISOString() },
    ]);
    const { listEscrowableCredentialDescriptors } = await import('./keyStore');
    const descs = await listEscrowableCredentialDescriptors();
    expect(descs.length).toBe(2);
    expect(descs.map(d => d.credentialId).sort()).toEqual(['cred-1', 'cred-2']);
    // All share the same slot's prf_salt — single key_slot per createIdentity.
    expect(Array.from(descs[0].prfSalt)).toEqual(Array.from(prfSalt));
    expect(Array.from(descs[1].prfSalt)).toEqual(Array.from(prfSalt));
  });

  it('returns empty array when no identity exists', async () => {
    const { listEscrowableCredentialDescriptors, deleteIdentity } = await import('./keyStore');
    await deleteIdentity();
    const descs = await listEscrowableCredentialDescriptors();
    expect(descs).toEqual([]);
  });
});

// ─── Tampered key file rejection ─────────────────────────────────────────────

describe('corrupt key file handling', () => {
  it('rejects tampered MEK ciphertext', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    // Export, tamper, re-import
    const blob = JSON.parse((await exportIdentityBlob()) as string);
    blob.mek_ciphertext[0] ^= 0xff;
    await importIdentityBlob(JSON.stringify(blob));

    // Unlock should fail because decrypted payload is garbage
    await expect(unlockWithPrf(prfKey)).rejects.toThrow();
  });

  it('rejects tampered wrapped MEK in key slot', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());

    const blob = JSON.parse((await exportIdentityBlob()) as string);
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

describe('hasPasskeyKeySlot + hasPasswordSlot', () => {
  it('hasPasskeyKeySlot returns false when no identity exists', async () => {
    expect(await hasPasskeyKeySlot()).toBe(false);
  });

  it('hasPasskeyKeySlot returns true after PRF identity creation', async () => {
    const prfKey = randomBytes(32);
    const prfSalt = randomBytes(32);
    await createIdentity('https://example.com', prfKey, prfSalt, makeCredential());
    expect(await hasPasskeyKeySlot()).toBe(true);
  });

  it('hasPasswordSlot returns false when no identity exists', async () => {
    expect(await hasPasswordSlot()).toBe(false);
  });

  it('hasPasswordSlot returns true after passphrase identity creation', async () => {
    await createIdentityWithPassphrase('https://example.com', 'hunter2', []);
    expect(await hasPasswordSlot()).toBe(true);
  });

  it('hasPasskeyKeySlot returns false for a passphrase-only identity', async () => {
    await createIdentityWithPassphrase('https://example.com', 'hunter2', []);
    expect(await hasPasskeyKeySlot()).toBe(false);
  });
});
