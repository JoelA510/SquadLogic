# Phase B: teaming

Status: **approved by the owner 2026-10-22, with every recommendation** (AGENTS.md rule 14: B2
and B6 change the generator, B1 the domain model of buddy requests). B1 to B6 are built (see
"As built (B1)" to "As built (B6)"). B6 records the owner's team priorities of
2026-10-22. It applies the owner's decisions of 2026-10-20 (`2026-10-20-core-roadmap.md`) to the
teaming core: buddy requests, research item 3 (eligibility), and team counts per program. No
migration: everything new is computed, and the run's `results` JSON is stored opaque
(`team-persistence/index.ts:53`, `runMetadata: z.record(z.unknown())`). Six PRs, in this order; B2
and B6 touch the solver. Each is reviewed once before it opens.

**Superseded in part (owner, 2026-10-22, `2026-10-22-admin-focus.md`):** the paperwork flags
(payment, waiver, medical form) and the Compliance page are removed in R1, and B2 and B3 below no
longer flag paperwork; the waitlist stays the gate an admin uses. Birthdates give way to a stored
natural age in R5 (built: `players.natural_age`), which B2 carries into the generator.

Every claim below is _statically reviewed_ against `main` at `6a22d29` unless marked _executed_.
Line numbers are current; research item 3's (`:776`, `:806-835`) have moved.

## B1. Buddy requests reach the generator (medium; domain)

**Today:**

- The import stores the request text in `players.buddy_request`
  (`20261020020000_drop_player_medical_columns.sql:215,442`). The column is fed by "Buddy",
  "Buddy Request", "Friend Request" and "Buddy ID" headers alike
  (`import-validation/index.ts:130-137`), so it holds a **name** (GotSport's form; the mock seeds
  `'Jamie Jones'`, `mockSupabaseClient.js:226`) or a registration id (the e2e CSV,
  `tests/e2e/steps/data_and_output.ts:111-113`).
- `materialize_import_buddy_pairs` (`20260503080000:56-111`) writes `player_buddies` only when the
  request equals the other player's `external_registration_id` reciprocally, or from a two-player
  code. A name never matches. Nothing reads `player_buddies` back (only a delete,
  `20260611000100:390`; no `from('player_buddies')` in `frontend/src` outside the mock).
- `toGeneratorPlayer` (`TeamAnalysisPage.jsx:238-276`) emits id, division, names, DOB, play-up,
  skill and coach. No `buddy_request`, `mutual_buddy_code` or `external_registration_id`, so even
  code and id requests are lost before the pipeline.
- Had they arrived, names would still fail: `normalizeBuddyLinks` reads `buddy_request` as an
  external key only (`buddyLinking.js:56-62,161-168`) and reports `missing-buddy-target` for a name
  (_executed_: a reciprocal "Ada One"/"Bea Two" pair through `prepareTeamingInput` +
  `generateTeams` gives two `missing-buddy-target` diagnostics and no mutual pair).
- The page keeps `prepared.players` and drops `prepared.diagnostics` (`:817`).
- TeamBuilder's auto-balance matches names its own way (`balanceSignals.js:39-66,108-118`): case
  and whitespace only, last write wins on two players with one name, and one-way requests pair.
- Two side effects of buddies arriving: play-up route B (a buddy who is a coach's child sanctions a
  play-up, `playUp.js:200-219`) starts to fire; and a mutual pair whose two families each anchor a
  head coach **throws and aborts the run** (`assignmentUnits.js:89-92`; _executed_: "Conflicting
  coach assignments for players in unit: a, b").

**Change:**

1. `resolveBuddyRequests({ players, roster })` in `packages/core/src/buddyLinking.js`, pure.
   `players` is the program being generated; `roster` is every imported player (id, division, first,
   last, preferred name), so "not found" and "in another program" are told apart. Per request:
   - a value equal to a roster player's external registration id resolves to that player (today's
     rule, kept);
   - otherwise it is a name, normalised with `normaliseNamePart` (`people/identity.js:103`, the
     sibling contract: accents, case, punctuation), matched on first + last, preferred + last, and
     "Last, First";
   - exactly one match in the program resolves it; two or more is `ambiguous`, unless exactly one
     candidate's own request resolves back to the requester (reciprocity is the evidence);
   - a match only in another division is `cross-division`; none is `not-found`; a value naming
     more than one person, or the requester, is `unparsed` / `self`.
     Nothing is fuzzy-linked. Like `identity.js` ("proposes and never merges"), a near miss is
     reported with the same-surname candidates, never paired. The fix for a wrong request is the
     existing audited edit on the player record (`PlayerRecordPage.jsx:326`).
2. `prepareTeamingInput` runs it before `normalizeBuddyLinks`, so codes and ids keep their rules,
   and after coach linking breaks any mutual pair whose two players anchor different head coaches
   (diagnostic `buddy-coach-conflict`; both players keep their coach). The generator's unit guard
   stays as a backstop.
3. `toGeneratorPlayer` emits `buddy_request`, `mutual_buddy_code` and `external_registration_id`
   from the same header variants the import maps, and the page passes the roster. With the
   `buddy_requests` org flag off (`featureFlags.js:43`) no buddy field is emitted.
4. Semantics stay those of `incremental-teaming-hardening.md` section 3: a **mutual** pair is one
   unit and is always co-placed, one buddy per player. A **one-way** request is honoured only when
   the league's `buddy_rule` setting (introduced here, in B1, so no intermediate merge changes the
   default) is `one_way_best_effort`: then it sets `buddyId` and is best effort through
   `BuddyEvaluator` (`evaluators/BuddyEvaluator.js:22-43`), never a unit, with the owner's rules
   (B6). Under the default `mutual` it is listed for the admin and not honoured (decision 1).
   `buddy_rule` is a string setting, so B1 adds it the way `gender_model` is added: a
   `FeatureFlagSchema` branch accepting exactly `mutual` and `one_way_best_effort` (anything else is
   refused, not coerced), the default `mutual`, a selector (not a toggle) in the feature settings
   page, and the audited update path; tests: the schema refuses another string, a stored
   `one_way_best_effort` reads back as itself through the settings page and the persistence path.
5. The staged review shows a "Buddy requests" list from the pipeline and generator diagnostics:
   paired, one-way (placed together or not), and each unresolved request with its reason and
   candidates. Derived from the run's `results`, so it survives a reload.

**Tests:**

- `tests/buddyLinking.test.js`: each resolution case above, including two "Sam Lee"s (ambiguous),
  the same with one reciprocating (resolved), accents and "Last, First", a cross-division match,
  and a registration id (unchanged). Every name case fails today (`missing-buddy-target`).
