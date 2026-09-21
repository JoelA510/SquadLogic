/**
 * Types for the change-request re-solver.
 *
 * JSDoc typedefs only — this file emits no runtime code.
 *
 * @module resolve/types
 */

/**
 * One game as the re-solver holds it: exactly the rule engine's
 * {@link import('../ruleEngine/types.js').ScheduledGame}, so a resolved state
 * converts back into a `Schedule` without a translation layer that could drift.
 *
 * @typedef {Object} PlacedGame
 * @property {string} id
 * @property {string} date
 * @property {number} startMinutes
 * @property {number|null} endMinutes
 * @property {string} venueId
 * @property {string} surfaceId
 * @property {string|null} format
 * @property {string|null} divisionLabel
 * @property {string|null} homeTeamId
 * @property {string|null} awayTeamId
 * @property {string} homeLabel
 * @property {string} awayLabel
 * @property {boolean} counted
 */

/**
 * Where a game may stand. Never invented: every slot comes from the baseline's
 * own inventory or from a change request that named it.
 *
 * @typedef {Object} Slot
 * @property {string} date
 * @property {string} surfaceId
 * @property {number} startMinutes
 */

/**
 * The one thing a stage may ask the writer to do.
 *
 * @typedef {Object} Move
 * @property {string} gameId
 * @property {'relocate'|'dislodge'|'time-tbd'} kind
 * @property {Slot|null} to - null for `dislodge` and `time-tbd`
 * @property {string} reason
 * @property {Record<string, unknown>} [cause] - why, in machine-readable form,
 *   from the machinery that decided. Omitted by a move that inherits its reason
 *   from an earlier one
 */

/**
 * One entry of the move ledger: what actually happened, in order.
 *
 * @typedef {Object} MoveRecord
 * @property {number} seq
 * @property {string} stageId
 * @property {string} gameId
 * @property {string} kind
 * @property {Slot|null} from
 * @property {Slot|null} to
 * @property {string} reason - a sentence for a human; never parsed
 * @property {Record<string, unknown>|null} cause - machine-readable: which
 *   reason codes, which registry constraints, which other games, which binding
 *   edge and how many minutes short. `report.js` reads this to name what forced
 *   a consequential move
 */

/**
 * The run-scoped recorder. **Deliberately mutable, and deliberately the only
 * mutable thing a stage can reach**: the placement state is deep-frozen and
 * replaced wholesale on every write, while counters, findings and the move log
 * accumulate here.
 *
 * @typedef {Object} ResolveLedger
 * @property {ResolveMeta} meta
 * @property {MoveRecord[]} moves
 * @property {import('../freeze/types.js').FreezeFinding[]} findings
 * @property {Record<string, { considered: number, rejected: number, applied: number }>} byStage
 */

/**
 * Which slots the baseline schedule actually used. The anti-slot-inventor
 * guarantee lives here: nothing in this package can offer a game a date, a
 * surface or a kickoff that is not in this object.
 *
 * Frozen all the way down, and typed that way: the immutability is the
 * guarantee, not an implementation detail of how it happens to be built.
 *
 * @typedef {Object} SlotInventory
 * @property {ReadonlyArray<string>} dates
 * @property {Readonly<Record<string, string>>} venueBySurfaceId
 * @property {Readonly<Record<string, ReadonlyArray<number>>>} kickoffsByDateVenue - key `date|venueId`
 * @property {Readonly<Record<string, ReadonlyArray<string>>>} surfacesByDateVenueFormat - key `date|venueId|format`
 * @property {number} slotCount
 */

/**
 * The placement state. Deep-frozen except for `ledger`.
 *
 * @typedef {Object} ResolveState
 * @property {string[]} gameIds - every game in the run, sorted
 * @property {Record<string, PlacedGame>} games - the currently placed ones
 * @property {Record<string, PlacedGame>} baseline
 * @property {Record<string, string>} dispositions - gameId -> freeze disposition
 * @property {Record<string, string[]>} admittedSlotsByGameId - slots a change request brought
 * @property {Record<string, string>} pinnedAt - gameId -> the slot key it was frozen at mid-run by `pinGames()`; the position `freeze-audit` holds it to, in place of the baseline
 * @property {string[]} pending - dislodged, awaiting placement
 * @property {Array<{ gameId: string, reason: string }>} unplaced - TIME TBD
 * @property {SlotInventory} inventory
 * @property {ResolveLedger} ledger
 */

