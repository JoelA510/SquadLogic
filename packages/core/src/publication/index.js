/**
 * Barrel for publication state, parity, change notices and downstream sync.
 *
 * Every public export of `publication/` goes through this file, exactly as
 * `facility/index.js`, `timing/index.js`, `availability/index.js`,
 * `constraints/index.js`, `waivers/index.js`, `ruleEngine/index.js`,
 * `people/index.js`, `freeze/index.js`, `resolve/index.js`,
 * `attribution/index.js` and `reserve/index.js` do for theirs.
 *
 * ## What this module is
 *
 * The four things that let a schedule be checked against what families were
 * actually told:
 *
 * | thing | what it is | corpus |
 * | --- | --- | --- |
 * | **publication snapshot** | an immutable, timestamped copy of a published artifact, with who published it where | `published_rec_schedule.csv`, 567 rows |
 * | **parity** | one comparator over two row sets, partitioning into matched / differing / added / removed | 567 matched + 112 added against the 679-row workbook |
 * | **change notice** | a family-facing before/after list, grouped by team, enumerated from the roster | incident 1 |
 * | **sync registry** | every destination that consumes this schedule and when it last took a copy | the public site's daily auto-sync |
 *
 * ## What it deliberately is not
 *
 * - **Not persisted.** `PublicationSnapshot.durability` says `in-memory` on the
 *   record, and the reason is now GAP-29 alone. It used to be GAP-30 as well:
 *   `SlotSchema` and `AssignmentSchema` normalised through `z.coerce.date()`,
 *   so a snapshot round-tripped through them came back with its wall-clock
 *   times reinterpreted in the host timezone, and a parity checker storing its
 *   ground truth that way would have **caused the divergence it exists to
 *   detect**. That is closed: those schemas now refuse a naive wall reading
 *   outright and `timing/seasonClock.js` composes one against the season's
 *   zone. Persistence still waits on GAP-29, and on nothing else here.
 * - **Not a second diff.** `compareParityRows()` is the only row comparator
 *   here; `resolve/state.js` `diffAgainstBaseline()` remains the only
 *   game-by-game baseline diff, over a resolve run rather than over two
 *   artifacts. Phase 6.1's scenario diff is meant to call through this one.
 * - **Not a second export vocabulary.** `rows.js` adapts
 *   `outputGeneration.js`'s `SCHEDULE_EXPORT_COLUMNS` into parity rows; it does
 *   not restate the column names.
 * - **Not a second time renderer.** Notices render kickoffs with
 *   `reserve/publication.js` `naiveDateTime()`, the only GAP-30-safe one.
 * - **Not the teaming snapshot.** `teamSnapshot.js` owns `draft | review |
 *   published | locked` for roster drafts; nothing here reads or writes it, and
 *   every name in this package is qualified `Publication…` or `Parity…` so the
 *   two cannot be confused in an import list.
 * - **Not monitoring.** Nothing observes a destination's sync; every timestamp
 *   in the registry is an operator's assertion, and every report says so with
 *   `DESTINATION_SYNC_UNOBSERVED` at `compromise`.
 *
 * @module publication
 */

export {
  NOTICE_CHANGE_KIND,
  PARITY_BUCKET,
  PUBLICATION_DURABILITY,
  PUBLICATION_REASON,
  PUBLICATION_REASON_SEVERITY,
  PUBLICATION_SEVERITY,
  PUBLICATION_STATUS,
  SYNC_DESTINATION_KIND,
  createPublicationMeta,
  derivePublicationStatus,
  makePublicationFinding,
  mergePublicationMeta,
  publicationSeverityOf,
} from './reasonCodes.js';

export {
  MAPPABLE_PARITY_FIELDS,
  MappingRuleSchema,
  NoticeTeamSchema,
  PublicationSnapshotInputSchema,
  PublicationStampSchema,
  SyncDestinationSchema,
} from './schemas.js';

export {
  DEFAULT_PARITY_KEY_FIELDS,
  PARITY_FIELD,
  PARITY_FIELD_ORDER,
  exportCell,
  isParityField,
  makeParityRow,
  parityRowFromExportRow,
  parityRowKey,
  parityRowsFromExportRows,
  populatedParityFields,
  splitNaiveDateTime,
} from './rows.js';

export {
  makePublicationSnapshot,
  publicationDigest,
  snapshotRowsFromPublication,
  verifySnapshotDigest,
} from './snapshot.js';

export {
  applyMappingRules,
  checkParity,
  compareParityRows,
  parityPartitionFindings,
} from './parity.js';

export { buildChangeNotices } from './notices.js';

export { DESTINATION_STATE, buildSyncRegistryReport } from './registry.js';

export {
  SEASON_2026_EXTERNAL_COMPARED_FIELDS,
  SEASON_2026_PARITY_KEY_FIELDS,
  SEASON_2026_REC_COMPARED_FIELDS,
  season2026ExternalParityInput,
  season2026ExternalParityRows,
  season2026ExternalVenueMapping,
  season2026ParityRow,
  season2026ParityRows,
  season2026PublishedParityInput,
} from './adapters/season2026Publication.js';
