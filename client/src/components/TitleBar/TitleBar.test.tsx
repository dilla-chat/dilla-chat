import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TitleBar from './TitleBar';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    onResized: vi.fn().mockResolvedValue(() => {}),
    isMaximized: vi.fn().mockResolvedValue(false),
  }),
}));

describe('TitleBar', () => {
  // Suppress unhandled rejections from Tauri dynamic imports in test env
  const handler = (e: PromiseRejectionEvent) => e.preventDefault();
  beforeAll(() => window.addEventListener('unhandledrejection', handler));
  afterAll(() => window.removeEventListener('unhandledrejection', handler));
  afterEach(() => {
    delete (window as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('renders nothing when not in Tauri', () => {
    const { container } = render(<TitleBar />);
    expect(container.querySelector('.titlebar')).toBeNull();
  });

  it('renders a titlebar when Tauri is available', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const { container } = render(<TitleBar />);
    // After useEffect flushes, should render a titlebar
    const titlebar = container.querySelector('.titlebar');
    expect(titlebar).toBeInTheDocument();
  });

  it('renders window control buttons on non-mac platforms', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    // Default jsdom userAgent doesn't contain 'Mac' or 'Win', so it's 'linux'
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
      configurable: true,
    });

    render(<TitleBar />);
    expect(screen.getByLabelText('Minimize')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximize')).toBeInTheDocument();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('renders macOS drag region on Mac platform', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });

    const { container } = render(<TitleBar />);
    expect(container.querySelector('.titlebar-macos')).toBeInTheDocument();
    // macOS should not have control buttons
    expect(screen.queryByLabelText('Minimize')).not.toBeInTheDocument();
  });

  it('renders Windows controls on Windows platform', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true,
    });

    const { container } = render(<TitleBar />);
    expect(container.querySelector('.titlebar-win')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimize')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximize')).toBeInTheDocument();
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  // Button click tests omitted — they trigger dynamic imports of @tauri-apps/api
  // which produce unhandled rejections in jsdom. Covered by Tauri e2e tests instead.

  it('has data-tauri-drag-region attribute', () => {
    (window as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
      configurable: true,
    });

    const { container } = render(<TitleBar />);
    expect(container.querySelector('[data-tauri-drag-region]')).toBeInTheDocument();
  });
});
