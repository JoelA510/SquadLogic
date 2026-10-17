// @vitest-environment node
/**
 * The core package's manifest names only files that exist (remediation plan,
 * Discovered during execution, PR M5: `packages/core/package.json` named
 * `src/index.js` as its entry, a file that has never existed; knip reported it
 * as a configuration hint).
 *
 * The package has no root module. The frontend, the tests and the core itself
 * import it by module path, `@squadlogic/core/<module>.js`, through the alias
 * that vite.config.js, vitest.config.js and tsconfig.json map to
 * `packages/core/src` (held by tests/unwiredLayerImporters.test.js). So the
 * manifest declares no entry, and nothing may import the package bare: with no
 * entry, a bare import resolves to nothing.
 *
 * An index barrel was the other way to make the entry true. It was not taken:
 * knip treats a package's entries as used, so a barrel (or a wildcard
 * `exports` map) would stop it reporting a core module nothing imports.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const CORE = path.join(ROOT, 'packages/core');
const manifest = JSON.parse(readFileSync(path.join(CORE, 'package.json'), 'utf8'));

/** Every path a manifest names as an entry: main, module, browser, types, exports. */
function entryTargets(/** @type {Record<string, unknown>} */ pkg) {
  /** @type {string[]} */
  const targets = [];
  const collect = (/** @type {unknown} */ value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const field of ['main', 'module', 'browser', 'types', 'typings', 'exports']) {
    collect(pkg[field]);
  }
  return targets;
}

/** Does the manifest give the package a root (bare-specifier) entry? */
function hasRootEntry(/** @type {Record<string, unknown>} */ pkg) {
  if (typeof pkg.main === 'string' || typeof pkg.module === 'string') return true;
  const exports = pkg.exports;
  if (typeof exports === 'string') return true;
  return Boolean(exports && typeof exports === 'object' && '.' in exports);
}

/** Every source file under `dir`, skipping dependencies and build output. */
function listSources(/** @type {string} */ dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return /\.(c|m)?(j|t)sx?$/.test(name) ? [full] : [];
  });
}

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](@squadlogic\/core(?:\/[^'"]*)?)['"]/g;

/** The `@squadlogic/core` specifiers a file imports. */
function coreSpecifiers(/** @type {string} */ code) {
  return [...code.matchAll(SPECIFIER)].map((match) => match[1]);
}

describe('packages/core/package.json', () => {
  it('names only entry files that exist', () => {
    const missing = entryTargets(manifest).filter(
      (target) => !existsSync(path.join(CORE, target.replace(/\*.*$/, '')))
    );
    expect(missing).toEqual([]);
  });

  it('the detectors read entries and root entries as declared', () => {
    expect(entryTargets({ main: 'src/index.js' })).toEqual(['src/index.js']);
    expect(entryTargets({ exports: { '.': { import: './a.js' }, './*': './src/*' } })).toEqual([
      './a.js',
      './src/*',
    ]);
    expect(hasRootEntry({ main: 'src/index.js' })).toBe(true);
    expect(hasRootEntry({ exports: { '.': './a.js' } })).toBe(true);
    expect(hasRootEntry({ exports: { './*': './src/*' } })).toBe(false);
    expect(hasRootEntry({ name: '@squadlogic/core' })).toBe(false);
    expect(coreSpecifiers(`import { a } from '@squadlogic/core';`)).toEqual(['@squadlogic/core']);
    expect(coreSpecifiers(`const m = await import('@squadlogic/core/x.js');`)).toEqual([
      '@squadlogic/core/x.js',
    ]);
    expect(coreSpecifiers(`import '@squadlogic/core';\nimport "@squadlogic/core/y.js";`)).toEqual([
      '@squadlogic/core',
      '@squadlogic/core/y.js',
    ]);
    expect(coreSpecifiers(`// '@squadlogic/core/<module>.js' alias`)).toEqual([]);
  });

  it('with no root entry, nothing imports the package bare', () => {
    const files = ['frontend', 'packages', 'scripts', 'supabase', 'tests']
      .flatMap((dir) => listSources(path.join(ROOT, dir)))
      .concat(
        readdirSync(ROOT)
          .filter((name) => /\.(c|m)?(j|t)s$/.test(name))
          .map((name) => path.join(ROOT, name))
      )
      // This file's own detector samples are not imports.
      .filter((file) => file !== SELF);
    const specifiers = files.flatMap((file) =>
      coreSpecifiers(readFileSync(file, 'utf8')).map((specifier) => ({
        file: path.relative(ROOT, file),
        specifier,
      }))
    );
    // Meta: the scan reached the module-path imports it is meant to see (well
    // over a hundred today), so an empty bare list is not an empty scan.
    expect(specifiers.filter(({ specifier }) => specifier.includes('/')).length).toBeGreaterThan(
      100
    );
    if (!hasRootEntry(manifest)) {
      expect(specifiers.filter(({ specifier }) => specifier === '@squadlogic/core')).toEqual([]);
    }
  });
});
