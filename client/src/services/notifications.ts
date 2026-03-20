class NotificationService {
  private enabled = true;

  async requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  async notify(title: string, body: string, options?: { icon?: string }): Promise<void> {
    if (!this.enabled) return;
    if (document.hasFocus()) return;

    // Try Tauri notification API first (only in Tauri shell)
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const mod = '@tauri-apps/api/notification';
        const { isPermissionGranted, requestPermission, sendNotification } =
          await import(/* @vite-ignore */ mod);
        const permitted = await isPermissionGranted()
          || (await requestPermission()) === 'granted';
        if (permitted) {
          sendNotification({ title, body, icon: options?.icon });
          return;
        }
      } catch {
        // Tauri not available, fall through to browser API
      }
    }

    // Browser Notification API fallback
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if (result !== 'granted') return;
    }
    new Notification(title, { body, icon: options?.icon });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

export const notificationService = new NotificationService();
