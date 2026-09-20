/**
 * The mapping layer: foreign names to our ids, as **records** rather than as a
 * function.
 *
 * ## The naming trap this module is built around
 *
 * `external_fixtures_published.csv` names its ground `Alder Park (Back Pitch 2)`.
 * The club files that as venue `Alder Park`, field `Pitch 2`. A matcher that
 * treats `Back` as decoration — strip the parenthetical, drop the leading word,
 * fuzzy-match the rest — gets Alder Park right on all eight rows, which is
 * exactly what makes it dangerous. The same matcher applied at Maplewood is
 * **wrong**: `facility_geometry.json` declares `Maplewood Back` and
 * `Maplewood Front` as two separate venues, each carrying a `Field 1`, and
 * `facility/adapters/season2026Geometry.js` records that they form one *complex*
 * for travel purposes only — spelled out rather than derived, with the comment
 * *"a shared first word is not a fact about geography"*.
 *
 * So this module has exactly one normalisation, {@link normaliseExternalLabel},
 * and it removes **no word from any label**. It trims, collapses runs of
 * whitespace to one space, and case-folds. Those three are typography: two
 * people typing the same name differ that way, and nobody means a different
 * pitch by it. Everything else — `Back`, `Front`, `Upper`, a parenthetical, a
 * numeral — is treated as part of the name, because in this corpus at least one
 * of them is. A label with no record is
 * {@link import('./reasonCodes.js').EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_LABEL_UNRESOLVED}
 * at **blocking**, naming the label and every key the registry does hold.
 *
 * The consequence is stated so nobody re-derives it as a bug: this registry
 * **cannot** resolve a label nobody has written a record for, including one that
 * differs from a known label by a single word. That is the design. The
 * alternative — resolving it "because it usually works" — is how `Maplewood
 * Back` becomes `Maplewood Front` in silence, on a corpus where the two are five
 * minutes apart and hold different formats.
 *
 * ## Persistence: a seam, declared, and deliberately unwired
 *
 * The build plan's own record (`docs/BUILD_PLAN_STATUS.md` §3) says **nothing in
 * phases 1-7 is persisted**, and this registry's own stored half is
 * [GAP-34](../../../../docs/MODEL_GAPS.md#gap-34) — not GAP-29, which keeps the
 * published baseline and was never the mapping registry's home (the citation
 * here said GAP-29 until the 2026-09-19 scope ruling corrected it). GAP-30 used to be
 * the other half of this sentence: `z.coerce.date()` in
 * `SlotSchema`/`AssignmentSchema` meant a registry stored through a
 * timezone-lossy layer came back describing different ground after DST ends —
 * and this module's whole job is to detect a difference between two artifacts,
 * so a store that *created* one would be the parity defect
 * `publication/index.js` refuses for the same reason. **GAP-30 is closed.**
 * Those schemas refuse a naive wall reading and `timing/seasonClock.js` is the
 * one place a wall time becomes an instant, so the remaining blocker is GAP-34
 * alone.
 *
 * What is built here instead, and what is claimed for it:
 *
 * - the registry is **in memory**, and says so on the record
 *   (`durability: 'in-memory'`, the shape `PublicationSnapshot.durability` uses);
 * - {@link serialiseExternalMappingRegistry} and
 *   {@link readExternalMappingRegistry} are the seam. They move a registry
 *   through a JSON document containing **no `Date`, no `Map` and no function**,
 *   validated by {@link import('./schemas.js').MappingDocumentSchema} in both
 *   directions;
 * - the round trip is an identity — `serialise(read(serialise(r)))` is
 *   byte-identical to `serialise(r)` — and that is asserted over the corpus
 *   registry, because it is the property a store needs and the one GAP-30 used
 *   to threaten;
 * - every registry publishes
 *   {@link import('./reasonCodes.js').EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_NOT_PERSISTED}
 *   at `info`, so no report can imply durability this module does not have.
 *
 * There is **no SQL migration** and no storage adapter. Wiring one is a
 * different unit of work with a different review, and writing the columns now
 * would be inventing the store this seam exists to defer.
 *
 * @module externalImport/mapping
 */

import { sortRecordsById } from '../documentOrder.js';
import { getSurface } from '../facility/facilityGraph.js';

