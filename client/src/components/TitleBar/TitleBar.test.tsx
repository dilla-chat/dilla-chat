import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import TitleBar from './TitleBar';

describe('TitleBar', () => {
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
});
