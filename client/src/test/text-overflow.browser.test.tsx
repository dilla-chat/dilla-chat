/**
 * Browser-mode tests for text overflow and truncation across components.
 * Verifies single-line ellipsis and multi-line clamp behaviors.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../styles/theme.css';
import '../components/ChannelList/ChannelList.css';
import '../components/MemberList/MemberList.css';
import '../components/DMList/DMList.css';
import '../components/ThreadPanel/ThreadPanel.css';
import '../components/TeamSidebar/TeamSidebar.css';
import '../components/UserPanel/UserPanel.css';
import '../components/VoiceControls/VoiceControls.css';
import '../components/MessageInput/MessageInput.css';
import '../components/SearchBar/SearchBar.css';
import '../pages/AppLayout.css';

const LONG_TEXT = 'This is a very long text that should definitely be truncated with an ellipsis';

describe('Single-line ellipsis truncation', () => {
  test('representative elements have ellipsis truncation', async () => {
    const screen = await render(
      <div style={{ width: '100px' }}>
        <div className="channel-item">
          <span className="channel-name" data-testid="channel-name">
            {LONG_TEXT}
          </span>
        </div>
        <div className="dm-item">
          <div className="dm-item-info">
            <div className="dm-item-header">
              <span className="dm-item-name" data-testid="dm-item-name">
                {LONG_TEXT}
              </span>
            </div>
          </div>
        </div>
        <div className="member-item">
          <div className="member-info">
            <span className="member-display-name" data-testid="member-display-name">
              {LONG_TEXT}
            </span>
          </div>
        </div>
        <div className="thread-panel-header-info">
          <span className="thread-panel-title" data-testid="thread-panel-title">
            {LONG_TEXT}
          </span>
        </div>
        <div className="server-group">
          <span className="server-label" data-testid="server-label">
            {LONG_TEXT}
          </span>
        </div>
        <div className="user-panel-info">
          <span className="user-panel-name" data-testid="user-panel-name">
            {LONG_TEXT}
          </span>
        </div>
        <div className="voice-controls-peer">
          <span className="voice-peer-name" data-testid="voice-peer-name">
            {LONG_TEXT}
          </span>
        </div>
        <div className="content-header">
          <span className="content-header-topic" data-testid="content-header-topic">
            {LONG_TEXT}
          </span>
        </div>
      </div>,
    );

    const testIds = [
      'channel-name',
      'dm-item-name',
      'member-display-name',
      'thread-panel-title',
      'server-label',
      'user-panel-name',
      'voice-peer-name',
      'content-header-topic',
    ];

    for (const id of testIds) {
      await expect.element(screen.getByTestId(id)).toHaveStyle({
        textOverflow: 'ellipsis',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      });
    }
  });
});

describe('Multi-line clamp', () => {
  test('thread-parent-content uses line-clamp: 3', async () => {
    await render(
      <div className="thread-parent-message">
        <div className="thread-parent-content" data-testid="thread-content">
          This is a very long thread parent message content that should be clamped to three lines
          maximum to keep the thread panel header compact and readable for users browsing threads
          with long initial messages.
        </div>
      </div>,
    );

    const el = document.querySelector('[data-testid="thread-content"]');
    const style = getComputedStyle(el!);
    expect(style.getPropertyValue('-webkit-line-clamp')).toBe('3');
    expect(style.getPropertyValue('-webkit-box-orient')).toBe('vertical');
    expect(style.overflow).toBe('hidden');
  });

  test('search-result-content uses line-clamp: 2', async () => {
    await render(
      <div className="search-bar-result">
        <div className="search-result-content" data-testid="search-content">
          This is a very long search result content that should be clamped to two lines maximum to
          keep the dropdown compact and readable for users browsing results quickly.
        </div>
      </div>,
    );

    const el = document.querySelector('[data-testid="search-content"]');
    const style = getComputedStyle(el!);
    expect(style.getPropertyValue('-webkit-line-clamp')).toBe('2');
    expect(style.getPropertyValue('-webkit-box-orient')).toBe('vertical');
    expect(style.overflow).toBe('hidden');
  });
});
