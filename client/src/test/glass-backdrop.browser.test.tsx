/**
 * Browser-mode tests for glass/backdrop-filter effects across the UI.
 * Verifies that blur effects are applied to structural, floating, and overlay elements.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../styles/theme.css';
import '../components/TeamSidebar/TeamSidebar.css';
import '../components/MemberList/MemberList.css';
import '../components/ThreadPanel/ThreadPanel.css';
import '../components/MessageList/MessageList.css';
import '../components/ChannelList/ChannelList.css';
import '../components/SearchBar/SearchBar.css';
import '../components/CreateChannel/CreateChannel.css';
import '../components/EditChannel/EditChannel.css';
import '../components/DMList/NewDMModal.css';
import '../pages/AppLayout.css';

function getBackdropFilter(selector: string): string {
  const el = document.querySelector(selector);
  return getComputedStyle(el!).backdropFilter;
}

describe('Structural glass: sidebars + panels', () => {
  test('sidebars and panels have backdrop-filter', async () => {
    await render(
      <div>
        <div className="team-sidebar" data-testid="team-sidebar">
          <div className="team-list" />
        </div>
        <div className="channel-sidebar" data-testid="channel-sidebar">sidebar</div>
        <div className="member-list" data-testid="member-list">members</div>
        <div style={{ display: 'flex' }}>
          <div style={{ flex: 1 }}>content</div>
          <div className="thread-panel" data-testid="thread-panel">thread</div>
        </div>
        <div className="content-header" data-testid="content-header">header</div>
      </div>,
    );

    const selectors = [
      '.team-sidebar',
      '.channel-sidebar',
      '.member-list',
      '.thread-panel',
      '.content-header',
    ];

    for (const sel of selectors) {
      const bf = getBackdropFilter(sel);
      expect(bf, `${sel} should have backdrop-filter`).not.toBe('none');
      expect(bf, `${sel} should use blur`).toContain('blur');
    }
  });
});

describe('Floating glass: menus + dropdowns', () => {
  test('floating elements have backdrop-filter', async () => {
    await render(
      <div>
        <div className="message-item">
          <div className="message-actions" data-testid="msg-actions" style={{ display: 'flex' }}>
            action
          </div>
        </div>
        <div
          className="channel-context-menu"
          data-testid="ctx-menu"
          style={{ top: 0, left: 0 }}
        >
          menu
        </div>
        <div className="header-search" style={{ position: 'relative' }}>
          <div className="header-search-dropdown" data-testid="search-dropdown">results</div>
        </div>
        <div
          className="member-profile-popup"
          data-testid="profile-popup"
          style={{ top: 0, left: 0 }}
        >
          popup
        </div>
      </div>,
    );

    const selectors = [
      '.message-actions',
      '.channel-context-menu',
      '.header-search-dropdown',
      '.member-profile-popup',
    ];

    for (const sel of selectors) {
      const bf = getBackdropFilter(sel);
      expect(bf, `${sel} should have backdrop-filter`).not.toBe('none');
      expect(bf, `${sel} should use blur`).toContain('blur');
    }
  });
});

describe('Overlay glass: modal backdrops', () => {
  test('modal overlays have backdrop-filter blur(4px)', async () => {
    await render(
      <div>
        <div className="create-channel-overlay" data-testid="create-overlay" />
        <div className="edit-channel-overlay" data-testid="edit-overlay" />
        <div className="new-dm-overlay" data-testid="dm-overlay" />
      </div>,
    );

    const selectors = ['.create-channel-overlay', '.edit-channel-overlay', '.new-dm-overlay'];

    for (const sel of selectors) {
      const bf = getBackdropFilter(sel);
      expect(bf, `${sel} should have backdrop-filter`).toContain('blur');
      expect(bf, `${sel} should use 4px blur`).toContain('4px');
    }
  });
});

describe('Glass variable resolution', () => {
  test('blur variables resolve to correct px values', async () => {
    await render(<div data-testid="root">test</div>);

    const root = document.documentElement;
    const style = getComputedStyle(root);

    expect(style.getPropertyValue('--glass-blur').trim()).toBe('12px');
    expect(style.getPropertyValue('--glass-blur-heavy').trim()).toBe('20px');
    expect(style.getPropertyValue('--glass-blur-light').trim()).toBe('8px');
  });
});
