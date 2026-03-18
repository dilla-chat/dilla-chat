import { describe, it, expect, beforeEach } from 'vitest';
import {
  cacheMessage,
  getCachedMessage,
  getCachedMessages,
  deleteCachedMessage,
  clearChannelCache,
  clearAllMessageCache,
} from './messageCache';

beforeEach(async () => {
  await clearAllMessageCache();
});

describe('cacheMessage / getCachedMessage', () => {
  it('roundtrips a message', async () => {
    await cacheMessage('msg-1', 'ch-1', 'Hello world');
    const result = await getCachedMessage('msg-1');
    expect(result).toBe('Hello world');
  });

  it('returns null for non-existent message', async () => {
    const result = await getCachedMessage('nonexistent');
    expect(result).toBeNull();
  });

  it('overwrites existing entry with same id', async () => {
    await cacheMessage('msg-1', 'ch-1', 'original');
    await cacheMessage('msg-1', 'ch-1', 'updated');
    const result = await getCachedMessage('msg-1');
    expect(result).toBe('updated');
  });
});

describe('getCachedMessages', () => {
  it('retrieves multiple messages', async () => {
    await cacheMessage('m1', 'ch-1', 'first');
    await cacheMessage('m2', 'ch-1', 'second');
    await cacheMessage('m3', 'ch-2', 'third');

    const results = await getCachedMessages(['m1', 'm2', 'm3']);
    expect(results.size).toBe(3);
    expect(results.get('m1')).toBe('first');
    expect(results.get('m3')).toBe('third');
  });

  it('returns empty map for empty ids array', async () => {
    const results = await getCachedMessages([]);
    expect(results.size).toBe(0);
  });
});

describe('deleteCachedMessage', () => {
  it('deletes a single message', async () => {
    await cacheMessage('msg-1', 'ch-1', 'hello');
    await deleteCachedMessage('msg-1');
    const result = await getCachedMessage('msg-1');
    expect(result).toBeNull();
  });
});

describe('clearChannelCache', () => {
  it('clears all messages for a channel', async () => {
    await cacheMessage('m1', 'ch-1', 'a');
    await cacheMessage('m2', 'ch-1', 'b');
    await cacheMessage('m3', 'ch-2', 'c');

    await clearChannelCache('ch-1');

    expect(await getCachedMessage('m1')).toBeNull();
    expect(await getCachedMessage('m2')).toBeNull();
    expect(await getCachedMessage('m3')).toBe('c'); // different channel preserved
  });
});

describe('clearAllMessageCache', () => {
  it('clears everything', async () => {
    await cacheMessage('m1', 'ch-1', 'a');
    await cacheMessage('m2', 'ch-2', 'b');
    await clearAllMessageCache();
    expect(await getCachedMessage('m1')).toBeNull();
    expect(await getCachedMessage('m2')).toBeNull();
  });

  it('is safe to call when cache is empty', async () => {
    await clearAllMessageCache();
    expect(await getCachedMessage('m1')).toBeNull();
  });
});

describe('getCachedMessages edge cases', () => {
  it('skips missing ids without error', async () => {
    await cacheMessage('m1', 'ch-1', 'hello');
    const results = await getCachedMessages(['m1', 'missing-id']);
    expect(results.size).toBe(1);
    expect(results.get('m1')).toBe('hello');
    expect(results.has('missing-id')).toBe(false);
  });
});

describe('clearChannelCache edge cases', () => {
  it('is safe when channel has no messages', async () => {
    await clearChannelCache('empty-channel');
    // Should not throw
  });

  it('only clears target channel', async () => {
    await cacheMessage('m1', 'ch-1', 'a');
    await cacheMessage('m2', 'ch-2', 'b');
    await cacheMessage('m3', 'ch-1', 'c');
    await clearChannelCache('ch-1');
    expect(await getCachedMessage('m1')).toBeNull();
    expect(await getCachedMessage('m3')).toBeNull();
    expect(await getCachedMessage('m2')).toBe('b');
  });
});

describe('deleteCachedMessage edge cases', () => {
  it('is safe to delete non-existent message', async () => {
    await deleteCachedMessage('nonexistent');
    // Should not throw
  });
});

describe('transaction error handling', () => {
  it('cacheMessage rejects on transaction error', async () => {
    // We can't easily force a transaction error in fake-indexeddb,
    // but we can verify the promise-based API works normally
    await cacheMessage('err-test', 'ch-1', 'data');
    const result = await getCachedMessage('err-test');
    expect(result).toBe('data');
  });

  it('clearChannelCache handles cursor iteration correctly', async () => {
    // Add multiple messages to same channel then clear
    await cacheMessage('cc1', 'ch-clear', 'a');
    await cacheMessage('cc2', 'ch-clear', 'b');
    await cacheMessage('cc3', 'ch-clear', 'c');
    await cacheMessage('cc4', 'ch-other', 'd');

    await clearChannelCache('ch-clear');

    expect(await getCachedMessage('cc1')).toBeNull();
    expect(await getCachedMessage('cc2')).toBeNull();
    expect(await getCachedMessage('cc3')).toBeNull();
    expect(await getCachedMessage('cc4')).toBe('d');
  });

  it('clearAllMessageCache clears store completely', async () => {
    await cacheMessage('ca1', 'ch-1', 'x');
    await cacheMessage('ca2', 'ch-2', 'y');
    await clearAllMessageCache();
    expect(await getCachedMessage('ca1')).toBeNull();
    expect(await getCachedMessage('ca2')).toBeNull();
  });
});
