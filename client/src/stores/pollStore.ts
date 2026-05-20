import { create } from 'zustand';

export interface PollState {
  id: string;
  channelId: string;
  question: string;
  options: string[];
  tallies: number[];
  /** voter user_ids per option index */
  voters: string[][];
  createdBy: string | null;
  createdAt: string;
}

interface PollStore {
  /** channelId -> polls in creation order. */
  polls: Map<string, PollState[]>;
  upsert: (poll: PollState) => void;
  remove: (channelId: string, pollId: string) => void;
  clear: () => void;
}

export const usePollStore = create<PollStore>((set) => ({
  polls: new Map(),
  upsert: (poll) =>
    set((state) => {
      const map = new Map(state.polls);
      const list = map.get(poll.channelId) ?? [];
      const idx = list.findIndex((p) => p.id === poll.id);
      const next = idx >= 0 ? list.map((p, i) => (i === idx ? poll : p)) : [...list, poll];
      map.set(poll.channelId, next);
      return { polls: map };
    }),
  remove: (channelId, pollId) =>
    set((state) => {
      const map = new Map(state.polls);
      const list = map.get(channelId) ?? [];
      map.set(channelId, list.filter((p) => p.id !== pollId));
      return { polls: map };
    }),
  clear: () => set({ polls: new Map() }),
}));

/** Convert a server poll payload to the store shape. Accepts either the
 *  REST GET response or a WS poll:new / poll:update event — both share the
 *  same field set. */
export function normalizePoll(p: any): PollState {
  return {
    id: p.id,
    channelId: p.channel_id,
    question: p.question,
    options: p.options ?? [],
    tallies: p.tallies ?? [],
    voters: p.voters ?? [],
    createdBy: p.created_by ?? null,
    createdAt: p.created_at ?? '',
  };
}
