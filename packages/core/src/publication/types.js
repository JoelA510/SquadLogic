/**
 * Types for publication snapshots, parity, change notices and the downstream
 * sync registry.
 *
 * JSDoc typedefs only — this file emits no runtime code.
 *
 * @module publication/types
 */

/**
 * One finding, in the shape every module in this repository uses.
 *
 * @typedef {Object} PublicationFinding
 * @property {string} code - a `PUBLICATION_REASON` value
 * @property {string} severity - a `PUBLICATION_SEVERITY` value, looked up from the frozen table
 * @property {string} message - for humans only; never parsed
 * @property {Record<string, unknown>} details - flat primitives and ids
 */

/**
 * Additive counters. See `createPublicationMeta()` for what each one means.
 *
 * @typedef {Object} PublicationMeta
 * @property {number} snapshotsCreated
 * @property {number} snapshotRowsFrozen
 * @property {number} snapshotsRead
 * @property {number} publishedRowsRead
 * @property {number} currentRowsRead
 * @property {number} rowsCompared
 * @property {number} rowsMatched
 * @property {number} rowsDiffering
 * @property {number} rowsAdded
 * @property {number} rowsRemoved
 * @property {number} fieldComparisons
 * @property {number} mappingRulesDeclared
 * @property {number} mappingRulesApplied
 * @property {number} rowsRewritten
 * @property {number} teamsEnumerated
 * @property {number} teamsWithChanges
 * @property {number} noticeLinesEmitted
 * @property {number} destinationsExamined
 * @property {number} destinationsStale
 * @property {number} destinationsNeverSynced
 */

/**
 * An immutable, timestamped copy of what was published.
 *
 * `rows` are frozen copies rather than references into whatever produced them,
 * `durability` says on the record that this lives in memory only, and `digest`
 * is a drift digest over `rows` in `columns` order — see `snapshot.js`.
 *
 * @typedef {Object} PublicationSnapshot
 * @property {string} snapshotId
 * @property {string} label - what was published, in words
 * @property {string} channel - where it went
 * @property {string} publishedAt - naive `YYYY-MM-DDTHH:MM:SS`, supplied by the caller
 * @property {string} publishedBy - who published it
 * @property {string|null} notes
 * @property {ReadonlyArray<string>} columns
 * @property {ReadonlyArray<Record<string, string>>} rows
 * @property {number} rowCount
 * @property {string} digest
 * @property {string} durability - a `PUBLICATION_DURABILITY` value
 */

/**
 * One row of a schedule, in the single normalised vocabulary every parity
 * comparison speaks.
 *
 * `null` means "this source does not carry that column" — never "empty" and
 * never "equal".
 *
 * @typedef {Object} ParityRow
 * @property {string} rowId - provenance; never keyed or compared
 * @property {string} sourceLabel - which artifact this came from
 * @property {string|null} date - `YYYY-MM-DD`
 * @property {number|null} startMinutes - minutes past local midnight
 * @property {string|null} venue
 * @property {string|null} field
 * @property {string|null} format
 * @property {string|null} division
 * @property {string|null} home
 * @property {string|null} away
 * @property {string|null} participant - the team a per-team export row is addressed to
 */

/**
 * One field-name mapping rule, as a record with provenance.
 *
 * @typedef {Object} MappingRule
 * @property {string} id
 * @property {string} appliesTo - `published` or `current`
 * @property {Record<string, string>} match - exact labels this rule recognises
 * @property {Record<string, string>} set - what those fields become
 * @property {string} provenance - where these labels came from
 */

/**
 * A mapping rule and how many times it fired. `applications: 0` is
 * `MAPPING_RULE_UNEXERCISED` at blocking.
 *
 * @typedef {MappingRule & { applications: number }} MappingRuleReport
 */

