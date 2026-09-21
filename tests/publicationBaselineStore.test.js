/**
 * **The vertical slice, driven end to end: store, writer, reader.**
 *
 * GAP-29's binding condition was that the table must not land without a reader
 * that answers a real question with it. This file is where that is proved by
 * *running* it rather than by reading three files and believing they line up:
 * a schedule is exported, published through `usePublicationBaselines`, the
 * schedule is then changed, and the stored baseline is asked whether it still
 * matches. The answer has to name what moved.
 *
 * Two halves, and they check different things:
 *
 * 1. **Behaviour**, through the real mock Supabase client and the real hook.
 *    `scripts/dbharness` executes the actual SQL; this executes the app's path
 *    to it.
 * 2. **The mock and the migration as one contract**, following
 *    `tests/fieldBlackoutMockContract.test.js`. The mock is what the E2E suite
 *    and the UI are written against, so a mock looser than the database is a
 *    defect generator. The column set and the refusals are derived from the
 *    MIGRATION TEXT and the mock is held to them.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

import { mockSupabase, getMockData } from '../frontend/src/lib/mockSupabaseClient.js';
import { generateScheduleExports } from '@squadlogic/core/outputGeneration.js';
import { PUBLICATION_REASON, baselineDriftSummary } from '@squadlogic/core/publication/index.js';
import {
  naivePublicationStamp,
  usePublicationBaselines,
} from '../frontend/src/hooks/usePublicationBaselines.js';
import { useOrganization } from '../frontend/src/contexts/OrganizationContext.jsx';

vi.mock('../frontend/src/lib/supabaseClient.js', async () => {
  const mock = await import('../frontend/src/lib/mockSupabaseClient.js');
  return { supabase: mock.mockSupabase };
});
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: vi.fn(),
}));
vi.mock('../frontend/src/lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readFileSync(
  path.join(REPO_ROOT, 'supabase/migrations/20260920000000_publication_baselines.sql'),
  'utf8'
);
const HOOK_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'frontend/src/hooks/usePublicationBaselines.js'),
  'utf8'
);

const ORG = 'org-1';
const setMockSession = (userId) =>
  sessionStorage.setItem('__MOCK_SESSION__', JSON.stringify({ user: { id: userId } }));

const TEAMS = [
  { id: 't-1', name: 'Blue Bears', division: 'U10' },
  { id: 't-2', name: 'Red Foxes', division: 'U10' },
  { id: 't-3', name: 'Green Owls', division: 'U12' },
  { id: 't-4', name: 'Grey Wolves', division: 'U12' },
];
const GAMES = [
  {
    homeTeamId: 't-1',
    awayTeamId: 't-2',
    start: '2026-04-11T09:00:00Z',
    end: '2026-04-11T10:00:00Z',
    fieldId: 'pitch-1',
    slotId: 's-1',
  },
  {
    homeTeamId: 't-3',
    awayTeamId: 't-4',
    start: '2026-04-11T11:00:00Z',
    end: '2026-04-11T12:00:00Z',
    fieldId: 'pitch-2',
    slotId: 's-2',
  },
];
/** The first game half an hour later, on other ground. The second is gone. */
const MOVED_GAMES = [
  {
    homeTeamId: 't-1',
    awayTeamId: 't-2',
    start: '2026-04-11T09:30:00Z',
    end: '2026-04-11T10:30:00Z',
    fieldId: 'pitch-7',
    slotId: 's-1',
  },
];

const rowsFor = (games) =>
  generateScheduleExports({ teams: TEAMS, gameAssignments: games }).master.rows;

const publishInput = (rows, overrides = {}) => ({
  snapshotId: 'week-1',
  label: 'Master schedule',
  channel: 'exports bucket',
  publishedAt: '2026-04-10T18:00:00',
  publishedBy: 'actor-1',
  rows,
  ...overrides,
});

function freshMock(userId = 'mock-admin-id') {
  sessionStorage.clear();
  delete window.__MOCK_DB__;
  setMockSession(userId);
}

async function mountHook() {
  const rendered = renderHook(() => usePublicationBaselines());
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error [MOCK] - a partial organization context is enough here.
  vi.mocked(useOrganization).mockReturnValue({ currentOrganization: { id: ORG } });
  freshMock();
});

/* ========================================================================== */
/* Behaviour: the slice, run                                                   */
/* ========================================================================== */

