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

let _testCounter = 0;

export function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `msg-${++_testCounter}`,
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
    id: `ch-${++_testCounter}`,
    teamId: 'team-1',
    name: 'general',
    topic: '',
    type: 'text',
    position: 0,
    category: 'General',
    ...overrides,
  };
}

/**
 * Invoke a WebSocket event handler captured by a mocked `ws.on()`.
 * Eliminates repeated inline casts like:
 *   `(handler[1] as (...args: unknown[]) => Promise<void>)(payload)`
 */
export function invokeWsHandler(handler: unknown, ...args: unknown[]): Promise<void> {
  return (handler as (...a: unknown[]) => Promise<void>)(...args);
}

/**
 * Find a registered WS event handler from mocked `ws.on` calls.
 * Returns the handler function for the given event name, or undefined.
 */
export function getWsHandler(
  onMock: ReturnType<typeof import('vitest').vi.fn>,
  eventName: string,
): ((...args: unknown[]) => Promise<void>) | undefined {
  const calls = onMock.mock.calls as [string, (...args: unknown[]) => Promise<void>][];
  const match = calls.find((c) => c[0] === eventName);
  return match?.[1];
}

/**
 * Find the LAST registered WS event handler (useful when effects re-run).
 */
export function getLastWsHandler(
  onMock: ReturnType<typeof import('vitest').vi.fn>,
  eventName: string,
): ((...args: unknown[]) => Promise<void>) | undefined {
  const calls = onMock.mock.calls as [string, (...args: unknown[]) => Promise<void>][];
  const matches = calls.filter((c) => c[0] === eventName);
  return matches.length > 0 ? matches[matches.length - 1][1] : undefined;
}
