// Mirror of the shell modal's TeamAudit but rendered with the route's
// .settings-section styling. The describe() switch and members lookup
// match the modal version so the same audit row reads the same way in
// both places — anything else would invite drift.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../services/api';
import { useTeamStore } from '../../stores/teamStore';

interface AuditEvent {
  id: string;
  created_at: string;
  actor_user_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  details?: string | null;
}

type AuditDescribeContext = {
  detail: Record<string, unknown> | null;
  targetUser: string | null;
  name: string;
};

function buildAuditContext(
  e: AuditEvent,
  membersById: Map<string, { username?: string }>,
): AuditDescribeContext {
  let detail: Record<string, unknown> | null = null;
  if (e.details) {
    try { detail = JSON.parse(e.details); } catch { /* leave null */ }
  }
  const targetUser = e.target_type === 'user' && e.target_id
    ? membersById.get(e.target_id)?.username ?? null
    : null;
  const name = (detail && (detail.name as string ?? detail.reason as string)) || '';
  return { detail, targetUser, name };
}

function describeRoleAction(action: string, name: string): string | null {
  switch (action) {
    case 'role.create':  return `created role ${name || '—'}`;
    case 'role.update':  return `updated role ${name || '—'}`;
    case 'role.delete':  return `deleted role ${name || '—'}`;
    case 'role.reorder': return `reordered roles`;
    default: return null;
  }
}

function describeChannelAction(
  action: string,
  name: string,
  detailType: string | undefined,
): string | null {
  switch (action) {
    case 'channel.create':         return `created channel #${name || '—'}${detailType ? ' · ' + detailType : ''}`;
    case 'channel.delete':         return `deleted channel #${name || '—'}`;
    case 'channel.lock':           return `locked channel #${name || '—'}`;
    case 'channel.unlock':         return `unlocked channel #${name || '—'}`;
    case 'channel.update':         return `updated channel #${name || '—'}`;
    case 'channel.access.update':  return `changed access for channel`;
    default: return null;
  }
}

function describeGroupAction(action: string, name: string): string | null {
  switch (action) {
    case 'group.create': return `created group ${name || '—'}`;
    case 'group.update': return `updated group ${name || '—'}`;
    case 'group.delete': return `deleted group ${name || '—'}`;
    case 'group.access': return `changed access for group ${name || '—'}`;
    default: return null;
  }
}

function describeMemberAction(
  action: string,
  ctx: AuditDescribeContext,
  e: AuditEvent,
): string | null {
  const who = ctx.targetUser ?? e.target_id ?? '?';
  const detailReason = ctx.detail?.reason as string | undefined;
  switch (action) {
    case 'member.roles.update': return `changed roles for @${who}`;
    case 'member.kick':         return `kicked @${who}`;
    case 'member.leave':        return `left the team`;
    case 'member.ban': {
      const suffix = detailReason ? ` — ${detailReason}` : '';
      return `banned @${who}${suffix}`;
    }
    default: return null;
  }
}

function describeMiscAction(action: string, ctx: AuditDescribeContext): string | null {
  const detailMaxUses = ctx.detail?.max_uses as number | undefined;
  const detailExpiresAt = ctx.detail?.expires_at as string | undefined;
  switch (action) {
    case 'message.pin':              return `pinned a message`;
    case 'message.unpin':            return `unpinned a message`;
    case 'team.update':              return `updated team settings${ctx.name ? ' · ' + ctx.name : ''}`;
    case 'invite.create':            return `created an invite${detailMaxUses ? ' · max ' + detailMaxUses : ''}${detailExpiresAt ? ' · expires ' + detailExpiresAt : ''}`;
    case 'invite.revoke':            return `revoked an invite`;
    case 'integration.giphy.set':    return `set Giphy API key`;
    case 'integration.giphy.clear':  return `cleared Giphy API key`;
    default: return null;
  }
}

function describeAuditEvent(
  e: AuditEvent,
  membersById: Map<string, { username?: string }>,
): string {
  const ctx = buildAuditContext(e, membersById);
  const detailType = ctx.detail?.type as string | undefined;
  return (
    describeRoleAction(e.action, ctx.name)
    ?? describeChannelAction(e.action, ctx.name, detailType)
    ?? describeGroupAction(e.action, ctx.name)
    ?? describeMemberAction(e.action, ctx, e)
    ?? describeMiscAction(e.action, ctx)
    ?? e.action
  );
}

export default function AuditLogTab({ teamId }: Readonly<{ teamId: string }>) {
  const { t } = useTranslation();
  const members = useTeamStore((s) => s.members.get(teamId) ?? []);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const membersById = useMemo(
    () => new Map(members.map((m) => [m.userId, m])),
    [members],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await api.getAuditEvents(teamId, 200)) as AuditEvent[];
        if (!cancelled) setEvents(list);
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message || t('audit.loadFailed', 'failed to load audit log'));
      }
    })();
    return () => { cancelled = true; };
  }, [teamId, t]);

  function describe(e: AuditEvent): string {
    return describeAuditEvent(e, membersById);
  }

  return (
    <div className="settings-section">
      <h2 className="heading-3">{t('settings.auditLog', 'Audit Log')}</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: '1rem' }}>
        {t('audit.hint', 'Server-stored log of admin actions for this team.')}
      </p>

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</p>
      )}
      {!error && events === null && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>{t('common.loading', 'Loading…')}</p>
      )}
      {!error && events?.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          {t('audit.empty', 'No audit events yet — admin actions (role changes, channel locks, kicks/bans, …) will appear here.')}
        </p>
      )}
      {!error && events && events.length > 0 && (
        <div className="audit-log">
          {events.map((e) => {
            const actor = e.actor_user_id ? membersById.get(e.actor_user_id) : null;
            const actorName = actor?.username || (e.actor_user_id ? e.actor_user_id.slice(0, 8) : 'system');
            return (
              <div
                key={e.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '8rem 8rem 1fr',
                  gap: '0.75rem',
                  padding: '0.5rem 0',
                  borderBottom: '1px solid var(--hairline)',
                  fontSize: '0.8125rem',
                }}
              >
                <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{e.created_at}</span>
                <span style={{ fontWeight: 600 }}>@{actorName}</span>
                <span>{describe(e)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
