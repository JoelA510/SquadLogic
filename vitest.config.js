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
      // Measured 93.05 / 84.28 / 95.19 / 94.04 on 2026-10-13; each threshold
      // is about one point under it. At 60 / 50 / 55 / 60 the gate had 30+
      // points of slack, so deleting a whole test file never failed it. A PR
      // that drops below one adds the tests, or lowers the figure here with
      // its reason; it never deletes the threshold.
      thresholds: {
        statements: 92,
        branches: 83,
        functions: 94,
        lines: 93,
      },
    },
  },
});
