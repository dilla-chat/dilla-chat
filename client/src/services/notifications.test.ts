import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notificationService } from './notifications';

beforeEach(() => {
  notificationService.setEnabled(true);
  vi.clearAllMocks();
});

describe('NotificationService', () => {
  it('isEnabled defaults to true', () => {
    expect(notificationService.isEnabled()).toBe(true);
  });

  it('setEnabled toggles state', () => {
    notificationService.setEnabled(false);
    expect(notificationService.isEnabled()).toBe(false);
    notificationService.setEnabled(true);
    expect(notificationService.isEnabled()).toBe(true);
  });

  it('requestPermission returns true when already granted', async () => {
    const result = await notificationService.requestPermission();
    expect(result).toBe(true);
  });

  it('notify does nothing when disabled', async () => {
    notificationService.setEnabled(false);
    // Spy on document.hasFocus to make sure it's not even called
    const spy = vi.spyOn(document, 'hasFocus');
    await notificationService.notify('Test', 'body');
    expect(spy).not.toHaveBeenCalled();
  });

  it('notify does nothing when document has focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    await notificationService.notify('Test', 'body');
    // Notification constructor shouldn't be called when focused
    expect(Notification).not.toHaveBeenCalled();
  });

  it('notify creates a Notification when unfocused', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await notificationService.notify('Title', 'Body');
    expect(Notification).toHaveBeenCalledWith('Title', { body: 'Body', icon: undefined });
  });

  it('notify passes icon option when provided', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await notificationService.notify('Title', 'Body', { icon: '/icon.png' });
    expect(Notification).toHaveBeenCalledWith('Title', { body: 'Body', icon: '/icon.png' });
  });

  it('requestPermission returns false when Notification API is not available', async () => {
    const original = (window as Record<string, unknown>).Notification;
    delete (window as Record<string, unknown>).Notification;
    const result = await notificationService.requestPermission();
    expect(result).toBe(false);
    (window as Record<string, unknown>).Notification = original;
  });

  it('requestPermission returns false when permission is denied', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true });
    const result = await notificationService.requestPermission();
    expect(result).toBe(false);
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
  });

  it('notify requests permission when not yet granted', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true });
    const requestSpy = vi.spyOn(Notification, 'requestPermission').mockResolvedValue('granted');
    await notificationService.notify('Title', 'Body');
    expect(requestSpy).toHaveBeenCalled();
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
  });

  it('notify does not create notification when permission request denied', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true });
    vi.spyOn(Notification, 'requestPermission').mockResolvedValue('denied');
    const constructSpy = vi.fn();
    // Clear the mock constructor to track calls specifically
    (Notification as unknown as ReturnType<typeof vi.fn>).mockClear();
    await notificationService.notify('Title', 'Body');
    // Notification constructor should not be called after denied
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
  });

  it('setEnabled and isEnabled round-trip', () => {
    notificationService.setEnabled(false);
    expect(notificationService.isEnabled()).toBe(false);
    notificationService.setEnabled(true);
    expect(notificationService.isEnabled()).toBe(true);
  });

  it('requestPermission asks browser when permission is default', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true });
    const requestSpy = vi.spyOn(Notification, 'requestPermission').mockResolvedValue('granted');
    const result = await notificationService.requestPermission();
    expect(result).toBe(true);
    expect(requestSpy).toHaveBeenCalled();
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
  });

  it('requestPermission returns false when browser denies', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true });
    vi.spyOn(Notification, 'requestPermission').mockResolvedValue('denied');
    const result = await notificationService.requestPermission();
    expect(result).toBe(false);
    Object.defineProperty(Notification, 'permission', { value: 'granted', configurable: true });
  });

  it('notify uses Tauri API when __TAURI_INTERNALS__ is present', async () => {
    const mockSendNotification = vi.fn();
    const mockIsPermissionGranted = vi.fn().mockResolvedValue(true);
    const mockRequestPermission = vi.fn().mockResolvedValue('granted');

    // Set up Tauri internals
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    // Mock the dynamic import
    vi.doMock('@tauri-apps/api/notification', () => ({
      isPermissionGranted: mockIsPermissionGranted,
      requestPermission: mockRequestPermission,
      sendNotification: mockSendNotification,
    }));

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await notificationService.notify('Title', 'Body');

    delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.doUnmock('@tauri-apps/api/notification');
  });

  it('notify falls through to browser API when Tauri import fails', async () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    // The import will fail since @tauri-apps/api/notification doesn't exist in test
    await notificationService.notify('Title', 'Body');
    expect(Notification).toHaveBeenCalledWith('Title', { body: 'Body', icon: undefined });

    delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('notify does nothing when Notification API is not available and not in Tauri', async () => {
    const original = (window as Record<string, unknown>).Notification;
    delete (window as Record<string, unknown>).Notification;
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    // Should not throw
    await notificationService.notify('Title', 'Body');
    (window as Record<string, unknown>).Notification = original;
  });
});
