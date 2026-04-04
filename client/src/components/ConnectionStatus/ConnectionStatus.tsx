import { useEffect, useState, useRef, useCallback } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { ws } from '../../services/websocket';

type Quality = 'excellent' | 'good' | 'poor' | 'disconnected';

interface ConnectionState {
  wsConnected: boolean;
  latency: number | null;
  quality: Quality;
}

const PING_INTERVAL = 10_000;

function getQuality(latency: number | null, wsConnected: boolean): Quality {
  if (!wsConnected) return 'disconnected';
  if (latency === null) return 'good';
  if (latency < 80) return 'excellent';
  if (latency < 200) return 'good';
  return 'poor';
}

function qualityLabel(q: Quality): string {
  switch (q) {
    case 'excellent': return 'Excellent';
    case 'good': return 'Good';
    case 'poor': return 'Poor';
    case 'disconnected': return 'Disconnected';
  }
}

function qualityBars(q: Quality): number {
  switch (q) {
    case 'excellent': return 4;
    case 'good': return 3;
    case 'poor': return 2;
    case 'disconnected': return 0;
  }
}

const qualityColorClass: Record<Quality, string> = {
  excellent: 'text-success',
  good: 'text-success',
  poor: 'text-foreground-warning',
  disconnected: 'text-foreground-danger',
};

const badgeClasses: Record<Quality, string> = {
  excellent: 'bg-success-a15 text-success',
  good: 'bg-success-a15 text-success',
  poor: 'bg-accent-a20 text-foreground-warning',
  disconnected: 'bg-danger-a15 text-foreground-danger',
};

const barHeights = ['h-1', 'h-[7px]', 'h-2.5', 'h-3.5'] as const;

export default function ConnectionStatus() {
  const { activeTeamId } = useTeamStore();
  const [state, setState] = useState<ConnectionState>({
    wsConnected: false,
    latency: null,
    quality: 'disconnected',
  });
  const [showTooltip, setShowTooltip] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null);

  const pingServer = useCallback(async () => {
    if (!activeTeamId) return;
    if (!ws.isConnected(activeTeamId)) {
      setState(prev => ({ ...prev, wsConnected: false, quality: 'disconnected', latency: null }));
      return;
    }
    try {
      const latency = await ws.ping(activeTeamId);
      setState({
        wsConnected: true,
        latency,
        quality: getQuality(latency, true),
      });
    } catch {
      setState(prev => ({
        ...prev,
        wsConnected: ws.isConnected(activeTeamId),
        latency: null,
        quality: ws.isConnected(activeTeamId) ? 'poor' : 'disconnected',
      }));
    }
  }, [activeTeamId]);

  // WS connection events
  useEffect(() => {
    const onConnected = () => {
      setState(prev => ({ ...prev, wsConnected: true, quality: getQuality(prev.latency, true) }));
    };
    const onDisconnected = () => {
      setState({ wsConnected: false, quality: 'disconnected', latency: null });
    };
    const unsub1 = ws.on('ws:connected', onConnected);
    const unsub2 = ws.on('ws:disconnected', onDisconnected);
    return () => { unsub1(); unsub2(); };
  }, []);

  // Periodic WS ping (fires immediately then every PING_INTERVAL)
  useEffect(() => {
    const id = setTimeout(pingServer, 0);
    intervalRef.current = setInterval(pingServer, PING_INTERVAL);
    return () => {
      clearTimeout(id);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [pingServer]);

  const bars = qualityBars(state.quality);
  const label = qualityLabel(state.quality);

  return (
    <output
      className={`flex items-center gap-1.5 px-2.5 py-2 bg-surface-secondary border-t border-divider cursor-default relative select-none text-micro ${qualityColorClass[state.quality]}`}
      aria-label={`Connection quality: ${label}`}
      data-testid="connection-status"
      data-quality={state.quality}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div className="flex items-end gap-[1.5px] h-3.5">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className={`w-[3px] rounded-[1px] transition-colors duration-200 ${barHeights[i]} ${i < bars ? 'connection-bar active' : 'connection-bar'}`}
            data-testid="connection-bar"
            data-active={i < bars}
          />
        ))}
      </div>

      {showTooltip && (
        <div className="absolute bottom-[calc(100%+8px)] left-2 w-[220px] bg-glass-floating backdrop-blur-glass-heavy border border-glass-border rounded-lg p-3 z-[1000] pointer-events-none">
          <div className="text-micro font-medium uppercase tracking-wide text-foreground-muted mb-2 tracking-[0.04em]">Connection Info</div>
          <div className="flex justify-between items-center py-[3px] text-xs text-foreground-muted">
            <span>Quality</span>
            <span className={`text-micro px-1.5 py-px rounded-sm font-semibold ${badgeClasses[state.quality]}`}>
              {label}
            </span>
          </div>
          <div className="flex justify-between items-center py-[3px] text-xs text-foreground-muted" data-testid="tooltip-latency">
            <span>Latency</span>
            <span className="text-foreground font-medium">{state.latency === null ? '—' : `${state.latency} ms`}</span>
          </div>
          <div className="flex justify-between items-center py-[3px] text-xs text-foreground-muted">
            <span>WebSocket</span>
            <span className="text-foreground font-medium">{state.wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      )}
    </output>
  );
}
