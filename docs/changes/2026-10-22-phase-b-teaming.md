# Phase B: teaming

Status: **proposed 2026-10-22, for owner approval** (AGENTS.md rule 14: B2 and B6 change the
generator, B1 the domain model of buddy requests). B6 records the owner's team priorities of
2026-10-22. It applies the owner's decisions of 2026-10-20 (`2026-10-20-core-roadmap.md`) to the
teaming core: buddy requests, research item 3 (eligibility), and team counts per program. No
migration: everything new is computed, and the run's `results` JSON is stored opaque
(`team-persistence/index.ts:53`, `runMetadata: z.record(z.unknown())`). Six PRs, in this order; B2
and B6 touch the solver. Each is reviewed once before it opens.

**Superseded in part (owner, 2026-10-22, `2026-10-22-admin-focus.md`):** the paperwork flags
(payment, waiver, medical form) and the Compliance page are removed in R1, and B2 and B3 below no
longer flag paperwork; the waitlist stays the gate an admin uses. Birthdates give way to a stored
natural age in R5, which B2 carries into the generator.

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
- **Header variants.** If the import rows carry a header form B1 does not read, requests stay lost
  silently. B1's page test uses the real canonical headers, and an import with a buddy column whose
  every request is unresolved shows that in the list.
- **Rollback:** each PR reverts alone; no data is written that a revert strands.

## Decisions for you

1. **One-way requests:** _answered (owner, 2026-10-22)_: a league setting, `buddy_rule` (B6),
   default mutual only with one buddy per player; `one_way_best_effort` is the league's choice.
2. **Name matching:** exact after normalising, ambiguity settled only by reciprocity, near misses
   listed, never linked? _Recommended: yes_, as identity resolution does (incident 6, the fixture
   README): a wrong pair is worse than a listed miss, and the admin fixes the request text.
3. **A rostered player who becomes ineligible** stays and is listed; the sync is not blocked?
   _Recommended: yes._ The roster was reviewed; the admin moves them by hand if they agree.
4. **Saved overrides that were never chosen:** keep them, or reset to Auto? _Recommended: keep_, with
   the recommendation and "Use N" beside them. A saved estimate cannot be told from a choice.
5. **TeamBuilder (B5):** adopt the resolver and mutual-only pairing? _Recommended: yes_, so the two
   pages cannot disagree about who is a buddy (AGENTS.md: adopt the sibling's contract).

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
