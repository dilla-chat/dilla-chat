import { Component, type ReactNode } from 'react';
import { recordException } from '../../services/telemetry';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  error: Error | null;
}

export default class ContentErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    recordException(error, 'ContentErrorBoundary');
  }

  render() {
    if (this.state.error) {
      return (
        <div className="content-error-boundary">
          <p style={{ color: 'var(--text-danger)', fontWeight: 500 }}>
            {this.props.fallbackLabel ?? 'This section encountered an error.'}
          </p>
          <pre
            style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              whiteSpace: 'pre-wrap',
              maxHeight: 120,
              overflow: 'auto',
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: '0.5rem',
              padding: '0.25rem 0.75rem',
              cursor: 'pointer',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              fontSize: '0.8125rem',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
