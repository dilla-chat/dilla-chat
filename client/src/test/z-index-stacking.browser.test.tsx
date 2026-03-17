/**
 * Browser-mode tests for z-index stacking hierarchy across all components.
 * Verifies that overlays, modals, dropdowns, and fixed elements layer correctly.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../styles/theme.css';
import '../components/TitleBar/TitleBar.css';
import '../components/ShortcutsModal/ShortcutsModal.css';
import '../components/CreateChannel/CreateChannel.css';
import '../components/EditChannel/EditChannel.css';
import '../components/DMList/NewDMModal.css';
import '../components/MemberList/MemberList.css';
import '../components/StatusPicker/StatusPicker.css';
import '../components/ChannelList/ChannelList.css';
import '../components/SearchBar/SearchBar.css';
import '../components/ThreadPanel/ThreadPanel.css';
import '../components/SettingsLayout/SettingsLayout.css';
import '../components/MobileTabBar/MobileTabBar.css';
import '../components/MessageList/MessageList.css';
import '../components/MessageInput/MessageInput.css';
import '../components/ResizeHandle/ResizeHandle.css';

describe('z-index hierarchy', () => {
  test('z-index hierarchy correct: TitleBar > ShortcutsModal > Modals > SearchDropdown > ThreadPanel-mobile > MobileTabBar > MessageInput', async () => {
    const screen = await render(
      <div>
        <div className="titlebar" data-testid="titlebar" />
        <div className="shortcuts-overlay" data-testid="shortcuts-overlay" />
        <div className="create-channel-overlay" data-testid="create-channel-overlay" />
        <div className="edit-channel-overlay" data-testid="edit-channel-overlay" />
        <div className="new-dm-overlay" data-testid="new-dm-overlay" />
        <div className="status-picker" data-testid="status-picker" />
        <div
          className="channel-context-menu"
          data-testid="context-menu"
          style={{ top: 0, left: 0 }}
        />
        <div className="header-search" style={{ position: 'relative' }}>
          <div className="header-search-dropdown" data-testid="search-dropdown">
            results
          </div>
        </div>
        <div className="mobile-tab-bar" data-testid="tab-bar" />
        <div style={{ position: 'relative' }}>
          <div className="message-input-wrapper" data-testid="msg-input">
            input
          </div>
        </div>
      </div>,
    );

    const titlebar = screen.getByTestId('titlebar');
    const shortcuts = screen.getByTestId('shortcuts-overlay');
    const createChannel = screen.getByTestId('create-channel-overlay');
    const editChannel = screen.getByTestId('edit-channel-overlay');
    const newDm = screen.getByTestId('new-dm-overlay');
    const statusPicker = screen.getByTestId('status-picker');
    const contextMenu = screen.getByTestId('context-menu');
    const searchDropdown = screen.getByTestId('search-dropdown');
    const tabBar = screen.getByTestId('tab-bar');
    const msgInput = screen.getByTestId('msg-input');

    // TitleBar: 9999
    await expect.element(titlebar).toHaveStyle({ zIndex: '9999' });
    // ShortcutsModal overlay: 2000
    await expect.element(shortcuts).toHaveStyle({ zIndex: '2000' });
    // Modals: 1000
    await expect.element(createChannel).toHaveStyle({ zIndex: '1000' });
    await expect.element(editChannel).toHaveStyle({ zIndex: '1000' });
    await expect.element(newDm).toHaveStyle({ zIndex: '1000' });
    await expect.element(statusPicker).toHaveStyle({ zIndex: '1000' });
    await expect.element(contextMenu).toHaveStyle({ zIndex: '1000' });
    // Search dropdown: 200
    await expect.element(searchDropdown).toHaveStyle({ zIndex: '200' });
    // MobileTabBar: 100
    await expect.element(tabBar).toHaveStyle({ zIndex: '100' });
    // MessageInput: 10
    await expect.element(msgInput).toHaveStyle({ zIndex: '10' });
  });
});

describe('Modal overlays are position fixed inset 0', () => {
  test('all modal overlays use fixed positioning with inset 0', async () => {
    const screen = await render(
      <div>
        <div className="create-channel-overlay" data-testid="create-channel" />
        <div className="edit-channel-overlay" data-testid="edit-channel" />
        <div className="new-dm-overlay" data-testid="new-dm" />
        <div className="shortcuts-overlay" data-testid="shortcuts" />
        <div className="settings-overlay" data-testid="settings" />
      </div>,
    );

    const overlays = ['create-channel', 'edit-channel', 'new-dm', 'shortcuts', 'settings'];
    for (const id of overlays) {
      await expect.element(screen.getByTestId(id)).toHaveStyle({
        position: 'fixed',
        inset: '0px',
      });
    }
  });
});

describe('TitleBar fixed at top', () => {
  test('TitleBar is fixed at top with z-index 9999', async () => {
    const screen = await render(<div className="titlebar" data-testid="titlebar" />);

    await expect.element(screen.getByTestId('titlebar')).toHaveStyle({
      position: 'fixed',
      top: '0px',
      zIndex: '9999',
    });
  });
});
