import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';
import dotenv from 'dotenv';

// Load environment variables from .env
dotenv.config();

const testDir = defineBddConfig({
  features: 'tests/e2e/features/**/*.feature',
  steps: 'tests/e2e/steps/**/*.ts',
  outputDir: '.features-gen-local',
});

const config = defineConfig({
  testDir,
  globalTeardown: './tests/e2e/global-teardown.ts',
  reporter: 'html',
  fullyParallel: true,
  workers: process.env.CI ? '100%' : '50%',
  // Give Vite dev server time to lazily compile route chunks on first access
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  use: {
    // CRITICAL: Allows step definitions to use relative paths like page.goto('/teams')
    baseURL: 'http://localhost:5173',
    trace: 'on',
    screenshot: 'only-on-failure', // Highly recommended for vision-agent debugging
    actionTimeout: 10000,
  },
  // CRITICAL: Auto-start the Vite dev server before running tests
  webServer: {
    command: 'npm run frontend:dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
    env: {
      VITE_USE_MOCK_SUPABASE: 'true',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

// The real-backend project (plan item M4.1): a few scenarios against a local
// Supabase stack (`supabase start`, seeded by tests/e2e/real-backend/seed.sql),
// run by .github/workflows/e2e-real-backend.yml. It exists only when that
// stack's API URL is in the environment, so the mock suite (`npm run
// test:e2e`, ci.yml) sees exactly the configuration above and nothing more.
// Its features and steps live under tests/e2e/real-backend/, outside the mock
// project's globs, so neither project loads the other's steps.
const realBackendUrl = process.env.E2E_REAL_BACKEND_SUPABASE_URL?.replace(/\/+$/, '');
if (realBackendUrl) {
  const port = 5174;
  const mockServers = config.webServer;
  config.webServer = [
    ...(Array.isArray(mockServers) ? mockServers : mockServers ? [mockServers] : []),
    {
      // A production build of the real client, served by `vite preview`: the
      // shape that ships (no mock chunk, no StrictMode double effects), against
      // the local stack and its Edge Functions. Built into its own directory
      // (paths are relative to Vite's root, frontend/) so `dist/` is untouched.
      command:
        'npx vite build --outDir ../.real-backend-dist --emptyOutDir && ' +
        `npx vite preview --outDir ../.real-backend-dist --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300 * 1000,
      env: {
        VITE_USE_MOCK_SUPABASE: 'false',
        VITE_SUPABASE_URL: realBackendUrl,
        VITE_SUPABASE_ANON_KEY: process.env.E2E_REAL_BACKEND_ANON_KEY ?? '',
        VITE_SUPABASE_PERSISTENCE_URL: `${realBackendUrl}/functions/v1`,
      },
    },
  ];
  config.projects = [
    ...(config.projects ?? []),
    {
      name: 'real-backend',
      testDir: defineBddConfig({
        features: 'tests/e2e/real-backend/features/**/*.feature',
        steps: 'tests/e2e/real-backend/steps/**/*.ts',
        outputDir: '.features-gen-real-backend',
      }),
      // One shared database, so the scenarios run one at a time, in order.
      fullyParallel: false,
      timeout: 180000,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${port}` },
    },
  ];
}

export default config;
