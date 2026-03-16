import { useState, useEffect } from 'react';
import { cryptoService } from '../../services/crypto';

interface SafetyNumberProps {
  peerId: string;
  peerPublicKey: string;
  derivedKey: string;
}

export default function SafetyNumber({ peerId, peerPublicKey, derivedKey }: SafetyNumberProps) {
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cryptoService
      .getSafetyNumber(peerId, peerPublicKey, derivedKey)
      .then(setSafetyNumber)
      .catch((e: unknown) => setError(String(e)));
  }, [peerId, peerPublicKey, derivedKey]);

  if (error) {
    return <div style={{ color: 'var(--text-danger)', padding: '1rem' }}>Failed to generate safety number</div>;
  }

  if (!safetyNumber) {
    return <div style={{ padding: '1rem', opacity: 0.5 }}>Loading…</div>;
  }

  // Format as 12 groups of 5 digits, 4 groups per row
  const groups: string[] = [];
  for (let i = 0; i < safetyNumber.length; i += 5) {
    groups.push(safetyNumber.slice(i, i + 5));
  }

  const rows: string[][] = [];
  for (let i = 0; i < groups.length; i += 4) {
    rows.push(groups.slice(i, i + 4));
  }

  return (
    <div
      style={{
        padding: '1.5rem',
        fontFamily: 'monospace',
        textAlign: 'center',
        background: 'var(--bg-tertiary)',
        borderRadius: '8px',
        maxWidth: '320px',
      }}
    >
      <div style={{ marginBottom: '1rem', fontWeight: 600, color: 'var(--text-primary)' }}>Safety Number</div>
      <div style={{ fontSize: '1.25rem', lineHeight: '2', color: 'var(--header-primary)', letterSpacing: '0.1em' }}>
        {rows.map((row, i) => (
          <div key={i}>{row.join(' ')}</div>
        ))}
      </div>
      <p style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
        Compare this number with your contact in person or via a trusted channel. If the numbers
        match, your conversation is end-to-end encrypted and secure.
      </p>
    </div>
  );
}
