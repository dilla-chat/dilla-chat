import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadStore, type Thread } from './threadStore';
import { createMockMessage } from '../test/helpers';

function getState() {
  return useThreadStore.getState();
}

beforeEach(() => {
  useThreadStore.setState({
    threads: {},
    activeThreadId: null,
    threadMessages: {},
    threadPanelOpen: false,
  });
});

const mockThread: Thread = {
  id: 'th-1',
  channel_id: 'ch-1',
  parent_message_id: 'msg-1',
  team_id: 't1',
  creator_id: 'u1',
  title: 'Test Thread',
  message_count: 0,
  last_message_at: null,
  created_at: new Date().toISOString(),
};

describe('thread CRUD', () => {
  it('setThreads sets threads for a channel', () => {
    getState().setThreads('ch-1', [mockThread]);
    expect(getState().threads['ch-1']).toHaveLength(1);
  });

  it('addThread with deduplication', () => {
    getState().addThread('ch-1', mockThread);
    getState().addThread('ch-1', mockThread);
    expect(getState().threads['ch-1']).toHaveLength(1);
  });

  it('updateThread replaces matching thread', () => {
    getState().setThreads('ch-1', [mockThread]);
    const updated = { ...mockThread, title: 'Updated' };
    getState().updateThread(updated);
    expect(getState().threads['ch-1'][0].title).toBe('Updated');
  });

  it('removeThread filters by id', () => {
    getState().setThreads('ch-1', [mockThread]);
    getState().removeThread('ch-1', 'th-1');
    expect(getState().threads['ch-1']).toHaveLength(0);
  });
});

describe('thread messages', () => {
  it('setThreadMessages', () => {
    const msgs = [createMockMessage({ id: 'tm1' })];
    getState().setThreadMessages('th-1', msgs);
    expect(getState().threadMessages['th-1']).toHaveLength(1);
  });

  it('addThreadMessage with deduplication', () => {
    const msg = createMockMessage({ id: 'tm1' });
    getState().addThreadMessage('th-1', msg);
    getState().addThreadMessage('th-1', msg);
    expect(getState().threadMessages['th-1']).toHaveLength(1);
  });

  it('updateThreadMessage', () => {
    const msg = createMockMessage({ id: 'tm1', content: 'old' });
    getState().setThreadMessages('th-1', [msg]);
    getState().updateThreadMessage('th-1', { ...msg, content: 'new' });
    expect(getState().threadMessages['th-1'][0].content).toBe('new');
  });

  it('removeThreadMessage marks as deleted', () => {
    const msg = createMockMessage({ id: 'tm1', content: 'hello' });
    getState().setThreadMessages('th-1', [msg]);
    getState().removeThreadMessage('th-1', 'tm1');
    expect(getState().threadMessages['th-1'][0].deleted).toBe(true);
    expect(getState().threadMessages['th-1'][0].content).toBe('');
  });
});

describe('active thread / panel', () => {
  it('setActiveThread', () => {
    getState().setActiveThread('th-1');
    expect(getState().activeThreadId).toBe('th-1');
  });

  it('setThreadPanelOpen', () => {
    getState().setThreadPanelOpen(true);
    expect(getState().threadPanelOpen).toBe(true);
  });
});
