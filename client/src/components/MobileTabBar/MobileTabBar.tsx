import { HomeSimple, Hashtag, ChatBubble, Group } from 'iconoir-react';

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

export default function MobileTabBar({ activeTab, onTabChange }: Readonly<MobileTabBarProps>) {
  return (
    <nav
      className="flex items-center justify-around h-[var(--bottom-tab-height)] min-h-[var(--bottom-tab-height)] bg-glass-tertiary backdrop-blur-glass border-t border-glass-border shrink-0 p-0 z-[100]"
      aria-label="Main navigation"
    >
      {tabs.map(({ id, label, Icon }) => (
        <button
          key={id}
          aria-current={activeTab === id ? 'page' : undefined}
          className={`flex flex-col items-center justify-center gap-0.5 flex-1 h-full bg-none border-none cursor-pointer py-1 px-0 transition-colors duration-150 ease-linear [-webkit-tap-highlight-color:transparent] ${activeTab === id ? 'text-brand' : 'text-interactive'}`}
          onClick={() => onTabChange(id)}
        >
          <Icon width={22} height={22} strokeWidth={2} />
          <span className="text-micro font-semibold tracking-[0.02em]">{label}</span>
        </button>
      ))}
    </nav>
  );
}
