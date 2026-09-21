/**
 * The stored baseline asked its question — `packages/core/src/publication/baseline.js`.
 *
 * GAP-29 Stage 4. The store exists (`20260920000000_publication_baselines.sql`)
 * and the writer is on the publish path; this is the file that proves the
 * reader **answers a real question with it** rather than being a store nobody
 * consults.
 *
 * Every number below is derived from a schedule built here and then *changed*,
 * never typed in, and every assertion has the break that makes it fail
 * constructed beside it:
 *
 * - the round trip is driven end to end — export, snapshot, serialise, read,
 *   compare — and then driven again against a schedule with one kickoff moved,
 *   one fixture deleted and one added, so `matched`, `differing`, `removed`
 *   and `added` are each non-zero and each traceable to the edit that caused
 *   it. A comparator that reported everything as matched would fail three
 *   assertions and a comparator that reported everything as differing would
 *   fail the fourth;
 * - the key is proved **necessary**: the same comparison run under
 *   `DEFAULT_PARITY_KEY_FIELDS` is shown collapsing into
 *   `PARITY_KEY_AMBIGUOUS`, which is what a per-team artifact does without
 *   `participant`;
 * - the coverage finding is handed a column list that makes it fire and one
 *   that does not;
 * - `BASELINE_READ_EXPORT_HEADERS` is checked against `rows.js`'s own source,
 *   so the "these columns are uncovered" claim cannot drift into overclaiming;
 * - and `baseline.js` is enumerated for a second comparator, because
 *   `publication/index.js` says `compareParityRows()` is the only one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  BASELINE_COMPARED_FIELDS,
  BASELINE_KEY_FIELDS,
  BASELINE_READ_EXPORT_HEADERS,
  BASELINE_UNREAD_EXPORT_COLUMNS,
  DEFAULT_PARITY_KEY_FIELDS,
  PARITY_FIELD,
  PUBLICATION_REASON,
  PUBLICATION_SEVERITY,
  PUBLICATION_STATUS,
  baselineDriftSummary,
  baselineParityCoverageFindings,
  baselineParityIsBlocking,
  baselineParitySoundness,
  checkBaselineParity,
  checkParity,
  derivePublicationStatus,
  makePublicationSnapshot,
  parityRowsFromExportRows,
  readPublicationSnapshot,
  serialisePublicationSnapshot,
} from '@squadlogic/core/publication/index.js';
import {
  SCHEDULE_EXPORT_COLUMNS,
  SCHEDULE_EXPORT_HEADERS,
  generateScheduleExports,
} from '@squadlogic/core/outputGeneration.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codesOf = (findings) => findings.map((finding) => finding.code);

/* -------------------------------------------------------------------------- */
/* A small season, and the edits made to it                                    */
/* -------------------------------------------------------------------------- */

const TEAMS = [
  { id: 't-1', name: 'Blue Bears', division: 'U10' },
  { id: 't-2', name: 'Red Foxes', division: 'U10' },
  { id: 't-3', name: 'Green Owls', division: 'U12' },
  { id: 't-4', name: 'Grey Wolves', division: 'U12' },
];

/** Games as `generateScheduleExports()` takes them. */
const PUBLISHED_GAMES = [
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
  {
    homeTeamId: 't-1',
    awayTeamId: 't-3',
    start: '2026-04-18T09:00:00Z',
    end: '2026-04-18T10:00:00Z',
    fieldId: 'pitch-1',
    slotId: 's-3',
  },
];

/**
 * The same season with three deliberate edits, each of which must land in a
 * different bucket:
 *
 * | edit | expected bucket |
 * | --- | --- |
 * | game 1 kicks off 30 minutes later, on other ground | `differing` (2 rows) |
 * | game 2 is gone | `removed` (2 rows) |
 * | a new game on 04/25 | `added` (2 rows) |
 *
 * Two rows each, because an export artifact is per team. Three *different*
 * cardinalities would be better still, and the bucket sizes are therefore not
 * the only thing asserted: every bucket's contents are traced back to the
 * teams and dates the edit touched.
 */
