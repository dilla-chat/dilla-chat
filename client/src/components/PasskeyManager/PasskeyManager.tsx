import { useState, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import {
  registerPasskey,
  prfOutputToBase64,
} from '../../services/webauthn';
import {
  getCredentialInfo,
  exportIdentityBlob,
  encodeRecoveryKey as encodeRecoveryKeyKS,
  generateRecoveryKey as generateRecoveryKeyBytes,
} from '../../services/keyStore';

interface CredentialInfo {
  credentials: { id: string; name: string; created_at: string }[];
  prfSalt: Uint8Array;
}

export default function PasskeyManager() {
  const { derivedKey, setCredentialIds } = useAuthStore();
  const [credInfo, setCredInfo] = useState<CredentialInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [newRecoveryKey, setNewRecoveryKey] = useState('');

  const loadCredentials = async () => {
    try {
      const info = await getCredentialInfo();
      if (info) {
        setCredInfo(info);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    loadCredentials();
  }, []);

  const handleAddPasskey = async () => {
    if (!credInfo?.prfSalt || !derivedKey) return;
    setError('');
    setLoading(true);

    try {
      const username = localStorage.getItem('dilla_username') ?? 'user';
      const userId = new TextEncoder().encode(username.padEnd(32, '\0').slice(0, 32));

      const result = await registerPasskey(username, userId, credInfo.prfSalt);
      // Compute new derived key (used for re-wrapping in future)
      prfOutputToBase64(result.prfOutput);

      const updated = [
        ...credInfo.credentials,
        { id: result.credentialId, name: result.credentialName, created_at: String(Date.now()) },
      ];

      setCredInfo({ ...credInfo, credentials: updated });
      setCredentialIds(updated.map((c) => c.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerateRecovery = async () => {
    setError('');
    try {
      // Generate new recovery key and re-encode for display
      // Note: A full implementation would re-wrap the MEK with the new recovery key
      const newKey = generateRecoveryKeyBytes();
      setNewRecoveryKey(encodeRecoveryKeyKS(newKey));
      setShowRecoveryKey(true);

      // Re-upload identity blob to all known servers
      const blob = await exportIdentityBlob();
      if (!blob) return;
      const { teams } = useAuthStore.getState();
      const allServers: string[] = [];
      teams.forEach((entry) => {
        if (entry.baseUrl) allServers.push(entry.baseUrl);
      });
      for (const [, entry] of teams.entries()) {
        if (!entry.baseUrl || !entry.token) continue;
        try {
          await fetch(`${entry.baseUrl}/api/v1/identity/blob`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${entry.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ blob, servers: allServers }),
          });
        } catch (e) {
          console.warn(`Blob upload to ${entry.baseUrl} failed:`, e);
        }
      }
    } catch (e) {
      setError(String(e));
    }
  };

  if (!credInfo) return null;

  return (
    <div className="py-6">
      <h3 className="m-0 mb-4 text-[15px] font-semibold text-heading">Passkey Management</h3>

      <div className="mb-4">
        {credInfo.credentials.length === 0 ? (
          <p className="text-foreground-muted text-sm opacity-60">No passkeys registered</p>
        ) : (
          credInfo.credentials.map((cred, i) => (
            <div key={cred.id || i} className="flex items-center justify-between px-4 py-2 bg-input rounded-md mb-1">
              <span className="font-medium text-foreground text-base">{cred.name || 'Passkey'}</span>
              <span className="text-foreground-muted mono">
                {cred.id?.slice(0, 12)}...
              </span>
            </div>
          ))
        )}
      </div>

      {error && <p className="text-foreground-danger text-sm mt-2">{error}</p>}

      <div className="flex gap-2 flex-wrap">
        <button onClick={handleAddPasskey} disabled={loading} className="px-6 py-2 text-sm">
          {loading ? 'Adding...' : 'Add Another Passkey'}
        </button>
        <button
          onClick={handleRegenerateRecovery}
          className="px-6 py-2 text-sm bg-transparent border border-divider"
        >
          Regenerate Recovery Key
        </button>
      </div>

      {showRecoveryKey && newRecoveryKey && (
        <div className="mt-6 p-4 bg-input rounded-md border border-divider">
          <p><strong>New Recovery Key:</strong></p>
          <code className="block font-mono text-sm break-all p-2 bg-surface-secondary rounded-sm mt-1.5 select-all">
            {newRecoveryKey}
          </code>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(newRecoveryKey);
            }}
            className="mt-2"
          >
            Copy to Clipboard
          </button>
        </div>
      )}
    </div>
  );
}
