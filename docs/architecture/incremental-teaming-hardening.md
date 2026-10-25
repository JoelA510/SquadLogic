## [← Back to Documentation Index](../README.md)

# Incremental Teaming Hardening — Design & PR Sequence

> **Status:** Implemented. This page is both the original design baseline _and_ the as-shipped
> reference for **snapshot-aware, incremental** team generation layered on top of the fresh
> allocator. The phased effort (PRs 01–09) is complete: §6a–§6g document each phase as shipped, §6h
> is the consolidated `changePolicy` reference, and §4's fresh-path invariants remain guaranteed by
> the characterization suite. The fresh allocator's behavior is unchanged whenever no snapshot is
> supplied. (§5–§6 retain the original forward-looking plan/target shapes for historical context.)
>
> Code comments cite these phases as "project-hardening PR 01"–"PR 09". The prompt bundle that
> drove them (`project-hardening/`) was removed in 2026-10 (remediation plan item M5.1); this page
> is the record: §5 names the phase each PR delivered, and §6a–§6g describe PRs 02–08 as shipped.

The current allocator (`packages/core/src/teamGeneration.js`) is a **fresh allocator**: every
run treats all players as unassigned and builds teams from scratch. That is correct for the
first teaming pass of a season, but it cannot safely re-run once rosters have been reviewed,
published, or locked — a re-run would discard existing team IDs, manual moves, and coach
assignments. This effort hardens the engine so it can **preserve an existing snapshot** and
reconcile only what changed (late registrations, drops, buddy/coach deltas) while leaving the
fresh path untouched when no snapshot is supplied.

See also: [`team-generation.md`](team-generation.md) (current algorithm design),
[`data-modeling.md`](data-modeling.md), and [`persistence-rpc-layer.md`](persistence-rpc-layer.md).

---

## 1. Current data flow (TeamAnalysisPage → persistence)

1. **Import → generator players.** `frontend/src/pages/TeamAnalysisPage.jsx` reads imported
   registration rows from the import context and maps each to an engine-shaped player via
   `toGeneratorPlayer()` (normalizes skill text → numeric, resolves division from age group,
   carries `coachId`).
2. **Coach linking & play-up.** `packages/core/src/teamingPipeline.js` (`prepareTeamingInput`)
   links volunteer coaches to their children (via `coachLinking.js`) and annotates play-up
   eligibility before generation.
3. **Generation.** `TeamAnalysisPage` calls `generateTeams({ players, divisionConfigs, seed })`
   (frontend uses `seed`; unit tests use an injected `random`). The allocator returns teams +
   diagnostics per division (see §3).
4. **Review snapshot.** `frontend/src/utils/teamReviewPersistence.js` (`buildTeamReviewSnapshot`)
   wraps the result with DB UUIDs and per-player metadata, including `assignment_source`
   (`'auto'` vs `'manual'`). `frontend/src/components/teaming/RosterManager.jsx` performs manual
   roster moves, marking moved players `assignment_source: 'manual'`.
5. **Persistence.** `packages/core/src/teamSupabase.js` (`buildTeamRows`, `buildTeamPlayerRows`)
   and `teamPersistenceSnapshot.js` produce the snake-case Supabase payload (`team_players` rows
   keyed by `team_id` / `player_id` / `source` / `run_id`). Conflict detection for buddies lives
   in `frontend/src/hooks/useConflicts.js`.

**Key seam:** today the persistence layer already understands team UUIDs and
`assignment_source`, but **the generator never receives them back** — there is no
`existingSnapshot` input. Closing that loop is the core of this effort.

---

## 2. Current generateTeams contract

Signature (`packages/core/src/teamGeneration.js:89`):

```js
export function generateTeams({
  players,
  divisionConfigs,
  random = Math.random,
  seed,
  featureFlags = {},
  dryRun: _dryRun = false,
  customWeights = {},
})
```

Return shape (per-division maps):

- `teamsByDivision[div]` — `Array<{ id, name, division, coachId, coachNeeded, assistantCoachIds, skillTotal, players }>`
- `overflowByDivision[div]` — `Array<{ players, reason, metadata? }>` (reasons today: `coach-capacity`, `insufficient-capacity`; Phase B2 adds `eligibility-blocked`, §6f)
- `overflowSummaryByDivision[div]` — `{ totalUnits, totalPlayers, byReason }`
- `buddyDiagnosticsByDivision[div]` — `{ mutualPairs, unmatchedRequests }`
- `coachCoverageByDivision[div]` — `{ totalTeams, volunteerCoaches, teamsWithCoach, teamsWithoutCoach, coverageRate, needsAdditionalCoaches, additionalCoachesNeeded }`
- `rosterBalanceByDivision[div]` — `{ teamStats[], summary }`
- `skillBalanceByDivision[div]` — `{ teamStats[], summary }`

