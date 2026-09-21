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
 * - **Still an in-memory record, now with somewhere to be put.**
 *   `PublicationSnapshot.durability` says `in-memory` on every snapshot this
 *   package constructs, and that stays true: a snapshot object lives in this
 *   process whether or not a copy of it was also written to a table. What has
 *   changed is that there is a table. `PUBLICATION_DURABILITY` deliberately
 *   still has **one** member, because a second one would have to be produced
 *   by some input and none can: `readPublicationSnapshot()` is handed a
 *   document and cannot tell a row of `publication_baselines` from a fixture
 *   file, so a `persisted` member would be a branch nothing could reach —
 *   which this repository counts as evidence of a missing feature rather than
 *   as coverage.
 * - **Seamed, and — since GAP-29 Stage 2 — stored.** `serialise.js` moves a
 *   snapshot through a version-stamped document and back, validated in both
 *   directions. That pair used to be a declaration that a store was missing,
 *   which is what a `serialise*()` / `read*()` pair had always meant here.
 *   `public.publication_baselines` is now the store, and it reaches it
 *   **through** the seam rather than around it —
 *   `frontend/src/hooks/usePublicationBaselines.js` serialises into
 *   `admin_publish_schedule_baseline()` and reads back out through
 *   `readPublicationSnapshot()`. That is the one place this package departs
 *   from the `fieldAdmin` precedent, and `baseline.js`'s header says why: a
 *   registry seam serialises N records into one document and its store holds
 *   one row per record, so the granularities did not meet; a snapshot *is* one
 *   immutable document and the store holds exactly one row per document. The
 *   other two seams — `externalImport`'s and `fieldAdmin`'s — are unchanged and
 *   still store through nothing.
 * - **Not the comparison, twice.** `baseline.js` joins a stored baseline to
 *   {@link checkParity} and contains no comparator of its own.
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
  PUBLICATION_SNAPSHOT_DOCUMENT_VERSION,
  PublicationSnapshotDocumentSchema,
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

export { readPublicationSnapshot, serialisePublicationSnapshot } from './serialise.js';

export {
  BASELINE_COMPARED_FIELDS,
  BASELINE_KEY_FIELDS,
  BASELINE_READ_EXPORT_HEADERS,
  BASELINE_UNREAD_EXPORT_COLUMNS,
  BASELINE_UNSOUND_REASONS,
  baselineDriftSummary,
  baselineParityCoverageFindings,
  baselineParityIsBlocking,
  baselineParitySoundness,
  checkBaselineParity,
} from './baseline.js';

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
