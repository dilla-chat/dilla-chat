import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MobileTabBar from './MobileTabBar';

describe('MobileTabBar', () => {
  it('renders 4 tabs', () => {
    render(<MobileTabBar activeTab="chat" onTabChange={vi.fn()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
  });

  it('highlights the active tab', () => {
    render(<MobileTabBar activeTab="channels" onTabChange={vi.fn()} />);
    const tabs = screen.getAllByRole('tab');
    const channelsTab = tabs.find((t) => t.textContent?.includes('Kanals'));
    expect(channelsTab).toHaveClass('active');
    expect(channelsTab).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onTabChange when a tab is clicked', async () => {
    const onTabChange = vi.fn();
    render(<MobileTabBar activeTab="chat" onTabChange={onTabChange} />);
    const tabs = screen.getAllByRole('tab');
    const teamsTab = tabs.find((t) => t.textContent?.includes('Teams'));
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
