/**
 * **The published artifact, frozen.**
 *
 * > *"Recovery was only possible by re-importing the published schedule and
 * > treating it as ground truth."* — incident 1
 *
 * A publication snapshot is what families were actually told, kept in the shape
 * it was told to them in: flat rows in the export column vocabulary
 * (`packages/core/src/outputGeneration.js` `SCHEDULE_EXPORT_COLUMNS`), plus the
 * audit trail of what went out, where it went, and who sent it.
 *
 * ## Four properties, and why each is not decoration
 *
 * - **Frozen copies, not references.** The rows are copied out of whatever
 *   produced them and deep-frozen. A "snapshot" that shared structure with the
 *   working schedule would change when the schedule changed, which is the one
 *   thing a snapshot must not do.
 * - **`publishedAt` and `publishedBy` are inputs.** Nothing here reads a clock
 *   or invents an actor. A self-stamped snapshot has two fields that read as an
 *   audit trail and are not one, and this repository has already lost a board
 *   waiver to a field that read as load-bearing and was not.
 * - **A content digest.** {@link publicationDigest} over the rows in their
 *   declared column order, so that a snapshot whose rows were edited after the
 *   fact can be caught — {@link verifySnapshotDigest} — even though nothing is
 *   persisted. It is a **drift digest, not a seal**: FNV-1a is not
 *   cryptographic and a determined forger can collide it. It catches the
 *   accident, which is the failure mode that actually happens.
 * - **`durability: 'in-memory'` on the record, and a store to put a copy in.**
 *   A snapshot object lives in this process; that is what `durability` is
 *   about, and it does not change when a copy of it is also written to a
 *   table. Two reasons once stood between this package and a store and both
 *   are gone. GAP-30 went first: `SlotSchema` and `AssignmentSchema` normalised
 *   through `z.coerce.date()`, so a snapshot round-tripped through them came
 *   back with its wall-clock times reinterpreted in the host timezone — the
 *   parity checker causing the divergence it exists to detect. Those schemas
 *   now refuse a naive wall reading. GAP-29 went second:
 *   {@link import('./serialise.js').serialisePublicationSnapshot} and
 *   {@link import('./serialise.js').readPublicationSnapshot} are the
 *   persistence seam, and `public.publication_baselines`
 *   (`20260920000000_publication_baselines.sql`) **stores through it** —
 *   `frontend/src/hooks/usePublicationBaselines.js` serialises into
 *   `admin_publish_schedule_baseline()` and reads back through the same pair.
 *   The sentence is checkable rather than decorative, and it is checked the
 *   same way its predecessor was: `tests/publicationParity.test.js` enumerates
 *   the repository, and where it once required **no** production caller it now
 *   requires exactly the ones named here. Remove the writer and the finding's
 *   message becomes false and the test goes red, which is the direction the
 *   guard has to point once the store exists.
 *
 *   `externalImport`'s seam and `fieldAdmin`'s are unchanged: both still store
 *   through nothing, and both still say so.
 *
 * ## Not the teaming snapshot
 *
 * `packages/core/src/teamSnapshot.js` already owns the word "published" for
 * teaming, with its own `SnapshotStatus` of `draft | review | published |
 * locked` over roster drafts. This module never touches it, shares no type with
 * it, and is qualified `Publication…` throughout so the two cannot be confused
 * in an import list.
 *
 * @module publication/snapshot
 */

import { SCHEDULE_EXPORT_COLUMNS } from '../outputGeneration.js';

import {
  PUBLICATION_DURABILITY,
  PUBLICATION_REASON,
  createPublicationMeta,
  derivePublicationStatus,
  makePublicationFinding,
} from './reasonCodes.js';
import { PublicationSnapshotInputSchema } from './schemas.js';

/**
 * Deep-freeze a value, in place.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 2166136261;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 16777619;

/**
 * One 32-bit FNV-1a pass over a string, from a stated seed.
 *
 * @param {string} text
 * @param {number} seed
 * @returns {number} an unsigned 32-bit integer
 */
