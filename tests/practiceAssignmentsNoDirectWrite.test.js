/**
 * `practice_assignments` has one writer: `persist_practice_schedule` (writer
 * v3), reached through the `practice-persistence` Edge Function. A second
 * writer, `persistPracticeAssignments` in `packages/core/src/practiceSupabase.js`,
 * inserted/upserted rows straight into the table, skipping the RPC's lock,
 * unlock-audit and fingerprint checks. It had no caller and was retired in
 * #66. This guard keeps a direct table write from coming back.
 *
 * The rule: in app source (`frontend/src`, `packages/core/src`,
 * `supabase/functions`), a `.from('practice_assignments')` chain may only
 * read. It may not call `.insert` / `.upsert` / `.update` / `.delete`, either
 * on the chain itself or on a variable the builder was bound to. The second
 * form is how the retired writer did it: `const table = client.from(...)`,
 * then `table.upsert`.
 *
 * Test seeding against the mock client (`tests/**`) is not app source and is
 * not scanned.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_DIRS = ['frontend/src', 'packages/core/src', 'supabase/functions'];
const SOURCE_EXT = /\.(js|jsx|ts|tsx|mjs)$/;

const FROM_TABLE = /\.from\(\s*(['"`])practice_assignments\1\s*\)/g;
const WRITE_METHOD = /\.(insert|upsert|update|delete)\s*\(/;
// A write through any identifier: `x.insert` / `x.upsert` / `x.update` /
// `x.delete` / `x[...]`. The identifier is captured and compared to the bound
// name as a string, so no RegExp is ever built from source text (no escaping
// to get wrong). `(?<![\w$.])` keeps `a.x.insert` and `ax.insert` from
// matching `x`; `\b` alone cannot sit before a leading `$`.
const WRITE_THROUGH =
  /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\.\s*(?:insert|upsert|update|delete)\b|\[)/g;
const writesThrough = (name, text) => [...text.matchAll(WRITE_THROUGH)].some((m) => m[1] === name);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...walk(full));
    } else if (SOURCE_EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every direct write to `practice_assignments` in `text`, plus the number of
 * `.from('practice_assignments')` sites examined (the meta-count).
 */
function findDirectWrites(text) {
  const writes = [];
  let sites = 0;
  for (const match of text.matchAll(FROM_TABLE)) {
    sites += 1;
    const start = match.index;
    const rest = text.slice(start + match[0].length);
    // The chain runs to the end of its statement, or to the next `.from(`
    // when several queries share one statement (a `Promise.all([...])`).
    const stops = [rest.indexOf(';'), rest.indexOf('.from(')].filter((i) => i >= 0);
    const chain = stops.length ? rest.slice(0, Math.min(...stops)) : rest;
    const line = text.slice(0, start).split('\n').length;
    if (WRITE_METHOD.test(chain)) {
      writes.push({ line, form: 'chain' });
    }
    // `const x = client.from('practice_assignments')` -> any later `x.insert(`
    // / `x.upsert` / `x[...]` in the same file is a write through the binding.
    // The statement is read back to its start, not to the line start: Prettier
    // puts `.from(...)` on its own line, so the `const x =` is usually above.
    const before = text.slice(0, start);
    const statementStart = Math.max(...[';', '{', '}'].map((c) => before.lastIndexOf(c))) + 1;
    const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]*\s*$/.exec(
      before.slice(statementStart)
    );
    if (binding && writesThrough(binding[1], rest)) {
      writes.push({ line, form: `binding ${binding[1]}` });
    }
  }
  return { writes, sites };
}

describe('practice_assignments has no direct table writer', () => {
  it('the detector flags both write forms and passes a read', () => {
    const chain = "await supabase.from('practice_assignments').upsert(rows);";
    const bound =
      "const table = client.from('practice_assignments');\n" +
      'const { error } = await table.insert(rows);';
    const read =
      "await supabase.from('practice_assignments').select('id').eq('team_id', id);\n" +
      "await supabase.from('teams').update({ name });";
    const boundMultiline =
      'const table = await supabaseClient\n' +
      "  .from('practice_assignments');\n" +
      'await table.upsert(rows);';
    const boundDollar = "const $pa = client.from('practice_assignments');\n$pa.insert(rows);";
    expect(findDirectWrites(chain).writes).toHaveLength(1);
    expect(findDirectWrites(bound).writes).toHaveLength(1);
    expect(findDirectWrites(boundMultiline).writes).toHaveLength(1);
    expect(findDirectWrites(boundDollar).writes).toHaveLength(1);
    expect(findDirectWrites(read)).toEqual({ writes: [], sites: 1 });

    // `$` is the only regex metacharacter an identifier can hold; `a$b` would
    // read as an anchor if the name were ever interpolated into a pattern.
    const boundInnerDollar = "const a$b = client.from('practice_assignments');\na$b.delete();";
    expect(findDirectWrites(boundInnerDollar).writes).toHaveLength(1);
    const doubleQuoted = 'await supabase.from("practice_assignments").delete().eq("id", id);';
    expect(findDirectWrites(doubleQuoted).writes).toHaveLength(1);
    // Near misses: a longer name, or the same name as a property, is not the binding.
    const nearMiss =
      "const table = client.from('practice_assignments');\n" +
      'xtable.upsert(rows);\nother.table.insert(rows);';
    expect(findDirectWrites(nearMiss)).toEqual({ writes: [], sites: 1 });
  });

  it('app source only reads practice_assignments', () => {
    const files = SCANNED_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
    const offenders = [];
    const siteFiles = new Set();
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const { writes, sites } = findDirectWrites(readFileSync(file, 'utf8'));
      if (sites > 0) siteFiles.add(rel);
      for (const w of writes) offenders.push(`${rel}:${w.line} (${w.form})`);
    }

    // Meta-assertions. The subject set is pinned by name, not derived from
    // the scan: these readers are known to exist, so a regex or walk break
    // that finds nothing fails here instead of passing on an empty set.
    expect(files.length).toBeGreaterThan(100);
    for (const known of [
      'frontend/src/hooks/usePracticeAssignments.js',
      'frontend/src/hooks/useTeamPortal.js',
      'packages/core/src/practiceSupabase.js',
    ]) {
      expect(siteFiles, `expected a practice_assignments read in ${known}`).toContain(known);
    }

    expect(
      offenders,
      'practice_assignments must be written only through persist_practice_schedule ' +
        '(practice-persistence Edge Function); direct table writes found'
    ).toEqual([]);
  });
});
