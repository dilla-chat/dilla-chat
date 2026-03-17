/**
 * Browser-mode tests for the MobileTabBar component.
 * Runs in real Chromium to verify CSS rendering and interactions.
 */
import { render } from 'vitest-browser-react';
import { expect, test, describe } from 'vitest';
import { page } from 'vitest/browser';
import MobileTabBar from './MobileTabBar';
import type { MobileTab } from './MobileTabBar';
import '../../styles/theme.css';

const MOBILE = { w: 375, h: 812 };

describe('MobileTabBar browser', () => {
  test('renders with correct height and layout', async () => {
    await page.viewport(MOBILE.w, MOBILE.h);

    const screen = await render(
      <MobileTabBar activeTab="chat" onTabChange={() => {}} />,
    );

    const tabBar = screen.getByRole('tablist');
    // --bottom-tab-height is 56px
    await expect.element(tabBar).toHaveStyle({ height: '56px' });
    await expect.element(tabBar).toBeVisible();
  });

  test('active tab has brand color', async () => {
    await page.viewport(MOBILE.w, MOBILE.h);

    const screen = await render(
      <MobileTabBar activeTab="channels" onTabChange={() => {}} />,
    );

    const activeTab = screen.getByRole('tab', { name: /kanals/i });
    // --brand-500 = #2e8b9a = rgb(46, 139, 154)
    await expect.element(activeTab).toHaveStyle({ color: 'rgb(46, 139, 154)' });

    // Inactive tabs have --interactive-normal = #8fa3b8 = rgb(143, 163, 184)
    const inactiveTab = screen.getByRole('tab', { name: /teams/i });
    await expect.element(inactiveTab).toHaveStyle({ color: 'rgb(143, 163, 184)' });
  });

  test('tabs are evenly distributed', async () => {
    await page.viewport(MOBILE.w, MOBILE.h);

    const screen = await render(
      <MobileTabBar activeTab="chat" onTabChange={() => {}} />,
    );

    // All four tabs should have flex: 1 (equal distribution)
    const tabs = ['Teams', 'Kanals', 'Chat', 'Members'];
    for (const tabName of tabs) {
      const tab = screen.getByRole('tab', { name: tabName });
      await expect.element(tab).toHaveStyle({ flex: '1' });
    }
  });

  test('clicking a tab triggers onTabChange', async () => {
    await page.viewport(MOBILE.w, MOBILE.h);

    let lastTab: MobileTab | null = null;
    const screen = await render(
      <MobileTabBar activeTab="chat" onTabChange={(tab) => { lastTab = tab; }} />,
    );

    await screen.getByRole('tab', { name: /members/i }).click();
    expect(lastTab).toBe('members');

    await screen.getByRole('tab', { name: /teams/i }).click();
    expect(lastTab).toBe('teams');
  });
});
