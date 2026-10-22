import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as browser from '../frontend/src/utils/importAllowlist.js';
import { HEADER_ALIASES as BROWSER_ALIASES } from '../frontend/src/utils/telemetryUtils.js';
import * as edge from '../supabase/functions/_shared/import-allowlist.ts';

/**
 * The import allowlist (plan docs/changes/2026-10-22-admin-focus.md, R0) has
 * three copies: the browser filters columns before upload, import-validation
 * filters them again before it stages a row, and the SQL finalizers read only
 * the keys they need and build `custom_attributes` from the organization's
 * declared fields. This holds them together:
 *
 * - the two code copies have the same lists and give the same answer on every
 *   header below (the corpus is written here, not derived from either copy);
 * - the two header alias maps agree on every header that reaches an
 *   allowlisted key, so the browser and the Edge Function judge a column by
 *   the same canonical key;
 * - **the lists equal what the SQL reads.** The subject set is enumerated from
 *   the migrations: the latest definition of every function whose body reads
 *   `normalized_payload`. Each is classified below; an unclassified reader
 *   fails, and so does a people finalizer that reads a key the allowlist does
 *   not hold (or the allowlist holding a key nothing reads).
 *
 * **Blind spot, declared.** A key a SQL function reads dynamically (a key built
 * at run time, or `jsonb_each` over the payload) is invisible to the scan;
 * `import_declared_attributes` is the one such reader, and it reads only the
 * organization's declared fields.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the import allowlist, browser and Edge copies', () => {
  it('has the same lists and entity types in both copies', () => {
    expect([...edge.PLAYER_IMPORT_KEYS]).toEqual([...browser.PLAYER_IMPORT_KEYS]);
    expect([...edge.COACH_IMPORT_KEYS]).toEqual([...browser.COACH_IMPORT_KEYS]);
    expect({ ...edge.ALLOWLIST_ENTITY_TYPES }).toEqual({ ...browser.ALLOWLIST_ENTITY_TYPES });
    expect({ ...browser.ALLOWLIST_ENTITY_TYPES }).toEqual({ players: 'player', coaches: 'coach' });
  });

  const DROPPED_PLAYER = [
    'email',
    'contact_email',
    'phone',
    'contact_phone',
    'guardian_name',
    'parent_name',
    'guardian_email',
    'parent_email',
    'guardian_phone',
    'parent_phone',
    'guardian_1_first_name',
    'guardian_1_email',
    'guardian_1_alternate_email',
    'guardian_2_last_name',
    'guardian 1 address',
    'guardian 1 mobile phone number',
    'payment_status',
    'payment status',
    'enroller',
    'shirt size',
  ];
  const KEPT_PLAYER = [
    'first_name',
    'last_name',
    'date_of_birth',
    'external_registration_id',
    'age group',
    'gender',
    'division_name',
    'buddy_request',
    'mutual_buddy_code',
    'play_up',
    'willing_to_coach',
    'years_played',
    'team name',
    'team age',
    'team gender',
  ];
  const DROPPED_COACH = [
    'phone',
    'contact_phone',
    'first_name',
    'guardian 1 address',
    'guardian 1 mobile phone number',
    'guardian 1 email address',
    "what is your player's birth date?",
    'date_of_birth',
    'payment status',
    'team name',
    'playing up',
    'preferred co-coach',
  ];
  const KEPT_COACH = ['full_name', 'email', 'status', 'can_coach_multiple_teams', 'certifications'];

  it.each(DROPPED_PLAYER)('both copies drop the player key %j', (key) => {
    expect(browser.isAllowedImportKey('players', key)).toBe(false);
    expect(edge.isAllowedImportKey('players', key)).toBe(false);
  });
  it.each(KEPT_PLAYER)('both copies keep the player key %j', (key) => {
    expect(browser.isAllowedImportKey('players', key)).toBe(true);
    expect(edge.isAllowedImportKey('players', key)).toBe(true);
  });
  it.each(DROPPED_COACH)('both copies drop the coach key %j', (key) => {
    expect(browser.isAllowedImportKey('coaches', key)).toBe(false);
    expect(edge.isAllowedImportKey('coaches', key)).toBe(false);
  });
  it.each(KEPT_COACH)('both copies keep the coach key %j', (key) => {
    expect(browser.isAllowedImportKey('coaches', key)).toBe(true);
    expect(edge.isAllowedImportKey('coaches', key)).toBe(true);
  });

  it('keeps a declared field by its identity in both copies, and only for its entity', () => {
    for (const copy of [browser, edge]) {
      expect(copy.isAllowedImportKey('coaches', 'shirt size', ['shirt_size'])).toBe(true);
      expect(copy.isAllowedImportKey('coaches', '  Shirt   Size ', ['shirt_size'])).toBe(true);
      expect(copy.isAllowedImportKey('coaches', 'shirt', ['shirt_size'])).toBe(false);
      expect(copy.isAllowedImportKey('coaches', 'shirt size', [])).toBe(false);
      expect(copy.declaredFieldKey(' Jersey  Size ')).toBe('jersey_size');
    }
  });

  it('leaves the other import types as given in both copies', () => {
    const row = { location: 'Field Park', 'Guardian 1 Email Address': 'kept@example.com' };
    const lower = (h) => h.toLowerCase().trim();
    expect(edge.keepAllowedColumns('fields', row, lower)).toEqual(row);
    expect(browser.keepAllowedColumns('fields', row, lower)).toEqual(row);
    expect(browser.isAllowedImportKey('field_availability', 'anything')).toBe(true);
  });

  it('filters synthetic export rows the same way in both copies, to allowlisted keys only', () => {
    const playerRow = {
      'First Name': 'First1',
      'Last Name': 'Last1',
      'Date of Birth': '2016-01-01',
      'Registration ID': 'REG-1',
      Gender: 'F',
      'Age Group': '9',
      'Team Name': 'Team 1',
      'Play Up': 'yes',
      'Shirt Size': 'YM',
      Email: 'email1@example.com',
      Phone: '555-100-0001',
      'Guardian 1 First Name': 'First2',
      'Guardian 1 Email Address': 'email2@example.com',
      'Guardian 1 Mobile Phone Number': '555-100-0002',
      'Guardian 1 Address': '1 Placeholder Way',
      'Payment Status': 'PAID',
    };
    const coachRow = {
      'Full Name': 'First3 Last3',
      Email: 'email3@example.com',
      Phone: '555-100-0003',
      'Guardian 1 Email Address': 'email4@example.com',
      "What is your player's birth date?": '2016-02-02',
      'Playing Up': 'Yes',
      'Playing Up__2': 'No',
      'Shirt Size': 'AL',
    };
    const normalize = browser.canonicalImportKey;
    for (const copy of [browser, edge]) {
      expect(copy.keepAllowedColumns('players', playerRow, normalize, ['shirt_size'])).toEqual({
        'First Name': 'First1',
        'Last Name': 'Last1',
        'Date of Birth': '2016-01-01',
        'Registration ID': 'REG-1',
        Gender: 'F',
        'Age Group': '9',
        'Team Name': 'Team 1',
        'Play Up': 'yes',
        'Shirt Size': 'YM',
      });
      expect(copy.keepAllowedColumns('coaches', coachRow, normalize, [])).toEqual({
        'Full Name': 'First3 Last3',
        Email: 'email3@example.com',
      });
    }
    expect(browser.filterImportRows('coaches', [coachRow], ['shirt_size'])).toEqual([
      { 'Full Name': 'First3 Last3', Email: 'email3@example.com', 'Shirt Size': 'AL' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The two alias maps: the browser judges a header by the key the Edge stages.
// ---------------------------------------------------------------------------

/** The Edge Function's alias map, read from its source (its module calls `serve`). */
function edgeAliases() {
  const src = readFileSync(
    path.join(REPO, 'supabase/functions/import-validation/index.ts'),
    'utf8'
  );
  const start = src.indexOf('const HEADER_ALIASES');
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n};', open);
  const body = src.slice(open + 1, close);
  /** @type {Record<string, string>} */
  const map = {};
  const entry =
    /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_][\w]*))\s*:\s*\n?\s*'([^']*)'/gm;
  for (const m of body.matchAll(entry)) {
    const key = (m[1] ?? m[2] ?? m[3]).replace(/\\'/g, "'");
    map[key] = m[4];
  }
  return map;
}

