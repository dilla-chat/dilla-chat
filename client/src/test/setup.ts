import '@testing-library/jest-dom';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// ─── window.matchMedia stub ─────────────────────────────────────────────────
Object.defineProperty(globalThis, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ─── AudioContext stubs ─────────────────────────────────────────────────────
class MockOscillatorNode {
  frequency = { value: 0, setValueAtTime: vi.fn() };
  type = 'sine';
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockGainNode {
  gain = { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  connect = vi.fn().mockReturnThis();
  disconnect = vi.fn();
}

class MockAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  createOscillator = vi.fn(() => new MockOscillatorNode());
  createGain = vi.fn(() => new MockGainNode());
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    frequencyBinCount: 128,
    getByteTimeDomainData: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  close = vi.fn();
  resume = vi.fn();
}

vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('OscillatorNode', MockOscillatorNode);
vi.stubGlobal('GainNode', MockGainNode);

// ─── RTCPeerConnection / MediaStream stubs ──────────────────────────────────
class MockMediaStream {
  id = 'mock-stream';
  active = true;
  getTracks = vi.fn(() => []);
  getAudioTracks = vi.fn(() => []);
  getVideoTracks = vi.fn(() => []);
  addTrack = vi.fn();
  removeTrack = vi.fn();
  clone = vi.fn(() => new MockMediaStream());
}

vi.stubGlobal('MediaStream', MockMediaStream);
vi.stubGlobal('RTCPeerConnection', vi.fn(() => ({
  createOffer: vi.fn(),
  createAnswer: vi.fn(),
  setLocalDescription: vi.fn(),
  setRemoteDescription: vi.fn(),
  addTrack: vi.fn(),
  removeTrack: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
})));

// ─── Notification stub ──────────────────────────────────────────────────────
const MockNotification = vi.fn() as unknown as typeof Notification;
Object.defineProperty(MockNotification, 'permission', {
  get: () => 'granted',
  configurable: true,
});
(MockNotification as Record<string, unknown>).requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
vi.stubGlobal('Notification', MockNotification);

// ─── Mock react-i18next ─────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
    i18n: {
      language: 'en',
      changeLanguage: vi.fn(),
    },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));



// ─── Cleanup after each test ────────────────────────────────────────────────
afterEach(() => {
  cleanup();
  // Guard for tests that opt into the `node` environment via
  // `// @vitest-environment node` — those don't have window storage globals.
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
});
