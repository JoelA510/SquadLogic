/**
 * Zod schemas for publication snapshots, field-name mapping rules, parity
 * subjects and downstream sync destinations.
 *
 * `.strict()` throughout, matching every module since Phase 1.
 *
 * Three refusals here are load-bearing rather than tidy, and each has a
 * failure behind it:
 *
 * 1. **`publishedAt` and `publishedBy` have no defaults.** A snapshot that
 *    stamps itself with the current clock and an actor of `'system'` carries
 *    two fields that read as an audit trail and are not one. Timestamps are
 *    inputs in this repository; constructing a `Date` is banned in this package.
 * 2. **`destinationSyncedAt` is nullable but never optional.** Omitting it must
 *    be a decision somebody wrote down, because the alternative — assuming a
 *    destination is fresh — is precisely how a stale pointer publishes
 *    plausible-looking wrong data with no error anywhere.
 * 3. **A mapping rule may not touch `date` or `startMinutes`.** Field-name
 *    mapping translates *labels* the public view spells differently. A rule
 *    that rewrote a kickoff would be a schedule edit wearing a translation
 *    layer's clothes, and the parity report would then agree with itself.
 *
 * @module publication/schemas
 */

import { z } from 'zod';

import { PARITY_FIELD, PARITY_FIELD_ORDER } from './rows.js';
import { SYNC_DESTINATION_KIND } from './reasonCodes.js';

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/**
 * A naive wall-clock stamp, `YYYY-MM-DDTHH:MM:SS`.
 *
 * No offset and no `Z`, and no `Date` is ever constructed from it: two stamps
 * are ordered by comparing their text, which is total and exact for this
 * format. The consequence is stated rather than hidden — every stamp in one
 * report must come from **one clock**, because a naive stamp carries no zone
 * to reconcile against another (GAP-30). Same format
 * `reserve/publication.js` `naiveDateTime()` renders.
 */
export const PublicationStampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, {
  message: 'expected a naive YYYY-MM-DDTHH:MM:SS stamp with no timezone offset',
});

/**
 * The fields a name-mapping rule may read or write.
 *
 * Labels only. See this module's header for why `date` and `startMinutes` are
 * absent.
 *
 * @type {ReadonlyArray<string>}
 */
export const MAPPABLE_PARITY_FIELDS = Object.freeze(
  PARITY_FIELD_ORDER.filter(
    (field) => field !== PARITY_FIELD.DATE && field !== PARITY_FIELD.START_MINUTES
  )
);

/** A `{ field: label }` record over mappable fields only. */
const LabelPatchSchema = z
  .record(z.string(), z.string())
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'a mapping rule that names no field is not a rule',
  })
  .refine((patch) => Object.keys(patch).every((key) => MAPPABLE_PARITY_FIELDS.includes(key)), {
    message: `mapping rules may only read or write ${MAPPABLE_PARITY_FIELDS.join(', ')}`,
  });

/**
 * One field-name mapping rule: what the other side calls it, and what it is
 * called here.
 *
 * `match` is an exact-label test over one or more fields; `set` is what those
 * fields become. `set` may write a field `match` did not read — the corpus's
 * public venue label `Alder Park (Back Pitch 2)` carries a venue *and* a field
 * in one cell, and splitting it is the mapping.
 *
 * `provenance` is mandatory and is the reason this is a record rather than a
 * lookup table: a rule has to be able to say where its labels came from, so
 * that a rule for a label nobody uses any more can be recognised as one.
 */
export const MappingRuleSchema = z
  .object({
    id: IdSchema,
    /**
     * Which side's labels this rule translates. The published or externally
     * sourced artifact by default: it is the copy written in somebody else's
     * vocabulary.
     */
    appliesTo: z.enum(['published', 'current']).default('published'),
    match: LabelPatchSchema,
    set: LabelPatchSchema,
    provenance: z
      .string()
      .min(1, { message: 'a mapping rule must say where its labels came from' }),
  })
  .strict();

/** One row of a published artifact, in its declared column vocabulary. */
const ArtifactRowSchema = z.record(z.string(), z.string());

/**
 * The input to {@link import('./snapshot.js').makePublicationSnapshot}.
 *
 * `rows.min(1)` for the reason `reserve/schemas.js` refuses a capacity report
 * over zero dates: a snapshot of nothing would satisfy every later parity check
 * having published nothing, which is incident 4 wearing a publication badge.
 */
