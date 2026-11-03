# Play-down off by default; every play-up and play-down flagged and counted by the division played

Kind: FEATURE (a setting, flags and counts) with a defect fix (the team-count advice counts by the wrong
division) · Drawn up: 2026-11-03 against `origin/main` `2ae6333` · Owner: the repository owner · Status:
**APPROVED 2026-11-03: every decision of section 7 as recommended (record in section 7); PR 1 is in build, PR 2
and PR 3 are not started.** AGENTS.md rule 14 applies (the change touches what team generation seats, which is
the domain model); the owner's approval is the plan it asked for. Persistence is touched only by an existing
JSONB column through an existing audited RPC: no migration is planned.

Every claim about the code is _statically reviewed_ (read) unless marked _executed_. Executed figures come from
`npx vitest run` on the unmodified tree and from throwaway scripts kept outside the repository (they import core
by absolute path and change nothing), run on 2026-11-03 after `npm ci` (one engine warning for a dev dependency;
nothing forced). A claim of absence was made only after a search that matches something; the positive control is
named beside it. Figures copied from an earlier plan are labelled as such and were not re-run.

## Owner requirement (2026-11-03, verbatim)

> "Play-down should not be available by default, to be clear. Flag any play-up or play-down both in division and
> program views with counts for each."

Folded in by the owner: the open follow-up of `docs/changes/2026-11-02-data-followups.md` ("Not covered"). The
team-count advice counts a player in the program they **registered** in; generation seats them in the division
they **play** in; the two can disagree.

Principles the owner has on record (as relayed with the request): a program spans divisions and each division is
in exactly one program; play-up is by request (`docs/changes/2026-10-27-play-up-by-request.md`); one-way buddies
are best effort; sunset conditions warn and never refuse (flags over refusals); an unused or unrequested
capability is off, not hidden. The relayed line "coaches view permits read-only" does not match the code; see
finding 3.

## Size verdict (prompts/plan-change.md, Step 0)

Planned, not small. It meets: spans more than one pull request (three are proposed); changes behaviour other code
and people rely on (the Division Overview's player counts and recommended team counts, the Play-up section's
sentence); touches the domain model (what the placement function decides, rule 14); adds a setting. It does not
meet: no data model or migration (the setting is a key in an existing JSONB column), no dependency, no service, no
environment variable, no new authorization path.

## Findings that change the question

