/**
 * Barrel for the practice import's pure core (plan `docs/changes/2026-11-03-schedule-expansion.md`
 * section 4.11; PR 9). Every public export of `practiceImport/` goes through this file, as
 * `scheduleImport/index.js` and its siblings do for theirs.
 *
 * | module | what it is |
 * | --- | --- |
 * | `reasonCodes.js` | the closed lists: what refuses a file, what lists a row, what is flagged (and by whom) |
 * | `slotKey.js` | the label key, a slot's identity, and the supply rule between two slots |
 * | `parseRows.js` | the CSV rows: days, times, `End` or `Length`, capacity, dates, open slots and holds |
 * | `aliases.js` | the optional alias file: a label of the practice file to one of the organization's grounds |
 * | `mapping.js` | the file's labels against the organization's records: proposals, decisions, slots, settings |
 * | `probableMoves.js` | a re-import's rows leaving and arriving, paired at team level |
 * | `staging.js` | a parsed row as the staged payload the SQL apply reads (PR 10), and the whole file staged (PR 11) |
 * | `previewCounts.js` | the counts a preview shows and its confirm carries: the dry run's own (PR 11) |
 *
 * ## What it is not
 *
 * It persists nothing and reads no table. It is the reference the Edge function (PR 11) and the SQL
 * (PR 10) are held to, and the browser's preview runs it. It shares the schedule import's date, time and
 * length readers and its label normaliser (so `externalImport` gains no second importer), and nothing
 * in `scheduleImport/` imports it: the dependency runs one way.
 */

export * from './reasonCodes.js';
export * from './slotKey.js';
export * from './parseRows.js';
export * from './aliases.js';
export * from './mapping.js';
export * from './probableMoves.js';
export * from './staging.js';
export * from './previewCounts.js';
