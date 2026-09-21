/**
 * The change log: classification over the season-2026 corpus, the per-subject
 * history, and the as-of query.
 *
 * Every figure here is **derived from the corpus at test time** and asserted
 * against a stated number, so a corpus edit fails loudly rather than quietly
 * re-baselining. Nothing is tuned to make a plan figure come out: where the
 * corpus disagreed with the prompt, the corpus won and the PR body records it.
 *
 * Meta-assertion discipline (CLAUDE.md §3): every check asserts it examined a
 * non-zero number of records, the team universe is enumerated from the
 * **roster** rather than from the entries being checked, and the
 * `positive controls` block constructs the input that makes each load-bearing
 * check fail. A check that is not in that block is a check nobody has shown
 * can fail.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { loadSeason2026, loadSeason2026Practice } from '@squadlogic/core/fixtures/index.js';
import { NOTICE_CHANGE_KIND } from '@squadlogic/core/publication/index.js';
import {
  CHANGELOG_REASON,
  CHANGELOG_STATUS,
  COMPARED_FIELDS,
  PARTICIPANT_RESOLUTION,
  RawChangeEntrySchema,
  SEASON_2026_CHANGE_SOURCES,
  AMBIGUOUS_SOURCE,
  UNDECLARED_SOURCE,
  buildChangeHistory,
  buildChangeLog,
  changeLogPartitionFindings,
  changedFieldsOf,
  kindOf,
  season2026ChangeSources,
  stateAsOf,
  toSeason2026ChangeEntries,
} from '@squadlogic/core/changelog/index.js';

/* -------------------------------------------------------------------------- */
/* The corpus, loaded once                                                     */
/* -------------------------------------------------------------------------- */

const season = loadSeason2026();
const practice = loadSeason2026Practice({ season });

/**
 * The team universe, from the **roster**.
 *
 * `buildTeams()` indexes `coach_roster.csv`'s assignments; the games only add
 * division labels. So a team whose fixtures all vanished is still in here,
 * which is the property `publication/notices.js` and `LESSONS_LEARNED` both
 * insist on: never enumerate the subject set from the data a break corrupts.
 */
const teams = season.teams.map((team) => ({ teamId: team.id, teamName: null }));

/** Participant labels the combined schedule shows are not rostered teams. */
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

const entries = toSeason2026ChangeEntries(practice.gameChanges);

const log = buildChangeLog({
  subject: 'season-2026 game change log',
  entries,
  sources: season2026ChangeSources(),
  teams,
  nonTeamLabels,
});

/** Count findings by code, so an assertion names a number rather than a boolean. */
function codeCounts(findings) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  return counts;
}

/** A minimal valid raw entry, for controls that vary one thing. */
function rawEntry(overrides = {}) {
  return {
    date: '2026-10-03',
    home: 'A',
    away: 'B',
    reason: 'because',
    before: { raw: '10:00', startMinutes: 600, location: 'Pitch 1', scheduled: true },
    after: { raw: '10:30', startMinutes: 630, location: 'Pitch 1', scheduled: true },
    ...overrides,
  };
}

const anySource = [{ id: 'any', title: 'anything', matches: () => true }];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */

