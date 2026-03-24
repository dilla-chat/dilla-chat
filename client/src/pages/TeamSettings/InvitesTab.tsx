import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';
import type { Invite } from './types';

export default function InvitesTab({ teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [maxUses, setMaxUses] = useState<string>('0');
  const [expiry, setExpiry] = useState<string>('24');
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    api.listInvites(teamId).then((data) => setInvites(data as Invite[])).catch(() => {
      // Invite listing is non-critical; section stays empty on failure.
    });
  }, [teamId]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const maxUsesNum = Number(maxUses) || undefined;
      const expiryHours = Number(expiry) || undefined;
      const result = (await api.createInvite(teamId, maxUsesNum, expiryHours)) as { invite: Invite };
      setInvites((prev) => [result.invite, ...prev]);
    } catch {
      // Invite creation may fail due to permissions; UI stays functional.
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    try {
      await api.revokeInvite(teamId, inviteId);
      setInvites((prev) => prev.filter((i) => i.id !== inviteId));
    } catch {
      // Revocation is best-effort; invite remains in list on failure.
    }
  };

  const getInviteLink = (token: string) => `${globalThis.location.origin}/join/${token}`;

  const copyLink = (inviteId: string, token: string) => {
    navigator.clipboard.writeText(getInviteLink(token)).catch(() => {
      // Clipboard API may be unavailable in insecure contexts.
    });
    setCopiedId(inviteId);
    setTimeout(() => setCopiedId((prev) => (prev === inviteId ? null : prev)), 2000);
  };

  return (
    <div className="settings-section">
      <h2>{t('settings.invites')}</h2>

      <div className="invite-form">
        <div className="settings-field">
          <label>{t('invites.maxUses', 'Max Uses')}</label>
          <select value={maxUses} onChange={(e) => setMaxUses(e.target.value)}>
            <option value="0">{t('invites.unlimited', 'Unlimited')}</option>
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>

        <div className="settings-field">
          <label>{t('invites.expiry', 'Expires After')}</label>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="0.5">{t('invites.30min', '30 minutes')}</option>
            <option value="1">{t('invites.1hour', '1 hour')}</option>
            <option value="6">{t('invites.6hours', '6 hours')}</option>
            <option value="12">{t('invites.12hours', '12 hours')}</option>
            <option value="24">{t('invites.1day', '1 day')}</option>
            <option value="168">{t('invites.7days', '7 days')}</option>
            <option value="0">{t('invites.never', 'Never')}</option>
          </select>
        </div>

        <button className="btn-primary" onClick={handleCreate} disabled={creating}>
          {creating ? t('common.creating', 'Creating...') : t('invites.create', 'Create Invite')}
        </button>
      </div>

      {invites.length > 0 && (
        <table className="invites-table">
          <thead>
            <tr>
              <th>{t('invites.link', 'Invite Link')}</th>
              <th>{t('invites.createdBy', 'Created By')}</th>
              <th>{t('invites.uses', 'Uses')}</th>
              <th>{t('invites.expiresAt', 'Expires')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => {
              const link = getInviteLink(inv.token);
              const isCopied = copiedId === inv.id;
              return (
                <tr key={inv.id}>
                  <td>
                    <div className="invite-link-cell">
                      <button
                        className="invite-link-text"
                        onClick={() => copyLink(inv.id, inv.token)}
                        title={link}
                        type="button"
                      >
                        {link.length > 48 ? `${link.slice(0, 48)}…` : link}
                      </button>
                      <button
                        className={`invite-copy-btn${isCopied ? ' copied' : ''}`}
                        onClick={() => copyLink(inv.id, inv.token)}
                        title={isCopied ? t('invites.copied', 'Copied!') : t('invites.copyLink', 'Copy invite link')}
                      >
                        {isCopied ? '✓' : '⎘'}
                      </button>
                    </div>
                  </td>
                  <td>{inv.created_by}</td>
                  <td>
                    {inv.uses}/{inv.max_uses ?? '∞'}
                  </td>
                  <td>{inv.expires_at ? new Date(inv.expires_at).toLocaleString() : t('invites.never')}</td>
                  <td>
                    <button className="btn-danger" onClick={() => handleRevoke(inv.id)}>
                      {t('invites.revoke', 'Revoke')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
