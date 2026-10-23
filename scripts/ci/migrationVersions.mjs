#!/usr/bin/env node
/**
 * PR-time static check on supabase/migrations (no secrets, no database).
 *
 *   1. Every file is named `<14-digit version>_<name>.sql`. The Supabase CLI
 *      silently ignores a file that does not match its pattern, so a misnamed
 *      migration would never be applied and nothing would say so.
 *   2. Every version is unique. The ledger keys on the version alone; two files
 *      sharing one means the second is recorded as already applied.
 *   3. (with --base <git ref>) Every version NEW relative to the base must be
 *      greater than the latest version on the base, and every base version
 *      must survive unrenamed and unedited. Deploy time is too late for either:
 *      the CLI refuses out-of-order files, and never re-runs an edited one.
 *      The one exception: a version listed in
 *      supabase/unapplied-migration-edits.json (never applied in production)
 *      may be edited, to exactly the blob the entry records.
 *
 * Check 3 compares two independent trees, `git ls-tree <base>` and
 * `git ls-tree HEAD` (blob ids from the tree, not the working copy, which is
 * subject to line-ending conversion); checks 1-2 read the working tree.
 *
 * Usage: node scripts/ci/migrationVersions.mjs [--base <sha>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const UNAPPLIED_EDITS_FILE = 'supabase/unapplied-migration-edits.json';
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

/**
 * Check 3, keyed on VERSION (the ledger's key), not on file name. Entries are
 * `{ file, blob }` where `blob` is the git blob id (null skips the content check).
 *   - a version new to the head must be greater than the base's latest;
 *   - a base version must survive, under the same file name;
 *   - a base version's content must not change: production never re-runs an
 *     applied migration, so an edit would silently never be applied.
 * @returns {string[]} errors
 */
export function checkAgainstBase(baseEntries, headEntries, allowedEdits = []) {
  const byVersion = (entries) =>
    new Map(entries.filter((e) => versionOf(e.file) !== null).map((e) => [versionOf(e.file), e]));
  const base = byVersion(baseEntries);
  if (base.size === 0) {
    return ['base branch: no migration versions found -- cannot establish the latest one'];
  }
  const head = byVersion(headEntries);
  const latest = [...base.keys()].sort().at(-1);
  const errors = [];
  for (const [version, h] of head) {
    const b = base.get(version);
    if (!b) {
      if (version <= latest) {
        errors.push(
          `${h.file}: new version ${version} is not greater than the latest on the base ` +
            `branch (${latest}); give it a later timestamp`
        );
      }
    } else if (b.file !== h.file) {
      errors.push(`${b.file} was renamed to ${h.file}; applied migrations keep their name`);
    } else if (b.blob && h.blob && b.blob !== h.blob) {
      const allowed = allowedEdits.find((a) => a.version === version);
      if (allowed && allowed.blob === h.blob) continue;
      errors.push(
        `${h.file}: an existing migration was edited, and production will never re-run it. ` +
          'Revert the edit and add a new migration instead'
      );
    }
  }
  for (const [version, b] of base) {
    if (!head.has(version)) errors.push(`${b.file} (version ${version}) was removed`);
  }
  return errors;
}

/**
 * The edits allowed to never-applied migrations: `[{ version, blob, reason }]`.
 * A missing file allows none; a malformed one is an error, never an empty list.
 */
export function readAllowedEdits(path = UNAPPLIED_EDITS_FILE) {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || !Array.isArray(value.edits)) throw new Error(`${path}: no "edits" array`);
  for (const e of value.edits) {
    if (!/^[0-9]{14}$/.test(e?.version ?? '') || !/^[0-9a-f]{40}$/.test(e?.blob ?? '')) {
      throw new Error(`${path}: each edit needs a 14-digit "version" and a 40-hex "blob"`);
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      throw new Error(`${path}: edit ${e.version} needs a "reason"`);
    }
  }
  return value.edits;
}

export function listHead(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).sort();
}

/** @returns {{ file: string, blob: string }[]} from `git ls-tree` lines `mode type blob\tfile` */
export function baseEntries(ref, dir = MIGRATIONS_DIR) {
  const out = execFileSync('git', ['ls-tree', `${ref}:${dir}`], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      return { file, blob: meta.split(' ')[2] };
    });
}

export function main(argv = process.argv.slice(2)) {
  const head = listHead();
  const errors = checkNames(head);
  const i = argv.indexOf('--base');
  const baseRef = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !baseRef) errors.push('--base needs a git ref');
  if (baseRef) {
    errors.push(...checkAgainstBase(baseEntries(baseRef), baseEntries('HEAD'), readAllowedEdits()));
  }
  for (const e of errors) console.error(`::error title=Migration versions::${e}`);
  if (errors.length > 0) return 1;
  console.log(
    `Migration versions OK: ${head.length} files, all unique` +
      (baseRef ? `; none added below the base's latest, renamed, removed or edited.` : '.')
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
