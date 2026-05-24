import { describe, it, expect } from 'vitest';
import * as VI from './index';

describe('voiceIsolation/index public exports', () => {
  it('re-exports createPipeline', () => {
    expect(typeof VI.createPipeline).toBe('function');
  });

  it('re-exports Dfn3Pipeline class + DFN3_HYPERPARAMS', () => {
    expect(VI.Dfn3Pipeline).toBeDefined();
    expect(VI.DFN3_HYPERPARAMS).toBeDefined();
    expect(typeof VI.DFN3_HYPERPARAMS).toBe('object');
  });

  it('re-exports loadDfn3Model + fetchManifest + ManifestError', () => {
    expect(typeof VI.loadDfn3Model).toBe('function');
    expect(typeof VI.fetchManifest).toBe('function');
    expect(typeof VI.ManifestError).toBe('function');
  });

  it('DFN3_HYPERPARAMS carries the documented sample rate + frame sizes', () => {
    expect(VI.DFN3_HYPERPARAMS.sampleRate).toBe(48000);
    expect(VI.DFN3_HYPERPARAMS.fftSize).toBe(960);
    expect(VI.DFN3_HYPERPARAMS.hopSize).toBe(480);
  });
});
