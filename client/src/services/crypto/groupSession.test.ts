import { describe, it, expect } from 'vitest';
import { GroupSession } from './groupSession';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('crypto/groupSession (Sender Keys)', () => {
  it('self-decrypt: encrypted by alice → decrypted by alice (echo case)', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const ct = await a.encrypt(enc.encode('hi'));
    expect(dec.decode(await a.decrypt(ct))).toBe('hi');
  });

  it('cross-decrypt: bob processes alice\'s distribution + decrypts her message', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const b = await GroupSession.create('c1', 'bob');
    b.processDistribution(a.createDistributionMessage());

    const ct = await a.encrypt(enc.encode('hello bob'));
    expect(dec.decode(await b.decrypt(ct))).toBe('hello bob');
  });

  it('processDistribution overwrites a previous member entry', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const b1 = await GroupSession.create('c1', 'bob');
    const b2 = await GroupSession.create('c1', 'bob'); // bob rotated/re-joined

    a.processDistribution(b1.createDistributionMessage());
    a.processDistribution(b2.createDistributionMessage());

    const ct = await b2.encrypt(enc.encode('after rotation'));
    expect(dec.decode(await a.decrypt(ct))).toBe('after rotation');
  });

  it('handles a skipped message (chain advances forward, not back)', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const b = await GroupSession.create('c1', 'bob');
    b.processDistribution(a.createDistributionMessage());

    const m1 = await a.encrypt(enc.encode('one'));
    const m2 = await a.encrypt(enc.encode('two'));
    const m3 = await a.encrypt(enc.encode('three'));

    // Deliver m3 first — chain advances 0 → 2 → consume → 3.
    expect(dec.decode(await b.decrypt(m3))).toBe('three');
    // m1 and m2 are now behind; sender-key chains can't go back.
    await expect(b.decrypt(m1)).rejects.toThrow('predates current state');
    await expect(b.decrypt(m2)).rejects.toThrow('predates current state');
  });

  it('rejects forged signatures', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const b = await GroupSession.create('c1', 'bob');
    b.processDistribution(a.createDistributionMessage());
    const ct = await a.encrypt(enc.encode('legit'));
    ct.signature = ct.signature.map((x, i) => (i === 0 ? x ^ 0xff : x));
    await expect(b.decrypt(ct)).rejects.toThrow('signature verification failed');
  });

  it('rejects messages from unknown senders', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const ct = await a.encrypt(enc.encode('x'));
    ct.sender_id = 'stranger';
    await expect(a.decrypt(ct)).rejects.toThrow('No sender key');
  });

  it('rejects a giant chain gap (possible corruption or attack)', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const b = await GroupSession.create('c1', 'bob');
    b.processDistribution(a.createDistributionMessage());
    const ct = await a.encrypt(enc.encode('x'));
    ct.message_number = 5000;
    await expect(b.decrypt(ct)).rejects.toThrow('gap too large');
  });

  it('rotateMyKey: re-encrypts under a fresh chain, old chain becomes unusable', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const oldDist = a.createDistributionMessage();

    await a.rotateMyKey();
    // Distribute the fresh state BEFORE encrypting so the peer's chain
    // starts at message_number=0 to match the first post-rotation message.
    const peer = await GroupSession.create('c1', 'bob');
    peer.processDistribution(a.createDistributionMessage());

    const ct = await a.encrypt(enc.encode('post-rotation'));
    expect(dec.decode(await peer.decrypt(ct))).toBe('post-rotation');

    // A peer that only ever saw the OLD distribution cannot decrypt the new ciphertext.
    const stalePeer = await GroupSession.create('c1', 'eve');
    stalePeer.processDistribution(oldDist);
    await expect(stalePeer.decrypt(ct)).rejects.toThrow();
  });

  it('removeMember drops the sender key', async () => {
    const a = await GroupSession.create('c1', 'alice');
    const b = await GroupSession.create('c1', 'bob');
    a.processDistribution(b.createDistributionMessage());
    a.removeMember('bob');
    const ct = await b.encrypt(enc.encode('hi'));
    await expect(a.decrypt(ct)).rejects.toThrow('No sender key');
  });

  it('toJSON / fromJSON round-trips an active session', async () => {
    const a = await GroupSession.create('c1', 'alice');
    await a.encrypt(enc.encode('warm'));
    const cloned = GroupSession.fromJSON(a.toJSON() as Record<string, unknown>);
    expect(cloned.channelId).toBe('c1');
    expect(cloned.mySenderKey.senderId).toBe('alice');
    expect(cloned.mySenderKey.messageNumber).toBe(a.mySenderKey.messageNumber);
  });

  it('encrypt() throws if signingPrivatePkcs8 is missing', async () => {
    const a = await GroupSession.create('c1', 'alice');
    a.mySenderKey.signingPrivatePkcs8 = null;
    await expect(a.encrypt(enc.encode('x'))).rejects.toThrow('No signing key');
  });
});
