import { useMeshStore } from '../../stores/meshStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useServerConfig } from '../../hooks/useServerConfig';
import { isCryptoInitialized } from '../../services/crypto';
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
  let dbLabel: string;
  let dbTitle: string;
  if (dbEncrypted === null) {
    dbLabel = 'CHECKING…';
    dbTitle = 'Waiting for server config…';
  } else if (dbEncrypted) {
    dbLabel = 'SQLCIPHER · AES-256';
    dbTitle = 'SQLCipher at-rest encryption is active on the server.';
  } else {
    dbLabel = 'PLAIN SQLITE · UNENCRYPTED';
    dbTitle = 'Server is running without DILLA_DB_PASSPHRASE (--insecure). The DB file on disk is plain SQLite.';
  }

  // e2e chip: only claim Signal/X3DH/AES-256-GCM when crypto is actually
  // initialized for this session. Pre-unlock (no derivedKey) or before
  // initCrypto runs, surface the real state instead of misleading the
  // user.
  const derivedKey = useAuthStore((s) => s.derivedKey);
  let e2eState: 'active' | 'initializing' | 'locked';
  if (!derivedKey) {
    e2eState = 'locked';
  } else if (isCryptoInitialized()) {
    e2eState = 'active';
  } else {
    e2eState = 'initializing';
  }
  let e2eLabel: string;
  let e2eTitle: string;
  if (e2eState === 'active') {
    e2eLabel = 'SIGNAL · X3DH · AES-256-GCM';
    e2eTitle = 'X3DH key agreement + Double Ratchet, AES-256-GCM AEAD. Click for encryption details.';
  } else if (e2eState === 'initializing') {
    e2eLabel = 'INITIALIZING…';
    e2eTitle = 'Identity unlocked; crypto manager booting…';
  } else {
    e2eLabel = 'LOCKED';
    e2eTitle = 'No derived key in this session — messages cannot be decrypted until you unlock.';
  }

  return (
    <div className="mesh-bottom" role="contentinfo" aria-label="Mesh bottom bar">
      <button
        type="button"
        className="mb-chunk mb-clickable"
        title="Click for federation settings"
        onClick={() =>
          globalThis.dispatchEvent(new CustomEvent('mesh:open-federation'))
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
              globalThis.dispatchEvent(new CustomEvent('mesh:open-federation'))
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
        className={
          'mb-chunk mb-clickable' + (e2eState === 'locked' ? ' mb-warn' : '')
        }
        title={e2eTitle}
        onClick={() =>
          globalThis.dispatchEvent(new CustomEvent('mesh:open-privacy'))
        }
      >
        <span className="mb-k">e2e</span> {e2eLabel}
      </button>

      {voiceConnected ? (
        <button
          type="button"
          className="mb-chunk mb-voice mb-clickable"
          title="Click for voice settings"
          onClick={() =>
            globalThis.dispatchEvent(new CustomEvent('mesh:open-voice-settings'))
          }
        >
          <span className="mb-k">voice</span> SRTP · OPUS 48kHz @ 96kbps
        </button>
      ) : (
        <div
          className={'mb-chunk' + (dbEncrypted === false ? ' mb-warn' : '')}
          title={dbTitle}
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
