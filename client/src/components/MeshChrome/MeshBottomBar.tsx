import { useMeshStore } from '../../stores/meshStore';
import { useVoiceStore } from '../../stores/voiceStore';
import './MeshBottomBar.css';

const APP_VERSION = '0.4.2-nightly';
const BUILD_HASH = 'c0ffee';

export default function MeshBottomBar() {
  const { nodeName, peersConnected, peersTotal, lamport, latencyMs, status } =
    useMeshStore();
  const voiceConnected = useVoiceStore((s) => s.connected);

  const peersChunk = peersTotal > 0 ? `peers ${peersConnected}/${peersTotal}` : 'peers 0/0';
  const peersDegraded = status === 'degraded';
  const peersArrow = peersDegraded ? ' ⚠' : ' ▲';

  return (
    <footer
      className="mesh-bottom-bar"
      role="contentinfo"
      aria-label="Mesh bottom bar"
    >
      <button
        type="button"
        className="mesh-bottom-bar-chunk"
        onClick={() => window.dispatchEvent(new CustomEvent('mesh:open-federation'))}
        title="Federation"
      >
        node {nodeName || 'local'}
      </button>

      <button
        type="button"
        className={`mesh-bottom-bar-chunk ${peersDegraded ? 'degraded' : ''}`}
        onClick={() => window.dispatchEvent(new CustomEvent('mesh:open-federation'))}
        title="Federation"
      >
        {peersChunk}
        <span aria-hidden="true">{peersArrow}</span>
      </button>

      <span className="mesh-bottom-bar-chunk static">
        lamport {lamport.toLocaleString('en-US')}↑
      </span>

      {!peersDegraded && (
        <span className="mesh-bottom-bar-chunk static">
          latency {latencyMs}ms p50
        </span>
      )}

      <button
        type="button"
        className="mesh-bottom-bar-chunk"
        onClick={() => window.dispatchEvent(new CustomEvent('mesh:open-privacy'))}
        title="Privacy & encryption"
      >
        e2e SIGNAL · X3DH · AES-256-GCM
      </button>

      {voiceConnected ? (
        <button
          type="button"
          className="mesh-bottom-bar-chunk"
          onClick={() => window.dispatchEvent(new CustomEvent('mesh:open-voice-settings'))}
          title="Voice & video"
        >
          voice SRTP · OPUS 48kHz @ 96kbps
        </button>
      ) : (
        <span className="mesh-bottom-bar-chunk static">
          db SQLCIPHER · AES-256
        </span>
      )}

      <span className="mesh-bottom-bar-chunk static mesh-bottom-bar-version">
        v {APP_VERSION} · build {BUILD_HASH}
      </span>
    </footer>
  );
}