function fnv1a(text, seed) {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * A content digest over an artifact's rows.
 *
 * Canonicalised as the rows' cells **in the declared column order**, so that a
 * row object whose keys were inserted in a different order digests the same and
 * a row whose contents changed does not. Two FNV-1a passes from different seeds
 * are concatenated into 16 hex characters.
 *
 * Not cryptographic, and the module header says so plainly. It detects the
 * artifact that drifted, not the artifact somebody forged.
 *
 * @param {ReadonlyArray<string>} columns
 * @param {ReadonlyArray<Record<string, string>>} rows
 * @returns {string} 16 lowercase hex characters
 */
export function publicationDigest(columns, rows) {
  const canonical = JSON.stringify(rows.map((row) => columns.map((column) => row[column] ?? '')));
  const high = fnv1a(canonical, FNV_OFFSET);
  const low = fnv1a(canonical, FNV_OFFSET ^ 0x5bf03635);
  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

/**
 * Take an immutable, timestamped snapshot of a published artifact.
 *
 * @param {Object} input
 * @param {string} input.snapshotId
 * @param {string} input.label - what was published, in words
 * @param {string} input.channel - where it went
 * @param {string} input.publishedAt - naive `YYYY-MM-DDTHH:MM:SS`, supplied by the caller
 * @param {string} input.publishedBy - who published it
 * @param {ReadonlyArray<Record<string, string>>} input.rows
 * @param {ReadonlyArray<string>} [input.columns] - defaults to the export vocabulary
 * @param {string|null} [input.notes]
 * @returns {{ snapshot: import('./types.js').PublicationSnapshot, findings: import('./types.js').PublicationFinding[], status: string, meta: import('./types.js').PublicationMeta }}
 */
export function makePublicationSnapshot(input) {
  const parsed = PublicationSnapshotInputSchema.parse({
    columns: SCHEDULE_EXPORT_COLUMNS,
    ...input,
  });

  const meta = createPublicationMeta();
  const columns = Object.freeze([...parsed.columns]);
  // Copies, not references: the snapshot must outlive whatever produced these
  // rows without ever changing when that thing changes.
  const rows = Object.freeze(
    parsed.rows.map((row) => {
      meta.snapshotRowsFrozen += 1;
      /** @type {Record<string, string>} */
      const copy = {};
      for (const column of columns) copy[column] = String(row[column]);
      return Object.freeze(copy);
    })
  );

  const digest = publicationDigest(columns, rows);
  meta.snapshotsCreated = 1;

  const snapshot = /** @type {import('./types.js').PublicationSnapshot} */ (
    deepFreeze({
      snapshotId: parsed.snapshotId,
      label: parsed.label,
      channel: parsed.channel,
      publishedAt: parsed.publishedAt,
      publishedBy: parsed.publishedBy,
      notes: parsed.notes,
      columns,
      rows,
      rowCount: rows.length,
      digest,
      durability: PUBLICATION_DURABILITY.IN_MEMORY,
    })
  );

  /** @type {import('./types.js').PublicationFinding[]} */
  const findings = [
    makePublicationFinding(
      PUBLICATION_REASON.SNAPSHOT_CREATED,
      `snapshot "${parsed.snapshotId}" froze ${rows.length} row(s) of "${parsed.label}" published to ${parsed.channel} at ${parsed.publishedAt} by ${parsed.publishedBy}`,
      {
        snapshotId: parsed.snapshotId,
        channel: parsed.channel,
        publishedAt: parsed.publishedAt,
        publishedBy: parsed.publishedBy,
        rowCount: rows.length,
        digest,
      }
    ),
    makePublicationFinding(
      PUBLICATION_REASON.SNAPSHOT_IN_MEMORY_ONLY,
      `snapshot "${parsed.snapshotId}" is an in-memory record and is lost when this process ends unless a copy is stored; serialisePublicationSnapshot() writes it through admin_publish_schedule_baseline() into public.publication_baselines, and readPublicationSnapshot() reads it back (GAP-29)`,
      { snapshotId: parsed.snapshotId, durability: PUBLICATION_DURABILITY.IN_MEMORY }
    ),
  ];

  return { snapshot, findings, status: derivePublicationStatus(findings), meta };
}

/**
 * Does this snapshot's stored digest still describe its rows?
 *
 * **Exported and given the snapshot rather than closing over the creation
 * path** for the same reason `publicationCoverageFindings()` is: a check nobody
 * can make fail is not a check. A test hands this a snapshot whose rows were
 * replaced and watches `SNAPSHOT_DIGEST_MISMATCH` fire.
 *
 * @param {import('./types.js').PublicationSnapshot} snapshot
 * @returns {import('./types.js').PublicationFinding[]}
 */
export function verifySnapshotDigest(snapshot) {
  const recomputed = publicationDigest(snapshot.columns, snapshot.rows);
  if (recomputed === snapshot.digest) return [];
  return [
    makePublicationFinding(
      PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH,
      `snapshot "${snapshot.snapshotId}" carries digest ${snapshot.digest} but its ${snapshot.rows.length} row(s) digest to ${recomputed}, so it is no longer the artifact that was published`,
      { snapshotId: snapshot.snapshotId, stored: snapshot.digest, recomputed }
    ),
  ];
}

/**
 * The rows of a `publicationRowsFor()` result, in the shape a snapshot takes.
 *
 * A three-line adapter rather than a second projection: `reserve/publication.js`
 * already turns reserved slots and TIME TBD fixtures into export-vocabulary
 * rows, and this drops the per-row provenance it carries alongside them.
 *
 * @param {{ rows: ReadonlyArray<{ row: Record<string, string> }> }} publication
 * @returns {Record<string, string>[]}
 */
export function snapshotRowsFromPublication(publication) {
  return publication.rows.map((entry) => ({ ...entry.row }));
}