Team IDs are generated as `${division}-T{nn}` (e.g. `U10-T01`). Determinism comes from `seed`
(hashed to a `mulberry32` PRNG) or an injected `random`.

---

## 3. Current fresh-allocation assumptions

1. All input players start **unassigned**; no team identity is carried in.
2. Teams are **anchored per unique `coachId`** found in the player set, then additional coachless
   teams are created up to the required count.
3. Assignment **units** are atomic: a single player, or a confirmed **mutual** buddy pair.
   One-sided / self / cross-target buddy requests are reported, never paired.
4. Allocation source is always implicitly **auto**; there are no manual locks to honor.
5. Roster constraints (`maxRosterSize`, `minRosterSize`, `minTeams`, `maxTeams`, overrides) apply
   uniformly; units that cannot fit go to **overflow** with a reason.
6. Diagnostics (coach coverage, roster/skill balance, buddy, overflow) are computed from the
   freshly built teams only.

---

## 4. Invariants that MUST hold when no `existingSnapshot` is supplied

These are locked in by `tests/teamGeneration.characterization.test.js` and must remain true as
the phases below land (they define backward compatibility for the fresh path):

- **Conservation:** every input player is assigned to exactly one team **or** present in overflow;
  no player appears twice.
- **Capacity:** no team exceeds `maxRosterSize`.
- **Buddy co-placement:** mutual buddies share a team, or overflow together as one unit.
- **Coach anchoring:** a player with `coachId` lands on that coach's team (or overflows under
  `coach-capacity`), and an anchored coach team has `coachNeeded === false`.
- **Overflow stability:** existing reason codes (`coach-capacity`, `insufficient-capacity`) and
  their `metadata` shapes are unchanged.
- **Param tolerance:** passing later incremental params (`existingSnapshot: null`,
  `generationMode: 'draft'`, `changePolicy: {}`, `teamCountPolicy: 'auto'`) produces **identical**
  output to omitting them.

---

## 5. Phased target architecture

Each phase is one PR (see §7). Phases are additive and preserve the fresh path.

1. **Snapshot normalization & delta reconciliation core** (PR 02) — pure helpers
   (`teamSnapshot.js`, `teamDelta.js`): normalize an existing snapshot and classify players as
   preserved / late / dropped / changed, with diagnostics. Not yet wired into `generateTeams`.
2. **Typed assignment units** (PR 03) — replace the implicit "array of players" unit with explicit
   typed units (`assignmentUnits.js`); preserve fresh behavior exactly.
3. **Structural stability & incremental generation** (PR 04) — integrate snapshot/delta into
   `generateTeams` behind new optional params; add team-count policies; preserve team IDs/shells.
4. **Buddy normalization & historical buddy routing** (PR 05) — canonicalize buddy fields
   (`buddyLinking.js`) and route valid late buddies to a preserved team or overflow with a reason.
5. **Coach continuity & assistant backfill** (PR 06) — handle dropped/late/replaced head coaches
   and fix assistant-only placement to backfill existing teams (`coachContinuity.js`).
6. **Change diagnostics & summaries** (PR 07) — emit structured `changeDiagnosticsByDivision`.
7. **Frontend & persistence integration** (PR 08) — build `existingSnapshot` from persisted teams,
   preserve UUIDs, send a full authoritative persistence payload.
8. **E2E hardening sweep, docs, interaction audit** (PR 09) — end-to-end regression scenarios and
   final documentation/interaction audit.

---

## 6. Proposed data shapes (target — not yet implemented)

These shapes are the agreed targets the phases will implement; exact names may be adjusted to
repo conventions during each PR. A canonical example snapshot lives in
`tests/fixtures/incrementalTeamingFixtures.js` (`makeExistingSnapshotFixture`).

**`existingSnapshot`** (input to PR 04, normalized by PR 02):

```js
{
  status: 'draft' | 'review' | 'published' | 'locked',
  runId: string | null,
  teamsByDivision: {
    [division]: [{
      id: string,            // persisted UUID — preserved, never remapped
      generatorId?: string,  // prior `${division}-T{nn}` label
      name?: string,
      division: string,
      coachId?: string | null,
      assistantCoachIds?: string[],
      locked?: boolean,
      players: [{ id: string, assignment_source?: 'auto' | 'manual', locked?: boolean }],
    }],
  },
}
```

**Typed assignment unit** (PR 03):

