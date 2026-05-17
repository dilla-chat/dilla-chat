import { create } from 'zustand';
import { darkTheme, lightTheme, meshTheme, minimalTheme } from '../themes/themes';
import { useUserSettingsStore } from './userSettingsStore';

type ThemeName = 'dark' | 'light' | 'minimal' | 'mesh';
type Density = 'compact' | 'regular' | 'cozy';

function applyTheme(theme: ThemeName) {
  const root = document.documentElement;
  let colors;
  if (theme === 'light') {
    colors = lightTheme;
  } else if (theme === 'minimal') {
    colors = minimalTheme;
  } else if (theme === 'mesh') {
    colors = meshTheme;
  } else {
    colors = darkTheme;
  }
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(key, value);
  }
  root.dataset.theme = theme;
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
}

function applyDensity(density: Density) {
  document.documentElement.dataset.density = density;
}

interface ThemeState {
  theme: ThemeName;
}

export const useThemeStore = create<ThemeState>(() => {
  const settings = useUserSettingsStore.getState();
  applyTheme(settings.theme);
  applyDensity(settings.density);
  return { theme: settings.theme };
});

// Sync theme + density whenever userSettingsStore changes
useUserSettingsStore.subscribe((state) => {
  const current = useThemeStore.getState().theme;
  if (state.theme !== current) {
    applyTheme(state.theme);
    useThemeStore.setState({ theme: state.theme });
  }
  if (document.documentElement.dataset.density !== state.density) {
    applyDensity(state.density);
  }
});
