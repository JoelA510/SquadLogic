/**
 * Barrel for the change log.
 *
 * Every public export of `changelog/` goes through this file, exactly as
 * `facility/index.js`, `practice/index.js` and `fieldAdmin/index.js` do for
 * their layers. There is no `packages/core/src/index.js` and this does not
 * create one: the convention is a barrel per module directory, reached through
 * the `@squadlogic/core/<module>/index.js` alias.
 *
 * ## What this package is
 *
 * The classified half of 8.8: a dated log of changes, each carrying a kind, a
 * declared cause and a resolved set of addressees, plus the per-subject
 * history and as-of query over it.
 *
 * ## What this package is NOT, stated so the absences are decisions
 *
 * - **Not a store.** Every log carries `LOG_NOT_PERSISTED`. The durable
 *   changelog is GAP-35's, which `docs/MODEL_GAPS.md` records was split out of
 *   GAP-29 by operator ruling and is not scheduled. The design ruling that
 *   goes with it — a changelog row references `publication_baselines
 *   .baseline_version` rather than hanging off it, and never lives in
 *   `audit_log`, which a 180-day cron prunes — is recorded in that gap.
 * - **Not a notice generator.** `PHASE_8_PLAN.md` §8.10 generates *"an
 *   individual change notice per changelog entry"*, and notice state is built
 *   with the generation rather than a task ahead of it. What this package owes
 *   8.10 is that every field a `publication/notices.js` `ChangeNoticeEntry`
 *   needs is on a {@link import('./types.js').ChangeLogEntry}; the
 *   correspondence is tabulated in `types.js` so 8.10 can hold this one to it.
 * - **Not a second causal taxonomy.** The kind axis *is*
 *   `publication/reasonCodes.js`'s `NOTICE_CHANGE_KIND`. The cause axis is a
 *   caller-declared registry rather than `resolve/`'s `causeKind`, because
 *   `causeKind`'s two values describe why a solver moved a game and a change
 *   log records why a club did. `classify.js`'s header is the argument.
 *
 * The package is pure domain logic: no React, no `node:*`, **no `Date`
 * construction** and no import from `fixtures/`.
 *
 * @module changelog
 */

export {
  CHANGELOG_REASON,
  CHANGELOG_REASON_SEVERITY,
  CHANGELOG_SEVERITY,
  CHANGELOG_STATUS,
  PARTICIPANT_RESOLUTION,
  changelogSeverityOf,
  createChangelogMeta,
  deriveChangelogStatus,
  makeChangelogFinding,
} from './reasonCodes.js';

export {
  ChangeLogTeamSchema,
  ChangeStateSchema,
  IsoDateSchema,
  MinutesSchema,
  RawChangeEntrySchema,
} from './schemas.js';

export {
  AMBIGUOUS_SOURCE,
  COMPARED_FIELDS,
  UNDECLARED_SOURCE,
  buildChangeLog,
  changeLogPartitionFindings,
  changedFieldsOf,
  kindOf,
} from './classify.js';

export { buildChangeHistory, stateAsOf } from './history.js';

export {
  SEASON_2026_CHANGE_SOURCES,
  season2026ChangeSources,
  toChangeState,
  toSeason2026ChangeEntries,
} from './adapters/season2026ChangeLog.js';
