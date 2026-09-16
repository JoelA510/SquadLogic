import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockSupabase as supabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PATH = path.join(REPO, 'frontend/src/lib/mockSupabaseClient.js');
const SOURCE = readFileSync(MOCK_PATH, 'utf8');

const ORG = 'org-1';
const SEEDED_TEAM = '00000000-0000-0000-0000-000000000001';

const setSession = (userId) => {
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));
};

beforeEach(() => {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  setSession('mock-admin-id');
});

// ---------------------------------------------------------------------------
// The census. A mechanism, not a one-time audit.
// ---------------------------------------------------------------------------
//
// **The supervisor's figure for this defect was "~30 sites"; the brief's was
// three. Both were guesses, and the answer is derived here instead.** A row
// leaves a table in this mock in exactly one shape -- a reassignment of
// `db.<table>` (or `db[<expr>]`) to a narrowed `.filter(...)` -- and every one
// of those must record a tombstone, because `getDB()` rebuilds from
// `initialMockData` on every read and `mergeSource` only adds or updates.
//
// A one-time audit goes stale the first time someone writes site 26. This scan
// runs on every `npm run test`, so it does not.

/** A window is generous enough for a multi-line `markMockDeleted(` two
 * statements away (the widest real gap is 12 lines) and tight enough that an
 * unrelated tombstone elsewhere in the same RPC cannot cover a new site. */
const WINDOW = 15;

/** Every line that assigns to a db table, however the right-hand side is
 * spelled. Deriving the set from ASSIGNMENT rather than from `.filter(` is
 * deliberate: this PR makes helpers (`dropMockFieldSubunits`, `cascadeDoomed`,
 * `dropByProfile`) the house style for a delete, and a scanner keyed on
 * `.filter(` would not see `db.x = withoutId(db.x, id)` at all -- so the next
 * helper written without a tombstone would pass a clean census. */
const scanTableWrites = (source) => {
  const lines = source.split('\n');
  const writes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*db(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]+)\])\s*=\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    writes.push({
      line: i + 1,
      table: match[1] || match[2],
      dynamic: !match[1],
      rhs: match[3].trim(),
      text: lines[i].trim(),
    });
  }
  return writes;
};

