import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTelemetry } from './services/telemetry';
import { installBrowserLogRelay } from './services/browserLogs';
import { installTrustedTypesPolicy } from './services/trustedTypes';

// F7 — register the Trusted Types `default` policy BEFORE anything else
// touches the DOM. The server CSP includes
// `require-trusted-types-for 'script'`, so any DOM sink (innerHTML,
// script.src, …) without a Trusted Type value would throw in Chromium.
// Closes DR-XSS-1 from the architecture review §8.4.
installTrustedTypesPolicy();

// Pipe console output to the server (no-op when the server has the
// relay disabled). Install before everything else so boot-time
// errors get captured too.
installBrowserLogRelay();

// Initialize theme store so CSS variables are applied before first render
import './stores/themeStore';

// Sync notification service with persisted setting on startup
import { useUserSettingsStore } from './stores/userSettingsStore';
import { notificationService } from './services/notifications';
notificationService.setEnabled(useUserSettingsStore.getState().desktopNotifications);

// Initialize OpenTelemetry (no-op when VITE_OTEL_ENABLED is not 'true').
initTelemetry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
