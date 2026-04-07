import { IconHome, IconHash, IconMessage, IconUsers } from '@tabler/icons-react';
import './MobileTabBar.css';

export type MobileTab = 'teams' | 'channels' | 'chat' | 'members';

interface MobileTabBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const tabs: { id: MobileTab; label: string; Icon: typeof IconHome }[] = [
  { id: 'teams', label: 'Teams', Icon: IconHome },
  { id: 'channels', label: 'Kanals', Icon: IconHash },
  { id: 'chat', label: 'Chat', Icon: IconMessage },
  { id: 'members', label: 'Members', Icon: IconUsers },
];

export default function MobileTabBar({ activeTab, onTabChange }: Readonly<MobileTabBarProps>) {
  return (
    <nav className="mobile-tab-bar" aria-label="Main navigation">
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          aria-current={activeTab === id ? 'page' : undefined}
          className={`mobile-tab-bar-item ${activeTab === id ? 'active' : ''}`}
          onClick={() => onTabChange(id)}
        >
          <Icon size={22} stroke={1.75} />
          <span className="mobile-tab-bar-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
