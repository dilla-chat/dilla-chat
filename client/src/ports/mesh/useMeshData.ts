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
import { useMessageStore } from '../../stores/messageStore';
import { useDMStore } from '../../stores/dmStore';
import { useThreadStore } from '../../stores/threadStore';
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

// Map our reaction shape ({emoji, users, count}) to handoff's
// ({e, n, mine}). `mine` is true if the current user reacted.
function mapReactions(reactions, currentUserId) {
  if (!reactions || reactions.length === 0) return undefined;
  return reactions.map((r) => ({
    e: r.emoji,
    n: r.count,
    mine: !!currentUserId && r.users?.includes(currentUserId),
  }));
}

// Map a single Message from messageStore to handoff's per-message shape.
// `text` is the displayed body; `kind` follows handoff vocabulary (text /
// system / image / file) and falls back to 'text' for anything unknown.
function mapMessage(msg, currentUserId) {
  return {
    id: msg.id,
    author: msg.authorId,
    at: new Date(msg.createdAt),
    kind: msg.type === 'system' ? 'system' : 'text',
    text: msg.content,
    edited: !!msg.editedAt,
    deleted: msg.deleted,
    reactions: mapReactions(msg.reactions, currentUserId),
  };
}

// Map a DMChannel to the handoff DMS shape. `with` is the other member's
// user_id for 1:1s, or an array of user_ids for group DMs.
function mapDM(dm, myId) {
  const others = dm.members.filter((m) => m.user_id !== myId);
  if (dm.is_group) {
    return {
      id: dm.id,
      with: others.map((m) => m.user_id),
      group: true,
      name: others.map((m) => m.username).join(', '),
      preview: dm.last_message?.content ?? '',
      at: dm.last_message ? new Date(dm.last_message.createdAt) : new Date(dm.created_at),
      unread: 0,
    };
  }
  const other = others[0];
  return {
    id: dm.id,
    with: other?.user_id ?? '',
    preview: dm.last_message?.content ?? '',
    at: dm.last_message ? new Date(dm.last_message.createdAt) : new Date(dm.created_at),
    unread: 0,
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
  const messages = useMessageStore((s) => s.messages);
  const dmChannels = useDMStore((s) => s.dmChannels);
  const dmMessages = useDMStore((s) => s.dmMessages);
  const threads = useThreadStore((s) => s.threads);
  const threadMessages = useThreadStore((s) => s.threadMessages);

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

    // MESSAGES: handoff shape is { [channelId]: [msg, ...] }. Iterate the
    // active team's channels and produce mapped arrays. Channels with no
    // messages in our store get an empty array (not the handoff fixture).
    const MESSAGES = {};
    for (const ch of teamChannels) {
      const list = messages.get(ch.id) ?? [];
      MESSAGES[ch.id] = list.map((m) => mapMessage(m, myId));
    }

    // DMS + DM_MESSAGES from useDMStore. Empty fallback when nothing is
    // seeded — the handoff PMs tab will just show an empty list.
    const dmList = dmChannels[activeTeamId] ?? [];
    const DMS = dmList.map((dm) => mapDM(dm, myId));
    const DM_MESSAGES = {};
    for (const dm of dmList) {
      const list = dmMessages[dm.id] ?? [];
      DM_MESSAGES[dm.id] = list.map((m) => mapMessage(m, myId));
    }

    // THREAD_REPLIES: handoff keys by parent messageId, value is a flat
    // array of replies. Walk all threads across the active team's channels
    // and map their replies via mapMessage so author/at/text/reactions
    // line up with the handoff's per-message rendering.
    const THREAD_REPLIES = {};
    for (const ch of teamChannels) {
      const chThreads = threads[ch.id] ?? [];
      for (const th of chThreads) {
        const replies = threadMessages[th.id] ?? [];
        THREAD_REPLIES[th.parent_message_id] = replies.map((m) => mapMessage(m, myId));
      }
    }

    return {
      ...MOCK_DATA,
      SERVERS,
      CHANNELS,
      MEMBERS,
      byId,
      MESSAGES,
      DMS,
      DM_MESSAGES,
      THREAD_REPLIES,
    };
  }, [teams, channels, members, presences, activeTeamId, authTeams, messages, dmChannels, dmMessages, threads, threadMessages]);
}

// Re-export for callers that want to hand the produced data directly to
// window.MOCK_DATA before ChatApp renders.
export { initialsOf };
