import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './FirstRunSplash.css';

interface Props {
  /** ms the splash stays fully visible before fading out. Default 1200 */
  durationMs?: number;
  onDone?: () => void;
}

const BOOT_LINES = [
  '> initialising mesh runtime',
  '> loading identity keys',
  '> verifying x3dh prekeys',
  '> connecting to peer mesh',
  '> ok',
];

export default function FirstRunSplash({ durationMs = 1200, onDone }: Readonly<Props>) {
  const [phase, setPhase] = useState<'visible' | 'fading' | 'done'>('visible');
  const [shownLines, setShownLines] = useState(1);

  useEffect(() => {
    const lineInterval = setInterval(() => {
      setShownLines((n) => Math.min(n + 1, BOOT_LINES.length));
    }, Math.max(60, Math.floor(durationMs / BOOT_LINES.length)));

    const fadeAt = setTimeout(() => setPhase('fading'), durationMs);
    const doneAt = setTimeout(() => {
      setPhase('done');
      onDone?.();
    }, durationMs + 300);

    return () => {
      clearInterval(lineInterval);
      clearTimeout(fadeAt);
      clearTimeout(doneAt);
    };
  }, [durationMs, onDone]);

  if (phase === 'done') return null;

  const body = (
    <output
      className={`first-run-splash ${phase === 'fading' ? 'fading' : ''}`}
      aria-label="Dilla starting"
    >
      <div className="first-run-splash-brand">
        <span className="first-run-splash-tile" aria-hidden="true">D</span>
        <span className="first-run-splash-word">DILLA</span>
        <span className="first-run-splash-caret">_</span>
      </div>
      <div className="first-run-splash-log" aria-live="polite">
        {BOOT_LINES.slice(0, shownLines).map((line) => (
          <div key={line} className="first-run-splash-log-line">
            {line}
          </div>
        ))}
      </div>
    </output>
  );

  return createPortal(body, document.body);
}
