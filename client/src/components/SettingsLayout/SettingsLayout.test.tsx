import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsLayout, { type NavSection } from './SettingsLayout';

// Mock iconoir-react
vi.mock('iconoir-react', () => ({
  Xmark: () => <span data-testid="xmark-icon" />,
}));

// Mock TitleBar component
vi.mock('../TitleBar/TitleBar', () => ({
  default: () => <div data-testid="title-bar" />,
}));

const sections: NavSection[] = [
  {
    label: 'User Settings',
    items: [
      { id: 'account', label: 'My Account' },
      { id: 'appearance', label: 'Appearance' },
    ],
  },
  {
    items: [
      { id: 'logout', label: 'Log Out', danger: true },
    ],
  },
];

describe('SettingsLayout', () => {
  it('renders nav sections and items', () => {
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={vi.fn()} onClose={vi.fn()}>
        <div>Content</div>
      </SettingsLayout>,
    );
    expect(screen.getByText('User Settings')).toBeInTheDocument();
    expect(screen.getByText('My Account')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('Log Out')).toBeInTheDocument();
  });

  it('highlights active item', () => {
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={vi.fn()} onClose={vi.fn()}>
        <div>Content</div>
      </SettingsLayout>,
    );
    const accountItem = screen.getByText('My Account');
    expect(accountItem.className).toContain('active');
  });

  it('clicking item calls onSelect', () => {
    const onSelect = vi.fn();
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={onSelect} onClose={vi.fn()}>
        <div>Content</div>
      </SettingsLayout>,
    );
    fireEvent.click(screen.getByText('Appearance'));
    expect(onSelect).toHaveBeenCalledWith('appearance');
  });

  it('Escape key calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={vi.fn()} onClose={onClose}>
        <div>Content</div>
      </SettingsLayout>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={vi.fn()} onClose={onClose}>
        <div>Content</div>
      </SettingsLayout>,
    );
    fireEvent.click(screen.getByText('ESC').previousElementSibling!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders children', () => {
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={vi.fn()} onClose={vi.fn()}>
        <div>My Content</div>
      </SettingsLayout>,
    );
    expect(screen.getByText('My Content')).toBeInTheDocument();
  });

  it('danger items have danger class', () => {
    render(
      <SettingsLayout sections={sections} activeId="account" onSelect={vi.fn()} onClose={vi.fn()}>
        <div>Content</div>
      </SettingsLayout>,
    );
    const logoutItem = screen.getByText('Log Out');
    expect(logoutItem.className).toContain('danger');
  });
});