describe('season-2026 change log — classification', () => {
  it('loads and classifies all 167 rows, with every entry in exactly one bucket on both axes', () => {
    expect(practice.gameChanges).toHaveLength(167);
    expect(log.meta.entriesExamined).toBe(167);
    expect(log.entries).toHaveLength(167);

    // The reconciliation, against the count taken from the INPUT.
    const kindTotal = Object.values(log.byKind).reduce((sum, n) => sum + n, 0);
    const sourceTotal = Object.values(log.bySource).reduce((sum, n) => sum + n, 0);
    expect(kindTotal).toBe(practice.gameChanges.length);
    expect(sourceTotal).toBe(practice.gameChanges.length);
    expect(codeCounts(log.findings)[CHANGELOG_REASON.PARTITION_UNSOUND]).toBeUndefined();
  });

  it('classifies the kind axis as 108 changed / 59 added / 0 removed', () => {
    expect(log.byKind).toEqual({ changed: 108, added: 59, removed: 0 });
    // Stated rather than left implicit: this season never cancelled a fixture
    // outright. A `removed` count of zero is a property of the corpus, and
    // publishing it is what keeps "nothing was removed" apart from "removals
    // were not looked for".
    expect(log.byKind[NOTICE_CHANGE_KIND.REMOVED]).toBe(0);
    // **And therefore the `removed` branch is not exercised by real data.**
    // Breaking `kindOf()` so it can never return `removed` leaves every
    // corpus assertion in this file green; only the constructed case below
    // catches it. That is said here rather than left for a reader to discover,
    // for the reason `facility/lifecycle.js` publishes `datedNodeCount: 0`:
    // a branch whose only exercise is a constructed input should say so, not
    // sit inside a suite that reads as corpus-verified throughout.
  });

  it('uses publication/ NOTICE_CHANGE_KIND itself, not a second three-word enum', () => {
    expect(Object.keys(log.byKind).sort()).toEqual(Object.values(NOTICE_CHANGE_KIND).sort());
    for (const entry of log.entries) {
      expect(Object.values(NOTICE_CHANGE_KIND)).toContain(entry.kind);
    }
    expect(log.entries.length).toBeGreaterThan(0);
  });

  it('claims every entry with one of the four declared sources, and none is undeclared', () => {
    expect(log.bySource).toEqual({
      [UNDECLARED_SOURCE]: 0,
      [AMBIGUOUS_SOURCE]: 0,
      'venue-respacing': 87,
      'external-league-fixture': 59,
      'facility-closure': 20,
      'person-conflict': 1,
    });
    expect(log.meta.sourcesDeclared).toBe(4);
    expect(log.meta.sourcesMatched).toBe(4);
    const counts = codeCounts(log.findings);
    expect(counts[CHANGELOG_REASON.SOURCE_UNDECLARED]).toBeUndefined();
    expect(counts[CHANGELOG_REASON.SOURCE_AMBIGUOUS]).toBeUndefined();
    expect(counts[CHANGELOG_REASON.SOURCE_MATCHED_NOTHING]).toBeUndefined();
  });

  it('declares exactly the reason strings the corpus carries — an allowlist with no slack', () => {
    const corpusReasons = new Set(practice.gameChanges.map((record) => record.reason));
    const declaredReasons = new Set(SEASON_2026_CHANGE_SOURCES.map((source) => source.reason));
    expect(corpusReasons.size).toBe(4);
    expect([...declaredReasons].sort()).toEqual([...corpusReasons].sort());
  });

  it('records the timing and coverage limits of the source rather than leaving them to be assumed', () => {
    const counts = codeCounts(log.findings);
    // The log dates the fixture, not the decision. An as-of query over it is a
    // valid-time question and cannot be read as "what did we know then".
    expect(counts[CHANGELOG_REASON.TRANSACTION_TIME_ABSENT]).toBe(1);
    // 167 logged changes over a 679-row season is not a proof that the other
    // rows held still.
    expect(counts[CHANGELOG_REASON.COVERAGE_UNSTATED]).toBe(1);
    // The idiom publication/snapshot.js and fieldAdmin/serialise.js established.
    expect(counts[CHANGELOG_REASON.LOG_NOT_PERSISTED]).toBe(1);
  });

  it('carries every field 8.10 needs to build a per-entry notice', () => {
    // PHASE_8_PLAN §8.10 generates "an individual change notice per changelog
    // entry" into publication/notices.js's ChangeNoticeEntry shape. This is
    // the contract this package owes that one, asserted rather than promised
    // in a docblock.
    for (const entry of log.entries) {
      expect(typeof entry.kind).toBe('string');
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(Array.isArray(entry.changedFields)).toBe(true);
      expect(entry.before).not.toBeUndefined();
      expect(entry.after).not.toBeUndefined();
      expect(entry.participants.length).toBe(2);
    }
    expect(log.entries.length).toBe(167);
  });

  it('names a changed entry’s changed fields, and leaves an addition’s empty', () => {
    const changed = log.entries.filter((entry) => entry.kind === NOTICE_CHANGE_KIND.CHANGED);
    const added = log.entries.filter((entry) => entry.kind === NOTICE_CHANGE_KIND.ADDED);
    expect(changed.length).toBe(108);
    expect(added.length).toBe(59);
    for (const entry of added) expect(entry.changedFields).toEqual([]);
    for (const entry of changed) expect(entry.changedFields.length).toBeGreaterThan(0);

    const withTime = changed.filter((entry) => entry.changedFields.includes('startMinutes'));
    const withGround = changed.filter((entry) => entry.changedFields.includes('location'));
    // 77 time-only + 28 time-and-ground = 105 touching the time; 3 ground-only.
    expect(withTime.length).toBe(105);
    expect(withGround.length).toBe(31);
    expect(codeCounts(log.findings)[CHANGELOG_REASON.ENTRY_CHANGED_NOTHING]).toBeUndefined();
  });
});

