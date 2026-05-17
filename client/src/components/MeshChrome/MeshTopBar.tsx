import { useEffect, useState } from 'react';
import { useMeshStore } from '../../stores/meshStore';
import { useLayoutStore } from '../../stores/layoutStore';
import './MeshTopBar.css';

function formatClock(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusLabel(status: 'ok' | 'degraded' | 'ready'): string {
  if (status === 'degraded') return '● MESH DEGRADED';
  if (status === 'ok') return '● MESH OK';
  return '● READY';
}

export default function MeshTopBar() {
  const { nodeName, status } = useMeshStore();
  const toggleTopBar = useLayoutStore((s) => s.toggleTopBar);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const statusClass =
    status === 'degraded'
      ? 'mesh-top-bar-status degraded'
      : status === 'ok'
        ? 'mesh-top-bar-status ok'
        : 'mesh-top-bar-status ready';

  return (
    <header className="mesh-top-bar" role="banner" aria-label="Mesh top bar">
      <div className="mesh-top-bar-section left">
        <span className="mesh-brand-mark" aria-hidden="true">
          <span className="mesh-brand-tile">D</span>
          <span className="mesh-brand-word">DILLA</span>
          <span className="mesh-brand-caret">_</span>
        </span>
        {nodeName && (
          <span className="mesh-top-bar-node">
            team · node {nodeName}
          </span>
        )}
        <span className={statusClass}>{statusLabel(status)}</span>
      </div>

      <div className="mesh-top-bar-section center">
        <span className="mesh-top-bar-clock" aria-label="Current time">
          {formatClock(now)}
        </span>
      </div>

      <div className="mesh-top-bar-section right">
        <button
          type="button"
          className="mesh-top-bar-keybind"
          title="Command palette"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('mesh:open-command-palette'))
          }
        >
          <kbd>⌘K</kbd>
          <span>CMD</span>
        </button>
        <button
          type="button"
          className="mesh-top-bar-keybind"
          title="Search"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('mesh:open-search'))
          }
        >
          <kbd>/</kbd>
          <span>SEARCH</span>
        </button>
        <button
          type="button"
          className="mesh-top-bar-keybind"
          title="Hide top bar"
          onClick={toggleTopBar}
        >
          <kbd>?</kbd>
          <span>HIDE</span>
        </button>
      </div>
    </header>
  );
}