```js
{
  id: string,
  type: 'general' | 'mutual-buddy' | 'coach' | 'assistant' | 'targeted-buddy' | 'locked',
  players: Player[],
  targetTeamId: string | null,
  coachId: string | null,
  assistantCoachIds: string[],
  locked: boolean,
  hardConstraints: string[],
  softConstraints: string[],
  skillTotal: number,
  diagnostics: [],
}
```

**`changePolicy`** (PR 04/06):

```js
{
  teamCountPolicy: 'auto' | 'preserve-existing' | 'preserve-or-expand' | 'preserve-with-overflow',
  allowOverCapAssignments?: boolean,
  coachReplacementMap?: { [oldCoachId]: newCoachId },
  householdKeyField?: string,
  allowHouseholdCoachReplacement?: boolean,
  allowLateCoachAttachToChildTeam?: boolean,
}
```

**`changeDiagnosticsByDivision`** (PR 07):

```js
{
  [division]: {
    mode, teamCountPolicy,
    existingTeamsPreserved, newTeamsCreated, teamCountChangeBlocked,
    lockedAssignmentsPreserved, manualAssignmentsPreserved,
    latePlayersAssigned, latePlayersOverflowed, droppedPlayersRemoved,
    coachDrops: [], coachReplacements: [], assistantBackfills: [],
    buddyTargetAssignments: [], capacityViolations: [],
    minRosterWarnings: [], structuralWarnings: [], manualReview: [],
  }
}
```

---

## 6a. Implemented in PR 02 — snapshot & delta helpers

PR 02 landed the two pure helpers below in `packages/core/src` (no `generateTeams` change). They
implement §5 phase 1 against the real persisted shapes: the design `existingSnapshot` in §6 and the
relational persistence/review payload (`{ payload: { teamRows, teamPlayerRows } }`) are both accepted,
and `null`/malformed input yields diagnostics rather than throwing.

```js
normalizeExistingSnapshot(existingSnapshot, options?) => {
  status, runId,
  teamsByDivision,   // canonical NormalizedTeam[] per division (camelCase; assistants flattened)
  orphanedPlayers,   // [{ playerId, teamId }] — player rows with no resolvable team
  diagnostics,       // [{ code, severity, message }]
}

indexTeamSnapshot(normalized) => { teamsById, playersById, teamIdByPlayerId, divisions }

reconcileTeamDeltas({ players, existingSnapshot, generationMode, changePolicy?, divisionConfigs? }) => {
  preservedTeamsByDivision,     // team shells kept (even if empty); rosters reduced to active players
  activeLockedPlayerIds,        // per-player lock OR manual assignment in review/published/locked
  unassignedPlayersByDivision,  // late arrivals + players who moved divisions (need placement here)
  droppedPlayersByDivision,     // in snapshot, no longer registered
  changedDivisionPlayers,       // [{ playerId, fromDivision, toDivision }]
  orphanedSnapshotPlayers,
  coachDeltas,                  // [{ teamId, division, coachId, coachDropped, droppedAssistantCoachIds }]
  diagnostics,
}
```

These are not wired into `generateTeams` yet (PR 04). `coachDeltas` is **detection only** —
continuity and backfill land in PR 06.

---

## 6b. Implemented in PR 03 — typed assignment units

PR 03 extracted the generator's implicit "a unit is an array of players" model into a typed
`packages/core/src/assignmentUnits.js` (no behavior change — the characterization and existing
generation tests pass unchanged):

```js
buildAssignmentUnits(players) => { units: AssignmentUnit[], buddyDiagnostics }
createAssignmentUnit(init)   => AssignmentUnit   // factory with defaults
getSkillRating(player) / calculateUnitSkill(players)
```

Each `AssignmentUnit` is `{ id, type, players, targetTeamId, coachId, assistantCoachIds, locked,
hardConstraints, softConstraints, skillTotal, diagnostics }`. Fresh generation emits only
`'general' | 'mutual-buddy' | 'coach' | 'assistant'` units; `'targeted-buddy'` and `'locked'` are
reserved for snapshot-aware placement (PR 04/05). `generateTeams` partitions units by `type` and
feeds `unit.players` into the unchanged placement / scoring helpers.

---

## 6c. Implemented in PR 04 — snapshot-aware incremental generation

`generateTeams` now accepts three additive params (backward compatible — with no snapshot the
fresh path runs unchanged and **no new output keys appear**):

```js
generateTeams({ ..., existingSnapshot = null, generationMode = 'draft', changePolicy = {} })
```

- `changePolicy.teamCountPolicy`: `'auto' | 'preserve-existing' | 'preserve-or-expand' |
'preserve-with-overflow'`. Defaults: no snapshot → `auto`; snapshot + review/published/locked →
  `preserve-existing`; snapshot + draft → `preserve-or-expand`. An **explicit** `auto` with a
  snapshot falls back to fresh generation (snapshot ignored).
