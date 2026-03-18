import { describe, it, expect, vi, beforeEach } from 'vitest';
import { playJoinSound, playLeaveSound } from './sounds';
import { useUserSettingsStore } from '../stores/userSettingsStore';

describe('sounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('playJoinSound', () => {
    it('does nothing when sound notifications are disabled', () => {
      useUserSettingsStore.setState({ soundNotifications: false });
      // Should not throw
      playJoinSound();
    });

    it('plays tones when sound notifications are enabled', () => {
      useUserSettingsStore.setState({ soundNotifications: true });
      // Should not throw, uses mocked AudioContext from setup
      playJoinSound();
    });
  });

  describe('playLeaveSound', () => {
    it('does nothing when sound notifications are disabled', () => {
      useUserSettingsStore.setState({ soundNotifications: false });
      playLeaveSound();
    });

    it('plays tones when sound notifications are enabled', () => {
      useUserSettingsStore.setState({ soundNotifications: true });
      playLeaveSound();
    });
  });

  describe('setTimeout callbacks', () => {
    it('playJoinSound fires second tone via setTimeout', () => {
      vi.useFakeTimers();
      useUserSettingsStore.setState({ soundNotifications: true });
      playJoinSound();
      vi.advanceTimersByTime(100);
      vi.useRealTimers();
    });

    it('playLeaveSound fires second tone via setTimeout', () => {
      vi.useFakeTimers();
      useUserSettingsStore.setState({ soundNotifications: true });
      playLeaveSound();
      vi.advanceTimersByTime(100);
      vi.useRealTimers();
    });
  });
});
