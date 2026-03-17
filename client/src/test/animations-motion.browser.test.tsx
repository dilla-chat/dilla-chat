/**
 * Browser-mode tests for CSS animations, keyframes, and pseudo-element transitions.
 * Verifies animation names, pseudo-element indicator heights, and toggle positions.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';

import '../styles/theme.css';
import '../components/MessageList/MessageList.css';
import '../components/VoiceControls/VoiceControls.css';
import '../components/TeamSidebar/TeamSidebar.css';
import '../components/DMList/DMList.css';
import '../pages/UserSettings.css';

describe('Animation keyframes', () => {
  test('messageFlash animation on .message-highlight', async () => {
    await render(
      <div className="message-item message-highlight" data-testid="highlight">
        Highlighted
      </div>,
    );

    const el = document.querySelector('[data-testid="highlight"]');
    const animName = getComputedStyle(el!).animationName;
    expect(animName).toContain('messageFlash');
  });

  test('voice-slide-in animation on .voice-controls', async () => {
    await render(
      <div className="voice-controls" data-testid="voice-controls">
        <div className="voice-controls-row">controls</div>
      </div>,
    );

    const el = document.querySelector('[data-testid="voice-controls"]');
    const animName = getComputedStyle(el!).animationName;
    expect(animName).toContain('voice-slide-in');
  });
});

describe('Pseudo-element indicators', () => {
  test('team-icon-wrapper::before: height 0 default, 40px with .active', async () => {
    await render(
      <div style={{ padding: '20px' }}>
        <div className="team-icon-wrapper" data-testid="wrapper-default">
          <div className="team-icon">T</div>
        </div>
        <div className="team-icon-wrapper active" data-testid="wrapper-active">
          <div className="team-icon">A</div>
        </div>
      </div>,
    );

    const defaultEl = document.querySelector('[data-testid="wrapper-default"]');
    const defaultHeight = getComputedStyle(defaultEl!, '::before').height;
    expect(defaultHeight).toBe('0px');

    const activeEl = document.querySelector('[data-testid="wrapper-active"]');
    const activeHeight = getComputedStyle(activeEl!, '::before').height;
    expect(activeHeight).toBe('40px');
  });

  test('dm-item::before: height 0 default, 40px with .active', async () => {
    await render(
      <div style={{ padding: '20px' }}>
        <div className="dm-item" data-testid="dm-default">
          <span className="dm-item-name">user</span>
        </div>
        <div className="dm-item active" data-testid="dm-active">
          <span className="dm-item-name">active user</span>
        </div>
      </div>,
    );

    const defaultEl = document.querySelector('[data-testid="dm-default"]');
    const defaultHeight = getComputedStyle(defaultEl!, '::before').height;
    expect(defaultHeight).toBe('0px');

    const activeEl = document.querySelector('[data-testid="dm-active"]');
    const activeHeight = getComputedStyle(activeEl!, '::before').height;
    expect(activeHeight).toBe('40px');
  });
});

describe('Toggle switch position', () => {
  test('toggle-switch::after left value changes with .active class', async () => {
    await render(
      <div>
        <button className="toggle-switch" data-testid="toggle-off" />
        <button className="toggle-switch active" data-testid="toggle-on" />
      </div>,
    );

    const offEl = document.querySelector('[data-testid="toggle-off"]');
    const offLeft = getComputedStyle(offEl!, '::after').left;
    expect(offLeft).toBe('3px');

    const onEl = document.querySelector('[data-testid="toggle-on"]');
    const onLeft = getComputedStyle(onEl!, '::after').left;
    expect(onLeft).toBe('19px');
  });
});
