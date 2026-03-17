/**
 * Browser-mode tests for ChannelList CSS behaviors that jsdom cannot verify:
 * hover-reveal actions, arrow rotation, text truncation, context menu glass effects.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../../styles/theme.css';
import './ChannelList.css';

describe('ChannelList hover-reveal', () => {
  test('channel-actions hidden by default', async () => {
    const screen = await render(
      <div className="channel-item" data-testid="channel-item">
        <span className="channel-name">general</span>
        <div className="channel-actions" data-testid="channel-actions">
          <button className="channel-action-btn">+</button>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('channel-actions')).toHaveStyle({ display: 'none' });
  });

  test('channel-actions visible on channel-item hover', async () => {
    const screen = await render(
      <div className="channel-item" data-testid="channel-item">
        <span className="channel-name">general</span>
        <div className="channel-actions" data-testid="channel-actions">
          <button className="channel-action-btn">+</button>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('channel-actions')).toHaveStyle({ display: 'none' });
    await screen.getByTestId('channel-item').hover();
    await expect.element(screen.getByTestId('channel-actions')).toHaveStyle({ display: 'flex' });
  });
});

describe('ChannelList category arrow', () => {
  test('category-arrow rotates when collapsed', async () => {
    const screen = await render(
      <div className="channel-category-name">
        <span className="category-arrow collapsed" data-testid="arrow">
          ▶
        </span>
        General
      </div>,
    );

    await expect.element(screen.getByTestId('arrow')).toHaveStyle({
      transform: 'rotate(-90deg)',
    });
  });
});

describe('ChannelList text truncation', () => {
  test('channel-name truncates with ellipsis', async () => {
    const screen = await render(
      <div className="channel-item" style={{ width: '100px' }}>
        <span className="channel-name" data-testid="channel-name">
          this-is-a-very-long-channel-name-that-should-truncate
        </span>
      </div>,
    );

    await expect.element(screen.getByTestId('channel-name')).toHaveStyle({
      textOverflow: 'ellipsis',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    });
  });
});

describe('ChannelList context menu', () => {
  test('context-menu has correct z-index and position', async () => {
    const screen = await render(
      <div className="channel-context-menu" data-testid="ctx-menu" style={{ top: 100, left: 100 }}>
        <div className="channel-context-item">Edit</div>
      </div>,
    );

    await expect.element(screen.getByTestId('ctx-menu')).toHaveStyle({
      position: 'fixed',
      zIndex: '1000',
    });
  });

  test('context-menu has backdrop-filter', async () => {
    const screen = await render(
      <div className="channel-context-menu" data-testid="ctx-menu" style={{ top: 100, left: 100 }}>
        <div className="channel-context-item">Edit</div>
      </div>,
    );

    const el = document.querySelector('[data-testid="ctx-menu"]');
    const bf = getComputedStyle(el!).backdropFilter;
    expect(bf).not.toBe('none');
    expect(bf).toContain('blur');
  });
});
