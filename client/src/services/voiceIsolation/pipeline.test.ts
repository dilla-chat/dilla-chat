import { describe, it, expect } from 'vitest';
import { createPipeline } from './pipeline';

describe('pipeline.createPipeline', () => {
  it('exports a function', () => {
    // Smoke test only — the real pipeline needs an AudioContext, an
    // AudioWorklet, and a Worker, none of which jsdom provides. The
    // browser-mode test in pipeline.browser.test.ts exercises the full
    // assembly.
    expect(typeof createPipeline).toBe('function');
  });
});
