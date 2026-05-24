import { defineConfig, mergeConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.browser.test.{ts,tsx}'],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
      },
      // v8 coverage works in browser mode too — merging the lcov output
      // with the jsdom run gives Sonar a single combined coverage map.
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        reportsDirectory: './coverage-browser',
        exclude: ['src/test/**', 'src/main.tsx', 'src/App.tsx', '**/*.test.{ts,tsx}', '**/*.css'],
      },
    },
  }),
);
