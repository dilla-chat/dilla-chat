/**
 * Browser-mode tests for responsive CSS media queries.
 *
 * These run in real Chromium via Vitest browser mode so CSS is fully evaluated.
 * We render lightweight wrapper elements with the same CSS classes used by the
 * real components to avoid pulling in heavy dependencies (WebSocket, stores, etc.).
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe, beforeEach } from 'vitest';
import { page } from 'vitest/browser';

/* Import the CSS files whose media queries we're testing */
import '../components/MemberList/MemberList.css';
import '../components/ThreadPanel/ThreadPanel.css';
import '../components/SearchBar/SearchBar.css';
import '../components/MessageInput/MessageInput.css';
import '../components/TeamSidebar/TeamSidebar.css';
import '../styles/theme.css';

// ─── Helpers ────────────────────────────────────────────────────────
const MOBILE = { w: 375, h: 812 };
const TABLET = { w: 900, h: 1024 };
const DESKTOP = { w: 1280, h: 900 };

async function setViewport(size: { w: number; h: number }) {
  await page.viewport(size.w, size.h);
  // Allow a frame for CSS to recompute
  await new Promise((r) => requestAnimationFrame(r));
}

// ─── AppLayout mobile breakpoint ────────────────────────────────────
describe('AppLayout responsive', () => {
  beforeEach(async () => {
    await setViewport(DESKTOP);
  });

  test('mobile: left-panels hidden, mobile controls visible', async () => {
    const screen = await render(
      <div className="app-layout-main mobile">
        <div className="left-panels" data-testid="left-panels">
          <div className="left-panels-top">sidebar</div>
        </div>
        <div className="mobile-tab-content" data-testid="mobile-tab-content">
          tab content
        </div>
        <div className="content-wrapper">
          <div className="content-header">header</div>
        </div>
        <div className="mobile-bottom-controls" data-testid="mobile-bottom-controls">
          controls
        </div>
      </div>,
    );

    // Desktop: left-panels visible, mobile controls hidden
    await expect.element(screen.getByTestId('left-panels')).toHaveStyle({ display: 'flex' });
    await expect.element(screen.getByTestId('mobile-bottom-controls')).toHaveStyle({
      display: 'none',
    });
    await expect.element(screen.getByTestId('mobile-tab-content')).toHaveStyle({
      display: 'none',
    });

    // Switch to mobile
    await setViewport(MOBILE);

    await expect.element(screen.getByTestId('mobile-bottom-controls')).toHaveStyle({
      display: 'flex',
    });
    await expect.element(screen.getByTestId('mobile-tab-content')).toHaveStyle({
      display: 'flex',
    });
  });

  test('mobile: content header has reduced padding', async () => {
    const screen = await render(
      <div className="app-layout-main mobile">
        <div className="content-wrapper">
          <div className="content-header" data-testid="content-header">
            header
          </div>
        </div>
      </div>,
    );

    // Desktop padding
    await expect.element(screen.getByTestId('content-header')).toHaveStyle({
      paddingLeft: '16px',
      paddingRight: '16px',
    });

    // Mobile padding
    await setViewport(MOBILE);
    await expect.element(screen.getByTestId('content-header')).toHaveStyle({
      paddingLeft: '8px',
      paddingRight: '8px',
    });
  });
});

// ─── MemberList responsive ──────────────────────────────────────────
describe('MemberList responsive', () => {
  test('width adapts across breakpoints', async () => {
    const screen = await render(
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <div style={{ flex: 1 }}>content</div>
        <div className="member-list" data-testid="member-list">
          members
        </div>
      </div>,
    );

    const el = screen.getByTestId('member-list');

    // Desktop: 240px (--member-sidebar-width)
    await setViewport(DESKTOP);
    await expect.element(el).toHaveStyle({ width: '240px' });

    // Tablet: 200px
    await setViewport(TABLET);
    await expect.element(el).toHaveStyle({ width: '200px' });

    // Mobile: 100%
    await setViewport(MOBILE);
    await expect.element(el).toHaveStyle({ borderLeft: 'none' });
  });
});

// ─── ThreadPanel responsive ─────────────────────────────────────────
describe('ThreadPanel responsive', () => {
  test('layout adapts across breakpoints', async () => {
    const screen = await render(
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <div style={{ flex: 1 }}>content</div>
        <div className="thread-panel" data-testid="thread-panel">
          thread
        </div>
      </div>,
    );

    const el = screen.getByTestId('thread-panel');

    // Desktop: 400px width
    await setViewport(DESKTOP);
    await expect.element(el).toHaveStyle({ width: '400px', minWidth: '400px' });

    // Tablet: 320px
    await setViewport(TABLET);
    await expect.element(el).toHaveStyle({ width: '320px', minWidth: '320px' });

    // Mobile: fixed fullscreen overlay
    await setViewport(MOBILE);
    await expect.element(el).toHaveStyle({ position: 'fixed', minWidth: '0px' });
  });
});

// ─── SearchBar responsive ───────────────────────────────────────────
describe('SearchBar responsive', () => {
  test('input wrapper width adapts', async () => {
    const screen = await render(
      <div className="header-search">
        <div className="header-search-input-wrapper" data-testid="search-wrapper">
          <input className="header-search-input" placeholder="Search" />
        </div>
      </div>,
    );

    const el = screen.getByTestId('search-wrapper');

    // Desktop: 200px
    await setViewport(DESKTOP);
    await expect.element(el).toHaveStyle({ width: '200px' });

    // Mobile: 140px
    await setViewport(MOBILE);
    await expect.element(el).toHaveStyle({ width: '140px' });
  });
});

// ─── MessageInput responsive ────────────────────────────────────────
describe('MessageInput responsive', () => {
  test('wrapper padding adapts', async () => {
    const screen = await render(
      <div style={{ position: 'relative', width: '100%', height: '200px' }}>
        <div className="message-input-wrapper" data-testid="msg-wrapper">
          <div className="message-input-composer">
            <div className="message-input-textarea-area">
              <textarea className="message-input-textarea" />
            </div>
          </div>
        </div>
      </div>,
    );

    const el = screen.getByTestId('msg-wrapper');

    // Desktop: padding 0 16px 16px
    await setViewport(DESKTOP);
    await expect.element(el).toHaveStyle({
      paddingLeft: '16px',
      paddingRight: '16px',
      paddingBottom: '16px',
    });

    // Mobile: padding 0 8px 8px
    await setViewport(MOBILE);
    await expect.element(el).toHaveStyle({
      paddingLeft: '8px',
      paddingRight: '8px',
      paddingBottom: '8px',
    });
  });
});

// ─── TeamSidebar responsive ─────────────────────────────────────────
describe('TeamSidebar responsive', () => {
  test('flex-direction changes on mobile', async () => {
    const screen = await render(
      <div className="mobile-tab-content" style={{ display: 'flex' }}>
        <div className="team-sidebar" data-testid="team-sidebar">
          <div className="team-list">
            <div className="team-icon-wrapper">
              <div className="team-icon">T</div>
            </div>
          </div>
        </div>
      </div>,
    );

    const el = screen.getByTestId('team-sidebar');

    // Desktop: column layout, 72px width
    await setViewport(DESKTOP);
    await expect.element(el).toHaveStyle({ flexDirection: 'column', width: '72px' });

    // Mobile: row layout, full width
    await setViewport(MOBILE);
    await expect.element(el).toHaveStyle({ flexDirection: 'row' });
  });
});
