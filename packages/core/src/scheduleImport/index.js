/**
 * Barrel for the schedule import's pure core (plan `docs/changes/2026-11-03-schedule-expansion.md`
 * section 4; PR 4). Every public export of `scheduleImport/` goes through this file, as
 * `externalImport/index.js` and its siblings do for theirs.
 *
 * | module | what it is |
 * | --- | --- |
 * | `reasonCodes.js` | the closed lists: what refuses a file, what lists a row, what is flagged |
 * | `parseRows.js` | the CSV rows: dates, times, the week rule, the allowlist, the season clock |
 * | `mapping.js` | the file's labels against the organization's records: proposals, decisions, outside clubs |
 * | `audit.js` | the conflict audit, with what it did not check |
 * | `staging.js` | what a parsed row becomes in `staging_import_rows` (the keys the SQL apply reads) |
 *
 * ## What it is not
 *
 * It persists nothing and reads no table. It is the reference the Edge function (PR 6) and the SQL
 * (PR 5) are held to, and the browser's preview runs it. It imports `externalImport/mapping.js` for
 * the one label normaliser, which makes `externalImport` **wired for the first time**: that module
 * was unimported by anything outside itself until this one (`tests/externalFixtureImport.test.js`
 * lists its importers exactly).
 */

export * from './reasonCodes.js';
export * from './parseRows.js';
export * from './mapping.js';
export * from './audit.js';
export * from './staging.js';