/**
 * A stage's freeze contract. Required, and required to be filled in: a stage
 * that says nothing about how it treats the freeze cannot be registered.
 *
 * @typedef {Object} FreezeContract
 * @property {string[]} mutationKinds - empty means "this stage writes nothing"
 * @property {'offers-frozen-move'|'writes-nothing'} probe
 * @property {string} claim - what this stage promises about frozen games
 */

/**
 * One stage of the pipeline.
 *
 * @typedef {Object} ResolveStage
 * @property {string} id
 * @property {string} title
 * @property {FreezeContract} freezeContract
 * @property {(state: ResolveState, context: Object) => ResolveState} run
 */

/**
 * What one stage did.
 *
 * @typedef {Object} StageResult
 * @property {string} stageId
 * @property {string} title
 * @property {string[]} declaredMutationKinds
 * @property {string} claim
 * @property {number} movesConsidered
 * @property {number} movesRejectedByFreeze
 * @property {number} movesApplied
 * @property {number} findingsEmitted
 */

/**
 * Everything either entry point accepts.
 *
 * @typedef {Object} ResolveInput
 * @property {import('../ruleEngine/types.js').Schedule} schedule - the baseline
 * @property {ReadonlyArray<Object>} [changes] - see `ScheduleChangeRequestSchema`
 * @property {Object} engines - `{ graph, table, calendar, registry, resources?, ruleEngine?, waiverLedger? }`
 * @property {import('../freeze/types.js').FreezePlan} [freeze] - omit for maximum freeze
 * @property {boolean} [holdChanges] - pin the changed games at the slots they were given
 * @property {'throw'|'report'} [onUnsatisfiable]
 * @property {ReadonlyArray<Object>} [extraStages] - inserted before `freeze-audit`
 * @property {Object|null} [baselineVerification] - a `runRuleEngine()` result over the baseline
 * @property {boolean} [verify] - false skips the rule-engine pass
 * @property {Record<string, number>} [objectiveWeights] - overrides for
 *   `RESOLVE_OBJECTIVE_WEIGHTS`; an unknown term is refused rather than ignored
 * @property {number|null} [changeBudget] - a hard cap on **moved games**,
 *   requested and consequential together. Since 8.6 it bounds the
 *   neighbourhood as well as judging the result: every relocation is checked
 *   against it before the writer sees it, so a run comes back within the cap
 *   and partially repaired rather than over it and refused whole. The
 *   irreducible core — the requested moves and the dislodges they force — is
 *   not gated and still reaches `RESOLVE_CHANGE_BUDGET_EXCEEDED` at blocking
 *   and a refusal at `commitResolve()`, which has no override
 * @property {ReadonlyArray<string>} [repairScope] - games whose current
 *   position this run repairs rather than accepts. Without it a run accepts
 *   whatever the schedule arrived carrying, which is right for a change
 *   request and blind to ground that has been withdrawn since publication.
 *   Naming a game the schedule does not hold throws. It does **not** thaw
 *   anything: the freeze is still the only authority on what may move, so a
 *   scope over frozen games reports rather than acts
 * @property {string} [name]
 * @property {string} [reason] - `reoptimiseWholeSeason()` only, and required there
 * @property {true} [acknowledged] - `reoptimiseWholeSeason()` only, and required there
 * @property {string} [requestedBy] - `reoptimiseWholeSeason()` only
 * @property {ReadonlyArray<Object>} [holdScopes] - `reoptimiseWholeSeason()` only: rules to hold parts of the season even under a thawed default
 */

