import { useMeshStore } from '../../stores/meshStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useServerConfig } from '../../hooks/useServerConfig';
import './MeshBottomBar.css';

// Injected at build time by Vite from package.json + git short SHA
// (see vite.config.ts) — keeps the displayed version honest without
// having to remember to hand-edit a constant on every release.
const APP_VERSION = __APP_VERSION__;
const BUILD_HASH = __GIT_SHA__;

export default function MeshBottomBar() {
  const { nodeName, peersConnected, peersTotal, lamport, latencyMs, status } =
    useMeshStore();
  const voiceConnected = useVoiceStore((s) => s.connected);
  const federated = status !== 'ready';
  const degraded = status === 'degraded';
  const serverConfig = useServerConfig();
  const dbEncrypted = serverConfig?.db_encrypted ?? null;
  const dbLabel =
    dbEncrypted === null
      ? 'CHECKING…'
      : dbEncrypted
        ? 'SQLCIPHER · AES-256'
        : 'PLAIN SQLITE · UNENCRYPTED';

  return (
    <div className="mesh-bottom" role="contentinfo" aria-label="Mesh bottom bar">
      <button
        type="button"
        className="mb-chunk mb-clickable"
        title="Click for federation settings"
        onClick={() =>
          window.dispatchEvent(new CustomEvent('mesh:open-federation'))
        }
      >
        <span className="mb-k">node</span> {nodeName || 'local'}
      </button>

      {federated && (
        <>
          <button
            type="button"
            className="mb-chunk mb-clickable"
            title="Click for peer status"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('mesh:open-federation'))
            }
          >
            <span className="mb-k">peers</span>{' '}
            {degraded ? (
              <span style={{ color: 'var(--warn)', fontWeight: 600 }}>
                {peersConnected}/{peersTotal || 1} ⚠
              </span>
            ) : (
              <span className="mb-ok">
                {peersConnected}/{peersTotal} ▲
              </span>
            )}
          </button>
          <div className="mb-chunk">
            <span className="mb-k">lamport</span> {lamport.toLocaleString('en-US')}↑
          </div>
          <div className="mb-chunk">
            <span className="mb-k">latency</span>{' '}
            {degraded ? '—' : `${latencyMs}ms p50`}
          </div>
        </>
      )}

      <button
        type="button"
        className="mb-chunk mb-clickable"
        title="Click for encryption details"
        onClick={() =>
          window.dispatchEvent(new CustomEvent('mesh:open-privacy'))
        }
      >
        <span className="mb-k">e2e</span> SIGNAL · X3DH · AES-256-GCM
      </button>

      {voiceConnected ? (
        <button
          type="button"
          className="mb-chunk mb-voice mb-clickable"
          title="Click for voice settings"
          onClick={() =>
            window.dispatchEvent(new CustomEvent('mesh:open-voice-settings'))
          }
        >
          <span className="mb-k">voice</span> SRTP · OPUS 48kHz @ 96kbps
        </button>
      ) : (
        <div
          className={'mb-chunk' + (dbEncrypted === false ? ' mb-warn' : '')}
          title={
            dbEncrypted === false
              ? 'Server is running without DILLA_DB_PASSPHRASE (--insecure). The DB file on disk is plain SQLite.'
              : dbEncrypted
                ? 'SQLCipher at-rest encryption is active on the server.'
                : 'Waiting for server config…'
          }
        >
          <span className="mb-k">db</span> {dbLabel}
        </div>
      )}

      <div className="mb-chunk mb-grow" />
      <div className="mb-chunk">
        <span className="mb-k">v</span> {APP_VERSION} · build {BUILD_HASH}
      </div>
    </div>
  );
}
