// Tests for the Trusted Types installer + the SSR/worker fallback
// stripper. The DOMParser-backed path is the production path in the
// browser; we exercise it AND the no-DOMParser linear fallback.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We can't import private functions directly — exercise via the
// installed default policy's createHTML hook. Re-import the module
// fresh per suite so each spec gets its own policy registration.
async function withDOMParser(fn: () => Promise<void> | void) {
  await fn();
}

async function withoutDOMParser(fn: () => Promise<void> | void) {
  const orig = (globalThis as { DOMParser?: unknown }).DOMParser;
  Object.defineProperty(globalThis, 'DOMParser', { value: undefined, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(globalThis, 'DOMParser', { value: orig, configurable: true });
  }
}

// Helper: install the policy + return its createHTML transform.
async function getCreateHTML(): Promise<(s: string) => string> {
  return (await getPolicy()).createHTML;
}

interface PolicyHooks {
  createHTML: (s: string) => string;
  createScript: (s: string) => string;
  createScriptURL: (s: string) => string;
}

async function getPolicy(): Promise<PolicyHooks> {
  vi.resetModules();
  let captured!: PolicyHooks;
  Object.defineProperty(window, 'trustedTypes', {
    value: {
      createPolicy: (_name: string, opts: PolicyHooks) => {
        captured = opts;
        return opts;
      },
    },
    configurable: true,
    writable: true,
  });
  const mod = await import('./trustedTypes');
  mod.installTrustedTypesPolicy();
  return captured;
}

describe('trustedTypes / stripDangerousMarkup (DOMParser path)', () => {
  let createHTML: (s: string) => string;
  beforeEach(async () => {
    createHTML = await getCreateHTML();
  });
  afterEach(() => {
    // @ts-expect-error reset
    delete window.trustedTypes;
  });

  it('passes plain text through unchanged', async () => {
    await withDOMParser(() => {
      expect(createHTML('hello <b>world</b>')).toContain('hello');
    });
  });

  it('strips <script> tags', async () => {
    await withDOMParser(() => {
      const out = createHTML('<p>ok</p><script>alert(1)</script>');
      expect(out).not.toContain('<script');
      expect(out).toContain('ok');
    });
  });

  it('returns empty when input exceeds the 64 KiB cap', async () => {
    await withDOMParser(() => {
      const oversized = 'a'.repeat(64 * 1024 + 1);
      expect(createHTML(oversized)).toBe('');
    });
  });
});

describe('trustedTypes / stripDangerousMarkup (linear SSR fallback)', () => {
  let createHTML: (s: string) => string;
  beforeEach(async () => {
    createHTML = await getCreateHTML();
  });
  afterEach(() => {
    // @ts-expect-error reset
    delete window.trustedTypes;
  });

  it('strips <script> via the linear scanner when DOMParser is unavailable', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('<p>ok</p><script>alert(1)</script>');
      expect(out).toBe('<p>ok</p>');
    });
  });

  it('strips multiple script tags and preserves content between them', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('a<script>x</script>b<script>y</script>c');
      expect(out).toBe('abc');
    });
  });

  it('handles whitespace + attributes on the open + close tag', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('<p>a</p><script type="text/javascript" >evil()</script  >');
      expect(out).toBe('<p>a</p>');
    });
  });

  it('does not strip identifiers like <scripted-foo>', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('<scripted-foo>fine</scripted-foo>');
      expect(out).toContain('scripted-foo');
    });
  });

  it('drops everything after an unclosed <script>', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('<p>safe</p><script>unclosed');
      expect(out).toBe('<p>safe</p>');
    });
  });

  it('returns input verbatim when it does not contain <script>', async () => {
    await withoutDOMParser(() => {
      expect(createHTML('<p>just text</p>')).toBe('<p>just text</p>');
    });
  });

  it('handles char after <script that is not a tag-boundary (e.g. <scriptz)', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('<scriptz>fine</scriptz>');
      expect(out).toContain('scriptz');
    });
  });

  it('handles <script without closing tag start — drops the rest', async () => {
    await withoutDOMParser(() => {
      const out = createHTML('<p>a</p><script no-close');
      expect(out).toBe('<p>a</p>');
    });
  });
});

describe('trustedTypes / createScript + createScriptURL hooks', () => {
  afterEach(() => {
    // @ts-expect-error reset
    delete window.trustedTypes;
  });

  it('createScript always throws', async () => {
    const policy = await getPolicy();
    expect(() => policy.createScript('alert(1)')).toThrow(TypeError);
  });

  it('createScriptURL accepts a safe relative URL', async () => {
    const policy = await getPolicy();
    expect(policy.createScriptURL('/static/x.js')).toBe('/static/x.js');
  });

  it('createScriptURL rejects javascript: URL', async () => {
    const policy = await getPolicy();
    expect(() => policy.createScriptURL('javascript:alert(1)')).toThrow(TypeError);
  });

  it('createScriptURL rejects vbscript: URL', async () => {
    const policy = await getPolicy();
    expect(() => policy.createScriptURL('vbscript:msgbox 1')).toThrow(TypeError);
  });

  it('createScriptURL rejects data: text/html URL', async () => {
    const policy = await getPolicy();
    expect(() => policy.createScriptURL('data:text/html,<script>1</script>')).toThrow(TypeError);
  });

  it('createScriptURL accepts data: text/javascript (out of scope for this filter)', async () => {
    const policy = await getPolicy();
    // The coarse filter only rejects javascript:/vbscript:/data:text/html.
    // text/javascript-data is still allowed (CSP catches real loads).
    expect(policy.createScriptURL('data:text/javascript,1')).toBe('data:text/javascript,1');
  });

  it('logs and swallows when createPolicy throws (duplicate-policy case)', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window, 'trustedTypes', {
      value: {
        createPolicy: () => {
          throw new Error('already exists');
        },
      },
      configurable: true,
      writable: true,
    });
    const mod = await import('./trustedTypes');
    expect(() => mod.installTrustedTypesPolicy()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      '[trusted-types] policy registration failed:',
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it('no-ops when trustedTypes is not available', async () => {
    vi.resetModules();
    Object.defineProperty(window, 'trustedTypes', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const mod = await import('./trustedTypes');
    expect(() => mod.installTrustedTypesPolicy()).not.toThrow();
  });
});
