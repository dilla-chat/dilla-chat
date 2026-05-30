import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MiniMeter, StatsSparkline, VoiceDockLatency, VoiceDockBitrate } from './VoiceDockStats';
import { useVoiceStore } from '../stores/voiceStore';

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
  }
  observe() { /* noop */ }
  disconnect() { /* noop */ }
  unobserve() { /* noop */ }
}
(globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver = FakeResizeObserver;

describe('MiniMeter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders 4 bars', () => {
    const { container } = render(<MiniMeter />);
    expect(container.querySelectorAll('.mm-bar').length).toBe(4);
  });

  it('animates bar heights over time (tick updates state)', () => {
    const { container } = render(<MiniMeter />);
    const before = [...container.querySelectorAll('.mm-bar')].map((b) => (b as HTMLElement).style.height);
    act(() => { vi.advanceTimersByTime(300); });
    const after = [...container.querySelectorAll('.mm-bar')].map((b) => (b as HTMLElement).style.height);
    // At least one bar's height should differ across ticks.
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });
});

describe('StatsSparkline', () => {
  function basicProps(overrides: Partial<Parameters<typeof StatsSparkline>[0]> = {}) {
    return {
      label: 'latency',
      unit: 'ms',
      samples: [10, 15, 25],
      floor: 30,
      tone: (v: number) => (v < 20 ? 'ok' : v < 35 ? 'warn' : 'bad') as 'ok' | 'warn' | 'bad',
      title: (c: number | null) => (c != null ? `current ${c}ms` : 'idle'),
      ...overrides,
    };
  }

  it('shows the most recent sample as the current readout', () => {
    const { container } = render(<StatsSparkline {...basicProps()} />);
    expect(container.querySelector('.vd-spark-cur')?.textContent).toContain('25');
  });

  it('renders the unit suffix', () => {
    const { container } = render(<StatsSparkline {...basicProps()} />);
    expect(container.querySelector('.vd-u')?.textContent).toBe('ms');
  });

  it('shows "0" when samples is empty (no current value)', () => {
    const { container } = render(<StatsSparkline {...basicProps({ samples: [] })} />);
    const cur = container.querySelector('.vd-spark-cur');
    expect(cur?.textContent).toContain('0');
  });

  it('uses the idle tone class when no samples are present', () => {
    const { container } = render(<StatsSparkline {...basicProps({ samples: [] })} />);
    expect(container.querySelector('.vd-spark-idle')).toBeTruthy();
  });

  it('uses the tone callback to colour the current readout', () => {
    const { container: ok } = render(<StatsSparkline {...basicProps({ samples: [10] })} />);
    expect(ok.querySelector('.vd-spark-ok')).toBeTruthy();
    const { container: warn } = render(<StatsSparkline {...basicProps({ samples: [25] })} />);
    expect(warn.querySelector('.vd-spark-warn')).toBeTruthy();
    const { container: bad } = render(<StatsSparkline {...basicProps({ samples: [50] })} />);
    expect(bad.querySelector('.vd-spark-bad')).toBeTruthy();
  });

  it('renders a title attribute from the title() callback', () => {
    const { container } = render(<StatsSparkline {...basicProps()} />);
    expect(container.querySelector('.vd-spark')?.getAttribute('title')).toContain('current 25');
  });
});

describe('VoiceDockLatency', () => {
  beforeEach(() => {
    useVoiceStore.setState({ latencySamples: [] } as never);
  });

  it('reads latencySamples from voiceStore', () => {
    useVoiceStore.setState({ latencySamples: [12, 18, 30] } as never);
    const { container } = render(<VoiceDockLatency />);
    expect(container.textContent).toContain('30');
    expect(container.textContent).toContain('ms');
  });

  it('uses lower-is-better tone thresholds: <20 ok', () => {
    useVoiceStore.setState({ latencySamples: [10] } as never);
    const { container } = render(<VoiceDockLatency />);
    expect(container.querySelector('.vd-spark-ok')).toBeTruthy();
  });

  it('uses warn tone at 20-34ms', () => {
    useVoiceStore.setState({ latencySamples: [25] } as never);
    const { container } = render(<VoiceDockLatency />);
    expect(container.querySelector('.vd-spark-warn')).toBeTruthy();
  });

  it('uses bad tone at >=35ms', () => {
    useVoiceStore.setState({ latencySamples: [60] } as never);
    const { container } = render(<VoiceDockLatency />);
    expect(container.querySelector('.vd-spark-bad')).toBeTruthy();
  });
});

describe('VoiceDockBitrate', () => {
  beforeEach(() => {
    useVoiceStore.setState({ bitrateSamples: [] } as never);
  });

  it('reads bitrateSamples from voiceStore', () => {
    useVoiceStore.setState({ bitrateSamples: [24] } as never);
    const { container } = render(<VoiceDockBitrate />);
    expect(container.textContent).toContain('24');
    expect(container.textContent).toContain('kbps');
  });

  it('uses higher-is-better thresholds: >=16 ok', () => {
    useVoiceStore.setState({ bitrateSamples: [20] } as never);
    const { container } = render(<VoiceDockBitrate />);
    expect(container.querySelector('.vd-spark-ok')).toBeTruthy();
  });

  it('uses warn tone at 8-15kbps', () => {
    useVoiceStore.setState({ bitrateSamples: [10] } as never);
    const { container } = render(<VoiceDockBitrate />);
    expect(container.querySelector('.vd-spark-warn')).toBeTruthy();
  });

  it('uses bad tone at <8kbps', () => {
    useVoiceStore.setState({ bitrateSamples: [4] } as never);
    const { container } = render(<VoiceDockBitrate />);
    expect(container.querySelector('.vd-spark-bad')).toBeTruthy();
  });
});
