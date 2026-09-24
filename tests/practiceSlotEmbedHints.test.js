/**
 * Every `practice_assignments` read that embeds `practice_slots` names its FK
 * column (fix #64).
 *
 * `practice_assignments` carries two foreign keys to `practice_slots`
 * (`slot_id` and `practice_slot_id`, `20260331000000_definitive_schema.sql`).
 * With both present, PostgREST refuses an unhinted `practice_slots(...)` embed
 * with PGRST201, so every such reader returned an error in production -- the
 * calendar feed, the team portal, the player record and the practice grid --
 * while the mock resolved it through `slot_id` and E2E stayed green.
 *
 * The hint is the column the live writer populates, by column name
 * (`practice_slots!practice_slot_id`): that form works whether or not the
 * second FK exists in a given database, where a constraint-name hint would
 * depend on names that differ between environments.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['frontend/src', 'supabase/functions', 'packages'];
const SOURCE = /\.(js|jsx|ts|tsx|mjs)$/;
const REQUIRED_HINT = 'practice_slot_id';

/**
 * The embed sites known when this test was written. The scan must find at
 * least these, so it cannot pass by matching nothing after a rename or a
 * change of quoting style.
 */
const KNOWN_SITES = [
  'frontend/src/hooks/usePracticeAssignments.js',
  'frontend/src/hooks/useTeamPortal.js',
  'frontend/src/pages/PlayerRecordPage.jsx',
  'supabase/functions/calendar-feed/index.ts',
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every `.from('practice_assignments')...select(<literal>)` in `source`, and
 * each `practice_slots(` embed inside that literal with its hint (or null).
 */
function findPracticeSlotEmbeds(source) {
  const sites = [];
  const selects =
    /\.from\(\s*['"`]practice_assignments['"`]\s*\)\s*\.select\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
  for (const select of source.matchAll(selects)) {
    const literal = select[1];
    for (const embed of literal.matchAll(/\bpractice_slots\s*(?:!\s*(\w+))?\s*\(/g)) {
      sites.push({ hint: embed[1] ?? null, text: embed[0] });
    }
  }
  return sites;
}

function scanRepo() {
  const files = SCAN_ROOTS.flatMap((root) => walk(path.join(ROOT, root)));
  const sites = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    for (const site of findPracticeSlotEmbeds(fs.readFileSync(file, 'utf8'))) {
      sites.push({ ...site, file: rel });
    }
  }
  return { files, sites };
}

describe('practice_assignments -> practice_slots embeds name their FK column', () => {
  it('the scanner flags an unhinted embed and accepts a column hint', () => {
    // The scanner's own failure case, constructed rather than assumed.
    const unhinted = `supabase.from('practice_assignments').select(\`id, slot:practice_slots ( day_of_week )\`)`;
    const hinted = `supabase.from('practice_assignments').select('id, practice_slots!practice_slot_id (id)')`;
    expect(findPracticeSlotEmbeds(unhinted)).toEqual([{ hint: null, text: 'practice_slots (' }]);
    expect(findPracticeSlotEmbeds(hinted).map((s) => s.hint)).toEqual(['practice_slot_id']);
    // Not an embed off practice_assignments: out of scope.
    expect(findPracticeSlotEmbeds(`supabase.from('fields').select('practice_slots (id)')`)).toEqual(
      []
    );
  });

  it('every embed site in frontend/src, supabase/functions and packages hints practice_slot_id', () => {
    const { files, sites } = scanRepo();

    // Meta-assertions: the scan read real files and found every known site.
    expect(files.length).toBeGreaterThan(100);
    const siteFiles = new Set(sites.map((s) => s.file));
    for (const known of KNOWN_SITES) {
      expect(siteFiles, `expected an embed site in ${known}`).toContain(known);
    }
    expect(sites.length).toBeGreaterThanOrEqual(KNOWN_SITES.length);

    const offenders = sites
      .filter((s) => s.hint !== REQUIRED_HINT)
      .map((s) => `${s.file}: ${s.text}${s.hint ? ` (hint ${s.hint})` : ' (no hint)'}`);
    expect(offenders).toEqual([]);
  });
});
