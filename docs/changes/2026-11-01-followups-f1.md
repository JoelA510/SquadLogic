# Follow-ups F1: season and roster correctness

Status: **owner approved the five follow-ups and bundling them (2026-11-01)**. AGENTS.md rule 14
applies to the two that touch team generation and what the Teams page counts, so this is their plan,
written before the code. Each item below was found as a leftover note in an earlier pull request
(#671, #677, #680, and the Phase C and D build notes); the agent that wrote them is gone, so every
claim was checked against `main` at `a7ae223` before anything was changed. No migration, no
dependency, no new persistence.

## 1. "Deleting a season that has games fails" (#680): not a defect; nothing to fix

**The claim.** `games.season_id` is `ON DELETE SET NULL` while the season's teams are already gone and
the team foreign key refuses, so a season with games cannot be deleted.

**What is true** (_executed_, a scratch cluster built from all 169 migrations at `a7ae223`, Postgres 16):

| Case                                                                                                                                   | Result                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The game row is inserted in the **same transaction** as `DELETE FROM season_settings` (every pgTAP file is one transaction)            | `ERROR: insert or update on table "games" violates foreign key constraint "games_home_team_id_fkey"`                                                           |
| The game row is **committed** earlier (what production holds); `DELETE` as `postgres`, so with no `auth.uid()` as in the retention job | the season, its divisions, teams **and its games go**; nothing refused                                                                                         |
| A committed game whose `season_id` is the deleted season but whose teams are in another season                                         | the game is **kept**, `season_id` set null: the `SET NULL` does what it was written for                                                                        |
| A signed-in admin runs `DELETE FROM season_settings` (a draft or a completed season)                                                   | **0 rows deleted, no error**: `20261101010000` dropped the INSERT, UPDATE and DELETE policies ("the season RPCs are the writers"), and no RPC deletes a season |

**Why the first case fails.** The `SET NULL` update of `games.season_id` runs after the cascade through
`divisions` and `teams` has removed the game's teams. Postgres re-checks a foreign key on an UPDATE
of a row **the same transaction inserted** (its `xmin` is the current transaction), even when the key
columns are unchanged, and the team is gone. A row from an earlier transaction is not re-checked.
So the failure exists only inside one transaction that both creates the games and deletes the season,
which is what a pgTAP file is and what no application path is.

**Options.** (a) Leave the schema alone and correct the two notes that call it a defect (chosen).
(b) Make `games.season_id` `ON DELETE CASCADE`: it removes the artifact, but it changes which rows a
season delete takes (a game kept today, with its teams in another season, would go) and needs a
migration, a revert, a smoke and a catalogue snapshot, for a path nobody can call. (c) Add an admin
"delete this season's data" RPC: a product feature (`season-enrollment.md` says it is "a later
change"), not a fix.

**Choice.** (a). A fix for a failure no caller can reach, behind a migration, is the refactor beyond
the request that rule 2 says to flag; and the real delete semantics (a season's own teams take their
games with them; a game of another season's teams survives, unlinked) are already right and are now
measured. The comment in `supabase/tests/season_schedule_readonly.sql` and the sentence in
`2026-10-27-season-enrollment.md` that say "cannot be deleted at all, before or after this migration"
are corrected to what was measured. Tests: none new (nothing changes); the pgTAP file's assertions
are unchanged and it is re-run.

## 2. A preserved player later waitlisted stays on the roster, unlisted (#671)

**Today** (_statically reviewed_, `packages/core/src/teamGeneration.js`, `buildTeamsForDivisionIncremental`).
On a rerun a **blocked** player already on a reviewed roster stays there and is listed in
`changeDiagnosticsByDivision[div].eligibilityHolds`, which the Teams page shows under "Needs review"
(owner decision 3 of B2: a reviewed roster is never reshuffled). A **waitlisted** player is held out
of a late placement (`separateEligibilityBlocked`), but one already on a preserved roster stays and
nothing says so: `eligibilityHolds` filters `isEligibilityBlocked` only. The Phase B plan lists this as
"Not built".

**Options.** (a) List them: the same contract as a blocked player, "stays on the reviewed roster, listed
for the admin to move by hand" (chosen). (b) Remove them from the roster: breaks the invariant that a
reviewed, published or locked roster is never reshuffled, and a locked team forbids it. (c) Do nothing.

**Choice.** (a), by the rule "when a sibling already handles an edge case, adopt its contract". No
product behaviour is invented: nobody moves.

**Design.** The state is read where it already is computed, `isWaitlisted` / `cannotBePlaced`
(`playUp.js`). `eligibilityHolds` takes a final-roster player for whom `cannotBePlaced` holds. A
blocked player is listed exactly as before (no new key); a waitlisted one is listed with
`waitlisted: true` and `reviewReason: null`; a player both blocked and waitlisted is listed once, as
blocked (as the overflow already reports them). The review (`summarizePlacementReview`) carries
`waitlisted` on the entry, and enumerates a waitlisted player found on a current roster that the holds
do not name (a manual move onto a team), as it does for a blocked one. The list words it: "On the
waitlist, but already on the reviewed roster. Kept there; move them by hand if you agree."

**Tests** (each shown failing first): `tests/teamGenerationWaitlistHold.test.js` (a rostered player
waitlisted later is kept on the same team UUID and listed; on a locked team too; blocked and waitlisted
is one blocked entry; a late waitlisted player still overflows and is no hold; a player taken off the
waitlist by the exception is no hold; everyone seated or in overflow exactly once), and
`tests/placementReview.test.jsx` (the entry, the roster enumeration, the words, the live-region count).
The B2 golden (nobody blocked or waitlisted) stays byte for byte.

## 3. The recommended team count counts waitlisted players (#671)

**Today** (_statically reviewed_, `TeamAnalysisPage.jsx`). `derivePrograms(rows)` counts every import
row as a player; `deriveProgramStats`, `TeamingConfiguration` and the overview feed that count to
`assessTeamCount` and `resolveTeamCount`. Generation builds its count over the players it can seat
(`separateEligibilityBlocked`: not blocked, not waitlisted), so with the Waitlist option on the page
recommends more teams than generation makes. The Phase B plan records it as left as it was, "as it
already counts the not-eligible".

**What is in scope.** The waitlisted. The not-eligible need each player's age placed against the
division rules (a different computation) and are not part of this follow-up; they are listed for the
owner.

**Design.** One predicate, `isWaitlistedRow(row)`, is the only place the page decides a row is
waitlisted; `toGeneratorPlayer` calls it (its behaviour is unchanged) and so does the count.
`derivePrograms` takes the set of waitlisted rows and gives each program `playerCount` (the players
generation can seat: what the advice functions are for), `waitlistedCount`, and `totalPlayers` (all
registered, as before). The overview's Players cell and the panel's sentence say how many are on the
waitlist when there are some, and are byte for byte as before when there are none.

**Which rows are waitlisted** is the record's word over the file's, as generation reads it
(`withDurableIdentity`: the stored `status` replaces the file's waitlist column). A file-only count
would be wrong in the other direction after a save, because a coach's child's buddy taken off the
waitlist is made active in the record (`activateWaitlistedPlayers`) while the file still marks them
waitlisted, and would be left out of the advice for a player who now takes a seat. So, only while the
Waitlist option is on, the page reads the stored status of the file's players once per import
(`fetchDurablePlayers`, the generation's own read: chunked, at most eight requests at a time) and
decides each row with the same function generation uses. A read that fails is logged and the file's
column is used meanwhile; generation still re-reads and still stops on a refused read. A league
with the option off makes no new request and counts as before.

**Options.** (a) File's column only: no request, wrong after a save (rejected). (b) The record over
the file, read once (chosen). (c) Show the count only after a run: loses the advice before generating.

**Callers checked** (`rg derivePrograms|playerCount|assessTeamCount|recommendedTeamCount`):
`deriveProgramStats` (est. teams, recommended, average roster, capacity), the overview's Players
cell, `TeamingConfiguration`'s advice, and `destinationPrograms` (the divisions a birth-date window
fills; its count leaves out the waitlisted too). `assessTeamCount` and `resolveTeamCount` themselves
are not changed: they are told the right number.

**Tests** (failing first): `tests/teamingConfigurationAdvice.test.jsx` (30 rows with 6 waitlisted by
the file: recommended is for 24, not 30, and the row says 6 on the waitlist; the record moving one
off the waitlist and one on changes it; the option off counts all 30; a refused read falls back to the
file's column and logs; an exact-multiple edge where one waitlisted player is the difference between
2 and 3 teams); `tests/rosterSizing.test.js` is unchanged (the function is not).

## 4. Permits: Open and Download are written twice (#670)

**Today** (_statically reviewed_). `FieldPermitsSection.jsx` (the admin's section in Fields & Venues)
and `PermitsPage.jsx` (the admins' page) each carry the same two handlers: open a tab on the tap, make
a signed link, point the tab at it or close it; make a signed link with a download name and click an
anchor. The #670 note left a shared helper "for the owner to call". The same two files also carry a
byte-identical file-size formatter (`sizeText` against `permitSizeText` in `utils/permitText.js`) and
the same status icon and badge (`STATUS_ICON` against `components/permits/PermitStatusBadge.jsx`). The
core package and the Edge `_shared` mirror hold no permit logic of their own (`rg -i permit
supabase/functions`: three unrelated mentions), so there is no third copy.

**Choice.** The owner has now asked for it. `frontend/src/utils/permitFile.js` holds
`openPermitFile(signedUrl, path)` and `downloadPermitFile(signedUrl, file)`; each call site keeps its own
busy state and its own error text. `FieldPermitsSection` uses the existing `permitSizeText` and
`PermitStatusBadge` instead of its copies. Behaviour is identical: the existing tests of both call
sites (`FieldManagementPermits.test.jsx`, `permitsPage.test.jsx`) are the proof and are unchanged; the
helper has its own test (the tab opens on the tap and loses its opener, is pointed at the link, is
closed when the link fails, a blocked tab falls back to the window, the download anchor is added,
clicked and removed, and a failed link clicks nothing). The helper keeps the copies' exact steps,
including that an anchor whose click throws is not removed (a browser's `click()` does not throw).

## 5. "An unknown sunset is still refused" (Phase D): skipped, owner decision needed

**What "refused" means in code.** Past sunset is flagged, never blocked (owner, 2026-10-27), in the Edge
daylight pass and in the core repair. An **unknown** sunset (an unlit or undeclared-lighting venue with
no coordinates and no table row) is handled differently in the two: the Edge pass flags it
(`D4`, `docs/PHASE_8_9_PLAN.md`: "flag, count, banner; never pass; do not refuse yet ... revisit once
the admin UI ships"), and `practice/repair.js` refuses the re-home candidate `sunset-unknown` (TIME TBD,
never read as legal). Lesson 47 records "keep refusing" for the repair.

**Why it is skipped.** The plans state what the behaviour is, not what the owner wants it to become:
D4 says to revisit, and the owner's answer ("flag, but don't block, anything that goes past sunset")
is about a known sunset. Choosing between the options below is a product decision (rule 14, "never
guess product behaviour"), so nothing is changed and it is listed in the pull request:

1. Keep it (today): the repair refuses, the Edge pass flags; an admin who sets the venue's coordinates
   clears it.
2. Make the repair flag as the Edge pass does: place the candidate, mark it "sunset unknown", and let
   the admin decide.
3. Refuse in the Edge pass too, now that the coordinates form exists: strictest, and blocks a league
   that has not entered coordinates.
