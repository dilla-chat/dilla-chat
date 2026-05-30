// Tests for the user-me sync hook. Drives api.getMe with a mock and
// verifies the result is written into userSettingsStore via
// setQuietHours.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const getMeMock = vi.fn();
vi.mock('../services/api', () => ({
  api: { getMe: (...args: unknown[]) => getMeMock(...args) },
}));

import { useUserMeSync } from './useUserMeSync';
import { useAuthStore } from '../stores/authStore';
import { useUserSettingsStore } from '../stores/userSettingsStore';

describe('useUserMeSync', () => {
  beforeEach(() => {
    getMeMock.mockReset();
    useUserSettingsStore.setState({
      quietHoursEnabled: false,
      quietHoursFrom: '',
      quietHoursTo: '',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when activeTeamId is null', () => {
    useAuthStore.setState({ teams: new Map() });
    renderHook(() => useUserMeSync(null));
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it('does nothing when the team has no baseUrl/token', () => {
    useAuthStore.setState({
      teams: new Map([
        ['t1', { token: '', user: { id: 'u1' }, teamInfo: {}, baseUrl: '' }],
      ]),
    });
    renderHook(() => useUserMeSync('t1'));
    expect(getMeMock).not.toHaveBeenCalled();
  });

  it('writes quiet hours from the API response into the store', async () => {
    getMeMock.mockResolvedValue({
      quiet_hours_enabled: true,
      quiet_hours_from: '22:00',
      quiet_hours_to: '08:00',
    });
    useAuthStore.setState({
      teams: new Map([
        ['t1', {
          token: 'tok',
          user: { id: 'u1' },
          teamInfo: {},
          baseUrl: 'http://localhost:8080',
        }],
      ]),
    });
    renderHook(() => useUserMeSync('t1'));
    await waitFor(() => {
      const s = useUserSettingsStore.getState();
      expect(s.quietHoursEnabled).toBe(true);
      expect(s.quietHoursFrom).toBe('22:00');
      expect(s.quietHoursTo).toBe('08:00');
    });
  });

  it('skips writes when the API response is null', async () => {
    getMeMock.mockResolvedValue(null);
    useAuthStore.setState({
      teams: new Map([
        ['t1', {
          token: 'tok',
          user: { id: 'u1' },
          teamInfo: {},
          baseUrl: 'http://localhost:8080',
        }],
      ]),
    });
    renderHook(() => useUserMeSync('t1'));
    // Brief wait — promise tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(useUserSettingsStore.getState().quietHoursEnabled).toBe(false);
  });

  it('swallows fetch errors via console.warn without rejecting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getMeMock.mockRejectedValue(new Error('network'));
    useAuthStore.setState({
      teams: new Map([
        ['t1', {
          token: 'tok',
          user: { id: 'u1' },
          teamInfo: {},
          baseUrl: 'http://localhost:8080',
        }],
      ]),
    });
    renderHook(() => useUserMeSync('t1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
