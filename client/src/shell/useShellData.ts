// @ts-nocheck
// Live binding for the shell/ChatApp. Produces a MOCK_DATA-shaped
// object whose SERVERS + CHANNELS come from our real useTeamStore, and
// whose remaining fields (MEMBERS, MESSAGES, byId, DMS, DM_MESSAGES,
// THREAD_REPLIES) still come from the seeded mocks until later migration
// steps replace them.

import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useMessageStore } from '../stores/messageStore';
import { useDMStore } from '../stores/dmStore';
import { usePollStore } from '../stores/pollStore';
import { useThreadStore } from '../stores/threadStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUnreadStore } from '../stores/unreadStore';
import { api } from '../services/api';
import { usernameColor } from '../utils/colors';
import { MOCK_DATA } from './data';

// Empty shape used by /app while team data hasn't loaded yet. We do NOT
// spread MOCK_DATA here: that has historically been the source of every
// "mock content briefly visible on /app" regression — any field we forgot
// to override would leak BERRALITOS / ada / mira / mock channels. This
// shape only has what ChatApp actually reads, and reads are all empty.
// One blank server keeps `team.name` / `team.node` accesses from crashing
// while sync:init is in flight; the empty strings render as nothing.
const EMPTY_DATA = {
  SERVERS: [{ id: '', name: '', description: '', short: '', node: '', federated: false, members: 0 }],
  CHANNELS: [],
  MEMBERS: [],
  byId: {},
  MESSAGES: {},
  DMS: [],
  DM_MESSAGES: {},
  THREAD_REPLIES: {},
  activeServerId: null,
  activeChannelId: null,
  currentUserId: null,
};

// Tiny initials helper — handoff used "TH" / "AD" / "BE" 2-char caps,
// always two letters. For multi-word names take first letter of the
// first two words; for single-word names take the first two letters.
function initialsOf(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  let initials = '';
  if (words.length >= 2) {
    initials = words[0][0] + words[1][0];
  } else if (words.length === 1) {
    initials = words[0].slice(0, 2);
  }
  return initials.toUpperCase();
}

// Map a teamStore Channel to the handoff CHANNELS shape. The handoff also
// carries per-channel unread/mention/encrypted/muted flags. We don't have
// those on the channel record itself yet (unread lives in useUnreadStore,
// E2E lives in useAuthStore.derivedKey), so we set encrypted=true (Mesh
// promise) and leave the unread/mention fields off.
//
// For voice channels we also attach `participants` (array of user_ids
// currently in this voice room) from useVoiceStore.voiceOccupants so the
// 'Active voice' section + voice cards render.
function mapChannel(ch, occupants, unreadCounts) {
  const unread = unreadCounts[ch.id] || 0;
  const base = {
    id: ch.id,
    name: ch.name,
    type: ch.type,
    topic: ch.topic ?? '',
    category: ch.category ?? '',
    groupId: (ch.groupId ?? ch.group_id ?? null) as string | null,
    encrypted: true,
    unread,
    locked: !!ch.locked,
    accessRoleIds: ch.accessRoleIds ?? [],
    hiddenIfRestricted: !!(ch.hiddenIfRestricted ?? ch.hidden_if_restricted),
    slowModeSeconds: (ch.slowModeSeconds ?? ch.slow_mode_seconds ?? 0) as number,
  };
  if (ch.type === 'voice') {
    const peers = occupants ?? [];
    // voicePeers: { [user_id]: { muted, deafened, speaking, screen_sharing, webcam_sharing, voiceLevel } }
    // ChatApp can look this up to render real peer state on voice cards
    // (was previously hardcoded to pid === 'ada' / 'ben').
    const voicePeers = Object.fromEntries(peers.map((p) => [p.user_id, p]));
    return {
      ...base,
      participants: peers.map((p) => p.user_id),
      voicePeers,
    };
  }
  return base;
}

