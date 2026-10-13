import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

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
      '@': path.resolve(__dirname, './packages/core/src'),
      src: path.resolve(__dirname, './packages/core/src'),
      '@squadlogic/core': path.resolve(__dirname, './packages/core/src'),
    },
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'supabase-vendor': ['@supabase/supabase-js'],
          'lucide-vendor': ['lucide-react'],
          'chart-vendor': ['recharts'],
          'dnd-vendor': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'virtual-vendor': ['@tanstack/react-virtual'],
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