describe('publication baselines :: the slice, run end to end', () => {
  it('publishes, lists, and then reports exactly what moved', async () => {
    const { result } = await mountHook();

    // Nothing published yet, and the reader says so rather than pretending.
    expect(result.current.baselines).toEqual([]);

    const published = rowsFor(GAMES);
    await act(async () => {
      await result.current.publishBaseline(publishInput(published));
    });

    // ---- the store holds it, at version 1, with the payload -----------------
    await waitFor(() => expect(result.current.baselines).toHaveLength(1));
    const [summary] = result.current.baselines;
    expect(summary.baselineVersion).toBe(1);
    expect(summary.rowCount).toBe(published.length);
    expect(summary.publishedAt).toBe('2026-04-10T18:00:00');

    const stored = getMockData('publication_baselines');
    expect(stored).toHaveLength(1);
    expect(stored[0].export_rows).toHaveLength(published.length);
    // The digest was computed by the package, not by the hook or the store.
    expect(stored[0].digest).toMatch(/^[0-9a-f]{16}$/);

    // ---- the reader, against a schedule that has since changed -------------
    const report = await result.current.compareWithBaseline(summary.id, rowsFor(MOVED_GAMES));
    const drift = baselineDriftSummary(report.parity);

    // The stored ground truth read back clean: the round trip through jsonb
    // did not disturb the digest.
    expect(report.readFindings.map((finding) => finding.code)).not.toContain(
      PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH
    );

    expect(drift.drifted).toBe(true);
    // Game 1 moved: both of its rows differ, on both the time and the ground.
    expect(drift.differing).toBe(2);
    for (const pair of report.parity.buckets.differing) {
      expect([...pair.changedFields].sort()).toEqual(['field', 'startMinutes']);
    }
    // Game 2 is gone: named, not counted. Incident 1 is a count that said 366.
    expect(drift.removed).toBe(2);
    expect(report.parity.buckets.removed.map((orphan) => orphan.row.participant).sort()).toEqual([
      't-3',
      't-4',
    ]);
    expect(drift.added).toBe(0);
    expect(drift.matched).toBe(0);
  });

  it('assigns the next version per organisation and refuses a repeated snapshot id', async () => {
    const { result } = await mountHook();
    const rows = rowsFor(GAMES);

    await act(async () => {
      await result.current.publishBaseline(publishInput(rows));
    });
    let second = /** @type {any} */ (null);
    await act(async () => {
      second = await result.current.publishBaseline(
        publishInput(rows, { snapshotId: 'week-2', publishedAt: '2026-04-17T18:00:00' })
      );
    });
    expect(second.baseline_version).toBe(2);

    // **The durable version is the store's, not the caller's**, so the RPC has
    // no parameter for it and a caller cannot set it.
    expect(HOOK_SOURCE).not.toContain('baseline_version:');
    expect(MIGRATION).not.toContain('p_baseline_version');

    await expect(
      result.current.publishBaseline(publishInput(rows, { snapshotId: 'week-1' }))
    ).rejects.toThrow(/publication_baselines_snapshot_unique/);

    // The newest first, which is the order the operator picks from.
    await waitFor(() => expect(result.current.baselines).toHaveLength(2));
    expect(result.current.baselines.map((baseline) => baseline.baselineVersion)).toEqual([2, 1]);
  });

  it('refuses a caller who is not an admin of the organisation', async () => {
    // `is_org_admin` in SQL; the mock's own membership check here. A member of
    // no organisation is the closest the mock gets to an anonymous caller.
    freshMock('not-a-member');
    const { result } = await mountHook();
    await expect(result.current.publishBaseline(publishInput(rowsFor(GAMES)))).rejects.toThrow(
      /Access denied/
    );
    expect(getMockData('publication_baselines')).toEqual([]);
  });

  it('writes a before and an after audit row for every publication', async () => {
    const { result } = await mountHook();
    await act(async () => {
      await result.current.publishBaseline(publishInput(rowsFor(GAMES)));
    });

    const entries = getMockData('audit_log').filter(
      (entry) => entry.action === 'publication.baseline_recorded'
    );
    expect(entries.map((entry) => entry.metadata.phase).sort()).toEqual(['after', 'before']);
    // The before row carries no payload, for the reason the migration states:
    // a season baseline written into audit metadata twice is a megabyte of
    // duplicated schedule per publication.
    const before = entries.find((entry) => entry.metadata.phase === 'before');
    expect(before.metadata.requested.export_rows).toBeUndefined();
    expect(before.metadata.requested.row_count).toBe(rowsFor(GAMES).length);
  });

  it('refuses to compare when nothing has been generated, rather than comparing against nothing', async () => {
    const { result } = await mountHook();
    await act(async () => {
      await result.current.publishBaseline(publishInput(rowsFor(GAMES)));
    });
    await waitFor(() => expect(result.current.baselines).toHaveLength(1));
    const [summary] = result.current.baselines;
    await expect(result.current.compareWithBaseline(summary.id, [])).rejects.toThrow(
      /Generate the CSVs first/
    );
  });

  it('reports a baseline whose stored rows were edited, rather than comparing against the edit', async () => {
    // **The case the digest exists for.** A row is edited directly in the
    // store, behind the RPC. The read must say so; the append-only trigger is
    // what stops this happening in Postgres, and the digest is what catches it
    // if it ever does.
    const { result } = await mountHook();
    await act(async () => {
      await result.current.publishBaseline(publishInput(rowsFor(GAMES)));
    });
    await waitFor(() => expect(result.current.baselines).toHaveLength(1));
    const [summary] = result.current.baselines;

    // Through `window.__saveMockDB__`, the sanctioned producer, rather than
    // writing sessionStorage directly: `tests/mockDeleteTombstones.test.js`
    // keeps an exact registry of every write that goes past `saveDB`, and a
    // new bypass fails it. Bypassing the RPC is the point here; bypassing the
    // mock's own save is not.
    const db = JSON.parse(sessionStorage.getItem('__MOCK_DB__'));
    db.publication_baselines[0].export_rows[0].Field = 'somewhere-else';
    window.__saveMockDB__(db);

    const report = await result.current.compareWithBaseline(summary.id, rowsFor(GAMES));
    expect(report.readFindings.map((finding) => finding.code)).toContain(
      PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH
    );
  });
});

