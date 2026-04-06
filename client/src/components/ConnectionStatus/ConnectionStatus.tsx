import { useEffect, useState, useRef, useCallback } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { ws } from '../../services/websocket';
import './ConnectionStatus.css';

type BarStatus = 'disconnected' | 'reconnecting' | 'connected' | 'hidden';

/** Slim top-of-content banner shown when the WS connection is lost or reconnecting.
 *  Renders nothing once "connected" flash fades. */
export function ConnectionStatusBar() {
  const { activeTeamId } = useTeamStore();
  const [status, setStatus] = useState<BarStatus>(() =>
    activeTeamId && ws.isConnected(activeTeamId) ? 'hidden' : 'disconnected',
  );
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    const onConnected = () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setStatus('connected');
      hideTimerRef.current = setTimeout(() => setStatus('hidden'), 2500);
    };
    const onDisconnected = () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      // Start as disconnected; flip to reconnecting after a brief moment
      // to avoid a flash on transient drops that resolve immediately.
      setStatus('disconnected');
      hideTimerRef.current = setTimeout(() => {
        setStatus(prev => (prev === 'disconnected' ? 'reconnecting' : prev));
      }, 1500);
    };

    const unsub1 = ws.on('ws:connected', onConnected);
    const unsub2 = ws.on('ws:disconnected', onDisconnected);
    return () => {
      unsub1();
      unsub2();
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (status === 'hidden') return null;

  const labels: Record<BarStatus, string> = {
    disconnected: 'No connection',
    reconnecting: 'Reconnecting…',
    connected: 'Back online',
    hidden: '',
  };

  return (
    <div className={`connection-status-bar ${status}`} role="status" aria-live="polite">
      <div className="connection-status-dot" aria-hidden="true" />
      <span>{labels[status]}</span>
    </div>
  );
}

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
      className={`connection-status connection-status--${state.quality}`}
      aria-label={`Connection quality: ${label}`}
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
          <div className="connection-status__tooltip-title micro">Connection Info</div>
          <div className="connection-status__tooltip-row">
            <span>Quality</span>
            <span className={`connection-status__quality-badge connection-status__quality-badge--${state.quality}`}>
              {label}
            </span>
          </div>
          <div className="connection-status__tooltip-row">
            <span>Latency</span>
            <span>{state.latency === null ? '—' : `${state.latency} ms`}</span>
          </div>
          <div className="connection-status__tooltip-row">
            <span>WebSocket</span>
            <span>{state.wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>
      )}
    </output>
  );
}
