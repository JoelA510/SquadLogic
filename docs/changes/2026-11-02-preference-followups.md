# Practice preference follow-ups: edit a pending must without deciding it; a pointer from Data Ingestion

Kind: FEATURE (two small follow-ups to C1/C2) · Drawn up: 2026-11-02 against `origin/main` `228980a` ·
Owner: the repository owner · Status: **direction given** ("Address smaller items as recommended",
2026-11-02); both items follow the recommendations in the brief. Amends
`docs/changes/2026-10-27-phase-d-scheduling.md`, build notes C2, departure (4) ("Editing a rule that was
asked for as a must decides the request"); everything else in C1 and C2 stands.

AGENTS.md rule 14 applies to item 1 (it replaces an RPC that writes a persisted decision): this plan is
committed before any code, and the stop conditions the brief names are checked in "Stop conditions" below.
Every claim about the code is _statically reviewed_ unless marked _executed_. The production figures are
_executed_, read-only, 2026-11-02, through the Supabase MCP.

## Why

1. **An admin cannot fix a pending must without deciding it.** `admin_edit_practice_preference` decides a
   requested must by the level it is sent (`20261112010000`, lines 489-567): a rule with `requested_level =
'must'` edited at `prefer` becomes `kept_prefer`, at `must` becomes `accepted`. The editor therefore warns,
   and defaults to Prefer, so that correcting the days of a pending must does not accept it by accident, and
   the price is that it silently _declines_ it instead. Correcting a coach's typo should do neither.
2. **Practice preferences are imported on the Practice preferences page, not on Data Ingestion** (C2
   departure 1: an "Import a file" tab, not a fifth type of the shared panel). An admin who goes looking on
   Data Import for where preferences go finds players, coaches, evaluations, fields and field availability and
   no mention of preferences. The owner's recommendation, taken: **no second importer**, a pointer.

## Behavior

### Item 1: editing a pending must leaves it pending

What `admin_edit_practice_preference(p_preference_id, p_level, ...)` does to the decision, by the rule's state
before the edit and the level sent (only the rows that differ are in bold):

| Before                                                | `p_level`                   | `must_decision` now                    | After this change                                           |
| ----------------------------------------------------- | --------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| pending must (`level` prefer, `requested_level` must) | `prefer` (also the default) | `kept_prefer`, `decided_by/at` stamped | **`pending`, `decided_by/at` untouched**                    |
| pending must                                          | `must`                      | `accepted`, stamped                    | unchanged: accepted, stamped (the edit decides, explicitly) |
| accepted must                                         | `must`                      | `accepted`, stamped                    | unchanged                                                   |
| accepted must                                         | `prefer`                    | `kept_prefer`, stamped                 | unchanged (the admin changed the level, explicitly)         |
| kept as prefer                                        | `prefer`                    | `kept_prefer`, stamped                 | unchanged                                                   |
| kept as prefer                                        | `must`                      | `accepted`, stamped                    | unchanged                                                   |
| never asked as a must                                 | `prefer` / `must`           | `NULL` / `accepted`                    | unchanged                                                   |

So the one new rule is: **a rule that is still pending and is saved at the level it is already in force at
(`prefer`) is not decided.** Nothing else in the RPC changes: the conditions, priority and window are replaced
as before, the CHECKs hold as before, `requested_level` stays `must`, `level` stays `prefer`.

The decisions are made only where an admin made them on purpose: **Accept as must** and **Keep as prefer**
(`admin_decide_must_preference`, the Pending musts list, the editor's own buttons), **Accept all**
(`admin_accept_all_musts`), or an edit that changes the level to Must.

### Item 1: the editor

For a rule whose `must_decision` is `pending` the dialog shows **Still pending** (a badge and a sentence:
"This rule was asked for as a must and counts as a prefer until you decide. Saving your changes does not
decide it.") in place of the Level control, and, beside it, **Accept as must…** and **Keep as prefer** as
buttons of their own:

- **Accept as must…** closes the editor and opens the same Accept dialog the Pending musts list uses, with the
  impact preview (`AcceptMustDialog`).
- **Keep as prefer** calls `admin_decide_must_preference(id, 'keep_prefer')` and closes the editor.
- Both act on the **saved** rule, so they are off while the form holds unsaved changes (and say why in text
  tied to them), so no admin accepts "the new days" and gets the old ones.
- **Save rule** sends the level in force (`prefer`) and says what the database answered: "Rule saved. It is
  still waiting for your decision." when the row came back pending, and the plain "Rule saved" plus what was
  decided if it did not (so a new editor against a database that has not yet applied the migration does not
  claim a rule is pending when it was decided).

Rules that were requested as a must and already decided keep today's wording and today's Level control
("Saving it as Prefer keeps it as prefer; saving it as Must accepts it").

### Item 2: the pointer

On Data Import (`/import`, the page whose panel is headed Data Ingestion) a small card under the panel:
**Practice preferences are imported on their own page.** It says that a coach preference file is imported on
the Practice preferences page, in its Import a file tab, that the tab shows what the file will do before it
does it, and that a must in the file stays pending until the admin accepts it; one link, **Open Practice
preferences, Import a file tab**, to `/coaches/practice-preferences?tab=import`. The Practice preferences page
reads `?tab=` once, on arrival, to choose the tab it opens on (`import`, `pending`, `rules` or `conflicts`;
anything else is ignored and the page opens as it does today).

The card is shown **only where the page it points to is reachable**: it takes the visibility rule from the
`practice-preferences` entry of `NAV` (`constants/navigation.js`) itself, the same `permission` and optional
`feature` the side navigation filters that entry by, so if the entry is ever put behind a feature flag the card
follows it without being edited. Today that is `DECIDE_PRACTICE_PREFERENCE` (admin and staff) and no flag; the
route carries the same permission and no flag (`App.jsx`). If the entry cannot be found the card renders
nothing, and a test fails.

## Out of scope

- A fifth import type on Data Ingestion, or any change to `ImportPanel`, `ImportContext`, the allowlist or the
  shared import path (the owner's recommendation is the opposite).
- Changing what Accept all, Accept as must or Keep as prefer do, or the audit action names.
- The `decided_by` / `decided_at` stamps of an edit that does not change a decided rule (an accepted must edited
  at `must` re-stamps today; left as it is: `must_decision` semantics are unchanged everywhere else).
- Anything in `packages/core`, `supabase/functions` or `fixtures/season-2026`.

## Stop conditions (brief), checked

| Condition                                         | Result                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a table, column, CHECK, RLS or grant change       | **None.** `CREATE OR REPLACE FUNCTION` with the same signature keeps the owner and ACL; the 16 CHECKs and the RLS read policy are untouched; no `GRANT` or `REVOKE` is written. The migration's end-state check requires `authenticated` can run it and `anon` cannot.                                                                             |
| a new audit action needing a CHECK or enum change | **None.** The edit keeps `practice_preference.edited` (before and after rows).                                                                                                                                                                                                                                                                     |
| `fixtures/season-2026` results move               | **They cannot.** Core and the Edge twin read `level` (and the rule's conditions), never `must_decision` or `requested_level` (`grep` over `packages/` and `supabase/functions/`: no match); a pending must and a rule kept as prefer are both `level = 'prefer'`, so the solver input is identical. The suite is still run (full `test:coverage`). |

## Against the rules

- **Rule 14 (persistence).** The change is to an RPC's decision logic, so the plan is committed first (this
  file) and the build notes record what happened. The brief carries the owner's go-ahead for these two items.
- **Backward compatibility.** The signature (eleven arguments), the defaults (`p_level` still defaults to
  `'prefer'`), the return value (the row as `jsonb`), the errors (42501, 22023 `not_in_force`, 22023
  `season_completed`, 23514 from the CHECKs) and the grants are unchanged. **What a pre-existing caller now
  gets:** a caller that sends `prefer` (or omits the level) for a _pending_ must used to decide it as
  `kept_prefer`; it now leaves it pending. A caller that sends `must` gets `accepted`, as before. Every other
  state and level is unchanged (table above). **Why that is safe:** the scheduler cannot tell the two apart (a
  pending must and a must kept as prefer are both in force as `prefer`; no reader of `level` looks at
  `must_decision`), no row becomes a must without a `must` sent explicitly or an Accept, and the only visible
  difference is that the rule stays on the Pending musts list. The one way that difference could bite is a
  caller that meant "keep as prefer" and relied on the edit to say it: only this repository's own editor did,
  and it is updated here; a browser tab still running the old bundle would leave the rule pending, where the
  Pending musts list still shows it and Accept all's confirmation still names and counts it (lesson 78).
- **Locking.** The brief says "per-team advisory lock as in the siblings". Read from the migration and from
  production (_executed_: the five admin RPCs' deployed bodies contain no `advisory`; the finalizer's does),
  **none of the five admin RPCs takes a per-team advisory lock; they lock the rule's row (`SELECT ... FOR
UPDATE`), and only `finalize_practice_preference_import_job` takes the per-team advisory lock** (lesson 72,
  two files replacing one team's imported rules). This change keeps what the edit already does, the row lock,
  which serializes it against the finalizer's replacement of that same row (the second reads the first's
  committed state). Adding an advisory lock _after_ the row lock would take the finalizer's two locks in the
  opposite order and could deadlock; adding it _before_ it is a new pattern in an RPC whose siblings do not
  have it. Left as is, and flagged for the owner in the PR.
- **Audit.** The edit writes the same `practice_preference.edited` row with `before` and `after`; a
  pending-stays-pending edit shows `must_decision` `pending` in both.
- **Known and unchanged:** the RPC takes the level the caller believes is in force. An editor opened on a
  pending rule that another admin accepted in the meantime would send `prefer` and demote the accepted must to
  `kept_prefer`, exactly as the old editor would have. A guard argument (expected decision) would close it, at
  the price of a signature change and a drop-and-replace; not taken, listed for the owner.

## Design

### The migration `20261116010000_edit_keeps_must_pending.sql`

- Version: the next free after `20261115010000`. Checked: the repository's ledger ends there (`ls
supabase/migrations`), production's ledger ends there (_executed_ `list_migrations`, 2026-11-02), and the
  only open pull requests are two dependency bumps.
- **md5-guarded on the deployed body.** `md5(replace(p.prosrc, E'\r', ''))` of `public.admin_edit_practice_preference`
  read from production (_executed_, read-only, project `mmwupqsjkikqzvmdvuzm`, 2026-11-02) is
  `4d909e3ea286460367c2ca7c8671f89d`; the same digest of the body in `20261112010000` (3,104 characters) is
  `4d909e3ea286460367c2ca7c8671f89d`. The migration refuses to run on any other body, and on any signature
  but the one.
- **The body** is the deployed one with two `CASE` branches changed: `must_decision` gains `WHEN must_decision
= 'pending' THEN 'pending'` after the `must` branch, and `decided_by` / `decided_at` skip a pending rule that
  is not being accepted. `CREATE OR REPLACE` resets the `SET` clauses (lesson 40), so the pinned `search_path`
  and `TimeZone` are stated again and the end-state check reads them. The comment is replaced.
- **End-state check** (the migration does not commit otherwise): one overload; a definer with `search_path` and
  `TimeZone` pinned; `authenticated` may execute and `anon` may not; the body names the pending branch; the
  new md5 differs from the old one (a no-op replacement is a mistake); the comment names the rule.
- **Revert** `docs/sql/20261116010000_revert.sql`: restores the `20261112010000` body (md5 checked) and its
  comment. Nothing else changed, so nothing else is restored. A rule left pending by an edit stays pending
  (the revert cannot know which ones); it is still a valid row under the old function.
- **Smoke** `docs/sql/20261116010000_smoke.sql`: as a real admin through the RPC, on a pending must, an
  accepted must, a rule kept as prefer and a rule never asked as a must (the table above, row by row), with
  `decided_by` / `decided_at`, `requested_level`, `level` and the audit row read back.

### The mock client

`frontend/src/lib/mockCoachPreferences.js` answers the RPC for the E2E and the unit tests; its edit branch gets
the same two `CASE` changes, held to the SQL by the same table in `tests/coachPreferencesMock.test.js` and by
the smoke and the pgTAP file. No Edge or core twin of this RPC exists (`grep` over `packages/` and
`supabase/functions/` for `admin_edit_practice_preference`: no match).

### Harness

Plants in `scripts/dbharness/prove.sh`, M65 / R65 (the next free after M64 / R64), each anchor resolving
exactly once (`PLANT_ANCHORS_ONLY=1`), and each **run for real** through `run.sh` in its own copy of the
repository, red at the check named, then discarded. Nine are on the migration: four aimed at the smoke (the
pending branch placed after the kept-as-prefer branch so it never fires; before the accepted branch so a save at
`must` leaves the rule pending; a pending save that stamps `decided_by`; one that stamps `decided_at`), one at
the accepted-must branch (dropped), and four at the migration's own end-state check (the pending branch
deleted, the pinned search path lost, the rule granted to `anon`, the md5 guard expecting another body). Two are
on the revert (a restored body that is not the deployed one; the new comment left in place). A plant aimed at
the smoke keeps the end-state check's text in the body and breaks what the body does, so the smoke is the
check that catches it and not the text (the first design, deleting the branch, was caught by the text check and
could not prove the smoke's claim). Two `(checked)` claims go in `run.sh`, each registered in `CLAIM_PROVER`
against the plants that reach it. The harness also seeds a pending must and an admin before the revert and, after
it, runs the old meaning as that admin (an edit at `prefer` keeps it as prefer again). The catalogue snapshot
holds signatures, policies, triggers and views, none of which change, so it is **not** regenerated (checked by
the harness's own diff). No existing plant aims at `20261112010000`'s `admin_edit_practice_preference` body
(`grep` of `prove.sh`), so none is re-aimed (lesson 70); `PLANT_ANCHORS_ONLY=1` confirms it.

### Frontend

`RuleDialog` (the pending branch above), `RuleForm` (a read-only Level for a pending rule), `AdminPreferenceReview`
(passes `onAccept` so the editor can hand over to the Accept dialog and `onKeepPrefer`), the hook's comment, and
`CoachPreferencesPage` / `AdminPreferenceReview` for `?tab=`. New: `components/preferences/PracticePreferencesPointer.jsx`
and its place in `pages/ImportPage.jsx` (not in `ImportPanel`, which stays untouched).

## Risks and rollback

- **Rolling out.** The migration and the frontend merge together; CI applies the migration, Vercel deploys the
  bundle, in either order for a few minutes. New frontend on the old function: a save on a pending rule
  decides it (the old behavior) and the dialog reports what the database returned. Old frontend on the new
  function: a save on a pending rule leaves it pending, with the old dialog saying "Prefer keeps it as prefer"
  (see "Backward compatibility").
- **Rollback.** The revert script (function body and comment only). The frontend revert alone is also safe: the
  old editor against the new function leaves a rule pending that it described as kept.
- **A replaced function is a replaced guarantee** (lesson 70): no plant aims at the old body today; the
  harness refuses the run if one is later added that does.

## Tasks

Each names its test.

1. Plan committed first: this file. (No test.)
2. Migration, revert, smoke, harness registration (`REVERT_CHECKS`, the post-revert verdict, two `(checked)`
   claims, eleven plants) · tests: the migration's end-state check; `docs/sql/20261116010000_smoke.sql`; the
   revert's own verdict; each plant red.
3. pgTAP: `supabase/tests/practice_preference_rules.sql` gains the edit-keeps-pending cases (pending at
   `prefer`, at `must`, `decided_by` untouched, the audit row, an accepted must still demoted by `prefer`, a
   kept-as-prefer rule still kept, a non-pending rule unchanged) · run on a scratch PostgreSQL 16 with real
   pgTAP.
4. Mock client parity · `tests/coachPreferencesMock.test.js` (one table of the rows above).
5. Editor: pending branch, Accept / Keep as prefer buttons, the dirty guard, the honest toast ·
   `tests/coachPreferencesUi.test.jsx` (the old pending-note test is rewritten; new: the buttons, the guard,
   Save leaves it pending, Keep as prefer decides, the toast when the database decided).
6. Pointer, visibility rule and `?tab=` · `tests/preferencesImportPointer.test.jsx` (admin sees it with the
   link; a role without the permission does not; a flag on the nav entry hides it when off; a missing entry
   hides it; the page opens on `?tab=import`, ignores an unknown tab).
7. E2E · `tests/e2e/features/practice_preferences_import.feature`: the editor on a pending must (stays pending,
   axe in both themes) and `tests/e2e/features/practice_preferences_pointer.feature`: the card on `/import`,
   the link opening the Import a file tab, and axe in both themes.
8. Docs: `docs/architecture/practice-scheduling.md` ("The preference screens"), the C2 build-note departure
   (4) pointed at this plan, lesson 86, CHANGELOG (Unreleased, Changed).

## Done when

The gates in the brief pass on the final tree (typecheck, lint, `check:unused`, `check:advisors`, full
`test:coverage` at the default timeout, the full mock E2E, the frontend build and `check:bundle`, the harness
and the touched pgTAP file on a scratch cluster, `git diff --check`), each new or changed test has been shown
failing against a planted defect, and the pull request says what was run and what was not.

## Decisions for the owner

1. **Locking.** The siblings take row locks, not a per-team advisory lock (above). Keep the edit as it is
   (recommended), or ask for the advisory lock with the lock order spelled out?
2. **The stale-editor demotion** (above) is unchanged. A guard argument would close it at the price of a
   drop-and-replace of the RPC; worth it?
3. **The decided stamp on a no-op edit** of a decided rule is unchanged (re-stamped). Leave (recommended).

## Build notes (2026-11-02)

- **Built as planned:** the function replaced on its deployed body (`20261116010000_edit_keeps_must_pending.sql`),
  its revert and smoke, the harness registration, the mock client, the pgTAP cases, the editor, the card on Data
  Import and the `?tab=` link, the tests, the docs, lesson 86. No table, column, CHECK, RLS, grant or audit-action
  change, and no result of `fixtures/season-2026` can move (core and the Edge twin read `level`, never
  `must_decision`), so none of the brief's stop conditions arose.
- **Departures from the plan above:** (1) eleven plants rather than seven (the harness section says which: the first
  design for the smoke plants, deleting the pending branch, was caught by the migration's own text check at
  `applying` and so could not prove the smoke's claim, which is how the reorder plants and the stamp plants came to
  be). (2) `RuleForm` takes a `levelLocked` prop for the read-only level; the plan said "a read-only Level" without
  naming the seam. (3) The Accept dialog is reached by handing over from the editor (one `dialog` state), not by
  opening a second modal over it.
- **Found while building:** (a) the brief's "per-team advisory lock as in the siblings" does not describe the
  siblings (see "Locking" above); (b) `NAV.flatMap` over a union of group and item entries does not typecheck in a
  `.jsx` file under `checkJs` (a loop and a cast do); (c) the pointer's test restored the `NAV` entry it had
  renamed by looking it up by the new id, which left the entry renamed for every later test in the file (it now
  keeps the object by reference); (d) **Playwright's `reuseExistingServer` is on outside CI, so a full E2E run
  started while another worktree's dev server held port 5173 ran against that worktree's code**: the first full
  run (178 passed, 41 failed, among them every new scenario, which showed the old dialog) was invalid for this
  tree and was repeated with `CI=true`, which makes Playwright start its own server; (e) the shared scratch
  directory held another session's `plants/` folder, which was left alone (these plants used `plants65/`).
- **Planted defects.** _Tests (three, each shown red, then reverted):_ the mock client decides a pending must again
  (`staysPending = false`): 2 of the 24 in `tests/coachPreferencesMock.test.js` red, and the E2E scenario "Saving
  the days of a pending must leaves it pending" red (the toast says the rule is no longer pending); Keep as prefer
  not guarded by unsaved changes (`disabled={busy}`): 1 of the 39 in `tests/coachPreferencesUi.test.jsx` red; the
  pointer ignoring the permission: 2 of the 10 in `tests/preferencesImportPointer.test.jsx` red. _Not planted:_ the
  `?tab=` link tests, the Accept hand-over test, and the pointer's E2E scenarios (each passes on the final tree and
  was not shown failing). _The migration (eleven, harness plants M65 and R65):_ each run for real through
  `scripts/dbharness/run.sh` in its own copy of the repository, each scored CAUGHT at the check named and by no
  other: five at `smoke 20261116010000`, four at `applying 20261116010000_edit_keeps_must_pending.sql`, two at
  `revert 20261116010000`. The five smoke-aimed bodies were also applied to a scratch database and the new pgTAP
  file run against each: every one turns assertions red (the pending-stays-pending ones fail by value; the two that
  break a CHECK abort the file's transaction, so the rest error rather than fail).
- **Verification** (_executed_ means run here and its output read; nothing here is _fully validated_ against the
  hosted project):
  - _Executed_, the database: `bash scripts/dbharness/run.sh` ends `HARNESS OK` (172 migrations apply from scratch,
    every smoke including `20261116010000`'s two claims, every revert including its own with the old meaning run as
    the planted admin, the catalogue snapshot unchanged at 196 functions, 69 triggers, 112 policies, 4 views);
    `PLANT_ANCHORS_ONLY=1`: 446 of 446 anchors resolve exactly once, none inside a superseded statement;
    `PROVE_CLAIM_CENSUS_ONLY=1`: 149 claims, each with a plant declared. pgTAP on a scratch PostgreSQL 16 with real
    pgTAP (the harness prelude standing in for `auth`, with `auth.uid()` completed): `practice_preference_rules.sql`
    81 of 81, `practice_preference_import.sql` 52 of 52, `demo_sessions.sql` 113 of 117 (the four failures are the
    storage assertions 77 to 80, and the same four fail, 113 of 117, in the same scratch setup built from `main`'s
    171 migrations without `20261116010000`).
  - _Executed_, the app: `npm run typecheck`, `npm run lint` (no ESLint output), `npm run check:unused`,
    `npm run check:advisors`, `npm run test:coverage` at the **default** timeout (489 files, 7,819 tests, exit 0, no
    timeout raised), the frontend build made as CI makes it and `npm run check:bundle` (all chunks within budget),
    the full mock E2E (219 passed, `--workers=1 --trace off`, `CI=true`, 19.7 minutes; artefacts deleted),
    `git diff --check`.
  - _Executed_, read-only against production on 2026-11-02: the deployed `admin_edit_practice_preference` has md5
    `4d909e3ea286460367c2ca7c8671f89d`, equal to the body in `20261112010000`; the five admin RPCs' bodies contain
    no `advisory`, the finalizer's does; the ledger ends at `20261115010000`.
  - _Not run_: the Deno mirror tests and `deno check` (nothing under `supabase/functions` or the Edge twins
    changed); `supabase test db` (CI's pgTAP job, with the real `auth` and `storage`); the real-backend E2E scenario
    (the preference scenarios are mock-client only); `test:perf`; the whole `prove.sh` sweep (hours; only the eleven
    plants of this change were run, for real, beside the anchors and the census); the pointer and the editor with a
    screen reader (axe ran in Chromium in both themes; the keyboard path is Tab-order plus Enter on the link, and
    the unit tests hold the disabled and described states); a browser other than Chromium; the migration against
    production (CI applies it on merge).