describe('season-2026 change log — who can be told', () => {
  it('resolves both sides of every entry that is not an external fixture', () => {
    const unresolvedEntries = log.entries.filter((entry) =>
      entry.participants.some((p) => p.resolution === PARTICIPANT_RESOLUTION.UNRESOLVED)
    );
    expect(unresolvedEntries.length).toBe(55);
    // The structural claim worth pinning: unresolvability is confined to the
    // external-fixture import. Every respacing, closure and coach-conflict
    // change reaches both its families.
    expect(new Set(unresolvedEntries.map((entry) => entry.sourceId))).toEqual(
      new Set(['external-league-fixture'])
    );
    expect(new Set(unresolvedEntries.map((entry) => entry.kind))).toEqual(
      new Set([NOTICE_CHANGE_KIND.ADDED])
    );
    expect(log.meta.participantsExamined).toBe(334);
    expect(log.meta.participantsResolved).toBe(271);
    expect(log.meta.participantsDeclaredNonTeam).toBe(4);
    expect(log.meta.participantsUnresolved).toBe(59);
    // The three buckets reconcile against the count taken as sides were read,
    // so a participant dropped on one branch cannot hide in the arithmetic.
    expect(
      log.meta.participantsResolved +
        log.meta.participantsDeclaredNonTeam +
        log.meta.participantsUnresolved
    ).toBe(log.meta.participantsExamined);
    expect(log.meta.participantsExamined).toBe(log.entries.length * 2);
    // 55 entries with one unresolved side plus 4 with two.
    expect(unresolvedEntries.length + 4).toBe(log.meta.participantsUnresolved);
  });

  it('refuses an unresolved participant rather than dropping the change silently', () => {
    expect(codeCounts(log.findings)[CHANGELOG_REASON.PARTICIPANT_UNRESOLVED]).toBe(59);
    expect(log.status).toBe(CHANGELOG_STATUS.REJECTED);
  });

  it('names 16BSuperRec02 — a team-code-shaped home side no roster team answers to', () => {
    // A corpus finding, recorded rather than resolved. 43 of the 44 unresolved
    // labels are external clubs' own team names, which nobody here can notify
    // and nobody expects to. This one is different: it is shaped exactly like
    // a roster team code, it is the HOME side of four fixtures, and no team in
    // the 132-team roster answers to it. Those four fixtures' families cannot
    // be told. Whether the roster is short a Select team or the label is
    // misspelled is an operator question; silently treating it as an external
    // club would answer it wrongly, which is incident 4's shape.
    const unresolvedLabels = [
      ...new Set(
        log.entries.flatMap((entry) =>
          entry.participants
            .filter((p) => p.resolution === PARTICIPANT_RESOLUTION.UNRESOLVED)
            .map((p) => p.label)
        )
      ),
    ];
    expect(unresolvedLabels.length).toBe(44);

    const codeShaped = unresolvedLabels.filter((label) =>
      /^\d{2}[A-Z][A-Za-z0-9]*\d{2}$/.test(label)
    );
    expect(codeShaped).toEqual(['16BSuperRec02']);
    expect(season.teams.some((team) => team.id === '16BSuperRec02')).toBe(false);

    const itsEntries = log.entries.filter((entry) =>
      entry.participants.some((p) => p.label === '16BSuperRec02')
    );
    expect(itsEntries).toHaveLength(4);
    for (const entry of itsEntries) {
      expect(entry.sourceId).toBe('external-league-fixture');
      expect(entry.label.startsWith('16BSuperRec02 v ')).toBe(true);
    }
  });

  it('resolves every unresolved label once the caller declares them — the check falsified the other way', () => {
    const unresolvedLabels = [
      ...new Set(
        log.entries.flatMap((entry) =>
          entry.participants
            .filter((p) => p.resolution === PARTICIPANT_RESOLUTION.UNRESOLVED)
            .map((p) => p.label)
        )
      ),
    ];
    expect(unresolvedLabels.length).toBeGreaterThan(0);
    const declared = buildChangeLog({
      subject: 'season-2026 game change log, opponents declared',
      entries,
      sources: season2026ChangeSources(),
      teams,
      nonTeamLabels: [...nonTeamLabels, ...unresolvedLabels],
    });
    expect(codeCounts(declared.findings)[CHANGELOG_REASON.PARTICIPANT_UNRESOLVED]).toBeUndefined();
    expect(declared.meta.participantsUnresolved).toBe(0);
    expect(declared.status).toBe(CHANGELOG_STATUS.COMPROMISED);
    // And the partition is untouched by who can be notified.
    expect(declared.byKind).toEqual(log.byKind);
    expect(declared.bySource).toEqual(log.bySource);
  });
});

