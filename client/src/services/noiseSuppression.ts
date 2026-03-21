/**
 * Noise suppression service — STUB.
 *
 * The RNNoise-based implementation has been removed. This module preserves the
 * public API surface so that callers compile without changes, but every method
 * is a no-op. The feature can be re-implemented later with a different library.
 */

export class NoiseSuppression {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async initWorklet(_audioContext: AudioContext): Promise<void> {
    /* no-op */
  }

  getWorkletNode(): AudioWorkletNode | null {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setEnabled(_enabled: boolean): void {
    /* no-op */
  }

  isEnabled(): boolean {
    return false;
  }

  isInitialized(): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setVadThreshold(_value: number): void {
    /* no-op */
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setVadGracePeriodMs(_value: number): void {
    /* no-op */
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setRetroactiveGraceMs(_value: number): void {
    /* no-op */
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  waitForReady(_timeoutMs?: number): Promise<boolean> {
    return Promise.resolve(false);
  }

  cleanup(): void {
    /* no-op */
  }
}

// Singleton — preserved across HMR
const globalKey = '__dilla_noiseSuppression__';
const _nsGlobal = globalThis as Record<string, unknown>;
if (!_nsGlobal[globalKey]) {
  _nsGlobal[globalKey] = new NoiseSuppression();
}
export const noiseSuppression: NoiseSuppression = _nsGlobal[globalKey] as NoiseSuppression;
