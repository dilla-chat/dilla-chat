import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TeamSettings from './TeamSettings';
import UserSettings from './UserSettings';

let dispatchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  dispatchSpy.mockClear();
});

function lastDillaEvent(): CustomEvent | undefined {
  return dispatchSpy.mock.calls
    .map((c) => c[0])
    .filter((e): e is CustomEvent => e instanceof CustomEvent && e.type === 'dilla:open-settings')
    .at(-1);
}

function navigateTeam(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app" element={<div data-testid="app" />} />
        <Route path="/app/settings" element={<TeamSettings />} />
      </Routes>
    </MemoryRouter>,
  );
}

function navigateUser(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app" element={<div data-testid="app" />} />
        <Route path="/app/user-settings" element={<UserSettings />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TeamSettings redirect shim', () => {
  it('mounts + completes the redirect', () => {
    const { container } = navigateTeam('/app/settings');
    expect(container).toBeTruthy();
  });

  it('fires dilla:open-settings with team mode + null tab when no ?tab', () => {
    navigateTeam('/app/settings');
    const fired = lastDillaEvent();
    expect(fired?.detail).toEqual({ mode: 'team', tab: null });
  });

  it('parses ?tab=members', () => {
    navigateTeam('/app/settings?tab=members');
    expect(lastDillaEvent()?.detail.tab).toBe('members');
  });

  it('parses ?tab=roles', () => {
    navigateTeam('/app/settings?tab=roles');
    expect(lastDillaEvent()?.detail.tab).toBe('roles');
  });

  it('parses ?tab=invites', () => {
    navigateTeam('/app/settings?tab=invites');
    expect(lastDillaEvent()?.detail.tab).toBe('invites');
  });
});

describe('UserSettings redirect shim', () => {
  it('mounts + completes the redirect', () => {
    const { container } = navigateUser('/app/user-settings');
    expect(container).toBeTruthy();
  });

  it('fires dilla:open-settings with user mode + null tab when no ?tab', () => {
    navigateUser('/app/user-settings');
    expect(lastDillaEvent()?.detail).toEqual({ mode: 'user', tab: null });
  });

  it('parses ?tab=devices', () => {
    navigateUser('/app/user-settings?tab=devices');
    expect(lastDillaEvent()?.detail.tab).toBe('devices');
  });

  it('parses ?tab=privacy', () => {
    navigateUser('/app/user-settings?tab=privacy');
    expect(lastDillaEvent()?.detail.tab).toBe('privacy');
  });

  it('parses ?tab=voice', () => {
    navigateUser('/app/user-settings?tab=voice');
    expect(lastDillaEvent()?.detail.tab).toBe('voice');
  });
});
