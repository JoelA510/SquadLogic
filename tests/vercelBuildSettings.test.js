// @vitest-environment node
/**
 * Vercel's build settings live in vercel.json, not only in the dashboard
 * (audit finding 7.3, plan item M5.4), so a fresh Vercel project imported
 * from the repository builds the same way production does. Each setting is
 * pinned to what it has to agree with, read from the files a break would
 * change rather than from vercel.json itself:
 *
 * - `buildCommand` runs a package.json script that exists and builds the
 *   frontend (the script `npm run build` is not a build: M6.1);
 * - `outputDirectory` is where vite.config.js writes the build, resolved from
 *   its own `root` and `build.outDir`;
 * - `framework` is Vite, which is what makes Vercel serve the SPA's assets.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../vite.config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('vercel.json build settings', () => {
  it('names the framework, build command and output directory', () => {
    expect(vercel.framework).toBe('vite');
    expect(typeof vercel.buildCommand).toBe('string');
    expect(typeof vercel.outputDirectory).toBe('string');
  });

  it('builds through a package.json script that runs the frontend build', () => {
    const match = /^npm run ([\w:-]+)$/.exec(vercel.buildCommand);
    expect(match, `buildCommand "${vercel.buildCommand}" is not "npm run <script>"`).not.toBeNull();
    const script = pkg.scripts[match[1]];
    expect(script, `package.json has no "${match[1]}" script`).toBeDefined();
    expect(script).toMatch(/runViteWithPersistenceEndpoint\.js build$/);
  });

  it('serves the directory vite.config.js builds into', () => {
    // No defaults: a config that stops exporting a plain object with `root`
    // and `build.outDir` must fail here, not resolve to Vite's own default.
    expect(typeof viteConfig).toBe('object');
    expect(typeof viteConfig.root).toBe('string');
    expect(typeof viteConfig.build?.outDir).toBe('string');
    const outDir = path.resolve(ROOT, viteConfig.root, viteConfig.build.outDir);
    expect(path.resolve(ROOT, vercel.outputDirectory)).toBe(outDir);
  });
});
