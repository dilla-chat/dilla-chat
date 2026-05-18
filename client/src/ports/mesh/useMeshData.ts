// @ts-nocheck
// Live binding for the ports/mesh/ChatApp. Produces a MOCK_DATA-shaped
// object whose SERVERS + CHANNELS come from our real useTeamStore, and
// whose remaining fields (MEMBERS, MESSAGES, byId, DMS, DM_MESSAGES,
// THREAD_REPLIES) still come from the seeded mocks until later migration
// steps replace them.

import { useMemo } from 'react';
import { useTeamStore } from '../../stores/teamStore';
import { useAuthStore } from '../../stores/authStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { usernameColor } from '../../utils/colors';
import { MOCK_DATA } from './data';

// Tiny initials helper — handoff used "TH" / "AD" style 2-char caps.
function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// Map a teamStore Channel to the handoff CHANNELS shape. The handoff also
// carries per-channel unread/mention/encrypted/muted flags. We don't have
// those on the channel record itself yet (unread lives in useUnreadStore,
// E2E lives in useAuthStore.derivedKey), so we set encrypted=true (Mesh
// promise) and leave the unread/mention fields off.
function mapChannel(ch: { id: string; name: string; type: string; topic: string; category: string }) {
  return {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    topic: ch.topic ?? '',
    category: ch.category ?? '',
    encrypted: true,
  };
}

// Map a teamStore Team to the handoff SERVERS shape. `short` is the 1-char
// rail tile letter. `node` should come from authStore.baseUrl host eventually.
function mapServer(team: { id: string; name: string }, federated = true) {
  const short = (team.name?.[0] ?? '?').toUpperCase();
  return {
    id: team.id,
    name: team.name,
    short,
    node: 'local',
    federated,
    members: 0,
  };
}

// Map a teamStore Member (+ presence record) to the handoff MEMBERS shape.
// The handoff identifies members by short string ids ('ada', 'thim'); we use
// the userId from our store as that id so message.author refs line up when
// step 4 wires messages.
function mapMember(member, presence) {
  const name = member.displayName || member.username;
  const status = presence?.status ?? (member.statusType || 'offline');
  const custom = presence?.custom_status || undefined;
  const role = member.roles?.[0]?.name?.toLowerCase();
  return {
    id: member.userId,
    name: member.username,
    initials: initialsOf(name),
    color: usernameColor(member.username),
    status,
    role,
    custom,
  };
}

export function useMeshData() {
  const teams = useTeamStore((s) => s.teams);
  const channels = useTeamStore((s) => s.channels);
  const members = useTeamStore((s) => s.members);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const presences = usePresenceStore((s) => s.presences);
  const authTeams = useAuthStore((s) => s.teams);

  return useMemo(() => {
    // If no team is active (e.g. /mesh visited cold without /demo seeding the
    // store first), fall back to the handoff mocks as-is so the sandbox
    // keeps rendering.
    if (!activeTeamId || teams.size === 0) {
      return MOCK_DATA;
    }

    const SERVERS = [...teams.values()].map((t) => mapServer(t));
    const teamChannels = channels.get(activeTeamId) ?? [];
    const CHANNELS = teamChannels.map(mapChannel);
    const teamMembers = members.get(activeTeamId) ?? [];
    const teamPresences = presences[activeTeamId] ?? {};
    const MEMBERS = teamMembers.map((m) => mapMember(m, teamPresences[m.userId]));
    const byId = Object.fromEntries(MEMBERS.map((m) => [m.id, m]));

    // The handoff ChatApp hardcodes `members.byId.thim` for the current
    // user (UserPanel, voice peer state, mention filter). Alias the
    // logged-in user's record to 'thim' so those refs keep working
    // until the ChatApp is refactored to take currentUserId as a prop.
    const myId = authTeams.get(activeTeamId)?.user?.id;
    if (myId && byId[myId]) {
      byId['thim'] = byId[myId];
    }

    return {
      ...MOCK_DATA,
      SERVERS,
      CHANNELS,
      MEMBERS,
      byId,
    };
  }, [teams, channels, members, presences, activeTeamId, authTeams]);
}

// Re-export for callers that want to hand the produced data directly to
// window.MOCK_DATA before ChatApp renders.
export { initialsOf };