import {
  EXTERNAL_IMPORT_REASON,
  EXTERNAL_NAME_RESOLUTION,
  assertExternalImportFindings,
  createExternalImportMeta,
  deriveExternalImportStatus,
  makeExternalImportFinding,
} from './reasonCodes.js';
import { ExternalMappingRegistryInputSchema, MappingDocumentSchema } from './schemas.js';

/**
 * The two kinds of name a record translates.
 *
 * @readonly
 * @enum {string}
 */
export const EXTERNAL_MAPPING_KIND = Object.freeze({
  /** A ground label. Carries both a venue id and a surface id. */
  VENUE: 'venue',
  /** A team or club label. Carries a subject id. */
  PARTICIPANT: 'participant',
});

/**
 * **Which artifact a label lookup was made about.**
 *
 * The ledger's question is *"did the imported publication use this record"*, so
 * a lookup has to say whose label it was resolving. Both sides go through the
 * same resolver — that is the fix for a key that used to be computed two
 * different ways — but they are not the same evidence: canonicalising our own
 * fixture's `homeLabel` through the registry tells you nothing about whether the
 * publication we are judging ever mentioned that record.
 *
 * Folding the two together silences
 * {@link import('./reasonCodes.js').EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_REGISTRY_UNEXERCISED},
 * which is blocking and is incident 4's shape; keeping our side out of the
 * ledger entirely loses the ability to say *why* a record looks unexercised.
 * So it is counted, apart, and named.
 *
 * @readonly
 * @enum {string}
 */
export const EXTERNAL_LOOKUP_SIDE = Object.freeze({
  /** A label the foreign artifact carries. The ledger's subject. */
  IMPORTED: 'imported-publication',
  /** A label from the schedule we hold, canonicalised for comparison. */
  OURS: 'the-fixtures-we-hold',
});

/**
 * Where a registry lives. One member, on purpose: adding a second is the change
 * that has to be reviewed, not a field that quietly gains values.
 *
 * @readonly
 * @enum {string}
 */
export const EXTERNAL_MAPPING_DURABILITY = Object.freeze({
  /** This process only. Gone when it exits. Stated on every registry. */
  IN_MEMORY: 'in-memory',
});

/** The document version this module writes and reads. */
export const MAPPING_DOCUMENT_VERSION = 1;

/**
 * **The one normalisation, and everything it does.**
 *
 * 1. trim leading and trailing whitespace;
 * 2. collapse every internal run of whitespace to one space;
 * 3. case-fold with `toLowerCase()`.
 *
 * It removes no word, no parenthesis, no punctuation and no digit. Each of the
 * three is a typographic difference between two people writing the same name;
 * none of them can turn one real ground into another. `Maplewood Back` and
 * `Maplewood Front` normalise to two different keys, which is the property the
 * test suite asserts against a deliberately-wrong resolver that strips
 * decoration and merges them.
 *
 * @param {string} label
 * @returns {string}
 */
