// Voice-dock stats primitives — extracted from ChatApp.tsx.
//
// Four small, dependency-light components that the voice dock + its
// per-card UI lean on:
//
//   - MiniMeter         — 4-bar animated voice-level meter on each
//                         speaking voice card.
//   - StatsSparkline    — shared bar-chart shape with auto-fit bar
//                         count and tone-coloured current readout.
//                         The dock's latency + bitrate rows render
//                         this with metric-specific thresholds.
//   - VoiceDockLatency  — RTT samples from useVoiceStore.latencySamples.
//   - VoiceDockBitrate  — outbound audio bitrate samples from
//                         useVoiceStore.bitrateSamples.
//
// All four were private to ChatApp.tsx (6107 lines) and only used at
// three call sites in the same file; pulling them out drops ~120
// lines from that catch-all and gives the voice dock a sensible
// module boundary for further extraction.

import { useEffect, useRef, useState } from 'react';
import { useVoiceStore } from '../stores/voiceStore';

/** Tiny 4-bar animated voice meter. Rendered next to a voice card's
 *  name when the SFU reports that user as currently speaking. The
 *  bars use a deterministic sin-driven height so the animation
 *  reads as activity without needing live RTP-level samples. */
export function MiniMeter() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), 140);
    return () => clearInterval(id);
  }, []);
  function v(i: number) {
    return 0.3 + Math.abs(Math.sin(t * 0.7 + i * 1.3)) * 0.7;
  }
  return (
    <span className="mini-meter">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="mm-bar" style={{ height: 3 + Math.round(v(i) * 6) }} />
      ))}
    </span>
  );
}

// Voice-dock stats sparkline — shared design used for both latency
// and bitrate. Bar count is derived dynamically from the graph's
// rendered width so the bars + inter-bar gaps always tile the
// container exactly, with no "looks the same again" fusing in narrow
// docks or wasted space in wide ones. `tone` returns ok/warn/bad
// based on a metric-specific threshold so the same color language
// reads correctly in both directions (lower-better for latency,
// higher-better for bitrate).
const SPARK_BAR_PX = 4; // target bar width
const SPARK_GAP_PX = 4; // visual gap between bars (matches .vd-spark-graph gap)

export type SparkTone = 'ok' | 'warn' | 'bad';

export function StatsSparkline({
  label,
  unit,
  samples,
  floor,
  tone,
  title,
}: {
  label: string;
  unit: string;
  samples: number[];
  floor: number;
  tone: (v: number) => SparkTone;
  title: (current: number | null) => string;
}) {
  const graphRef = useRef<HTMLDivElement | null>(null);
  const [barCount, setBarCount] = useState(0);

  // Recompute how many (barPx + gapPx) units fit each time the graph
  // resizes (sidebar resize, dock width changes, font scale shifts).
  useEffect(() => {
    const el = graphRef.current;
    if (!el) return;
    const recompute = () => {
      const w = el.clientWidth;
      if (!w) return;
      // n bars take n*bar + (n-1)*gap = (bar+gap)*n - gap pixels.
      // Solve for max n with the inequality (bar+gap)*n - gap <= w.
      const n = Math.max(1, Math.floor((w + SPARK_GAP_PX) / (SPARK_BAR_PX + SPARK_GAP_PX)));
      setBarCount(n);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const current = samples.length ? samples[samples.length - 1] : null;
  const max = Math.max(...samples, floor);
  const currentTone: SparkTone | 'idle' = current != null ? tone(current) : 'idle';
  // Show only the most recent `barCount` samples; pad the head with
  // idle slots so the graph fills from the right while still showing
  // its frame on first paint.
  const display: Array<number | null> = [];
  const recent = samples.slice(-barCount);
  for (let i = 0; i < barCount - recent.length; i++) display.push(null);
  for (const s of recent) display.push(s);
  return (
    <div className="vd-spark" title={title(current)}>
      <div className="vd-spark-head">
        <span className="vd-k">{label}</span>
        <span className={'vd-spark-cur vd-spark-' + currentTone}>
          {current ?? 0}
          <span className="vd-u">{unit}</span>
        </span>
      </div>
      <div className="vd-spark-graph" ref={graphRef}>
        {display.map((v, i) => {
          const t = v == null ? 'idle' : tone(v);
          const pct = v == null ? 0 : (v / max) * 100;
          return (
            <span
              key={i}
              className={'vd-spark-bar vd-spark-' + t}
              style={{ width: `${SPARK_BAR_PX}px`, height: pct ? `${pct}%` : undefined }}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Latency sparkline — lower-is-better. Thresholds: <20ms OK,
 *  <35ms warn, ≥35ms bad. */
export function VoiceDockLatency() {
  const samples = useVoiceStore((s) => s.latencySamples);
  return (
    <StatsSparkline
      label="latency"
      unit="ms"
      samples={samples}
      floor={30}
      tone={(v) => (v < 20 ? 'ok' : v < 35 ? 'warn' : 'bad')}
      title={(c) => (c != null ? `live latency · current ${c}ms` : 'measuring latency…')}
    />
  );
}

/** Bitrate sparkline — higher-is-better. Opus voice typically sits
 *  16-32 kbps; drops below ~8 mean muted, DTX silence, or
 *  network-throttled. */
export function VoiceDockBitrate() {
  const samples = useVoiceStore((s) => s.bitrateSamples);
  return (
    <StatsSparkline
      label="bitrate"
      unit="kbps"
      samples={samples}
      floor={32}
      tone={(v) => (v >= 16 ? 'ok' : v >= 8 ? 'warn' : 'bad')}
      title={(c) => (c != null ? `outbound audio · current ${c}kbps` : 'measuring bitrate…')}
    />
  );
}