const CHANGED_GAMES = [
  {
    homeTeamId: 't-1',
    awayTeamId: 't-2',
    start: '2026-04-11T09:30:00Z',
    end: '2026-04-11T10:30:00Z',
    fieldId: 'pitch-3',
    slotId: 's-1',
  },
  {
    homeTeamId: 't-1',
    awayTeamId: 't-3',
    start: '2026-04-18T09:00:00Z',
    end: '2026-04-18T10:00:00Z',
    fieldId: 'pitch-1',
    slotId: 's-3',
  },
  {
    homeTeamId: 't-2',
    awayTeamId: 't-4',
    start: '2026-04-25T09:00:00Z',
    end: '2026-04-25T10:00:00Z',
    fieldId: 'pitch-2',
    slotId: 's-4',
  },
];

/**
 * The export as the Exports panel produces it: **no `timezone` argument**, so
 * `Start` is `toISOString()`.
 *
 * The first draft of this file passed `timezone: 'UTC'` and every assertion
 * about a moved kickoff failed, because that argument makes
 * `generateScheduleExports()` render `Start` with `toLocaleString('en-US')` --
 * `4/11/2026, 9:00:00 AM` -- which no parity adapter can read. That is a real
 * third spelling of the cell and it has its own test below rather than being
 * tidied away.
 */
const exportFor = (games) => generateScheduleExports({ teams: TEAMS, gameAssignments: games });

const SNAPSHOT_INPUT = Object.freeze({
  snapshotId: 'baseline-week-1',
  label: 'Master schedule',
  channel: 'exports bucket',
  publishedAt: '2026-04-10T18:00:00',
  publishedBy: 'actor-1',
});

/** Export -> snapshot -> document -> read back: the whole store round trip. */
function storedSnapshot(games = PUBLISHED_GAMES) {
  const { snapshot } = makePublicationSnapshot({
    ...SNAPSHOT_INPUT,
    rows: exportFor(games).master.rows,
  });
  // Through the seam and back, exactly as the hook does through the RPC. The
  // JSON round trip is what a jsonb column does to a document.
  const document = JSON.parse(JSON.stringify(serialisePublicationSnapshot(snapshot)));
  return readPublicationSnapshot(document);
}

/* -------------------------------------------------------------------------- */

