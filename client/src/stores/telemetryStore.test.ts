import { describe, it, expect, beforeEach } from 'vitest';
import { useTelemetryStore } from './telemetryStore';

beforeEach(() => {
  useTelemetryStore.setState({ enabled: false });
});

describe('telemetryStore', () => {
  it('defaults to disabled', () => {
    expect(useTelemetryStore.getState().enabled).toBe(false);
  });

  it('setEnabled toggles boolean', () => {
    useTelemetryStore.getState().setEnabled(true);
    expect(useTelemetryStore.getState().enabled).toBe(true);
    useTelemetryStore.getState().setEnabled(false);
    expect(useTelemetryStore.getState().enabled).toBe(false);
  });
});
