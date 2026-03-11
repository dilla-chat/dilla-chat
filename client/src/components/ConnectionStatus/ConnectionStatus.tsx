import { useEffect, useState, useRef, useCallback } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { ws } from '../../services/websocket';
import './ConnectionStatus.css';

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

  // Periodic WS ping
  useEffect(() => {
    pingServer();
    intervalRef.current = setInterval(pingServer, PING_INTERVAL);
    return () => clearInterval(intervalRef.current!);
  }, [pingServer]);

  const bars = qualityBars(state.quality);
  const label = qualityLabel(state.quality);

  return (
    <div
      className={`connection-status connection-status--${state.quality}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div className="connection-status__bars">
        {[1, 2, 3, 4].map(i => (
          <div
            key={i}
            className={`connection-status__bar connection-status__bar--${i} ${i <= bars ? 'active' : ''}`}
          />
        ))}
      </div>

      {showTooltip && (
        <div className="connection-status__tooltip">
          <div className="connection-status__tooltip-title">Connection Info</div>
          <div className="connection-status__tooltip-row">
            <span>Quality</span>
            <span className={`connection-status__quality-badge connection-status__quality-badge--${state.quality}`}>
              {label}
            </span>
          </div>
          <div className="connection-status__tooltip-row">
            <span>Latency</span>
            <span>{state.latency !== null ? `${state.latency} ms` : '—'}</span>
          </div>
          <div className="connection-status__tooltip-row">
            <span>WebSocket</span>
            <span>{state.wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
