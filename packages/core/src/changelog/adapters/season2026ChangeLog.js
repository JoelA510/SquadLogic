/**
 * The season-2026 game change log as change-log entries, and the four sources
 * that corpus declares.
 *
 * **Already-parsed records in, domain records out.** This module takes what
 * `fixtures/season2026PracticeParsers.js` `parseGameChangeLog()` returns and
 * never reads a file, so the arrow points `fixtures/ -> changelog/` and never
 * back — the rule `fieldAdmin/index.js` states for its own adapters. The same
 * mapping therefore works on an operator's uploaded sheet without a second
 * code path.
 *
 * ## Why the sources are exact strings
 *
 * `fixtures/season-2026/practice/game_change_log.csv` carries exactly four
 * distinct reason strings across its 167 rows. They are declared here **by
 * exact text**, which makes the registry an allowlist: a fifth reason, or a
 * fourth reason respelled, matches nothing and is `SOURCE_UNDECLARED` at
 * blocking.
 *
 * That is deliberate and it is the corpus's own standard. Its vocabulary guard
 * was rewritten from a denylist to an allowlist for the reason its README
 * states — *"A leak no longer has to be recognised to be caught — it only has
 * to be new"* — and a classifier built from four loose regexes would have the
 * denylist's failure mode exactly: it would file a fifth cause under whichever
 * pattern happened to be permissive and report a complete partition. Adding a
 * legitimate new reason fails the classifier until a human declares it. That
 * is the point.
 *
 * A log whose reasons are not a closed set declares matchers of its own shape;
 * `ChangeSourceDeclaration.matches` is a predicate precisely so this adapter's
 * choice is not imposed on the next one.
 *
 * ## The four causes, and why none of them is a `causeKind`
 *
 * An operator policy decision, an external league's fixtures arriving, a
 * facility closure and one person's conflict. `resolve/`'s `causeKind` has two
 * values — `constraint` and `global-reoptimisation` — and both describe why
 * the *solver* moved a game. `classify.js`'s header argues this at length; it
 * is repeated here only far enough to say that the omission is a decision.
 *
 * @module changelog/adapters/season2026ChangeLog
 */

/**
 * The exact reason text of each declared source, and the id it classifies to.
 *
 * Exported so a test can prove the set is exhaustive against the corpus
 * rather than trusting this list — the four counts are asserted in
 * `tests/changelog.test.js` against the parsed rows, so a corpus edit that
 * adds a fifth reason fails there as well as here.
 *
 * @readonly
 */
export const SEASON_2026_CHANGE_SOURCES = Object.freeze([
  Object.freeze({
    id: 'venue-respacing',
    title: 'Maplewood respacing to 30-minute gaps',
    reason:
      'Maplewood respacing to 30-min gaps between games (spaced games for parking, field quality)',
  }),
  Object.freeze({
    id: 'external-league-fixture',
    title: 'Regional League Select fixture',
    reason: 'Regional League Select fixture',
  }),
  Object.freeze({
    id: 'facility-closure',
    title: 'Gardening Day closure at Maplewood',
    reason: '10/17 Gardening Day - Maplewood 1-7 closed until noon',
  }),
  Object.freeze({
    id: 'person-conflict',
    title: "A coach's own commitment elsewhere",
    reason: 'Coach conflict - away U19G game in Havenbrook 10:20 AM',
  }),
]);

/**
 * The four sources as declarations the classifier consumes.
 *
 * @returns {Array<import('../types.js').ChangeSourceDeclaration>}
 */
export function season2026ChangeSources() {
  return SEASON_2026_CHANGE_SOURCES.map((source) => ({
    id: source.id,
    title: source.title,
    matches: (reason) => reason === source.reason,
  }));
}

/**
 * One parsed `game_change_log.csv` side as a {@link import('../types.js').ChangeState}.
 *
 * The parser's `unscheduled` flag is the corpus's `(not previously scheduled)`
 * marker and is the only thing that decides `scheduled`. A time is never
 * inferred from its absence and an absence is never inferred from a time.
 *
 * @param {{ raw: string, unscheduled: boolean, minutes: number|null, location: string|null }} side
 * @returns {import('../types.js').ChangeState}
 */
export function toChangeState(side) {
  if (side.unscheduled) {
    return { raw: side.raw, startMinutes: null, location: null, scheduled: false };
  }
  return {
    raw: side.raw,
    startMinutes: side.minutes,
    location: side.location,
    scheduled: true,
  };
}

/**
 * The parsed change-log records as raw change-log entries.
 *
 * @param {ReadonlyArray<{ date: string, homeLabel: string, awayLabel: string, reason: string, was: Object, now: Object }>} records
 * @returns {Array<Object>}
 */
export function toSeason2026ChangeEntries(records) {
  return records.map((record) => ({
    date: record.date,
    home: record.homeLabel,
    away: record.awayLabel,
    reason: record.reason,
    before: toChangeState(
      /** @type {{ raw: string, unscheduled: boolean, minutes: number|null, location: string|null }} */ (
        record.was
      )
    ),
    after: toChangeState(
      /** @type {{ raw: string, unscheduled: boolean, minutes: number|null, location: string|null }} */ (
        record.now
      )
    ),
  }));
}
