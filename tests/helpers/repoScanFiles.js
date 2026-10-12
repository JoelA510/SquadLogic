/**
 * The repo-wide file universe the content guards scan: every tracked content
 * directory, walked, filtered to the scanned extensions, plus the root
 * documents. One definition, shared by `tests/heatSyntheticCoordinates.test.js`
 * and `tests/realNameDenylist.test.js`, so the two guards cannot drift onto
 * different trees.
 *
 * Each caller passes its own `NOT_SCANNED` map (path -> reason) and the files
 * it excludes as itself; the universe is the tree, never an allowed set.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCAN_ROOTS = Object.freeze([
  'tests',
  'scripts',
  'frontend',
  'packages',
  'fixtures',
  'docs',
  'supabase',
  'config',
  'project-hardening',
]);
export const SCAN_ALWAYS = Object.freeze(['CHANGELOG.md', 'README.md', 'CLAUDE.md', 'vercel.json']);
export const SCAN_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.py',
  '.feature',
  '.md',
  '.sql',
  '.csv',
  '.txt',
  '.yml',
  '.yaml',
]);

/** Every file under `dir`, recursively, skipping dependency and build trees. */
export function filesUnder(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.features-gen' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...filesUnder(full));
    else files.push(full);
  }
  return files;
}

/**
 * Repo-relative, forward-slashed, sorted paths of every scanned file.
 *
 * @param {{ exclude?: string[], notScanned?: Record<string, string> }} [options]
 *   `exclude`: absolute paths of the calling guard itself; `notScanned`:
 *   repo-relative paths deliberately skipped, each with its reason.
 * @returns {string[]}
 */
export function scannedFiles({ exclude = [], notScanned = {} } = {}) {
  return SCAN_ROOTS.flatMap((r) => filesUnder(path.join(REPO_ROOT, r)))
    .filter((f) => !exclude.includes(f))
    .filter((f) => SCAN_EXT.has(path.extname(f)))
    .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))
    .filter((rel) => !(rel in notScanned))
    .concat(SCAN_ALWAYS)
    .sort();
}
