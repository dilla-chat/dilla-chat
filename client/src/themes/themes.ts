export interface ThemeColors {
  [key: string]: string;
}

export const darkTheme: ThemeColors = {
  /* Backgrounds — Midnight Teal */
  '--bg-primary': '#111c25',
  '--bg-secondary': '#0a1018',
  '--bg-tertiary': '#070b10',
  '--bg-accent': '#f59e0b',
  '--bg-accent-hover': '#fbbf24',
  '--bg-modifier-hover': 'rgba(255, 255, 255, 0.04)',
  '--bg-modifier-active': 'rgba(255, 255, 255, 0.08)',
  '--bg-modifier-selected': 'rgba(255, 255, 255, 0.12)',
  '--bg-floating': '#0c1418',
  /* Text */
  '--text-primary': '#e8edf2',
  '--text-secondary': 'rgba(255, 255, 255, 0.4)',
  '--text-muted': 'rgba(255, 255, 255, 0.25)',
  '--text-link': '#22d3ee',
  '--text-positive': '#10b981',
  '--text-danger': '#ef4444',
  '--text-warning': '#f59e0b',
  /* Borders */
  '--border-color': 'rgba(255, 255, 255, 0.06)',
  '--border-subtle': 'rgba(255, 255, 255, 0.03)',
  /* Interactive */
  '--channel-icon': 'rgba(255, 255, 255, 0.25)',
  '--interactive-normal': 'rgba(255, 255, 255, 0.45)',
  '--interactive-hover': 'rgba(255, 255, 255, 0.7)',
  '--interactive-active': '#e8edf2',
  '--interactive-muted': 'rgba(255, 255, 255, 0.1)',
  /* Status */
  '--status-online': '#10b981',
  '--status-idle': '#f59e0b',
  '--status-dnd': '#ef4444',
  '--status-offline': 'rgba(255, 255, 255, 0.2)',
  /* Scrollbar */
  '--scrollbar-thin-thumb': 'rgba(255, 255, 255, 0.08)',
  '--scrollbar-thin-track': 'transparent',
  /* Other */
  '--modal-bg': '#0c1418',
  '--input-bg': 'rgba(255, 255, 255, 0.03)',
  /* Aliases */
  '--accent': '#f59e0b',
  '--accent-hover': '#fbbf24',
  '--danger': '#ef4444',
  '--success': '#10b981',
  '--warning': '#f59e0b',
  '--hover': 'rgba(255, 255, 255, 0.04)',
  '--active': 'rgba(255, 255, 255, 0.08)',
  /* Header */
  '--header-primary': '#e8edf2',
  '--header-secondary': 'rgba(255, 255, 255, 0.4)',
  /* Brand */
  '--brand-500': '#0ea5c0',
  '--brand-560': '#22d3ee',
  '--text-normal': 'rgba(255, 255, 255, 0.6)',
  /* Brand-specific */
  '--color-encrypted': '#10b981',
  '--shadow-glow-brand': '0 0 20px rgba(14, 165, 192, 0.25)',
  '--shadow-glow-accent': '0 0 20px rgba(245, 158, 11, 0.2)',
  /* Glass */
  '--glass-blur': '12px',
  '--glass-blur-heavy': '20px',
  '--glass-blur-light': '8px',
  '--glass-bg-primary': 'rgba(17, 28, 37, 0.85)',
  '--glass-bg-secondary': 'rgba(10, 16, 24, 0.80)',
  '--glass-bg-tertiary': 'rgba(7, 11, 16, 0.90)',
  '--glass-bg-floating': 'rgba(12, 20, 24, 0.92)',
  '--glass-bg-modal': 'rgba(10, 16, 24, 0.95)',
  '--glass-border': 'rgba(255, 255, 255, 0.06)',
  '--glass-border-light': 'rgba(255, 255, 255, 0.03)',
  '--glass-highlight': 'rgba(255, 255, 255, 0.04)',
  '--glass-shadow': '0 8px 32px rgba(0, 0, 0, 0.3)',
  '--glass-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.4)',
  /* Gradients */
  '--gradient-brand': 'linear-gradient(135deg, #0ea5c0 0%, #0d8ca5 100%)',
  '--gradient-accent': 'linear-gradient(135deg, #f59e0b 0%, #d4880a 100%)',
  '--gradient-surface': 'linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, transparent 100%)',
  /* Overlays */
  '--overlay-dark': 'rgba(0, 0, 0, 0.5)',
  '--overlay-light': 'rgba(0, 0, 0, 0.15)',
  '--overlay-heavy': 'rgba(0, 0, 0, 0.85)',
  '--white-overlay-subtle': 'rgba(255, 255, 255, 0.06)',
  '--white-overlay-light': 'rgba(255, 255, 255, 0.1)',
  '--white-overlay-medium': 'rgba(255, 255, 255, 0.7)',
  /* Brand alpha */
  '--brand-alpha-10': 'rgba(14, 165, 192, 0.1)',
  '--brand-alpha-12': 'rgba(14, 165, 192, 0.12)',
  '--brand-alpha-15': 'rgba(14, 165, 192, 0.15)',
  '--brand-alpha-20': 'rgba(14, 165, 192, 0.2)',
  '--brand-alpha-25': 'rgba(14, 165, 192, 0.25)',
  /* Accent alpha */
  '--accent-alpha-08': 'rgba(245, 158, 11, 0.08)',
  '--accent-alpha-10': 'rgba(245, 158, 11, 0.10)',
  '--accent-alpha-15': 'rgba(245, 158, 11, 0.15)',
  '--accent-alpha-20': 'rgba(245, 158, 11, 0.2)',
  '--accent-alpha-25': 'rgba(245, 158, 11, 0.25)',
  '--accent-alpha-30': 'rgba(245, 158, 11, 0.3)',
  /* Danger alpha */
  '--danger-alpha-15': 'rgba(239, 68, 68, 0.15)',
  '--danger-alpha-25': 'rgba(239, 68, 68, 0.25)',
  /* Success alpha */
  '--success-alpha-15': 'rgba(16, 185, 129, 0.15)',
  '--success-alpha-35': 'rgba(16, 185, 129, 0.35)',
  '--success-alpha-40': 'rgba(16, 185, 129, 0.4)',
  /* Divider */
  '--divider': 'rgba(255, 255, 255, 0.03)',
  /* Status extras */
  '--green-360': '#10b981',
  '--yellow-300': '#f59e0b',
  '--red-400': '#ef4444',
};

