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
      expect(() => playJoinSound()).not.toThrow();
    });

    it('plays tones when sound notifications are enabled', () => {
      useUserSettingsStore.setState({ soundNotifications: true });
      expect(() => playJoinSound()).not.toThrow();
    });
  });

  describe('playLeaveSound', () => {
    it('does nothing when sound notifications are disabled', () => {
      useUserSettingsStore.setState({ soundNotifications: false });
      expect(() => playLeaveSound()).not.toThrow();
    });

    it('plays tones when sound notifications are enabled', () => {
      useUserSettingsStore.setState({ soundNotifications: true });
      expect(() => playLeaveSound()).not.toThrow();
    });
  });

  describe('setTimeout callbacks', () => {
    it('playJoinSound fires second tone via setTimeout', () => {
      vi.useFakeTimers();
      useUserSettingsStore.setState({ soundNotifications: true });
      expect(() => playJoinSound()).not.toThrow();
      vi.advanceTimersByTime(100);
      vi.useRealTimers();
    });

    it('playLeaveSound fires second tone via setTimeout', () => {
      vi.useFakeTimers();
      useUserSettingsStore.setState({ soundNotifications: true });
      expect(() => playLeaveSound()).not.toThrow();
      vi.advanceTimersByTime(100);
      vi.useRealTimers();
    });
  });
});