/** In-place removals that never assign, so the scan above cannot see them. */
const scanInPlaceRemovals = (source) =>
  source
    .split('\n')
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(({ text }) =>
      /\bdb(\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\.(splice|pop|shift)\(/.test(text)
    );

/**
 * Writes that cannot remove a row, each with the reason. Everything else is
 * treated as a removal and must be tombstoned -- including a shape nobody has
 * thought of yet, which is the point of classifying by exclusion.
 */
const BENIGN = [
  {
    name: 'lazy initialiser',
    matches: (write) => /^db[.[][^=]*\|\|\s*(\[\]|\{\})\s*;?$/.test(write.rhs),
  },
  {
    name: 'append-only spread',
    matches: (write) => /^\[\s*\.\.\./.test(write.rhs),
  },
  {
    name: 'row-preserving map',
    matches: (write) => /^db\[[^\]]+\]\.map\(/.test(write.rhs),
  },
  {
    name: "mergeSource's non-array branches",
    matches: (write) =>
      write.rhs === '{ ...(db[key] || {}), ...source[key] };' || write.rhs === 'source[key];',
  },
  {
    name: "getDB's own application of the tombstones",
    matches: (write) =>
      write.text ===
      'db[table] = db[table].filter((row) => !removed.has(tombstoneKey(table, row)));',
  },
  {
    name: 'upsert writing back the array it built in place',
    matches: (write) => write.rhs === 'existing;',
  },
];

const isTombstoneCall = (line) =>
  /markMockDeleted\(/.test(line) && !/const markMockDeleted/.test(line);

/**
 * Is this removal site tombstoned FOR ITS OWN TABLE?
 *
 * Naming the table matters: `admin_delete_team` tombstoned `teams` and
 * nothing else while dropping three cascades beside it, so "a tombstone is
 * nearby" would have scored that site covered while two of its four tables
 * resurrected.
 *
 * What this does NOT check, stated so nobody reads more into a clean sheet
 * than is there: that the tombstone covers the same ROWS the site removes. A
 * tombstone naming the right table but a narrower predicate passes here, and
 * only the behavioural cases below can catch that.
 */
const isCovered = (source, site) => {
  const lines = source.split('\n');
  const from = Math.max(0, site.line - 1 - WINDOW);
  const to = Math.min(lines.length - 1, site.line - 1 + WINDOW);
  for (let j = from; j <= to; j += 1) {
    if (!isTombstoneCall(lines[j])) continue;
    const call = lines.slice(j, j + 5).join(' ');
    if (site.dynamic) {
      const variable = site.table.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) continue;
      if (new RegExp(`markMockDeleted\\(\\s*db,\\s*${variable}\\b`).test(call)) return true;
    } else if (call.includes(`'${site.table}'`)) {
      return true;
    }
  }
  return false;
};

/**
 * Every `markMockDeleted(` call, with its full argument text.
 *
 * **A tombstone with the wrong key is a silent no-op**: it records something
 * `getDB` can never match, so the delete looks durable and is not. Thirteen
 * call sites built the key by hand as `String(row.id)` or a literal, which was
 * right only for as long as the table had no composite identity -- and
 * `team_players` gaining one in this PR is exactly how that stops being true.
 */
const scanTombstoneCalls = (source) => {
  const lines = source.split('\n');
  const calls = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/markMockDeleted\(/.test(lines[i]) || /const markMockDeleted/.test(lines[i])) continue;
    let depth = 0;
    let text = '';
    let j = i;
    do {
      text += lines[j];
      for (const character of lines[j]) {
        if (character === '(') depth += 1;
        else if (character === ')') depth -= 1;
      }
      j += 1;
    } while (depth > 0 && j < lines.length && j < i + 14);
    calls.push({ line: i + 1, text });
  }
  return calls;
};

/**
 * Every place outside `saveDB` that writes the mock db straight into the page.
 *
 * Such a write skips `liftMockTombstonesForPresentRows`, so a row a previous
 * step deleted stays tombstoned when a later step seeds it back. The E2E steps
 * seed this way throughout, which is why `window.__saveMockDB__` exists: a
 * `page.evaluate` cannot import, so the producer is published on `window`.
 */
const SEARCH_ROOTS = ['frontend/src', 'tests'];
const scanDirectDbWrites = () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const assigns = /__MOCK_DB__\s*=(?!=)/.test(line) && !/=\s*undefined/.test(line);
          const stores = /setItem\(\s*'__MOCK_DB__'/.test(line);
          if (assigns || stores) {
            found.push({ file: path.relative(REPO, full), line: index + 1 });
          }
        });
    }
  };
  for (const root of SEARCH_ROOTS) walk(path.join(REPO, root));
  return found;
};

/** The removal sites: every table write that no BENIGN rule accounts for. */
const removalSites = (source) =>
  scanTableWrites(source).filter((write) => !BENIGN.some((rule) => rule.matches(write)));

