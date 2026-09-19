/**
 * **The persistence seam `snapshot.js` used to say did not exist.**
 *
 * Until 2026-09-19 this package's position was the third of three. Its two
 * siblings each declared a `serialise*()` / `read*()` document pair and
 * reported that nothing stores through it —
 * `externalImport/mapping.js` with `EXTERNAL_MAPPING_NOT_PERSISTED`,
 * `fieldAdmin/serialise.js` with `REGISTRY_NOT_PERSISTED` — while this one
 * reported `SNAPSHOT_IN_MEMORY_ONLY` and said in `snapshot.js` that *"there is
 * no persistence seam to store through"* at all. Three subsystems in the same
 * situation, saying three different things about it. This file makes the
 * situation one situation; the situation itself is unchanged, and
 * {@link import('./snapshot.js').makePublicationSnapshot} still says so on
 * every snapshot it takes.
 *
 * ## What is claimed for it, and what is not
 *
 * Claimed: a snapshot survives `serialise -> read -> serialise` byte-identically,
 * validated by {@link import('./schemas.js').PublicationSnapshotDocumentSchema}
 * **in both directions**, through a document holding no `Date`, no `Map` and no
 * function. A document this module cannot read back is not a document, and
 * finding that out at write time is the difference between a failing test and a
 * corrupt store.
 *
 * Not claimed: that this is how a store will be reached. `docs/MODEL_GAPS.md`
 * GAP-29's own record earns the opposite rule — the one package here that
 * actually got persistence (`fieldAdmin`, `field_blackouts`) **bypassed its own
 * seam entirely** and went table + RPC + RLS + audit, as CLAUDE.md requires.
 * Read this pair as a declaration that a store is missing, and as the shape of
 * the value such a store would hold, not as the interface it will use.
 *
 * ## Row order: the one place this seam does not follow its siblings
 *
 * `fieldAdmin` and (since the same date) `externalImport` sort their records by
 * id in code-unit order, through the shared comparator in
 * `../documentOrder.js`, because a registry is a set and two orderings of it are
 * one registry. **A publication snapshot is not a set.** Its rows carry no id,
 * and their order is *inside* {@link import('./snapshot.js').publicationDigest},
 * which canonicalises cells by column and rows by position. Sorting them here
 * would write a document that no longer digests to the digest it carries — the
 * seam corrupting the drift detector it exists to serve.
 *
 * So the rule this seam adopts from its siblings is the half that applies:
 * **cells sit in the declared column order**, so two snapshots that differ only
 * in key insertion order serialise to the same bytes. That normalisation is
 * `makePublicationSnapshot()`'s, done once on the way in and not repeated here;
 * the end-to-end property is what the test asserts. The half that does not
 * apply - sorting the rows - is stated here rather than silently skipped.
 *
 * That leaves a real asymmetry on the record for whoever scopes the store: two
 * snapshots holding the same rows in a different order are the same table and
 * two different digests. Changing that means changing `publicationDigest()`,
 * which is load-bearing for `scenario/` fingerprints as well, and is not this
 * unit of work.
 *
 * @module publication/serialise
 */

import { derivePublicationStatus } from './reasonCodes.js';
import {
  PUBLICATION_SNAPSHOT_DOCUMENT_VERSION,
  PublicationSnapshotDocumentSchema,
} from './schemas.js';
import { makePublicationSnapshot, verifySnapshotDigest } from './snapshot.js';

/**
 * **Serialise a snapshot** into the only shape a store would hold.
 *
 * Validated on the way out as well as on the way in, for the reason
 * `serialiseExternalMappingRegistry()` states.
 *
 * @param {import('./types.js').PublicationSnapshot} snapshot
 * @returns {Object} a `PublicationSnapshotDocumentSchema` value
 */
export function serialisePublicationSnapshot(snapshot) {
  const document = {
    version: PUBLICATION_SNAPSHOT_DOCUMENT_VERSION,
    snapshotId: snapshot.snapshotId,
    label: snapshot.label,
    channel: snapshot.channel,
    publishedAt: snapshot.publishedAt,
    publishedBy: snapshot.publishedBy,
    notes: snapshot.notes,
    columns: [...snapshot.columns],
    // Plain copies. The cells are **already** in declared column order:
    // `makePublicationSnapshot()` builds every row by walking `columns`, and
    // re-walking them here would be a second canonicaliser whose failure case
    // no input can reach - a branch that cannot be made to fail is not a
    // safeguard. The property is asserted end to end instead, in
    // `tests/publicationParity.test.js`: two snapshots of one artifact whose
    // rows differ only in key insertion order serialise to one document.
    rows: snapshot.rows.map((row) => ({ ...row })),
    digest: snapshot.digest,
  };
  return /** @type {Object} */ (PublicationSnapshotDocumentSchema.parse(document));
}

/**
 * **Read a snapshot back** out of a document.
 *
 * Re-runs every construction check, so a document edited by hand — or by a
 * store with its own opinions — is refused or reported exactly as a fresh input
 * would be. There is no fast path that trusts a document because this module
 * wrote it.
 *
 * **Two classes of corruption, two behaviours**, following
 * `readExternalMappingRegistry()` rather than inventing a third answer:
 *
 * - **Structural** — a wrong `version`, a missing field, an undeclared extra
 *   field, a row not written in the document's own column vocabulary — throws
 *   out of the schema. A document from another version is not a snapshot that
 *   needs reporting on, it is bytes nobody here can explain.
 * - **Content** — the rows no longer digest to the digest the document carries
 *   — is reported as {@link import('./reasonCodes.js').PUBLICATION_REASON.SNAPSHOT_DIGEST_MISMATCH}
 *   at `blocking`, through the *same* {@link verifySnapshotDigest} the in-memory
 *   path uses. There is no second digest comparison in this repository, and the
 *   returned snapshot carries the digest of the rows actually read rather than
 *   the claim that failed.
 *
 * @param {unknown} rawDocument
 * @returns {ReturnType<typeof makePublicationSnapshot>}
 */
export function readPublicationSnapshot(rawDocument) {
  const document = /** @type {any} */ (PublicationSnapshotDocumentSchema.parse(rawDocument));
  const rebuilt = makePublicationSnapshot({
    snapshotId: document.snapshotId,
    label: document.label,
    channel: document.channel,
    publishedAt: document.publishedAt,
    publishedBy: document.publishedBy,
    notes: document.notes,
    columns: document.columns,
    rows: document.rows,
  });
  rebuilt.meta.snapshotsRead = 1;

  // The stored claim, checked against the rows that arrived. Handing
  // `verifySnapshotDigest()` the rebuilt snapshot wearing the document's digest
  // is what keeps the comparison in one place: it recomputes over
  // `columns`/`rows` exactly as it does for an in-memory snapshot.
  const findings = [
    ...rebuilt.findings,
    ...verifySnapshotDigest({ ...rebuilt.snapshot, digest: document.digest }),
  ];

  return {
    snapshot: rebuilt.snapshot,
    findings,
    status: derivePublicationStatus(findings),
    meta: rebuilt.meta,
  };
}