describe('season-2026 change log — history and as-of', () => {
  const subjectId = '16BSuperRec02 v Visiting Club D - U16B Bravo';

  it('builds a subject’s history in date order', () => {
    const history = buildChangeHistory(log, { subjectId });
    expect(history.stats.phaseCount).toBe(1);
    expect(history.stats.conflictCount).toBe(0);
    expect(history.stats.logEntryCount).toBe(167);
    expect(history.phases[0].date).toBe('2026-09-19');
    expect(history.phases[0].kind).toBe(NOTICE_CHANGE_KIND.ADDED);
  });

  it('enumerates 165 distinct subjects from 167 entries', () => {
    expect(log.meta.subjectsEnumerated).toBe(165);
    const histories = [...new Set(log.entries.map((entry) => entry.subjectId))].map((id) =>
      buildChangeHistory(log, { subjectId: id })
    );
    expect(histories).toHaveLength(165);
    // Every entry is reachable through exactly one subject's history.
    const totalPhases = histories.reduce((sum, history) => sum + history.stats.phaseCount, 0);
    expect(totalPhases).toBe(167);
    // And no subject holds two states on one date.
    expect(histories.every((history) => history.stats.conflictCount === 0)).toBe(true);
  });

  it('answers what a fixture’s state was on a date, and says when the log is silent', () => {
    const after = stateAsOf(log, { subjectId, asOf: '2026-12-01' });
    expect(after.logged).toBe(true);
    expect(after.fromEntryKey).toBe('2026-09-19|16BSuperRec02 v Visiting Club D - U16B Bravo');
    expect(after.state?.scheduled).toBe(true);
    expect(typeof after.state?.startMinutes).toBe('number');

    // Before the entry, the log says nothing — which is not "it had no slot".
    const before = stateAsOf(log, { subjectId, asOf: '2026-09-01' });
    expect(before.logged).toBe(false);
    expect(before.state).toBeNull();
  });

  it('refuses to call the last entry current when no as-of date was given', () => {
    const unjudged = stateAsOf(log, { subjectId });
    expect(unjudged.state).toBeNull();
    expect(unjudged.logged).toBe(true);
    expect(codeCounts(unjudged.findings)[CHANGELOG_REASON.AS_OF_UNJUDGED]).toBe(1);
    expect(unjudged.status).toBe(CHANGELOG_STATUS.COMPROMISED);
  });

  it('says so when a subject was never logged, rather than returning an empty list', () => {
    const missing = buildChangeHistory(log, { subjectId: 'no such fixture' });
    expect(missing.phases).toEqual([]);
    expect(codeCounts(missing.findings)[CHANGELOG_REASON.HISTORY_EMPTY]).toBe(1);
    expect(missing.stats.logEntryCount).toBe(167);
  });
});

/* -------------------------------------------------------------------------- */
/* Positive controls — each load-bearing check, made to fail                   */
/* -------------------------------------------------------------------------- */

