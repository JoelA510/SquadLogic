/**
 * The rollback class of the practice import (PR 10; LESSONS_LEARNED #105): the (table, operation) pairs the apply can
 * record are read from the apply's own text, required equal to what the mock records for a world that creates every kind
 * of record, and each pair must have a later-change scenario in the pgTAP file (section 7 of
 * `supabase/tests/practice_import_apply_rollback.sql`, which runs the rollback after each change and a witness that the
 * later writer's change survived). A pair with no scenario fails, and so does a scenario for a pair the apply cannot
 * write; a plant shows the scan can fail.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handlePracticeImportRpc } from '../frontend/src/lib/mockPracticeImport.js';
import {
  practiceDivisionDecisionKey,
  practiceFieldDecisionKey,
  practiceLocationDecisionKey,
  practiceSubunitDecisionKey,
  practiceTeamDecisionKey,
} from '../packages/core/src/practiceImport/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(
  path.join(REPO, 'supabase/migrations/20261123010000_practice_import.sql'),
  'utf8'
);
const PGTAP = readFileSync(
  path.join(REPO, 'supabase/tests/practice_import_apply_rollback.sql'),
  'utf8'
);

/** The body of one function of the migration. */
function body(sql, name) {
  const start = sql.indexOf(`CREATE FUNCTION public.${name}(`);
  const end = sql.indexOf('$function$;', start);
  return start < 0 || end < 0 ? '' : sql.slice(start, end);
}

/** The pairs an apply's text records: each `INSERT INTO public.import_application_records` and the tables it names. */
export function recordedPairs(applyText) {
  const pairs = new Set();
  for (const m of applyText.matchAll(/INSERT INTO public\.import_application_records[\s\S]*?;/g)) {
    const stmt = m[0];
    const op = /'(inserted|updated|deleted)'/.exec(stmt)?.[1];
    for (const t of stmt.matchAll(/SELECT '(\w+)'(?:\s+AS\s+t)?,/g)) pairs.add(`${t[1]}:${op}`);
  }
  return pairs;
}

const ORG = '00000000-0000-4000-8000-0000000000a1';
const SEASON = '00000000-0000-4000-8000-0000000000a2';
const DIV = '00000000-0000-4000-8000-0000000000a3';
const TEAM = '00000000-0000-4000-8000-0000000000a4';
let n = 0;
const ctx = {
  isOrgAdmin: () => true,
  currentUserId: '00000000-0000-4000-8000-0000000000a5',
  newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  now: () => '2026-11-13T12:00:00.000Z',
};

/** A world whose apply creates a division, a location, a field, a half, a shell, a slot and a practice. */
function world() {
  const stage = (row, p) => ({
    id: `s${row}`,
    organization_id: ORG,
    import_job_id: 'job',
    import_type: 'practice_schedule',
    source_row_number: row,
    validation_errors: [],
    normalized_payload: {
      row_key: `row-${row}`,
      status: p.team ? 'placement' : 'open',
      day: 'tue',
      start_time: '17:00',
      end_time: '18:00',
      valid_from: '2026-09-07',
      valid_until: '2026-11-20',
      capacity: 1,
      flags: [],
      division: p.division ?? '',
      division_key: p.team ? practiceDivisionDecisionKey(p.division) : '',
      location: 'W Park',
      location_key: practiceLocationDecisionKey('W Park'),
      field: 'W Field',
      field_key: practiceFieldDecisionKey('W Park', 'W Field'),
      subunit: p.sub,
      subunit_key: practiceSubunitDecisionKey('W Park', 'W Field', p.sub),
      team: p.team ?? '',
      team_key: p.team ? practiceTeamDecisionKey(p.division, p.team) : '',
    },
  });
  const db = {
    season_settings: [
      {
        id: SEASON,
        organization_id: ORG,
        status: 'active',
        season_start: '2026-09-07',
        season_end: '2026-11-20',
      },
    ],
    divisions: [
      {
        id: DIV,
        organization_id: ORG,
        season_settings_id: SEASON,
        name: 'Old Div',
        practices_per_week: 1,
      },
    ],
    teams: [
      { id: TEAM, organization_id: ORG, division_id: DIV, name: 'Old Team', is_external: false },
    ],
    import_jobs: [
      {
        id: 'job',
        organization_id: ORG,
        job_type: 'practice_schedule',
        status: 'ready_to_apply',
        season_settings_id: SEASON,
      },
    ],
    staging_import_rows: [
      stage(1, { team: 'W Shell', division: 'W Div', sub: 'A' }),
      stage(2, { sub: 'B' }),
    ],
  };
  const mapping = {
    divisions: { [practiceDivisionDecisionKey('W Div')]: { action: 'create' } },
    locations: { [practiceLocationDecisionKey('W Park')]: { action: 'create' } },
    fields: { [practiceFieldDecisionKey('W Park', 'W Field')]: { action: 'create' } },
    subunits: {
      [practiceSubunitDecisionKey('W Park', 'W Field', 'A')]: { action: 'create' },
      [practiceSubunitDecisionKey('W Park', 'W Field', 'B')]: { action: 'create' },
    },
    teams: { [practiceTeamDecisionKey('W Div', 'W Shell')]: { action: 'create' } },
  };
  expect(
    handlePracticeImportRpc(
      db,
      'map_practice_import_job',
      { p_import_job_id: 'job', p_mapping: mapping },
      ctx
    ).error
  ).toBeNull();
  const applied = handlePracticeImportRpc(
    db,
    'apply_practice_import_job',
    { p_import_job_id: 'job' },
    ctx
  );
  expect(applied.error).toBeNull();
  return db;
}