describe('publication baseline :: the round trip, and the question at the end of it', () => {
  it('reports an unchanged schedule as matching, with nothing in the other three buckets', () => {
    const { snapshot, findings } = storedSnapshot();
    // The read is clean: no digest mismatch survived the document round trip.
    expect(codesOf(findings)).not.toContain(PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH);

    const currentRows = exportFor(PUBLISHED_GAMES).master.rows;
    const parity = checkBaselineParity({ snapshot, currentRows });
    const drift = baselineDriftSummary(parity);

    // Derived from the corpus, not typed in: 3 games, 2 rows each.
    expect(currentRows).toHaveLength(PUBLISHED_GAMES.length * 2);
    expect(drift.matched).toBe(currentRows.length);
    expect(drift).toMatchObject({ drifted: false, differing: 0, removed: 0, added: 0 });
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_VACUOUS);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_KEY_AMBIGUOUS);
  });

  it('reports the moved, the vanished and the new, each in its own bucket', () => {
    const { snapshot } = storedSnapshot();
    const parity = checkBaselineParity({
      snapshot,
      currentRows: exportFor(CHANGED_GAMES).master.rows,
    });
    const drift = baselineDriftSummary(parity);

    expect(drift.drifted).toBe(true);
    // One game moved: both of its rows differ, and on both the fields that
    // moved. **The changed fields are asserted, not just the count** -- a
    // comparator reporting a difference for the wrong reason would pass a
    // count-only check.
    expect(drift.differing).toBe(2);
    for (const pair of parity.buckets.differing) {
      expect([...pair.changedFields].sort()).toEqual(
        [PARITY_FIELD.START_MINUTES, PARITY_FIELD.FIELD].sort()
      );
    }
    // The two differing rows are the two halves of game 1, told apart by
    // `participant`, which is what the key exists for.
    expect(parity.buckets.differing.map((pair) => pair.currentRow.participant).sort()).toEqual([
      't-1',
      't-2',
    ]);

    // The vanished game: reported as removed, and **named**, because incident
    // 1 is a count that said "366" long after the damage.
    expect(drift.removed).toBe(2);
    expect(parity.buckets.removed.map((orphan) => orphan.row.participant).sort()).toEqual([
      't-3',
      't-4',
    ]);
    expect(parity.buckets.removed.every((orphan) => orphan.row.date === '2026-04-11')).toBe(true);
    expect(codesOf(parity.findings)).toContain(PUBLICATION_REASON.PARITY_ROW_REMOVED);

    // The new game: an addition, which is news rather than drift, so it does
    // not count toward `drifted`.
    expect(drift.added).toBe(2);
    expect(codesOf(parity.findings)).toContain(PUBLICATION_REASON.PARITY_ROW_ADDED);

    // The untouched game still matches, so the report is not simply reporting
    // everything as changed.
    expect(drift.matched).toBe(2);
    expect(drift.matched + drift.differing + drift.removed + drift.added).toBe(
      parity.meta.rowsCompared
    );
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE);

    // A removed row is `blocking`: a game families were told about and that is
    // now gone is somebody's Saturday.
    expect(baselineParityIsBlocking(parity)).toBe(true);
  });

  it('does not call a new fixture drift, which is the false alarm the buckets exist to avoid', () => {
    // **The case a bare `differing + removed + added` would get wrong**, and
    // it is here because the falsification pass found nothing that could
    // catch it: every other run in this file has a real difference alongside
    // its additions, so `drifted` was true for the wrong reason as easily as
    // the right one. The corpus's own version of this is the 112-row Select
    // layer -- reporting it as drift is a 112-row false alarm on a schedule
    // that is perfectly faithful.
    const { snapshot } = storedSnapshot();
    const withExtra = [
      ...PUBLISHED_GAMES,
      {
        homeTeamId: 't-2',
        awayTeamId: 't-4',
        start: '2026-04-25T09:00:00Z',
        end: '2026-04-25T10:00:00Z',
        fieldId: 'pitch-2',
        slotId: 's-9',
      },
    ];
    const parity = checkBaselineParity({
      snapshot,
      currentRows: exportFor(withExtra).master.rows,
    });
    const drift = baselineDriftSummary(parity);

    expect(drift.added).toBe(2);
    expect(drift.differing).toBe(0);
    expect(drift.removed).toBe(0);
    // The whole point: additions are news, and news is not drift.
    expect(drift.drifted).toBe(false);
    // And they are still reported, so "not drift" is not "not mentioned".
    expect(codesOf(parity.findings)).toContain(PUBLICATION_REASON.PARITY_ROW_ADDED);
  });

  it('carries the read s digest mismatch into the report rather than comparing against a lie', () => {
    // A row edited in the store: the digest no longer describes the rows.
    const { snapshot } = storedSnapshot();
    const document = serialisePublicationSnapshot(snapshot);
    const tampered = {
      ...document,
      rows: document.rows.map((row, index) =>
        index === 0 ? { ...row, [SCHEDULE_EXPORT_HEADERS.FIELD]: 'pitch-99' } : row
      ),
    };
    const readBack = readPublicationSnapshot(tampered);
    expect(codesOf(readBack.findings)).toContain(PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH);

    // And the comparison against it is still runnable -- which is precisely
    // why the read's findings have to travel with it. The parity run alone
    // looks like one ordinary difference.
    const parity = checkBaselineParity({
      snapshot: readBack.snapshot,
      currentRows: exportFor(PUBLISHED_GAMES).master.rows,
    });
    expect(baselineDriftSummary(parity).differing).toBe(1);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH);
  });
});

describe('publication baseline :: the status is derived from the findings it ships', () => {
  it('re-derives status after the baseline findings are merged, rather than carrying checkParity s', () => {
    // **A `/code-review` finding, and it affected every single run.**
    // `checkParity()` derives `status` mechanically from *its* findings;
    // `checkBaselineParity()` then appends the coverage finding (always) and
    // the vocabulary finding (sometimes). Spreading the old status over the
    // new findings produced a result that contradicted itself: `allowed`
    // while carrying a `compromise`.
    const { snapshot } = storedSnapshot();
    const clean = checkBaselineParity({
      snapshot,
      currentRows: exportFor(PUBLISHED_GAMES).master.rows,
    });
    expect(clean.findings.some((f) => f.severity === PUBLICATION_SEVERITY.COMPROMISE)).toBe(true);
    expect(clean.status).toBe(derivePublicationStatus(clean.findings));
    expect(clean.status).not.toBe(PUBLICATION_STATUS.ALLOWED);

    // And a blocking finding added by this module, not by `checkParity()`,
    // reaches the status too — the vocabulary refusal is the only finding
    // separating these two runs.
    const wallRows = exportFor(PUBLISHED_GAMES).master.rows.map((row) => ({
      ...row,
      [SCHEDULE_EXPORT_HEADERS.START]: String(row[SCHEDULE_EXPORT_HEADERS.START]).replace(
        /\.\d+Z$/,
        ''
      ),
    }));
    const mixed = checkBaselineParity({ snapshot, currentRows: wallRows });
    expect(mixed.status).toBe(derivePublicationStatus(mixed.findings));
    expect(mixed.status).toBe(PUBLICATION_STATUS.REJECTED);
  });
});

