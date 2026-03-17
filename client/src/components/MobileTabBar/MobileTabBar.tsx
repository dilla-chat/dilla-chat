import { HomeSimple, Hashtag, ChatBubble, Group } from 'iconoir-react';
import './MobileTabBar.css';

export type MobileTab = 'teams' | 'channels' | 'chat' | 'members';

interface MobileTabBarProps {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}

const tabs: { id: MobileTab; label: string; Icon: typeof HomeSimple }[] = [
  { id: 'teams', label: 'Teams', Icon: HomeSimple },
  { id: 'channels', label: 'Kanals', Icon: Hashtag },
  { id: 'chat', label: 'Chat', Icon: ChatBubble },
  { id: 'members', label: 'Members', Icon: Group },
];

export default function MobileTabBar({ activeTab, onTabChange }: MobileTabBarProps) {
  return (
    <nav className="mobile-tab-bar" role="tablist">
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          role="tab"
          aria-selected={activeTab === id}
          className={`mobile-tab-bar-item ${activeTab === id ? 'active' : ''}`}
          onClick={() => onTabChange(id)}
        >
          <Icon width={22} height={22} strokeWidth={2} />
          <span className="mobile-tab-bar-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
