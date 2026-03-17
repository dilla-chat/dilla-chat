/**
 * Browser-mode tests for MessageList CSS behaviors:
 * hover-reveal actions, action bar positioning, backdrop-filter, animations, scroll padding.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../../styles/theme.css';
import './MessageList.css';

describe('MessageList hover-reveal actions', () => {
  test('message-actions hidden by default', async () => {
    const screen = await render(
      <div className="message-item" data-testid="message-item">
        <span className="message-content">Hello world</span>
        <div className="message-actions" data-testid="message-actions">
          <button className="message-action-btn">X</button>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('message-actions')).toHaveStyle({ display: 'none' });
  });

  test('message-actions visible on message-item hover', async () => {
    const screen = await render(
      <div className="message-item" data-testid="message-item">
        <span className="message-content">Hello world</span>
        <div className="message-actions" data-testid="message-actions">
          <button className="message-action-btn">X</button>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('message-actions')).toHaveStyle({ display: 'none' });
    await screen.getByTestId('message-item').hover();
    await expect.element(screen.getByTestId('message-actions')).toHaveStyle({ display: 'flex' });
  });
});

describe('MessageList action bar positioning', () => {
  test('message-actions positioned correctly', async () => {
    const screen = await render(
      <div className="message-item" style={{ position: 'relative', height: '60px' }}>
        <span className="message-content">Hello</span>
        <div className="message-actions" data-testid="message-actions" style={{ display: 'flex' }}>
          <button className="message-action-btn">X</button>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('message-actions')).toHaveStyle({
      position: 'absolute',
      top: '-16px',
      right: '4px',
    });
  });

  test('message-actions has backdrop-filter', async () => {
    const screen = await render(
      <div className="message-item">
        <div className="message-actions" data-testid="message-actions" style={{ display: 'flex' }}>
          <button className="message-action-btn">X</button>
        </div>
      </div>,
    );

    const el = document.querySelector('[data-testid="message-actions"]');
    const bf = getComputedStyle(el!).backdropFilter;
    expect(bf).not.toBe('none');
    expect(bf).toContain('blur');
  });
});

describe('MessageList animations', () => {
  test('messageFlash animation applied to highlight', async () => {
    await render(
      <div className="message-item message-highlight" data-testid="highlight">
        <span className="message-content">Highlighted message</span>
      </div>,
    );

    const el = document.querySelector('[data-testid="highlight"]');
    const animName = getComputedStyle(el!).animationName;
    expect(animName).toContain('messageFlash');
  });
});

describe('MessageList scroll padding', () => {
  test('message-list has 140px bottom padding', async () => {
    const screen = await render(
      <div className="message-list" data-testid="message-list">
        <div>message</div>
      </div>,
    );

    await expect.element(screen.getByTestId('message-list')).toHaveStyle({
      paddingBottom: '140px',
    });
  });
});

describe('MessageList group hover', () => {
  test('message-group hover background', async () => {
    const screen = await render(
      <div className="message-group" data-testid="message-group">
        <div className="message-group-content">content</div>
      </div>,
    );

    await screen.getByTestId('message-group').hover();

    const el = document.querySelector('[data-testid="message-group"]');
    const bg = getComputedStyle(el!).backgroundColor;
    // On hover, background should be var(--bg-modifier-hover) which resolves to a non-transparent value
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  });
});