export function normaliseExternalLabel(label) {
  if (typeof label !== 'string') {
    throw new TypeError(
      `externalImport: an external label must be a string, got ${JSON.stringify(label)}`
    );
  }
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The key a record is indexed under: its kind and its normalised label. Kind is
 * part of the key so a venue named like a team cannot answer a team lookup.
 *
 * @param {string} kind
 * @param {string} label
 * @returns {string}
 */
function mappingKey(kind, label) {
  return `${kind}|${normaliseExternalLabel(label)}`;
}

/**
 * What a record names, rendered for a message and for the ambiguity report.
 *
 * @param {import('./types.js').ExternalMappingRecord} record
 * @returns {string}
 */
function targetOf(record) {
  if (record.kind === EXTERNAL_MAPPING_KIND.VENUE) {
    return `${record.venueId ?? '?'}/${record.surfaceId ?? '?'}`;
  }
  return record.subjectId ?? '?';
}

/**
 * Structural findings about one record, independent of any run.
 *
 * @param {import('./types.js').ExternalMappingRecord} record
 * @param {import('../facility/types.js').FacilityGraph|null} graph
 * @returns {import('./types.js').ExternalImportFinding[]}
 */
function recordFindings(record, graph) {
  /** @type {import('./types.js').ExternalImportFinding[]} */
  const findings = [];
  const kinds = /** @type {string[]} */ (Object.values(EXTERNAL_MAPPING_KIND));
  if (!kinds.includes(record.kind)) {
    findings.push(
      makeExternalImportFinding(
        EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_TARGET_UNKNOWN,
        `mapping record ${record.id} declares kind ${JSON.stringify(record.kind)}, which is not one of ${kinds.join(', ')}`,
        { recordId: record.id, kind: record.kind, externalLabel: record.externalLabel }
      )
    );
    return findings;
  }

  if (record.kind === EXTERNAL_MAPPING_KIND.VENUE) {
    if (record.venueId === null || record.surfaceId === null) {
      findings.push(
        makeExternalImportFinding(
          EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_TARGET_UNKNOWN,
          `venue record ${record.id} for ${JSON.stringify(record.externalLabel)} must name both a venue and a surface; the external cell carries both and splitting it is the mapping`,
          {
            recordId: record.id,
            externalLabel: record.externalLabel,
            venueId: record.venueId,
            surfaceId: record.surfaceId,
          }
        )
      );
      return findings;
    }
    if (graph !== null) {
      const surface = getSurface(graph, record.surfaceId);
      if (!surface) {
        findings.push(
          makeExternalImportFinding(
            EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_TARGET_UNKNOWN,
            `venue record ${record.id} names surface ${JSON.stringify(record.surfaceId)}, which the facility graph does not have`,
            {
              recordId: record.id,
              externalLabel: record.externalLabel,
              surfaceId: record.surfaceId,
            }
          )
        );
      } else if (surface.venueId !== record.venueId) {
        findings.push(
          makeExternalImportFinding(
            EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_TARGET_UNKNOWN,
            `venue record ${record.id} pairs venue ${JSON.stringify(record.venueId)} with surface ${JSON.stringify(record.surfaceId)}, which the graph places at ${JSON.stringify(surface.venueId)}`,
            {
              recordId: record.id,
              externalLabel: record.externalLabel,
              venueId: record.venueId,
              surfaceId: record.surfaceId,
              graphVenueId: surface.venueId,
            }
          )
        );
      }
    }
    return findings;
  }

  if (record.subjectId === null) {
    findings.push(
      makeExternalImportFinding(
        EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_TARGET_UNKNOWN,
        `participant record ${record.id} for ${JSON.stringify(record.externalLabel)} names no subject`,
        { recordId: record.id, externalLabel: record.externalLabel }
      )
    );
  }
  return findings;
}

/**
 * **Build a registry.** Validating, index-building and self-checking; it never
 * reads a file and never writes one.
 *
 * The two structural checks it makes at construction, rather than leaving to a
 * lookup:
 *
 * - **key collision.** Two records whose labels normalise to one key and name
 *   *different* targets are `EXTERNAL_MAPPING_KEY_COLLISION` at blocking. Two
 *   that name the same target are a harmless duplicate and are reported at
 *   `info` through the unexercised path instead, because a table maintained by
 *   two people will have them and refusing the whole registry over one helps
 *   nobody.
 * - **target unknown.** With a `graph`, every venue record's surface is checked
 *   to exist and to sit at the venue the record pairs it with. Without one, that
 *   check is skipped — and the registry says so by simply not carrying the
 *   finding, which is why the season adapter always passes a graph.
 *
 * @param {Object} rawInput - see `ExternalMappingRegistryInputSchema`
 * @param {{ graph?: import('../facility/types.js').FacilityGraph|null }} [options]
 * @returns {import('./types.js').ExternalMappingRegistry}
 */
export function buildExternalMappingRegistry(rawInput, options = {}) {
  const input = /** @type {any} */ (ExternalMappingRegistryInputSchema.parse(rawInput));
  const graph = options.graph ?? null;
  const meta = createExternalImportMeta();
  /** @type {import('./types.js').ExternalImportFinding[]} */
  const findings = [];

  const records = /** @type {import('./types.js').ExternalMappingRecord[]} */ (input.records);
  meta.mappingRecordsDeclared = records.length;

  if (records.length === 0) {
    findings.push(
      makeExternalImportFinding(
        EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_REGISTRY_EMPTY,
        `mapping registry ${input.registryId} for ${input.party} declares no records; every label an import brings will be reported unresolved`,
        { registryId: input.registryId, party: input.party }
      )
    );
  }

  for (const record of records) findings.push(...recordFindings(record, graph));

  /** @type {Map<string, import('./types.js').ExternalMappingRecord[]>} */
  const byKey = new Map();
  for (const record of records) {
    const key = mappingKey(record.kind, record.externalLabel);
    if (!byKey.has(key)) byKey.set(key, []);
    /** @type {import('./types.js').ExternalMappingRecord[]} */ (byKey.get(key)).push(record);
  }

  for (const [key, claimants] of byKey) {
    if (claimants.length < 2) continue;
    const targets = [...new Set(claimants.map(targetOf))].sort();
    if (targets.length < 2) continue;
    findings.push(
      makeExternalImportFinding(
        EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_KEY_COLLISION,
        `${claimants.length} records normalise onto the key ${JSON.stringify(key)} and name ${targets.length} different targets (${targets.join(', ')}); one of them has to go, because a lookup cannot choose`,
        {
          normalisedKey: key,
          recordIds: claimants.map((record) => record.id).sort(),
          labels: [...new Set(claimants.map((record) => record.externalLabel))].sort(),
          targets,
        }
      )
    );
  }

  findings.push(
    makeExternalImportFinding(
      EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_NOT_PERSISTED,
      `mapping registry ${input.registryId} lives in memory only; serialiseExternalMappingRegistry() and readExternalMappingRegistry() are the declared persistence seam and nothing in this repository stores through it (GAP-34)`,
      {
        registryId: input.registryId,
        durability: EXTERNAL_MAPPING_DURABILITY.IN_MEMORY,
        recordCount: records.length,
      }
    )
  );

  assertExternalImportFindings(findings, `mapping registry ${input.registryId}`);

  return Object.freeze({
    registryId: input.registryId,
    label: input.label,
    party: input.party,
    records: Object.freeze(records.map((record) => Object.freeze({ ...record }))),
    durability: EXTERNAL_MAPPING_DURABILITY.IN_MEMORY,
    findings,
    status: deriveExternalImportStatus(findings),
    meta,
  });
}

/**
 * **Resolve one foreign label.** Three-valued, always; never a guess.
 *
 * @param {import('./types.js').ExternalMappingRegistry} registry
 * @param {string} kind - an {@link EXTERNAL_MAPPING_KIND} value
 * @param {string} label
 * @returns {import('./types.js').ExternalNameResolution}
 */
export function resolveExternalName(registry, kind, label) {
  const normalisedKey = normaliseExternalLabel(label);
  const claimants = registry.records.filter(
    (record) =>
      record.kind === kind && normaliseExternalLabel(record.externalLabel) === normalisedKey
  );
  const candidateRecordIds = claimants.map((record) => record.id).sort();
  const candidateTargets = [...new Set(claimants.map(targetOf))].sort();

  /** @type {import('./types.js').ExternalNameResolution} */
  const base = {
    kind,
    label,
    normalisedKey,
    state: EXTERNAL_NAME_RESOLUTION.UNRESOLVED,
    record: null,
    venueId: null,
    surfaceId: null,
    subjectId: null,
    candidateRecordIds,
    candidateTargets,
  };

  if (claimants.length === 0) return base;
  if (candidateTargets.length > 1) {
    return { ...base, state: EXTERNAL_NAME_RESOLUTION.AMBIGUOUS };
  }

  // One target, possibly named by several duplicate records. The first by id is
  // chosen so the answer is stable across input orderings; every claimant is
  // published in `candidateRecordIds` so nothing is hidden by the choice.
  const chosen = [...claimants].sort((a, b) => a.id.localeCompare(b.id))[0];
  return {
    ...base,
    state: EXTERNAL_NAME_RESOLUTION.RESOLVED,
    record: chosen,
    venueId: chosen.venueId,
    surfaceId: chosen.surfaceId,
    subjectId: chosen.subjectId,
  };
}

/**
 * **The reverse direction**, which the avoid-windows export needs: what does the
 * other party call this surface?
 *
 * Three-valued for the same reason as the forward direction, and the ambiguous
 * arm is a real possibility rather than a formality: two external labels naming
 * one of our surfaces is what happens when a league renames a pitch mid-season
 * and somebody writes the second record without deleting the first. Exporting
 * under either one would be picking, silently, which name the recipient reads.
 *
 * @param {import('./types.js').ExternalMappingRegistry} registry
 * @param {string} surfaceId
 * @returns {import('./types.js').ExternalNameResolution}
 */
export function reverseResolveSurface(registry, surfaceId) {
  const claimants = registry.records.filter(
    (record) => record.kind === EXTERNAL_MAPPING_KIND.VENUE && record.surfaceId === surfaceId
  );
  const candidateRecordIds = claimants.map((record) => record.id).sort();
  const candidateTargets = [...new Set(claimants.map((record) => record.externalLabel))].sort();

  /** @type {import('./types.js').ExternalNameResolution} */
  const base = {
    kind: EXTERNAL_MAPPING_KIND.VENUE,
    label: surfaceId,
    normalisedKey: surfaceId,
    state: EXTERNAL_NAME_RESOLUTION.UNRESOLVED,
    record: null,
    venueId: null,
    surfaceId: null,
    subjectId: null,
    candidateRecordIds,
    candidateTargets,
  };

  if (claimants.length === 0) return base;
  if (candidateTargets.length > 1) return { ...base, state: EXTERNAL_NAME_RESOLUTION.AMBIGUOUS };

  const chosen = [...claimants].sort((a, b) => a.id.localeCompare(b.id))[0];
  return {
    ...base,
    state: EXTERNAL_NAME_RESOLUTION.RESOLVED,
    record: chosen,
    venueId: chosen.venueId,
    surfaceId: chosen.surfaceId,
    subjectId: chosen.subjectId,
  };
}

/* -------------------------------------------------------------------------- */
/* Usage tracking — kept off the registry, which is frozen                     */
/* -------------------------------------------------------------------------- */

/**
 * A run's record of which mapping records actually fired.
 *
 * Deliberately not state on the registry: a registry is an immutable record set
 * and a lookup must not mutate it, or two concurrent imports would report each
 * other's usage. This is the caller's ledger, and the caller folds it into its
 * own findings.
 *
 * The two record sets are the two sides of {@link EXTERNAL_LOOKUP_SIDE}, kept
 * apart rather than unioned: `usedRecordIds` answers *"did the publication use
 * this record"*, which is the only question {@link mappingUsageFindings} is
 * entitled to answer, and `ourRecordIds` exists so a record that fired only
 * while canonicalising our own fixtures can be **said** to have done so instead
 * of appearing to have fired for the import.
 *
 * @returns {{ usedRecordIds: Set<string>, ourRecordIds: Set<string>, lookups: number, resolved: number, unresolved: number, unclaimedOptional: number, ambiguous: number, ourLookups: number, ourResolved: number }}
 */
export function createMappingUsage() {
  return {
    usedRecordIds: new Set(),
    ourRecordIds: new Set(),
    lookups: 0,
    resolved: 0,
    unresolved: 0,
    unclaimedOptional: 0,
    ambiguous: 0,
    ourLookups: 0,
    ourResolved: 0,
  };
}

/**
 * Fold one resolution into a usage ledger.
 *
 * `optional` says whether a record was **required** for this lookup. A venue
 * label is required: without a record the import cannot tell which ground the
 * other party means, and the row is undecidable. A participant label is not:
 * where no record claims it the label itself is the identity, which is the
 * normal case and is why the two are counted apart. Folding them together made
 * the season corpus report sixteen unresolved labels for a run in which every
 * required lookup resolved.
 *
 * `side` says whose label this was. The default is
 * {@link EXTERNAL_LOOKUP_SIDE.IMPORTED}, because every caller outside
 * `resolution.js`'s standing index is reading a foreign artifact. An `ours`
 * lookup touches **only** the two `our*` counters: it is not an unresolved
 * label, not an unclaimed-optional one, and not evidence that the publication
 * exercised anything. Counting it as any of those is what silenced
 * `EXTERNAL_MAPPING_REGISTRY_UNEXERCISED` and what would put a
 * `labelsUnclaimedOptional` on each of the hundred-odd standing labels no
 * external record was ever meant to claim.
 *
 * @param {ReturnType<typeof createMappingUsage>} usage
 * @param {import('./types.js').ExternalNameResolution} resolution
 * @param {{ optional?: boolean, side?: string }} [options]
 * @returns {import('./types.js').ExternalNameResolution} the same resolution
 */
export function recordMappingUse(usage, resolution, options = {}) {
  if (options.side === EXTERNAL_LOOKUP_SIDE.OURS) {
    usage.ourLookups += 1;
    if (resolution.state === EXTERNAL_NAME_RESOLUTION.RESOLVED) {
      usage.ourResolved += 1;
      if (resolution.record !== null) usage.ourRecordIds.add(resolution.record.id);
    }
    return resolution;
  }
  usage.lookups += 1;
  if (resolution.state === EXTERNAL_NAME_RESOLUTION.RESOLVED) {
    usage.resolved += 1;
    if (resolution.record !== null) usage.usedRecordIds.add(resolution.record.id);
  } else if (resolution.state === EXTERNAL_NAME_RESOLUTION.AMBIGUOUS) {
    usage.ambiguous += 1;
  } else if (options.optional === true) {
    usage.unclaimedOptional += 1;
  } else {
    usage.unresolved += 1;
  }
  return resolution;
}

/**
 * **The meta-assertion on the registry itself.**
 *
 * Incident 4 is a validator whose join matched zero records and reported a
 * perfect score. A registry against which not one label resolved is that exact
 * shape, and it is **blocking**: an import that translated nothing has not been
 * checked against our naming at all, whatever else its report says.
 *
 * An individual record that did not fire is `info`, not blocking, and the
 * difference is deliberate. A standing registry legitimately holds records for
 * grounds this particular publication does not use; a registry where *nothing*
 * fired is either pointed at the wrong party or has gone stale wholesale.
 *
 * **Both questions are asked of the imported side only.** A record consulted
 * while canonicalising our own fixtures has not been exercised *by the
 * publication*, and counting it as though it had is how this blocking finding
 * came to be silenced by a registry the import never touched. What our side did
 * is not discarded, though — it is what the message says instead of guessing.
 *
 * @param {import('./types.js').ExternalMappingRegistry} registry
 * @param {ReturnType<typeof createMappingUsage>} usage
 * @returns {{ findings: import('./types.js').ExternalImportFinding[], unexercised: import('./types.js').ExternalMappingRecord[] }}
 */
export function mappingUsageFindings(registry, usage) {
  /** @type {import('./types.js').ExternalImportFinding[]} */
  const findings = [];
  // Sorted, not filtered-in-place: a reported list whose order depends on how
  // the registry was assembled is the divergence `serialiseExternalMappingRegistry()`
  // was just brought into line about, one layer up.
  const unexercised = sortRecordsById(
    registry.records.filter((record) => !usage.usedRecordIds.has(record.id))
  );

  if (registry.records.length > 0 && usage.usedRecordIds.size === 0) {
    // Both halves of this sentence are read off the ledger rather than assumed
    // from which branch produced it: a run in which our own side did fire a
    // record says so, because "the import used nothing" and "nothing at all
    // happened" are different reports and only one of them is true here.
    const alsoOurs =
      usage.ourRecordIds.size > 0
        ? `; ${usage.ourRecordIds.size} of them did resolve a label of ours over ${usage.ourLookups} lookup(s) while canonicalising the fixtures we hold, which is not the publication using them`
        : '';
    findings.push(
      makeExternalImportFinding(
        EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_REGISTRY_UNEXERCISED,
        `not one of registry ${registry.registryId}'s ${registry.records.length} records resolved a label the imported publication brought, over ${usage.lookups} lookup(s) of its labels${alsoOurs}; a mapping that matched nothing has not checked anything`,
        {
          registryId: registry.registryId,
          recordCount: registry.records.length,
          lookups: usage.lookups,
          ourLookups: usage.ourLookups,
          recordsExercisedByOurSide: usage.ourRecordIds.size,
        }
      )
    );
  }

  for (const record of unexercised) {
    const firedOnOurSide = usage.ourRecordIds.has(record.id);
    findings.push(
      makeExternalImportFinding(
        EXTERNAL_IMPORT_REASON.EXTERNAL_MAPPING_RECORD_UNEXERCISED,
        firedOnOurSide
          ? `mapping record ${record.id} (${JSON.stringify(record.externalLabel)} -> ${targetOf(record)}) fired only while canonicalising the fixtures we hold; no row of the imported publication asked for it`
          : `mapping record ${record.id} (${JSON.stringify(record.externalLabel)} -> ${targetOf(record)}) did not fire in this run, on either side`,
        {
          recordId: record.id,
          externalLabel: record.externalLabel,
          target: targetOf(record),
          provenance: record.provenance,
          firedOnOurSide,
        }
      )
    );
  }

  return { findings, unexercised };
}

/* -------------------------------------------------------------------------- */
/* The persistence seam                                                        */
/* -------------------------------------------------------------------------- */

/**
 * **Serialise a registry** into the only shape a store would hold.
 *
 * The output is JSON primitives throughout — no `Date`, no `Map`, no function —
 * and its field order is fixed, so `JSON.stringify()` of two equal registries is
 * the same string. That is what makes the round-trip assertion in
 * `tests/externalFixtureImport.test.js` a real check rather than a deep-equal
 * that would pass on a lossy transform.
 *
 * ## Record order is a declared sort, not the caller's insertion order
 *
 * **This used to preserve insertion order, and its sibling did not.**
 * `fieldAdmin/serialise.js` — written after this file and explicitly modelled on
 * it — sorts by record id in code-unit order and documents byte-stability as a
 * rule, because a registry assembled in a different order is the same registry.
 * Two logically identical registries therefore produced two different documents
 * here and one document there. That difference is harmless while nothing stores
 * either, and stops being harmless the moment something does: a table is a set,
 * so "has this registry changed since we stored it?" answered by comparing
 * documents would report a re-ordered read as an edit.
 *
 * So the contract is the sibling's, unchanged in substance from
 * {@link import('../fieldAdmin/serialise.js').serialiseFieldRegistry}: sorted by
 * `id`, in **code-unit order** rather than `localeCompare`, because
 * `localeCompare` varies with the runtime's default locale and ICU build — and
 * these ids are full of the punctuation locales disagree about
 * (`season-2026/external/alder-back-pitch-2`).
 *
 * The consequence is stated rather than discovered: a registry read back from a
 * document carries its records in id order, which need not be the order the
 * registry that wrote it held them in. No **answer** changes — every lookup
 * filters and reports its claimants `.sort()`ed, which
 * `tests/externalFixtureImport.test.js` holds to a registry built in
 * deliberately reversed order. Two derived **orderings** did follow input
 * order, and both are named rather than glossed:
 *
 * - {@link mappingUsageFindings}'s `unexercised` list, which
 *   `classifyExternalImport()` republishes as `unexercisedRecords` along with
 *   one `EXTERNAL_MAPPING_RECORD_UNEXERCISED` finding each. That is a reported
 *   list, so it is now sorted by the same comparator — otherwise one registry
 *   would produce two differently-ordered reports depending on whether it had
 *   been through a document, which is the same false difference one layer up.
 * - The per-record structural findings {@link buildExternalMappingRegistry}
 *   emits at construction, which follow record order and therefore do differ.
 *   They are keyed by code and record id and nothing reads them positionally;
 *   sorting the whole finding stream would reorder unrelated codes against each
 *   other, which is a larger change than this one and not obviously right.
 *
 * @param {import('./types.js').ExternalMappingRegistry} registry
 * @returns {Object} an `MappingDocumentSchema` value
 */
export function serialiseExternalMappingRegistry(registry) {
  const document = {
    version: MAPPING_DOCUMENT_VERSION,
    registryId: registry.registryId,
    label: registry.label,
    party: registry.party,
    records: sortRecordsById(registry.records).map((record) => ({
      id: record.id,
      kind: record.kind,
      externalLabel: record.externalLabel,
      venueId: record.venueId,
      surfaceId: record.surfaceId,
      subjectId: record.subjectId,
      provenance: record.provenance,
      statedBy: record.statedBy,
      statedOn: record.statedOn,
      note: record.note,
    })),
  };
  // Validated on the way out as well as on the way in: a document this module
  // cannot read back is not a document, and finding that out at write time is
  // the difference between a failing test and a corrupt store.
  return /** @type {Object} */ (MappingDocumentSchema.parse(document));
}

/**
 * **Read a registry back** out of a document.
 *
 * Re-runs every construction check, so a document that has been edited by hand
 * — or by a store with its own opinions about dates — is refused or reported
 * exactly as a fresh input would be. There is no fast path that trusts a
 * document because this module wrote it.
 *
 * @param {unknown} rawDocument
 * @param {{ graph?: import('../facility/types.js').FacilityGraph|null }} [options]
 * @returns {import('./types.js').ExternalMappingRegistry}
 */
export function readExternalMappingRegistry(rawDocument, options = {}) {
  const document = /** @type {any} */ (MappingDocumentSchema.parse(rawDocument));
  return buildExternalMappingRegistry(
    {
      registryId: document.registryId,
      label: document.label,
      party: document.party,
      records: document.records,
    },
    options
  );
}