export const PublicationSnapshotInputSchema = z
  .object({
    snapshotId: IdSchema,
    /** What was published, in words. */
    label: z.string().min(1),
    /** Where it went — the audit trail's *where*. */
    channel: z.string().min(1, { message: 'a snapshot must say where it was published' }),
    /** When, as a naive stamp supplied by the caller. Never self-stamped. */
    publishedAt: PublicationStampSchema,
    /** By whom. An actor identifier, not a person's contact details. */
    publishedBy: z.string().min(1, { message: 'a snapshot must say who published it' }),
    columns: z.array(z.string().min(1)).min(1),
    rows: z.array(ArtifactRowSchema).min(1, {
      message: 'a snapshot of zero rows is not a publication',
    }),
    notes: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((input, ctx) => {
    // A row that is missing a declared column, or carries one the vocabulary
    // does not declare, is not written in the vocabulary the snapshot claims —
    // and a parity run against it would compare cells that are not there.
    const declared = new Set(input.columns);
    input.rows.forEach((row, index) => {
      for (const column of input.columns) {
        if (!(column in row)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rows', index],
            message: `row ${index} is missing the declared column "${column}"`,
          });
        }
      }
      for (const column of Object.keys(row)) {
        if (!declared.has(column)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rows', index],
            message: `row ${index} carries "${column}", which the snapshot's columns do not declare`,
          });
        }
      }
    });
  });

/**
 * Bumped when the document shape changes in a way a reader must know about.
 *
 * Declared here beside the schema that pins it rather than in `serialise.js`,
 * so the literal in {@link PublicationSnapshotDocumentSchema} and the stamp the
 * writer writes are the same constant. `externalImport` keeps the two apart
 * (`MAPPING_DOCUMENT_VERSION` in `mapping.js`, `z.literal(1)` in its schema) and
 * `fieldAdmin` keeps them together; one constant is the reading under which the
 * two cannot disagree.
 */
export const PUBLICATION_SNAPSHOT_DOCUMENT_VERSION = 1;

/**
 * **The serialised form of a snapshot** — the persistence seam, and the only
 * shape a store would ever hold.
 *
 * Deliberately the same field names as the snapshot itself plus a `version`,
 * exactly as {@link import('../externalImport/schemas.js').MappingDocumentSchema}
 * is, so that reading a document is validation rather than translation.
 * Everything in it is a JSON primitive: no `Date`, no `Map`, no function.
 *
 * ## The two snapshot fields this document drops, and the one it keeps anyway
 *
 * - **`durability`.** It describes the record in this process, not the
 *   document. A stored document that carried `in-memory` would be asserting a
 *   durability it cannot know, and a read back into memory is `in-memory`
 *   again by construction — so the reader derives it rather than trusting it.
 * - **`rowCount`.** `rows.length` is the same number, and a document carrying
 *   both invites the one case where they disagree.
 * - Nothing else. `digest` **is** carried, unlike the two sibling seams, and
 *   that is the one deliberate divergence: it is not a reconstruction input —
 *   the reader recomputes it — it is the stored claim the recomputation is
 *   checked against. Without it a document whose rows were edited in the store
 *   would be read back, re-digested from the edited rows, and agree with
 *   itself. `SNAPSHOT_DIGEST_MISMATCH` exists precisely to catch the artifact
 *   that drifted, and dropping the stored digest would be dropping the only
 *   thing it can be compared to.
 */
export const PublicationSnapshotDocumentSchema = z
  .object({
    version: z.literal(PUBLICATION_SNAPSHOT_DOCUMENT_VERSION),
    snapshotId: IdSchema,
    label: z.string().min(1),
    channel: z.string().min(1),
    publishedAt: PublicationStampSchema,
    publishedBy: z.string().min(1),
    notes: z.string().min(1).nullable(),
    columns: z.array(z.string().min(1)).min(1),
    rows: z.array(ArtifactRowSchema).min(1),
    /** The digest the snapshot carried when it was written. See above. */
    digest: z.string().regex(/^[0-9a-f]{16}$/, {
      message: 'expected 16 lowercase hex characters from publicationDigest()',
    }),
  })
  .strict();

/**
 * One destination that consumes this schedule.
 *
 * `destinationSyncedAt` is `nullable()` and **not** `optional()`: the key must
 * be present, so "we do not know when this last synced" is something a caller
 * wrote down rather than something a default invented.
 */
export const SyncDestinationSchema = z
  .object({
    destinationId: IdSchema,
    /** What it is called, for an operator. */
    name: z.string().min(1),
    kind: z.enum(Object.values(SYNC_DESTINATION_KIND)),
    /** Which artifact it consumes — the master export, a per-team feed, a file. */
    consumes: z.string().min(1, { message: 'a destination must say what it consumes' }),
    /** When it last took a copy, as a naive stamp. `null` means never/unknown. */
    destinationSyncedAt: PublicationStampSchema.nullable(),
    /** Who to talk to. An owning role or team, not a person's contact details. */
    owner: z.string().min(1).nullable().default(null),
  })
  .strict();

/**
 * A team the notice builder enumerates from.
 *
 * The universe comes from the roster, never from the changed rows: a team whose
 * game vanished produces no changed row, so a builder that grouped from rows
 * would leave the family with the worst news with no notice at all.
 */
export const NoticeTeamSchema = z
  .object({
    teamId: IdSchema,
    teamName: z.string().min(1),
    division: z.string().min(1).nullable().default(null),
    /** Contact columns are excluded from notices unless a caller names the flag. */
    coachName: z.string().min(1).nullable().default(null),
    coachEmail: z.string().min(1).nullable().default(null),
  })
  .strict();
