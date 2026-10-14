# Resume queue (after the 2026-10-14 pause)

The order to take the remaining work in, by dependency. The plan holds the detail of each item
and its "Discovered during execution" section holds the findings; this file only orders them.
Tags:

- **ready**: can start at once;
- **plan first**: needs a plan the owner approves before any code (`AGENTS.md` rule 14);
- **schema**: a migration, which CI applies on merge.

At most two agent PRs in flight; read [`agent-brief.md`](./agent-brief.md) first.

## Wave 0: unblock (first PRs after the break)

- **ready:** change the mock's organization and season ids (`org-1`, `season-1`) to UUIDs.
  - Core's `SlotSchema` and the auto-scheduler's request schema refuse non-UUID ids. So in mock
    mode every game slot is refused, and Generate Schedule never succeeds.
  - The change touches most of the E2E suite.
  - It goes first because every later scheduling fix wants an engine-backed mock E2E test.
- **ready (read-only):** find out why `set_updated_at()` exists on a fresh build but not in
  production. This is schema drift, and it must be understood before any new migration.
- **plan first:** ask the owner to approve M4.8's plan (the solver's date model).

## Wave 1: finish Milestone 4, alongside the independent UI fixes

- **plan first:** M4.8, the solver's date model.
- **ready:** the M4.7 follow-up, practice exceptions (`relocated`, `time_tbd`), as its own PR.
- **plan first** (scoring change): the game evaluator silently skips a team that is missing from
  a non-empty roster (#576).
- **In parallel**, the Wave 3 UI fixes that don't touch the engines: Import "Continue", the Teams
  page after "Sync to Supabase", the Exports abort check, and the game-view tabs.

## Wave 2: schema, audit and RLS (one writer: CI)

- **schema:** create the `exports` storage bucket and its `storage.objects` policy, which
  "Upload to Storage" needs.
- **schema:** the SQL-side `create_import_job` audit stops storing `file_name`;
  `ImportContext` stops sending it.
- **schema, plan first:** write each audit row in the same transaction as its save
  (`persist_team_schedule`, `persist_game_schedule`). Send audit-write failures to BetterStack
  (`logFailure`).
- **ready:** the real-backend import scenario asserts that an `audit_log` row exists.
- **schema, plan first, deadline:** rewrite the RLS policies flagged by `auth_rls_initplan` (11)
  and `multiple_permissive_policies` (20).
  - Their advisor waivers expire on **2027-01-11**. After that the required pgTAP check fails
    every PR.
  - Start this by early December even if the other waves slip.

## Wave 3: product bugs

- **Import and Teams:**
  - the "Continue" handler sets the import and then clears it;
  - the Teams page loses its success line after "Sync to Supabase";
  - `TeamPersistencePanel`'s 10 s timeout says "Please retry" for an outcome that is unknown;
  - triage the issues with teams added through the UI.
- **Exports:**
  - `useSchedulerRun` detects an abort only by `err.name`, so supabase-js's `PostgrestError`
    slips through;
  - wire "Upload to Storage", after Wave 2's bucket.
- **Game grid:**
  - a drag can land a game in another field's column, which double-books a capacity-1 slot.
    "Move to…" already avoids these;
  - the view tabs are told apart by colour alone;
  - "By Team" does nothing in edit mode.

## Wave 4: M6 polish, accessibility, close-out

- **M6.1-M6.4:**
  - the `packages/core/package.json` entry (`src/index.js`) is missing;
  - the `build` script never runs in CI;
  - `frontend:build` writes a `frontend/.env.local` nothing reads;
  - `process.env.NODE_ENV` is still read in `FeatureGuard.jsx` and `featureFlags.js`;
  - the bundle budget doesn't measure the shipped shape: lazy-load Sentry Replay or re-baseline;
  - record the reviewed esbuild postinstall in `allowScripts`.
- **Accessibility (#580 follow-ups):**
  - `DataGrid` traps Tab once a cell is active;
  - 29 files use `-400` text shades;
  - the analytics charts use hard-coded colours;
  - the axe scan sees only the mock seed's pages;
  - 15 waived `__MOCK_DB__` reads remain in E2E steps.
- **The M1 tails:**
  - a signed-in Sentry event carrying the user and org ids;
  - a BetterStack Edge error carrying the org id.
- **Close-out:**
  - place or defer the 13 July-plan items (DS-4, DS-5, DS-9, DS-14, DS-15, DD-1..5, DD-7, DD-9,
    TG-3);
  - final scorecard and lessons;
  - mark the plan DONE.
- **Upstream** (agent-ready-template, then a sync to repo-build-template):
  - `check-instructions` reads a CRLF `.gitignore` blank line as ignoring every path;
  - `check-audit.mjs`:
    - exit 2 on zero dependencies audited;
    - trim waiver values;
    - open the scheduled-failure issue from its own job;
    - per-event concurrency.
  - The template's 24,000-byte `AGENTS.md` limit exists for Antigravity. This project doesn't use
    Antigravity, so the limit should be configurable. It is not enforced here (`AGENTS.md`
    header).

## Owner, outside the code

- Delete `claude/vibrant-allen-hr7y7s-notes` once this file is on `main`. It held the handoff that
  this file and `agent-brief.md` replace.
- Dependabot opens one monthly majors inventory PR, as a draft, not to merge (D6). Merge the
  minor/patch group after `@dependabot rebase` when it's green.
