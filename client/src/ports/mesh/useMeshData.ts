// @ts-nocheck
// Live binding for the ports/mesh/ChatApp. Produces a MOCK_DATA-shaped
// object whose SERVERS + CHANNELS come from our real useTeamStore, and
// whose remaining fields (MEMBERS, MESSAGES, byId, DMS, DM_MESSAGES,
// THREAD_REPLIES) still come from the seeded mocks until later migration
// steps replace them.

import { useMemo } from 'react';
import { useTeamStore } from '../../stores/teamStore';
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

export function useMeshData() {
  const teams = useTeamStore((s) => s.teams);
  const channels = useTeamStore((s) => s.channels);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);

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

    return {
      ...MOCK_DATA,
      SERVERS,
      CHANNELS,
    };
  }, [teams, channels, activeTeamId]);
}

// Re-export for callers that want to hand the produced data directly to
// window.MOCK_DATA before ChatApp renders.
export { initialsOf };
