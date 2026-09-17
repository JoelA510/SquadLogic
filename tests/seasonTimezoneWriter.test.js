import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

/**
 * The check that would have caught GAP-30's precondition.
 *
 * `season_settings.timezone` was added in `20251214000002`, read by
 * `GameSchedulingPage`, `PracticeSchedulingPage` and `calendar-feed`, and
 * **written by nothing** for nine months. Every one of those readers was
 * reading a NULL that the host's zone quietly stood in for, which is the defect
 * GAP-30 is about — one layer further back than the composer.
 *
 * ## Why this enumerates from the writers
 *
 * CLAUDE.md §3: never derive a check's subject set from the data a break would
 * corrupt. A check that asked "does anything read this column" passes for a
 * column nothing writes — the readers are exactly what a missing writer leaves
 * intact. A check built from the failing tests would have passed the moment the
 * six e2e seeds were fixed, which is how a green suite came to sit over a
 * broken production path.
 *
 * So the subject set is the **INSERT and UPDATE statements against
 * `season_settings` in `supabase/migrations/`**, which is what a missing writer
 * actually leaves empty.
 */

/** Every `.sql` under `supabase/migrations`, newest last. */
function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
}

/**
 * Statements that write `season_settings`, with the column list that follows.
 *
 * Deliberately crude: it reads the text of the migrations rather than a live
 * database, because the point is to fail in CI without Postgres. The live
 * counterpart is `docs/sql/20260913000000_smoke.sql` section 1, which asks
 * `pg_proc` the same question.
 *
 * @returns {Array<{file: string, kind: 'insert'|'update', body: string}>}
 */
function seasonSettingsWriters() {
  /** @type {Array<{file: string, kind: 'insert'|'update', body: string}>} */
  const writers = [];
  for (const { name, text } of migrationFiles()) {
    // `INSERT INTO [public.]season_settings ( … )` — capture the column list.
    for (const match of text.matchAll(
      /INSERT\s+INTO\s+(?:public\.)?season_settings\s*\(([^)]*)\)/gis
    )) {
      writers.push({ file: name, kind: 'insert', body: match[1] });
    }
    // `UPDATE [public.]season_settings … SET …` — capture through the next `;`.
    for (const match of text.matchAll(/UPDATE\s+(?:public\.)?season_settings\b([\s\S]*?);/gi)) {
      writers.push({ file: name, kind: 'update', body: match[1] });
    }
  }
  return writers;
}

describe('season_settings.timezone has a writer (GAP-30 precondition)', () => {
  const writers = seasonSettingsWriters();

  it('finds the writers at all', () => {
    // The meta-assertion, and it is about the **regex**, not the content: a
    // pattern that matched nothing would make every assertion below pass over
    // an empty set, which is precisely the failure mode this file exists to
    // prevent one level up. Deliberately NOT a count that the fix changes —
    // that would make the sanity check and the substantive check the same
    // check, which is the "compared a set against itself" shape.
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.some((w) => w.kind === 'insert')).toBe(true);
    // Every writer's captured body must look like SQL, or the regex is
    // matching something other than what it claims to.
    for (const writer of writers) {
      expect(writer.body.length, `${writer.file} (${writer.kind})`).toBeGreaterThan(0);
    }
  });

  it('at least one writer sets the timezone column', () => {
    const touching = writers.filter((w) => /\btimezone\b/i.test(w.body));
    expect(
      touching.map((w) => `${w.file} (${w.kind})`),
      'No INSERT or UPDATE anywhere in supabase/migrations/ writes season_settings.timezone. Three surfaces read that column; a column nothing writes reads as "this season has no clock" forever, and the game scheduler refuses every slot.'
    ).not.toEqual([]);
  });

  it('the onboarding RPC writes it, so a self-serve org gets a clock', () => {
    // The specific hole: `initialize_new_tenant` took `p_timezone`, wrote it to
    // `organizations.contact_info` as jsonb nothing reads, and omitted it from
    // the `season_settings` INSERT beside it.
    const initTenant = migrationFiles()
      .filter(({ text }) =>
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.initialize_new_tenant/i.test(text)
      )
      .pop();
    expect(initTenant, 'initialize_new_tenant is not defined in any migration').toBeDefined();

    const inserts = [
      ...initTenant.text.matchAll(/INSERT\s+INTO\s+(?:public\.)?season_settings\s*\(([^)]*)\)/gis),
    ];
    expect(inserts.length, 'initialize_new_tenant does not insert season_settings').toBeGreaterThan(
      0
    );
    // The LAST definition wins at runtime, so that is the one that must carry it.
    expect(
      inserts.some((m) => /\btimezone\b/i.test(m[1])),
      `initialize_new_tenant (${initTenant.name}) does not write season_settings.timezone. Every organization created through self-serve onboarding would have a null season clock and a disabled game scheduler, while the timezone the admin typed sits unread in organizations.contact_info.`
    ).toBe(true);
  });

  it('validates the zone rather than storing whatever it is handed', () => {
    const writerFiles = migrationFiles().filter(({ text }) =>
      /INSERT\s+INTO\s+(?:public\.)?season_settings\s*\([^)]*timezone/is.test(text)
    );
    expect(writerFiles.length).toBeGreaterThan(0);
    // A stored `Americas/New_York` satisfies NOT NULL and then refuses every
    // slot at read time with a reason the operator cannot act on. Refusing at
    // the write is the same rule one layer earlier.
    expect(
      writerFiles.some(({ text }) => /pg_timezone_names/i.test(text)),
      'No writer validates the timezone against pg_timezone_names.'
    ).toBe(true);
  });

  it('there is no read-time contact_info fallback anywhere', () => {
    // One source of truth. A `contact_info->>'timezone'` read outside the
    // one-time backfill is a second answer to the question the column exists to
    // answer, and two answers for a season's clock is the drift GAP-30 is made
    // of. The backfill itself is an UPDATE, so it is excluded by shape.
    const offenders = [];
    for (const { name, text } of migrationFiles()) {
      for (const line of text.split('\n')) {
        if (!/contact_info\s*->>\s*'timezone'/i.test(line)) continue;
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
    // Every remaining hit must live inside the backfill UPDATE or the jsonb the
    // onboarding RPC still writes for backwards compatibility.
    const backfill = migrationFiles().find(({ name }) => name.includes('season_timezone_writer'));
    expect(backfill).toBeDefined();
    const outsideBackfill = offenders.filter((o) => !o.startsWith(backfill.name));
    expect(
      outsideBackfill,
      "contact_info->>'timezone' is read outside the one-time backfill; that is a second source of truth for the season clock."
    ).toEqual([]);
  });
});

