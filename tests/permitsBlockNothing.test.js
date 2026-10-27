/**
 * **A permit never blocks anything** (owner, 2026-10-26): no import, scheduling run, publish or
 * export is refused or gated for a missing, expiring or expired permit.
 *
 * That is held here by what can read a permit. The subject set is every source file that could be
 * a gate (the frontend, the core package, the Edge Functions, and the migrations' functions),
 * enumerated from the directories rather than from a list of gates, and the allowlist is the permit
 * surface itself. A file outside it that reads the permit tables, the permit RPC, or the permit
 * helpers is a place a gate could have been written, and fails here until someone argues it in.
 *
 * `supabase/tests/facility_permits.sql` holds the same line for the database: the functions whose
 * bodies mention a permit table are exactly the permit RPCs, their helpers and `admin_delete_field`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ROOTS = ['frontend/src', 'packages/core/src', 'supabase/functions', 'supabase/migrations'];

/** The permit surface: the files whose job is permits (or that show them). */
const ALLOWED = new Set([
  'frontend/src/components/setup/FieldPermitsSection.jsx',
  'frontend/src/components/setup/PermitDialog.jsx',
  'frontend/src/hooks/useFacilityPermits.js',
  'frontend/src/lib/mockFacilityPermits.js',
  // the mock twin's wiring and its tables' read policies
  'frontend/src/lib/mockReadPolicies.js',
  'frontend/src/lib/mockSupabaseClient.js',
  // the pages that show them: Field Management, the admin home's reminders, and (Phase C3) the
  // coach's /permits page and its home card
  'frontend/src/pages/FieldManagementPage.jsx',
  'frontend/src/pages/DashboardPage.jsx',
  'frontend/src/pages/PermitsPage.jsx',
  'frontend/src/components/coach/CoachPermitsCard.jsx',
  // the core module, and the barrel that registers it
  'packages/core/src/facility/index.js',
  'packages/core/src/facility/permits.js',
  'supabase/migrations/20261102010000_facility_permits.sql',
]);

// What reads a permit: the tables, the RPC, the hooks and the core helpers. In JavaScript the tables
// are named in a query (`from('facility_permits')`), because the season-2026 fixture loaders already
// use the words for the permit reservations they parse, which is unrelated; in SQL any mention counts.
const READS_A_PERMIT_JS =
  /from\(\s*['"]facility_permit|['"]get_facility_permits|useFacilityPermits|usePermitWarnings|mockFacilityPermits|facility\/permits|fieldsWithoutPermit|permitWarnings/;
const READS_A_PERMIT_SQL = /facility_permit_scopes|facility_permits|get_facility_permits/;
const readsAPermit = (file, text) =>
  (file.endsWith('.sql') ? READS_A_PERMIT_SQL : READS_A_PERMIT_JS).test(text);

const walk = (dir) =>
  readdirSync(path.join(REPO, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === 'node_modules') return [];
    return statSync(path.join(REPO, rel)).isDirectory()
      ? walk(rel)
      : /\.(jsx?|tsx?|sql)$/.test(name)
        ? [rel]
        : [];
  });

const files = ROOTS.flatMap(walk);
const readers = files.filter((file) =>
  readsAPermit(file, readFileSync(path.join(REPO, file), 'utf8'))
);

describe('a permit blocks nothing', () => {
  it('examines the sources (the meta-assertion: the walk found the code it is about)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain('frontend/src/pages/ImportPage.jsx');
    expect(files.some((f) => f.startsWith('supabase/functions/'))).toBe(true);
    expect(
      files.some((f) => f.startsWith('packages/core/src/solver') || f.includes('scheduling'))
    ).toBe(true);
    // And it finds what it looks for: the permit surface itself is in the readers.
    expect(readers).toContain('frontend/src/hooks/useFacilityPermits.js');
  });

  it('is read by no import, scheduling, publish or export code', () => {
    const outside = readers.filter((file) => !ALLOWED.has(file));
    expect(
      outside,
      `these files read a permit and are not part of the permit surface: ${outside.join(', ')}`
    ).toEqual([]);
  });

  it('every file on the allowlist still reads a permit (an entry that reads nothing is a stale exemption)', () => {
    const stale = [...ALLOWED].filter((file) => !readers.includes(file));
    expect(stale).toEqual([]);
  });

  it('the pages that show permits only show them: no gate in them refuses on a permit', () => {
    for (const file of [
      'frontend/src/pages/FieldManagementPage.jsx',
      'frontend/src/pages/DashboardPage.jsx',
      'frontend/src/pages/PermitsPage.jsx',
      'frontend/src/components/coach/CoachPermitsCard.jsx',
    ]) {
      const text = readFileSync(path.join(REPO, file), 'utf8');
      // The only uses are the read, the warnings and the delete confirmation's wording.
      expect(text).not.toMatch(/permit[A-Za-z]*\s*(?:\)|&&)?\s*(?:\?\s*)?(?:return|throw)\b/);
      expect(text).not.toMatch(/disabled=\{[^}]*permit/i);
    }
  });
});