describe('positive controls', () => {
  it('PARTITION_UNSOUND fires on a bucket short of an entry, and on one counting twice', () => {
    const short = changeLogPartitionFindings({ changed: 1 }, { a: 2 }, 2);
    expect(codeCounts(short)[CHANGELOG_REASON.PARTITION_UNSOUND]).toBe(1);
    expect(short[0].details.axis).toBe('kind');

    const doubled = changeLogPartitionFindings({ changed: 2 }, { a: 3 }, 2);
    expect(codeCounts(doubled)[CHANGELOG_REASON.PARTITION_UNSOUND]).toBe(1);
    expect(doubled[0].details.axis).toBe('source');

    const both = changeLogPartitionFindings({ changed: 1 }, { a: 3 }, 2);
    expect(codeCounts(both)[CHANGELOG_REASON.PARTITION_UNSOUND]).toBe(2);

    // And it stays silent when the partition is sound, so the check is not
    // simply always-on.
    expect(changeLogPartitionFindings({ changed: 2 }, { a: 2 }, 2)).toEqual([]);
  });

  it('SOURCE_UNDECLARED fires on a fifth reason the corpus does not carry', () => {
    const withFifth = buildChangeLog({
      subject: 'a fifth reason',
      entries: [...entries, rawEntry({ reason: 'a reason nobody declared' })],
      sources: season2026ChangeSources(),
      teams,
      nonTeamLabels,
    });
    expect(codeCounts(withFifth.findings)[CHANGELOG_REASON.SOURCE_UNDECLARED]).toBe(1);
    expect(withFifth.bySource[UNDECLARED_SOURCE]).toBe(1);
    expect(withFifth.status).toBe(CHANGELOG_STATUS.REJECTED);
    // The partition still reconciles — which is the point of the sentinel
    // bucket: an undeclared entry is counted, not dropped.
    const total = Object.values(withFifth.bySource).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(168);
    expect(withFifth.bySource[AMBIGUOUS_SOURCE]).toBe(0);
  });

  it('SOURCE_AMBIGUOUS fires when two declarations claim one entry', () => {
    const result = buildChangeLog({
      subject: 'overlapping matchers',
      entries: [rawEntry()],
      sources: [
        { id: 'one', title: 'one', matches: () => true },
        { id: 'two', title: 'two', matches: () => true },
      ],
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
    });
    expect(codeCounts(result.findings)[CHANGELOG_REASON.SOURCE_AMBIGUOUS]).toBe(1);
    // Banked in its own bucket: "nobody claimed it" and "everybody did" are
    // opposite faults with opposite remedies, so one bucket for both would
    // make the partition a reader looks at unable to tell them apart.
    expect(result.bySource[AMBIGUOUS_SOURCE]).toBe(1);
    expect(result.bySource[UNDECLARED_SOURCE]).toBe(0);
    // And neither source reads as dormant: both matched, and
    // SOURCE_MATCHED_NOTHING is derived from matches() rather than the bucket.
    expect(result.meta.sourcesMatched).toBe(2);
    expect(codeCounts(result.findings)[CHANGELOG_REASON.SOURCE_MATCHED_NOTHING]).toBeUndefined();
  });

  it('SOURCE_MATCHED_NOTHING fires for a declaration nothing hits', () => {
    const result = buildChangeLog({
      subject: 'a dormant source',
      entries: [rawEntry()],
      sources: [
        { id: 'live', title: 'live', matches: () => true },
        { id: 'dormant', title: 'dormant', matches: () => false },
      ],
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
    });
    const counts = codeCounts(result.findings);
    expect(counts[CHANGELOG_REASON.SOURCE_MATCHED_NOTHING]).toBe(1);
    expect(result.meta.sourcesDeclared).toBe(2);
    expect(result.meta.sourcesMatched).toBe(1);
  });

  it('PARTICIPANT_AMBIGUOUS fires when one label is claimed by two teams', () => {
    const result = buildChangeLog({
      subject: 'a colliding label',
      entries: [rawEntry()],
      sources: anySource,
      // One team's NAME is another team's ID — the collision notices.js is
      // built to refuse, reproduced here over the same construction.
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'C', teamName: 'A' },
        { teamId: 'B', teamName: null },
      ],
    });
    expect(codeCounts(result.findings)[CHANGELOG_REASON.PARTICIPANT_AMBIGUOUS]).toBe(1);
    expect(result.entries[0].participants[0].resolution).toBe(PARTICIPANT_RESOLUTION.UNRESOLVED);
    expect(result.entries[0].participants[0].teamId).toBeNull();
  });

  it('PARTICIPANT_SELF_PAIRED fires when both sides resolve to one team', () => {
    const result = buildChangeLog({
      subject: 'a fixture against itself',
      entries: [rawEntry({ home: 'A', away: 'Aces' })],
      sources: anySource,
      teams: [{ teamId: 'A', teamName: 'Aces' }],
    });
    expect(codeCounts(result.findings)[CHANGELOG_REASON.PARTICIPANT_SELF_PAIRED]).toBe(1);
  });

  it('ENTRY_CHANGED_NOTHING fires on a logged change whose states are identical', () => {
    const same = { raw: '10:00', startMinutes: 600, location: 'Pitch 1', scheduled: true };
    const result = buildChangeLog({
      subject: 'a logged no-op',
      entries: [rawEntry({ before: same, after: { ...same } })],
      sources: anySource,
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
    });
    expect(codeCounts(result.findings)[CHANGELOG_REASON.ENTRY_CHANGED_NOTHING]).toBe(1);
    expect(result.entries[0].changedFields).toEqual([]);
    expect(result.entries[0].kind).toBe(NOTICE_CHANGE_KIND.CHANGED);
  });

  it('HISTORY_CONFLICT fires when one subject holds two states on one date', () => {
    const twice = [
      rawEntry(),
      rawEntry({
        after: { raw: '11:00', startMinutes: 660, location: 'Pitch 1', scheduled: true },
      }),
    ];
    const result = buildChangeLog({
      subject: 'two states, one date',
      entries: twice,
      sources: anySource,
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
    });
    expect(codeCounts(result.findings)[CHANGELOG_REASON.HISTORY_CONFLICT]).toBe(1);
    const history = buildChangeHistory(result, { subjectId: 'A v B' });
    expect(history.stats.conflictCount).toBe(1);
    expect(history.status).toBe(CHANGELOG_STATUS.REJECTED);
  });

  it('COVERAGE_UNSTATED goes quiet when the caller states what the log covers', () => {
    const stated = buildChangeLog({
      subject: 'a log that says what it covers',
      entries: [rawEntry()],
      sources: anySource,
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
      coverage: 'every change to the rec layer between 2026-08-01 and 2026-11-28',
    });
    expect(codeCounts(stated.findings)[CHANGELOG_REASON.COVERAGE_UNSTATED]).toBeUndefined();
    // And the limit that does NOT go away, because stating coverage says
    // nothing about when a decision was taken.
    expect(codeCounts(stated.findings)[CHANGELOG_REASON.TRANSACTION_TIME_ABSENT]).toBe(1);
  });

  it('refuses a state that is unscheduled and yet carries a time', () => {
    expect(() =>
      RawChangeEntrySchema.parse(
        rawEntry({ after: { raw: 'x', startMinutes: 600, location: null, scheduled: false } })
      )
    ).toThrow();
    expect(() =>
      RawChangeEntrySchema.parse(
        rawEntry({ after: { raw: 'x', startMinutes: null, location: null, scheduled: true } })
      )
    ).toThrow();
  });

  it('refuses a logged change with no reason — the field 8.8 makes required', () => {
    expect(() => RawChangeEntrySchema.parse(rawEntry({ reason: '' }))).toThrow();
    const { reason: _omitted, ...withoutReason } = rawEntry();
    expect(() => RawChangeEntrySchema.parse(withoutReason)).toThrow();
  });

  it('refuses a source id that would collide with the undeclared bucket, or itself', () => {
    expect(() =>
      buildChangeLog({
        subject: 'a colliding source id',
        entries: [rawEntry()],
        sources: [{ id: UNDECLARED_SOURCE, title: 'x', matches: () => true }],
        teams: [],
      })
    ).toThrow(/cannot also be a declared source id/);
    expect(() =>
      buildChangeLog({
        subject: 'the other reserved id',
        entries: [rawEntry()],
        sources: [{ id: AMBIGUOUS_SOURCE, title: 'x', matches: () => true }],
        teams: [],
      })
    ).toThrow(/cannot also be a declared source id/);
    expect(() =>
      buildChangeLog({
        subject: 'a duplicated source id',
        entries: [rawEntry()],
        sources: [
          { id: 'same', title: 'x', matches: () => false },
          { id: 'same', title: 'y', matches: () => true },
        ],
        teams: [],
      })
    ).toThrow(/declared twice/);
  });

  it('a derived answer cannot read cleaner than the log it came from', () => {
    // Review finding: history and as-of started their findings list empty, so
    // a subject with nothing wrong with it returned `allowed` out of a log
    // that was `rejected`. The corpus log IS rejected (59 unroutable
    // participants), and this is the exact subject whose home side the README
    // calls unnotifiable.
    expect(log.status).toBe(CHANGELOG_STATUS.REJECTED);
    const subjectId = '16BSuperRec02 v Visiting Club D - U16B Bravo';

    const history = buildChangeHistory(log, { subjectId });
    expect(history.logStatus).toBe(CHANGELOG_STATUS.REJECTED);
    expect(codeCounts(history.findings)[CHANGELOG_REASON.DERIVED_FROM_REJECTED_LOG]).toBe(1);
    expect(history.status).not.toBe(CHANGELOG_STATUS.ALLOWED);

    const asOf = stateAsOf(log, { subjectId, asOf: '2026-12-01' });
    expect(asOf.logStatus).toBe(CHANGELOG_STATUS.REJECTED);
    expect(asOf.status).not.toBe(CHANGELOG_STATUS.ALLOWED);
    // The answer itself is still given — the point is that it is not clean,
    // not that it is withheld.
    expect(asOf.state?.scheduled).toBe(true);

    // ...and the other direction: over a log that is not rejected, no such
    // finding and the status is free to be clean.
    const clean = buildChangeLog({
      subject: 'a log with nothing wrong',
      entries: [rawEntry()],
      sources: anySource,
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
      coverage: 'stated',
    });
    const cleanHistory = buildChangeHistory(clean, { subjectId: 'A v B' });
    expect(cleanHistory.logStatus).toBe(CHANGELOG_STATUS.COMPROMISED);
    expect(
      codeCounts(cleanHistory.findings)[CHANGELOG_REASON.DERIVED_FROM_REJECTED_LOG]
    ).toBeUndefined();
    expect(cleanHistory.status).toBe(CHANGELOG_STATUS.ALLOWED);
  });

  it('honours a declared non-team label ahead of a team that answers to it', () => {
    // Review finding: the precedence was team-before-declared-label, the
    // inverse of publication/notices.js:204, so a placeholder the caller had
    // declared was silently routed to a team with no finding. That is a
    // placeholder read as a team code — incident 4.
    const result = buildChangeLog({
      subject: 'a placeholder a team also answers to',
      entries: [rawEntry({ home: 'TBD', away: 'B' })],
      sources: anySource,
      teams: [
        { teamId: 'T1', teamName: 'TBD' },
        { teamId: 'B', teamName: null },
      ],
      nonTeamLabels: ['TBD'],
    });
    expect(result.entries[0].participants[0]).toEqual({
      label: 'TBD',
      resolution: PARTICIPANT_RESOLUTION.DECLARED_NON_TEAM,
      teamId: null,
    });
    expect(result.meta.participantsDeclaredNonTeam).toBe(1);
    // Without the declaration the same label IS the team — so the check is
    // the declaration doing work, not the label being unroutable anyway.
    const undeclared = buildChangeLog({
      subject: 'the same label, not declared',
      entries: [rawEntry({ home: 'TBD', away: 'B' })],
      sources: anySource,
      teams: [
        { teamId: 'T1', teamName: 'TBD' },
        { teamId: 'B', teamName: null },
      ],
    });
    expect(undeclared.entries[0].participants[0].teamId).toBe('T1');
  });

  it('names the two colliding rows by ordinal, since their keys are identical', () => {
    // Review finding: `key` is `date|label`, so two entries for one subject on
    // one date have the SAME key. A finding naming only keys handed an
    // operator the same string twice and no way to locate either row.
    const twice = [
      rawEntry(),
      rawEntry({
        after: { raw: '11:00', startMinutes: 660, location: 'Pitch 1', scheduled: true },
      }),
    ];
    const result = buildChangeLog({
      subject: 'two states, one date',
      entries: twice,
      sources: anySource,
      teams: [
        { teamId: 'A', teamName: null },
        { teamId: 'B', teamName: null },
      ],
    });
    const conflict = result.findings.find(
      (finding) => finding.code === CHANGELOG_REASON.HISTORY_CONFLICT
    );
    expect(conflict?.details.ordinals).toEqual([0, 1]);
    expect(result.entries[0].key).toBe(result.entries[1].key);

    const history = buildChangeHistory(result, { subjectId: 'A v B' });
    expect(
      history.findings.find((f) => f.code === CHANGELOG_REASON.HISTORY_CONFLICT)?.details.ordinals
    ).toEqual([0, 1]);
    // And the phases are ordered by source position, not by insertion luck.
    expect(history.phases.map((phase) => phase.ordinal)).toEqual([0, 1]);
  });

  it('refuses a scheduled state with no ground, which would report a move that never happened', () => {
    // Review finding: `changedFieldsOf` compares `location` by value, so a
    // source that merely omitted the ground on one side made the entry claim
    // a ground change — and under §8.10 every entry becomes a notice.
    expect(() =>
      RawChangeEntrySchema.parse(
        rawEntry({ after: { raw: '10:30', startMinutes: 630, location: null, scheduled: true } })
      )
    ).toThrow();
    // The shape that would have gone out: a null ground read as a value.
    expect(
      changedFieldsOf(
        { raw: null, startMinutes: 600, location: 'Pitch 1', scheduled: true },
        { raw: null, startMinutes: 600, location: null, scheduled: true }
      )
    ).toEqual(['location']);
  });

  it('kindOf and changedFieldsOf answer each case they are asked about', () => {
    const none = { raw: null, startMinutes: null, location: null, scheduled: false };
    const some = { raw: '10:00', startMinutes: 600, location: 'Pitch 1', scheduled: true };
    const later = { raw: '10:30', startMinutes: 630, location: 'Pitch 1', scheduled: true };
    const elsewhere = { raw: '10:00', startMinutes: 600, location: 'Pitch 2', scheduled: true };

    expect(kindOf(none, some)).toBe(NOTICE_CHANGE_KIND.ADDED);
    expect(kindOf(some, none)).toBe(NOTICE_CHANGE_KIND.REMOVED);
    expect(kindOf(some, later)).toBe(NOTICE_CHANGE_KIND.CHANGED);
    expect(kindOf(none, none)).toBe(NOTICE_CHANGE_KIND.CHANGED);

    expect(changedFieldsOf(some, later)).toEqual(['startMinutes']);
    expect(changedFieldsOf(some, elsewhere)).toEqual(['location']);
    expect(changedFieldsOf(some, { ...later, location: 'Pitch 2' })).toEqual([...COMPARED_FIELDS]);
    expect(changedFieldsOf(none, some)).toEqual([]);
    expect(changedFieldsOf(some, none)).toEqual([]);
  });

  it('refuses a log with no subject, and a history or as-of with no subject id', () => {
    // Cast at the call: these are the shapes a JS caller can pass and the
    // type checker is right to refuse, so the refusal is asserted at runtime
    // where a plain `.js` consumer would actually hit it.
    expect(() =>
      buildChangeLog(/** @type {any} */ ({ entries: [], sources: [], teams: [] }))
    ).toThrow(/subject/);
    expect(() => buildChangeHistory(log, /** @type {any} */ ({}))).toThrow(/subjectId/);
    expect(() => stateAsOf(log, /** @type {any} */ ({}))).toThrow(/subjectId/);
    expect(() => stateAsOf(log, { subjectId: 'A v B', asOf: '3 October' })).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The package's stated purity, enforced rather than declared                  */
/* -------------------------------------------------------------------------- */

describe('changelog :: the seams the barrel claims', () => {
  // `changelog/index.js` says the package builds no `Date`, imports nothing
  // from `node:` and nothing from `fixtures/`. A docstring that says so and a
  // test that checks it are different things, and CLAUDE.md's "declared is not
  // enforced" is the whole reason this block exists. `practice/`'s equivalent
  // in tests/practiceSlotModel.test.js is the model.

  /** Strip comments, so prose *about* `Date` is not mistaken for a use. */
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const packageFiles = () => {
    /** @type {string[]} */
    const found = [];
    const walk = (absolute) => {
      for (const entry of readdirSync(absolute).sort()) {
        const full = path.join(absolute, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) found.push(full);
      }
    };
    walk(path.join(REPO_ROOT, 'packages/core/src/changelog'));
    return found;
  };

  const FORBIDDEN = [/\bnew Date\b/, /\bDate\s*\./, /from '[^']*fixtures\//, /from 'node:/];

  it('builds no Date, and imports from neither fixtures/ nor node:', () => {
    const files = packageFiles();
    // Meta-assertion: a walk that found nothing would pass the loop below
    // while reading an empty directory.
    expect(files.length).toBe(7);
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of FORBIDDEN) {
        expect(code, `${path.relative(REPO_ROOT, file)} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('the guard above can fail — each pattern catches a planted use', () => {
    const planted = [
      'const now = new Date();',
      'const n = Date.now();',
      "import { loadSeason2026 } from '../fixtures/season2026Loader.js';",
      "import { readFileSync } from 'node:fs';",
    ];
    expect(planted).toHaveLength(FORBIDDEN.length);
    planted.forEach((sample, index) => {
      expect(stripComments(sample)).toMatch(FORBIDDEN[index]);
    });
    // ...and the stripper neither swallows real code nor lets prose through.
    expect(stripComments('/* new Date */ const x = 1;')).not.toMatch(FORBIDDEN[0]);
    expect(stripComments('const d = new Date(); // fine')).toMatch(FORBIDDEN[0]);
  });
});
