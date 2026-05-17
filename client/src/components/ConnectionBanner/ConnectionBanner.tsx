import { useMeshStore } from '../../stores/meshStore';
import './ConnectionBanner.css';

const KIND_LABEL: Record<string, string> = {
  reconnecting: 'RECONNECTING',
  offline: 'OFFLINE',
  restored: 'CONNECTION RESTORED',
  error: 'CONNECTION ERROR',
};

export default function ConnectionBanner() {
  const { connectionBanner, hideConnectionBanner } = useMeshStore();

  if (!connectionBanner) return null;

  return (
    <div
      className={`connection-banner connection-banner-${connectionBanner.kind}`}
      role="alert"
      aria-live="polite"
    >
      <span className="connection-banner-label">
        {KIND_LABEL[connectionBanner.kind] ?? connectionBanner.kind.toUpperCase()}
      </span>
      <span className="connection-banner-message">
        {connectionBanner.message}
      </span>
      <button
        type="button"
        className="connection-banner-close"
        aria-label="Dismiss"
        onClick={hideConnectionBanner}
      >
        ×
      </button>
    </div>
  );
}
