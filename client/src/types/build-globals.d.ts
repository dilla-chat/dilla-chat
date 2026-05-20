// Compile-time constants injected by Vite's `define` (see vite.config.ts).
// Populated from package.json + `git rev-parse --short HEAD` at build time,
// so the version string in the UI footer always matches what we shipped.

declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
