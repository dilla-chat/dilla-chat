import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithTimeout } from './fetchWithTimeout';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves when fetch completes within timeout', async () => {
    const mockResponse = new Response('ok', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const promise = fetchWithTimeout('https://example.com');
    const result = await promise;
    expect(result.status).toBe(200);
  });

  it('aborts when fetch exceeds timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      ),
    );

    const promise = fetchWithTimeout('https://example.com', { timeout: 1000 });
    vi.advanceTimersByTime(1500);
    await expect(promise).rejects.toThrow('Aborted');
  });

  it('uses custom timeout value', async () => {
    let abortCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              abortCalled = true;
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      ),
    );

    const promise = fetchWithTimeout('https://example.com', { timeout: 500 });
    vi.advanceTimersByTime(600);
    await expect(promise).rejects.toThrow();
    expect(abortCalled).toBe(true);
  });
});