export const lightTheme: ThemeColors = {
  '--bg-primary': '#ffffff',
  '--bg-secondary': '#f2f3f5',
  '--bg-tertiary': '#e3e5e8',
  '--bg-accent': '#c49000',
  '--bg-accent-hover': '#a87a00',
  '--bg-modifier-hover': 'rgba(79, 84, 92, 0.08)',
  '--bg-modifier-active': 'rgba(79, 84, 92, 0.16)',
  '--bg-modifier-selected': 'rgba(79, 84, 92, 0.24)',
  '--bg-floating': '#ffffff',
  '--text-primary': '#060607',
  '--text-secondary': '#4f5660',
  '--text-muted': '#80848e',
  '--text-link': '#0068b8',
  '--text-positive': '#248045',
  '--text-danger': '#c43535',
  '--text-warning': '#9a6700',
  '--border-color': 'rgba(79, 84, 92, 0.16)',
  '--border-subtle': 'rgba(79, 84, 92, 0.10)',
  '--channel-icon': '#6d6f78',
  '--interactive-normal': '#4f5660',
  '--interactive-hover': '#2e3338',
  '--interactive-active': '#060607',
  '--interactive-muted': '#c7c8ce',
  '--status-online': '#248045',
  '--status-idle': '#9a6700',
  '--status-dnd': '#c43535',
  '--status-offline': '#80848e',
  '--scrollbar-thin-thumb': '#c7c8ce',
  '--scrollbar-thin-track': 'transparent',
  '--modal-bg': '#ffffff',
  '--input-bg': '#e3e5e8',
  '--accent': '#c49000',
  '--accent-hover': '#a87a00',
  '--danger': '#c43535',
  '--success': '#248045',
  '--warning': '#9a6700',
  '--hover': 'rgba(79, 84, 92, 0.08)',
  '--active': 'rgba(79, 84, 92, 0.16)',
  /* Text */
  '--text-normal': '#2e3338',
  /* Header */
  '--header-primary': '#060607',
  '--header-secondary': '#4f5660',
  /* Brand */
  '--brand-500': '#0068b8',
  '--brand-560': '#0078d4',
  /* Brand-specific */
  '--color-encrypted': '#248045',
  '--shadow-glow-brand': '0 0 16px rgba(0,104,184,0.2)',
  '--shadow-glow-accent': '0 0 16px rgba(196,144,0,0.2)',
  /* Glass */
  '--glass-blur': '12px',
  '--glass-blur-heavy': '20px',
  '--glass-blur-light': '8px',
  '--glass-bg-primary': 'rgba(255, 255, 255, 0.85)',
  '--glass-bg-secondary': 'rgba(242, 243, 245, 0.80)',
  '--glass-bg-tertiary': 'rgba(227, 229, 232, 0.90)',
  '--glass-bg-floating': 'rgba(255, 255, 255, 0.90)',
  '--glass-bg-modal': 'rgba(255, 255, 255, 0.92)',
  '--glass-border': 'rgba(79, 84, 92, 0.12)',
  '--glass-border-light': 'rgba(79, 84, 92, 0.06)',
  '--glass-highlight': 'rgba(255, 255, 255, 0.5)',
  '--glass-shadow': '0 8px 32px rgba(0, 0, 0, 0.1)',
  '--glass-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.15)',
  /* Gradients */
  '--gradient-brand': 'linear-gradient(135deg, #0068b8 0%, #004d8a 100%)',
  '--gradient-accent': 'linear-gradient(135deg, #c49000 0%, #a87a00 100%)',
  '--gradient-surface': 'linear-gradient(180deg, rgba(79, 84, 92, 0.04) 0%, transparent 100%)',
  /* Overlays */
  '--overlay-dark': 'rgba(0, 0, 0, 0.3)',
  '--overlay-light': 'rgba(0, 0, 0, 0.08)',
  '--overlay-heavy': 'rgba(0, 0, 0, 0.6)',
  '--white-overlay-subtle': 'rgba(255, 255, 255, 0.3)',
  '--white-overlay-light': 'rgba(255, 255, 255, 0.5)',
  '--white-overlay-medium': 'rgba(255, 255, 255, 0.85)',
  /* Brand alpha */
  '--brand-alpha-10': 'rgba(14, 165, 192, 0.1)',
  '--brand-alpha-12': 'rgba(14, 165, 192, 0.12)',
  '--brand-alpha-15': 'rgba(14, 165, 192, 0.15)',
  '--brand-alpha-20': 'rgba(14, 165, 192, 0.2)',
  '--brand-alpha-25': 'rgba(14, 165, 192, 0.25)',
  /* Accent alpha */
  '--accent-alpha-08': 'rgba(245, 158, 11, 0.08)',
  '--accent-alpha-10': 'rgba(245, 158, 11, 0.10)',
  '--accent-alpha-15': 'rgba(245, 158, 11, 0.15)',
  '--accent-alpha-20': 'rgba(245, 158, 11, 0.2)',
  '--accent-alpha-25': 'rgba(245, 158, 11, 0.25)',
  '--accent-alpha-30': 'rgba(245, 158, 11, 0.3)',
  /* Danger alpha */
  '--danger-alpha-15': 'rgba(239, 68, 68, 0.15)',
  '--danger-alpha-25': 'rgba(239, 68, 68, 0.25)',
  /* Success alpha */
  '--success-alpha-15': 'rgba(16, 185, 129, 0.15)',
  '--success-alpha-35': 'rgba(16, 185, 129, 0.35)',
  '--success-alpha-40': 'rgba(16, 185, 129, 0.4)',
  /* Divider */
  '--divider': 'rgba(79, 84, 92, 0.10)',
  /* Status extras */
  '--green-360': '#248045',
  '--yellow-300': '#9a6700',
  '--red-400': '#c43535',
};

