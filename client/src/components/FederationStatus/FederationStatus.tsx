import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';

interface Peer {
  name: string;
  address: string;
  status: string;
  last_seen: string;
}

interface FederationStatusData {
  node_name: string;
  peers: Peer[];
  lamport_ts: number;
}

interface JoinTokenData {
  token: string;
  join_command: string;
}

const statusDotColor: Record<string, string> = {
  connected: 'bg-status-online',
  syncing: 'bg-status-idle',
  disconnected: 'bg-danger',
};

export default function FederationStatus({ teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<FederationStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinToken, setJoinToken] = useState<JoinTokenData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.getFederationStatus(teamId);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch federation status');
    }
  }, [teamId]);

  useEffect(() => {
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, 10_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStatus]);

  const handleGenerateToken = async () => {
    setGenerating(true);
    try {
      const data = await api.generateJoinToken(teamId);
      setJoinToken(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate join token');
    } finally {
      setGenerating(false);
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Clipboard API not available — silent failure
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    }
  };

  const peers = status?.peers ?? [];
  const connected = peers.filter((p) => p.status === 'connected').length;
  const disconnected = peers.filter((p) => p.status !== 'connected').length;
  const total = peers.length;

  const statusLabel = (s: string) => {
    switch (s) {
      case 'connected':
        return t('federation.statusConnected');
      case 'syncing':
        return t('federation.statusSyncing');
      default:
        return t('federation.statusDisconnected');
    }
  };

  const formatLastSeen = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const curlOneLiner = joinToken
    ? `curl -sSL https://get.dilla.dev | sh -s -- --join-token ${joinToken.token}`
    : '';

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-foreground-primary m-0 mb-xs">{t('federation.title')}</h2>

      {error && <div className="text-foreground-danger text-sm">{error}</div>}

      {/* Node Information */}
      {status && (
        <div className="bg-surface-secondary border border-glass-border-light rounded-lg p-lg">
          <h3 className="text-foreground-primary text-base font-semibold uppercase tracking-[0.02em] m-0 mb-md">{t('federation.nodeInfo')}</h3>
          <div className="grid grid-cols-[auto_1fr] gap-x-lg gap-y-sm items-center">
            <span className="text-foreground-muted text-sm font-medium">{t('federation.nodeName')}</span>
            <span className="text-foreground-primary font-mono text-sm">{status.node_name}</span>
            <span className="text-foreground-muted text-sm font-medium">{t('federation.lamportTimestamp')}</span>
            <span className="text-foreground-primary font-mono text-sm">{status.lamport_ts}</span>
          </div>
        </div>
      )}

      {/* Connected Peers */}
      <div className="bg-surface-secondary border border-glass-border-light rounded-lg p-lg">
        <h3 className="text-foreground-primary text-base font-semibold uppercase tracking-[0.02em] m-0 mb-md">{t('federation.connectedPeers')}</h3>
        {total > 0 && (
          <div className="text-foreground-muted text-xs mb-md">
            {t('federation.meshSummary', { total, connected, disconnected })}
          </div>
        )}
        {total === 0 ? (
          <div className="text-foreground-muted text-sm py-md">{t('federation.noPeers')}</div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left p-sm px-md border-b border-border text-micro font-medium uppercase tracking-wide text-foreground-muted">{t('federation.peerName')}</th>
                <th className="text-left p-sm px-md border-b border-border text-micro font-medium uppercase tracking-wide text-foreground-muted">{t('federation.peerAddress')}</th>
                <th className="text-left p-sm px-md border-b border-border text-micro font-medium uppercase tracking-wide text-foreground-muted">{t('federation.peerStatus')}</th>
                <th className="text-left p-sm px-md border-b border-border text-micro font-medium uppercase tracking-wide text-foreground-muted">{t('federation.peerLastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => (
                <tr key={peer.name}>
                  <td className="py-2.5 px-md text-foreground-primary text-sm border-b border-border last:border-b-0">{peer.name}</td>
                  <td className="py-2.5 px-md text-foreground-primary text-sm border-b border-border last:border-b-0">{peer.address}</td>
                  <td className="py-2.5 px-md text-sm border-b border-border last:border-b-0">
                    <span className="inline-flex items-center gap-1.5 text-sm">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor[peer.status] ?? 'bg-danger'}`} />
                      {statusLabel(peer.status)}
                    </span>
                  </td>
                  <td className="py-2.5 px-md text-foreground-primary text-sm border-b border-border last:border-b-0">{formatLastSeen(peer.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Join Token Generator */}
      <div className="bg-surface-secondary border border-glass-border-light rounded-lg p-lg">
        <h3 className="text-foreground-primary text-base font-semibold uppercase tracking-[0.02em] m-0 mb-md">{t('federation.joinCommand')}</h3>
        <button
          className="bg-[var(--gradient-accent)] text-interactive-active border border-white-overlay-light rounded-sm px-lg py-sm text-base font-medium cursor-pointer transition-[filter,box-shadow] duration-150 shadow-[0_2px_8px_var(--accent-alpha-20)] hover:brightness-110 hover:shadow-[0_4px_16px_var(--accent-alpha-30)] disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'var(--gradient-accent)' }}
          onClick={handleGenerateToken}
          disabled={generating}
        >
          {generating ? '...' : t('federation.generateJoinToken')}
        </button>

        {joinToken && (
          <div className="mt-lg flex flex-col gap-md">
            <p className="text-foreground-muted text-sm m-0">{t('federation.joinCommandHelp')}</p>
            <div className="relative bg-surface-tertiary rounded-sm p-md text-foreground-primary break-all whitespace-pre-wrap font-mono text-sm">
              {joinToken.join_command}
              <button
                className={`absolute top-2 right-2 border-none rounded-sm px-sm py-xs text-xs cursor-pointer transition-colors duration-150 ${copiedField === 'join' ? 'bg-status-online text-foreground-primary' : 'bg-border text-foreground-primary hover:bg-surface-hover'}`}
                onClick={() => copyToClipboard(joinToken.join_command, 'join')}
              >
                {copiedField === 'join' ? t('federation.copied') : t('federation.copyToClipboard')}
              </button>
            </div>

            <p className="text-foreground-muted text-xs m-0">{t('federation.curlOneLiner')}</p>
            <div className="relative bg-surface-tertiary rounded-sm p-md text-foreground-primary break-all whitespace-pre-wrap font-mono text-sm">
              {curlOneLiner}
              <button
                className={`absolute top-2 right-2 border-none rounded-sm px-sm py-xs text-xs cursor-pointer transition-colors duration-150 ${copiedField === 'curl' ? 'bg-status-online text-foreground-primary' : 'bg-border text-foreground-primary hover:bg-surface-hover'}`}
                onClick={() => copyToClipboard(curlOneLiner, 'curl')}
              >
                {copiedField === 'curl' ? t('federation.copied') : t('federation.copyToClipboard')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="text-foreground-muted text-xs tracking-[0.02em] opacity-70 text-right">{t('federation.autoRefresh')}</div>
    </div>
  );
}
