#!/usr/bin/env node
/**
 * PR-time static check on supabase/migrations (no secrets, no database).
 *
 *   1. Every file is named `<14-digit version>_<name>.sql`. The Supabase CLI
 *      silently ignores a file that does not match its pattern, so a misnamed
 *      migration would never be applied and nothing would say so.
 *   2. Every version is unique. The ledger keys on the version alone; two files
 *      sharing one means the second is recorded as already applied.
 *   3. (with --base <git ref>) Every migration ADDED relative to the base must
 *      have a version greater than the latest version on the base. The
 *      `deploy-migrations` guard refuses out-of-order files at deploy time;
 *      this catches them before merge, while they are still cheap to rename.
 *
 * The base set is read from git (`git ls-tree <base>`), the head set from the
 * working tree -- two independent sources, so a check cannot compare a set
 * against itself.
 *
 * Usage: node scripts/ci/migrationVersions.mjs [--base <sha>]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = 'supabase/migrations';
const NAME = /^([0-9]{14})_[A-Za-z0-9_]+\.sql$/;

/** @returns {string | null} the version, or null when the name is malformed */
export function versionOf(file) {
  const m = NAME.exec(file);
  return m ? m[1] : null;
}

/** Checks 1 and 2. @returns {string[]} errors */
export function checkNames(files) {
  if (files.length === 0) return [`${MIGRATIONS_DIR}: no migration files found`];
  const errors = [];
  const byVersion = new Map();
  for (const file of files) {
    const version = versionOf(file);
    if (version === null) {
      errors.push(`${file}: not named <14-digit version>_<name>.sql (the CLI would ignore it)`);
      continue;
    }
    byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
  }
  for (const [version, same] of byVersion) {
    if (same.length > 1) errors.push(`version ${version} is used by ${same.join(', ')}`);
  }
  return errors;
}

/** Check 3. @returns {string[]} errors */
export function checkAddedAfterBase(baseFiles, headFiles) {
  const baseVersions = baseFiles.map(versionOf).filter((v) => v !== null);
  if (baseVersions.length === 0) {
    return ['base branch: no migration versions found -- cannot establish the latest one'];
  }
  const latest = baseVersions.sort().at(-1);
  const base = new Set(baseFiles);
  const errors = [];
  for (const file of headFiles) {
    if (base.has(file)) continue;
    const version = versionOf(file);
    if (version !== null && version <= latest) {
      errors.push(
        `${file}: version ${version} is not greater than the latest on the base branch ` +
          `(${latest}); rename it to a later timestamp`
      );
    }
  }
  return errors;
}

export function listHead(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).sort();
}

export function listBase(ref, dir = MIGRATIONS_DIR) {
  const out = execFileSync('git', ['ls-tree', '--name-only', `${ref}:${dir}`], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).sort();
}

export function main(argv = process.argv.slice(2)) {
  const head = listHead();
  const errors = checkNames(head);
  const i = argv.indexOf('--base');
  const baseRef = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !baseRef) errors.push('--base needs a git ref');
  if (baseRef) errors.push(...checkAddedAfterBase(listBase(baseRef), head));
  for (const e of errors) console.error(`::error title=Migration versions::${e}`);
  if (errors.length > 0) return 1;
  console.log(
    `Migration versions OK: ${head.length} files, all unique` +
      (baseRef ? `, none added below the base branch's latest.` : '.')
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
