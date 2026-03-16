// Dilla-harmonized username color palette
const USERNAME_COLORS = [
  '#2e8b9a', // teal (brand)
  '#e8b84b', // amber (accent)
  '#4caf82', // green
  '#d05a4a', // coral red
  '#3ba8ba', // light teal
  '#9c6fb0', // muted purple
  '#e09040', // warm orange
  '#5b9bd5', // soft blue
  '#c75b8f', // rose
  '#6aab8e', // sage
  '#b87333', // copper
  '#7b8fa8', // steel blue
];

export function usernameColor(username: string): string {
  const name = username || 'Unknown';
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USERNAME_COLORS[Math.abs(hash) % USERNAME_COLORS.length];
}

export function getInitials(username: string): string {
  return (username || '?').slice(0, 2).toUpperCase();
}