- `changePolicy.allowOverCapAssignments`: opt-in to place late players beyond `maxRosterSize`.

Incremental behavior (per division): preserved shells keep their ids, names, coach/assistant
metadata, and already-assigned players (rehydrated to full incoming player objects, carrying
`assignment_source`/`locked`); dropped players leave rosters but shells survive (even empty);
snapshot-only divisions remain in output (a missing division config yields a synthetic constraint
plus a structural warning instead of a crash); ONLY late/unassigned players are routed through the
PR-03 unit builder and placed by the unchanged scoring helpers; team creation is policy-gated
(`preserve-or-expand` creates on demand, still respecting `maxTeams`); preserved over-cap teams are
flagged (`capacityViolations`) and accept no additions by default; `minRosterSize` produces warnings
(`minRosterWarnings` / `teamsBelowMinRoster`) — never collapses preserved teams.

Incremental output adds `changeDiagnosticsByDivision` (subset of the §6 target — `mode`,
`teamCountPolicy`, `existingTeamsPreserved`, `newTeamsCreated`, `latePlayersAssigned`,
`latePlayersOverflowed`, `droppedPlayersRemoved`, `manualAssignmentsPreserved`,
`capacityViolations`, `minRosterWarnings`, `structuralWarnings` — PR 07 finalizes the full shape)
and a top-level `snapshotDiagnostics` array (the reconcile diagnostics).

---

## 6d. Implemented in PR 05 — buddy normalization & historical buddy routing

**Canonical buddy field.** `packages/core/src/buddyLinking.js` canonicalizes every buddy variant
into `buddyId` before generation:

```js
normalizeBuddyLinks(players) => { players, diagnostics }  // pure; inputs not mutated
getCanonicalBuddyId(player)  => string | undefined        // buddyId ?? buddy_id (frontend-safe)
```

- An explicit `buddyId` / `buddy_id` wins over a code. A `mutual_buddy_code` / `mutualBuddyCode`
  links players only when **exactly two** players share the code within one division (mirroring
  the import materialization SQL).
- Diagnostics: `missing-buddy-target`, `one-sided-buddy`, `duplicate-buddy-code` (>2 players),
  `buddy-code-unmatched` (1 player), `self-buddy-reference`, `cross-division-buddy`.
- `prepareTeamingInput` runs normalization first and returns `diagnostics.buddyLinking`; the
  `useConflicts` hook reads buddies via `getCanonicalBuddyId`, so React never duplicates the
  normalization rules.

**Historical buddy routing** (incremental generation): a late solo player whose valid buddy is
already preserved on a team becomes a `targeted-buddy` unit aimed at that team (coach anchoring
takes precedence; two late players with a reciprocal request remain a `mutual-buddy` unit).
Placement: onto the target team when capacity and policy allow (recorded in
`changeDiagnosticsByDivision[division].buddyTargetAssignments`); otherwise overflow with
`buddy-target-capacity` (full / over cap) or `buddy-target-locked` (team locked) — existing
rosters are **never reshuffled** to make room. Fresh (no-snapshot) buddy behavior is unchanged.

---

## 6e. Implemented in PR 06 — coach continuity & assistant backfill

`packages/core/src/coachContinuity.js` reconciles coach deltas against the rehydrated preserved
shells before placement — **explicit/evidence-based only**; ambiguity becomes a `manualReview`
entry, never a guess:

1. **Explicit replacement** (`changePolicy.coachReplacementMap` `{oldId: newId}`) always wins.
2. **Dropped head coach** (no incoming player references them): roster and shell preserved, the
   anchor is cleared (`previousCoachId` keeps the history), `coachNeeded` becomes true, and the
   drop is recorded in `coachDrops`. With `allowHouseholdCoachReplacement: true` and EXACTLY ONE
   of the team's preserved children now carrying a different active `coachId` (the other parent
   stepping up), the replacement applies; multiple candidates → `ambiguous-coach-replacement`.
3. **Late head coach** whose child sits on a coachless preserved team attaches to that team
   (`allowLateCoachAttachToChildTeam`, default true), unless the adult already anchors another
   team or multiple candidates exist (→ manual review). Distinct teams sharing one `coachId` in
   the snapshot are never collapsed.
4. **Locked teams** never have their coach mutated (a dropped coach is flagged
   `coachInactive` → `coachNeeded`).

