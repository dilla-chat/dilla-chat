/**
 * Noise suppression service — no-op stub.
 *
 * RNNoise has been removed. This file preserves the public API so that
 * existing call-sites compile without changes; every method is a no-op.
 */

export class NoiseSuppression {
  /* noop */
  async initWorklet(_audioContext: AudioContext): Promise<void> {
    /* noop */
  }

  /* noop */
  getWorkletNode(): AudioWorkletNode | null {
    /* noop */
    return null;
  }

  /* noop */
  setEnabled(_enabled: boolean): void {
    /* noop */
  }

  /* noop */
  isEnabled(): boolean {
    /* noop */
    return false;
  }

  /* noop */
  isInitialized(): boolean {
    /* noop */
    return false;
  }

  /* noop */
  setVadThreshold(_value: number): void {
    /* noop */
  }

  /* noop */
  setVadGracePeriodMs(_value: number): void {
    /* noop */
  }

  /* noop */
  setRetroactiveGraceMs(_value: number): void {
    /* noop */
  }

  /* noop */
  waitForReady(_timeoutMs = 3000): Promise<boolean> {
    /* noop */
    return Promise.resolve(false);
  }

  /* noop */
  cleanup(): void {
    /* noop */
  }
}

// Singleton — preserved across HMR
const globalKey = '__dilla_noiseSuppression__';
const _nsGlobal = globalThis as Record<string, unknown>;
if (!_nsGlobal[globalKey]) {
  _nsGlobal[globalKey] = new NoiseSuppression();
}
export const noiseSuppression: NoiseSuppression = _nsGlobal[globalKey] as NoiseSuppression;
