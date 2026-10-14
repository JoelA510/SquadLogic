import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror vite.config.js so '@squadlogic/core/<file>' imports resolve
    // in unit tests exactly as they do in the app build.
    alias: {
      '@': path.resolve(__dirname, './packages/core/src'),
      src: path.resolve(__dirname, './packages/core/src'),
      '@squadlogic/core': path.resolve(__dirname, './packages/core/src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.js',
    include: ['tests/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['packages/core/src/**', 'frontend/src/hooks/**'],
      // heat/data's `.bin` lookup tables are data, not code: v8 cannot parse them
      // and logged a PARSE_ERROR on every coverage run.
      exclude: ['**/node_modules/**', 'tests/**', '**/*.bin'],
      // CI enforces these (plan item M3.1: Build & Test runs test:coverage).
      // Measured on 2026-10-13 with CI's command: 93.08 / 84.37 / 95.21 / 94.07
      // (statements / branches / functions / lines) overall, and 65.32 / 55.54 /
      // 67.81 / 69.37 for frontend/src/hooks. Each threshold is about 3 points
      // under its figure, rounded down: room for a change that is a little less
      // covered than the rest, not for untested code. The hooks have their own
      // floor because the well-covered core outweighs them about 14 to 1 in the
      // overall figure: deleting all 11 hook test files only moved it to 91.27 /
      // 82.61 / 93.40 / 92.17, and the hooks' own to 41.13 / 33.48 / 46.23 /
      // 43.78. The overall figure counts the hooks too. A PR
      // that drops below one adds the tests, or lowers the figure here with its
      // reason; it never deletes a threshold.
      thresholds: {
        statements: 90,
        branches: 81,
        functions: 92,
        lines: 91,
        'frontend/src/hooks/**': {
          statements: 62,
          branches: 52,
          functions: 64,
          lines: 66,
        },
      },
    },
  },
});
