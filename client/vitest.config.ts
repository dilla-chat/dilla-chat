import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      exclude: ['src/**/*.browser.test.{ts,tsx}', 'node_modules'],
      css: false,
      coverage: {
        provider: 'v8',
        exclude: ['src/test/**', 'src/main.tsx', 'src/App.tsx', '**/*.test.{ts,tsx}', '**/*.css'],
      },
    },
  }),
);