// Map a teamStore Team to the handoff SERVERS shape. `short` is the 1-char
// rail tile letter. `node` is the host portion of authStore.baseUrl when
// available, else 'local'. `federated` should reflect actual peer status —
// until we wire real peer info, callers pass it in.
function mapServer(team, federated, node) {
  const short = (team.name?.[0] ?? '?').toUpperCase();
  return {
    id: team.id,
    name: team.name,
    description: team.description ?? '',
    short,
    node: node || 'local',
    federated: !!federated,
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
// When the store message has attachments, surface them in the handoff
// shape: `attachment: { kind, label, size, src }` (handoff used a single
// attachment per message). `src` resolves via api.getAttachmentUrl when
// the server didn't include one — which it doesn't on /app where the
// page is served from vite at a different origin than the API server.
// DM messages don't get proper attachment rows server-side yet — the
// uploader stuffs `[file:<attachment_id>] <filename>` into the encrypted
// text content. Parse that token so DM attachments render the same way
// channel attachments do. Channels use the attachments[] array instead
// and never hit this branch.
const FILE_TOKEN = /^\[file:([^\]]+)\]\s*(.*)$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function mapMessage(msg, currentUserId, teamId) {
  let att = msg.attachments?.[0];
  let isImage = att?.content_type?.startsWith('image/');
  let text = msg.content;

  // Fall back to in-content token only when no real attachment row was
  // attached. Once DMs gain server-side attachments this branch can go.
  if (!att && typeof text === 'string') {
    const m = text.match(FILE_TOKEN);
    if (m && teamId) {
      const [, id, label] = m;
      const imageLike = IMAGE_EXT.test(label);
      att = {
        id,
        filename: label || 'file',
        content_type: imageLike ? 'image/*' : 'application/octet-stream',
        size: undefined,
        url: api.getAttachmentUrl(teamId, id),
      };
      isImage = imageLike;
      text = '';
    }
  }

  const attachment = att
    ? {
        kind: isImage ? 'image' : 'file',
        label: att.filename || 'file',
        size: att.size,
        src: isImage && teamId ? api.getAttachmentUrl(teamId, att.id) : att.url,
      }
    : undefined;
  return {
    id: msg.id,
    author: msg.authorId,
    at: new Date(msg.createdAt),
    kind: msg.type === 'system' ? 'system' : attachment?.kind ?? 'text',
    text,
    edited: !!msg.editedAt,
    deleted: msg.deleted,
    reactions: mapReactions(msg.reactions, currentUserId),
    attachment,
  };
}

// Map a DMChannel to the handoff DMS shape. `with` is the other member's
// user_id for 1:1s, or an array of user_ids for group DMs. `unread` is
// looked up by dm.id in useUnreadStore so the PMs sidebar pill matches
// the live event-driven count from useDMEvents.
function mapDM(dm, myId, unreadCounts) {
  const members = dm.members ?? [];
  const others = members.filter((m) => m.user_id !== myId);
  const unread = unreadCounts[dm.id] || 0;
  if (dm.is_group) {
    return {
      id: dm.id,
      with: others.map((m) => m.user_id),
      group: true,
      name: others.map((m) => m.username).join(', '),
      preview: dm.last_message?.content ?? '',
      at: dm.last_message ? new Date(dm.last_message.createdAt) : new Date(dm.created_at),
      unread,
    };
  }
  const other = others[0];
  return {
    id: dm.id,
    with: other?.user_id ?? '',
    preview: dm.last_message?.content ?? '',
    at: dm.last_message ? new Date(dm.last_message.createdAt) : new Date(dm.created_at),
    unread,
  };
}

// Map a teamStore Member (+ presence record) to the handoff MEMBERS shape.
// The handoff identifies members by short string ids ('ada', 'thim'); we use
// the userId from our store as that id so message.author refs line up when
// step 4 wires messages.
function mapMember(member, presence) {
  const name = member.displayName || member.username;
  // Presence is ephemeral — it lives in the server's in-memory
  // PresenceManager and reaches the client via the sync:init presence
  // map + presence:changed events. The DB `status_type` column is
  // a registration-time default that NEVER updates on disconnect, so
  // falling back to it would show users as online forever. Anyone not
  // in the live map is offline by definition.
  const status = presence?.status ?? 'offline';
  const custom = presence?.custom_status || undefined;
  // Pass through all non-default roles ordered by position desc — the
  // member panel groups members under the highest one. `role` is the
  // legacy single-string shorthand (lowest-cardinality name) kept for
  // styling like role-colored names.
  const nonDefaultRoles = (member.roles ?? [])
    .filter((r: any) => !r.isDefault)
    .sort((a: any, b: any) => (b.position ?? 0) - (a.position ?? 0));
  const role = nonDefaultRoles[0]?.name?.toLowerCase();
  return {
    id: member.userId,
    name: member.username,
    initials: initialsOf(name),
    color: usernameColor(member.username),
    status,
    role,
    roles: nonDefaultRoles.map((r: any) => ({ id: r.id, name: r.name, color: r.color, position: r.position })),
    custom,
    publicKeyHex: member.publicKeyHex ?? '',
    isAdmin: !!member.isAdmin,
  };
}

export function useShellData() {
  const teams = useTeamStore((s) => s.teams);
  const channels = useTeamStore((s) => s.channels);
  const members = useTeamStore((s) => s.members);
  const activeTeamId = useTeamStore((s) => s.activeTeamId);
  const presences = usePresenceStore((s) => s.presences);
  const authTeams = useAuthStore((s) => s.teams);
  const messages = useMessageStore((s) => s.messages);
  const dmChannels = useDMStore((s) => s.dmChannels);
  const dmMessages = useDMStore((s) => s.dmMessages);
  const channelPollsBy = usePollStore((s) => s.polls);
  const threads = useThreadStore((s) => s.threads);
  const threadMessages = useThreadStore((s) => s.threadMessages);
  const voiceOccupants = useVoiceStore((s) => s.voiceOccupants);
  const unreadCounts = useUnreadStore((s) => s.counts);
  // React-driven route signal so navigation between /mesh and /app
  // invalidates the memo below. `window.location.pathname` outside the
  // deps array would leave a stale cached result after route changes,
  // which is the original cause of "mock content shown on /app".
  const pathname = useLocation().pathname;
  const isMesh = pathname.startsWith('/mesh');

  return useMemo(() => {
    // Pre-bootstrap fallback. On /mesh the handoff fixtures stand in
    // until ensureMockSession() finishes seeding the stores; on /app
    // we must NEVER show mock content, so return an empty shell while
    // sync:init is in flight.
    if (!activeTeamId || teams.size === 0) {
      return isMesh ? MOCK_DATA : EMPTY_DATA;
    }

    // Per-team federation + node info from authStore.baseUrl. We don't track
    // federated state in our team store yet — leave it false until a real
    // peer-status feed exists. Once present, this will reflect real peers.
    const SERVERS = [...teams.values()].map((t) => {
      const base = (authTeams.get(t.id) as { baseUrl?: string } | undefined)?.baseUrl ?? '';
      let node = 'local';
      try {
        if (base) node = new URL(base).host.split('.')[0] || 'local';
      } catch { /* ignore */ }
      return mapServer(t, false, node);
    });
    const teamChannels = channels.get(activeTeamId) ?? [];
    const CHANNELS = teamChannels.map((ch) => mapChannel(ch, voiceOccupants[ch.id], unreadCounts));
    const teamMembers = members.get(activeTeamId) ?? [];
    const teamPresences = presences[activeTeamId] ?? {};
    const MEMBERS = teamMembers.map((m) => mapMember(m, teamPresences[m.userId]));
    const byId = Object.fromEntries(MEMBERS.map((m) => [m.id, m]));

    // Resolve the local user's member id. ChatApp reads this via
    // currentUserId() and looks up `byId[id]` — there's no longer any
    // `byId['thim']` alias because that was a mock-id leak (a real user
    // could legitimately be named 'thim' and shadow themselves).
    const myId =
      authTeams.get(activeTeamId)?.user?.id ?? MEMBERS[0]?.id;

    // Index threads by parent_message_id so mapMessage can attach a
    // thread-preview summary to its parent. Replies are mapped further
    // down into THREAD_REPLIES.
    const threadByParent = {};
    for (const ch of teamChannels) {
      for (const th of threads[ch.id] ?? []) {
        const replies = threadMessages[th.id] ?? [];
        threadByParent[th.parent_message_id] = {
          count: th.message_count ?? replies.length,
          lastReplyAt: th.last_message_at ? new Date(th.last_message_at) : (replies.at(-1) ? new Date(replies.at(-1).createdAt) : new Date()),
          participants: [...new Set(replies.map((r) => r.authorId))],
        };
      }
    }

    // MESSAGES: handoff shape is { [channelId]: [msg, ...] }. Iterate the
    // active team's channels and produce mapped arrays. Channels with no
    // messages in our store get an empty array (not the handoff fixture).
    // Soft-deleted messages are filtered out — the server's list endpoint
    // returns them with deleted=1 and empty content, but the UI treats
    // them as gone (renders no placeholder for now).
    const MESSAGES = {};
    for (const ch of teamChannels) {
      const list = messages.get(ch.id) ?? [];
      const mapped = list
        .filter((m) => !m.deleted)
        .map((m) => {
          const mm = mapMessage(m, myId, activeTeamId);
          if (threadByParent[m.id]) mm.thread = threadByParent[m.id];
          return mm;
        });
      const channelPolls = (channelPollsBy.get(ch.id) ?? []).map((p) => ({
        id: p.id,
        kind: 'poll',
        author: p.createdBy || '',
        at: p.createdAt ? new Date(p.createdAt) : new Date(),
        question: p.question,
        options: p.options.map((label, i) => ({
          label,
          votes: p.tallies[i] || 0,
          mine: (p.voters[i] || []).includes(myId),
        })),
      }));
      MESSAGES[ch.id] = [...mapped, ...channelPolls].sort((a, b) => {
        const at = a.at instanceof Date ? a.at.getTime() : new Date(a.at).getTime();
        const bt = b.at instanceof Date ? b.at.getTime() : new Date(b.at).getTime();
        return at - bt;
      });
    }

    // DMS + DM_MESSAGES from useDMStore. Empty fallback when nothing is
    // seeded — the handoff PMs tab will just show an empty list.
    const dmList = dmChannels[activeTeamId] ?? [];
    const DMS = dmList.map((dm) => mapDM(dm, myId, unreadCounts));
    const DM_MESSAGES = {};
    for (const dm of dmList) {
      const list = dmMessages[dm.id] ?? [];
      DM_MESSAGES[dm.id] = list
        .filter((m) => !m.deleted)
        .map((m) => mapMessage(m, myId, activeTeamId));
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
        THREAD_REPLIES[th.parent_message_id] = replies
          .filter((m) => !m.deleted)
          .map((m) => mapMessage(m, myId, activeTeamId));
      }
    }

    // Surface the active channel/team so ChatApp can default to the
    // user's actual selection (not the first channel in the list).
    const activeChannelId = useTeamStore.getState().activeChannelId;

    // Explicit shape — no `...MOCK_DATA` spread. Every regression where
    // "BERRALITOS / ada / mira" appeared on /app traced back to a field
    // we forgot to override here. Keeping the return literal flat means
    // anything not listed is simply undefined, not silently inherited
    // from the demo fixtures.
    return {
      SERVERS,
      CHANNELS,
      MEMBERS,
      byId,
      MESSAGES,
      DMS,
      DM_MESSAGES,
      THREAD_REPLIES,
      activeServerId: activeTeamId,
      activeChannelId,
      currentUserId: myId,
    };
  }, [teams, channels, members, presences, activeTeamId, authTeams, messages, dmChannels, dmMessages, threads, threadMessages, voiceOccupants, unreadCounts, isMesh, channelPollsBy]);
}

// Re-export for callers that want to hand the produced data directly to
// window.MOCK_DATA before ChatApp renders.
export { initialsOf };
