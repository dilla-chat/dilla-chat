/**
 * Browser-mode tests for SearchBar CSS behaviors:
 * width transitions on focus, dropdown z-index and backdrop-filter, line-clamp, responsive widths.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe, beforeEach } from 'vitest';
import { page } from 'vitest/browser';

import '../../styles/theme.css';
import './SearchBar.css';

const MOBILE = { w: 375, h: 812 };
const DESKTOP = { w: 1280, h: 900 };

async function setViewport(size: { w: number; h: number }) {
  await page.viewport(size.w, size.h);
  await new Promise((r) => requestAnimationFrame(r));
}

describe('SearchBar width transitions', () => {
  beforeEach(async () => {
    await setViewport(DESKTOP);
  });

  test('default width 200px, focused width 300px', async () => {
    const screen = await render(
      <div className="header-search">
        <div className="header-search-input-wrapper" data-testid="wrapper">
          <input className="header-search-input" placeholder="Search" />
        </div>
      </div>,
    );

    // Default: 200px
    await expect.element(screen.getByTestId('wrapper')).toHaveStyle({ width: '200px' });

    // With focused class: 300px
    screen.getByTestId('wrapper').element().classList.add('focused');
    await new Promise((r) => requestAnimationFrame(r));
    await expect.element(screen.getByTestId('wrapper')).toHaveStyle({ width: '300px' });
  });

  test('mobile: default 140px, focused 200px', async () => {
    await setViewport(MOBILE);

    const screen = await render(
      <div className="header-search">
        <div className="header-search-input-wrapper" data-testid="wrapper">
          <input className="header-search-input" placeholder="Search" />
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('wrapper')).toHaveStyle({ width: '140px' });

    screen.getByTestId('wrapper').element().classList.add('focused');
    await new Promise((r) => requestAnimationFrame(r));
    await expect.element(screen.getByTestId('wrapper')).toHaveStyle({ width: '200px' });
  });
});

describe('SearchBar dropdown', () => {
  test('dropdown: z-index 200, max-height 60vh', async () => {
    const screen = await render(
      <div className="header-search" style={{ position: 'relative' }}>
        <div className="header-search-dropdown" data-testid="dropdown">
          <div className="search-bar-result">result</div>
        </div>
      </div>,
    );

    await expect.element(screen.getByTestId('dropdown')).toHaveStyle({
      zIndex: '200',
    });
    // max-height: 60vh is computed to px — verify it's roughly 60% of viewport height
    const el = document.querySelector('[data-testid="dropdown"]');
    const maxH = parseFloat(getComputedStyle(el!).maxHeight);
    const expected = window.innerHeight * 0.6;
    expect(Math.abs(maxH - expected)).toBeLessThan(2);
  });

  test('dropdown: backdrop-filter applied', async () => {
    await render(
      <div className="header-search" style={{ position: 'relative' }}>
        <div className="header-search-dropdown" data-testid="dropdown">
          <div className="search-bar-result">result</div>
        </div>
      </div>,
    );

    const el = document.querySelector('[data-testid="dropdown"]');
    const bf = getComputedStyle(el!).backdropFilter;
    expect(bf).not.toBe('none');
    expect(bf).toContain('blur');
  });
});

describe('SearchBar result truncation', () => {
  test('search-result-content uses line-clamp: 2', async () => {
    await render(
      <div className="search-bar-result">
        <div className="search-result-content" data-testid="content">
          This is a very long search result content that should be clamped to two lines maximum to
          keep the dropdown compact and readable for users browsing results.
        </div>
      </div>,
    );

    const el = document.querySelector('[data-testid="content"]');
    const style = getComputedStyle(el!);
    expect(style.getPropertyValue('-webkit-line-clamp')).toBe('2');
    expect(style.getPropertyValue('-webkit-box-orient')).toBe('vertical');
    expect(style.overflow).toBe('hidden');
  });
});