1. **Play-down is already not available by default in team generation.** No branch of the placement function
   seats a player, whose age and division bands are known, in a division younger than their age; a player registered younger is moved to their own age
   division (or left unplaced when none holds their age). _Executed_: `tests/playUp.test.js` ("a play-down plays
   in the player's own age division", "a play-down is not honoured even when the flag is set") and the 9 pinning
   test files below pass (181 tests). The owner's sentence is already true of generation; what is missing is the
   visibility, an enable path, and the one path where play-down **is** available by default: manual roster moves
   (finding 2).
2. **The only default path to a play-down is a manual move in the roster editor, and its warning cannot fire in
   production.** `RosterManager` moves a player to a team of any division (`RosterManager.jsx:260-300`, "All
   divisions"); the age check is `useConflicts.js:97-120`, which needs `team.minAge`/`maxAge` and
   `p1.playUpRequested`. The page builds teams from persisted team rows (`TeamAnalysisPage.jsx:2210-2250`) whose
   keys are id, organization, division, name and coaches (`teamReviewPersistence.js:162-183`); the `teams` table
   has no age column; the page never passes `playUpRequested`; an unmatched player's age defaults to 10
   (`:2235`). The E2E scenario that shows the banner forges `min_age`/`max_age` onto the team
   (`tests/e2e/steps/team_and_roster.ts:239-243`), a state production cannot produce (AGENTS.md: a test that forges
   state the production path cannot reach is evidence of a bug). Statically reviewed; section 4.7 fixes it.
3. **There is no coach view to be read-only.** The owner removed coach sign-in and every coach screen on
   2026-10-27 (`docs/changes/2026-10-27-admin-only.md`; `docs/product.md` "Users": "there are no coach, family or
   public pages"); migration `20261104010000` drops `get_my_division_teams` and `admin_get_division_teams`;
   `permissions.js` has no coach role. So nothing here reaches a coach, and "read-only for coaches" holds by
   construction. If the owner meant something else (a read-only artifact coaches receive), it is not in this plan
   (decision 9).
4. **The disagreement is wider than advice versus generation: three bases on one page.** The Division Overview
   counts by registered division (`derivePrograms`, `TeamAnalysisPage.jsx:159`); the Play-up section counts by
   registered kind (`playUpReview.js:84-91`, "2 play-ups (1 requested, 1 not), 1 play-down"); generation seats by
   division played. For a division the file has registrants in, a moved player is counted in both the division they
   left (too many) and not in the one they joined (too few): `destinationPrograms` (`:1113`) adds only divisions the
   file has **no** registrant in. _Executed_ on the season-2026 registrations (1,153 rows, real age bands read off
   the data) with 6 age-12 players re-registered in U10B and 4 age-10 players re-registered in U12B (one with a
   request): the registered counts the page's `derivePrograms` would give (read, not run) are U10B 81 and U12B 91, the placement (executed) seats 78 and 94, and
   `resolveTeamCount` at a maximum roster of 10 gives **9 teams advised against 8 seated** for U10B.
5. **Real exports mark play-up requests, not play-ups.** _Executed_ on `fixtures/demo-2026/players.csv` (1,259
   rows) and on the season fixture (1,153): the app's placement gives 0 play-up, 0 play-down and 33 (demo) and 29
   (season fixture) "requested a play-up but registered in their own division" (`kind: requested-own-division`).
   The export's own team columns hold the play-ups (the demo README: 50 older, 1 younger) and are stored as
   `custom_attributes.team_age`, which nothing reads (`importAllowlist.js:411-413` is its only mention). So a
   division view that counts only seated play-ups reads 0 for a league where 33 families asked. Decision 5.
6. **Core already counts play-up and play-down, and nothing reads it.** `applyPlayUpEligibility` fills
   `diagnostics.counts` (`playUp.js:356-377`); its only readers are tests (search below, with the control). A
   field produced and never read is the repository's named hollow guarantee; the plan replaces it with the one
   per-division count (task A1).
7. **A file with an age group and no division column flags everyone.** The finalizer derives the division as
   `U(age group + 1)` (`20261108010000:701-711`) while the stored natural age is the age group itself.
   _Executed_ (constructed row): natural age 7 registered in a derived U8 is `play_up` and moves to U7, or is
   `no_division` when the season has no U7. The new counts would show this loudly, which is useful, but it is a
   separate defect and is **not** fixed here (decision 10).
8. **Flipping the setting after rosters exist can drop players.** A re-run removes a preserved-roster player who is
   no longer in the division's incoming rows (`incremental-teaming-hardening.md:507-511`, `droppedPlayersRemoved`);
   a seat that changes because a setting changed looks, to the re-run, like a drop. The same is true today of
   clearing a play-up request (statically reviewed; task C3 pins it first).

## 1. Today: what play-up and play-down mean here (question A)

**Definitions.** A player's natural age is the U-number the season's cutoff gives their birth date at import (stored
as `players.natural_age`), else the age group the export states. A division's band is its saved `min_age`..`max_age`,
else read from its name ("U10" is 10 to 10). Younger than the band is a **play-up**; older than the band is a
**play-down** (`classifyPlacement`, `ageGroups.js:426-433`).

**Where each is decided.** One function, `applyPlayUpEligibility` (`playUp.js:302-354`, pass 1), pure and per
player: it reads the player, the divisions and the season's age rule, and no other player. Its decisions:

| The player is                                     | Request | Plays in                                | Listing kind                    | `placement`   |
| ------------------------------------------------- | ------- | --------------------------------------- | ------------------------------- | ------------- |
| in the registered division's band                 | no      | registered division                     | none                            | `in_band`     |
| in band                                           | yes     | registered division                     | `requested-own-division`        | `in_band`     |
| younger than the band (registered older)          | yes     | the registered (older) division         | `play-up`, requested            | `play_up`     |
| younger than the band                             | no      | own age division, same gender or co-ed  | `play-up`, not requested        | `play_up`     |
| older than the band (registered younger)          | any     | own age division, same gender or co-ed  | `play-down`                     | `play_down`   |
| younger or older, and no division holds their age | any     | nowhere: not placed, listed             | `no-division`                   | `no_division` |
| no age, or the registered division has no band    | any     | registered division, nothing is checked | `requested-age-unknown` or none | `unknown`     |

**Where each is counted, shown or acted on.**

- The Division Overview counts players by registered division and leaves out the waitlisted and the not eligible
  (`derivePrograms`, `deriveProgramStats`, `ProgramOverview.jsx`, `TeamingConfiguration.jsx`).
- The Play-up section lists every `play-up`, `play-down`, `requested-*` and `no-division` entry of a run with a
  sentence of totals by **registered kind** (`PlayUpList.jsx`, `playUpReview.js`); the page announces it once per
  generation (`TeamAnalysisPage.jsx:1935`).
- The placement review lists who was not placed, who is held on a reviewed roster, and who was placed with
  "eligibility not checked" (`placementReview.js`).
- Generation seats by the division played (`playsHere`, `:1780`), and leaves `cannotBePlaced` players out of the
  team count and of the league-wide averages (`teamGeneration.js:237`).

**Is play-down available by default, and through which path?**

| Path                                                     | Available by default?                                                                                                      | Evidence                                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An import column                                         | No. The only column is `play_up`, stored as `play_up_requested` (play-up only)                                             | `gotsport-import-contract.md:81`; `playUp.test.js` "not honoured even when the flag is set" (executed)                                                            |
| A request                                                | No play-down request exists                                                                                                | same                                                                                                                                                              |
| The division band rule (registered younger than the age) | Not honoured: own age division, or not placed when none                                                                    | `playUp.js:341-349`; executed on the fixture (section 8)                                                                                                          |
| Generation, fresh or re-run                              | No: nothing seats below the age                                                                                            | `rg PLAY_DOWN` has 5 non-test hits, none seats (control: it matches the definition at `playUp.js:35`)                                                             |
| Manual move in the roster editor (`RosterManager`)       | **Yes**, any player to any team of any division, no warning in production                                                  | finding 2                                                                                                                                                         |
| Team Builder, Player record                              | No for a person: the choice is the player's own stored division, and `admin_update_player` refuses another division's team | `TeamBuilderPage.jsx:111-123`; `20260611000100:196-224`. A direct call to `persist_team_schedule` (`20260503040000`) checks the division's organization, not ages |
| The export's team columns (`team_age`)                   | Stored, read by nothing                                                                                                    | `importAllowlist.js:411-413`                                                                                                                                      |

**Every consumer of the decision** (statically reviewed; searches in section 8):

- Core: `playUp.js` (the decision, `isEligibilityBlocked`, `cannotBePlaced`, `withFinalBuddyFacts`);
  `teamingPipeline.js:191` and `breakPlayedApartPairs` (`:97`); `teamGeneration.js` (`:237`, `:596`, `:1304`);
  `waitlistException.js:84,109`; `constants.js` (`REASON_EligibilityBlocked`).
- Teams page: `TeamAnalysisPage.jsx` call sites at `:634` (the advice's not-eligible set), `:1122` (destination
  divisions) and `:1780` (who plays here), `toGeneratorPlayer` (`:834`, the request), `withDurableIdentity` (`:488`,
  the record's request and age win over the file's), `derivePrograms`, `buildDivisionDescriptors`.
- Components and helpers: `ProgramOverview`, `TeamingConfiguration`, `PlayUpList`, `playUpReview`,
  `PlacementReviewList`, `placementReview`, `BuddyRequestsList.jsx:16`, `useConflicts` and `RosterManager`,
  `PlayerRecordPage.jsx:298-308` (the request field), `importAllowlist.js`, `telemetryUtils.js:173-175`, and the
  mock finalizer's request (`mockSupabaseClient.js:5486-5557`).
- Edge and database: `import-validation` and `natural-age.ts` (the age), `finalize_import_job` (writes
  `play_up_requested`), `apply_player_patch` (edits it); nothing in the database judges an age against a division
  (`players_enforce_season` checks seasons only, `20261108010000:296`).
- Pinned by tests (_executed_, all passing, 9 files, 181 tests): `playUp`, `teamGenerationEligibility`,
  `teamAnalysisPlayUp`, `teamAnalysisEligibility`, `teamingOwnerDecisions`, `placementReview`,
  `teamingConfigurationAdvice`, `teamingPipeline`, `waitlistException`.

## 2. The views (question B)

The Teams page's identifiers call a division a "program" (`derivePrograms`, `ProgramOverview`, as its own comment
says); the owner's **program** is the `programs` table, a group of divisions (`groupByProgram`). Only two screens
know programs: the Teams overview (headings) and Settings > Season > Programs (configuration, no players).
Searched, with the control that it matches: `rg "groupByProgram|usePrograms" frontend/src` lists `TeamAnalysisPage`,
`programGroups.js`, `usePrograms.js`, `ProgramsSection.jsx` and nothing else.

| Surface                                                                   | View            | Shows now                                                                     | Where flags and counts go                                                                            |
| ------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Division Overview (`ProgramOverview.jsx`; import session, pre-generation) | division        | Players (waitlist, not eligible beneath), Est. Teams, Recommended, Avg Roster | a column "Play-up and play-down"; moved notes under Players; a one-line league total above the table |
| Its program headings (`groups`, only when a program holds a division)     | program         | the heading text                                                              | counts in the heading row (the sum of its divisions' seated players, each player once)               |
| Division panel (`TeamingConfiguration.jsx`)                               | division        | the recommendation sentence, "N not counted"                                  | the same moved note, so the sentence says who moved here                                             |
| After generation: Play-up section (`PlayUpList`), placement review        | division        | rows per division, totals by registered kind                                  | the totals sentence from the one count; rows unchanged                                               |
| Roster editor (`RosterManager`, "Show division")                          | division        | a red "Conflict Detected" banner (age check dead in production)               | its own "Play-up and play-down" list from the seats on the roster                                    |
| Settings > Season > Programs (`ProgramsSection.jsx`)                      | program         | divisions in each program; reads no players                                   | **not in this plan** (decision 7)                                                                    |
| Players grid and record, Team Builder                                     | stored division | registered division; Team Builder keys its board by it                        | not in this plan                                                                                     |
| Exports, ICS feeds, master export                                         | none            | no play-up or age data (search below)                                         | unchanged                                                                                            |

A league with no program of its own sees one flat list and no program heading (`groupByProgram` returns `null`);
it therefore has no program counts. The league total line is what it sees.

## 3. Design for "play-down is not available by default" (question C)

Options and costs:

| #   | Option                                                               | Stored in                                                                                                                 | Persistence (rule 14)                                                                                                                                            | Cost  | Verdict                                                                          |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| 0   | A hard rule: play-down is never honoured (what the code does)        | nowhere                                                                                                                   | none                                                                                                                                                             | zero  | the fallback if decision 2 is "no setting now"                                   |
| 1   | An organization setting `play_down`, off unless an admin turns it on | `organizations.feature_flags` (existing JSONB), written by `update_org_feature_flags`, audited as `feature_flags.updated` | **none**: no migration, RPC, CHECK or Zod branch (a boolean key is kept when it is in `FEATURE_FLAGS`; the RPC has no key list)                                  | S + S | **recommended**                                                                  |
| 2   | A per-season column                                                  | `season_settings`                                                                                                         | migration; the four season writers (md5-guarded); the cutoff guard and freeze rules (lessons 58, 63, 64); Zod; audit; rollover copy; mock; pgTAP; harness plants | L     | rejected: a setting nothing needs to vary by season                              |
| 3   | A per-player `play_down_requested`                                   | `players`                                                                                                                 | migration, finalizer mapping, `apply_player_patch`, Zod, audit, an import column, mock, demo; one more flag about a minor (data minimization)                    | L     | later, as a gate **on top of** option 1, if the owner wants play-down by request |
| 4   | A per-division setting                                               | `divisions`                                                                                                               | `admin_upsert_division_settings` and columns                                                                                                                     | M-L   | no use case named                                                                |

**Recommendation: option 1.** It matches the repository's idiom for an optional capability (`skill_tier`, E3c: off
unless turned on, the page reads it, the generator is handed the result; lesson 75), it is off by default by
construction (an absent key is off: `FEATURE_DEFAULTS` needs no entry), it is visible as an off switch in
Settings > Features ("off, not hidden"), and its change is audited with old and new values already.

**Semantics.** The page reads `isEnabled(FEATURE_FLAGS.PLAY_DOWN)` and hands core a boolean, `allowPlayDown`
(core stays pure; `PLAY_DOWN_FLAG = 'play_down'` is exported beside the rule, with a test holding it equal to the
registry key, as `SPREAD_COACHING_LEADS_FLAG` is).

| Registered younger than the age           | Setting off (the default; **today's behaviour, byte for byte**)                            | Setting on                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| A division of the player's own age exists | Plays in their own age division; listed; counted as **moved**                              | Plays in the division they registered for; listed `play-down`; counted as **playing down** |
| No division holds their age               | Not placed, listed, as today (the one remaining hold-out; the owner decided it 2026-10-27) | Plays in the division they registered for, flagged                                         |

Play-up is unchanged and stays by request. The asymmetry is deliberate and stated on screen: play-up needs a
request; with the setting on, the registration itself is the play-down request, because no play-down column
exists (decision 2 offers option 3 as the stricter alternative).

**"What happens to an existing play-down request when it is off?"** There is none: nothing in the import or the
record expresses one. The signal is the registration in a younger division. Off: flagged and moved to the own age
division (recommended; unchanged from today). Rejected: _flagged and left unplaced_ (a refusal, against flags
over refusals, and it adds to "not eligible"); _treated as not eligible_ (lesson 87's not-eligible means no
division holds the age, which is false here); _kept in its registered division with a flag_ (that is what **on**
does).

**The enable path.** An admin turns on "Play-down" in Settings > Features (and the "Choose your tools" step, which
lists the same catalog). The next overview, generation and Play-up section use it. It is admin-only server-side
(`update_org_feature_flags` is `is_org_admin`) and audited.

**Effects.** _Generation_: unchanged when off (golden `teamGenerationEligibility.golden.json`); when on, a
play-down is seated in the registered division. _Advice_: by the division played (section 4), with the setting
read by the same helper. _Import_: nothing; no play-down column is added. _Mock_: the mock stores org flags
(`mockSupabaseClient.js:4872-4889`) and placement runs in browser core, so no mock change. _Demo league_: its
organization has no key, so off; and it holds 0 play-downs by registration (executed, finding 5), so nothing
changes there. Showing a flagged play-down in the demo would need a seed migration; not recommended (decision 8).
_Edge/database_: none; the server does not judge ages.

## 4. Design for the flags and counts (question D)

### 4.1 One definition, one function, two inputs

A count is a function of **seats**, not of how a seat was decided:
`summarizeSeats({ seats, divisions })` in a new `packages/core/src/playUpSeats.js`, where a seat is
`{ playerId, naturalAge, registeredDivision, seatedDivision | null, requested, waitlisted }` and a division carries
its band and its program (`programOf`). It classifies with `classifyPlacement(naturalAge, band(seatedDivision))`,
the primitive `applyPlayUpEligibility` already uses, so the forecast and the result share the definition of
in-band, up and down. Seats come from two sources:

- **Before generation:** the placement output, one row per registrant (`seatedDivision` is `player.division`, null
  for `no_division`). The page runs it once, in one helper (4.3).
- **After generation and on a roster edit:** the saved rosters (`seatedDivision` is the team's `division_id`), so a
  manual move and a preserved seat are counted as they are, and the count survives a reload without the import.

**Parity is the guarantee.** A test generates teams for a league that has every kind, then counts the saved
rosters, and requires the result to equal the count from the placement, per division and per program. That is
"advice and generation cannot disagree", shown and not stated.

### 4.2 What is counted (each count says what it is a count of)

| Count                       | Means                                                                                             | Of which players                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `playingUp`                 | seated in a division whose band is above their age                                                | seated there; the waitlisted included (decision 4)                              |
| `playingDown`               | seated in a division whose band is below their age                                                | seated there; 0 unless the setting is on or a roster edit put them there        |
| `askedToPlayUp`             | a request with nothing to honour: registered in their own division, or age unknown                | registered there (decision 5)                                                   |
| `movedIn` / `movedOut`      | seated in a division other than the one registered (the age rule, or a roster edit)               | seated there / registered there                                                 |
| `notChecked`                | age unknown, or the seated division has no age band (unknown is never read as in band, lesson 47) | seated there                                                                    |
| `seated`                    | what generation can seat: **equals the advice's player count**                                    | seated there, neither waitlisted nor not eligible                               |
| `waitlisted`, `notEligible` | as F1 and the data follow-ups; `seated + waitlisted + notEligible` is every registrant            | partition, a row both waitlisted and not eligible counted once, as not eligible |

At program level the counts are the sum over the program's divisions, each player once; `movedIn`/`movedOut` count
only moves **across** programs there (a move inside a program nets to zero). The flags are overlays on the
partition; the partition itself is the subject set, enumerated from the rows, never from the placement (AGENTS.md
§3).

### 4.3 The advice by the division played

One page helper, `placeImportRows(...)`, builds the generator player for every row exactly as generation does
(record over file, `toGeneratorPlayer`, `withDurableIdentity`), runs `applyPlayUpEligibility` once with the same
descriptors, season rule and `allowPlayDown`, and returns the placed players. It replaces the three call sites
(`:634`, `:1122`, `:1780`), so the advice, the destination rows and generation's `playsHere` cannot drift (a census
test fails a fourth call). `derivePrograms` then counts a row in the division it plays in, and `destinationPrograms`
dissolves into it: every division with a seated player is a row, and the existing `incoming` flag is kept for a
division the file has no registrant in. **This is a refactor the owner folded in**, flagged under rule 2: the
status quo costs a wrong recommended count (finding 4: 9 teams advised, 8 seated); the risk is that the overview's
numbers change for any league with a moved player (not for one without: the existing advice tests and the season
and demo fixtures stay identical, section 5). Until the divisions have been read (`divisionsRead`), the advice is
what it was (lesson on `divisionsRead`, data follow-ups).

The registered-versus-seated discrepancy therefore ends: a division's Players cell is `seated`, with muted notes
"N moved here from other divisions" and "N registered here, placed in their own age division", so the arithmetic
from the file's count to the advice is on screen.

### 4.4 Wording (plain; "flagged"; no refusal language)

- Division Overview, new column **Play-up and play-down**: `2 playing up`, `1 playing down`, `None`, or
  `3 not checked (no age, or no age band)`.
- Under Players, muted as the waitlist note is, three lines that appear only when they are not zero:
  - `2 moved here from other divisions`
  - `3 registered here, placed in their own age division`
  - `4 asked to play up, registered in their own division`
- A sentence under the table heading. Setting off: "Play-down is off: a player registered in a younger division
  is placed in their own age division and shown as moved. Play-up is by request. Nothing here is approved or
  refused." with a link "Turn on play-down in Settings > Features". On: "Play-down is on: a player registered in a
  younger division plays there, and is flagged."
- A league line above the table: "League: 5 playing up, 0 playing down." Program heading rows: "Junior: 3 playing up,
  0 playing down" (and "2 moved in from other programs" when there are).
- Play-up section sentence: "3 playing up (3 requested), 0 playing down, 3 moved to their own age division, 4 asked
  to play up from their own division." The rows keep their existing words.
- Roster list (4.7): "Playing up: Pia (natural age 10) is on U12 Boys Team 2, a division for ages 11 to 12. A
  play-up was requested." / "No play-up request is on file." / "Playing down: Jake (natural age 12) is on U10 Boys
  Team 1, a division for ages 9 to 10."

### 4.5 Accessibility (WCAG 2.2 AA, tokens, both themes)

Counts are text in a real table column (`th scope="col"`), never colour alone; `Badge` tones come from the existing
tokens and nothing is hard-coded (AGENTS.md §6). The program heading row stays a `th scope="rowgroup"` with the
counts inside its text, `colSpan` raised by one, so a screen reader reads "Junior, 3 playing up, 0 playing down".
"Not checked" and "None" are words, not blanks (an unknown is not a pass). The only new interactive element is the
"Turn on play-down" link (a real link, target size over 24 px, in the normal focus order); nothing is draggable. The
page's polite live region announces the Play-up section once per generation, as now, with the new sentence. The
proof is axe in both themes **with the flags on screen** (lesson 84.3, lesson 90) in the E2E, plus jsdom axe.

### 4.6 Read-only, and the coaches

Every flag and count is display-only: no control approves, dismisses or refuses anything, and nothing is written
when it is shown; a completed season changes nothing about it. The Teams page is admin-only
(`VIEW_ALL_TEAMS`, `App.jsx:194`) and the setting is admin-only. No coach surface exists (finding 3), and no
export, feed or calendar reads play-up or age data (search below), so nothing reaches a coach; a test pins the list
of consumers of the new count so a later surface must be added deliberately.

### 4.7 The roster editor (the one default play-down path)

The age check moves out of the red conflict banner (flags are not errors; decision 6) into its own list, computed
from the seats on the roster by `summarizeSeats`, using what production has: the team's `division_id`, the
division's band from the rows the page already reads (`divisionRows`), and each player's stored natural age and
request. The roster directory reads the stored player already, but only `id, first_name, last_name, rating,
skill_tier` (`useRosterDirectory.js:59`); its column list gains `natural_age` and `play_up_requested` (lesson 60: a
column list is a second copy of the schema, so the test double must honour it). The list is shown with the editor,
the only place a manual move can happen. It stops depending on `teams.min_age`, on `playUpRequested` being passed,
and on the invented age 10. The E2E step stops forging `min_age`/`max_age`. A
manual cross-division move is thereby flagged as playing up or down, at once and after a reload.

## 5. Tasks, pull requests, plants, stop conditions, risks, rollback (question E)

Sizes are estimates, not measurements: S under 150 lines, M 150 to 500, L over 500, tests included. Three pull
requests, in this order; PR 2 and PR 3 are independent of each other and may be in flight together once PR 1
merges (the repository allows two). At the time of writing two Dependabot pull requests (#692, #693) are open
(REST list, 2026-11-03), so PR 1 opens when one has merged or the owner allows it. No migration in any of them.

**PR 1: one placement, one count, the advice by the division played** (core and Teams page; no setting, no UI beyond
the Players cell)

- [x] A1 (M) `packages/core/src/playUpSeats.js` (`summarizeSeats`), replacing the unread `diagnostics.counts`
      (flagged refactor: 8 assertions in `tests/playUp.test.js` and `tests/teamingPipeline.test.js` move to the new
      function). Test: `tests/playUpSeats.test.js` (new), expected counts worked from the rule by hand for a small
      league (U10 ages 9 to 10 and U12 ages 11 to 12 in two programs; three requested play-ups, two unrequested, one
      registered-younger, one waitlisted, one no-division, one unknown age, one division with no band): the partition
      sums to the rows; program counts equal the sum of their divisions; an unknown age and a bandless division are
      `notChecked` and never `playingUp`; a move inside a program nets to zero at program level.
- [x] A2 (L) `placeImportRows` and the advice by seat (`derivePrograms`, `destinationPrograms`, `playsHere`,
      `notEligibleRowIndexes`). Tests: `tests/teamingConfigurationAdvice.test.jsx` gains the moved-player cases (the
      finding 4 league worked by hand: advised teams equal the teams **Generate** makes, for both divisions); a census
      test fails when `applyPlayUpEligibility` is called anywhere in `frontend/src` but the helper; the existing
      advice cases (24 of 30, waitlist, refused reads) pass unchanged.
- [x] A3 (S) The Players cell notes and the matching sentence in `TeamingConfiguration`. Test: a new
      `tests/programOverviewPlayUp.test.jsx`: the notes appear only when there are moved players and the cell reads
      byte for byte as before when there are none.

**What PR 1 did differently from the tasks above** (built 2026-11-03; where the plan and the code disagreed,
the code won and the difference is here, so PR 2 and PR 3 start from what is true):

- **The parity test moved from PR 2 (B5) into PR 1, at core level.** `tests/playUpSeatsParity.test.js` runs a
  21-registrant league with every kind of player through the real pipeline and generator, division by division,
  and requires the count from the placement (`applyPlayUpEligibility`, what the advice is built on) to equal the
  count from the rosters generation saved, per division and per program, and the held-back players to be the
  waitlisted and not-eligible the placement counts. It has a negative control (a player moved by hand to
  another division changes the roster count where it should). B5 keeps only what the page can add: reading
  saved rosters after a reload (with B3).
- **The one known disagreement is pinned, not hidden.** A waitlisted buddy of a coach's child is taken off the
  waitlist by the pipeline after the placement (`applyWaitlistException`), so generation seats them and the
  advice counts them as waitlisted until the page's save makes them active (the data follow-ups' "Not covered").
  The first draft of the parity test built the placement side from the pipeline's output, which already
  includes the exception, and so could not have shown it; review found the overstatement. Closing the gap is
  not in this plan; the test flips when someone does.
- **`summarizeSeats`' shape.** Divisions carry their program as `program_id` or `programId`; the result is
  `{ byDivision, byProgram, league }` (Maps, every listed division an entry; `byProgram` in order of first
  appearance with the no-program group last under `null`; `league` the plain sum, so its moves are every
  player who plays elsewhere than they registered). A listed id is matched exactly before folding case, so two
  divisions that differ only in case stay two. `seatsFromPlacedPlayers` (added) makes one seat per player from
  the placement, so a held-back player cannot vanish from a count. A request by a player the age rule moved is
  a move, not an `askedToPlayUp`. `playingUp`, `playingDown`, `askedToPlayUp` and `notChecked` are computed and
  tested in PR 1 but have no reader on screen until PR 2 (the page reads `seated`, `waitlisted`, `notEligible`,
  `movedIn`, `movedOut`); `playingDown` is zero from the placement by construction.
- **The page: one helper, more removed than named.** `placeImportRows` is the page's only call of
  `applyPlayUpEligibility` (census test). Generation's "who plays here" now places the other programs' rows
  through it (the old call also placed the selected program's own players, whose result nothing read). Gone
  with it: `waitlistedRowIndexes`, `notEligibleRowIndexes`, `destinationPrograms`, `fileProgramsBase` and the two
  empty-set constants; the waitlist is read from the generator player's status (the same `isWaitlistedRow`
  predicate). The destination rows now apply the stored player over the file's row, as generation does (they
  used the file's row alone).
- **Waitlisted players who move are counted on the waitlist of the division they would play in**, and a division
  the file has no registrants in gets a row when only waitlisted players would play there (it reads "All on the
  waitlist"), so the file's count reconciles on screen. (The plan's rule was "a division with a seated player".)
- **A division whose registrants all moved on says "All placed in other divisions".** `assessTeamCount` returns
  no warnings for zero players, so without a status of its own such a division read "Fits the limits"; any mix
  with the waitlisted or not eligible reads "Nobody to seat".
- **The settings sentence words the move-out note differently from the cell.** The cell keeps the plan's
  words ("N registered here, placed in their own age division"); the sentence says "N registered here are placed
  in their own age division and not counted", because beside "for 24 players" the cell's words read as if they
  were among the 24.
- **`totalPlayers` on a program row is kept and its meaning written down** (the players who play here, seated or
  waitlisted, and the registrants no division holds); nothing reads it. It was "everyone registered" before.
- **Two existing tests pinned the old counting and moved on purpose:** `tests/teamingConfigurationAdvice.test.jsx`
  "does not call a player not eligible who another division can hold" (U10 advised 3 teams for 30; it is 2 for 24
  with U12 gaining the six) and `tests/teamAnalysisDivisionWindow.test.jsx` (U3 `9` is `8`, with "1 moved here"
  on U4). No test of a league without a moved player changed.
- **The consumer census** also pins the importers of `playUpSeats.js` to the Teams page (the plan listed it
  under "What stays unchanged"); PR 2 adds its consumers there on purpose.
- **Not done in PR 1, left for the docs pass of PR 3 (C4):** the stale words in `teamGeneration.js:55`,
  `constants.js:28` and the fixture string in `tests/placementReview.test.jsx:63`, and the notes in
  `gotsport-import-contract.md` and `2026-10-27-play-up-by-request.md` (they describe the setting and the
  flags, which PR 1 does not add). `docs/changes/2026-11-02-data-followups.md` "Not covered", first bullet, is
  marked resolved here.

**PR 1, executed (2026-11-03, throwaway script outside the repository over the core functions):** on the season
fixture (1,153 registrations, bands read off the data) and the demo league (1,259), counting by seat gives the
same player count and the same recommended team count in every division as counting by registration (0 of 21
and 0 of 17 divisions differ; 0 moved, 29 and 33 requests registered in their own division). With ten of the
season fixture's players re-registered (six age-12 players into U10B, four age-10 players into U12B, one
requesting) the registered counts are U10B 81 and U12B 91, the seated counts are 77 and 95, and the advised
teams at a maximum roster of 10 are 9 against 8 for U10B and 10 against 10 for U12B. (The plan's 78 and 94 came
from a different choice of ten players; 9 against 8 is the same.)

**PR 2: flags and counts in the views** (after PR 1)

- [ ] B1 (M) `ProgramOverview` column, caption, league line and program heading counts. Test:
      `tests/programOverviewPlayUp.test.jsx`: a league with two programs and a division in none; counts equal the
      hand-worked numbers; a flat league shows the league line and no heading; "None" and "not checked" read as
      words; axe clean.
- [ ] B2 (S) The Play-up section sentence and announcement from `summarizeSeats`. Test:
      `tests/teamAnalysisPlayUp.test.jsx` (the pinned sentence at `:250` changes, deliberately, in this commit) and
      `tests/playUpReview.test.js`.
- [ ] B3 (M) The roster list (4.7) and a repaired `useConflicts`. Tests: `tests/rosterAgeFlags.test.jsx` (new): a
      persisted-shape team row with **no** age keys and a cross-division move is flagged; a requested move says so;
      the directory's column list holds the two new columns (the double refuses a select without them);
      `tests/e2e/steps/team_and_roster.ts` no longer forges the band.
- [ ] B4 (M) One mock E2E scenario in `tests/e2e/features/play_up_by_request.feature`: the overview shows the counts
      by division and by program, then after Generate the Play-up section and the roster list agree with them; axe in
      both themes with the flags on screen. Run after `bddgen`.
- [ ] B5 (S) The parity test (4.1): generate, count the rosters, equal to the placement count, per division and
      program. Test: `tests/playUpSeatsParity.test.jsx`.

**PR 3: the setting** (after PR 1; only if decision 2 says build it)

- [x] C1 (S) Core `allowPlayDown` on `applyPlayUpEligibility` and `prepareTeamingInput`, default false. Test:
      `tests/playUp.test.js`: off equals today for every case; on seats a play-down in the registered division,
      listed and counted `playingDown`, including the no-own-division case; the golden
      `teamGenerationEligibility.golden.json` unchanged.
- [x] C2 (S) `FEATURE_FLAGS.PLAY_DOWN`, its catalog entry (off), `PLAY_DOWN_FLAG` in core, the page reads it, the three
      placement call sites already share the helper. Tests: `tests/FeatureFlagSettings.test.jsx`; a new
      `tests/playDownSetting.test.jsx` from a **stored** value through `FeatureFlagSchema` and the real page, both
      states; the key held equal to core's (lesson 75: a gate on every place that shows it and every place that
      uses it, each shown red with the gate removed).
- [x] C3 (M) Flip safety (decision 3): a player already on a preserved roster keeps their seat when a setting
      change (or a cleared request) would move them, and is flagged. Test: a reviewed roster with a seated
      play-down, setting turned off, re-run: still on the roster, `droppedPlayersRemoved` is 0, flagged; first
      written against today's code to show what it does now.
- [x] C4 (S) Docs and the lesson (below).

**What PR 3 did differently from the tasks above** (built 2026-11-03; the code won where it and the plan
disagreed):

- **Three placements, not "the three call sites already share the helper".** After PR 1 the page asks the
  placement from `placeImportRows` twice (the advice, and generation's "who plays here") and generation
  asks it again inside `prepareTeamingInput`. The page reads the setting once (`playDownEnabled`) and hands
  `allowPlayDown` to all three; a census (`tests/playUpPlacementCensus.test.js`) reads the argument text of
  every such call and fails one that leaves the setting, or the saved rosters, out. It also pins the readers
  of the registry key (the catalog and the page) and that core is handed a boolean.
- **C3 is in the placement, not the generator.** Only the placement knows a player was moved by a rule and
  did not leave, so it takes `heldSeats` (player id to the division of a saved roster; the page builds it
  with `heldSeatsFromSnapshot` from every division's own latest payload) and keeps the player on that
  division when it is a seat the rule itself can give them: the division registered for, or their own age
  division. Any other roster is left to the re-run, so a registration that changed or a move by hand still
  moves a player (the hold would otherwise pin them for good). A request set after a roster was built holds
  the same way as one cleared. `generateTeams` is unchanged: the held player is an ordinary incoming player of
  the roster's division. **Written first against the code before the change**: a cleared request removed the
  player from her U12 team, `droppedPlayersRemoved` 1, `heldSeats` not yet a parameter; the same test with the
  hold takes it to 0 (`tests/playDownFlipSafety.test.js`, 12 tests; the page-level twin is in
  `tests/playDownSetting.test.jsx`).
- **"Flagged" is a listing entry.** A held player is listed with `heldSeat: true`, `ruleDivision` and
  `ruleDivisionName`, keys present only on a held entry, so every other listing is byte for byte what it was.
  The Play-up section row says: "Stays on the roster they are on in U10: a team that exists is not reshuffled.
  A new roster would place them in U12." A play-down the setting honours reads "Plays in U10, the younger
  division they registered for." (the only other row sentence that changed).
- **With the setting on, the gap is not capped.** The plan's table says the registration is the request, so a
  16-year-old registered in U10 plays there, flagged; the one remaining hold-out with the setting on is a
  play-up nobody asked for into a division no one holds (age 7 into U10 with no U7). For the owner: say so if
  a cap is wanted (it would be a second rule).
- **Executed (throwaway script outside the repository, 2026-11-03).** Setting off equals `origin/main` byte
  for byte: the placement's `sha256` is the same from `origin/main` and from this branch, with the setting
  absent and with it `false`, over the season fixture's 1,108 registrations that carry a division, the same
  with ten re-registered, and the demo league's 1,259. Off versus on differs for 0 of the season fixture and 0
  of the demo (nobody is registered below their age: nothing to honour). With six age-12 players
  re-registered in U10B and four age-10 players in U12B (one asking): U10B seats 78 off and 84 on (6 playing
  down), U12B 94 off and 88 on. The season fixture suite, the natural-age fixture and
  `teamGenerationEligibility.golden.json` pass unchanged (29 files, 426 tests, before the full run).
- **The wording of what the page says about the rule is PR 3's, from one module.** The Play-up section's
  sentence ("players play in their own age division unless a play-up was requested") named the rule as if the
  setting did not exist; it now reads it from `frontend/src/utils/playDownNote.js` (on: "... or, with Play-down
  on, they registered in a younger division"), the page handing the section the same boolean as the placement
  (the census checks the element). PR 2 ships the Division Overview's note as static text ("Play-down is not
  available: ..."), which is not on `main` yet: once it is, the note is read from the same module (on: "Play-down
  is on: a player registered in a younger division plays there, and is flagged."), applied in a later push and
  drafted and tested on PR 2's head. There is no "Turn on play-down" link: the Features tab is local state with
  no address, and the tab needs a permission a Teams admin may not hold, so a link would land on a page that may
  not show it. The card says where the switch is.
- **No E2E scenario**, as the plan lists none; the setting is shown from a stored value through the schema
  and the real page in jsdom, both states, in the advice and in generation.
- **Left alone, report only:** a player moved by hand to a roster that is neither the division registered nor
  their own age division is still dropped from it by a re-run of that division, as before; Team Builder; the
  advice reads the saved rosters only once they have loaded, so it can change once as they arrive.

**Plants** (three per pull request; each must turn the named test red, then is reverted). PR 1: the advice counts by
registered division (A2's parity case); `summarizeSeats` classifies from the registration, not the seat (A1); the
subject set is taken from the seated players, so a waitlisted or no-division row vanishes (A1's partition). PR 2:
the roster check reads `teamRow.min_age` again (B3); the program heading counts only its first division (B1); the
section sentence reads registered kinds (B2). PR 3: the gate removed so on is always on (C1/C2); an absent key read
as on (C2); a flip that evicts a rostered player (C3).
_Run for PR 3_ (each reverted, the files equal by `sha256`): `isEnabled(...) || true` on the page turned 9 tests of
`tests/playDownSetting.test.jsx` red (the off states of the advice and of generation, and both flips); a
`FEATURE_DEFAULTS` entry of `true` turned 10 red across `tests/playDownSetting.test.jsx` and
`tests/FeatureFlagSettings.test.jsx`; a hold that never applies turned 5 of `tests/playDownFlipSafety.test.js`
and 2 of `tests/playDownSetting.test.jsx` red.

**Stop conditions** (checked against this plan). Stop and report if: a migration, RPC, CHECK or table change turns
out to be needed (none planned: the diff must show no file under `supabase/migrations`); the season fixture suite
or any generation golden moves; output differs for a league with no moved, play-up or play-down players
(the advice cases and the demo and season fixtures must be identical); the setting off changes any placement;
three materially different approaches fail (AGENTS.md rule 8).

**Risks** (watch / if it happens).

- **Overview numbers change for leagues with moved players, by design.** Watch: the PR description lists which
  divisions of the fixtures would differ (none today: executed, 0 moved in the season fixture and the demo). If it
  happens in production data: that is the defect fixed, and the Players cell notes explain the arithmetic.
- **A flip drops rostered players** (finding 8). Watch: C3's first run against today's code. If it happens and
  decision 3 is "re-run moves them": say so on the setting's card.
- **The counts are only as right as the age and the registered division** (finding 7 shows a file path that flags
  everyone). Watch: the first real import after the change; a division where most players are flagged. If it
  happens: it is that derivation's defect; fix it in its own plan.
- **The roster list surfaces flags on rosters that never showed any** (the old check never worked). Watch: the
  count on the demo's teams. If noisy: they are warnings; show per division, collapsed.
- **Performance.** One placement pass took 6 ms for 1,259 players, 17 ms for 5,000 and 42 ms for 20,000
  (_executed_, node 22, no coverage), and the helper replaces three passes with one. Lesson 59: time the page
  tests with `--coverage` on the base and the branch before merging.
- **A fourth derivation appears.** `useTeamAnalysis.js` (a hook that groups programs by age) has no importer but its
  test (search below). Watch: the census test. If someone wires it: it must call `summarizeSeats`.
- **Unknown read as fine.** Test both directions (lesson 47): an unknown age or a bandless division is `notChecked`,
  never `None`.

**Rollback.** Each pull request reverts alone: code and tests only, no migration, no data. A `play_down` key left in
`organizations.feature_flags` after reverting PR 3 is dropped as unknown by `FeatureFlagSchema` (a dev warning) and
the registry keeps the key until no stored organization carries it (the guardians skill, "Retiring").

**What stays unchanged, each with a test.**

| Unchanged                                                                       | Test                                                                                           |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Placement with the setting off, byte for byte                                   | `teamGenerationEligibility.golden.json` and `tests/playUp.test.js` (play-down in own division) |
| A requested play-up plays older; an unrequested one plays in their own division | `tests/playUp.test.js`, `tests/teamAnalysisPlayUp.test.jsx`                                    |
| `no_division` is not placed and listed                                          | `tests/teamGenerationEligibility.test.js`                                                      |
| The waitlist and not-eligible counts and their partition                        | `tests/teamingConfigurationAdvice.test.jsx`                                                    |
| Advice for a league with no moved players                                       | the existing advice cases (24 of 30 and the rest), unchanged                                   |
| The season fixture and the generation goldens                                   | `season2026Fixture`, `naturalAgeSeasonFixture`, the golden files, run in PR 1                  |
| A league with no program shows no program heading                               | `tests/programOverviewPlayUp.test.jsx`                                                         |
| Nothing reaches a coach, a feed or an export                                    | a consumer census for `summarizeSeats` and `PLAY_DOWN_FLAG`, as `unwiredLayerImporters` does   |
| No schema change                                                                | PR check: `git diff --name-only origin/main` lists no path under `supabase/migrations`         |

**Docs to update.** `docs/architecture/team-generation.md` (the advice paragraph ends "still counts a player in the
program they registered in"); `docs/architecture/gotsport-import-contract.md` ("Play-up / play-down": the setting,
the counts, that requests arrive in the own division); `docs/changes/2026-10-27-play-up-by-request.md` (a dated
note under decision 2: play-down is "placed in their own division" unless the setting is on) and
`docs/changes/2026-11-02-data-followups.md` ("Not covered", first bullet: resolved); the stale words naming
`play_up_blocked` and `play_down_blocked` in `teamGeneration.js:55` and `constants.js:28`, and the fixture string
`'play-down is not permitted'` in `tests/placementReview.test.jsx:63`; `docs/LESSONS_LEARNED.md` (below); and, with
PR 3, `.agents/skills/squadlogic-feature-guardians/SKILL.md` and its `.claude/skills/` copy ("Settings the domain
reads today": add `play_down`).

## 6. Against the rules (checked)

- **AGENTS.md rule 14:** applies (placement is the domain model); this plan is the stop. Persistence is the
  existing JSONB column through the audited RPC; no table, column or migration.
- **Rule 2, minimal diffs:** one refactor beyond the narrow request is flagged and costed in 4.3 (the single page
  helper) and one in A1 (removing `diagnostics.counts`, "honour it or delete it"). Both are the owner's folded-in
  follow-up; neither starts before approval.
- **Privacy (§2):** nothing new about a person is stored (option 3, which would, is deferred); the counts are
  derived from fields already stored. **Authorization:** the setting write is `is_org_admin` server-side; the Teams
  page is admin-only; placement is a computation, not an access decision.
- **Scope (§2):** no hard exclusion is touched.
- **Verification conventions (§3):** subject sets come from the rows and the rosters; every count says what it is a
  count of (the idea of `counts.js`, applied by naming the population); every check has a plant; no field is left
  produced and unread.
- **No ADR folder exists**, so the decision is recorded here and, once settled, in `docs/LESSONS_LEARNED.md`.

## 7. Owner decisions (question F)

**Owner's decision, 2026-11-03 (verbatim): "As recommended on all of them, start PR 1".** That is decisions 1 to
10, each as recommended: the advice and every flag count by the division played, with the two refactors flagged
under rule 2 approved (one page helper in place of the three placement call sites, and deleting the unread
`diagnostics.counts`); the `play_down` organization setting, off by default (PR 3); a rostered player keeps their
seat when a setting flips (task C3); the waitlisted are counted in the flags; "asked to play up, registered in their
own division" is its own line; roster age flags get their own list; the program view is the Teams overview's program
headings plus a league line; the demo is unchanged; there is no coach-facing surface; and decision 10 stays
**report only** (nothing in it is built). The approval starts PR 1 only: PR 2 and PR 3 are separate pull requests,
started after it merges. The text below is the plan as it was put to the owner; the decisions are kept as asked.

Only decision 1 blocked the start of the build; 2 and 3 block later tasks only; the rest have a default that applies
if the owner is silent.

1. **BLOCKS PR 1 and PR 2. Count by the division played.** Recommended: the advice and every flag count a player in
   the division they will play in, with "moved" notes reconciling the file's count. This also asks the owner's call
   on the two refactors flagged under rule 2: one page helper in place of three placement call sites (4.3), and
   deleting the unread `diagnostics.counts` (A1; cost of the status quo: a third, unread derivation; risk: 8 test
   assertions move). Alternative: keep counting by
   registered division: the recommended team count stays wrong for any league with a moved player (9 advised, 8
   seated in the executed case) and the page keeps three bases that disagree.
2. **Blocks PR 3 only. The enable path for play-down.** Recommended: an organization setting, off by default; on
   means the registration in a younger division is honoured and flagged. Alternatives: (b) no setting now: play-down
   is simply never honoured, PR 3 is not built (cheapest; the day an organization wants it, it is a new plan);
   (c) a per-player play-down request on top (a migration, an import column, a patch and audit, and one more flag
   about a minor; the stricter match to "by request").
3. **Blocks task C3 only. What flipping the setting does to rosters already built.** Recommended: a rostered player
   keeps their seat and is flagged (the precedent of 2026-10-22, decision 3: a rostered player stays). Alternative:
   a re-run moves them, which today removes them from the roster they are on (finding 8).
4. **Count the waitlisted in the flags.** Recommended: yes, so every request is visible (owner, 2026-10-27:
   admins are aware of all players requesting); `seated` excludes them. Alternative: flags cover seated players
   only, and a waitlisted requester is invisible here.
5. **Show "asked to play up, registered in their own division" as its own line.** Recommended: yes, separate from
   "playing up". Alternative: fold it in, and the demo reads 33 play-ups where nobody plays up.
6. **Roster age flags get their own list, out of the red conflict banner.** Recommended: yes (flags, not errors).
   Alternative: keep them in the banner, repaired.
7. **Program view = the Teams overview's program headings plus a league line.** Recommended. Alternative: also
   Settings > Season > Programs, which would read stored players and run its own derivation (M).
8. **Demo.** Recommended: unchanged. Alternative: a seed migration that registers one demo player younger, so the
   demo shows a flagged play-down (a migration for a picture).
9. **Confirm there is no coach-facing surface.** The relayed principle "coaches view permits read-only" describes a
   view removed on 2026-10-27; this plan adds nothing a coach can see. If a read-only coach artifact is wanted, it
   is a different change.
10. **Report only, not planned here.** The age-group-only import path (finding 7); `no_division` as the one
    hold-out where flags-over-refusals would say flag and place; Team Builder keys its board by the registered
    division, so a moved player reads as unplaced there and Auto-balance would put them back (statically reviewed,
    `TeamBuilderPage.jsx:87-97` with `20260611000100:196-224`); the orphan hook `useTeamAnalysis.js`.

## 8. Receipts: searches, runs, and what was not run

| Claim                                                                   | Command (run 2026-11-03 in the worktree at `2ae6333`)                                                                                                                      | Result and control                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing seats a play-down below the age                                 | `rg -n "PLAY_DOWN\|play_down" packages frontend/src supabase/functions --glob '!**/*.test.*'`                                                                              | 5 hits: the definition, the classification, a count, a review set, a stale comment; none seats. Control: matches `playUp.js:35`                                                                                                                                                                                             |
| `diagnostics.counts` has no production reader                           | `rg -n "diagnostics\.counts\|playUp\.counts\|\.counts\.(playUp\|playDown\|inBand\|noDivision)" packages frontend/src supabase/functions`                                   | only the producer, `playUp.js:372-377`. Control: `rg -c ... tests` matches `playUp.test.js` (6) and `teamingPipeline.test.js` (2)                                                                                                                                                                                           |
| Three page call sites of the placement                                  | `rg -n "applyPlayUpEligibility\(" frontend/src packages/core/src`                                                                                                          | `TeamAnalysisPage.jsx` 634, 1122, 1780; `teamingPipeline.js:191`; the definition                                                                                                                                                                                                                                            |
| Team rows carry no age band                                             | `rg -n "min_age\|max_age" supabase/migrations \| rg -i teams`; read `teamReviewPersistence.js:162-183`                                                                     | none for `teams`. Control: `rg -l min_age supabase/migrations` lists the divisions' migrations. The E2E step forges it (`:239-243`)                                                                                                                                                                                         |
| No coach role or view                                                   | `rg -n "COACH" frontend/src/constants/permissions.js`; `rg -n "get_my_division_teams" supabase/migrations/20261104010000_admin_only.sql`                                   | no `COACH` (control: `ADMIN` matches 10 times); the migration drops both coach-view reads (`:819-820`)                                                                                                                                                                                                                      |
| Only two screens know programs                                          | `rg -n "groupByProgram\|usePrograms" frontend/src -l`                                                                                                                      | 4 files (listed in section 2). Control: it matches the page and the section                                                                                                                                                                                                                                                 |
| `useTeamAnalysis` has no production importer                            | `rg -n "useTeamAnalysis" frontend/src`                                                                                                                                     | only its own definition. Control: `rg -n useTeamAnalysis tests` matches `tests/useTeamAnalysis.test.js`                                                                                                                                                                                                                     |
| No export, feed or Edge function reads play-up or age beyond the import | `rg -n -i "natural_age\|play_up" supabase/functions -l`; `rg -n -i "natural_age\|naturalAge\|play_up\|playUp" frontend/src -l` (excluding the page, the list and the mock) | Edge: `natural-age.ts`, `import-allowlist.ts`, `import-validation`. Frontend: `PlayerRecordPage`, `placementReview`, `PlacementReviewList`, `useConflicts`, `importAllowlist`, `telemetryUtils`. No export code                                                                                                             |
| The setting needs no migration                                          | read `20260403000000_settings_audit_rpc.sql:28-73`; `rg -n -i "function (public\.)?update_org_feature_flags" supabase/migrations`                                          | the RPC stores any JSONB and audits old and new; it has no key list. A case-insensitive search of `feature_flags` with `check\|constraint\|trigger` finds three lines (two reads of a boolean key, a comment on the audit-action constraint) and no CHECK on the column. Control: the first search matches both definitions |
| Baseline of the pinning tests                                           | `npx vitest run` on the 9 files in section 1                                                                                                                               | _executed_: 9 files, 181 tests, all pass                                                                                                                                                                                                                                                                                    |
| Season fixture and demo: no play-up or play-down by registration        | throwaway scripts over `loadSeason2026Practice` and `fixtures/demo-2026/players.csv` (bands read off the data)                                                             | season fixture: 1,153 in band, 0 up, 0 down, 29 requests in own division; demo: 1,259 in band, 33 requests in own division                                                                                                                                                                                                  |
| The moved-player discrepancy                                            | the same script with 10 players re-registered, then `resolveTeamCount` at maximum roster 10                                                                                | registered 81 and 91, seated 78 and 94; teams 9 against 8 (U10B) and 10 against 10 (U12B)                                                                                                                                                                                                                                   |
| The age-group-only division                                             | a constructed row through `applyPlayUpEligibility`                                                                                                                         | natural age 7 in U8: `play_up`, played U7; with no U7 in the season: `no_division`                                                                                                                                                                                                                                          |
| One placement pass is cheap                                             | the same function over generated players                                                                                                                                   | 6 ms (1,259), 17 ms (5,000), 42 ms (20,000); no coverage                                                                                                                                                                                                                                                                    |

**Not run:** the full suite, the coverage run, the mock E2E, the production database (the "0 players in production"
figure is from `docs/changes/2026-11-02-data-followups.md` and was not re-read), and any page-level reproduction of
finding 4 (it is shown from the core function and the page's registered counting, which was read; task A2 makes it
a failing page test first).

## 9. What the planning taught (for `docs/LESSONS_LEARNED.md`, written in PR 1)

- A requirement phrased as "not available by default" may already be true; read every path before designing a
  switch. Here generation was already off, and the path that was on (a manual move) had a check that could not fire.
- A principle quoted from memory can describe a surface the owner removed the week before; check the plan that
  removed it before designing for it.
- A count is a number **of** a population: registered, seated, and requested are three populations, and a page
  that shows two of them under one word disagrees with its own generator.
- The first signal in a real export is the request, not the registration: a division view built on seats alone reads
  zero for a league where families asked.

## Output of the planning (prompts/plan-change.md)

1. Size verdict: planned (section above).
2. Departures from AGENTS.md or the ADRs: none; no ADR is drafted (the repository has no ADR folder). Open
   questions: one blocks the build (decision 1); decisions 2 and 3 block later tasks only.
3. The first task: A1, with `tests/playUpSeats.test.js` (written first, red against a stub, then the function).
4. What the planning taught: section 9.