describe('mock delete census :: every hard delete records a tombstone', () => {
  it('sees every write to a db table, and would fail if it saw none', () => {
    const writes = scanTableWrites(SOURCE);
    // **The anchor.** A scanner that matched nothing -- a renamed `db`, a
    // reformat that broke the regex -- would report a clean sheet below by
    // iterating an empty list.
    expect(writes.length).toBeGreaterThanOrEqual(90);
    expect(scanInPlaceRemovals(SOURCE)).toEqual([]);
  });

  it('accounts for the removal sites by name, and pins how many there are', () => {
    const sites = removalSites(SOURCE);
    // Pinned exactly, on LIVE-3's precedent: adding a delete path or folding
    // two into a helper must be a deliberate edit to this number, not a
    // silent drift past a >= with a margin of one.
    expect(sites).toHaveLength(24);
    const tables = new Set(sites.map((site) => site.table));
    for (const table of ['field_subunits', 'team_players', 'registrations', 'teams']) {
      expect(tables).toContain(table);
    }
  });

  it('leaves no removal site without a tombstone for its own table', () => {
    const uncovered = removalSites(SOURCE)
      .filter((site) => !isCovered(SOURCE, site))
      .map((site) => `${site.line}: ${site.table} -- ${site.text}`);
    expect(uncovered).toEqual([]);
  });

  it('keeps the benign list honest: every rule still classifies a real write', () => {
    // A rule that matches nothing is a hole nobody can see; a rule that
    // matched everything would pass the check above just as happily.
    const writes = scanTableWrites(SOURCE);
    for (const rule of BENIGN) {
      expect(writes.filter((write) => rule.matches(write)).length, rule.name).toBeGreaterThan(0);
    }
    expect(
      writes.filter((write) => BENIGN.some((rule) => rule.matches(write))).length
    ).toBeLessThan(writes.length);
  });

  it('POSITIVE CONTROL: rejects an untombstoned delete spelled with .filter()', () => {
    // **A guard you cannot make fail is not a guard.** The wrong
    // implementation is built here and the classifier is required to reject
    // it, rather than trusting that a clean sheet means the check works.
    const planted = SOURCE.replace(
      "    if (name === 'admin_delete_players') {",
      `    if (name === 'admin_delete_players') {
      db.divisions = (db.divisions || []).filter((d) => String(d.id) !== 'planted');`
    );
    expect(planted, 'the plant did not apply; this control proves nothing').not.toEqual(SOURCE);
    const uncovered = removalSites(planted).filter((site) => !isCovered(planted, site));
    expect(uncovered.map((site) => site.table)).toContain('divisions');
  });

  it('POSITIVE CONTROL: rejects an untombstoned delete routed through a helper', () => {
    // The shape a `.filter(`-keyed scanner cannot see, and the one this PR's
    // own style makes likely: the removal happens inside a helper and the call
    // site is a bare assignment.
    const planted = SOURCE.replace(
      "    if (name === 'admin_delete_players') {",
      `    if (name === 'admin_delete_players') {
      db.divisions = withoutDivision(db.divisions, 'planted');`
    );
    expect(planted, 'the plant did not apply; this control proves nothing').not.toEqual(SOURCE);
    const uncovered = removalSites(planted).filter((site) => !isCovered(planted, site));
    expect(uncovered.map((site) => site.table)).toContain('divisions');
  });

  it('POSITIVE CONTROL: rejects a tombstone that names a different table', () => {
    // The near miss the real code made: `admin_delete_team` tombstoned `teams`
    // and dropped `team_players` beside it. A table-blind classifier passes
    // that; this one must not.
    const planted = SOURCE.replace(
      "      cascadeDoomed('team_players', (tp) => String(tp.team_id) === String(p_team_id));",
      '      db.team_players = (db.team_players || []).filter(\n        (tp) => String(tp.team_id) !== String(p_team_id)\n      );'
    );
    expect(planted, 'the plant did not apply; this control proves nothing').not.toEqual(SOURCE);
    const uncovered = removalSites(planted).filter((site) => !isCovered(planted, site));
    expect(uncovered.map((site) => site.table)).toContain('team_players');
  });

  it('POSITIVE CONTROL: rejects an in-place splice on a db table', () => {
    const planted = SOURCE.replace(
      '      const ids = (p_player_ids || []).map(String);',
      '      const ids = (p_player_ids || []).map(String);\n      db.players.splice(0, 1);'
    );
    expect(planted, 'the plant did not apply; this control proves nothing').not.toEqual(SOURCE);
    expect(scanInPlaceRemovals(planted).length).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: a scan that matches nothing fails the anchor', () => {
    const blinded = SOURCE.replace(/\n(\s*)db\./g, '\n$1notdb.');
    expect(scanTableWrites(blinded).length).toBeLessThan(90);
  });

  it('builds every tombstone key through tombstoneKey, never by hand', () => {
    const calls = scanTombstoneCalls(SOURCE);
    expect(calls.length, 'the call scanner matched nothing').toBeGreaterThanOrEqual(24);
    const handBuilt = calls
      .filter((call) => !/tombstoneKey\(/.test(call.text))
      .map((call) => `${call.line}: ${call.text.trim().slice(0, 80)}`);
    expect(handBuilt).toEqual([]);
  });

  it('POSITIVE CONTROL: rejects a tombstone key built by hand', () => {
    const planted = SOURCE.replace(
      "      markMockDeleted(db, 'teams', [tombstoneKey('teams', team)]);",
      "      markMockDeleted(db, 'teams', [p_team_id]);"
    );
    expect(planted, 'the plant did not apply; this control proves nothing').not.toEqual(SOURCE);
    const handBuilt = scanTombstoneCalls(planted).filter(
      (call) => !/tombstoneKey\(/.test(call.text)
    );
    expect(handBuilt).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Writes that go past saveDB, and therefore past the lift
// ---------------------------------------------------------------------------
//
// **This is a ratchet, not an elimination, and saying which it is matters.**
// The E2E suite's seeding convention is to read the db out of the page, mutate
// it and assign it back, which skips `liftMockTombstonesForPresentRows`. That
// is not five sites in one file: it is 65 sites across 17 files, the whole
// convention. `window.__saveMockDB__` is the sanctioned replacement and
// `tests/e2e/steps/facility_management.ts` -- the file this PR's subject sits
// in -- is converted to it. The inventory below pins every remaining one by
// file and count, so a NEW bypass fails this test while the known debt stays
// visible and countable rather than buried in a PR description.

const SANCTIONED_WRITES = {
  // saveDB's own two writes, plus the module-scope initial load.
  'frontend/src/lib/mockSupabaseClient.js': 3,
  // A node-side seeder that runs before any client call; it cannot reach
  // saveDB, which is not exported.
  'tests/helpers/seedMockDb.js': 1,
  // Two deliberate injections that test what getDB does with a stale window
  // copy against a fresh sessionStorage one.
  'tests/importStaleJobCleanup.test.js': 2,
};

const KNOWN_E2E_DEBT = {
  'tests/e2e/steps/async_and_optimistic_ui.ts': 7,
  'tests/e2e/steps/auth_setup.ts': 1,
  'tests/e2e/steps/auto_scheduler.ts': 1,
  'tests/e2e/steps/coach_and_calendar.ts': 4,
  'tests/e2e/steps/dashboard_and_sidebar.ts': 10,
  'tests/e2e/steps/data_and_output.ts': 1,
  'tests/e2e/steps/network_resilience.ts': 2,
  'tests/e2e/steps/onboarding.ts': 2,
  'tests/e2e/steps/rbac_and_fields.ts': 3,
  'tests/e2e/steps/registration_compliance.ts': 2,
  'tests/e2e/steps/reporting.ts': 1,
  'tests/e2e/steps/scheduling_and_overrides.ts': 14,
  'tests/e2e/steps/team_and_roster.ts': 7,
  'tests/e2e/steps/team_communication.ts': 3,
  'tests/e2e/steps/visual_rbac_enforcement.ts': 1,
};

describe('mock db writes :: nothing new may go past saveDB', () => {
  it('finds the writes, and would fail if it found none', () => {
    const writes = scanDirectDbWrites();
    expect(writes.length).toBeGreaterThanOrEqual(60);
    expect(new Set(writes.map((write) => write.file))).toContain(
      'frontend/src/lib/mockSupabaseClient.js'
    );
  });

  it('accounts for every direct write, by file and by count', () => {
    const expected = { ...SANCTIONED_WRITES, ...KNOWN_E2E_DEBT };
    const actual = {};
    for (const write of scanDirectDbWrites()) {
      actual[write.file] = (actual[write.file] || 0) + 1;
    }
    // Exact, both ways: a new bypass fails, and so does a stale entry for a
    // file that has since been converted.
    expect(actual).toEqual(expected);
  });

  it('has converted the facility steps to the sanctioned producer', () => {
    const steps = readFileSync(path.join(REPO, 'tests/e2e/steps/facility_management.ts'), 'utf8');
    expect(steps).toContain('window.__saveMockDB__(db);');
    expect(steps).not.toMatch(/__MOCK_DB__\s*=(?!=)/);
    expect(SOURCE).toContain('window.__saveMockDB__ = saveDB;');
  });

  it('POSITIVE CONTROL: a file gaining a bypass is not silently absorbed', () => {
    const expected = { ...SANCTIONED_WRITES, ...KNOWN_E2E_DEBT };
    const actual = {};
    for (const write of scanDirectDbWrites()) {
      actual[write.file] = (actual[write.file] || 0) + 1;
    }
    // The shape a future edit takes: one more write in a file already listed.
    const drifted = {
      ...actual,
      'tests/e2e/steps/onboarding.ts': actual['tests/e2e/steps/onboarding.ts'] + 1,
    };
    expect(drifted).not.toEqual(expected);
    // ... and a file that is not listed at all.
    expect({ ...actual, 'tests/e2e/steps/brand_new.ts': 1 }).not.toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Behaviour: the deletes a SEEDED row can actually reach
// ---------------------------------------------------------------------------
//
// `initialMockData` is the only source `getDB()` re-merges that a delete
// cannot overwrite (`saveDB` replaces both `window.__MOCK_DB__` and
// sessionStorage wholesale), so a resurrection is stageable exactly when the
// deleted row is in the seed. These are those cases.

describe('mock hard deletes :: a seeded row stays deleted across getDB', () => {
  it('keeps the seeded roster rows of a deleted player gone', async () => {
    const before = getMockData('team_players').filter((row) => row.player_id === 'player-1');
    // Meta-assertion: a seed change that drops this row would make the check
    // below pass against nothing.
    expect(before, 'player-1 has no seeded team_players row to resurrect').toHaveLength(1);

    const { error } = await supabase.rpc('admin_delete_players', { p_player_ids: ['player-1'] });
    expect(error).toBeNull();

    expect(getMockData('players').find((p) => p.id === 'player-1')).toBeUndefined();
    expect(getMockData('team_players').filter((row) => row.player_id === 'player-1')).toEqual([]);
  });

  it('keeps a deleted team s seeded cascades gone', async () => {
    const rosterBefore = getMockData('team_players').filter((r) => r.team_id === SEEDED_TEAM);
    const practiceBefore = getMockData('practice_assignments').filter(
      (r) => r.team_id === SEEDED_TEAM
    );
    expect(rosterBefore.length, 'no seeded roster rows on the team under test').toBeGreaterThan(0);
    expect(practiceBefore.length, 'no seeded practice rows on the team under test').toBeGreaterThan(
      0
    );

    const { error } = await supabase.rpc('admin_delete_team', { p_team_id: SEEDED_TEAM });
    expect(error).toBeNull();

    expect(getMockData('teams').find((t) => t.id === SEEDED_TEAM)).toBeUndefined();
    expect(getMockData('team_players').filter((r) => r.team_id === SEEDED_TEAM)).toEqual([]);
    expect(getMockData('practice_assignments').filter((r) => r.team_id === SEEDED_TEAM)).toEqual(
      []
    );
  });

  it('keeps a deleted form s seeded submissions gone', async () => {
    const before = getMockData('registrations').filter((r) => r.form_id === 'f1');
    expect(before.length, 'form f1 has no seeded submissions to resurrect').toBeGreaterThan(0);

    const { error } = await supabase.rpc('admin_delete_registration_form', { p_form_id: 'f1' });
    expect(error).toBeNull();

    expect(getMockData('registration_forms').find((f) => f.id === 'f1')).toBeUndefined();
    expect(getMockData('registrations').filter((r) => r.form_id === 'f1')).toEqual([]);
  });

  it('keeps a row deleted through the generic .delete().eq() gone', async () => {
    expect(
      getMockData('players').find((p) => p.id === 'player-2'),
      'player-2 is not seeded, so this proves nothing'
    ).toBeTruthy();

    await supabase.from('players').delete().eq('id', 'player-2');

    expect(getMockData('players').find((p) => p.id === 'player-2')).toBeUndefined();
  });

  it('moves a player off a seeded roster row without it coming back', async () => {
    expect(
      getMockData('team_players').find(
        (r) => r.player_id === 'player-1' && r.team_id === SEEDED_TEAM
      ),
      'player-1 is not on the seeded team, so the move proves nothing'
    ).toBeTruthy();

    const { error } = await supabase.rpc('admin_update_player', {
      p_player_id: 'player-1',
      p_patch: { team_id: 't1' },
    });
    expect(error).toBeNull();

    const rows = getMockData('team_players').filter((r) => r.player_id === 'player-1');
    expect(rows.map((r) => r.team_id)).toEqual(['t1']);
  });

  it('lets the player move BACK, which a permanent tombstone would forbid', async () => {
    // **The hazard the tombstone introduces, and the reason `saveDB` lifts
    // one whose row is present again.** `team_players` keys on
    // `team_id:player_id`, so the pair recurs -- and a tombstone that outlived
    // the delete would turn a fixed resurrection into a silent disappearance.
    await supabase.rpc('admin_update_player', {
      p_player_id: 'player-1',
      p_patch: { team_id: 't1' },
    });
    const { error } = await supabase.rpc('admin_update_player', {
      p_player_id: 'player-1',
      p_patch: { team_id: SEEDED_TEAM },
    });
    expect(error).toBeNull();

    const rows = getMockData('team_players').filter((r) => r.player_id === 'player-1');
    expect(rows.map((r) => r.team_id)).toEqual([SEEDED_TEAM]);
  });

  it('lets a row be re-created under an id it was deleted under', async () => {
    await supabase.from('players').delete().eq('id', 'player-2');
    expect(getMockData('players').find((p) => p.id === 'player-2')).toBeUndefined();

    await supabase.from('players').insert({
      id: 'player-2',
      organization_id: ORG,
      first_name: 'Re',
      last_name: 'Created',
    });
    expect(getMockData('players').find((p) => p.id === 'player-2')?.last_name).toBe('Created');
  });
});

// ---------------------------------------------------------------------------
// Mechanism: the deletes no seeded row can reach TODAY
// ---------------------------------------------------------------------------
//
// Following the precedent set for `field_blackouts`: where the consequence is
// unreachable because the table is absent from `initialMockData`, staging an
// outcome would pass with or without the fix. What is asserted instead is that
// the delete records the tombstone its siblings record, so the arm stays
// consistent for the moment a row does come from the seed.

describe('mock hard deletes :: unreachable today, mechanism pinned anyway', () => {
  it('tombstones the subunits dropped when a field stops supporting halves', async () => {
    expect(
      getMockData('field_subunits'),
      'field_subunits is seeded now; this case should be behavioural instead'
    ).toEqual([]);

    await supabase.from('fields').insert({
      id: 'tomb-field',
      organization_id: ORG,
      name: 'Tombstone Field',
      supports_halves: true,
    });
    const created = getMockData('field_subunits').filter((s) => s.field_id === 'tomb-field');
    expect(created.length, 'no subunits were created, so nothing is dropped below').toBe(2);
    expect(getMockData('__deleted__')?.field_subunits ?? []).not.toContain(created[0].id);

    await supabase.from('fields').update({ supports_halves: false }).eq('id', 'tomb-field');

    expect(getMockData('field_subunits').filter((s) => s.field_id === 'tomb-field')).toEqual([]);
    const tombstones = getMockData('__deleted__')?.field_subunits ?? [];
    for (const subunit of created) expect(tombstones).toContain(subunit.id);
  });

  it('tombstones a revoked invite', async () => {
    expect(
      getMockData('organization_invites') ?? [],
      'organization_invites is seeded now; this case should be behavioural instead'
    ).toEqual([]);

    await supabase.from('organization_invites').insert({
      id: 'invite-tomb',
      organization_id: ORG,
      email: 'invitee@example.test',
    });
    expect(getMockData('__deleted__')?.organization_invites ?? []).not.toContain('invite-tomb');

    const { error } = await supabase.rpc('revoke_org_invite', {
      p_invite_id: 'invite-tomb',
      p_organization_id: ORG,
    });
    expect(error).toBeNull();

    expect(getMockData('organization_invites')).toEqual([]);
    expect(getMockData('__deleted__')?.organization_invites ?? []).toContain('invite-tomb');
  });
});

// ---------------------------------------------------------------------------
// The generic delete builder's one genuinely silent gap
// ---------------------------------------------------------------------------

describe('mock .delete() :: only .eq() exists, and says so', () => {
  it('names the failure when awaited with no filter instead of deleting nothing', async () => {
    const before = getMockData('players').length;
    expect(before, 'players is empty, so "deleted nothing" is indistinguishable').toBeGreaterThan(
      0
    );

    const { data, error } = await supabase.from('players').delete();

    expect(data).toBeNull();
    expect(error?.message).toContain("delete() on 'players' was awaited with no filter");
    expect(getMockData('players')).toHaveLength(before);
  });

  it('makes a keyless row s delete durable without wiping its siblings', async () => {
    // **`String(undefined)` is a key, and it matches every keyless row.**
    // `profile_players` rows have no `id`, so before this PR the only two
    // outcomes available were "tombstone 'undefined' and empty the table" or
    // "record nothing and resurrect the row". It gets the composite identity
    // `mergeSource` already dedupes it by instead, so neither happens.
    const before = getMockData('profile_players');
    expect(before.length, 'profile_players is empty, so this proves nothing').toBeGreaterThan(1);
    expect(before.every((row) => row.id === undefined)).toBe(true);

    await supabase.from('profile_players').delete().eq('player_id', 'player-1');

    const after = getMockData('profile_players');
    expect(after.filter((row) => row.player_id === 'player-1')).toHaveLength(0);
    // The sibling survives -- no collateral wipe from an 'undefined' key.
    expect(after.filter((row) => row.player_id === 'player-2')).toHaveLength(1);
  });

  it('leaves a removed member removed when they sign back in', async () => {
    // **A seeding convenience must not reverse an administrative action.**
    // The sign-in block creates an `organization_members` row for any profile
    // that has none, hardcoded to `org-1` -- the exact composite key
    // `admin_remove_member` tombstones. Routing sign-in through `saveDB` made
    // the lift see that key present and drop it, so a removed member came
    // back, carrying `app_metadata.role` rather than the role the admin had
    // assigned. Signing in does not create a membership in real Supabase, and
    // it must not here.
    const { error } = await supabase.rpc('admin_remove_member', {
      p_organization_id: ORG,
      p_profile_id: 'mock-coach-id',
    });
    expect(error).toBeNull();
    expect(
      getMockData('organization_members').filter((m) => m.profile_id === 'mock-coach-id'),
      'the member was not removed, so the sign-in below proves nothing'
    ).toHaveLength(0);

    await supabase.auth.signInWithPassword({
      email: 'coach@example.com',
      password: 'test-password-123',
    });

    expect(
      getMockData('organization_members').filter((m) => m.profile_id === 'mock-coach-id')
    ).toHaveLength(0);
  });

  it('still seeds a membership for a profile that was never a member', async () => {
    // The other half of the same branch, so the tombstone check cannot be
    // "fixed" by deleting the seeding push outright.
    expect(
      getMockData('organization_members').filter((m) => m.profile_id === 'mock-parent-id')
    ).toHaveLength(1);
    await supabase.rpc('admin_remove_member', {
      p_organization_id: ORG,
      p_profile_id: 'mock-parent-id',
    });

    await supabase.auth.signInWithPassword({
      email: 'staff@example.com',
      password: 'test-password-123',
    });

    expect(
      getMockData('organization_members').filter((m) => m.profile_id === 'mock-staff-id')
    ).toHaveLength(1);
  });

  it('persists what sign-in seeds, which writing past saveDB did not', async () => {
    // The real half of the finding that produced the resurrection: the direct
    // assignment never reached sessionStorage, so rows sign-in created were
    // lost on the next reload.
    await supabase.auth.signInWithPassword({
      email: 'staff@example.com',
      password: 'test-password-123',
    });
    const stored = JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}');
    expect(
      (stored.organization_members || []).filter((m) => m.profile_id === 'mock-staff-id')
    ).toHaveLength(1);
  });

  it('throws naming the method for a filter it does not implement', () => {
    // Not silent, and therefore left unimplemented rather than guessed at: the
    // TypeError names the missing method. Pinned so that a future `.neq` added
    // without a tombstone cannot slip in as a no-op instead.
    const builder = /** @type {any} */ (supabase.from('players').delete());
    expect(() => builder.neq('id', 'player-1')).toThrow(/neq is not a function/);
  });
});
