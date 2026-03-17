import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Message } from '../stores/messageStore';
import type { Channel } from '../stores/teamStore';

export function renderWithProviders(ui: ReactElement) {
  return render(ui, {
    wrapper: ({ children }) => <MemoryRouter>{children}</MemoryRouter>,
  });
}

export function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    channelId: 'ch-1',
    authorId: 'user-1',
    username: 'alice',
    content: 'Hello world',
    encryptedContent: '',
    type: 'text',
    threadId: null,
    editedAt: null,
    deleted: false,
    createdAt: new Date().toISOString(),
    reactions: [],
    ...overrides,
  };
}

export function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: `ch-${Math.random().toString(36).slice(2)}`,
    teamId: 'team-1',
    name: 'general',
    topic: '',
    type: 'text',
    position: 0,
    category: 'General',
    ...overrides,
  };
}
