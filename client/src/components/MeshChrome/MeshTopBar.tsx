import { useEffect, useState } from 'react';
import { useMeshStore } from '../../stores/meshStore';
import { useTeamStore } from '../../stores/teamStore';
import './MeshTopBar.css';

function formatClock(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

export default function MeshTopBar() {
  const { nodeName, status } = useMeshStore();
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const teams = useTeamStore((s) => s.teams);
  const teamName = activeTeamId ? teams.get(activeTeamId)?.name ?? '' : '';
  const shortNode = nodeName ? nodeName.split('.')[0] : 'local';
  const federated = status !== 'ready';
  const degraded = status === 'degraded';

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  void tick;
  const time = formatClock(new Date());

  let statusEl;
  if (degraded) {
    statusEl = <span className="mt-warn">● MESH DEGRADED</span>;
  } else if (federated) {
    statusEl = <span className="mt-ok">● MESH OK</span>;
  } else {
    statusEl = <span className="mt-ok">● READY</span>;
  }

  return (
    <header className="mesh-top" aria-label="Mesh top bar">
      <div className="mt-left">
        <span className="mt-brand">DILLA</span>
        <span className="mt-sep">─</span>
        <span className="mt-dim">team</span>{' '}
        <span>{teamName ? teamName.toUpperCase() : 'LOCAL'}</span>
        <span className="mt-sep">─</span>
        <span className="mt-dim">node</span> <span>{shortNode}</span>
        <span className="mt-sep">─</span>
        {statusEl}
      </div>
      <div className="mt-center" aria-label="Current time">
        {time}
      </div>
      <div className="mt-right">
        <button
          type="button"
          className="mt-key"
          onClick={() =>
            globalThis.dispatchEvent(new CustomEvent('mesh:open-command-palette'))
          }
        >
          <span className="mt-kbd">⌘K</span> CMD
        </button>
        <button
          type="button"
          className="mt-key"
          onClick={() =>
            globalThis.dispatchEvent(new CustomEvent('mesh:open-search'))
          }
        >
          <span className="mt-kbd">/</span> SEARCH
        </button>
        <button
          type="button"
          className="mt-key"
          onClick={() =>
            globalThis.dispatchEvent(new CustomEvent('mesh:open-shortcuts'))
          }
        >
          <span className="mt-kbd">?</span> HELP
        </button>
      </div>
    </header>
  );
}