/**
 * One requested change and what became of it — category (a) of the report.
 *
 * Enumerated from the **change request**, so a change that did not happen is
 * still in the list. "We ignored four of your eight fixtures" is the most
 * useful line a report can carry and a list built from what moved cannot
 * contain it.
 *
 * @typedef {Object} RequestedChange
 * @property {string} gameId
 * @property {string|null} label
 * @property {string|null} disposition
 * @property {string|null} requestedSlot
 * @property {string|null} before
 * @property {string|null} after
 * @property {string} outcome - `applied` | `displaced` | `refused` | `no-op` | `unplaced` | `unknown-game`
 * @property {boolean} moved
 * @property {string[]} personIds - whose day this is
 */

/**
 * One game that moved because something else did — **category (b), the one the
 * build plan says nobody notices until families complain**.
 *
 * Every field naming a cause is consumed from the move ledger, which the
 * deciding stage filled in from `checkPlacement()` (Phase 1.3 + the Phase 2.1
 * registry). A consequential move with `causeKind: null` is a bug and is
 * reported at blocking.
 *
 * @typedef {Object} ConsequentialChange
 * @property {string} gameId
 * @property {string} label
 * @property {string} disposition
 * @property {string} before
 * @property {string|null} after - null when it ended with no time at all
 * @property {string[]} changedFields
 * @property {string|null} causeKind - `constraint` | `global-reoptimisation`
 * @property {string|null} codes - the reason codes that forced it
 * @property {string|null} constraintId - the registry constraint, primary
 * @property {string[]} constraintIds
 * @property {string[]} counterpartGameIds - the specific games it clashed with
 * @property {string[]} bindingKinds - Phase 1.3's tightest edge
 * @property {number|null} slackMinutes - by how much it missed
 * @property {string|null} forcedByStageId
 * @property {string|null} reason
 * @property {string[]} personIds - whose day this is
 */

/**
 * The dry-run report: what would change, before anything is committed.
 *
 * @typedef {Object} ChangeReport
 * @property {string} name
 * @property {true} dryRun
 * @property {RequestedChange[]} requested - (a)
 * @property {ConsequentialChange[]} consequential - (b)
 * @property {Object} quality - (c) violations by code and by severity, before and after
 * @property {Object} objective - the weights, the two scores and the delta
 * @property {{ limit: number|null, moved: number, requested: number, consequential: number, withinBudget: boolean, blockingConstraintIds: string[] }} budget
 * @property {PublishedHold|null} hold - null only when the caller built a report without a partition
 * @property {Array<{ gameId: string, reason: string }>} unplaced
 * @property {Record<string, number|boolean>} meta
 * @property {import('../freeze/types.js').FreezeFinding[]} findings
 */

/**
 * Published-time hold, as a number a report can be read for.
 *
 * `kickoffHeld` is the family-facing one: the date and time they were told.
 * `slotHeld` is the subset that also kept its ground — still a notice to send,
 * but a different one. Both are counted by walking the **baseline** roster, so
 * a game the pipeline dropped lands in `unplaced` rather than quietly leaving
 * the denominator.
 *
 * @typedef {Object} PublishedHold
 * @property {number} baselineGames
 * @property {number} kickoffHeld
 * @property {number} slotHeld
 * @property {number} kickoffChanged
 * @property {number} moved
 * @property {number} unplaced
 * @property {number} measuredOver - the denominator, stated rather than implied
 */

/**
 * A committed re-solve: the one thing in the package `committed: true` can come
 * from, and only through `commitResolve()`.
 *
 * @typedef {Object} CommittedResolve
 * @property {true} committed
 * @property {string} name
 * @property {import('../ruleEngine/types.js').Schedule} schedule
 * @property {import('../ruleEngine/types.js').Schedule} baselineSchedule
 * @property {ScheduleChange[]} moved
 * @property {Array<{ gameId: string, reason: string }>} unplaced
 * @property {ChangeReport} report
 * @property {ReadonlyArray<string>} acceptedFindingCodes
 * @property {string|null} committedBy
 * @property {ResolveRun} run
 */

