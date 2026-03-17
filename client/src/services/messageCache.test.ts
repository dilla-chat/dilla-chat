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
});