describe('the mock client agrees with the real schema', () => {
  // LESSONS_LEARNED #13: the mock and the real schema drift apart silently, and
  // a column that exists only in one of them passes every test and fails in
  // production. These two writers must stay in step.
  const mock = readFileSync(
    path.join(ROOT, 'frontend', 'src', 'lib', 'mockSupabaseClient.js'),
    'utf8'
  );

  it('initialize_new_tenant seeds a season timezone in the mock too', () => {
    const block = mock.slice(mock.indexOf("name === 'initialize_new_tenant'"));
    const seasonPush = block.slice(block.indexOf('db.season_settings.push('));
    expect(seasonPush.slice(0, 800)).toMatch(/timezone:/);
  });

  it('the mock implements the Settings writer', () => {
    expect(mock).toMatch(/name === 'admin_set_season_timezone'/);
  });

  it('the mock refuses a zone the runtime does not know', () => {
    const block = mock.slice(mock.indexOf("name === 'admin_set_season_timezone'"));
    expect(block.slice(0, 3000)).toMatch(/Unknown IANA timezone/);
  });
});

describe('the Settings control persists to the database', () => {
  const settings = readFileSync(
    path.join(ROOT, 'frontend', 'src', 'components', 'settings', 'modules', 'SeasonModule.jsx'),
    'utf8'
  );

  it('calls the writer RPC', () => {
    // It used to call `updateTimezone` (localStorage) plus a `record_audit_event`
    // beside it — an audit row for a change that never reached a column.
    expect(settings).toMatch(/admin_set_season_timezone/);
  });

  it('reads the season row rather than the legacy localStorage copy', () => {
    expect(settings).toMatch(/currentSeasonSetting\?\.timezone/);
    expect(settings).not.toMatch(/updateTimezone/);
  });

  it('holds no second copy of the value', () => {
    // The select renders from the season row and `refetchOrgs()` is the update.
    // A mirror in context state would be a second answer to "what is this
    // season's clock", disagreeing for as long as a refetch is in flight —
    // the same shape as the `contact_info` fallback that was ruled out.
    expect(settings).toMatch(/refetchOrgs\(\)/);
    // `setTimezoneError` / `setTimezoneSaving` are request flags, not copies of
    // the value, so the boundary matters: `setTimezone(` exactly.
    expect(settings).not.toMatch(/\bsetTimezone\(|\breflectSeasonTimezone\b/);
  });

  it('surfaces a failure instead of silently succeeding', () => {
    // The previous version could not fail, because it never reached the
    // database. CLAUDE.md: never report success that was not checked.
    expect(settings).toMatch(/timezoneError/);
    expect(settings).toMatch(/role="alert"/);
  });
});
