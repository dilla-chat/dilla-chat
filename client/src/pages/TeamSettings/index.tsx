import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useTeamStore } from '../../stores/teamStore';
import FederationStatus from '../../components/FederationStatus/FederationStatus';
import SettingsLayout, { type NavSection } from '../../components/SettingsLayout/SettingsLayout';
import OverviewTab from './OverviewTab';
import RolesTab from './RolesTab';
import MembersTab from './MembersTab';
import InvitesTab from './InvitesTab';
import ModerationTab from './ModerationTab';
import BansTab from './BansTab';
import type { Tab } from './types';

export default function TeamSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeTeamId, teams, setTeam } = useTeamStore();
  const [tab, setTab] = useState<Tab>('overview');

  const team = activeTeamId ? teams.get(activeTeamId) : null;

  const sections: NavSection[] = useMemo(
    () => [
      {
        label: team?.name ?? t('teams.settings'),
        items: [
          { id: 'overview', label: t('settings.overview', 'Overview') },
          { id: 'roles', label: t('settings.roles') },
          { id: 'members', label: t('settings.members') },
          { id: 'invites', label: t('settings.invites') },
        ],
      },
      {
        label: t('settings.moderationCategory', 'MODERATION'),
        items: [
          { id: 'moderation', label: t('settings.moderation') },
          { id: 'audit-log', label: t('settings.auditLog', 'Audit Log') },
          { id: 'bans', label: t('settings.bans', 'Bans') },
        ],
      },
      {
        items: [{ id: 'federation', label: t('settings.federation') }],
      },
      {
        items: [{ id: 'delete-server', label: t('settings.deleteServer', 'Delete Server'), danger: true }],
      },
    ],
    [t, team?.name],
  );

  const handleClose = () => navigate('/app');

  return (
    <SettingsLayout
      sections={sections}
      activeId={tab}
      onSelect={(id) => setTab(id as Tab)}
      onClose={handleClose}
    >
      {tab === 'overview' && activeTeamId && team && (
        <OverviewTab teamId={activeTeamId} team={team} onSave={setTeam} />
      )}
      {tab === 'roles' && activeTeamId && <RolesTab teamId={activeTeamId} />}
      {tab === 'members' && activeTeamId && <MembersTab teamId={activeTeamId} />}
      {tab === 'invites' && activeTeamId && <InvitesTab teamId={activeTeamId} />}
      {tab === 'federation' && activeTeamId && <FederationStatus teamId={activeTeamId} />}
      {tab === 'moderation' && activeTeamId && <ModerationTab teamId={activeTeamId} />}
      {tab === 'audit-log' && (
        <div>
          <h2 className="text-foreground-primary mb-5">{t('settings.auditLog', 'Audit Log')}</h2>
          <p className="text-foreground-muted text-sm">
            {t('moderation.noActions', 'No recent actions')}
          </p>
        </div>
      )}
      {tab === 'bans' && activeTeamId && <BansTab teamId={activeTeamId} />}
      {tab === 'delete-server' && (
        <div>
          <h2 className="text-foreground-primary mb-5">{t('settings.deleteServer', 'Delete Server')}</h2>
          <p className="text-foreground-muted text-sm">
            {t('settings.deleteServerDesc', 'This action is irreversible. All data will be permanently deleted.')}
          </p>
          <button className="btn-danger mt-4" disabled>
            {t('settings.deleteServer', 'Delete Server')}
          </button>
        </div>
      )}
    </SettingsLayout>
  );
}
