import { create } from 'zustand';
import { darkTheme } from '../themes/themes';

function applyTheme() {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(darkTheme)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute('data-theme', 'dark');
  root.style.colorScheme = 'dark';
}

interface ThemeState {
  theme: 'dark';
}

export const useThemeStore = create<ThemeState>(() => {
  applyTheme();
  return { theme: 'dark' as const };
});