- `tests/teamingPipeline.test.js`: a reciprocal name pair arrives as mutual `buddyId`s; a coach's
  child named by a play-up player now sanctions the play-up; two coaching families as buddies
  give `buddy-coach-conflict` and no throw. The first two fail today; the third throws today.
- `tests/teamAnalysisBuddies.test.jsx` (page, as `teamSyncKeepsStatus.test.jsx` mocks it): an import
  with a reciprocal name pair yields a team holding both, and the list shows one unresolved request
  with its reason; with the flag off, no pair. Fails today.
- No names from fixtures in source (the `tests/people.test.js` rule applies to the new code too).

## B2. Eligibility honoured: one not-placed contract (medium; **solver**)

**Today:** `applyPlayUpEligibility` annotates `placement`, `needsReview`, `reviewReason`
(`playUp.js:190-277`); the page asks for annotation only (`remapBlocked: false`, `:815`).
`generateTeams` (`teamGeneration.js:108-120`) reads none of them (no `placement`, `needsReview` or
`reviewReason` anywhere in `teamGeneration.js`, `assignmentUnits.js` or `teamDelta.js`). _Executed:_
a player of natural age 13 in a U10 band comes back `play_down_blocked`, `needsReview: true`, and is
seated on `U10-T01` with no overflow entry. On a rerun the page passes the snapshot in `review`
mode (`:837-847`), where a player missing from the input counts as dropped (`teamDelta.js:124-128`),
so filtering blocked players out in the page would unseat rostered ones.

**Change** (generator only; fresh output is identical when no player is blocked):

1. **The contract is `overflowByDivision`**, the existing unassigned output (the late output is an
   input bucket, not a result). New reason `TEAM_GENERATION.REASON_EligibilityBlocked =
'eligibility-blocked'`, metadata `{ placement, reviewReason, naturalAge, coachId }`. The
   conservation invariant (assigned or in overflow, once) holds; existing reasons and metadata are
   unchanged; `summarizeTeamGeneration` rolls the new reason up as it does any other.
2. Blocked means `placement` is `play_up_blocked` or `play_down_blocked`. Nothing else blocks:
   `unknown` (no natural age, or no `season_year`) **flags** (owner decision 3, and B3). The
   natural age comes from the stored player (R5 of the admin-focus plan): the durable-player query
   (`TeamAnalysisPage.jsx:682-689`) selects it and `toGeneratorPlayer` (`:238-274`) emits it as
   `naturalAge`, so generation from stored players, without the original file, still checks
   eligibility; a page-path test generates from stored players only and gets a blocked placement.
3. Fresh path: blocked players leave the pool before units and coach anchors are built, so they
   are not counted toward the team count, and a blocked coach's child does not anchor a team
   (`coachId` in the metadata says so). A mutual buddy of a blocked player is placed alone, with
   an `unmatchedRequests` entry `buddy-not-placed`.
4. Incremental path: a blocked player already on a preserved roster **stays** (the invariant in
   AGENTS.md and the hardening doc) and is listed in a new `changeDiagnosticsByDivision[div]
.eligibilityHolds: [{ playerId, teamId, placement, reviewReason }]`; a blocked late player
   overflows with the new reason. Team UUIDs, manual and locked assignments are untouched.

**Tests** (`tests/teamGenerationEligibility.test.js`, new):

- a blocked player is in overflow with `eligibility-blocked` and its reason, on no team (fails today);
- a blocked player on a reviewed roster stays, keeps the team UUID, and appears in
  `eligibilityHolds` (fails today: no such key);