describe('publication baseline :: soundness is not severity', () => {
  it('calls a moved game a verdict and an unreadable kickoff an unsound run', () => {
    // **The distinction a `/code-review` fix got wrong on its first attempt,
    // pinned so it cannot be re-tightened.** `PARITY_ROW_DIFFERS` and
    // `PARITY_ROW_REMOVED` are `blocking` *because they are the answer*, so a
    // gate on "any blocking finding" makes the reader refuse to state the
    // result it exists for. Soundness is about whether the comparison could
    // be performed at all.
    const { snapshot } = storedSnapshot();

    const moved = checkBaselineParity({
      snapshot,
      currentRows: exportFor(CHANGED_GAMES).master.rows,
    });
    // It IS blocking...
    expect(baselineParityIsBlocking(moved)).toBe(true);
    // ...and it IS sound. Both at once, which is the whole point.
    expect(baselineParitySoundness(moved)).toEqual({ sound: true, reasons: [] });

    // The unreadable run: same module, same call, not sound, and it names why.
    const localised = generateScheduleExports({
      teams: TEAMS,
      gameAssignments: PUBLISHED_GAMES,
      timezone: 'UTC',
    }).master.rows;
    const blind = checkBaselineParity({
      snapshot: makePublicationSnapshot({ ...SNAPSHOT_INPUT, rows: localised }).snapshot,
      currentRows: localised,
    });
    const soundness = baselineParitySoundness(blind);
    expect(soundness.sound).toBe(false);
    expect(soundness.reasons).toContain(PUBLICATION_REASON.PARITY_FIELD_ABSENT);
  });

  it('folds in the read s own findings, because a digest mismatch is not a parity finding', () => {
    // A baseline whose stored rows were edited reads back with
    // `SNAPSHOT_DIGEST_MISMATCH`, and that finding lives on the *read*, not on
    // the comparison. A surface consulting only the parity result would
    // compare confidently against corrupted ground truth.
    const { snapshot } = storedSnapshot();
    const document = serialisePublicationSnapshot(snapshot);
    const tampered = {
      ...document,
      rows: document.rows.map((row, index) =>
        index === 0 ? { ...row, [SCHEDULE_EXPORT_HEADERS.FIELD]: 'pitch-99' } : row
      ),
    };
    const readBack = readPublicationSnapshot(tampered);
    const parity = checkBaselineParity({
      snapshot: readBack.snapshot,
      currentRows: exportFor(PUBLISHED_GAMES).master.rows,
    });

    // Without the read's findings it looks sound; with them it does not.
    expect(baselineParitySoundness(parity).sound).toBe(true);
    const withRead = baselineParitySoundness(parity, readBack.findings);
    expect(withRead.sound).toBe(false);
    expect(withRead.reasons).toEqual([PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH]);
  });
});

describe('publication baseline :: the key, and why it is not the default one', () => {
  it('collapses into ambiguity under the default key, which is the failure participant prevents', () => {
    // **The constructed break.** This is the same comparison the module makes,
    // run with `participant` taken out of the key -- the shape a caller who
    // reached for `DEFAULT_PARITY_KEY_FIELDS` would get. Both halves of every
    // fixture share one identity and nothing can be compared.
    const { snapshot } = storedSnapshot();
    const label = 'both halves under one identity';
    const collapsed = checkParity({
      subject: label,
      published: {
        label,
        rows: parityRowsFromExportRows(snapshot.rows, { sourceLabel: label }),
      },
      current: {
        label,
        rows: parityRowsFromExportRows(exportFor(PUBLISHED_GAMES).master.rows, {
          sourceLabel: label,
        }),
      },
      keyFields: DEFAULT_PARITY_KEY_FIELDS,
      comparedFields: BASELINE_COMPARED_FIELDS,
      mappingRules: [],
    });
    // One ambiguity per fixture, each naming two published rows against two
    // current rows: the home half and the away half wearing one identity.
    const ambiguities = collapsed.findings.filter(
      (finding) => finding.code === PUBLICATION_REASON.PARITY_KEY_AMBIGUOUS
    );
    expect(ambiguities).toHaveLength(PUBLISHED_GAMES.length);
    for (const finding of ambiguities) {
      expect(finding.details.publishedCount).toBe(2);
      expect(finding.details.currentCount).toBe(2);
    }

    // The module's own key, on the same rows, does not.
    const sound = checkBaselineParity({
      snapshot,
      currentRows: exportFor(PUBLISHED_GAMES).master.rows,
    });
    expect(codesOf(sound.findings)).not.toContain(PUBLICATION_REASON.PARITY_KEY_AMBIGUOUS);
    expect(sound.buckets.matched.length).toBeGreaterThan(0);

    expect(BASELINE_KEY_FIELDS).toEqual([...DEFAULT_PARITY_KEY_FIELDS, PARITY_FIELD.PARTICIPANT]);
  });
});

