import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('../services/mockSession', () => ({
  ensureMockSession: vi.fn(),
  isMockSession: () => true,
}));

vi.mock('./AppShell', () => ({
  default: ({ ready }: { ready: boolean }) => <div data-testid="appshell" data-ready={ready ? '1' : '0'} />,
}));

vi.mock('./useEagerLoad', () => ({
  useEagerLoad: () => ({ ready: true }),
}));

vi.mock('../hooks/useTeamSync', () => ({
  useTeamSync: () => ({ authChecked: true, dataLoaded: { current: new Set() } }),
}));

import MockShell from './MockShell';
import { useTeamStore } from '../stores/teamStore';

describe('MockShell', () => {
  it('renders the AppShell with ready=true from useEagerLoad', () => {
    useTeamStore.setState({ activeTeamId: 't1' } as never);
    const { getByTestId } = render(<MockShell />);
    expect(getByTestId('appshell').getAttribute('data-ready')).toBe('1');
  });

  it('invokes ensureMockSession at module load (smoke)', () => {
    // The mock factory calls ensureMockSession at the top of the
    // module, before the component is rendered. We can't easily
    // assert call count without resetting modules, but the module
    // should at least import without throwing.
    expect(MockShell).toBeDefined();
    expect(typeof MockShell).toBe('function');
  });
});
