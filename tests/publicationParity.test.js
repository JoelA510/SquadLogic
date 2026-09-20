/**
 * Publication snapshots, parity, change notices and the downstream sync
 * registry — `packages/core/src/publication/`.
 *
 * The acceptance test the build plan asks for is here (`567/567 rec games
 * match, the 11v11 layer reports as additions`), and so is the reason it is not
 * on its own: **the 567 rec rows are byte-identical across all eight columns**
 * between `published_rec_schedule.csv` and `combined_schedule.csv`, so an empty
 * mapping table passes it. Every parity number below is derived from the corpus
 * rather than typed in, and every check that could pass for the wrong reason
 * has the case that makes it fail constructed next to it:
 *
 * - the mapping table gets a **second subject** where the labels genuinely
 *   differ, plus a negative control that runs it with the rules removed;
 * - a declared rule that matches nothing is proved to fire at `blocking`, using
 *   the build plan's own invented `Brookside Field 1` example, which appears
 *   nowhere in the corpus;
 * - the partition check is handed a partition with a row dropped and one with a
 *   row counted twice;
 * - the notice builder is proved to name a team **whose games all vanished**,
 *   which is the team a builder that grouped from the changed rows would leave
 *   with no notice at all.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  DESTINATION_STATE,
  MappingRuleSchema,
  NOTICE_CHANGE_KIND,
  PARITY_FIELD,
  PARITY_FIELD_ORDER,
  PUBLICATION_DURABILITY,
  PUBLICATION_REASON,
  PUBLICATION_REASON_SEVERITY,
  PUBLICATION_SEVERITY,
  PUBLICATION_STATUS,
  PublicationSnapshotInputSchema,
  SYNC_DESTINATION_KIND,
  SyncDestinationSchema,
  buildChangeNotices,
  buildSyncRegistryReport,
  checkParity,
  createPublicationMeta,
  compareParityRows,
  makeParityRow,
  makePublicationSnapshot,
  mergePublicationMeta,
  parityPartitionFindings,
  parityRowFromExportRow,
  parityRowKey,
  parityRowsFromExportRows,
  PUBLICATION_SNAPSHOT_DOCUMENT_VERSION,
  PublicationSnapshotDocumentSchema,
  publicationDigest,
  readPublicationSnapshot,
  season2026ExternalParityInput,
  season2026ExternalVenueMapping,
  season2026ParityRows,
  season2026PublishedParityInput,
  serialisePublicationSnapshot,
  snapshotRowsFromPublication,
  splitNaiveDateTime,
  verifySnapshotDigest,
} from '@squadlogic/core/publication/index.js';
import {
  SCHEDULE_EXPORT_COLUMNS,
  SCHEDULE_EXPORT_HEADERS,
  generateScheduleExports,
} from '@squadlogic/core/outputGeneration.js';
import {
  makeReservedSlot,
  makeUnplacedFixture,
  publicationRowsFor,
  FIXTURE_SIDE,
  RESERVE_KIND,
} from '@squadlogic/core/reserve/index.js';
import { loadSeason2026, SEASON_2026_ROW_KIND } from '@squadlogic/core/fixtures/index.js';

/** The corpus is loaded once; every test reads from this immutable snapshot. */
const season = loadSeason2026();

/** Every code this module emits, by severity, for the finding assertions. */
const codesOf = (findings) => findings.map((finding) => finding.code);
const findingsWith = (findings, code) => findings.filter((finding) => finding.code === code);

/** A stamp the caller supplies; nothing in the package reads a clock. */
const PUBLISHED_AT = '2026-08-01T09:15:00';

/**
 * The eight columns the corpus's two schedule CSVs are written in.
 *
 * `participant` is the ninth parity field and belongs to per-team artifacts;
 * no row either CSV produces carries one.
 */
const SCHEDULE_PARITY_FIELDS = PARITY_FIELD_ORDER.filter(
  (field) => field !== PARITY_FIELD.PARTICIPANT
);

/* ========================================================================== */
/* Snapshots                                                                   */
/* ========================================================================== */

describe('publication :: snapshots are immutable, stamped and attributed', () => {
  const rows = [
    { a: '1', b: 'x' },
    { a: '2', b: 'y' },
  ];
  const input = {
    snapshotId: 'pub-1',
    label: 'rec schedule v1',
    channel: 'club website + email to families',
    publishedAt: PUBLISHED_AT,
    publishedBy: 'registrar',
    columns: ['a', 'b'],
    rows,
  };

  it('freezes copies of the rows rather than references into them', () => {
    const source = rows.map((row) => ({ ...row }));
    const { snapshot, meta } = makePublicationSnapshot({ ...input, rows: source });

    expect(meta.snapshotsCreated).toBe(1);
    expect(meta.snapshotRowsFrozen).toBe(2);
    expect(snapshot.rowCount).toBe(2);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);

    // The thing that makes it a snapshot: mutating what it was built from does
    // not reach it. A "snapshot" sharing structure with the working schedule
    // would change when the schedule changed.
    source[0].a = 'edited';
    expect(snapshot.rows[0].a).toBe('1');
  });

  it('states its durability on the record, not only in the docs', () => {
    const { snapshot, findings, status } = makePublicationSnapshot(input);
    expect(snapshot.durability).toBe(PUBLICATION_DURABILITY.IN_MEMORY);
    expect(codesOf(findings)).toContain(PUBLICATION_REASON.SNAPSHOT_IN_MEMORY_ONLY);
    expect(status).toBe(PUBLICATION_STATUS.ALLOWED);
  });

  it('carries the audit trail of what, where, when and by whom', () => {
    const { snapshot, findings } = makePublicationSnapshot(input);
    expect(snapshot.label).toBe('rec schedule v1');
    expect(snapshot.channel).toBe('club website + email to families');
    expect(snapshot.publishedAt).toBe(PUBLISHED_AT);
    expect(snapshot.publishedBy).toBe('registrar');
    const created = findingsWith(findings, PUBLICATION_REASON.SNAPSHOT_CREATED)[0];
    expect(created.details.publishedBy).toBe('registrar');
    expect(created.details.channel).toBe('club website + email to families');
  });

  it('refuses a snapshot that stamps itself, publishes nothing, or breaks its own vocabulary', () => {
    // No default for either audit field: a self-stamped actor is the field that
    // reads as load-bearing and is not.
    const { publishedAt: _at, ...noStamp } = input;
    expect(PublicationSnapshotInputSchema.safeParse(noStamp).success).toBe(false);
    const { publishedBy: _by, ...noActor } = input;
    expect(PublicationSnapshotInputSchema.safeParse(noActor).success).toBe(false);
    // A stamp with a timezone offset is refused: GAP-30, and comparison here is
    // textual.
    expect(
      PublicationSnapshotInputSchema.safeParse({ ...input, publishedAt: '2026-08-01T09:15:00Z' })
        .success
    ).toBe(false);
    // A snapshot of nothing would satisfy every later parity check.
    expect(PublicationSnapshotInputSchema.safeParse({ ...input, rows: [] }).success).toBe(false);
    // A row that is not written in the declared vocabulary.
    expect(PublicationSnapshotInputSchema.safeParse({ ...input, rows: [{ a: '1' }] }).success).toBe(
      false
    );
    expect(
      PublicationSnapshotInputSchema.safeParse({ ...input, rows: [{ a: '1', b: 'x', c: '?' }] })
        .success
    ).toBe(false);
    // The schema is strict about its own keys too.
    expect(PublicationSnapshotInputSchema.safeParse({ ...input, surprise: 1 }).success).toBe(false);
  });

  it('detects a tampered snapshot, and the check is proved able to fail', () => {
    const { snapshot } = makePublicationSnapshot(input);
    expect(verifySnapshotDigest(snapshot)).toEqual([]);

    // The positive control: same stored digest, different rows.
    const tampered = {
      ...snapshot,
      rows: [
        { a: '1', b: 'x' },
        { a: '2', b: 'MOVED' },
      ],
    };
    const findings = verifySnapshotDigest(tampered);
    expect(codesOf(findings)).toEqual([PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH]);
    expect(findings[0].severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
  });

  it('digests cell contents in column order, not key insertion order', () => {
    const columns = ['a', 'b'];
    expect(publicationDigest(columns, [{ a: '1', b: '2' }])).toBe(
      publicationDigest(columns, [{ b: '2', a: '1' }])
    );
    expect(publicationDigest(columns, [{ a: '1', b: '2' }])).not.toBe(
      publicationDigest(columns, [{ a: '2', b: '1' }])
    );
  });
});

/* ========================================================================== */
/* The persistence seam                                                        */
/* ========================================================================== */