export const minimalTheme: ThemeColors = {
  /* Backgrounds — neutral dark grays */
  '--bg-primary': '#1a1a1a',
  '--bg-secondary': '#141414',
  '--bg-tertiary': '#0f0f0f',
  '--bg-accent': '#5c7a99',
  '--bg-accent-hover': '#4a6580',
  '--bg-modifier-hover': 'rgba(255, 255, 255, 0.06)',
  '--bg-modifier-active': 'rgba(255, 255, 255, 0.10)',
  '--bg-modifier-selected': 'rgba(255, 255, 255, 0.14)',
  '--bg-floating': '#0a0a0a',
  /* Text */
  '--text-primary': '#e0e0e0',
  '--text-secondary': '#b0b0b0',
  '--text-muted': '#888888',
  '--text-link': '#7aadcc',
  '--text-positive': '#4caf7d',
  '--text-danger': '#d96b6b',
  '--text-warning': '#c8a050',
  /* Borders */
  '--border-color': 'rgba(255, 255, 255, 0.08)',
  '--border-subtle': 'rgba(255, 255, 255, 0.05)',
  /* Interactive */
  '--channel-icon': '#888888',
  '--interactive-normal': '#b0b0b0',
  '--interactive-hover': '#d0d0d0',
  '--interactive-active': '#f0f0f0',
  '--interactive-muted': '#444444',
  /* Status */
  '--status-online': '#4caf7d',
  '--status-idle': '#c8a050',
  '--status-dnd': '#d96b6b',
  '--status-offline': '#666666',
  /* Scrollbar */
  '--scrollbar-thin-thumb': '#333333',
  '--scrollbar-thin-track': 'transparent',
  /* Other */
  '--modal-bg': '#141414',
  '--input-bg': '#111111',
  /* Aliases */
  '--accent': '#5c7a99',
  '--accent-hover': '#4a6580',
  '--danger': '#d96b6b',
  '--success': '#4caf7d',
  '--warning': '#c8a050',
  '--hover': 'rgba(255, 255, 255, 0.06)',
  '--active': 'rgba(255, 255, 255, 0.10)',
  /* Header */
  '--header-primary': '#f0f0f0',
  '--header-secondary': '#b0b0b0',
  /* Brand */
  '--brand-500': '#5c7a99',
  '--brand-560': '#7a9ab8',
  '--text-normal': '#d0d0d0',
  /* Brand-specific */
  '--color-encrypted': '#4caf7d',
  '--shadow-glow-brand': '0 0 16px rgba(92, 122, 153, 0.3)',
  '--shadow-glow-accent': '0 0 16px rgba(160, 147, 125, 0.25)',
  /* Glass */
  '--glass-blur': '12px',
  '--glass-blur-heavy': '20px',
  '--glass-blur-light': '8px',
  '--glass-bg-primary': 'rgba(26, 26, 26, 0.85)',
  '--glass-bg-secondary': 'rgba(20, 20, 20, 0.80)',
  '--glass-bg-tertiary': 'rgba(15, 15, 15, 0.90)',
  '--glass-bg-floating': 'rgba(10, 10, 10, 0.90)',
  '--glass-bg-modal': 'rgba(20, 20, 20, 0.92)',
  '--glass-border': 'rgba(255, 255, 255, 0.08)',
  '--glass-border-light': 'rgba(255, 255, 255, 0.04)',
  '--glass-highlight': 'rgba(255, 255, 255, 0.03)',
  '--glass-shadow': '0 8px 32px rgba(0, 0, 0, 0.4)',
  '--glass-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.5)',
  /* Gradients */
  '--gradient-brand': 'linear-gradient(135deg, #5c7a99 0%, #3d5a73 100%)',
  '--gradient-accent': 'linear-gradient(135deg, #a0937d 0%, #7a6f60 100%)',
  '--gradient-surface': 'linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, transparent 100%)',
  /* Overlays */
  '--overlay-dark': 'rgba(0, 0, 0, 0.5)',
  '--overlay-light': 'rgba(0, 0, 0, 0.15)',
  '--overlay-heavy': 'rgba(0, 0, 0, 0.85)',
  '--white-overlay-subtle': 'rgba(255, 255, 255, 0.04)',
  '--white-overlay-light': 'rgba(255, 255, 255, 0.08)',
  '--white-overlay-medium': 'rgba(255, 255, 255, 0.65)',
  /* Brand alpha */
  '--brand-alpha-10': 'rgba(14, 165, 192, 0.1)',
  '--brand-alpha-12': 'rgba(14, 165, 192, 0.12)',
  '--brand-alpha-15': 'rgba(14, 165, 192, 0.15)',
  '--brand-alpha-20': 'rgba(14, 165, 192, 0.2)',
  '--brand-alpha-25': 'rgba(14, 165, 192, 0.25)',
  /* Accent alpha */
  '--accent-alpha-08': 'rgba(245, 158, 11, 0.08)',
  '--accent-alpha-10': 'rgba(245, 158, 11, 0.10)',
  '--accent-alpha-15': 'rgba(245, 158, 11, 0.15)',
  '--accent-alpha-20': 'rgba(245, 158, 11, 0.2)',
  '--accent-alpha-25': 'rgba(245, 158, 11, 0.25)',
  '--accent-alpha-30': 'rgba(245, 158, 11, 0.3)',
  /* Danger alpha */
  '--danger-alpha-15': 'rgba(239, 68, 68, 0.15)',
  '--danger-alpha-25': 'rgba(239, 68, 68, 0.25)',
  /* Success alpha */
  '--success-alpha-15': 'rgba(16, 185, 129, 0.15)',
  '--success-alpha-35': 'rgba(16, 185, 129, 0.35)',
  '--success-alpha-40': 'rgba(16, 185, 129, 0.4)',
  /* Divider */
  '--divider': 'rgba(255, 255, 255, 0.06)',
  /* Status extras */
  '--green-360': '#4caf7d',
  '--yellow-300': '#c8a050',
  '--red-400': '#d96b6b',
};