- a blocked late player overflows; a blocked player's mutual buddy is placed alone;
- `unknown` placement is placed and flagged (stays green; guards the owner's decision);
- the same seeded roster with no blocked player gives deep-equal output before and after (a golden
  captured from `main` in the PR's first commit).

## B3. Failures stop generation; not placed and flagged, on the Teams page (medium)

**Today:** the `coach_team_requests` read keeps only `data` (`TeamAnalysisPage.jsx:783-786`), so a
refused read means no coach anchors and no error. A pipeline throw is `console.warn`ed and the raw
roster generated (`:818-820`). The page shows overflow only as a count (`TeamListView.jsx:58`) and
never lists who or why.

**Change:**

1. The read's `error` throws, and the `catch` around the pipeline is removed; both land in the
   existing `generationError` path (`:901-904`), which stops the run and shows the message.
2. The review section (`:1263-1281`) gains "Not placed" (each player, the reason in words, the
   natural age) and "Needs review" (`eligibilityHolds`: who, which team, why), derived from the
   staged or persisted run's `results`. Following TIME TBD: visible, never dropped.
3. **Flags, never blocks:** "Eligibility not checked" (`unknown`). Placed players carry the flag
   beside their name; nothing is held off a roster. (No paperwork flag: the paperwork columns and
   the Compliance page are removed in R1.)
4. Lists are `<section>`s with headings, announced through a polite live region once.

**Tests:**

- `tests/teamAnalysisEligibility.test.jsx` (page): a refused `coach_team_requests` read shows the
  error and stages no review; a pipeline that throws does the same; a blocked player is listed under
  "Not placed" with the reason; a player with no natural age is placed and flagged "Eligibility
  not checked". All four fail today.
- e2e `late_registrant_reviewed_roster.feature`: a scenario adds a blocked late registrant to a
  reviewed roster and sees them under "Not placed" with no roster change.

## B4. Team counts per program, with outcome warnings (small; UI)

**Today:** #626 already gives the pre-generation advice: `assessTeamCount` (`rosterSizing.js:380`)
recommends a count from the players registered, with "Use N" and TOO_FEW/TOO_MANY warnings, in the
settings panel only (`TeamingConfiguration.jsx:30-38,170-201`). Gaps:

- the panel passes no `coachCount`, so advice ignores the head-coach floor it mentions;
- the overview's Status is a hard-coded "Ready" (`ProgramOverview.jsx:34-39`), so a program that
  cannot fit its limits looks ready; its rows are clickable `<tr>`s, not keyboard-operable;
- after generation, `teamsBelowMinRoster` (`teamGeneration.js:419-421`) and `capacityViolations`
  (`:492-499`, computed only on a rerun) are shown nowhere; only `teamReviewPersistence.js:112`
  touches them, to remap ids;
- `createDefaultConfig` pre-fills the override with `ceil(players / 12)` (`TeamAnalysisPage.jsx:
95-108`) and generation saves it (`:763`), so every program soon carries an "override" nobody set.

**Change:**

1. A core helper derives the outcome per division from a result: teams under the minimum, over the
   maximum, players not placed for capacity (`insufficient-capacity`, `coach-capacity`); the review
   section shows them as warnings beside the counts.
2. The overview shows each program's recommended count and a warning status from `assessTeamCount`,
   with `coachCount` counted from the rows by the rule `toGeneratorPlayer` uses. Rows become
   buttons (WCAG 2.1.1).
3. New programs default to Auto (no override); decision 4 covers saved ones.

**Programs without Phase E.** Everything is keyed by the generator's division key, as
`derivePrograms` (`TeamAnalysisPage.jsx:111-127`) groups today; no helper knows what a program is.
When E adds a program attribute, the overview groups divisions under it and the count stays per
division (teams form within one). Buddy matches across two programs of one age become
`cross-division`, never paired.

**Tests:** `tests/teamSizeOutcome.test.js` (under-min, over-max on a rerun with
`allowOverCapAssignments`, capacity overflow; fails today: no helper);
`tests/teamingConfigurationAdvice.test.jsx` extended: coaches raise the recommendation; a program
over its limits shows a warning status in the overview; rows operable by keyboard (fail today).

## B5. TeamBuilder adopts the resolver (small; optional, decision 5)

`buddyStats` and `serpentineAssign` call `resolveBuddyRequests`, so both pages match names the same
way and apply the league's `buddy_rule` (B1): mutual only by default, one-way best effort when the
league chooses it. `tests/balanceAndCoed.test.js` gains two-same-name and one-way cases under both
settings (fail today).

## B6. Team priorities and coaching leads (owner, 2026-10-22; medium; **solver**)

The owner set the order a team in a division is filled by:

1. **Coaches' children with their buddies.** Each coach's child (or children) anchors that coach's
   team, with the child's buddy as the league's buddy rule allows (below).
2. **An even number of coaching leads per team, where possible.** A coaching lead is a player whose
   registration says a parent volunteers to coach (`players.willing_to_coach`). Leads are spread so
   no two teams differ by more than one, except where a buddy unit holds more than one lead
   ("where buddying allows").
3. **Experience and skill balance** (years played, skill tier or rating), with compensation: a team
   with fewer leads receives more of the experienced or skilled players, to make up for the
   missing parent coaches.

**What a lead is, and is not.** Only the flag: a lead's contact details stay on the registration
platform and are not stored (`docs/changes/2026-10-22-admin-focus.md`, R0). Admins see a "Lead"
mark on the player while teaming. The coach-lead capture that copied a volunteering guardian's name
and email into a coach row is retired in R0; the signal is kept.

**League settings** (organization feature flags, audited, through the
`squadlogic-feature-guardians` registry):

- `teaming_spread_coaching_leads`: on by default. With it off, priority 2 and the compensation in
  3 are skipped. An import with no volunteer column has no leads, so the default changes nothing
  for it.
- `buddy_rule` (added in B1, used here): `mutual` by default (a pair is formed only when both
  players name each other, one buddy per player), or `one_way_best_effort`, the rule the owner gave
  earlier the same day: a one-way request is ignored when the requested player is not registered
  or requested someone else, is matched when the requested player listed no buddy, and every
  one-way request is listed for the admin (name variants).
- Both settings reach both entry points: Team Analysis reads the effective flags (`useFeatures`)
  and passes them to `generateTeams` (today it passes none, `TeamAnalysisPage.jsx:841-848`), and
  TeamBuilder passes them instead of its fixed `respectBuddies`/`respectCoach`
  (`TeamBuilderPage.jsx:122-128`). Page tests for each: default on, and stored off.

**Change:** a lead is not a coach. Today the page turns any `willing_to_coach` player into a
synthetic `coachId` (`TeamAnalysisPage.jsx:255-273`), which `assignmentUnits.js:84-100` treats as a
head-coach unit, so every lead would become priority 1 and anchor a team. B6 removes that synthetic
coach: `toGeneratorPlayer` emits a separate `isCoachingLead` flag, and only a coach linked through
`coach_team_requests` anchors a team. One rule in `packages/core` serves both the generator
(`teamGeneration.js` with `assignmentUnits.js`) and TeamBuilder's auto-balance
(`balanceSignals.js:69-140`, which already deals units holding a volunteer first, one per team where
possible). Units are dealt in priority order; a lead unit goes to a team with the fewest leads; the
balance signal is the league's own (`balanceSignalKind` and `playerSignal`: years played by default,
skill rating when the league enables it, never a signal that is off), and `toGeneratorPlayer`
carries `years_played`. Skill is dealt to the team with the lowest `signal total + c × leads`, where
`c` is the division's mean unit signal (one lead counts as one average player). `c` is a named
constant, tuned against `fixtures/demo-2026/` (years played, no rating; the season fixture holds no
player roster) before the PR opens.

**Tests:** a page-path test through `toGeneratorPlayer`: a lead with no linked coach does not anchor
a team (fails today); core unit: three teams and four leads give 2/1/1, never 3/1/0; two leads who
are mutual buddies stay together even when that is uneven; with compensation, the team with fewer
leads has the higher mean experience (planted: `c = 0` fails it); with the setting off, leads are
ignored; `buddy_rule = mutual` ignores a one-way request and `one_way_best_effort` honours it when
the requested player listed no buddy. The full season fixture suite runs (AGENTS.md, scheduling
engine conventions), and the demo league is teamed end to end.

## Must stay unchanged (regression tests)

- The fresh-path invariants, `tests/teamGeneration.characterization.test.js` (section 4 of the
  hardening doc), and seeded determinism, `tests/teamGenerationSeed.test.js`.
- Reruns keep UUIDs, manual and locked players: `existingSnapshotRerun.test.js`,
  `incrementalTeamingScenarios.test.js`, `teamGenerationIncremental.test.js`.
- Import materialization: `playerImportBuddyMaterialization.test.js`, `ingestion_hardening.feature`.
- The pre-generation advice: `rosterSizing.test.js`, `teamingConfigurationAdvice.test.jsx`.
- The season fixture is re-run for B1 and B2 (AGENTS.md). It holds no player roster and no test of it
  imports the generator (_executed_ search), so it proves nothing about teaming; the suites above do.

## Risks

- **More pairs change rosters.** Programs with name requests produce different teams after B1.
  Watch: the buddy list's counts on the first real import. Reruns are safe: preserved players stay.
- **Blocked players lower the team count.** Advice counts the registered; generation, the eligible.
  The outcome warnings and "Not placed" make the gap visible.
- **Review of PR #647 (Codex).** A namesake tie is settled only by a reverse request that names
  the requester and nobody else in its division. Any request text with a digit that matches no
  registration id is `not-found`. The page reads names and the request from the durable player
  rows (the Player Record page's edits), for the program and the whole roster, in chunks of 200
  ids. `BuddyEvaluator` also steers a player toward a placed requester who named them, so an
  honoured one-way request is scored whichever of the two is placed first (still best effort,
  never a unit; the evaluator change ran against the season fixture and the regression suites).
  Buddy codes are grouped across the whole roster, so a code shared with another division is
  `cross-division-buddy`; only two program players in one division are linked. The list takes
  its pairs from the prepared players too, so a review-mode rerun keeps preserved pairs.
- **Header variants.** If the import rows carry a header form B1 does not read, requests stay lost
  silently. B1's page test uses the real canonical headers, and an import with a buddy column whose
  every request is unresolved shows that in the list.
- **Rollback:** each PR reverts alone; no data is written that a revert strands.

## Decisions for you

1. **One-way requests:** _answered (owner, 2026-10-22)_: a league setting, `buddy_rule` (B6),
   default mutual only with one buddy per player; `one_way_best_effort` is the league's choice.
2. **Name matching:** _answered (owner, 2026-10-22): yes._ Exact after normalising, ambiguity
   settled only by reciprocity, near misses listed, never linked, as identity resolution does
   (incident 6, the fixture README): a wrong pair is worse than a listed miss, and the admin fixes
   the request text.
3. **A rostered player who becomes ineligible:** _answered (owner, 2026-10-22): yes._ They stay
   and are listed; the sync is not blocked. The roster was reviewed; the admin moves them by hand
   if they agree.
4. **Saved overrides that were never chosen:** _answered (owner, 2026-10-22): keep them_, with the
   recommendation and "Use N" beside them. A saved estimate cannot be told from a choice.
5. **TeamBuilder (B5):** _answered (owner, 2026-10-22): yes._ TeamBuilder adopts the resolver and
   the league's buddy rule, so the two pages cannot disagree about who is a buddy (AGENTS.md:
   adopt the sibling's contract).

## As built (B1)

- **A one-way registration id is a one-way request.** `normalizeBuddyLinks` used to set a
  `buddyId` from any `buddy_request` that matched an external registration id, reciprocated or
  not. In the pipeline the resolver now consumes the request text first, so an id follows the same
  buddy rule as a name: under `mutual` a one-way id request is listed, not linked. Called directly,
  `normalizeBuddyLinks` keeps its old rule. On the page no id request reached the pipeline before
  B1, so nothing a league saw changes.
- **Registration ids match with case ignored**, as `materialize_import_buddy_pairs` does
  (`lower()` on both sides), not exactly as `normalizeBuddyLinks` does.
- **`self`** is a request matching only the requester. The requester's own name beside a
  namesake is `ambiguous` (it may mean the namesake) unless the namesake names the requester back.
  A request of one name only (no surname) is `unparsed`; text with a digit that matches no
  registration id is `not-found`. Names compare in Latin letters only (`normaliseNamePart`, the
  identity module's contract), so a name in another script is `unparsed`.
- **The rule's audit row** is `settings.flags_updated`, the action the settings page writes for a
  toggle, beside `update_org_feature_flags`' own `feature_flags.updated`: a new action would need
  a migration (`audit_actions`), and B1 has none.
- **Only a mutual pair sanctions a play-up** (route B). An honoured one-way request's `buddyId`
  is set after play-up eligibility, so it is scored best effort and sanctions nothing: the two
  may not land together. A requester whom a buddy code pairs keeps the code pair, and the one-way
  request is listed as not honoured (one buddy per player).
- **The list** is in the review view below the persistence panel, and reads
  `results.buddyRequestsByDivision` of the staged or the synced run; whether a pair is together is
  read from the run's current `team_players`, so a manual roster edit shows. It also lists
  buddy-code problems and `buddy-coach-conflict` pairs.
- **Header variants.** The page reads the keys `materialize_import_buddy_pairs` reads, and any
  header the import's alias map stages under one of them (`canonicalImportKey`). Every one is on
  the import allowlist (`PLAYER_IMPORT_KEYS`).

## As built (B2)

- **Natural age comes from the page's existing annotation, not a stored one (item 2, decided by
  the orchestrator).** R5 (the stored natural age) is not built, so B2 adds no column and leaves
  the durable-player query (`DURABLE_PLAYER_FIELDS`) as it is. The generator honours whatever
  `placement` and `naturalAge` `applyPlayUpEligibility` annotates from the data the page already
  has: the import row's birthdate (`toGeneratorPlayer` emits `date_of_birth`) against the
  division's age bounds (the saved division row, or the U-number in the program's name), with the
  season's `season_year` and cutoff. The page test (`tests/teamAnalysisEligibility.test.jsx`)
  generates from import rows with birthdates, fresh and on a rerun. **Moved to R5**
  (`2026-10-22-admin-focus.md`, R5's row): the durable query selecting the natural age,
  `toGeneratorPlayer` emitting it, and the page test that generates from stored players only.
  **Taken by R5** (`2026-10-22-admin-focus.md`, As built (R5)): `DURABLE_PLAYER_FIELDS` selects
  `natural_age`, `withDurableIdentity` carries it and `toGeneratorPlayer` emits it as `naturalAge`
  (read before a session row's birth date); `tests/teamAnalysisEligibility.test.jsx` generates
  from import rows with no birth date and durable players with a stored natural age, and gets a
  blocked play-down and an unknown player placed.
- **Where the annotation was lost** (_executed_, the page test against the old generator): not on
  the page. `prepared.players` reaches `generateTeams` with `placement`, `needsReview`,
  `reviewReason` and `naturalAge`, and the generator clones every field; it read none of them, so a
  play-down was seated (the plan's "Today" holds). The one path that loses it is the pipeline's
  `catch`, which generates from the raw roster when the pipeline throws; B3 removes it. A program
  whose division row has no age bounds and whose name carries no U-number classifies everyone
  `unknown`: placed, never blocked.
- **One rule, beside `PLACEMENT`:** `isEligibilityBlocked(player)` in `playUp.js` (blocked means
  `play_up_blocked` or `play_down_blocked`; anything else, a missing annotation included, is not).
  The generator calls it; B3 can.
- **One overflow entry per blocked player**, never a unit, ahead of the division's other overflow
  entries, in input order. `metadata.naturalAge` is `null` when not a finite number; `coachId` is
  the player's (`null` when none). Beyond the plan, `metadata.assistantCoachId` is added when the
  blocked player carries one, so an assistant left on no team is named (review finding).
- **A division where every player is blocked builds no teams** (review finding): before, the
  team count's floor of one (or `teamCountOverride`, `minTeams`) built empty shells that the page
  would stage and sync as if teamed. Now the division has no teams, every player is in overflow,
  and the page stops at its existing "No teams could be generated" guard and stages nothing
  (`tests/teamAnalysisEligibility.test.jsx`); the wording of that message is B3's.
- **A remapped player is not blocked** (review finding): with `remapBlocked: true` (a
  multi-division flow; the page passes `false`), `applyPlayUpEligibility` moves a blocked player
  to their natural division but keeps the placement it judged in the registered one.
  `isEligibilityBlocked` blocks only while `division` is still `registeredDivision` (or no
  registered division is recorded), so the moved player is placed where they belong.
- **Buddy reasons.** The unit builder sees eligible players only, so a request naming a blocked
  player would read `missing-player`. It is relabelled in the generator's
  `buddyDiagnosticsByDivision[div].unmatchedRequests`: `buddy-not-placed` when the blocked player
  names the requester back (the mutual buddy, placed alone), `not-reciprocated` (as before B2)
  when they do not. Two blocked buddies both overflow and leave no entry. On a rerun, a late
  player whose reciprocal buddy is a preserved (held) blocked player is still routed to that team,
  as before.
- **`eligibilityHolds`** is always present on an incremental division (`[]` when nobody is held)
  and is read from the final rosters: every blocked player seated anywhere is listed, and only a
  preserved one can be. Team ids are the preserved (persisted) ones. A blocked late player counts
  in `latePlayersOverflowed`.
- **Unchanged on purpose:** coach continuity (a blocked late player's `coachId` still shows their
  coach as registered, so the coach is not reported dropped; a held child still counts as a coach
  candidate on their team), and the org means `WeightedAttributeEvaluator` normalises against,
  which are computed over every registered player, the blocked included, as they include every
  player overflowed for capacity.
- **The golden** (`tests/fixtures/teamGenerationEligibility.golden.json`, written by
  `scripts/generate-teaming-eligibility-golden.mjs`) was captured at `a18734d` in the branch's
  first commit: a fresh roster with every non-blocking annotation, both existing overflow reasons,
  buddies, coaches and an assistant; a fresh roster through the real pipeline; and a review-mode
  rerun with preserved UUIDs, manual, locked and late players. The test compares the serialized
  output byte for byte (the rerun after removing its empty `eligibilityHolds`), and fails when the
  placement order changes (planted).
- **Season fixture:** every test file that loads `fixtures/season-2026/` and the "Must stay
  unchanged" suites ran green; as above, the fixture holds no player roster.

## As built (B3)

- **Failures stop the run.** The `coach_team_requests` read's `error` throws ("Could not read the
  coaches' team links, so teams were not generated: …"), and the `try`/`catch` around the
  pipeline is gone, so a pipeline throw reaches the page's one `catch` with its own message. Both
  land in `generationError` (the validation panel's "generation" row) and nothing is staged. The
  admin's read is allowed by the table's one policy, "Org admins manage coach*team_requests"
  (`20260530000000`, `FOR ALL TO authenticated USING (is_org_admin(...))`): \_statically
  reviewed*; the real-backend season flow, which reads it as the seeded admin, runs in CI only.
- **One review, "Players to review"** (`PlacementReviewList.jsx`, from
  `frontend/src/utils/placementReview.js`), in the review view above "Buddy requests", read from
  the staged or synced run's `results` as that list is:
  - **Not placed:** every player in `overflowByDivision`, whatever the reason, each with the
    reason in words and the natural age ("Natural age unknown." when none). Eligibility and room
    are worded apart ("Not eligible for this division. Older than the division allows, …" against
    "No room: the teams were full."), and a per-division line counts them apart ("3 not placed (1
    not eligible for the division, 2 for another reason)"), so capacity overflow is never reported
    as eligibility. A reason the list has no words for is shown as recorded ("Not placed (reason
    recorded: “…”)"), never dropped; an entry with no reason reads `unknown`.
  - **Needs review:** `eligibilityHolds`, with the team the player is on **now** (the run's
    `team_players`, which a manual edit rewrites; the hold's team when the rows lack them), plus
    any blocked player found on a current roster whom the holds do not name: the list is
    enumerated from the rosters, not only from the diagnostic that names them.
  - **Eligibility not checked:** each placed player whose `placement` is not a passed check
    (`in_band`, `play_up_sanctioned`): `unknown`, an unrecognised value, or none recorded. The
    flag is beside the name, here and on the player's card in the roster editor (Edit Mode); it
    never holds anyone off a roster. Said only when the run carries `teamsByDivision`; a run
    without it (the e2e seed's saved run, an old run) shows no such list and no "every player
    is checked" line, rather than a falsely perfect result.
  - Each list is a `<section>` labelled by its `<h4>`, inside the review's `<section>` with its
    `<h3>`, like "Buddy requests".
- **Announced once.** The page holds one polite live region (`role="status"`, `sr-only`), always
  mounted, whose text is set when a generation stages a review ("Players to review: 1 player not
  placed (1 not eligible for the division); 1 placed player: eligibility not checked.") and
  cleared when a generation starts or the review is discarded. Switching views or reloading
  re-renders the lists without announcing them again (a page test reloads and checks).
- **Wording of the all-blocked stop** (B2's hand-off): "No teams could be generated for U10: none
  of its players is eligible for the division (each plays down, or plays up without a coaching
  parent or a coach's child as a buddy). Not eligible (12): …, … and 9 more. Check their
  birthdates and the division's age band." When some, not all, are blocked and no team is
  built, the generic message gains how many were not eligible.
- **Buddy requests** say why a pair is apart when one is not placed (B2's `buddy-not-placed`):
  "Not placed together: Ada Blocked is not eligible for this division and is not placed." The
  reason is read from the run's `overflowByDivision`; a buddy not placed for room reads "… is not
  placed".
- **Unchanged on purpose:** the core metric shape. `metrics.overflowPlayers` and the overview's
  "Manual Review" count (`totals.manualReviewRequired`, every not-placed player) still sum every
  overflow reason; the review's per-division line is where the two are told apart. The Dashboard's
  table view's "Overflow" (`TeamListView`) is not on the Teams page and is left as it is.
- **Open owner questions, not built:** whether evaluator org means exclude blocked players; and
  whether to surface a coach whose only child is blocked. Showing the latter would take a join the
  run already allows: the `eligibility-blocked` entry's `metadata.coachId` (and
  `assistantCoachId`) names the coach, and `coachCoverageByDivision` says whether any team has
  them; the list would need the coach's name, from the `coaches` read the Coaches page makes or
  from the coach import.
- **Accessibility.** The repository has no unit-level axe (jest-axe) pattern. The lists are
  scanned where they render: both `late_registrant_reviewed_roster.feature` scenarios run the
  accessibility feature's axe step on the staged review in the light and dark themes (the first
  shows seven "Eligibility not checked" flags, the second a "Not placed" entry), and a planted
  unnamed `role="img"` on the flag fails it. Contrast is not proven by that scan: axe left the
  badge's colour pair unresolved even with its text planted at the background's colour, so it is
  computed from the tokens instead (`--warning-text` on `--warning-weak`: 5.20:1 light, 8.42:1
  dark), with the opaque `bg-status-warning-bg` rather than a translucent tint.
- **Review round (`/code-review`, fixed here):** "not checked" is said only for a division whose
  generated rosters hold player records (a manual-edit snapshot can rebuild them from team rows
  with no players, which would have flagged everyone); coach rows are read out of the roster by
  the persistence module's role rule (`isRosterPlayerRow`, now exported beside
  `NON_ROSTER_ROLES`); the Buddy requests list does not call a buddy whom the current rows seat
  "not placed"; the announcement is cleared with the review it was about (sync, discard, another
  organization or season); a placed player whose team names no division is listed under
  "Division not recorded". A "placed by hand" note for a not-placed player was dropped: the
  roster editor shows only rostered players, so no user can produce that state.

## As built (B4)

- **The outcome helper** is `summarizeTeamSizeOutcome(result, { rosterSizeByTeamId })` in
  `packages/core/src/teamSizeOutcome.js` (imported by path, as every top-level core module is;
  the package has no index). Per division of `teamsByDivision`: `underMin`, `overMax` (each a
  list of `{ teamId, teamName, playerCount }`) and `notPlacedForCapacity`. Teams are enumerated
  from the rosters and sized from them (or from the run's current `team_players`, coach rows
  left out by `isRosterPlayerRow` and each player counted once, on the first row's team, as the
  placement review reads them, so a manual edit shows; rows that seat nobody on a division's
  teams leave it to its rosters); the limits are the ones the
  generator wrote on each team's `rosterBalanceByDivision` stats. So a fresh run, which carries
  no `capacityViolations`, is checked from its rosters; a rerun's `capacityViolations` is used
  only when the stats carry no maximum. A division it cannot check (no recorded maximum, or team
  rows with no players, as the mock seed's saved run has) reads `null`, and the page says "not
  checked", never that every team fits.
- **Capacity reasons:** beyond the plan's `insufficient-capacity` and `coach-capacity`, a rerun's
  `buddy-target-capacity` (no room on the buddy's team) counts as no room too
  (`CAPACITY_OVERFLOW_REASONS`). Eligibility is never counted there.
- **Where it shows:** a "Team sizes" section (`TeamSizeOutcomeList.jsx`) directly below the
  Teaming Overview's counts and above the sync panel, a line per division ("U10: 3 teams, 30
  players placed. Rosters of 10 to 14 players.") with its warnings beside it. Who was not
  placed is not listed again: the warning gives the count and the reasons and points to B3's
  "Not placed" list. The page's one polite live region now reads the team-size sentence before
  B3's ("Team sizes: 1 team under the minimum roster. Players to review: …"), set once per
  generation as before.
- **The overview** shows Est. Teams (the count generation will build), Recommended and a status
  from `assessTeamCount`: "Fits the limits", a badge per warning ("Teams over the maximum",
  "Teams under the minimum", "Too few players for one team", "Override not used"), or "Settings
  need fixing" when generation would refuse the rules (Est. Teams then reads "—"). Each
  program's name is a native button in the row's first cell, `aria-current` while it is the one
  being configured (a single selection, not a toggle); the row stays clickable with a mouse.
  Est. Teams now counts the head coaches too, so it agrees with the panel.
- **Coaches** are counted in `derivePrograms` by calling `toGeneratorPlayer` on each import row
  and collecting the distinct `coachId`s, the generator's own count: a coach email, or a
  willing-to-coach flag (which today makes the player a synthetic coach; B6 changes that, and
  this count follows). It is the import's count, not the run's: coaches that
  `coach_team_requests` links at generation are not read before it (they can add teams), and a
  coach whose child is not eligible anchors no team (B2; it can remove one), as the advice counts
  the registered players and the generator the eligible ones (Risks, above). The panel says "and
  N head coaches".
- **Auto by default:** `createDefaultConfig` sets no override, so a program with no saved
  division row generates and saves `team_count_override = null`. A saved override (decision 4)
  is kept as before; the panel already showed the recommendation and "Use N" when the two
  differ, and the overview's "Override not used" now says when generation will not use it.
- **Tests:** `tests/teamSizeOutcome.test.js` (core, real generator runs: under-min fresh, over-max
  on a rerun with `allowOverCapAssignments`, capacity and coach-capacity overflow, a result
  without `capacityViolations` or limits reading `null`, a stored run's ids and current rows);
  `tests/teamSizeReview.test.jsx` (the section and the announcement); the page tests in
  `tests/teamingConfigurationAdvice.test.jsx`; e2e, a Pillar 1 scenario reads the overview's
  count and status for one of two programs, chooses the other with the Enter key (failing with
  the row's control planted back as a span) and scans the overview with axe in both themes
  (failing on a planted unnamed button), and the generation scenario reads "Team sizes". The
  Pillar 1 import step now builds its rows in one helper, so the two-program step adds no mock
  write of its own. The late-registrant scenarios'
  axe scans now include the section's warnings (the saved teams are under the minimum).
- **Contrast** of the warnings is the tokens' pair B3 measured (`--warning-text` on
  `--warning-weak`); the overview's badges are the `Badge` primitive's, scanned by axe in both
  themes.
- **Review round (`/code-review`, fixed here):** the Enter-key step chose a program already
  chosen (now one of two); duplicate rows counted a player twice; rows that seat nobody on a
  division's teams read every team as empty; a toggle (`aria-pressed`) for a single selection;
  an estimate shown for rules generation refuses; and the coach count called a floor when a
  blocked child can lower it. Not changed: a player not placed and then seated by hand would
  still count under "no room", but the roster editor shows only rostered players, so no user can
  produce that state (B3's finding); the name and pluralising helpers are not shared with B3's
  module, which would be a refactor of B3's file.

## As built (B5)

- **One rule, three steps, shared.** `boardBuddyLinks(players, { roster, buddyRule })` in
  `balanceSignals.js` calls what `prepareTeamingInput` calls, in its order:
  `resolveBuddyRequests`, `applyBuddyRule` (moved unchanged from `teamingPipeline.js` to
  `buddyLinking.js`, beside `BUDDY_RULES`; the pipeline imports it) and `normalizeBuddyLinks`;
  then a one-way request whose requester a buddy code paired is dropped, as the pipeline drops
  it. A board has no head-coach anchors, so the pipeline's `buddy-coach-conflict` break has
  nothing to break. `buddyStats` and `serpentineAssign` read it. A parity test
  (`tests/balanceAndCoed.test.js`, "finds the same buddies as the Team Analysis pipeline") holds
  its mutual pairs and honoured one-way requests equal to the pipeline's for every board in the
  suite, under both rules, including codes and requests reaching another division or a player off
  the board.
- **Buddy codes pair on the board too** (beyond the plan's text, for decision 5's "the two pages
  cannot disagree"): before, TeamBuilder read `buddy_request` only and ignored
  `players.mutual_buddy_code`, which Team Analysis pairs. A code shared by exactly two players of
  one division is a mutual pair; a third holder anywhere on the roster, or a holder in another
  division, pairs nobody.
- **Mutual (the default):** a mutual pair is one unit, dealt together. A one-way request is
  neither paired nor counted in "buddies met" (before, every one-way name match paired).
- **One-way best effort:** an honoured request (the named player listed no buddy) is never a
  unit. Whichever of the two is dealt second goes to the other's team when that team is still a
  candidate (the coach spread can rule it out) and holds no more players than the team the deal
  would pick anyway, so requests naming one player cannot pile onto that player's team (review
  finding: ten requesters gave 11 against 3). This size check stands in for the roster limits the
  generator has and the board does not; so the board can honour fewer requests than the
  generator does. "Buddies met" counts each honoured one-way request once and each member of a
  mutual pair once.
- **The page** reads `buddyRule` from `useFeatures` and passes it, with every player as the
  roster, to the tile and to auto-balance. A player's buddy division is its `division_id`, as the
  program is in Team Analysis: under the co-ed model a board folds U10B and U10G into one, and a
  pair across the two is not paired (open question below). Waitlisted players stay off the board
  as before, so a request naming one is not found. With Buddy Requests off nothing is matched.
  The "Keep buddies together" toggle and `respectCoach` are unchanged; replacing them with league
  settings is B6.
- **Cost** (_executed_): `buddyStats` on a 100-player board with a 2,000-player roster takes about
  5.7 ms. It runs again on each `players` change, including each optimistic move during
  auto-balance; not memoised.
- **Tests:** `tests/balanceAndCoed.test.js` (two players of one name, unsettled and settled by
  reciprocity, under both rules; one-way under both rules, with steering both ways, a name
  variant, the coach spread parting the two, a named player who listed another buddy, a requester
  a code pairs, many requests naming one player, and steering when the smallest team is not a
  candidate; buddy codes across the roster; the parity test) and
  `tests/teamBuilderBuddyRule.test.jsx` (the page from stored flags: default, stored `mutual`,
  stored `one_way_best_effort`, and a co-ed board of two divisions; it reads the tile and the
  audited per-player moves). Every new case fails against `main`'s code. Thirteen planted
  defects, one or more per rule, each failed at least one test.
- **Review rounds (`/code-review`, fixed here):** unbounded steering; the board's filter key as
  the buddy division (co-ed boards paired across divisions); the pipeline import pulling coach
  linking and play-up into the board; a hand copy of the rule with no drift check (now the parity
  test); the resolver running with the flag off. Re-review of that round: the cap compared
  against the smallest team overall, refusing harmless steering, and the doc comment claimed an
  invariant only the size signal kept; the parity test had no off-board case. Not changed: the
  full re-resolution on each move (measured above); a waitlisted third holder of a code breaking
  a pair (Team Analysis's roster holds waitlisted players too, so it breaks the pair there as
  well).
- **Open owner question:** a co-ed league whose U10B and U10G are not yet merged sees one board.
  Before B5 a pair across the two was kept together; now it is not, as Team Analysis (one program
  at a time) and the import's `materialize_import_buddy_pairs` (same division) never pair it.
  Should a co-ed board pair across its folded divisions?

## As built (B6)

- **A lead is not a coach.** `toGeneratorPlayer` no longer makes a synthetic `coach-<id>` from a
  willing-to-coach answer; it emits `isCoachingLead: true` (only with Coaching Interest on, as B1
  emits buddy fields only with Buddy Requests on) and `years_played`, and the admin's `rating`
  when the record holds one. A coach the import row names (`coach_email`, `coach_id`) still
  anchors as before: `PLAYER_IMPORT_KEYS` keeps no such column, so in production only
  `coach_team_requests` links do, and the mock and tests keep their coach-email rows. B4's coach
  count follows: a lead adds no team to the advice (`teamingConfigurationAdvice.test.jsx`).
- **The lead comes from the record.** The durable read (`DURABLE_PLAYER_FIELDS`, beside R5's
  `natural_age`) now selects `willing_to_coach`, `years_played` and `rating`, and
  `withDurableIdentity` puts them over the import row, as it does names: the stored flag is what
  `finalize_import_job` read, whose vocabulary ("Maybe", "Head Coach", "Volunteer" and the
  rest, `COACHING_LEAD_ANSWERS`) the row fallback now shares. Before, the page read only
  yes/true/1 from the row, so "Maybe" (166 of the demo league's 1,259 rows) was a volunteer in
  the database and not on the Teams page.
- **One rule, `packages/core/src/coachingLeads.js`,** with `divisionLeadCompensation` and
  `carriesSignal` beside `playerSignal` in `balanceSignals.js`; the generator and TeamBuilder's
  `serpentineAssign` call the same functions. After coaches' children (priority 1, unchanged),
  units holding a lead are dealt first, the most leads first, each to a team with the fewest
  leads among those with room (`withFewestLeads`); every other unit goes to the lowest
  `signal total + c × leads`, then the smallest roster, then the seeded draw. A best-effort
  buddy (`BuddyEvaluator`) narrows the teams first, so `one_way_best_effort` is still honoured.
  A board has no coach anchors (B5), so TeamBuilder applies priorities 2 and 3.
- **`c` per player, not per unit.** The plan says "the division's mean unit signal (one lead
  counts as one average player)"; `c` is the mean **player** signal times
  `LEAD_COMPENSATION_FACTOR`, so a buddy pair does not count as one "average player".
- **When there is nothing to compensate with, the evaluators decide.** With the league's signal
  roster size only, or no player of the division carrying a value for it (Years Played on, but no
  years in the file), `c` is 0: leads are still spread, and the rest is placed by the evaluators
  (`WeightedAttributeEvaluator` and the custom weights), as in a division without leads (review
  finding: otherwise one ticked box replaced skill balancing with a deal at weight one). With a
  signal, the compensated deal replaces the evaluators' skill score for that division, as the
  plan says; the evaluators still run for every division with no lead.
- **Unchanged without leads.** With the setting off, or no lead in the division, the generator's
  path is the pre-B6 one: B2's golden (byte for byte), the characterization, seed, rerun and
  incremental suites pass unchanged, and a test holds a division with leads and the setting off
  equal to the same division with the flag stripped.
- **Reruns.** Late players are placed by the same rule, the leads counted over the preserved
  rosters and the eligible late players, each once; nobody preserved moves and team UUIDs are
  kept. Rosters persisted before B6 carry no coach for a lead (`coach_id` is kept only when it is
  a UUID, `teamReviewPersistence.js:172`), so a rerun sees no dropped coach.
- **The setting** is `teaming_spread_coaching_leads` (`FEATURE_FLAGS.TEAMING_SPREAD_COACHING_LEADS`,
  default on, in the catalog as "Spread Coaching Leads"), a boolean, so `FeatureFlagSchema`
  needs no branch and refuses a non-boolean; it is audited through `update_org_feature_flags`
  and the page's `settings.flags_updated` row. **No migration:** the RPC stores the JSONB as
  given and no SQL reads the key (`org_flag` reads booleans by name for the server-side reads,
  and nothing calls it with this key). TeamBuilder spreads leads when this and Coaching Interest
  are both on, since a lead is read from that column; its two toggles ("Keep buddies together",
  "Spread coach parents") give way to a read-only line of the league's settings, and its
  `teams.auto_balanced` audit row records them.
- **The Lead mark:** a "lead" badge on the player's card in the Teams page's roster editor (read
  from the run's rosters, `isCoachingLead`) and a "Lead" mark, in text, on the Team Builder chip
  (it was an icon with a title only). Nothing about a lead's parent is stored or shown.
- **Tuning `c`** (_executed_, a scratch script, not committed: the demo league's 21 divisions
  through `prepareTeamingInput` and `generateTeams` with the page's field mapping, one head coach
  per export team linked to their child, the README's team counts and roster sizes, ten seeds
  each, Years Played on). Factor 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2. With rosters exactly full,
  the spread of "mean years per player, a lead counted as one average player" across a
  division's teams was 0.204, 0.188, 0.158, 0.130, **0.129**, 0.152, 0.189 and 0.259; with three
  spare places per roster, 0.461 (factor 0), 0.424, 0.363, **0.299**, 0.299. So **1**, the
  plan's own reading ("one lead counts as one average player"), is kept. At 1, leads never
  differ by more than one in any division (the setting off: up to nine), every player is placed,
  rosters differ by at most one when full (two with spare places), and in 1,390 of 1,400 team
  pairs with different lead counts the team with fewer leads has the higher mean experience.
- **The demo league teamed end to end** (_executed_): every division as above, every player
  placed; and its U10 boys through the Teams page itself (`tests/teamAnalysisCoachingLeads.test.jsx`):
  88 players, 8 teams, no coach from a lead, leads within one (on `main`: 13 teams, one per
  "Yes").
- **Tests** (each fails on `main` or on a planted defect, _executed_): `tests/coachingLeads.test.js`
  (a lead anchors no team; 2/1/1; 2/2/2 by count, not load; units holding leads placed first; a
  coach's child who is a lead; mutual leads together; compensation, which fails with the factor
  0; the setting off; no signal carried; the buddy rule under leads; a late lead on a rerun; the
  same for the board); `tests/teamAnalysisCoachingLeads.test.jsx` and
  `tests/teamBuilderCoachingLeads.test.jsx` (the pages from stored flags: default and stored
  off; Coaching Interest off; the record winning over the file; a blank rating); the Lead mark
  (`tests/RosterManagerLeadMark.test.jsx`) and the setting (`tests/FeatureFlagSettings.test.jsx`).
  Planted: the factor 0; no fewest-leads filter (generator and board); no buddy steering; the
  setting ignored (generator and board); lead units not dealt first; compensating with no
  signal; `willing_to_coach` not read; a rating of 0 carried; the page emitting leads with
  Coaching Interest off, passing no flags, ignoring the stored lead, or reading a blank rating as
  0; the board's audit row without the settings. Each failed at least one test.
- **Review rounds (`/code-review`, fixed here):** compensation at weight one when nobody carries
  the signal; a rerun counting late coach and buddy players twice for `c`; a blank rating read as
  0; TeamBuilder's audit row without the settings; the setting's description silent on Coaching
  Interest; stale comments calling a lead a coach. Re-review of that round: `c`'s rule copied in
  two places (now `divisionLeadCompensation`); `carriesSignal` and `playerSignal` disagreeing on a
  0 or blank rating (now `ratingOf` for both); the docs silent on the fallback; the audit row
  unable to tell the setting off from Coaching Interest off. Not changed: compensation turns on
  when **some** player carries the signal, so a file with years for a few players weighs the rest
  as rookies, as TeamBuilder always has (a GotSport column is filled for every row or absent);
  the per-candidate rescans of each roster (a division of 120 players and 8 teams is the largest
  in the demo league; the whole league tunes in seconds); a second placement path beside the
  evaluator registry rather than a lead evaluator (a hard "fewest leads" filter is not a score).
  The rerun double count has no test of its own (_statically reviewed_).
- **Open owner questions:** should a coach the import row itself names still anchor (only the
  mock and tests carry such rows); should compensation also weigh the custom attribute weights
  the evaluators use; should Spread Coaching Leads be hidden or disabled while Coaching Interest
  is off (today its description says it needs it).

## Not in Phase B

Remapping a blocked player to their natural division (the page generates one division at a time);
reading or dropping `player_buddies` (it stays the import's report); a program attribute (E).

## Investigation notes

- Which key form the stored import rows carry (`'Buddy Request'` or `buddy_request`) was not
  verified; `toGeneratorPlayer`'s mixed variant lists suggest both occur.
- Whether real GotSport exports ever hold several names in one buddy field was not checked.
- `frontend/src/hooks/useTeamAnalysis.js:111` has a third team-count formula and no caller outside
  its test; left alone.
- No flag gates the waiver (only `medical_forms` exists); the paperwork rule follows the compliance
  page, unverified against owner intent.
- Executed probes were scratch scripts against `packages/core` (not committed); the four existing
  suites run (`teamingPipeline`, `buddyLinking`, characterization, advice) passed, 30 tests.