describe('publication :: the seam exists, and nothing stores through it', () => {
  /**
   * A snapshot in the shipping export vocabulary, built through the production
   * projection rather than from hand-written cells, so the round trip is
   * asserted over rows something actually emits.
   */
  const seamTeams = [
    { id: 'T1', name: 'Tigers', division: 'U10B', coachName: '', coachEmail: '' },
    { id: 'T2', name: 'Bears', division: 'U10B', coachName: '', coachEmail: '' },
  ];
  const seamProjection = publicationRowsFor({
    slots: [
      makeReservedSlot({
        id: 'slot-seam-1',
        kind: RESERVE_KIND.UNNAMED_FIXTURE,
        label: 'Select Game 1',
        date: '2026-09-12',
        venueId: 'venue:alder',
        surfaceId: 'surface:alder:pitch-2',
        startMinutes: 600,
        endMinutes: 720,
        format: '11v11',
        homeSide: FIXTURE_SIDE.TEAM,
        awaySide: FIXTURE_SIDE.TEAM,
        homeTeamId: 'T1',
        awayTeamId: 'T2',
      }),
    ],
    unplaced: [],
    teams: seamTeams,
  });
  const seamInput = {
    snapshotId: 'pub-seam-1',
    label: 'select layer v1',
    channel: 'public site',
    publishedAt: PUBLISHED_AT,
    publishedBy: 'registrar',
    rows: snapshotRowsFromPublication(seamProjection),
  };
  const seamSnapshot = (over = {}) => makePublicationSnapshot({ ...seamInput, ...over }).snapshot;

  it('round-trips a snapshot through the seam byte-identically', () => {
    const snapshot = seamSnapshot();
    expect(snapshot.columns).toEqual([...SCHEDULE_EXPORT_COLUMNS]);

    const document = serialisePublicationSnapshot(snapshot);
    const readBack = readPublicationSnapshot(document);
    const again = serialisePublicationSnapshot(readBack.snapshot);

    // Byte-identical, not deep-equal: a lossy transform can pass a deep-equal
    // and cannot pass this.
    expect(JSON.stringify(again)).toBe(JSON.stringify(document));
    expect(readBack.snapshot.rows).toEqual(snapshot.rows);
    expect(readBack.snapshot.digest).toBe(snapshot.digest);
    expect(readBack.snapshot.rowCount).toBe(snapshot.rowCount);
    // Durability is derived on read, never carried by the document: a stored
    // document cannot assert how durable the thing reading it is.
    expect(readBack.snapshot.durability).toBe(PUBLICATION_DURABILITY.IN_MEMORY);
    expect(document.durability).toBeUndefined();
    expect(readBack.status).toBe(PUBLICATION_STATUS.ALLOWED);
    // Counted rather than assumed: a round-trip assertion over a read that
    // never happened is the vacuous shape this file is full of controls for.
    expect(readBack.meta.snapshotsRead).toBe(1);
    expect(readBack.meta.snapshotRowsFrozen).toBe(snapshot.rowCount);
  });

  it('does not report a read as a publication event', () => {
    const readBack = readPublicationSnapshot(serialisePublicationSnapshot(seamSnapshot()));
    // `mergePublicationMeta()` folds every counter additively, so a Stage 2
    // caller loading N stored snapshots into one run would report N
    // publications that never happened - each with a finding naming who
    // published what, when and where. An audit trail synthesised from a disk
    // read is exactly what this package refuses elsewhere.
    expect(readBack.meta.snapshotsCreated).toBe(0);
    expect(codesOf(readBack.findings)).not.toContain(PUBLICATION_REASON.SNAPSHOT_CREATED);
    // The provenance that is still true on a read is still emitted.
    expect(codesOf(readBack.findings)).toContain(PUBLICATION_REASON.SNAPSHOT_IN_MEMORY_ONLY);
    // And the constructor, which really did publish, still says so.
    expect(codesOf(makePublicationSnapshot(seamInput).findings)).toContain(
      PUBLICATION_REASON.SNAPSHOT_CREATED
    );
    expect(makePublicationSnapshot(seamInput).meta.snapshotsCreated).toBe(1);
  });

  it('refuses to write a document it would refuse to read', () => {
    // `{ ...snapshot, rows }` is the idiom `verifySnapshotDigest()`'s own
    // docstring invites, and the schema cannot see it: the document would be
    // structurally perfect and carry a digest for rows that are not there, so
    // every read of it forever would blame the store.
    const snapshot = seamSnapshot();
    const edited = {
      ...snapshot,
      rows: snapshot.rows.map((row, index) =>
        index === 0 ? { ...row, [SCHEDULE_EXPORT_HEADERS.START]: '2026-09-12T11:30:00' } : row
      ),
    };
    expect(() => serialisePublicationSnapshot(edited)).toThrow(/could never be read back/);
    // The guard is content-only: an untouched snapshot still writes.
    expect(() => serialisePublicationSnapshot(snapshot)).not.toThrow();
  });

  it('writes cells in declared column order, so key insertion order cannot reach the document', () => {
    const forward = seamSnapshot();
    // The same rows with their keys inserted in the reverse order. Two
    // snapshots of one artifact; one document.
    const reversedKeys = seamInput.rows.map((row) => {
      /** @type {Record<string, string>} */
      const copy = {};
      for (const column of [...SCHEDULE_EXPORT_COLUMNS].reverse()) copy[column] = row[column];
      return copy;
    });
    const backward = seamSnapshot({ rows: reversedKeys });
    expect(Object.keys(reversedKeys[0])).not.toEqual(Object.keys(seamInput.rows[0]));
    expect(JSON.stringify(serialisePublicationSnapshot(backward))).toBe(
      JSON.stringify(serialisePublicationSnapshot(forward))
    );
  });

  it('carries no Date, no function and nothing exotic', () => {
    const document = serialisePublicationSnapshot(seamSnapshot());
    const walk = (value, at) => {
      if (value === null) return;
      const kind = typeof value;
      if (kind === 'string' || kind === 'number' || kind === 'boolean') return;
      expect(kind, `${at} is a ${kind}`).toBe('object');
      expect(value instanceof Date, `${at} is a Date`).toBe(false);
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${at}[${index}]`));
        return;
      }
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      for (const [key, entry] of Object.entries(value)) walk(entry, `${at}.${key}`);
    };
    walk(document, 'document');
    expect(() => PublicationSnapshotDocumentSchema.parse(document)).not.toThrow();
    expect(document.version).toBe(PUBLICATION_SNAPSHOT_DOCUMENT_VERSION);
  });

  it('carries a non-ASCII cell through unchanged', () => {
    // Nothing in the corpus exercises this, and a seam that normalised or
    // re-encoded a name would be silently rewriting what a family was told.
    const snapshot = seamSnapshot({
      snapshotId: 'pub-seam-ünïcode',
      label: 'Düsseldorf tour — v1',
      channel: 'e-mail (families) ✉',
      notes: 'renamed 対戦相手 after the league merge',
      rows: seamInput.rows.map((row) => ({
        ...row,
        [SCHEDULE_EXPORT_HEADERS.TEAM_NAME]: 'Tigres Ñandú',
        [SCHEDULE_EXPORT_HEADERS.NOTES]: 'kickoff moved — see 案内',
      })),
    });
    const readBack = readPublicationSnapshot(serialisePublicationSnapshot(snapshot));
    expect(readBack.snapshot.rows[0][SCHEDULE_EXPORT_HEADERS.TEAM_NAME]).toBe('Tigres Ñandú');
    expect(readBack.snapshot.rows[0][SCHEDULE_EXPORT_HEADERS.NOTES]).toBe(
      'kickoff moved — see 案内'
    );
    expect(readBack.snapshot.label).toBe('Düsseldorf tour — v1');
    expect(readBack.snapshot.notes).toBe('renamed 対戦相手 after the league merge');
    expect(readBack.snapshot.digest).toBe(snapshot.digest);
    expect(readBack.status).toBe(PUBLICATION_STATUS.ALLOWED);
  });

  it('refuses a document from another version, or one with a field added or removed', () => {
    const document = serialisePublicationSnapshot(seamSnapshot());
    // Each of these is the positive control for one schema clause; a seam
    // whose refusals are never fired is a schema nobody has read.
    expect(() => readPublicationSnapshot({ ...document, version: 2 })).toThrow();
    expect(() => readPublicationSnapshot({ ...document, extra: 1 })).toThrow();
    const { channel: _channel, ...noChannel } = document;
    expect(() => readPublicationSnapshot(noChannel)).toThrow();
    const { digest: _digest, ...noDigest } = document;
    expect(() => readPublicationSnapshot(noDigest)).toThrow();
    // A row that is no longer written in the document's own vocabulary.
    expect(() =>
      readPublicationSnapshot({
        ...document,
        rows: document.rows.map(({ [SCHEDULE_EXPORT_HEADERS.FIELD]: _drop, ...rest }) => rest),
      })
    ).toThrow();
    // And a digest that is not a digest at all.
    expect(() => readPublicationSnapshot({ ...document, digest: 'nope' })).toThrow();
  });

  it('reports an edited cell as a digest mismatch rather than agreeing with itself', () => {
    const document = serialisePublicationSnapshot(seamSnapshot());
    const tampered = {
      ...document,
      rows: document.rows.map((row, index) =>
        index === 0 ? { ...row, [SCHEDULE_EXPORT_HEADERS.START]: '2026-09-12T11:30:00' } : row
      ),
    };
    const readBack = readPublicationSnapshot(tampered);
    const mismatch = findingsWith(readBack.findings, PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH);
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(mismatch[0].details.stored).toBe(document.digest);
    expect(readBack.status).toBe(PUBLICATION_STATUS.REJECTED);
    // The snapshot handed back carries the digest of the rows that arrived, not
    // the claim that failed, so a caller cannot re-store the lie.
    expect(readBack.snapshot.digest).not.toBe(document.digest);
  });

  it('reports re-ordered rows as a mismatch, because the digest covers their order', () => {
    // The asymmetry with the two sibling seams, made visible rather than left
    // for a store to discover: a registry is a set and is sorted; a snapshot's
    // rows are positional and are not. `serialise.js`'s header says so.
    const snapshot = seamSnapshot();
    expect(snapshot.rowCount).toBeGreaterThan(1);
    const document = serialisePublicationSnapshot(snapshot);
    const reordered = { ...document, rows: [...document.rows].reverse() };
    const readBack = readPublicationSnapshot(reordered);
    expect(codesOf(readBack.findings)).toContain(PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH);
    expect(readBack.status).toBe(PUBLICATION_STATUS.REJECTED);
  });

  it('says on every snapshot that the seam exists and nothing stores through it', () => {
    const { findings } = makePublicationSnapshot(seamInput);
    const stated = findingsWith(findings, PUBLICATION_REASON.SNAPSHOT_IN_MEMORY_ONLY)[0];
    expect(stated).toBeDefined();
    expect(stated.severity).toBe(PUBLICATION_SEVERITY.INFO);
    // The message names the seam by both of its function names, and the two
    // assertions below hold that naming to the repository. A message naming a
    // seam nobody can find would be the decoration this change exists to avoid.
    expect(stated.message).toContain('serialisePublicationSnapshot()');
    expect(stated.message).toContain('readPublicationSnapshot()');
    expect(stated.message).toContain('nothing in this repository stores through it');
  });

  /* ---- the message's two halves, enumerated from the repository ---------- */

  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  /** Production roots only: tests and docs may name the seam freely. */
  const PRODUCTION_ROOTS = Object.freeze(['packages', 'frontend', 'supabase', 'scripts']);
  const SOURCE_EXTENSIONS = Object.freeze(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
  const SKIPPED = Object.freeze(['node_modules', 'dist', 'coverage', '.features-gen']);
  /**
   * The floor a healthy scan must clear. A walk that found nothing would make
   * both assertions below pass by looking at zero files.
   */
  const MIN_FILES_SCANNED = 200;
  /** The package the seam belongs to; every legitimate mention is inside it. */
  const SEAM_PACKAGE = 'packages/core/src/publication/';

  /** @type {Map<string, string>} */
  const productionSources = new Map();
  const collectSources = (absolute) => {
    for (const entry of readdirSync(absolute).sort()) {
      if (SKIPPED.includes(entry)) continue;
      const full = path.join(absolute, entry);
      if (statSync(full).isDirectory()) collectSources(full);
      else if (SOURCE_EXTENSIONS.includes(path.extname(entry))) {
        const relative = path.relative(REPO_ROOT, full).split(path.sep).join('/');
        productionSources.set(relative, readFileSync(full, 'utf8'));
      }
    }
  };
  for (const root of PRODUCTION_ROOTS) collectSources(path.join(REPO_ROOT, root));

  it('exports both halves of the seam from the package barrel', () => {
    const barrel = readFileSync(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'publication', 'index.js'),
      'utf8'
    );
    for (const name of ['serialisePublicationSnapshot', 'readPublicationSnapshot']) {
      expect(barrel, `${name} is not registered in the publication barrel`).toContain(name);
    }
    // And the names resolve through it, rather than only appearing in its text.
    expect(typeof serialisePublicationSnapshot).toBe('function');
    expect(typeof readPublicationSnapshot).toBe('function');
  });

  it('has no production caller anywhere, which is the half a store would falsify', () => {
    expect(productionSources.size).toBeGreaterThan(MIN_FILES_SCANNED);

    const mentions = [...productionSources]
      .filter(
        ([, source]) =>
          source.includes('serialisePublicationSnapshot') ||
          source.includes('readPublicationSnapshot')
      )
      .map(([file]) => file);
    // Meta-assertion: the pattern matches the seam's own file, so a renamed
    // function cannot make this check pass by matching nothing.
    expect(mentions).toContain(`${SEAM_PACKAGE}serialise.js`);
    for (const file of mentions) {
      expect(file.startsWith(SEAM_PACKAGE), `${file} names the publication seam`).toBe(true);
    }

    // The sharper half: only the barrel imports the seam module at all, so no
    // production path reaches it even under another name.
    const importers = [...productionSources]
      .filter(
        ([file, source]) =>
          file !== `${SEAM_PACKAGE}serialise.js` && /from\s+'[^']*serialise\.js'/.test(source)
      )
      .map(([file]) => file);
    expect(importers.filter((file) => file.startsWith(SEAM_PACKAGE))).toEqual([
      `${SEAM_PACKAGE}index.js`,
    ]);
    // `fieldAdmin/serialise.js` is a different module of the same name; its own
    // importers are not this seam's, and listing them here proves the regex is
    // matching real import lines rather than nothing.
    expect(importers.some((file) => file.startsWith('packages/core/src/fieldAdmin/'))).toBe(true);
  });
});

/* ========================================================================== */
/* Subject A — the acceptance test                                             */
/* ========================================================================== */

describe('publication :: parity subject A, the published rec schedule vs the workbook', () => {
  const parity = checkParity(
    season2026PublishedParityInput({
      publishedRecGames: season.recGames,
      combinedGames: season.combinedGames,
    })
  );

  it('matches 567/567 rec games and reports the 11v11 layer as additions', () => {
    expect(season.recGames).toHaveLength(567);
    expect(season.combinedGames).toHaveLength(679);

    expect(parity.buckets.matched).toHaveLength(567);
    expect(parity.buckets.differing).toEqual([]);
    expect(parity.buckets.removed).toEqual([]);
    // Additions, not differences. The whole point of the four buckets.
    expect(parity.buckets.added).toHaveLength(679 - 567);
    expect(parity.status).toBe(PUBLICATION_STATUS.ALLOWED);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_ROW_DIFFERS);
    const added = findingsWith(parity.findings, PUBLICATION_REASON.PARITY_ROW_ADDED)[0];
    expect(added.severity).toBe(PUBLICATION_SEVERITY.INFO);
    expect(added.details.count).toBe(112);
  });

  it('compares all eight published columns, and says how many cells it looked at', () => {
    // The meta-assertion: 567 pairs compared on zero fields would be 567
    // matches meaning nothing.
    expect(SCHEDULE_PARITY_FIELDS).toHaveLength(8);
    expect(parity.keyFields.length + parity.comparedFields.length).toBe(
      SCHEDULE_PARITY_FIELDS.length
    );
    expect(new Set([...parity.keyFields, ...parity.comparedFields])).toEqual(
      new Set(SCHEDULE_PARITY_FIELDS)
    );
    expect(parity.meta.fieldComparisons).toBe(567 * parity.comparedFields.length);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_FIELD_UNCOMPARED);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_FIELD_ABSENT);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_VACUOUS);
  });

  it('partitions every input row exactly once', () => {
    const { matched, differing, added, removed } = parity.buckets;
    expect(matched.length + differing.length + added.length + removed.length).toBe(
      parity.meta.rowsCompared
    );
    expect(matched.length + differing.length + removed.length).toBe(567);
    expect(matched.length + differing.length + added.length).toBe(679);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE);
  });

  it('says the mapping table was not exercised rather than implying it was', () => {
    // The trap: the rec rows are byte-identical across all eight columns, so an
    // empty mapping table passes the acceptance test above. The report must
    // therefore state the zero rather than let a reader assume a translation.
    expect(parity.mapping.declared).toBe(0);
    expect(parity.mapping.applied).toBe(0);
    expect(parity.meta.rowsRewritten).toBe(0);
    expect(codesOf(parity.findings)).toContain(PUBLICATION_REASON.MAPPING_NOT_EXERCISED);
  });

  it('accounts for the additions as the Select layer, from the row kinds', () => {
    const addedIds = new Set(parity.buckets.added.map((orphan) => orphan.row.rowId));
    const addedGames = season.combinedGames.filter((game) => addedIds.has(game.id));
    expect(addedGames).toHaveLength(112);
    const kinds = new Set(addedGames.map((game) => game.kind));
    expect(kinds.has(SEASON_2026_ROW_KIND.REC_GAME)).toBe(false);
    expect(kinds.has(SEASON_2026_ROW_KIND.MINIS_SESSION)).toBe(false);
    expect([...kinds].sort()).toEqual(
      [
        SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE,
        SEASON_2026_ROW_KIND.LEAGUE_PLACEHOLDER,
        SEASON_2026_ROW_KIND.RESERVATION,
        SEASON_2026_ROW_KIND.SCRIMMAGE,
      ].sort()
    );
  });
});

/* ========================================================================== */
/* Subject B — the run that actually exercises the mapping                     */
/* ========================================================================== */

describe('publication :: parity subject B, the external league naming', () => {
  const externalRows = season.combinedByKind[SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE];
  const input = season2026ExternalParityInput({
    externalFixtures: season.externalFixtures,
    agreedGames: externalRows,
  });
  const parity = checkParity(input);

  it('translates a venue label that exists nowhere in internal storage', () => {
    // Not an invented example: this label is in the corpus, and no internal row
    // spells a venue that way.
    const labels = new Set(season.externalFixtures.map((fixture) => fixture.externalVenueLabel));
    expect(labels.has('Alder Park (Back Pitch 2)')).toBe(true);
    const internalVenues = new Set(season.combinedGames.map((game) => game.venue));
    for (const label of labels) expect(internalVenues.has(label)).toBe(false);

    expect(parity.mapping.declared).toBe(2);
    expect(parity.mapping.applied).toBe(8);
    expect(parity.meta.rowsRewritten).toBe(8);
    for (const rule of parity.mapping.rules) {
      expect(rule.applications).toBeGreaterThan(0);
      expect(rule.provenance).toContain('external_fixtures_published.csv');
    }
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.MAPPING_RULE_UNEXERCISED);
  });

  it('reports 8 compared, 4 matched and 4 differing by the negotiated 30 minutes', () => {
    expect(season.externalFixtures).toHaveLength(8);
    expect(externalRows).toHaveLength(8);
    expect(parity.meta.rowsCompared).toBe(8);
    expect(parity.buckets.matched).toHaveLength(4);
    expect(parity.buckets.differing).toHaveLength(4);
    expect(parity.buckets.added).toEqual([]);
    expect(parity.buckets.removed).toEqual([]);
    expect(parity.status).toBe(PUBLICATION_STATUS.REJECTED);

    for (const pair of parity.buckets.differing) {
      expect(pair.changedFields).toEqual([PARITY_FIELD.START_MINUTES]);
      expect(pair.publishedRow.date).toBe('2026-08-22');
      expect(
        Number(pair.before.startMinutes) - Number(pair.after.startMinutes),
        `${pair.label} moved by an unexpected amount`
      ).toBe(30);
    }
    for (const pair of parity.buckets.matched) {
      expect(pair.publishedRow.date).toBe('2026-08-23');
    }
  });

  it('states the two columns the external file does not carry', () => {
    // `external_fixtures_published.csv` has no Format and no Division column,
    // so those are left out of the comparison rather than compared against
    // null — and the narrowing is reported rather than assumed.
    const uncompared = findingsWith(
      parity.findings,
      PUBLICATION_REASON.PARITY_FIELD_UNCOMPARED
    ).map((finding) => finding.details.field);
    expect(uncompared.sort()).toEqual([PARITY_FIELD.DIVISION, PARITY_FIELD.FORMAT].sort());
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_FIELD_ABSENT);
  });

  it('negative control: without the mapping rules, nothing matches', () => {
    // This is what proves the four matches above came from the mapping rather
    // than from the rows happening to agree.
    const unmapped = checkParity({ ...input, mappingRules: [] });
    expect(unmapped.buckets.matched).toHaveLength(0);
    expect(unmapped.buckets.differing).toHaveLength(8);
    for (const pair of unmapped.buckets.differing) {
      expect(pair.changedFields).toContain(PARITY_FIELD.VENUE);
      // The external file carries venue and field in one cell, so `field` is
      // absent until a rule splits it — and an absent cell is refused, never
      // read as agreement.
      expect(pair.absentFields).toEqual([PARITY_FIELD.FIELD]);
    }
    expect(codesOf(unmapped.findings)).toContain(PUBLICATION_REASON.PARITY_FIELD_ABSENT);
  });
});

/* ========================================================================== */
/* The mapping table is falsifiable on its own                                 */
/* ========================================================================== */

describe('publication :: a declared mapping rule that matches nothing is blocking', () => {
  const input = season2026ExternalParityInput({
    externalFixtures: season.externalFixtures,
    agreedGames: season.combinedByKind[SEASON_2026_ROW_KIND.EXTERNAL_FIXTURE],
  });

  it('fires on the build plan’s own invented example, which the corpus does not contain', () => {
    // "Brookside Field 1" -> "Brookside Upper 1" is one of the prompt's three
    // mapping examples. None of the three is in this corpus: there is no
    // `Brookside Field 1` row, only `MinisA`-`MinisD` and never `Minis01`, and
    // the one literal `TBD` is in the Home column rather than as an opponent.
    // A table full of plausible rules for labels that do not exist is exactly
    // what this check is for.
    const stale = {
      id: 'stale:brookside-field-1',
      appliesTo: 'published',
      match: { venue: 'Brookside Park', field: 'Field 1' },
      set: { field: 'Upper 1' },
      provenance: 'the build plan’s example; no corpus row spells it this way',
    };
    const rows = season.combinedGames.map((game) => game.field);
    expect(rows.includes('Field 1')).toBe(true);
    expect(
      season.combinedGames.some(
        (game) => game.venue === 'Brookside Park' && game.field === 'Field 1'
      )
    ).toBe(false);

    const parity = checkParity({
      ...input,
      mappingRules: [...input.mappingRules, stale],
    });
    const unexercised = findingsWith(parity.findings, PUBLICATION_REASON.MAPPING_RULE_UNEXERCISED);
    expect(unexercised).toHaveLength(1);
    expect(unexercised[0].severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(unexercised[0].details.ruleId).toBe('stale:brookside-field-1');
    // The real rules still fired: declared is 3, applied is still 8.
    expect(parity.mapping.declared).toBe(3);
    expect(parity.mapping.applied).toBe(8);
  });

  it('refuses a rule that rewrites a time, a date, or nothing at all', () => {
    const valid = {
      id: 'r1',
      match: { venue: 'A' },
      set: { venue: 'B' },
      provenance: 'test',
    };
    expect(MappingRuleSchema.safeParse(valid).success).toBe(true);
    // Field-name mapping translates labels. A rule that moved a kickoff would
    // be a schedule edit wearing a translation layer's clothes, and the parity
    // report would then agree with itself.
    expect(MappingRuleSchema.safeParse({ ...valid, set: { startMinutes: '600' } }).success).toBe(
      false
    );
    expect(MappingRuleSchema.safeParse({ ...valid, match: { date: '2026-08-22' } }).success).toBe(
      false
    );
    expect(MappingRuleSchema.safeParse({ ...valid, match: {} }).success).toBe(false);
    // Provenance is mandatory: a rule has to say where its labels came from.
    const { provenance: _p, ...noProvenance } = valid;
    expect(MappingRuleSchema.safeParse(noProvenance).success).toBe(false);
    expect(MappingRuleSchema.safeParse({ ...valid, surprise: 1 }).success).toBe(false);
  });

  it('derives the corpus rules from the loader’s own split, so there is one transform', () => {
    const rules = season2026ExternalVenueMapping(season.externalFixtures);
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      const source = season.externalFixtures.find(
        (fixture) => fixture.externalVenueLabel === rule.match.venue
      );
      expect(source).toBeDefined();
      expect(rule.set.venue).toBe(source.venue);
      expect(rule.set.field).toBe(source.field);
    }
  });
});

/* ========================================================================== */
/* The comparator's own guarantees                                             */
/* ========================================================================== */

describe('publication :: the comparator refuses to report on nothing', () => {
  const row = (over) =>
    makeParityRow({
      rowId: 'r',
      sourceLabel: 's',
      date: '2026-08-22',
      startMinutes: 600,
      venue: 'V',
      field: 'F',
      format: '7v7',
      division: 'U10B',
      home: 'H',
      away: 'A',
      ...over,
    });
  const subject = {
    subject: 'constructed',
    published: { label: 'p', rows: [row({ rowId: 'p1' })] },
    current: { label: 'c', rows: [row({ rowId: 'c1' })] },
    keyFields: [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY],
    comparedFields: [PARITY_FIELD.START_MINUTES, PARITY_FIELD.VENUE, PARITY_FIELD.FIELD],
  };

  it('reports an empty comparison as vacuous rather than as parity', () => {
    const empty = checkParity({
      ...subject,
      published: { label: 'p', rows: [] },
      current: { label: 'c', rows: [] },
    });
    expect(empty.meta.rowsCompared).toBe(0);
    const vacuous = findingsWith(empty.findings, PUBLICATION_REASON.PARITY_VACUOUS)[0];
    expect(vacuous.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(empty.status).toBe(PUBLICATION_STATUS.REJECTED);
  });

  it('throws on a subject that keys on nothing, compares nothing, or compares its own key', () => {
    expect(() => checkParity({ ...subject, keyFields: [] })).toThrow(/at least one field/);
    expect(() => checkParity({ ...subject, comparedFields: [] })).toThrow(/compares nothing/);
    expect(() => checkParity({ ...subject, comparedFields: [PARITY_FIELD.DATE] })).toThrow(
      /only ever compare equal/
    );
    expect(() => checkParity({ ...subject, keyFields: ['nonsense'] })).toThrow(
      /not a parity row field/
    );
    expect(() => checkParity({ ...subject, subject: '' })).toThrow(/what it is a comparison of/);
  });

  it('reports an ambiguous identity rather than silently pairing the wrong two rows', () => {
    const doubled = checkParity({
      ...subject,
      published: {
        label: 'p',
        rows: [row({ rowId: 'p1' }), row({ rowId: 'p2', startMinutes: 700 })],
      },
    });
    const ambiguous = findingsWith(doubled.findings, PUBLICATION_REASON.PARITY_KEY_AMBIGUOUS);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].severity).toBe(PUBLICATION_SEVERITY.COMPROMISE);
    expect(ambiguous[0].details.publishedCount).toBe(2);
    // The surplus is still accounted for: one pair, one removal.
    expect(doubled.buckets.matched).toHaveLength(1);
    expect(doubled.buckets.removed).toHaveLength(1);
  });

  it('proves the partition check can fail', () => {
    const partition = compareParityRows({
      published: subject.published.rows,
      current: subject.current.rows,
      keyFields: subject.keyFields,
      comparedFields: subject.comparedFields,
    });
    expect(parityPartitionFindings(partition, { publishedCount: 1, currentCount: 1 })).toEqual([]);

    // A row dropped on the way into the buckets...
    const dropped = parityPartitionFindings(partition, { publishedCount: 2, currentCount: 1 });
    expect(codesOf(dropped)).toEqual([PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE]);
    expect(dropped[0].severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(dropped[0].details.side).toBe('published');

    // ...and a row counted twice.
    const doubled = parityPartitionFindings(
      {
        ...partition,
        added: [...partition.added, { key: 'k', label: 'l', row: subject.current.rows[0] }],
      },
      { publishedCount: 1, currentCount: 1 }
    );
    expect(codesOf(doubled)).toEqual([PUBLICATION_REASON.PARITY_PARTITION_INCOMPLETE]);
    expect(doubled[0].details.side).toBe('current');
  });

  it('refuses to read an absent cell as agreement', () => {
    const absent = checkParity({
      ...subject,
      current: { label: 'c', rows: [row({ rowId: 'c1', venue: null })] },
    });
    const finding = findingsWith(absent.findings, PUBLICATION_REASON.PARITY_FIELD_ABSENT)[0];
    expect(finding.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(finding.details.field).toBe(PARITY_FIELD.VENUE);
    expect(absent.buckets.matched[0].absentFields).toEqual([PARITY_FIELD.VENUE]);
    // The cell was not counted as a comparison either.
    expect(absent.meta.fieldComparisons).toBe(2);
  });
});

/* ========================================================================== */
/* The export-vocabulary path: snapshot -> parity                              */
/* ========================================================================== */

describe('publication :: a snapshot of the export rows compares against a fresh projection', () => {
  const teams = [
    { id: 'T1', name: 'T1', division: 'U10B', coachName: '', coachEmail: '' },
    { id: 'T2', name: 'T2', division: 'U10B', coachName: '', coachEmail: '' },
  ];
  const slot = (over) =>
    makeReservedSlot({
      id: 'slot-1',
      kind: RESERVE_KIND.UNNAMED_FIXTURE,
      label: 'Select Game 1',
      date: '2026-09-12',
      venueId: 'venue:alder',
      surfaceId: 'surface:alder:pitch-2',
      startMinutes: 600,
      endMinutes: 720,
      format: '11v11',
      homeSide: FIXTURE_SIDE.TEAM,
      awaySide: FIXTURE_SIDE.TEAM,
      homeTeamId: 'T1',
      awayTeamId: 'T2',
      ...over,
    });
  const unplaced = makeUnplacedFixture({
    fixtureId: 'fx-9',
    label: 'T1 v T2',
    date: '2026-09-19',
    format: '11v11',
    homeTeamId: 'T1',
    awayTeamId: 'T2',
    reason: 'no permit at this venue on 09/19',
  });

  const projectionFor = (slots, unplacedRows = []) =>
    publicationRowsFor({ slots, unplaced: unplacedRows, teams });
  const snapshotOf = (projection, snapshotId) =>
    makePublicationSnapshot({
      snapshotId,
      label: 'select layer v1',
      channel: 'public site',
      publishedAt: PUBLISHED_AT,
      publishedBy: 'registrar',
      rows: snapshotRowsFromPublication(projection),
    }).snapshot;
  const snapshot = snapshotOf(projectionFor([slot()]), 'pub-export-1');

  const subjectFor = (currentProjection) => ({
    subject: 'snapshot vs working schedule',
    published: {
      label: snapshot.label,
      rows: parityRowsFromExportRows(snapshot.rows, { sourceLabel: snapshot.snapshotId }),
    },
    current: {
      label: 'working',
      rows: parityRowsFromExportRows(
        currentProjection.rows.map((entry) => entry.row),
        { sourceLabel: 'working' }
      ),
    },
    // A per-team export names each fixture twice, once per team, so the
    // identity carries the team the row is addressed to. Without it both halves
    // of one game would share a key and every fixture would report as
    // ambiguous.
    keyFields: [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY, PARITY_FIELD.PARTICIPANT],
    comparedFields: [PARITY_FIELD.START_MINUTES, PARITY_FIELD.FIELD, PARITY_FIELD.DIVISION],
  });

  it('uses the export column vocabulary rather than a second one', () => {
    expect(snapshot.columns).toEqual([...SCHEDULE_EXPORT_COLUMNS]);
    expect(snapshot.rows[0][SCHEDULE_EXPORT_HEADERS.START]).toBe('2026-09-12T10:00:00');
    expect(snapshot.rowCount).toBe(2);
  });

  it('finds no divergence against an unchanged projection', () => {
    const parity = checkParity(subjectFor(projectionFor([slot()])));
    expect(parity.buckets.differing).toEqual([]);
    expect(parity.buckets.added).toEqual([]);
    expect(parity.buckets.removed).toEqual([]);
    expect(parity.buckets.matched).toHaveLength(2);
    expect(parity.meta.fieldComparisons).toBe(6);
    expect(parity.status).toBe(PUBLICATION_STATUS.ALLOWED);
  });

  it('finds the one slot that moved, and says which field moved', () => {
    const parity = checkParity(subjectFor(projectionFor([slot({ startMinutes: 630 })])));
    expect(parity.buckets.differing).toHaveLength(2);
    expect(parity.buckets.matched).toEqual([]);
    for (const pair of parity.buckets.differing) {
      expect(pair.changedFields).toEqual([PARITY_FIELD.START_MINUTES]);
      expect(pair.before.startMinutes).toBe(600);
      expect(pair.after.startMinutes).toBe(630);
    }
    expect(parity.status).toBe(PUBLICATION_STATUS.REJECTED);
  });

  it('refuses to certify the time of a TIME TBD fixture on either side', () => {
    // An unplaced fixture exports as `TIME TBD` (incident 10), which is not a
    // time — so a parity subject that compares kickoffs cannot compare that
    // row's kickoff, on either side, and says so at blocking rather than
    // letting two unknowns read as agreement. The fixture is still *carried*
    // through parity, and still matched on everything it does have.
    const withTbd = projectionFor([slot()], [unplaced]);
    const tbdSnapshot = snapshotOf(withTbd, 'pub-export-tbd');
    expect(tbdSnapshot.rowCount).toBe(4);

    const rows = parityRowsFromExportRows(tbdSnapshot.rows, {
      sourceLabel: tbdSnapshot.snapshotId,
    });
    const tbd = rows.filter((row) => row.startMinutes === null);
    expect(tbd).toHaveLength(2);
    for (const row of tbd) expect(row.date).toBeNull();

    const parity = checkParity({
      ...subjectFor(withTbd),
      published: { label: tbdSnapshot.label, rows },
    });
    expect(parity.buckets.matched).toHaveLength(4);
    expect(parity.buckets.differing).toEqual([]);
    const absent = findingsWith(parity.findings, PUBLICATION_REASON.PARITY_FIELD_ABSENT)[0];
    expect(absent.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(absent.details.field).toBe(PARITY_FIELD.START_MINUTES);
    expect(absent.details.cells).toBe(4);
  });
});

/* ========================================================================== */
/* An empty cell is not an absent column                                       */
/* ========================================================================== */

describe('publication :: a cleared export cell is a change, not agreement', () => {
  /** One row in the export vocabulary, in the shape the exporters emit. */
  const exportRow = (over = {}) => ({
    [SCHEDULE_EXPORT_HEADERS.TEAM_ID]: 'T1',
    [SCHEDULE_EXPORT_HEADERS.TEAM_NAME]: 'T1',
    [SCHEDULE_EXPORT_HEADERS.DIVISION]: 'U10B',
    [SCHEDULE_EXPORT_HEADERS.COACHES]: '',
    [SCHEDULE_EXPORT_HEADERS.COACH_EMAILS]: '',
    [SCHEDULE_EXPORT_HEADERS.EVENT_TYPE]: 'Game',
    [SCHEDULE_EXPORT_HEADERS.OPPONENT]: 'T2',
    [SCHEDULE_EXPORT_HEADERS.ROLE]: 'Home',
    [SCHEDULE_EXPORT_HEADERS.START]: '2026-09-12T10:00:00',
    [SCHEDULE_EXPORT_HEADERS.END]: '2026-09-12T12:00:00',
    [SCHEDULE_EXPORT_HEADERS.FIELD]: 'surface:alder:pitch-2',
    [SCHEDULE_EXPORT_HEADERS.SLOT]: 'slot-1',
    [SCHEDULE_EXPORT_HEADERS.NOTES]: '',
    ...over,
  });

  it('reads a blank Field as blank rather than as a column the artifact lacks', () => {
    const published = parityRowFromExportRow(exportRow(), { sourceLabel: 'pub', index: 0 });
    const cleared = parityRowFromExportRow(
      exportRow({ [SCHEDULE_EXPORT_HEADERS.FIELD]: '', [SCHEDULE_EXPORT_HEADERS.DIVISION]: '' }),
      { sourceLabel: 'cur', index: 0 }
    );
    // `rows.js`'s own header reserves `null` for "this source does not carry
    // that column". A cell that is there and empty is a value.
    expect(published.field).toBe('surface:alder:pitch-2');
    expect(cleared.field, 'a cleared Field read as an absent column').toBe('');
    expect(cleared.division, 'a cleared Division read as an absent column').toBe('');

    const parity = checkParity({
      subject: 'a published fixture whose field was cleared',
      published: { label: 'published', rows: [published] },
      current: { label: 'working', rows: [cleared] },
      keyFields: [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY],
      comparedFields: [PARITY_FIELD.FIELD, PARITY_FIELD.DIVISION],
    });
    // Before the fix both cells were `null` on the current side, the pair
    // landed in `matched`, was counted by `PARITY_ROWS_MATCHED`, and the family
    // whose pitch had been cleared was told nothing at all.
    expect(parity.buckets.matched).toEqual([]);
    expect(parity.buckets.differing).toHaveLength(1);
    expect(parity.buckets.differing[0].changedFields).toEqual([
      PARITY_FIELD.FIELD,
      PARITY_FIELD.DIVISION,
    ]);
    expect(parity.buckets.differing[0].absentFields).toEqual([]);
    expect(codesOf(parity.findings)).not.toContain(PUBLICATION_REASON.PARITY_FIELD_ABSENT);
  });

  it('still reads a column the artifact does not carry at all as absent', () => {
    // The other half of the distinction, so the fix cannot be "never null".
    const row = parityRowFromExportRow(
      { [SCHEDULE_EXPORT_HEADERS.TEAM_NAME]: 'T1' },
      { sourceLabel: 's', index: 0 }
    );
    expect(row.field).toBeNull();
    expect(row.division).toBeNull();
    expect(row.participant).toBeNull();
    // The export vocabulary has no venue column at all, in either case.
    expect(row.venue).toBeNull();
  });

  it('is reachable from the shipping export path, not only from a constructed row', () => {
    // `generateScheduleExports()` writes `fieldId ?? ''` and `division ?? ''`,
    // so the blank cells above are what a real assignment with no field on a
    // team with no division produces.
    const exported = generateScheduleExports({
      teams: [
        { id: 'T1', name: 'T1' },
        { id: 'T2', name: 'T2' },
      ],
      gameAssignments: [
        {
          homeTeamId: 'T1',
          awayTeamId: 'T2',
          start: '2026-09-12T17:00:00Z',
          end: '2026-09-12T19:00:00Z',
        },
      ],
    });
    const row = exported.master.rows[0];
    expect(row[SCHEDULE_EXPORT_HEADERS.FIELD]).toBe('');
    expect(row[SCHEDULE_EXPORT_HEADERS.DIVISION]).toBe('');
    const parityRow = parityRowFromExportRow(row, { sourceLabel: 'master', index: 0 });
    expect(parityRow.field).toBe('');
    expect(parityRow.division).toBe('');
  });
});

/* ========================================================================== */
/* Change notices                                                              */
/* ========================================================================== */

describe('publication :: change notices are grouped by team, enumerated from the roster', () => {
  /** The whole corpus roster — the universe a break in the schedule leaves intact. */
  const universe = season.teams.map((team) => ({
    teamId: team.id,
    teamName: team.name,
    division: team.division,
    coachName: team.coachId,
    coachEmail: null,
  }));

  /** Every participant label in the corpus that is not a rostered team. */
  const nonTeamLabels = [
    ...new Set(
      season.combinedGames.flatMap((game) => {
        const labels = [];
        if (game.homeIsPlaceholder || !season.teams.some((team) => team.id === game.homeLabel)) {
          labels.push(game.homeLabel);
        }
        if (!season.teams.some((team) => team.id === game.awayLabel)) labels.push(game.awayLabel);
        return labels;
      })
    ),
  ];

  /** The team whose games we delete, chosen from the roster rather than the games. */
  const vanished = '10B7v701';

  const parity = checkParity(
    season2026PublishedParityInput({
      publishedRecGames: season.recGames,
      combinedGames: season.combinedGames.filter(
        (game) => game.homeLabel !== vanished && game.awayLabel !== vanished
      ),
    })
  );

  it('names the team whose games all vanished — the one a row-grouped builder would miss', () => {
    // The falsification ruling 6 asks for: this team produces no *changed* row,
    // because it produces no row at all. A notice builder that grouped from the
    // changed rows would leave the family with the worst news with no notice.
    expect(season.teams.some((team) => team.id === vanished)).toBe(true);
    expect(parity.buckets.removed.length).toBe(9);

    const result = buildChangeNotices({ parity, teams: universe, nonTeamLabels });
    expect(result.teamsEnumerated).toBe(132);
    expect(result.meta.teamsEnumerated).toBe(season.teams.length);

    const notice = result.notices.find((entry) => entry.teamId === vanished);
    expect(notice, `${vanished} was not told its nine games are gone`).toBeDefined();
    expect(notice.changes).toHaveLength(9);
    for (const change of notice.changes) {
      expect(change.kind).toBe(NOTICE_CHANGE_KIND.REMOVED);
      expect(change.after).toBeNull();
      expect(change.before.startAt).toMatch(/^2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
    // Its nine opponents are told too — and nobody else has a *removal*, which
    // is the news this test is about. Other teams do appear, with additions:
    // the Select layer was never in the published rec artifact at all.
    // Who should be told, enumerated from the published corpus rather than
    // from the parity result the assertion is about.
    const affected = new Set([vanished]);
    for (const game of season.recGames) {
      if (game.homeLabel === vanished) affected.add(game.awayLabel);
      if (game.awayLabel === vanished) affected.add(game.homeLabel);
    }
    const toldOfARemoval = result.notices
      .filter((entry) => entry.changes.some((change) => change.kind === NOTICE_CHANGE_KIND.REMOVED))
      .map((entry) => entry.teamId);
    expect(toldOfARemoval.sort()).toEqual([...affected].sort());
    expect(affected.size).toBeGreaterThan(1);
    expect(result.meta.teamsWithChanges).toBeGreaterThanOrEqual(10);
    expect(result.meta.teamsWithChanges).toBeLessThan(season.teams.length);
    expect(codesOf(result.findings)).toContain(PUBLICATION_REASON.NOTICE_BUILT);
    expect(result.status).toBe(PUBLICATION_STATUS.ALLOWED);
  });

  it('excludes coach contact columns by default and says so when a caller opts in', () => {
    const closed = buildChangeNotices({ parity, teams: universe, nonTeamLabels });
    expect(closed.includeContacts).toBe(false);
    for (const notice of closed.notices) expect(notice.contact).toBeNull();
    expect(JSON.stringify(closed.notices)).not.toContain('coachName');
    expect(codesOf(closed.findings)).not.toContain(PUBLICATION_REASON.NOTICE_CONTACTS_INCLUDED);

    const opened = buildChangeNotices({
      parity,
      teams: universe,
      nonTeamLabels,
      includeContacts: true,
    });
    expect(opened.notices[0].contact).not.toBeNull();
    const disclosure = findingsWith(
      opened.findings,
      PUBLICATION_REASON.NOTICE_CONTACTS_INCLUDED
    )[0];
    expect(disclosure.severity).toBe(PUBLICATION_SEVERITY.COMPROMISE);
    expect(opened.status).toBe(PUBLICATION_STATUS.COMPROMISED);
  });

  it('refuses to quietly drop a participant it does not recognise', () => {
    const result = buildChangeNotices({ parity, teams: universe, nonTeamLabels: [] });
    const unknown = findingsWith(result.findings, PUBLICATION_REASON.NOTICE_PARTICIPANT_UNKNOWN);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(result.status).toBe(PUBLICATION_STATUS.REJECTED);
  });

  it('reports an empty team universe as vacuous rather than as a quiet season', () => {
    const result = buildChangeNotices({ parity, teams: [], nonTeamLabels });
    expect(result.notices).toEqual([]);
    const vacuous = findingsWith(result.findings, PUBLICATION_REASON.NOTICE_VACUOUS)[0];
    expect(vacuous.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
  });

  it('renders kickoffs with the one GAP-30-safe renderer', () => {
    const moved = checkParity(
      season2026PublishedParityInput({
        publishedRecGames: season.recGames,
        combinedGames: season.combinedGames.map((game) =>
          game.homeLabel === vanished ? { ...game, kickoffMinutes: game.kickoffMinutes + 45 } : game
        ),
      })
    );
    const result = buildChangeNotices({ parity: moved, teams: universe, nonTeamLabels });
    const notice = result.notices.find((entry) => entry.teamId === vanished);
    expect(notice.changes.length).toBeGreaterThan(0);
    const change = notice.changes.find((entry) => entry.kind === NOTICE_CHANGE_KIND.CHANGED);
    expect(change.changedFields).toEqual([PARITY_FIELD.START_MINUTES]);
    expect(Number(change.after.startMinutes) - Number(change.before.startMinutes)).toBe(45);
    // Naive, no offset, no `Z`: the corpus is wall clock and two dates fall
    // after DST ends.
    expect(change.before.startAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(String(change.after.startAt).endsWith('Z')).toBe(false);
  });
});

/* ========================================================================== */
/* A notice run inherits the standing of the parity it was built from          */
/* ========================================================================== */

describe('publication :: notices cannot report a quiet season the comparison never supported', () => {
  const noticeTeam = (over = {}) => ({
    teamId: 'T1',
    teamName: 'T1',
    division: 'U10B',
    coachName: null,
    coachEmail: null,
    ...over,
  });
  const row = (over) =>
    makeParityRow({
      rowId: 'r',
      sourceLabel: 's',
      date: '2026-08-22',
      startMinutes: 600,
      venue: 'V',
      field: 'F',
      format: '7v7',
      division: 'U10B',
      home: 'T1',
      away: 'T2',
      ...over,
    });
  const subjectFor = (over = {}) => ({
    subject: 'constructed',
    published: { label: 'p', rows: [row({ rowId: 'p1' })] },
    current: { label: 'c', rows: [row({ rowId: 'c1' })] },
    keyFields: [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY],
    comparedFields: [PARITY_FIELD.START_MINUTES, PARITY_FIELD.VENUE, PARITY_FIELD.FIELD],
    ...over,
  });

  it('refuses to call a run over a vacuous parity allowed', () => {
    const vacuous = checkParity(
      subjectFor({ published: { label: 'p', rows: [] }, current: { label: 'c', rows: [] } })
    );
    expect(codesOf(vacuous.findings)).toContain(PUBLICATION_REASON.PARITY_VACUOUS);

    const result = buildChangeNotices({ parity: vacuous, teams: [noticeTeam()] });
    // The worst available answer: "0 of 1 enumerated team(s) have something to
    // be told", from a comparison that examined nothing.
    expect(result.status, 'a vacuous parity yielded an allowed notice run').not.toBe(
      PUBLICATION_STATUS.ALLOWED
    );
    expect(result.parityStatus).toBe(PUBLICATION_STATUS.REJECTED);
    const vacuousFinding = findingsWith(result.findings, PUBLICATION_REASON.NOTICE_VACUOUS)[0];
    expect(vacuousFinding.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(vacuousFinding.details.reason).toBe('parity-examined-nothing');
  });

  it('refuses to call a run that told nobody about a rejected parity allowed', () => {
    // The changed fixture names two participants the caller declared non-team,
    // so the divergence is real and no family is addressed by it.
    const diverged = checkParity(
      subjectFor({
        published: {
          label: 'p',
          rows: [row({ rowId: 'p1', home: 'Visiting Club A', away: 'Select Game 7' })],
        },
        current: {
          label: 'c',
          rows: [
            row({
              rowId: 'c1',
              home: 'Visiting Club A',
              away: 'Select Game 7',
              startMinutes: 630,
            }),
          ],
        },
      })
    );
    expect(diverged.status).toBe(PUBLICATION_STATUS.REJECTED);
    expect(diverged.buckets.differing).toHaveLength(1);

    const result = buildChangeNotices({
      parity: diverged,
      teams: [noticeTeam()],
      nonTeamLabels: ['Visiting Club A', 'Select Game 7'],
    });
    expect(result.notices).toEqual([]);
    expect(
      result.status,
      'a rejected parity nobody was told about yielded an allowed notice run'
    ).not.toBe(PUBLICATION_STATUS.ALLOWED);
    const finding = findingsWith(result.findings, PUBLICATION_REASON.NOTICE_VACUOUS)[0];
    expect(finding.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(finding.details.reason).toBe('divergence-told-to-nobody');
    expect(finding.details.divergentRows).toBe(1);
  });

  it('carries the parity’s standing onto a run that does tell somebody, and allows it', () => {
    // The negative control for the two refusals above: a parity rejected
    // *because* families need telling, and they are told, is allowed.
    const diverged = checkParity(
      subjectFor({ current: { label: 'c', rows: [row({ rowId: 'c1', startMinutes: 630 })] } })
    );
    expect(diverged.status).toBe(PUBLICATION_STATUS.REJECTED);

    const result = buildChangeNotices({
      parity: diverged,
      teams: [noticeTeam(), noticeTeam({ teamId: 'T2', teamName: 'T2' })],
    });
    expect(result.parityStatus).toBe(PUBLICATION_STATUS.REJECTED);
    const built = findingsWith(result.findings, PUBLICATION_REASON.NOTICE_BUILT)[0];
    expect(built.details.parityStatus).toBe(PUBLICATION_STATUS.REJECTED);
    expect(built.details.divergentRows).toBe(1);
    expect(result.meta.teamsWithChanges).toBe(2);
    expect(result.status).toBe(PUBLICATION_STATUS.ALLOWED);
    expect(codesOf(result.findings)).not.toContain(PUBLICATION_REASON.NOTICE_VACUOUS);
  });

  it('addresses a per-team row to the participant it names, not to both sides', () => {
    // One moved fixture in an export-vocabulary (per-team) artifact is two
    // rows, each addressed to one team. Filing each under both sides gives
    // every family the same change twice.
    const perTeam = (over) =>
      makeParityRow({
        rowId: 'x',
        sourceLabel: 's',
        date: '2026-09-12',
        startMinutes: 600,
        field: 'surface:alder:pitch-2',
        division: 'U10B',
        home: 'T1',
        away: 'T2',
        ...over,
      });
    const parity = checkParity({
      subject: 'per-team export',
      published: {
        label: 'p',
        rows: [
          perTeam({ rowId: 'p1', participant: 'T1' }),
          perTeam({ rowId: 'p2', participant: 'T2' }),
        ],
      },
      current: {
        label: 'c',
        rows: [
          perTeam({ rowId: 'c1', participant: 'T1', startMinutes: 630 }),
          perTeam({ rowId: 'c2', participant: 'T2', startMinutes: 630 }),
        ],
      },
      keyFields: [
        PARITY_FIELD.DATE,
        PARITY_FIELD.HOME,
        PARITY_FIELD.AWAY,
        PARITY_FIELD.PARTICIPANT,
      ],
      comparedFields: [PARITY_FIELD.START_MINUTES, PARITY_FIELD.FIELD, PARITY_FIELD.DIVISION],
    });
    expect(parity.buckets.differing).toHaveLength(2);

    const result = buildChangeNotices({
      parity,
      teams: [noticeTeam(), noticeTeam({ teamId: 'T2', teamName: 'T2' })],
    });
    const first = result.notices.find((notice) => notice.teamId === 'T1');
    const second = result.notices.find((notice) => notice.teamId === 'T2');
    expect(first.changes, 'T1 was told the one change twice').toHaveLength(1);
    expect(second.changes, 'T2 was told the one change twice').toHaveLength(1);
    expect(result.meta.noticeLinesEmitted).toBe(2);
  });

  it('still files a fixture that names no participant under both sides', () => {
    // The control that keeps the fix from becoming "only ever one addressee":
    // a schedule row is addressed to nobody, and both teams must hear about it.
    const parity = checkParity(
      subjectFor({ current: { label: 'c', rows: [row({ rowId: 'c1', startMinutes: 630 })] } })
    );
    expect(parity.buckets.differing[0].publishedRow.participant).toBeNull();
    const result = buildChangeNotices({
      parity,
      teams: [noticeTeam(), noticeTeam({ teamId: 'T2', teamName: 'T2' })],
    });
    expect(result.meta.noticeLinesEmitted).toBe(2);
    expect(result.notices.map((notice) => notice.teamId).sort()).toEqual(['T1', 'T2']);
  });

  it('refuses to route a label two teams answer to', () => {
    // One team's id is another team's name. A single-pass map lets the later
    // team overwrite the earlier one, and the change is filed under a family
    // it does not belong to — worse than failing to send it.
    const teams = [
      {
        teamId: '10B7v701',
        teamName: 'Alder Falcons',
        division: 'U10B',
        coachName: null,
        coachEmail: null,
      },
      {
        teamId: 'T9',
        teamName: '10B7v701',
        division: 'U10B',
        coachName: null,
        coachEmail: null,
      },
    ];
    const parity = checkParity(
      subjectFor({
        published: { label: 'p', rows: [row({ rowId: 'p1', home: '10B7v701', away: 'T9' })] },
        current: {
          label: 'c',
          rows: [row({ rowId: 'c1', home: '10B7v701', away: 'T9', startMinutes: 630 })],
        },
      })
    );
    expect(parity.buckets.differing).toHaveLength(1);

    const result = buildChangeNotices({ parity, teams });
    const wrongTeam = result.notices.find((notice) => notice.teamId === 'T9');
    // T9 is genuinely the away side, so it hears about the change once — and
    // must not also inherit the home side's on a name collision.
    expect(wrongTeam.changes, 'the home side’s change was filed under T9 as well').toHaveLength(1);
    expect(result.notices.find((notice) => notice.teamId === '10B7v701')).toBeUndefined();

    const ambiguous = findingsWith(
      result.findings,
      PUBLICATION_REASON.NOTICE_PARTICIPANT_UNKNOWN
    ).filter((finding) => finding.details.reason === 'ambiguous');
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(ambiguous[0].details.participant).toBe('10B7v701');
    expect(String(ambiguous[0].details.teamIds).split(',').sort()).toEqual(['10B7v701', 'T9']);
    expect(result.status).toBe(PUBLICATION_STATUS.REJECTED);
  });

  it('reports no collision when every label names one team', () => {
    // The control: the corpus roster spells every team's id and name the same
    // way, so the check above must be silent on it.
    const parity = checkParity(
      subjectFor({ current: { label: 'c', rows: [row({ rowId: 'c1', startMinutes: 630 })] } })
    );
    const result = buildChangeNotices({
      parity,
      teams: [noticeTeam(), noticeTeam({ teamId: 'T2', teamName: 'T2' })],
    });
    expect(codesOf(result.findings)).not.toContain(PUBLICATION_REASON.NOTICE_PARTICIPANT_UNKNOWN);
  });
});

/* ========================================================================== */
/* Downstream sync registry                                                    */
/* ========================================================================== */

describe('publication :: the downstream sync registry', () => {
  const snapshot = {
    snapshotId: 'pub-1',
    label: 'rec schedule v3',
    publishedAt: '2026-09-01T18:00:00',
  };
  const destinations = [
    {
      destinationId: 'public-site',
      name: 'club public site',
      kind: SYNC_DESTINATION_KIND.PULL,
      consumes: 'master schedule export',
      destinationSyncedAt: '2026-08-30T04:00:00',
      owner: 'communications',
    },
    {
      destinationId: 'league-portal',
      name: 'league portal upload',
      kind: SYNC_DESTINATION_KIND.PUSH,
      consumes: 'per-division CSV',
      destinationSyncedAt: '2026-09-01T18:05:00',
      owner: null,
    },
    {
      destinationId: 'printed-programme',
      name: 'printed programme',
      kind: SYNC_DESTINATION_KIND.MANUAL,
      consumes: 'master schedule export',
      destinationSyncedAt: null,
      owner: null,
    },
  ];

  it('warns when a destination predates the snapshot, and says which way the data flows', () => {
    const report = buildSyncRegistryReport({ snapshot, destinations });
    expect(report.meta.destinationsExamined).toBe(3);
    expect(report.meta.destinationsStale).toBe(1);
    expect(report.meta.destinationsNeverSynced).toBe(1);

    const stale = findingsWith(report.findings, PUBLICATION_REASON.DESTINATION_STALE)[0];
    expect(stale.severity).toBe(PUBLICATION_SEVERITY.COMPROMISE);
    expect(stale.details.destinationId).toBe('public-site');
    // A pull destination cannot be told from here that it is stale.
    expect(stale.details.kind).toBe(SYNC_DESTINATION_KIND.PULL);
    expect(stale.message).toContain('cannot be corrected from here');

    const states = Object.fromEntries(
      report.destinations.map((entry) => [entry.destinationId, entry.state])
    );
    expect(states).toEqual({
      'public-site': DESTINATION_STATE.STALE,
      'league-portal': DESTINATION_STATE.CURRENT,
      'printed-programme': DESTINATION_STATE.NEVER,
    });
  });

  it('treats an unknown last sync as blocking rather than as fresh', () => {
    const report = buildSyncRegistryReport({ snapshot, destinations });
    const never = findingsWith(report.findings, PUBLICATION_REASON.DESTINATION_NEVER_SYNCED)[0];
    expect(never.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
    expect(report.status).toBe(PUBLICATION_STATUS.REJECTED);
    // And the key may not simply be left out: omitting it has to be a decision
    // somebody wrote down.
    const { destinationSyncedAt: _s, ...omitted } = destinations[0];
    expect(SyncDestinationSchema.safeParse(omitted).success).toBe(false);
    expect(SyncDestinationSchema.safeParse(destinations[0]).success).toBe(true);
    expect(SyncDestinationSchema.safeParse({ ...destinations[0], surprise: 1 }).success).toBe(
      false
    );
  });

  it('says on every report that nothing observes these timestamps', () => {
    const report = buildSyncRegistryReport({
      snapshot,
      destinations: [destinations[1]],
    });
    const unobserved = findingsWith(
      report.findings,
      PUBLICATION_REASON.DESTINATION_SYNC_UNOBSERVED
    )[0];
    expect(unobserved.severity).toBe(PUBLICATION_SEVERITY.COMPROMISE);
    expect(report.status).toBe(PUBLICATION_STATUS.COMPROMISED);
  });

  it('validates the stamp everything is compared against, not only the destinations’', () => {
    // Every `destinationSyncedAt` goes through `PublicationStampSchema`; the
    // snapshot stamp they are all ordered against did not. Ordering here is
    // textual, so an ISO instant misclassifies staleness at the boundary — a
    // destination that synced at `2026-09-01T18:00:00` reads as *stale*
    // against a publication stamped `2026-09-01T18:00:00Z`, because the
    // shorter string sorts first. Staleness is this module's entire output.
    expect(() =>
      buildSyncRegistryReport({
        snapshot: { ...snapshot, publishedAt: '2026-09-01T18:00:00Z' },
        destinations,
      })
    ).toThrow(/naive/);
    expect(() =>
      buildSyncRegistryReport({
        snapshot: { ...snapshot, publishedAt: '2026-09-01' },
        destinations,
      })
    ).toThrow(/naive/);
    expect(() =>
      buildSyncRegistryReport({ snapshot: { ...snapshot, publishedAt: undefined }, destinations })
    ).toThrow(/naive/);
    // …and the valid stamp still reports, so the guard is not "always throw".
    expect(buildSyncRegistryReport({ snapshot, destinations }).meta.destinationsExamined).toBe(3);
  });

  it('reports an empty registry as vacuous', () => {
    const report = buildSyncRegistryReport({ snapshot, destinations: [] });
    const vacuous = findingsWith(report.findings, PUBLICATION_REASON.SYNC_REGISTRY_VACUOUS)[0];
    expect(vacuous.severity).toBe(PUBLICATION_SEVERITY.BLOCKING);
  });
});

/* ========================================================================== */
/* Structural                                                                  */
/* ========================================================================== */

describe('publication :: one comparator, one key, no clock', () => {
  const packageDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'core',
    'src',
    'publication'
  );

  /** @type {string[]} */
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js')) files.push(full);
    }
  };
  walk(packageDir);

  it('imports nothing from node:, nothing from the fixture loaders, and constructs no Date', () => {
    expect(files.length).toBeGreaterThan(5);
    const specifiers = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+'([^']+)'/gm)) {
        specifiers.push({ file, specifier: match[1] });
      }
      // GAP-30: no Date is constructed anywhere in this package, and no clock
      // is read — every timestamp is an input.
      expect(/new Date\(/.test(source), `${file} constructs a Date`).toBe(false);
      expect(/Date\.now\(/.test(source), `${file} reads a clock`).toBe(false);
    }
    expect(specifiers.length).toBeGreaterThan(0);
    for (const { file, specifier } of specifiers) {
      expect(specifier.startsWith('node:'), `${file} imports ${specifier}`).toBe(false);
      expect(specifier.includes('fixtures/'), `${file} imports ${specifier}`).toBe(false);
      expect(specifier.includes('react'), `${file} imports ${specifier}`).toBe(false);
    }
    // It does lean on the modules it is built on, which is the point: one
    // export vocabulary and one human time renderer.
    expect(specifiers.some((entry) => entry.specifier.includes('../outputGeneration.js'))).toBe(
      true
    );
    expect(specifiers.some((entry) => entry.specifier.includes('reserve/publication.js'))).toBe(
      true
    );
  });

  it('defines the row comparator and the key derivation exactly once', () => {
    const coreSrc = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'packages',
      'core',
      'src'
    );
    /** @type {string[]} */
    const all = [];
    const walkAll = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walkAll(full);
        else if (entry.endsWith('.js')) all.push(full);
      }
    };
    walkAll(coreSrc);
    expect(all.length).toBeGreaterThan(50);

    const definitionsOf = (name) =>
      all.filter((file) =>
        new RegExp(`export function ${name}\\b`).test(readFileSync(file, 'utf8'))
      );
    expect(definitionsOf('compareParityRows')).toHaveLength(1);
    expect(definitionsOf('parityRowKey')).toHaveLength(1);
    expect(definitionsOf('naiveDateTime')).toHaveLength(1);

    // The corpus's own published-identity key is that same derivation rather
    // than a second spelling of it.
    const parsers = readFileSync(path.join(coreSrc, 'fixtures', 'season2026Parsers.js'), 'utf8');
    const body = parsers.slice(parsers.indexOf('export function publicationKey'));
    expect(body.slice(0, 400)).toContain('parityRowKey(');
  });

  it('keeps the fixture suite’s parity test on the production checker', () => {
    const fixtureTest = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'season2026Fixture.test.js'),
      'utf8'
    );
    expect(fixtureTest).toContain('checkParity');
    expect(fixtureTest).toContain('season2026PublishedParityInput');
  });

  it('registers a severity for every reason code it can emit', () => {
    const emitted = new Set();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/PUBLICATION_REASON\.([A-Z_]+)/g)) emitted.add(match[1]);
    }
    expect(emitted.size).toBeGreaterThan(10);
    for (const code of emitted) {
      expect(PUBLICATION_REASON[code], `${code} is not a declared reason`).toBeDefined();
      // The assertion this test is named for. Checking `PUBLICATION_REASON`
      // alone compared the set against the enum the set was enumerated from —
      // a check that cannot fail for the defect it names. Severity lives in a
      // table, and a code missing from it throws at `makePublicationFinding()`
      // rather than defaulting to `info`.
      expect(
        PUBLICATION_REASON_SEVERITY[code],
        `${code} has no entry in PUBLICATION_REASON_SEVERITY`
      ).toBeDefined();
      expect(Object.values(PUBLICATION_SEVERITY)).toContain(PUBLICATION_REASON_SEVERITY[code]);
    }
    // And the table covers the whole vocabulary, not only the codes this
    // package happens to emit today.
    for (const code of Object.values(PUBLICATION_REASON)) {
      expect(
        PUBLICATION_REASON_SEVERITY[code],
        `${code} is declared and has no registered severity`
      ).toBeDefined();
    }
  });

  it('keys a row from the fields it is given, and nothing else', () => {
    const row = makeParityRow({ rowId: 'r', sourceLabel: 's', date: '2026-08-22', home: 'H' });
    expect(parityRowKey(row, [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY])).toBe(
      '2026-08-22|H|'
    );
    // Provenance never reaches the key: two rows from different artifacts that
    // describe the same fixture must collide.
    const other = makeParityRow({ rowId: 'r2', sourceLabel: 's2', date: '2026-08-22', home: 'H' });
    expect(parityRowKey(other, [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY])).toBe(
      parityRowKey(row, [PARITY_FIELD.DATE, PARITY_FIELD.HOME, PARITY_FIELD.AWAY])
    );
  });

  it('reads a naive datetime back without constructing one, and refuses anything else', () => {
    expect(splitNaiveDateTime('2026-11-07T16:44:00')).toEqual({
      date: '2026-11-07',
      startMinutes: 16 * 60 + 44,
    });
    // `TIME TBD` is not a time, and neither is an instant with an offset.
    expect(splitNaiveDateTime('TIME TBD')).toEqual({ date: null, startMinutes: null });
    expect(splitNaiveDateTime('2026-11-07T16:44:00Z')).toEqual({ date: null, startMinutes: null });
  });

  it('folds one result’s counters into another', () => {
    const total = createPublicationMeta();
    const one = { ...createPublicationMeta(), rowsMatched: 567, fieldComparisons: 2835 };
    const two = { ...createPublicationMeta(), rowsMatched: 4, fieldComparisons: 24 };
    mergePublicationMeta(mergePublicationMeta(total, one), two);
    expect(total.rowsMatched).toBe(571);
    expect(total.fieldComparisons).toBe(2859);
    expect(total.rowsRemoved).toBe(0);
  });

  it('sees the same rows every adapter produces', () => {
    // Meta-assertion for the corpus adapters: a season that parsed nothing
    // would make every parity number above true and meaningless.
    const rows = season2026ParityRows(season.recGames, 'published_rec_schedule.csv');
    expect(rows).toHaveLength(567);
    for (const field of SCHEDULE_PARITY_FIELDS) {
      expect(
        rows.some((row) => row[field] !== null),
        `no rec row carries ${field}`
      ).toBe(true);
    }
  });
});
