import { create } from 'zustand';
import { darkTheme, lightTheme } from '../themes/themes';
import { useUserSettingsStore } from './userSettingsStore';

function applyTheme(theme: 'dark' | 'light') {
  const root = document.documentElement;
  const colors = theme === 'light' ? lightTheme : darkTheme;
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
}

interface ThemeState {
  theme: 'dark' | 'light';
}

export const useThemeStore = create<ThemeState>(() => {
  const theme = useUserSettingsStore.getState().theme;
  applyTheme(theme);
  return { theme };
});

// Sync theme whenever userSettingsStore changes
useUserSettingsStore.subscribe((state) => {
  const current = useThemeStore.getState().theme;
  if (state.theme !== current) {
    applyTheme(state.theme);
    useThemeStore.setState({ theme: state.theme });
  }
});
