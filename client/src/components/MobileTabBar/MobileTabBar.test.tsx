import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileTabBar from './MobileTabBar';

describe('MobileTabBar', () => {
  it('renders 4 tabs', () => {
    render(<MobileTabBar activeTab="chat" onTabChange={vi.fn()} />);
    const tabs = screen.getAllByRole('button');
    expect(tabs).toHaveLength(4);
  });

  it('highlights the active tab', () => {
    render(<MobileTabBar activeTab="channels" onTabChange={vi.fn()} />);
    const tabs = screen.getAllByRole('button');
    const channelsTab = tabs.find((t) => t.textContent?.includes('Kanals'));
    expect(channelsTab).toHaveClass('active');
    expect(channelsTab).toHaveAttribute('aria-current', 'page');
  });

  it('calls onTabChange when a tab is clicked', async () => {
    const onTabChange = vi.fn();
    render(<MobileTabBar activeTab="chat" onTabChange={onTabChange} />);
    const tabs = screen.getAllByRole('button');
    const teamsTab = tabs.find((t) => t.textContent?.includes('Teams'));
    expect(teamsTab).toBeDefined();
    await userEvent.click(teamsTab!);
    expect(onTabChange).toHaveBeenCalledWith('teams');
  });

  it('renders correct labels', () => {
    render(<MobileTabBar activeTab="chat" onTabChange={vi.fn()} />);
    expect(screen.getByText('Teams')).toBeInTheDocument();
    expect(screen.getByText('Kanals')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Members')).toBeInTheDocument();
  });
});
