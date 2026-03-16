import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';
import './FederationStatus.css';

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

export default function FederationStatus({ teamId }: { teamId: string }) {
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
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
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

  const statusClass = (s: string) => {
    switch (s) {
      case 'connected':
        return 'connected';
      case 'syncing':
        return 'syncing';
      default:
        return 'disconnected';
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
    <div className="federation-status">
      <h2>{t('federation.title')}</h2>

      {error && <div className="settings-error">{error}</div>}

      {/* Node Information */}
      {status && (
        <div className="federation-node-info">
          <h3>{t('federation.nodeInfo')}</h3>
          <div className="node-info-grid">
            <span className="node-info-label">{t('federation.nodeName')}</span>
            <span className="node-info-value">{status.node_name}</span>
            <span className="node-info-label">{t('federation.lamportTimestamp')}</span>
            <span className="node-info-value">{status.lamport_ts}</span>
          </div>
        </div>
      )}

      {/* Connected Peers */}
      <div className="federation-peers">
        <h3>{t('federation.connectedPeers')}</h3>
        {total > 0 && (
          <div className="federation-mesh-summary">
            {t('federation.meshSummary', { total, connected, disconnected })}
          </div>
        )}
        {total === 0 ? (
          <div className="federation-no-peers">{t('federation.noPeers')}</div>
        ) : (
          <table className="federation-peer-table">
            <thead>
              <tr>
                <th>{t('federation.peerName')}</th>
                <th>{t('federation.peerAddress')}</th>
                <th>{t('federation.peerStatus')}</th>
                <th>{t('federation.peerLastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => (
                <tr key={peer.name}>
                  <td>{peer.name}</td>
                  <td>{peer.address}</td>
                  <td>
                    <span className="peer-status-indicator">
                      <span className={`peer-status-dot ${statusClass(peer.status)}`} />
                      {statusLabel(peer.status)}
                    </span>
                  </td>
                  <td>{formatLastSeen(peer.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Join Token Generator */}
      <div className="federation-join">
        <h3>{t('federation.joinCommand')}</h3>
        <button
          className="federation-generate-btn"
          onClick={handleGenerateToken}
          disabled={generating}
        >
          {generating ? '...' : t('federation.generateJoinToken')}
        </button>

        {joinToken && (
          <div className="federation-join-result">
            <p className="federation-join-help">{t('federation.joinCommandHelp')}</p>
            <div className="federation-command-block">
              {joinToken.join_command}
              <button
                className={`federation-copy-btn ${copiedField === 'join' ? 'copied' : ''}`}
                onClick={() => copyToClipboard(joinToken.join_command, 'join')}
              >
                {copiedField === 'join' ? t('federation.copied') : t('federation.copyToClipboard')}
              </button>
            </div>

            <p className="federation-curl-label">{t('federation.curlOneLiner')}</p>
            <div className="federation-command-block">
              {curlOneLiner}
              <button
                className={`federation-copy-btn ${copiedField === 'curl' ? 'copied' : ''}`}
                onClick={() => copyToClipboard(curlOneLiner, 'curl')}
              >
                {copiedField === 'curl' ? t('federation.copied') : t('federation.copyToClipboard')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="federation-auto-refresh">{t('federation.autoRefresh')}</div>
    </div>
  );
}
