// Smoke test for the main entry point — exercises the boot-time
// installs and renders App into a jsdom root. Mocks every side-
// effecting service so the bootstrap doesn't try to reach the real
// network / browser APIs that jsdom doesn't implement.

import { describe, it, expect, vi } from 'vitest';

vi.mock('./i18n', () => ({}));
vi.mock('./index.css', () => ({}));
vi.mock('./App.tsx', () => ({ default: () => null }));
vi.mock('./services/telemetry', () => ({ initTelemetry: vi.fn(), recordException: vi.fn() }));
vi.mock('./services/browserLogs', () => ({ installBrowserLogRelay: vi.fn() }));
vi.mock('./services/trustedTypes', () => ({ installTrustedTypesPolicy: vi.fn() }));
vi.mock('./services/notifications', () => ({
  notificationService: { setEnabled: vi.fn() },
}));
vi.mock('./stores/themeStore', () => ({}));
vi.mock('./stores/userSettingsStore', () => ({
  useUserSettingsStore: { getState: () => ({ desktopNotifications: false }) },
}));

describe('main.tsx entry point', () => {
  it('boots without crashing when a #root element is present', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    await import('./main');
    expect(document.getElementById('root')).toBeTruthy();
  });
});