/**
 * Two rows that share an identity.
 *
 * `changedFields`, `before` and `after` are deliberately the same three names
 * `resolve/types.js` `ScheduleChange` uses, so a consumer of either reads the
 * same shape.
 *
 * @typedef {Object} ParityPair
 * @property {string} key
 * @property {string} label - `${home} v ${away}`
 * @property {ParityRow} publishedRow
 * @property {ParityRow} currentRow
 * @property {string[]} changedFields - empty for a matched pair
 * @property {string[]} absentFields - compared fields one side does not carry
 * @property {Record<string, unknown>} before - the published values of the compared fields
 * @property {Record<string, unknown>} after - the current values of the compared fields
 */

/**
 * A row with no counterpart on the other side.
 *
 * @typedef {Object} ParityOrphan
 * @property {string} key
 * @property {string} label
 * @property {ParityRow} row
 */

/**
 * An identity that names more than one row on a side.
 *
 * @typedef {Object} ParityKeyAmbiguity
 * @property {string} key
 * @property {number} publishedCount
 * @property {number} currentCount
 */

/**
 * The comparator's raw partition, before anything judges it.
 *
 * @typedef {Object} ParityPartition
 * @property {ParityPair[]} matched
 * @property {ParityPair[]} differing
 * @property {ParityOrphan[]} added
 * @property {ParityOrphan[]} removed
 * @property {ParityKeyAmbiguity[]} ambiguousKeys
 * @property {Array<{ key: string, field: string, side: string }>} absentFieldCells
 * @property {number} fieldComparisons
 */

/**
 * A judged parity comparison.
 *
 * @typedef {Object} ParityResult
 * @property {string} subject
 * @property {string} publishedLabel
 * @property {string} currentLabel
 * @property {string[]} keyFields
 * @property {string[]} comparedFields
 * @property {{ matched: ParityPair[], differing: ParityPair[], added: ParityOrphan[], removed: ParityOrphan[] }} buckets
 * @property {{ declared: number, applied: number, rules: MappingRuleReport[] }} mapping
 * @property {PublicationFinding[]} findings
 * @property {string} status
 * @property {PublicationMeta} meta
 */

/**
 * One line of a family-facing notice.
 *
 * @typedef {Object} ChangeNoticeEntry
 * @property {string} kind - a `NOTICE_CHANGE_KIND` value
 * @property {string} key
 * @property {string} label
 * @property {string[]} changedFields
 * @property {Record<string, unknown>|null} before - null for an addition
 * @property {Record<string, unknown>|null} after - null for a removal
 */

/**
 * Everything one team's families need to be told.
 *
 * @typedef {Object} ChangeNotice
 * @property {string} teamId
 * @property {string} teamName
 * @property {string|null} division
 * @property {ChangeNoticeEntry[]} changes
 * @property {{ coachName: string|null, coachEmail: string|null }|null} contact - null unless a caller opted in
 */

/**
 * @typedef {Object} ChangeNoticeResult
 * @property {string} subject
 * @property {ChangeNotice[]} notices
 * @property {number} teamsEnumerated - from the team universe, never from the changes
 * @property {boolean} includeContacts
 * @property {string} parityStatus - the standing of the parity this run was built from
 * @property {PublicationFinding[]} findings
 * @property {string} status
 * @property {PublicationMeta} meta
 */

/**
 * One destination's standing against the active snapshot.
 *
 * @typedef {Object} SyncDestinationStatus
 * @property {string} destinationId
 * @property {string} name
 * @property {string} kind - a `SYNC_DESTINATION_KIND` value
 * @property {string} consumes
 * @property {string|null} owner
 * @property {string|null} destinationSyncedAt - operator-supplied; nothing here observes it
 * @property {string} snapshotPublishedAt
 * @property {string} state - a `DESTINATION_STATE` value
 */

/**
 * @typedef {Object} SyncRegistryReport
 * @property {string} snapshotId
 * @property {string} snapshotPublishedAt
 * @property {SyncDestinationStatus[]} destinations
 * @property {PublicationFinding[]} findings
 * @property {string} status
 * @property {PublicationMeta} meta
 */

export {};