describe('publication baselines :: the naive stamp', () => {
  it('renders local wall-clock parts, never the UTC rendering toISOString gives', () => {
    // A publication at 20:00 on the 20th stamped from `toISOString()` in a
    // negative-offset zone would read as the 21st, and an operator would see a
    // date they did not publish on. The parts are local by construction.
    const at = new Date(2026, 8, 20, 20, 5, 9);
    expect(naivePublicationStamp(at)).toBe('2026-09-20T20:05:09');
    // And it satisfies the schema the store enforces, which is the only
    // property that matters to the round trip.
    expect(naivePublicationStamp(at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

/* ========================================================================== */
/* Contract: the mock against the migration                                    */
/* ========================================================================== */

/** Column names of `CREATE TABLE public.publication_baselines`, from the SQL. */
const tableColumns = () => {
  const body = MIGRATION.slice(
    MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS public.publication_baselines ('),
    MIGRATION.indexOf('CREATE INDEX IF NOT EXISTS idx_publication_baselines_org_version')
  );
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+ (uuid|text|integer|jsonb|timestamptz)\b/.test(line))
    .map((line) => line.split(' ')[0])
    .sort();
};

describe('publication baselines :: the mock and the migration as one contract', () => {
  it('parses a non-empty column set out of the migration', () => {
    // The meta-assertion. A parser that matched nothing would make the
    // comparison below pass by comparing two empty lists.
    const columns = tableColumns();
    expect(columns.length).toBeGreaterThanOrEqual(13);
    expect(columns).toContain('baseline_version');
    expect(columns).toContain('export_rows');
    expect(columns).toContain('recorded_by');
  });

  it('gives a mock baseline row every column the table declares', async () => {
    const { result } = await mountHook();
    await act(async () => {
      await result.current.publishBaseline(publishInput(rowsFor(GAMES)));
    });
    // Exact: a column the table has and the mock does not is a row shape the
    // database produces and the E2E suite never sees.
    expect(Object.keys(getMockData('publication_baselines')[0]).sort()).toEqual(tableColumns());
  });

  it('returns the row without its payload, exactly as the RPC does', async () => {
    const { result } = await mountHook();
    let returned = /** @type {any} */ (null);
    await act(async () => {
      returned = await result.current.publishBaseline(publishInput(rowsFor(GAMES)));
    });
    // The SQL's `RETURN jsonb_build_object(...)` omits both payload columns,
    // and so must the mock -- otherwise a caller could read the rows back from
    // the write result and the read path would never be exercised.
    expect(returned.export_rows).toBeUndefined();
    expect(returned.export_columns).toBeUndefined();
    expect(MIGRATION).toContain('-- The row **without** its payload.');
    expect(returned.baseline_version).toBe(1);
    expect(returned.row_count).toBe(rowsFor(GAMES).length);
  });

  it('refuses every document the SQL validator refuses, with the same reason', async () => {
    // **The refusals, not just the happy path.** A mock that accepted a
    // document Postgres refuses is how a defect reaches production through a
    // green E2E suite. The reason strings are compared against the MIGRATION
    // rather than against this file's own expectations.
    const good = {
      version: 1,
      snapshotId: 'contract-1',
      label: 'Contract',
      channel: 'test',
      publishedAt: '2026-04-10T18:00:00',
      publishedBy: 'actor-1',
      notes: null,
      columns: ['Start'],
      rows: [{ Start: '2026-04-11T09:00:00' }],
      digest: '0123456789abcdef',
    };

    // The acceptance first: a validator that refused everything would satisfy
    // every case below.
    const accepted = await mockSupabase.rpc('admin_publish_schedule_baseline', {
      p_organization_id: ORG,
      p_document: good,
    });
    expect(accepted.error).toBeNull();

    const cases = [
      ['not an object', 'nope', 'must be a JSON object'],
      ['an extra key', { ...good, extra: 1 }, 'strict'],
      ['a future version', { ...good, version: 2 }, 'version 1'],
      // The needle is the SHARED fragment: the SQL builds this message with
      // `format(%s must be a non-empty string, v_name)` so the field name is
      // not a literal in the migration, while the mock interpolates it. The
      // field-specific half is asserted separately below.
      ['an empty label', { ...good, label: '  ' }, 'must be a non-empty string'],
      ['a short digest', { ...good, digest: 'abc' }, 'lowercase hex'],
      ['an uppercase digest', { ...good, digest: '0123456789ABCDEF' }, 'lowercase hex'],
      ['a zoned publishedAt', { ...good, publishedAt: '2026-04-10T18:00:00Z' }, 'naive'],
      ['an empty notes', { ...good, notes: '' }, 'notes must be null'],
      ['no rows', { ...good, rows: [] }, 'non-empty array'],
      ['a duplicate column', { ...good, columns: ['Start', 'Start'] }, 'duplicate'],
      ['a row missing a column', { ...good, columns: ['Start', 'Field'] }, 'declares columns'],
      ['a non-string cell', { ...good, rows: [{ Start: 3 }] }, 'non-string cell'],
    ];

    let refused = 0;
    for (const [what, document, needle] of cases) {
      const { data, error } = await mockSupabase.rpc('admin_publish_schedule_baseline', {
        p_organization_id: ORG,
        // A fresh id, so a refusal is never the uniqueness constraint wearing
        // the validator's clothes.
        p_document:
          typeof document === 'object' && document !== null
            ? { ...document, snapshotId: `contract-${what}` }
            : document,
      });
      expect(data, `the mock accepted a document with ${what}`).toBeNull();
      expect(error.message, `the mock refused "${what}" for the wrong reason`).toContain(needle);
      // **And the SQL says the same thing.** This is what keeps the two arms
      // from drifting: each needle has to appear in the migration too.
      expect(MIGRATION, `the migration never says "${needle}"`).toContain(needle);
      refused += 1;
    }
    // A loop over an empty list asserts nothing.
    expect(refused).toBe(cases.length);

    // …and the shared fragment above is not the mock being vague: it names
    // the field, exactly as the SQL does at runtime.
    const vague = await mockSupabase.rpc('admin_publish_schedule_baseline', {
      p_organization_id: ORG,
      p_document: { ...good, snapshotId: 'contract-named-field', label: '  ' },
    });
    expect(vague.error.message).toContain('label must be a non-empty string');
  });

  it('registers the audit action the RPC writes, in the migration', () => {
    // An unregistered action does not fail the migration; it fails the first
    // publication, at runtime, on the audit FK (LESSONS_LEARNED #5).
    expect(MIGRATION).toContain('INSERT INTO public.audit_actions (action)');
    expect(MIGRATION).toContain("'publication.baseline_recorded'");
  });

  it('keeps the table write-policy-free, with the RPC as the only writer', () => {
    // Read off the migration, because "writes go only through the RPC" is a
    // claim about the SQL and not about the hook.
    expect(MIGRATION).toContain(
      'ALTER TABLE public.publication_baselines ENABLE ROW LEVEL SECURITY'
    );
    expect(MIGRATION).toContain('FOR SELECT');
    for (const forbidden of ['FOR INSERT', 'FOR UPDATE', 'FOR DELETE', 'FOR ALL']) {
      expect(MIGRATION, `the migration declares a ${forbidden} policy`).not.toContain(forbidden);
    }
    // Meta-assertion: the needle style matches something, so "no write policy"
    // is not being reported by a search that finds nothing either way.
    expect(MIGRATION).toContain('FOR SELECT');
    // And the hook never writes the table directly.
    expect(HOOK_SOURCE).toContain("supabase.rpc('admin_publish_schedule_baseline'");
    for (const forbidden of ['.insert(', '.update(', '.delete(', '.upsert(']) {
      expect(HOOK_SOURCE, `the hook calls ${forbidden} on the table`).not.toContain(forbidden);
    }
  });

  it('keeps anon off both functions, explicitly', () => {
    // `docs/sql/20260920000000_smoke.sql` proves this against a live
    // catalogue; this is the static half, and it exists because the smoke that
    // caught an anon-callable definer function had never run until the harness
    // was fixed.
    for (const fn of [
      'public.admin_publish_schedule_baseline(uuid, jsonb)',
      'public.publication_baseline_document_problem(jsonb)',
    ]) {
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
      expect(MIGRATION).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM anon;`);
      expect(MIGRATION).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO authenticated;`);
    }
  });
});