describe('publication baseline :: the coverage claim, made falsifiable', () => {
  it('names the export columns the parity vocabulary does not model, and stays quiet when there are none', () => {
    const firing = baselineParityCoverageFindings(SCHEDULE_EXPORT_COLUMNS, 'a subject');
    expect(firing).toHaveLength(1);
    expect(firing[0].code).toBe(PUBLICATION_REASON.PARITY_FIELD_UNCOMPARED);
    expect(firing[0].severity).toBe(PUBLICATION_SEVERITY.COMPROMISE);
    for (const column of BASELINE_UNREAD_EXPORT_COLUMNS) {
      expect(firing[0].message).toContain(column);
    }
    // The coach columns are the ones this matters most for: a parity run that
    // said nothing about them while looking authoritative is the silence.
    expect(BASELINE_UNREAD_EXPORT_COLUMNS).toContain(SCHEDULE_EXPORT_HEADERS.COACHES);
    expect(BASELINE_UNREAD_EXPORT_COLUMNS).toContain(SCHEDULE_EXPORT_HEADERS.NOTES);

    // **The case that makes it NOT fire**, so the finding is a report rather
    // than an unconditional line of text: a snapshot declaring only columns
    // the comparison actually reads has nothing to disclose.
    expect(baselineParityCoverageFindings([...BASELINE_READ_EXPORT_HEADERS], 'a subject')).toEqual(
      []
    );
  });

  it('fires on every real run, because the export vocabulary always carries unread columns', () => {
    const { snapshot } = storedSnapshot();
    const parity = checkBaselineParity({
      snapshot,
      currentRows: exportFor(PUBLISHED_GAMES).master.rows,
    });
    expect(codesOf(parity.findings)).toContain(PUBLICATION_REASON.PARITY_FIELD_UNCOMPARED);
  });

  it('keeps BASELINE_READ_EXPORT_HEADERS honest against the adapter that does the reading', () => {
    // **Never derive the subject set from the thing a break would corrupt.**
    // The claim "these columns are uncovered" is only true if the covered list
    // really is what `parityRowFromExportRow()` reads, so the covered list is
    // enumerated from `rows.js`'s source rather than from this constant.
    const rowsSource = readFileSync(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'publication', 'rows.js'),
      'utf8'
    );
    const named = new Set(
      [...rowsSource.matchAll(/SCHEDULE_EXPORT_HEADERS\.([A-Z_]+)/g)].map((match) => match[1])
    );
    // Meta-assertion: the pattern matches something, so a renamed constant
    // cannot make the comparison below pass against an empty set.
    expect(named.size).toBeGreaterThan(0);

    const readByName = new Set(
      [...named].map((member) => SCHEDULE_EXPORT_HEADERS[member]).filter(Boolean)
    );
    expect([...readByName].sort()).toEqual([...BASELINE_READ_EXPORT_HEADERS].sort());
  });
});

