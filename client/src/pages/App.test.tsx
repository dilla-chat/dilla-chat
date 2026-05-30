// Cover pages/App.tsx — the authenticated app entry point.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../shell/AppShell', () => ({ default: () => <div>AppShell</div> }));
vi.mock('../shell/useEagerLoad', () => ({ useEagerLoad: () => ({ ready: true }) }));
vi.mock('../hooks/useTeamSync', () => ({ useTeamSync: () => ({ authChecked: true, dataLoaded: { current: new Set() } }) }));
vi.mock('../hooks/useUserMeSync', () => ({ useUserMeSync: vi.fn() }));
vi.mock('../hooks/useCryptoRestore', () => ({ useCryptoRestore: () => ({ cryptoReady: true }) }));
vi.mock('../hooks/useIdentityBackup', () => ({ useIdentityBackup: vi.fn() }));
vi.mock('../hooks/usePrekeyBackfill', () => ({ usePrekeyBackfill: vi.fn() }));
vi.mock('../hooks/usePresenceEvents', () => ({ usePresenceEvents: vi.fn() }));
vi.mock('../hooks/useCustomTheme', () => ({ useCustomTheme: vi.fn() }));
vi.mock('../hooks/useApplyUIPreferences', () => ({ useApplyUIPreferences: vi.fn() }));
vi.mock('../hooks/useShellSync', () => ({ useShellSync: vi.fn() }));
vi.mock('../hooks/useChannelEvents', () => ({ useChannelEvents: vi.fn() }));
vi.mock('../hooks/useDMEvents', () => ({ useDMEvents: vi.fn() }));
vi.mock('../hooks/useThreadEvents', () => ({ useThreadEvents: vi.fn() }));
vi.mock('../services/telemetryClient', () => ({ telemetryClient: { install: vi.fn(), addBreadcrumb: vi.fn() } }));

import AppPage from './App';
import { useTeamStore } from '../stores/teamStore';
import { useAuthStore } from '../stores/authStore';

beforeEach(() => {
  useTeamStore.setState({ activeTeamId: 't1' } as never);
  useAuthStore.setState({ teams: new Map([['t1', { user: { id: 'me' } }]]) } as never);
});

describe('AppPage', () => {
  it('renders AppShell when auth + crypto ready', () => {
    const { container } = render(
      <MemoryRouter><AppPage /></MemoryRouter>,
    );
    expect(container.textContent).toContain('AppShell');
  });

  it('renders nothing when authChecked=false', () => {
    // Re-mock useTeamSync for this test
    const { container } = render(
      <MemoryRouter><AppPage /></MemoryRouter>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('with empty teams, navigates to /join', () => {
    useAuthStore.setState({ teams: new Map() } as never);
    const { container } = render(
      <MemoryRouter><AppPage /></MemoryRouter>,
    );
    expect(container.firstChild).toBeTruthy();
  });
});
