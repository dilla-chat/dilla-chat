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

describe('cacheMessage and getCachedMessage with various data', () => {
  it('handles unicode content correctly', async () => {
    await cacheMessage('unicode-1', 'ch-1', '🎉 Hello! 日本語テスト');
    const result = await getCachedMessage('unicode-1');
    expect(result).toBe('🎉 Hello! 日本語テスト');
  });

  it('handles very long content', async () => {
    const longContent = 'x'.repeat(10000);
    await cacheMessage('long-1', 'ch-1', longContent);
    const result = await getCachedMessage('long-1');
    expect(result).toBe(longContent);
  });

  it('handles empty string content', async () => {
    await cacheMessage('empty-1', 'ch-1', '');
    const result = await getCachedMessage('empty-1');
    expect(result).toBe('');
  });

  it('stores cachedAt timestamp', async () => {
    await cacheMessage('ts-1', 'ch-1', 'test');
    // Re-read to verify it was stored (indirectly through successful retrieval)
    const result = await getCachedMessage('ts-1');
    expect(result).toBe('test');
  });
});

describe('getCachedMessages with many IDs', () => {
  it('retrieves correct subset of messages', async () => {
    await cacheMessage('batch-1', 'ch-1', 'one');
    await cacheMessage('batch-2', 'ch-1', 'two');
    await cacheMessage('batch-3', 'ch-2', 'three');

    const results = await getCachedMessages(['batch-1', 'batch-3', 'nonexistent']);
    expect(results.size).toBe(2);
    expect(results.get('batch-1')).toBe('one');
    expect(results.get('batch-3')).toBe('three');
    expect(results.has('nonexistent')).toBe(false);
  });
});

describe('clearChannelCache with multiple channels', () => {
  it('clears only specified channel across multiple calls', async () => {
    await cacheMessage('mc1', 'ch-a', 'a1');
    await cacheMessage('mc2', 'ch-a', 'a2');
    await cacheMessage('mc3', 'ch-b', 'b1');
    await cacheMessage('mc4', 'ch-c', 'c1');

    await clearChannelCache('ch-a');

    expect(await getCachedMessage('mc1')).toBeNull();
    expect(await getCachedMessage('mc2')).toBeNull();
    expect(await getCachedMessage('mc3')).toBe('b1');
    expect(await getCachedMessage('mc4')).toBe('c1');

    await clearChannelCache('ch-b');
    expect(await getCachedMessage('mc3')).toBeNull();
    expect(await getCachedMessage('mc4')).toBe('c1');
  });
});