describe('publication baseline :: the Start cell, in three spellings', () => {
  it('sees a moved kickoff at all, which it could not before the instant was re-spelled', () => {
    // **The regression this exists to hold.** `parityRowFromExportRow()` reads
    // a naive wall reading; `generateScheduleExports()` writes an instant.
    // Before `checkBaselineParity()` re-spelled it, `startMinutes` was null on
    // both sides of every pair and a game that moved by half an hour reported
    // as differing in `field` alone.
    const { snapshot } = storedSnapshot();
    const parity = checkBaselineParity({
      snapshot,
      currentRows: exportFor(CHANGED_GAMES).master.rows,
    });
    expect(
      parity.buckets.differing.every((pair) =>
        pair.changedFields.includes(PARITY_FIELD.START_MINUTES)
      )
    ).toBe(true);
    // And the cells really were instants, so the re-spelling was exercised
    // rather than skipped over rows that were already readable.
    expect(snapshot.rows.every((row) => /Z$/.test(row[SCHEDULE_EXPORT_HEADERS.START]))).toBe(true);
  });

  it('refuses to compare a wall reading against an instant, rather than agreeing they match', () => {
    // 09:00:00 and 09:00:00Z are not the same moment. A run that let them
    // match would report parity on a schedule displaced by the offset, which
    // is GAP-30 arriving through a CSV cell instead of through a schema.
    const { snapshot } = storedSnapshot();
    const wallRows = exportFor(PUBLISHED_GAMES).master.rows.map((row) => ({
      ...row,
      [SCHEDULE_EXPORT_HEADERS.START]: String(row[SCHEDULE_EXPORT_HEADERS.START]).replace(
        /\.\d+Z$/,
        ''
      ),
    }));
    const mixed = checkBaselineParity({ snapshot, currentRows: wallRows });
    const absent = mixed.findings.filter(
      (finding) => finding.code === PUBLICATION_REASON.PARITY_FIELD_ABSENT
    );
    expect(absent.length).toBeGreaterThan(0);
    expect(absent.some((finding) => finding.message.includes('not the same moment'))).toBe(true);
    expect(baselineParityIsBlocking(mixed)).toBe(true);
    // Nothing was matched on time: the published side stayed unreadable.
    expect(mixed.buckets.matched.every((pair) => pair.publishedRow.startMinutes === null)).toBe(
      true
    );
  });

  it('leaves a toLocaleString Start unreadable and says so, rather than guessing', () => {
    // The third spelling, produced by `generateScheduleExports({ timezone })`.
    // Nothing here parses `4/11/2026, 9:00:00 AM`, and inventing a parser for
    // a locale-formatted string is how a comparison starts guessing.
    const localised = generateScheduleExports({
      teams: TEAMS,
      gameAssignments: PUBLISHED_GAMES,
      timezone: 'UTC',
    }).master.rows;
    expect(localised.every((row) => /AM|PM/.test(row[SCHEDULE_EXPORT_HEADERS.START]))).toBe(true);

    const { snapshot } = makePublicationSnapshot({ ...SNAPSHOT_INPUT, rows: localised });
    const parity = checkBaselineParity({ snapshot, currentRows: localised });
    expect(codesOf(parity.findings)).toContain(PUBLICATION_REASON.PARITY_FIELD_ABSENT);
    expect(baselineParityIsBlocking(parity)).toBe(true);
  });
});

describe('publication baseline :: no second comparator', () => {
  it('leaves compareParityRows the only row comparator, as the barrel claims', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'publication', 'baseline.js'),
      'utf8'
    );
    // **Comments stripped first.** The first version of this check searched
    // the raw file and went red on the module's own prose, which names
    // `compareParityRows()` in the sentence explaining that it does not call
    // it. That is the third time in this change a source scan read a
    // documentation mention as a call, so the stripping is done rather than
    // the needle loosened.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Meta-assertion: the stripping left code behind. A regex that ate the
    // whole file would make every `not.toContain` below pass trivially.
    expect(code).toContain('export function checkBaselineParity');
    expect(code).toContain('checkParity({');

    // The comparator vocabulary: the entry point, the key derivation and the
    // per-pair field diff. Each needle is first shown matching in
    // `parity.js`, so a needle that could never match cannot be counted as a
    // clean result. `for (const ` is deliberately NOT among them --
    // `startVocabulary()` loops over rows to count which spelling their
    // `Start` cells use, which is a census rather than a comparison, and a
    // needle that cannot tell those apart would forbid the wrong thing.
    const parity = readFileSync(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'publication', 'parity.js'),
      'utf8'
    );
    for (const needle of ['compareParityRows(', 'parityRowKey(', 'changedFields']) {
      expect(parity, `the needle "${needle}" matches nothing even in parity.js`).toContain(needle);
      expect(code, `baseline.js contains "${needle}"`).not.toContain(needle);
    }
  });
});
