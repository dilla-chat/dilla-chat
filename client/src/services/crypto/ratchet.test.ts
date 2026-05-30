import { describe, it, expect } from 'vitest';
import { RatchetSession } from './ratchet';
import { generateX25519KeyPair, exportX25519PrivateKey } from './x25519';
import { randomBytes, bytesEqual } from './helpers';

async function newAlice(sharedSecret: Uint8Array, bobSpkPub: Uint8Array) {
  return RatchetSession.initAlice(sharedSecret, bobSpkPub, {
    identity_dh_key: [1, 2, 3],
    ephemeral_key: [4, 5, 6],
    one_time_prekey_index: 0,
  });
}

describe('crypto/ratchet (Double Ratchet)', () => {
  it('Alice → Bob: in-order delivery of three messages', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const alice = await newAlice(shared, bobSpk.publicKeyBytes);
    const bobPkcs8 = await exportX25519PrivateKey(bobSpk.privateKey);
    const bob = await RatchetSession.initBob(shared, bobPkcs8);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    for (const msg of ['one', 'two', 'three']) {
      const ct = await alice.encrypt(enc.encode(msg));
      const back = await bob.decrypt(ct);
      expect(dec.decode(back)).toBe(msg);
    }
  });

  it('first message carries the X3DH bootstrap, subsequent messages do not', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const alice = await newAlice(shared, bobSpk.publicKeyBytes);

    const m1 = await alice.encrypt(new TextEncoder().encode('hi'));
    const m2 = await alice.encrypt(new TextEncoder().encode('hello'));
    expect(m1.header.x3dh).toBeTruthy();
    expect(m2.header.x3dh).toBeUndefined();
  });

  it('out-of-order: m1 m2 m3 received as m1 m3 m2 still decrypts (skipped key cache)', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const alice = await newAlice(shared, bobSpk.publicKeyBytes);
    const bobPkcs8 = await exportX25519PrivateKey(bobSpk.privateKey);
    const bob = await RatchetSession.initBob(shared, bobPkcs8);
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const m1 = await alice.encrypt(enc.encode('one'));
    const m2 = await alice.encrypt(enc.encode('two'));
    const m3 = await alice.encrypt(enc.encode('three'));

    expect(dec.decode(await bob.decrypt(m1))).toBe('one');
    expect(dec.decode(await bob.decrypt(m3))).toBe('three'); // skips m2
    expect(dec.decode(await bob.decrypt(m2))).toBe('two'); // serves from skipped cache
  });

  it('bidirectional conversation triggers a DH ratchet on each side', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const alice = await newAlice(shared, bobSpk.publicKeyBytes);
    const bobPkcs8 = await exportX25519PrivateKey(bobSpk.privateKey);
    const bob = await RatchetSession.initBob(shared, bobPkcs8);

    const enc = new TextEncoder();
    const dec = new TextDecoder();

    // Alice → Bob
    const a1 = await alice.encrypt(enc.encode('hi bob'));
    expect(dec.decode(await bob.decrypt(a1))).toBe('hi bob');

    // Bob → Alice (forces Bob to ratchet on Alice's next send)
    const b1 = await bob.encrypt(enc.encode('hi alice'));
    expect(dec.decode(await alice.decrypt(b1))).toBe('hi alice');

    const a2 = await alice.encrypt(enc.encode('how are you'));
    expect(dec.decode(await bob.decrypt(a2))).toBe('how are you');
  });

  it('toJSON / fromJSON round-trips an active session', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const alice = await newAlice(shared, bobSpk.publicKeyBytes);
    await alice.encrypt(new TextEncoder().encode('warmup'));

    const cloned = RatchetSession.fromJSON(alice.toJSON() as Record<string, unknown>);
    expect(cloned.state.sendingMessageNumber).toBe(alice.state.sendingMessageNumber);
    expect(bytesEqual(cloned.state.rootKey, alice.state.rootKey)).toBe(true);
    expect(cloned.state.pendingBootstrap).toBeNull(); // bootstrap was consumed on first encrypt
  });

  it('exceeding MAX_SKIP causes a "Too many skipped messages" error', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const alice = await newAlice(shared, bobSpk.publicKeyBytes);
    const bobPkcs8 = await exportX25519PrivateKey(bobSpk.privateKey);
    const bob = await RatchetSession.initBob(shared, bobPkcs8);

    // Burn 260 messages on Alice, deliver only the last one — Bob must
    // try to skip > MAX_SKIP keys.
    let last: Awaited<ReturnType<typeof alice.encrypt>> | null = null;
    for (let i = 0; i < 260; i++) last = await alice.encrypt(new TextEncoder().encode('x'));
    await expect(bob.decrypt(last!)).rejects.toThrow('Too many skipped messages');
  });

  it('encrypt() throws if the session was constructed without a sending chain (Bob pre-receive)', async () => {
    const shared = randomBytes(32);
    const bobSpk = await generateX25519KeyPair();
    const bobPkcs8 = await exportX25519PrivateKey(bobSpk.privateKey);
    const bob = await RatchetSession.initBob(shared, bobPkcs8);
    await expect(bob.encrypt(new TextEncoder().encode('cant'))).rejects.toThrow('No sending chain key');
  });
});