/**
 * The whole answer.
 *
 * @typedef {Object} ResolveRun
 * @property {string} name
 * @property {false} committed - always. `commitResolve()` is the second step
 * @property {ChangeReport} report - the dry run, categories (a), (b) and (c)
 * @property {Object} objective - the weights this run was scored under and what it scored
 * @property {{ limit: number|null, moved: number, requested: number, consequential: number, withinBudget: boolean, blockingConstraintIds: string[] }} budget
 * @property {import('../ruleEngine/types.js').Schedule} schedule - the resolved schedule
 * @property {import('../ruleEngine/types.js').Schedule} baselineSchedule
 * @property {import('../freeze/types.js').FreezePlan} freeze
 * @property {import('../freeze/types.js').FreezeJudgementSet} judgements
 * @property {ResolveState} state
 * @property {ScheduleChange[]} moved - by game, never a bare count
 * @property {BaselinePartition} partition - moved, held and unplaced, from one walk of the roster
 * @property {Array<{ gameId: string, reason: string }>} unplaced
 * @property {MoveRecord[]} moves
 * @property {StageResult[]} stages
 * @property {Array<Object>} unsatisfiable - every frozen game reported rather than thrown
 * @property {Object|null} verification
 * @property {import('../freeze/types.js').FreezeFinding[]} findings
 * @property {string} status
 * @property {ResolveMeta} meta
 */

/**
 * One game that ended up somewhere other than where it started.
 *
 * @typedef {Object} ScheduleChange
 * @property {string} gameId
 * @property {string} label
 * @property {string} disposition
 * @property {string[]} changedFields
 * @property {Slot|null} before
 * @property {Slot|null} after
 */

/**
 * Counters.
 *
 * @typedef {Object} ResolveMeta
 * @property {number} gamesExamined
 * @property {number} freezeJudgements
 * @property {number} stagesRegistered
 * @property {number} stagesRun
 * @property {number} movesConsidered
 * @property {number} movesRejectedByFreeze
 * @property {number} movesApplied
 * @property {number} candidatesEvaluated
 * @property {number} candidatesRejected
 * @property {number} candidatesScored - survived legality and went to the objective
 * @property {number} conflictsExamined
 * @property {number} gamesDislodged
 * @property {number} gamesReplaced
 * @property {number} gamesTimeTbd
 * @property {number} gamesAudited
 * @property {number} rulesRun
 * @property {number} rulesExercised
 * @property {number} constraintsConsulted
 * @property {number} slotsAvailable
 * @property {number} movedGames
 * @property {number} movedRequested
 * @property {number} movedConsequential
 * @property {number} movedConsequentialExplained - of which named what forced them
 * @property {number} repairScopeGames - games the run was asked to repair rather than accept
 * @property {number} repairsUnavailable - of those, ones with nothing legal to offer
 * @property {number} movesRefusedByBudget - moves the change budget refused before the writer
 * @property {number} publishedKickoffHeld - baseline games standing at their published kickoff
 * @property {number} publishedSlotHeld - of those, ones also on their published ground
 */

/**
 * One game standing exactly where the baseline put it.
 *
 * No `changedFields` and no `before`/`after` pair, because there is no change
 * to describe: a hold is one game and one slot. Shaped deliberately unlike
 * {@link ScheduleChange} so the two cannot be handed to the same reader by
 * mistake.
 *
 * @typedef {Object} BaselineHold
 * @property {string} gameId
 * @property {string} label
 * @property {string} disposition
 * @property {Slot} slot
 */

/**
 * What `diffAgainstBaseline()` returns: the whole partition of the baseline
 * roster, not only the half of it that changed.
 *
 * `unplaced` is a **view** of the entries in `moved` whose `after` is null, not
 * a bucket subtracted from it; see that function's docblock for why the
 * unplaced keep counting as moved.
 *
 * @typedef {Object} BaselinePartitionCounts
 * @property {number} baselineGames
 * @property {number} held
 * @property {number} moved
 * @property {number} unplaced
 * @property {number} publishedKickoffHeld - same date and kickoff, any ground
 * @property {number} publishedSlotHeld - same date, kickoff and ground
 *
 * @typedef {Object} BaselinePartition
 * @property {ScheduleChange[]} moved
 * @property {BaselineHold[]} held
 * @property {ScheduleChange[]} unplaced
 * @property {BaselinePartitionCounts} counts
 */

export {};