**Assistant backfill** (both fresh and incremental placement): an assistant-only unit backfills,
in order — a team already carrying that assistant → a coached team without assistants → a coachless
team needing adult coverage. A new unmanaged shell is created only when
`changePolicy.allowAssistantShellCreation: true` (incremental; fresh generation keeps its
last-resort fallback). Otherwise the unit places like a general unit, with assistant metadata
merged after successful placement. Backfills onto preserved teams are recorded in
`changeDiagnostics.assistantBackfills`; `coachDrops`, `coachReplacements`, and `manualReview`
are also emitted per division.

> **Adult identity vs team-request anchor:** a `coachId` is an adult identity carried on player
> records. The continuity layer never collapses distinct preserved teams that share an adult, and
> never attaches one adult to a second team automatically — multi-team coaching remains an
> explicit, preserved-from-snapshot (or manual) decision.

---

## 6f. Implemented in PR 07 — change diagnostics & summaries (final shape)

`changeDiagnosticsByDivision[division]` is now the complete, **UI-stable** structure (no string
parsing required; ids and counts only — no extra PII). Emitted only in incremental mode; fresh
generation omits the key entirely.

| Field                                           | Type                                            | Meaning                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                                          | string                                          | `generationMode` of the run (`draft`/`review`/`published`/`locked`).                                                                                                                                                   |
| `teamCountPolicy`                               | string                                          | Effective policy after defaulting.                                                                                                                                                                                     |
| `existingTeamsPreserved`                        | number                                          | Snapshot shells carried into the output.                                                                                                                                                                               |
| `newTeamsCreated`                               | number                                          | Teams created this run (expansion or fresh-fallback divisions).                                                                                                                                                        |
| `teamCountChangeBlocked`                        | boolean                                         | At least one roster-cap-fittable unit overflowed for capacity while team creation was unavailable (policy forbids it, or `maxTeams` reached). Units larger than `maxRosterSize` never count — no team could seat them. |
| `lockedAssignmentsPreserved`                    | number                                          | Preserved players whose assignment is locked (per-player lock, or manual in review/published/locked).                                                                                                                  |
| `manualAssignmentsPreserved`                    | number                                          | Preserved players with `assignment_source: 'manual'`.                                                                                                                                                                  |
| `latePlayersAssigned` / `latePlayersOverflowed` | number                                          | Late registrations placed vs overflowed.                                                                                                                                                                               |
| `droppedPlayersRemoved`                         | number                                          | Snapshot players no longer registered (removed from rosters; shells kept).                                                                                                                                             |
| `buddyTargetAssignments`                        | `[{playerId, buddyId, teamId}]`                 | Late players routed onto their buddy's preserved team.                                                                                                                                                                 |
| `assistantBackfills`                            | `[{teamId, assistantCoachIds}]`                 | Assistant-only units backfilled onto preserved teams.                                                                                                                                                                  |
| `coachDrops`                                    | `[{teamId, coachId}]`                           | Head coaches no longer referenced by any incoming player.                                                                                                                                                              |
| `coachReplacements`                             | `[{teamId, fromCoachId, toCoachId}]`            | Applied replacements/attachments (`fromCoachId: null` = late-coach attach).                                                                                                                                            |
| `manualReview`                                  | `[{code, teamId, message, candidateCoachIds?}]` | Ambiguities requiring an admin decision — distinguishable from hard errors.                                                                                                                                            |
| `capacityViolations`                            | `[{teamId, playerCount, maxRosterSize}]`        | Final rosters above cap (pre-existing or `allowOverCapAssignments`).                                                                                                                                                   |
| `minRosterWarnings`                             | `string[]` (team ids)                           | Teams below `minRosterSize` (warning — preserved teams are never collapsed).                                                                                                                                           |
| `structuralWarnings`                            | `string[]`                                      | e.g. snapshot-only division with no division config.                                                                                                                                                                   |
| `eligibilityHolds`                              | `[{playerId, teamId, placement, reviewReason}]` | Phase B2: a blocked player (`play_up_blocked` / `play_down_blocked`) on a final roster. Only a preserved one can be: they stay on their reviewed team (owner decision 3) and are listed; a late one overflows.         |

**Overflow reason codes** (`overflowByDivision[].reason`, machine-readable kebab-case):
`insufficient-capacity`, `coach-capacity`, `buddy-target-capacity`, `buddy-target-locked`,
`eligibility-blocked` (Phase B2, `docs/changes/2026-10-22-phase-b-teaming.md`: one entry per
player whose `placement` is `play_up_blocked` or `play_down_blocked`, metadata
`{ placement, reviewReason, naturalAge, coachId }` (plus `assistantCoachId` when the player has
one), in fresh generation and for a late player on
a rerun; `unknown` is placed, never blocked). A blocked player leaves the pool before the team
count and coach anchors are built, and a mutual buddy of one is placed alone with the unmatched
request reason `buddy-not-placed`. With nobody blocked the output is unchanged
(`tests/teamGenerationEligibility.test.js`, a golden from `main`).