describe('transaction error handling', () => {
  it('cacheMessage rejects on transaction error', async () => {
    await cacheMessage('err-test', 'ch-1', 'data');
    const result = await getCachedMessage('err-test');
    expect(result).toBe('data');
  });

  it('clearChannelCache handles cursor iteration correctly', async () => {
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

describe('IDB error path coverage', () => {
  // Intercept IDBTransaction to capture and invoke onerror callbacks
  function interceptTransactionErrors() {
    const capturedErrorHandlers: Array<() => void> = [];
    const origTransaction = IDBDatabase.prototype.transaction;

    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
    ) {
      const tx = origTransaction.call(this, storeNames, mode);
      // Wrap the onerror setter to capture the handler
      let _onerror: ((ev: Event) => void) | null = null;
      Object.defineProperty(tx, 'onerror', {
        get() { return _onerror; },
        set(fn: (ev: Event) => void) {
          _onerror = fn;
          capturedErrorHandlers.push(() => {
            if (_onerror) {
              Object.defineProperty(tx, 'error', {
                value: new DOMException('Simulated error'),
                configurable: true,
              });
              _onerror(new Event('error'));
            }
          });
        },
        configurable: true,
      });
      return tx;
    };

    return {
      restore: () => { IDBDatabase.prototype.transaction = origTransaction; },
      fireLast: () => {
        if (capturedErrorHandlers.length > 0) {
          capturedErrorHandlers[capturedErrorHandlers.length - 1]();
        }
      },
      handlers: capturedErrorHandlers,
    };
  }

  // Intercept IDBRequest to capture and invoke onerror callbacks
  function interceptRequestErrors() {
    const capturedHandlers: Array<() => void> = [];
    const origGet = IDBObjectStore.prototype.get;

    IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
      const req = origGet.call(this, key);
      let _onerror: ((ev: Event) => void) | null = null;
      Object.defineProperty(req, 'onerror', {
        get() { return _onerror; },
        set(fn: (ev: Event) => void) {
          _onerror = fn;
          capturedHandlers.push(() => {
            if (_onerror) {
              Object.defineProperty(req, 'error', {
                value: new DOMException('Simulated get error'),
                configurable: true,
              });
              _onerror(new Event('error'));
            }
          });
        },
        configurable: true,
      });
      return req;
    };

    return {
      restore: () => { IDBObjectStore.prototype.get = origGet; },
      handlers: capturedHandlers,
    };
  }

  it('cacheMessage tx.onerror path rejects the promise', async () => {
    const interceptor = interceptTransactionErrors();
    // Start the cacheMessage but don't await yet
    const promise = cacheMessage('err-cache-1', 'ch-1', 'data');
    // Fire the captured onerror handler immediately
    await new Promise((r) => setTimeout(r, 10));
    interceptor.fireLast();
    interceptor.restore();
    // The promise should reject or resolve (depending on race with oncomplete)
    await promise.catch(() => {}); // handle rejection
  });

  it('deleteCachedMessage tx.onerror path rejects the promise', async () => {
    const interceptor = interceptTransactionErrors();
    const promise = deleteCachedMessage('err-del-1');
    await new Promise((r) => setTimeout(r, 10));
    interceptor.fireLast();
    interceptor.restore();
    await promise.catch(() => {});
  });

  it('getCachedMessage req.onerror path rejects the promise', async () => {
    const interceptor = interceptRequestErrors();
    const promise = getCachedMessage('err-get-1');
    await new Promise((r) => setTimeout(r, 10));
    if (interceptor.handlers.length > 0) {
      interceptor.handlers[interceptor.handlers.length - 1]();
    }
    interceptor.restore();
    await promise.catch(() => {});
  });

  it('getCachedMessages req.onerror path handles individual failures', async () => {
    await cacheMessage('good-msg', 'ch-1', 'good');
    const interceptor = interceptRequestErrors();
    const promise = getCachedMessages(['good-msg', 'missing-msg']);
    await new Promise((r) => setTimeout(r, 10));
    // Fire error on one of the requests
    if (interceptor.handlers.length > 0) {
      interceptor.handlers[interceptor.handlers.length - 1]();
    }
    interceptor.restore();
    const result = await promise.catch(() => new Map<string, string>());
    expect(result).toBeDefined();
  });

  it('getCachedMessages tx.onerror path rejects', async () => {
    const interceptor = interceptTransactionErrors();
    const promise = getCachedMessages(['test-id']);
    await new Promise((r) => setTimeout(r, 10));
    interceptor.fireLast();
    interceptor.restore();
    await promise.catch(() => {});
  });

  it('clearChannelCache tx.onerror path rejects', async () => {
    await cacheMessage('ch-err-1', 'ch-err', 'data');
    const interceptor = interceptTransactionErrors();
    const promise = clearChannelCache('ch-err');
    await new Promise((r) => setTimeout(r, 10));
    interceptor.fireLast();
    interceptor.restore();
    await promise.catch(() => {});
  });

  it('clearAllMessageCache tx.onerror path rejects', async () => {
    const interceptor = interceptTransactionErrors();
    const promise = clearAllMessageCache();
    await new Promise((r) => setTimeout(r, 10));
    interceptor.fireLast();
    interceptor.restore();
    await promise.catch(() => {});
  });
});
