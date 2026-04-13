import { beforeEach, describe, expect, it } from 'vitest';
import {
  diagnostics,
  resetDiagnosticsForTest,
  type DiagnosticsSnapshot,
} from './diagnostics';

describe('voiceIsolation diagnostics', () => {
  beforeEach(() => {
    resetDiagnosticsForTest();
  });

  it('returns empty snapshot when no frames reported', () => {
    const snap = diagnostics.snapshot();
    expect(snap.framesProcessed).toBe(0);
    expect(snap.framesDropped).toBe(0);
    expect(snap.medianFrameMs).toBe(0);
    expect(snap.p95FrameMs).toBe(0);
    expect(snap.cpuDegradeCount).toBe(0);
    expect(snap.errors).toEqual([]);
  });

  it('accumulates frame count and drops across multiple reports', () => {
    diagnostics.recordFrame(5);
    diagnostics.recordFrame(7);
    diagnostics.recordFrame(9);
    diagnostics.recordDrop();
    diagnostics.recordDrop();

    const snap = diagnostics.snapshot();
    expect(snap.framesProcessed).toBe(3);
    expect(snap.framesDropped).toBe(2);
  });

  it('computes median correctly for odd-length samples', () => {
    for (const v of [10, 2, 4, 8, 6]) diagnostics.recordFrame(v);
    const snap = diagnostics.snapshot();
    expect(snap.medianFrameMs).toBe(6);
  });

  it('computes median correctly for even-length samples', () => {
    for (const v of [1, 2, 3, 4]) diagnostics.recordFrame(v);
    const snap = diagnostics.snapshot();
    // median of [1,2,3,4] = (2+3)/2 = 2.5
    expect(snap.medianFrameMs).toBeCloseTo(2.5, 5);
  });

  it('computes p95 from nearest-rank ordering', () => {
    for (let i = 1; i <= 100; i++) diagnostics.recordFrame(i);
    const snap = diagnostics.snapshot();
    // nearest-rank p95 on 1..100 = 95
    expect(snap.p95FrameMs).toBe(95);
  });

  it('bounds the frame time ring to prevent unbounded growth', () => {
    // Push more than the ring capacity, then verify snapshot is still coherent.
    for (let i = 0; i < 10_000; i++) {
      diagnostics.recordFrame(i % 50);
    }
    const snap = diagnostics.snapshot();
    expect(snap.framesProcessed).toBe(10_000);
    // median should be finite and within observed range
    expect(snap.medianFrameMs).toBeGreaterThanOrEqual(0);
    expect(snap.medianFrameMs).toBeLessThan(50);
  });

  it('records errors into a bounded ring of 10', () => {
    for (let i = 0; i < 15; i++) {
      diagnostics.recordError(`err-${i}`);
    }
    const snap = diagnostics.snapshot();
    expect(snap.errors).toHaveLength(10);
    // Most recent last; oldest kept = err-5
    expect(snap.errors[0]?.message).toBe('err-5');
    expect(snap.errors[9]?.message).toBe('err-14');
  });

  it('attaches a timestamp to each error entry', () => {
    const before = Date.now();
    diagnostics.recordError('boom');
    const snap = diagnostics.snapshot();
    expect(snap.errors).toHaveLength(1);
    expect(snap.errors[0]?.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('counts CPU degrade trigger events', () => {
    diagnostics.recordCpuDegrade();
    diagnostics.recordCpuDegrade();
    diagnostics.recordCpuDegrade();
    const snap = diagnostics.snapshot();
    expect(snap.cpuDegradeCount).toBe(3);
  });

  it('resets all state via resetDiagnosticsForTest', () => {
    diagnostics.recordFrame(5);
    diagnostics.recordDrop();
    diagnostics.recordError('x');
    diagnostics.recordCpuDegrade();

    resetDiagnosticsForTest();

    const snap: DiagnosticsSnapshot = diagnostics.snapshot();
    expect(snap.framesProcessed).toBe(0);
    expect(snap.framesDropped).toBe(0);
    expect(snap.errors).toEqual([]);
    expect(snap.cpuDegradeCount).toBe(0);
    expect(snap.medianFrameMs).toBe(0);
    expect(snap.p95FrameMs).toBe(0);
  });

  it('snapshot is an immutable copy — mutating it does not affect state', () => {
    diagnostics.recordFrame(3);
    diagnostics.recordError('e1');
    const snap = diagnostics.snapshot();
    snap.errors.push({ timestamp: 0, message: 'injected' });
    const snap2 = diagnostics.snapshot();
    expect(snap2.errors).toHaveLength(1);
    expect(snap2.errors[0]?.message).toBe('e1');
  });
});
