import { useEffect } from 'react';
import { ws } from '../services/websocket';
import { useAuthStore } from '../stores/authStore';
import { useTeamStore } from '../stores/teamStore';
import { useMeshStore } from '../stores/meshStore';

/**
 * Syncs mesh-store state from the existing WebSocket event stream.
 *
 * Current data sources:
 * - nodeName: derived from active team's baseUrl
 * - status: 'ok' when WS is connected to active team; 'ready' otherwise
 * - lamport: ticks on every incoming `message:created` and `dm:message:created` event
 * - peersConnected/peersTotal: listens to `federation:peer-status` if the
 *   server emits it (the server has a `peer_statuses()` helper; once a
 *   broadcaster is added on the Rust side, this hook picks it up unchanged)
 * - connectionBanner: surfaces ws:connected / ws:disconnected transitions
 */
export function useMeshSync() {
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const teams = useAuthStore((s) => s.teams);

  // nodeName from active team
  useEffect(() => {
    if (!activeTeamId) {
      useMeshStore.getState().setNodeName('');
      return;
    }
    // Defensive: test mocks may pass a non-Map object through the selector.
    if (!teams || typeof (teams as { get?: unknown }).get !== 'function') return;
    const entry = teams.get(activeTeamId);
    const url = entry?.baseUrl ?? '';
    const node = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    useMeshStore.getState().setNodeName(node);
  }, [activeTeamId, teams]);

  // WS event listeners
  useEffect(() => {
    const offMsg = ws.on('message:created', () => {
      useMeshStore.getState().tickLamport();
    });
    const offDm = ws.on('dm:message:created', () => {
      useMeshStore.getState().tickLamport();
    });
    const offConn = ws.on('ws:connected', () => {
      const s = useMeshStore.getState();
      // If we had peers info, status stays in sync. Default to 'ok' on connect.
      if (s.peersTotal === 0) {
        s.setStatus('ready');
      } else if (s.peersConnected >= s.peersTotal) {
        s.setStatus('ok');
      } else {
        s.setStatus('degraded');
      }
      // Restored banner only fires if we previously had a banner of another kind.
      const prev = s.connectionBanner;
      if (prev && prev.kind !== 'restored') {
        s.showConnectionBanner({
          kind: 'restored',
          message: 'Connection restored',
        });
        setTimeout(() => useMeshStore.getState().hideConnectionBanner(), 3000);
      }
    });
    const offDisc = ws.on('ws:disconnected', () => {
      useMeshStore.getState().showConnectionBanner({
        kind: 'offline',
        message: 'Disconnected from mesh — attempting to reconnect',
      });
    });
    const offPeer = ws.on(
      'federation:peer-status',
      (data: { connected: number; total: number; degraded?: boolean }) => {
        if (typeof data?.connected !== 'number' || typeof data?.total !== 'number') return;
        useMeshStore.getState().setPeers(data.connected, data.total);
        if (data.total === 0) {
          useMeshStore.getState().setStatus('ready');
        } else if (data.degraded || data.connected < data.total) {
          useMeshStore.getState().setStatus('degraded');
        } else {
          useMeshStore.getState().setStatus('ok');
        }
      },
    );
    const offLamport = ws.on(
      'federation:lamport',
      (data: { value: number }) => {
        if (typeof data?.value !== 'number') return;
        useMeshStore.getState().setLamport(data.value);
      },
    );
    const offLatency = ws.on(
      'federation:latency',
      (data: { p50_ms: number }) => {
        if (typeof data?.p50_ms !== 'number') return;
        useMeshStore.getState().setLatency(data.p50_ms);
      },
    );

    return () => {
      offMsg?.();
      offDm?.();
      offConn?.();
      offDisc?.();
      offPeer?.();
      offLamport?.();
      offLatency?.();
    };
  }, []);
}