**Manual-review codes**: `ambiguous-coach-replacement`, `coach-replacement-candidate`,
`coach-replacement-target-anchored`, `ambiguous-coach-attachment`,
`coach-candidates-anchored-elsewhere`.

**Summaries**: `summarizeTeamGeneration(result)` now attaches each division's change diagnostics
as `divisions[i].changes` and adds incremental totals (`latePlayersAssigned`,
`latePlayersOverflowed`, `droppedPlayersRemoved`, `manualReviewCount`) — both only when the
result came from an incremental run; the fresh-generation summary shape is unchanged.
**Production consumers** (teaming follow-ups PR): `buildTeamReviewSnapshot` persists the summary as
`metrics.generationSummary` on every team run (computed from the remapped results so team ids are
the persisted UUIDs; non-fatal on failure), and `formatChangeNote(changes)` renders the one-line
admin note shown in the staged-review banner.

**Admin interpretation example**: after a published-mode rerun, `existingTeamsPreserved: 3,
newTeamsCreated: 0, latePlayersAssigned: 2, latePlayersOverflowed: 1, teamCountChangeBlocked: true`
reads as "your three teams are intact, two late players were seated, one could not fit anywhere —
either raise `maxRosterSize`, allow expansion (draft mode / `preserve-or-expand`), or place them
manually"; anything in `manualReview` is a decision the engine deliberately refused to make.

---

## 6g. Implemented in PR 08 — frontend & persistence integration

PR 08 wires the incremental engine into the only place teams are actually generated for admins
(`TeamAnalysisPage`) and proves the persistence round-trip preserves identity. **No core changes** —
the integration lives entirely in the frontend/persistence layer, keeping core free of Supabase/React
imports (the §4 / risk-register invariant).

### Admin re-run flow

`handleGenerateTeams` now derives an `existingSnapshot` from the division's previously persisted run
before calling `generateTeams`:

```text
useTeamPersistence() → persistenceSnapshot
  → buildExistingSnapshotForRerun(persistenceSnapshot, { divisionKey })  // frontend util, pure
    → existingSnapshot | null
generationMode = existingSnapshot ? 'review' : 'draft'
generateTeams({ players, divisionConfigs, existingSnapshot, generationMode })
  → result.changeDiagnosticsByDivision  → appended to the staged review message
```

- **First run** (no persisted snapshot for the division) → `buildExistingSnapshotForRerun` returns
  `null` → `generationMode: 'draft'` → byte-identical fresh behavior (the §4 invariant holds).
- **Re-run** (a prior snapshot exists) → `generationMode: 'review'` → preserved UUIDs, manual locks,
  coach/assistant continuity, and a `changeDiagnosticsByDivision` summary surfaced in the review banner.

The coach reference travels on the **player** rows: `prepareTeamingInput` → `linkCoachesToPlayers`
projects each coach onto their child as `player.coachId`, so on a re-run the returning child still
carries the reference and `applyCoachContinuity` recognizes the head coach as active and keeps the
anchor (a coach absent from the new import is, correctly, treated as dropped).

**Multi-division persistence.** Each persisted run holds a single division (the page generates one
program at a time), and `useTeamPersistence` only surfaces the most-recent run as `payload`. To keep
re-runs working for _every_ previously-persisted division — not just the most recent — the hook also
exposes `payloadByDivision` (`buildPayloadByDivision` in `schedulerRunFilters.js`): a division →
`{ teamRows, teamPlayerRows }` map built from the recent run window (newest run wins per division).
`buildExistingSnapshotForRerun` prefers that division-scoped payload, so re-running U10 after
persisting U12 still finds U10's teams instead of silently regenerating fresh (the risk-register
"re-run silently discards manual moves" failure mode). Two freshness races are also closed:
`handleGenerateTeams` refuses to run while the snapshot is still loading (the empty initial snapshot
would otherwise look like a first run), and a successful sync calls the hook's `refresh()` so a
same-session re-run sees the just-persisted teams.

### `buildExistingSnapshotForRerun(baseSnapshot, { divisionKey })` — frontend util

Pure (`frontend/src/utils/teamReviewPersistence.js`, no Supabase/React imports). Reverses a persisted
snapshot into the `teamsByDivision` shape `normalizeExistingSnapshot` already accepts:

| Concern         | Behavior                                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape tolerance | Reads `payload.teamRows` (generation teams w/ inline `players`) + optional relational `payload.teamPlayerRows`.                                                                                                       |
| Source of truth | Relational `source` wins for the manual/auto flag (survives manual roster edits); inline `players` is the fallback when no relational rows exist.                                                                     |
| Assistants      | `assistantCoachIds` reconstructed from `assistant_coach` role rows (case-insensitive, ∪ any inline `assistantCoachIds`); coach/head-coach role rows are kept out of the roster `players` (mirrors `teamSnapshot.js`). |
| Scoping         | Prefers the requested division's own most-recent payload (`payloadByDivision[divisionKey]`) over the single global `payload`, then filters to `divisionKey`.                                                          |
| Empty           | Returns `null` when there is nothing to preserve (first run) → caller falls back to fresh draft.                                                                                                                      |

### Persistence invariants (UUID preservation + full authoritative payload)

- **UUIDs preserved end-to-end.** `buildTeamReviewSnapshot` keeps `isUuid(team.id) ? team.id :
idFactory()` — a preserved team re-uses its persisted UUID; only a genuinely new team mints one.
  Tests assert **zero** id-factory calls for an all-preserved re-run.
- **Full authoritative payload (required).** The review payload lists _every_ team in the result and
  _every_ player on each team (one `team_players` row per roster player). The persistence RPC
  `persist_team_schedule` **replaces each submitted team's roster**: for a team present in the payload
  it `DELETE`s the memberships absent from the incoming rows and upserts the rest (a team _not_ in the
  payload is left untouched). Sending the full authoritative roster per submitted team is therefore
  **mandatory** — a partial roster would delete the omitted assignments. A welcome consequence: a
  player dropped on a re-run is also removed from the DB (their preserved team is in the payload and
  they are not in the incoming rows), so `droppedPlayersRemoved` matches the persisted state.

### Closed follow-ups (teaming follow-ups PR, migration `20260610000000_teaming_rerun_followups.sql`)

1. **Assistant-coach write-persistence — closed.** `team_players.player_id` is FK-bound to `players`
   while assistant ids are coach ids, so relational `assistant_coach` role rows are structurally
   impossible. Instead, `teams.assistant_coach_ids` (nullable `uuid[]`; NULL = never set, readers
   treat NULL like `{}`) now carries the list: `buildTeamReviewSnapshot` writes the UUID subset on
   every team row (the `coach_id` convention — non-UUID import-era ids round-trip via the inline
   results JSON the re-run path reads), and the redefined `persist_team_schedule`
   validates/sanitizes it (string array, UUID-filtered, **restricted to coaches that exist in the
   run organization** — the column grants portal/RLS access — deduped, ≤ 50 entries) and
   upserts it with `COALESCE(EXCLUDED…, teams.assistant_coach_ids)` — so an older client whose
   payload omits the key can never wipe a stored list. `tests/persistRoundTrip.test.js` proves the
   full DB round-trip (including old-client safety).
2. **Run-window bound — closed.** `get_latest_team_runs_per_division` (SECURITY INVOKER `DISTINCT ON`
   over `scheduler_runs`; RLS applies to the caller) returns the single newest team run per division,
   unbounded. `useTeamPersistence` prefers it for `payloadByDivision` and falls back to the bounded
   20-run window only when the RPC is unavailable (older DB / transient error). The mock client
   implements the same RPC for E2E parity.

### Remaining documented limitation

1. **Division-key form is consistent-by-convention, not enforced.** The snapshot's `division` is
   whatever `selectedProgram.id` resolved to at write time (an age-group key like `U10`, or a
   `division_id` UUID), and `divisionConfigs` is keyed by the same value end-to-end, so they always
   align today (pinned by the division-key contract assertions in `tests/persistRoundTrip.test.js`).
   A future caller that keyed `divisionConfigs` differently from `selectedProgram.id` would need the
   `changePolicy.divisionKeyById` remap (already supported by core) to bridge them.

---

## 6h. `changePolicy` reference (as shipped)

The complete, as-implemented `changePolicy` surface accepted by `generateTeams({ changePolicy })`.
This supersedes the forward-looking target shape sketched in §6 (which still lists some never-shipped
fields). All keys are optional; omitting `changePolicy` entirely is equivalent to `{}`.

