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
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 55,
        lines: 60,
      },
    },
  },
});
