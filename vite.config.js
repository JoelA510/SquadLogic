import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';
import { CLIENT_ENV_NAMES, formatEnvProblems, validateClientEnv } from './frontend/src/envRules.js';

const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf8'));

/**
 * Fails a production build whose environment the app would refuse (plan item
 * M2.2): `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` missing without the
 * `VITE_USE_MOCK_SUPABASE=true` opt-in, or any variable malformed. The rules
 * are frontend/src/envRules.js, the same ones frontend/src/env.js runs in the
 * browser. It reads Vite's resolved env (the env files and the process's
 * `VITE_` variables, as the bundle will see them), by name. Before M2.2 such a
 * build succeeded and its runtime guard showed a Configuration Error on every
 * page, before Sentry started, so a deploy missing its variables went READY
 * and reported nothing.
 * @returns {import('vite').Plugin}
 */
function validateEnvOnBuild() {
  return {
    name: 'squadlogic:validate-env',
    configResolved(config) {
      if (config.command !== 'build' || !config.isProduction) return;
      const raw = Object.fromEntries(CLIENT_ENV_NAMES.map((name) => [name, config.env[name]]));
      const { problems } = validateClientEnv(raw, { production: true });
      if (problems.length > 0) {
        throw new Error(
          `[SquadLogic] This production build's environment is invalid, so the build stops:\n` +
            `${formatEnvProblems(problems)}\n` +
            'See docs/operations/ENVIRONMENT.md.'
        );
      }
    },
  };
}

export default defineConfig({
  root: 'frontend',
  envDir: '..', // Look for .env in the project root
  // Sentry release tag (frontend/src/main.jsx): derived from the committed
  // package.json at build time, so no operator-set env var can drift from it.
  //
  // Sentry environment (frontend/src/lib/sentryOptions.js): Vercel's
  // VERCEL_ENV (production / preview / development), so preview events are not
  // reported as production. Exactly that one variable is exposed, by name;
  // never define the whole environment object, which would bundle every build secret.
  // Empty outside Vercel, where the options fall back to their old default.
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    'import.meta.env.VITE_VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV ?? ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './packages/core/src'),
      src: path.resolve(import.meta.dirname, './packages/core/src'),
      '@squadlogic/core': path.resolve(import.meta.dirname, './packages/core/src'),
    },
  },
  plugins: [validateEnvOnBuild(), react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Vite 8 bundles with Rolldown, which has no object form of `manualChunks`; these
        // groups keep the chunks `config/bundle-budget.json` matches by file name. A group
        // captures the modules its `test` matches and, by default, their dependencies, as
        // Rollup's object form did.
        codeSplitting: {
          groups: [
            {
              // react and react-router (react-router-dom re-exports it), plus react-dom's index
              // module only: `react-dom/client` stays in the entry, as it did under Rollup.
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-router|react-router-dom)[\\/]|node_modules[\\/]react-dom[\\/](index|cjs[\\/]react-dom\.production)\.js/,
            },
            { name: 'supabase-vendor', test: /node_modules[\\/]@supabase[\\/]supabase-js[\\/]/ },
            { name: 'lucide-vendor', test: /node_modules[\\/]lucide-react[\\/]/ },
            { name: 'chart-vendor', test: /node_modules[\\/]recharts[\\/]/ },
            {
              name: 'dnd-vendor',
              test: /node_modules[\\/]@dnd-kit[\\/](core|sortable|utilities)[\\/]/,
            },
            { name: 'virtual-vendor', test: /node_modules[\\/]@tanstack[\\/]react-virtual[\\/]/ },
            {
              // Keeps the entry's own static graph in the entry. Rolldown otherwise splits what
              // the entry shares with a lazy chunk (the Sentry core that sentryReplay imports,
              // `AuthContext`) into content-named common chunks that index.html preloads, which
              // no firstPaint rule in the bundle budget can match by a stable name. A group named
              // like the entry joins it; `$initial` limits it to what the entry loads anyway.
              name: 'index',
              tags: ['$initial'],
              test: (id) =>
                !id.includes('node_modules') || /node_modules[\\/]@sentry[\\/]/.test(id),
            },
          ],
        },
      },
    },
    minify: true,
    cssMinify: true,
  },
  server: {
    port: 5173,
  },
});