| Key                               | Type                      | Default                                                     | Effect                                                                                                                                                                                                  |
| --------------------------------- | ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `teamCountPolicy`                 | string                    | derived from `generationMode` (see below)                   | `auto` (ignore snapshot, fresh), `preserve-existing` (keep the team count), `preserve-or-expand` (add teams only when capacity requires), `preserve-with-overflow` (never add teams; overflow instead). |
| `lockManualAssignments`           | boolean                   | `true` in `review`/`published`/`locked`, `false` in `draft` | Forces (or releases) the "manual `assignment_source` is locked" rule independent of the mode. A locked player is never moved.                                                                           |
| `allowOverCapAssignments`         | boolean                   | `false`                                                     | Permits seating a late player beyond `maxRosterSize` (the resulting over-cap roster is reported in `capacityViolations`).                                                                               |
| `coachReplacementMap`             | `{ [oldCoachId]: newId }` | `{}`                                                        | Explicit head-coach swaps; always wins unless the target already anchors another team (→ `manualReview`).                                                                                               |
| `allowHouseholdCoachReplacement`  | boolean                   | `false`                                                     | When a head coach drops and **exactly one** preserved child now carries a different active coach, promote that parent.                                                                                  |
| `allowLateCoachAttachToChildTeam` | boolean                   | `true`                                                      | Lets a late head coach attach to their child's coachless preserved team (single-candidate only).                                                                                                        |
| `allowAssistantShellCreation`     | boolean                   | `false`                                                     | When set, an assistant-only late unit with no backfill target may create a new shell instead of overflowing.                                                                                            |
| `divisionKeyById`                 | `{ [division_id]: key }`  | `{}`                                                        | Maps a persisted relational `division_id` (UUID) back to the generator division key when a snapshot team row carries no display `division`.                                                             |

**`teamCountPolicy` default by mode:** no `existingSnapshot` → `auto` (fresh); `existingSnapshot` +
`generationMode: 'draft'` → `preserve-or-expand`; `existingSnapshot` + `review`/`published`/`locked` →
`preserve-existing`. An explicit `auto` with a snapshot discards the snapshot and runs fresh.

**Locked-team exception (coach policies).** A snapshot team with `locked: true` is exempt from _all_
coach mutation: `applyCoachContinuity` leaves its `coachId` untouched and merely reports a drop
(`coachInactive`) when the coach is gone. So `coachReplacementMap`, `allowHouseholdCoachReplacement`,
and `allowLateCoachAttachToChildTeam` have **no effect on a locked team** — unlock it (or fix the
roster upstream) before expecting a coach change to apply.

---

## 7. PR sequence

| PR  | Title                                        | New modules (core)                | Touches `generateTeams`? |
| --- | -------------------------------------------- | --------------------------------- | ------------------------ |
| 01  | Foundation & characterization                | — (docs + tests + fixtures)       | No                       |
| 02  | Snapshot normalization & delta core          | `teamSnapshot.js`, `teamDelta.js` | No (exports only)        |
| 03  | Typed assignment units                       | `assignmentUnits.js`              | Internal refactor only   |
| 04  | Structural stability & incremental gen       | —                                 | Yes (additive params)    |
| 05  | Buddy normalization & historical routing     | `buddyLinking.js`                 | Yes                      |
| 06  | Coach continuity & assistant backfill        | `coachContinuity.js`              | Yes                      |
| 07  | Change diagnostics & summaries               | —                                 | Yes (output only)        |
| 08  | Frontend & persistence integration           | — (frontend + persistence)        | No (consumer side)       |
| 09  | E2E hardening sweep, docs, interaction audit | —                                 | No                       |

---

## 8. Risk register

| Risk                                                                  | Mitigation                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Re-run silently discards manual moves or published team IDs           | Preserve UUIDs end-to-end (PR 08); honor `assignment_source: 'manual'` as locked.               |
| Fresh-path regression while adding incremental branches               | Characterization suite (§4) + `auto`/no-snapshot defaults; assert byte-identical fresh runs.    |
| Partial persistence payload deletes preserved `team_players` rows     | PR 08 sends a **full authoritative** snapshot; add tests asserting no preserved rows dropped.   |
| Core picks up Supabase/React imports during integration               | Keep snapshot/delta/buddy/coach helpers pure; integration lives in frontend/persistence.        |
| Coach identity collapsed across distinct team requests                | Explicit replacement evidence only (`coachReplacementMap` / household key); diagnose ambiguity. |
| Buddy field name drift (`buddyId` / `buddy_id` / `mutual_buddy_code`) | Canonicalize once in `buddyLinking.js`; reuse in `useConflicts` (PR 05).                        |
| Late buddy/coach changes reshuffle published rosters                  | Never reshuffle locked/published players; route to capacity or overflow with a reason.          |

---

## 9. Definition of done for the effort

- Fresh (no-snapshot) generation is provably unchanged (characterization suite stays green).
- Incremental generation preserves team IDs, shells, manual locks, and coach assignments.
- Structured diagnostics describe every preserved / late / dropped / overflowed decision.
- Core remains free of frontend/Supabase imports.
- Each phase ships with tests and updated docs.