describe('the header alias maps', () => {
  const EDGE = edgeAliases();
  const allowed = new Set([...browser.PLAYER_IMPORT_KEYS, ...browser.COACH_IMPORT_KEYS]);

  it('reads the Edge map, including the long GotSport questions', () => {
    expect(Object.keys(EDGE).length).toBeGreaterThan(150);
    expect(EDGE["can you coach for this player's team?"]).toBe('willing_to_coach');
    expect(EDGE['guardian 1 email address']).toBe('guardian_1_email');
  });

  it('agree on every header that reaches an allowlisted key', () => {
    const disagreements = [...new Set([...Object.keys(EDGE), ...Object.keys(BROWSER_ALIASES)])]
      .filter((h) => allowed.has(EDGE[h]) || allowed.has(BROWSER_ALIASES[h]))
      .filter((h) => EDGE[h] !== BROWSER_ALIASES[h]);
    expect(disagreements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lists equal what the latest SQL reads.
// ---------------------------------------------------------------------------

const stripSqlComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

const DEFINITION =
  /\b(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DROP\s+FUNCTION)\s+(?:IF\s+EXISTS\s+)?((?:"?\w+"?\s*\.\s*)?"?\w+"?)/gi;

/**
 * The latest body of every SQL function, migrations in version order. A body is
 * its dollar-quoted block (as `tests/practiceReaderCensus.test.js` reads them).
 * @param {Array<{ name: string, sql: string }>} files
 */
function latestFunctionBodies(files) {
  const latest = new Map();
  for (const { sql } of files) {
    const src = stripSqlComments(sql);
    for (const m of src.matchAll(DEFINITION)) {
      const name = m[2]
        .replace(/"/g, '')
        .replace(/\s+/g, '')
        .toLowerCase()
        .replace(/^public\./, '');
      if (m[1].toUpperCase().startsWith('DROP')) {
        latest.delete(name);
        continue;
      }
      const after = src.slice(m.index + m[0].length);
      const open = /\$(\w*)\$/.exec(after);
      if (open === null) continue;
      const rest = after.slice(open.index + open[0].length);
      const close = rest.indexOf(open[0]);
      latest.set(name, close < 0 ? rest : rest.slice(0, close));
    }
  }
  return latest;
}

const literals = (text) =>
  [...text.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

/**
 * Every payload key a body reads by name: each literal argument of an
 * `import_payload_text(<...normalized_payload>, ...)` call, and each key read
 * with `->>`, `->` or `?` off `normalized_payload`.
 * @param {string} body
 */
function payloadKeysRead(body) {
  const keys = new Set();
  const call = /import_payload_text\s*\(/gi;
  for (const m of body.matchAll(call)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const startArgs = i;
    while (i < body.length && depth > 0) {
      if (body[i] === "'") {
        i = body.indexOf("'", i + 1);
        while (body[i + 1] === "'") i = body.indexOf("'", i + 2);
      } else if (body[i] === '(') depth += 1;
      else if (body[i] === ')') depth -= 1;
      i += 1;
    }
    const args = body.slice(startArgs, i - 1);
    const comma = args.indexOf(',');
    if (comma < 0 || !/normalized_payload/.test(args.slice(0, comma))) continue;
    for (const key of literals(args.slice(comma + 1))) keys.add(key);
  }
  for (const m of body.matchAll(/normalized_payload\s*(?:->>|->|\?)\s*'((?:[^']|'')*)'/g)) {
    keys.add(m[1].replace(/''/g, "'"));
  }
  return keys;
}

/** Each function whose latest body reads `normalized_payload`, and what it reads for. */
const READERS = {
  finalize_import_job: 'players',
  materialize_import_buddy_pairs: 'players',
  finalize_coach_import_job: 'coaches',
  finalize_field_import_job: 'fields',
  finalize_field_availability_import_job: 'fields',
};

function migrationBodies() {
  const dir = path.join(REPO, 'supabase/migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
  return latestFunctionBodies(files);
}

/**
 * The keys each people import type's SQL readers read, and the readers the
 * registry does not classify.
 * @param {Map<string, string>} latest
 */
function sqlCensus(latest) {
  const readers = [...latest].filter(([, body]) => /\bnormalized_payload\b/.test(body));
  const unclassified = readers.map(([name]) => name).filter((name) => !(name in READERS));
  /** @type {Record<string, Set<string>>} */
  const read = { players: new Set(), coaches: new Set() };
  for (const [name, body] of readers) {
    const type = READERS[name];
    if (type in read) for (const key of payloadKeysRead(body)) read[type].add(key);
  }
  return { readers: readers.map(([name]) => name), unclassified, read };
}

const TEAM_PLACEMENT = ['team name', 'team age', 'team gender'];

describe('the allowlist equals what the latest SQL reads', () => {
  const latest = migrationBodies();
  const census = sqlCensus(latest);

  it('finds every classified reader in the migrations, and no unclassified one', () => {
    expect(census.unclassified).toEqual([]);
    expect([...census.readers].sort()).toEqual(Object.keys(READERS).sort());
  });

  it('the player readers read exactly the player allowlist', () => {
    expect([...census.read.players].sort()).toEqual([...browser.PLAYER_IMPORT_KEYS].sort());
    for (const key of TEAM_PLACEMENT) expect(census.read.players.has(key)).toBe(true);
  });

  it('the coach finalizer reads exactly the coach allowlist', () => {
    expect([...census.read.coaches].sort()).toEqual([...browser.COACH_IMPORT_KEYS].sort());
  });

  it('neither people finalizer stores the payload minus a denylist; both use the declared fields', () => {
    for (const name of ['finalize_import_job', 'finalize_coach_import_job']) {
      const body = latest.get(name) ?? '';
      expect(body, name).not.toMatch(/normalized_payload\s*\n?\s*-\s*'/);
      expect(body, name).toMatch(/import_declared_attributes\s*\(/);
    }
  });

  it('POSITIVE CONTROL: a finalizer that starts reading a guardian email or a phone fails', () => {
    const planted = new Map(latest);
    planted.set(
      'finalize_import_job',
      `${latest.get('finalize_import_job')}
       SELECT public.import_payload_text(sp.normalized_payload, 'guardian_1_email');`
    );
    planted.set(
      'finalize_coach_import_job',
      `${latest.get('finalize_coach_import_job')}
       v := v_row.normalized_payload ->> 'phone';`
    );
    const { read } = sqlCensus(planted);
    expect(read.players.has('guardian_1_email')).toBe(true);
    expect([...read.players].sort()).not.toEqual([...browser.PLAYER_IMPORT_KEYS].sort());
    expect([...read.coaches].sort()).not.toEqual([...browser.COACH_IMPORT_KEYS].sort());
  });

  it('POSITIVE CONTROL: a new reader of the staged payload is unclassified until named', () => {
    const planted = new Map(latest);
    planted.set('export_guardians', "SELECT sp.normalized_payload ->> 'guardian_email'");
    expect(sqlCensus(planted).unclassified).toEqual(['export_guardians']);
  });

  it('POSITIVE CONTROL: the key reader sees quoted apostrophes and nested calls', () => {
    const keys = payloadKeysRead(
      "lower(public.import_payload_text(sp.normalized_payload, 'a', 'can you coach for this player''s team?'))" +
        " || public.import_payload_text(lower(x), 'not-read')"
    );
    expect([...keys].sort()).toEqual(['a', "can you coach for this player's team?"]);
  });
});
