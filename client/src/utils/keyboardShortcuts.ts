const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
const mod = isMac ? '\u2318' : 'Ctrl';

export interface KeyboardShortcut {
  key: string;
  action: string;
  group: string;
}

export interface ShortcutGroup {
  group: string;
  shortcuts: KeyboardShortcut[];
}

export const shortcuts: KeyboardShortcut[] = [
  { key: `${mod}+K`, action: 'shortcuts.search', group: 'shortcuts.group.navigation' },
  { key: 'Escape', action: 'shortcuts.closePanel', group: 'shortcuts.group.navigation' },
  { key: 'Alt+\u2191/\u2193', action: 'shortcuts.navigateChannels', group: 'shortcuts.group.navigation' },
  { key: `${mod}+/`, action: 'shortcuts.showShortcuts', group: 'shortcuts.group.navigation' },
  { key: `${mod}+Shift+M`, action: 'shortcuts.toggleMute', group: 'shortcuts.group.voice' },
  { key: `${mod}+Shift+D`, action: 'shortcuts.toggleDeafen', group: 'shortcuts.group.voice' },
];

export function groupedShortcuts(): ShortcutGroup[] {
  const map = new Map<string, KeyboardShortcut[]>();
  for (const s of shortcuts) {
    const existing = map.get(s.group);
    if (existing) {
      existing.push(s);
    } else {
      map.set(s.group, [s]);
    }
  }
  return Array.from(map.entries()).map(([group, items]) => ({ group, shortcuts: items }));
}
