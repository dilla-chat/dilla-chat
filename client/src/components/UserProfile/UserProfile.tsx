import { useTranslation } from 'react-i18next';
import type { Member, Role } from '../../stores/teamStore';
import type { UserPresence } from '../../stores/presenceStore';
import { useVerifiedContacts } from '../../stores/verifiedContactsStore';
import PresenceIndicator from '../PresenceIndicator/PresenceIndicator';
import './UserProfile.css';

interface Props {
  member: Member;
  presence?: UserPresence;
  x: number;
  y: number;
  onSendMessage?: () => void;
  onClose?: () => void;
}

export default function UserProfile({ member, presence, x, y, onSendMessage, onClose }: Readonly<Props>) {
  const { t } = useTranslation();
  // F9 — surface identity-verification status in the profile popover.
  // Reads the verified-contacts store (per-device set of public keys
  // the user has compared out-of-band). Clicking the affordance fires
  // the existing `dilla:verify-safety` event so the SafetyCompare modal
  // handles the actual comparison UX. Closes X3DH-MITM-1.
  const verifiedContacts = useVerifiedContacts();
  const peerHex = (member.publicKeyHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  const verifyStatus = peerHex ? verifiedContacts.isVerified(member.userId, peerHex) : 'unverified';
  const verified = verifyStatus === 'verified';
  const keyChanged = verifyStatus === 'changed';

  function openSafetyCompare(): void {
    globalThis.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: member.userId }));
    onClose?.();
  }

  const initials = (member.displayName || member.username)
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const status = presence?.status ?? 'offline';
  const statusLabel = t(`presence.${status === 'offline' ? 'offline' : status}`);

  let verifyTitle: string;
  if (verified) {
    verifyTitle = t('profile.verifiedIdentity', 'Identity verified — click to re-check');
  } else if (keyChanged) {
    verifyTitle = t('profile.identityChanged', 'Identity key changed — verify again');
  } else {
    verifyTitle = t('profile.verifyIdentityTitle', 'Compare safety numbers out-of-band');
  }

  let verifyBody: React.ReactNode;
  if (verified) {
    verifyBody = (
      <>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{t('profile.verifiedBadge', 'Verified')}</span>
      </>
    );
  } else if (keyChanged) {
    verifyBody = (
      <>
        <span aria-hidden="true">⚠</span>
        <span>{t('profile.verifyAgain', 'Re-verify identity')}</span>
      </>
    );
  } else {
    verifyBody = (
      <>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 1l6 3v4c0 4-3 6-6 7-3-1-6-3-6-7V4l6-3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
        <span>{t('profile.verifyIdentity', 'Verify identity')}</span>
      </>
    );
  }

  return (
    <dialog
      className="user-profile-popover"
      style={{ left: Math.max(0, x), top: y }}
      open
    >
      <div className="user-profile-banner" />
      <div className="user-profile-body">
        <div className="user-profile-avatar-wrapper">
          <div className="user-profile-avatar">{initials}</div>
          <PresenceIndicator status={status} size="large" className="border-floating" />
        </div>

        <div className="user-profile-display-name">
          {member.displayName || member.username}
        </div>
        <div className="user-profile-username">@{member.username}</div>

        {/* F9 — identity verification affordance. Three states: */}
        {/*   - verified:    "Verified ✓" badge that opens compare to re-check */}
        {/*   - changed:     warning that the key rotated since last verify */}
        {/*   - unverified:  "Verify identity" button */}
        {peerHex && (
          <button
            type="button"
            className={
              'user-profile-verify' +
              (verified ? ' user-profile-verify--verified' : '') +
              (keyChanged ? ' user-profile-verify--changed' : '')
            }
            onClick={openSafetyCompare}
            title={verifyTitle}
          >
            {verifyBody}
          </button>
        )}

        <div className="user-profile-status-row">
          <span className="user-profile-status-text">{statusLabel}</span>
          {presence?.custom_status && (
            <span className="user-profile-custom-status">{presence.custom_status}</span>
          )}
        </div>

        {member.roles.length > 0 && (
          <div className="user-profile-section">
            <div className="user-profile-section-title micro">{t('profile.roles')}</div>
            <div className="user-profile-roles">
              {member.roles.map((role: Role) => (
                <span key={role.id} className="user-profile-role-badge">
                  <span className="user-profile-role-dot" style={{ background: role.color || '#8fa3b8' }} />
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {onSendMessage && (
          <button className="btn btn--primary btn--block" onClick={onSendMessage}>
            {t('profile.sendMessage')}
          </button>
        )}
      </div>
    </dialog>
  );
}
