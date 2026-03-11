export interface ThemeColors {
  [key: string]: string;
}

export const darkTheme: ThemeColors = {
  /* Backgrounds — deep indigo/purple */
  '--bg-primary': '#22203a',
  '--bg-secondary': '#1a1829',
  '--bg-tertiary': '#12101e',
  '--bg-accent': '#e84fab',
  '--bg-accent-hover': '#d13d96',
  '--bg-modifier-hover': 'rgba(160, 140, 200, 0.12)',
  '--bg-modifier-active': 'rgba(160, 140, 200, 0.20)',
  '--bg-modifier-selected': 'rgba(160, 140, 200, 0.28)',
  '--bg-floating': '#0e0c18',
  /* Text */
  '--text-primary': '#f0eef5',
  '--text-secondary': '#a9a4b8',
  '--text-muted': '#7a7490',
  '--text-link': '#00d4ff',
  '--text-positive': '#34d37a',
  '--text-danger': '#f2546a',
  '--text-warning': '#e8b84f',
  /* Borders */
  '--border-color': 'rgba(200, 180, 255, 0.10)',
  '--border-subtle': 'rgba(200, 180, 255, 0.08)',
  /* Interactive */
  '--channel-icon': '#7a7490',
  '--interactive-normal': '#a9a4b8',
  '--interactive-hover': '#d8d5e3',
  '--interactive-active': '#ffffff',
  '--interactive-muted': '#4a4560',
  /* Status */
  '--status-online': '#34d37a',
  '--status-idle': '#e8b84f',
  '--status-dnd': '#f2546a',
  '--status-offline': '#7a7490',
  /* Scrollbar */
  '--scrollbar-thin-thumb': '#161424',
  '--scrollbar-thin-track': 'transparent',
  /* Other */
  '--modal-bg': '#1a1829',
  '--input-bg': '#161424',
  /* Aliases */
  '--accent': '#e84fab',
  '--accent-hover': '#d13d96',
  '--danger': '#f2546a',
  '--success': '#34d37a',
  '--warning': '#e8b84f',
  '--hover': 'rgba(160, 140, 200, 0.12)',
  '--active': 'rgba(160, 140, 200, 0.20)',
};
