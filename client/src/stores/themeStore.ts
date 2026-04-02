import { create } from 'zustand';
import { darkTheme, lightTheme, minimalTheme } from '../themes/themes';
import { useUserSettingsStore } from './userSettingsStore';

function applyTheme(theme: 'dark' | 'light' | 'minimal') {
  const root = document.documentElement;
  let colors;
  if (theme === 'light') {
    colors = lightTheme;
  } else if (theme === 'minimal') {
    colors = minimalTheme;
  } else {
    colors = darkTheme;
  }
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

interface ThemeState {
  theme: 'dark' | 'light' | 'minimal';
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
