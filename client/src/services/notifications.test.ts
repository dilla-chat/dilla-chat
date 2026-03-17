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
});