const SCENARIO_FOR = {
  practice_assignments: 'practice_assignments, edited',
  practice_slots: 'practice_slots, edited',
  field_subunits: 'field_subunits, renamed',
  fields: 'fields, given a blackout since',
  locations: 'locations, given an address since',
  teams: 'teams (a shell), edited',
  divisions: 'divisions, its settings ticked since',
};

describe('the rollback class: every pair the apply records has a later-change scenario', () => {
  const sqlPairs = recordedPairs(body(MIGRATION, 'apply_practice_import_job'));

  it('reads seven pairs out of the apply, all inserted (the import changes and deletes nothing saved)', () => {
    expect([...sqlPairs].sort()).toEqual(
      Object.keys(SCENARIO_FOR)
        .map((t) => `${t}:inserted`)
        .sort()
    );
  });

  it('the mock records exactly those pairs for a world that creates every kind of record', () => {
    const db = world();
    const mockPairs = new Set(
      db.import_application_records.map((r) => `${r.target_table}:${r.operation}`)
    );
    expect([...mockPairs].sort()).toEqual([...sqlPairs].sort());
  });

  it('the pgTAP file has a scenario for each pair, run through the rollback with a witness', () => {
    for (const [table, description] of Object.entries(SCENARIO_FOR)) {
      expect(PGTAP, table).toContain(`'${description}`);
    }
    expect((PGTAP.match(/pg_temp\.scenario\(/g) ?? []).length).toBeGreaterThanOrEqual(
      Object.keys(SCENARIO_FOR).length + 1
    );
  });

  it('every table the rollback deletes from is a pair (a deletion with no record would destroy something it did not make)', () => {
    const rollback = body(MIGRATION, 'rollback_practice_import_job');
    const deleted = new Set([...rollback.matchAll(/\('(\w+)', \d\)/g)].map((m) => m[1]));
    deleted.add('practice_assignments');
    expect([...deleted].sort()).toEqual(Object.keys(SCENARIO_FOR).sort());
  });

  it('PLANT: a pair added to the apply without a scenario is reported', () => {
    const planted = body(MIGRATION, 'apply_practice_import_job').replace(
      "UNION ALL SELECT 'teams', t.id,",
      "UNION ALL SELECT 'schedule_tbd', t.id, to_jsonb(t) FROM public.teams t WHERE false\n                UNION ALL SELECT 'teams', t.id,"
    );
    const pairs = recordedPairs(planted);
    expect(pairs.has('schedule_tbd:inserted')).toBe(true);
    expect([...pairs].filter((p) => !(p.split(':')[0] in SCENARIO_FOR))).toEqual([
      'schedule_tbd:inserted',
    ]);
  });
});
