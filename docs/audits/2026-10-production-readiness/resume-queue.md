# Resume queue (after the 2026-10-19 close-out)

The remediation plan is DONE (2026-10-19); its "Close-out" section holds the final scorecard and
what was deferred. This file orders what is left, by dependency. The plan's "Discovered during
execution" section holds the detail of each finding; this file only orders them.
Tags:

- **ready**: can start at once;
- **plan first**: needs a plan the owner approves before any code (`AGENTS.md` rule 14);
- **schema**: a migration, which CI applies on merge.

At most two agent PRs in flight; read [`agent-brief.md`](./agent-brief.md) first.

Done since the pause, so nothing here repeats it: the accessibility follow-up (B1, below), Waves 0-4 and the M6 polish (#587-#592, #588),
M4.7's exceptions (#590), M4.8 (#593), the #576 follow-up (#594), the RLS persona matrix and
rewrite (#595, #596), the file-name audit fix (#597) and its telemetry half (#599), the schema drift
fix (#598), and audit-in-transaction (#600).

## Done: B1, the accessibility follow-up (#591's discovered entry)

The axe scan now covers `/exports` with a baseline, `/coaches/practice-preferences` with a pending
request, `/fields` with seasonal availability, `/admin/reports` past its masking threshold,
`/invite/:code`, and seven routes' main dialogs open; bare `text-status-warning` as text is gone
and refused. What stays unscanned, and why, is in the plan's #591 entry ("Done 2026-10-19").

## Next: the planned major upgrades, one PR each

Dependabot's grouped majors PR #584 was closed (2026-10-19): `eslint@10` cannot resolve against
`eslint-plugin-jsx-a11y@6.10.2`'s peer range (`eslint ^3` to `^9`; Build & Test run 38600851700).
`eslint` and `@eslint/js` are ignored at `>= 10` in `.github/dependabot.yml` until a jsx-a11y
release supports ESLint 10. The rest of that group is taken one at a time, each as a plan-first
upgrade (D6 held majors out of the remediation plan), in an order the owner picks:

- `typescript` 7;
- `vite` 8;
- `@vitejs/plugin-react` 6;
- `vitest` 5;
- `jsdom` 30;
- `@sentry/react` 11;
- `lucide-react` 1;
- `dotenv` 18: done (18.0.8), PR #606;
- `globals` 17: its own PR, after #606 (one held major per PR);
- `@testing-library/jest-dom` 7: done (7.0.1), branch `claude/vibrant-allen-hr7y7s-up-jest-dom`, PR number to be added.

The rest are not attempted. Each runs the Definition of Done gates and the bundle check on its own branch.

## After those, as the owner schedules them

All five groups hold the thirteen July items and the tails the close-out deferred; owner for each:
the repository owner. A group that touches persistence, the solver, a schema or a filed figure
starts as a plan.

- **B2, export and registration hardening (plan first, schema for DS-5):**
  - DS-4: spreadsheet-formula characters in the CSV export (`escapeCsvValue` in
    `packages/core/src/outputGeneration.js`). It changes what an export contains, negative numbers
    included, so the plan decides the escaping rule;
  - DS-5: a throttle on `submit_registration`, the RPC left open to `anon`.
- **B3, dashboard, impersonation and observability tails:**
  - DS-9: `TopBar` swallows `impersonateUser` failures, and `AdminComplianceDashboard` leaves them
    unhandled;
  - DS-14: `dashboardCache` (`frontend/src/lib/cache.js`) is used only by its own test; wire it in
    or delete it;
  - DS-15: both dashboards await their queries in sequence;
  - Edge logging residuals (M1): the auto-scheduler's other refusals and fairness-scoring's two
    season-read `console.error`s carry no request id; the persistence stand-in handler is not
    wrapped; `flush()` is awaited before a failing response. Needs the Deno suite and a redeploy;
  - production's performance advisors report 90 `unindexed_foreign_keys` and 19 `unused_index` at
    INFO (read 2026-10-19). Untriaged; any index is a migration, so plan first.
- **B4, docs-drift pass (docs only): done**, branch `claude/vibrant-allen-hr7y7s-b4-docs` (PR number to be filled in by the coordinator):
  - DD-1: `frontend-architecture.md`'s route table (`/compliance`, `/reporting`,
    `/registration/:formId`; the live paths are `/admin/compliance`, `/register/:formId`);
  - DD-2: `docs/expansion/03_ROADMAP.md` lists division team-size configuration as backlog;
  - DD-3: `data-modeling.md` and `team-generation.md` omit two shipped subsystems;
  - DD-4: `persistence-rpc-layer.md` lacks the `20260613*` RPCs;
  - DD-5: `v1.1-planning.md` quotes old M2.2 wording;
  - and `docs/security/rls-policies.md`'s example policy shape, out of date for every table the
    RLS rewrite touched.
- **B5, test journeys and tooling:**
  - TG-3: scenarios for DST-boundary practice splitting, rainout acknowledgement, and a late
    registrant on a locked roster;
  - DD-9: `playwright.config.ts` loads only `.env`, so `.env.test` (the documented place for the
    `TEST_*` credentials) is never read locally.

## The release

- **v1.1.0 is cut in its own PR, after the close-out is merged** (the owner's decision). The
  README's release line is held to `package.json` and `CHANGELOG.md` by
  `tests/releaseLine.test.js`, so the three change together.
- Then the release smoke, owner: the plan's Manual QA script on the deployed app, a signed-in
  Sentry event carrying the user and organization ids, and a BetterStack Edge error carrying the
  organization id (M1.5's two deferred legs).

## Upstream (agent-ready-template, then a sync to repo-build-template)

- `check-instructions` reads a CRLF `.gitignore` blank line as ignoring every path.
- `check-audit.mjs`:
  - exit 2 on zero dependencies audited;
  - trim waiver values;
  - open the scheduled-failure issue from its own job;
  - per-event concurrency.
- The template's 24,000-byte `AGENTS.md` limit exists for Antigravity. This project doesn't use
  Antigravity, so the limit should be configurable. `AGENTS.md` is sized for Claude Code and
  Codex (its header).
- `supabase.advisors-in-ci` fails a gate that does fail on unwaived findings: it reads `--fail-on
  none` as "never fails", though `scripts/ci/supabaseAdvisors.mjs` blocks on the JSON. Baselined in
  `docs/standards/conformance.json` until the probe can read a wrapper.

## Owner, outside the code

- The product questions the RLS work left: Q5 (should a `tenant_admin` match `is_org_admin` on
  `season_settings`, `registration_forms`, `audit_log` and `organization_schema_history`?) and Q6
  (should any signed-in user read open registration forms?). Both are kept as they are.
- Clear the Vercel dashboard's build-command override (`vercel.json` now carries the build
  settings; M5.4's last step).
- Turn on Auth's leaked-password protection (hosted advisors only; CI cannot see it).
- `check:settings` needs a token with Administration: read.
- Merge the Dependabot minor/patch group after `@dependabot rebase` when it's green. The monthly
  majors inventory PR is a draft and is never merged (D6).
- Delete `claude/vibrant-allen-hr7y7s-notes` and the other agent branches
  (`claude/vibrant-allen-hr7y7s-*`) once their PRs are merged.

## Backlog, flagged during the plan and not scheduled

Each is described where it was found, in the plan's "Discovered during execution". None blocks
anything above.

- The game grid draws every slot under every field, so (N-1)/N of its cells read "Other field";
  drawing only each field's own slots is a layout change (Wave 3 UI entry).
- The import panel's `importStatus` lives in `localStorage`, with no expiry and not per
  organization (Wave 3 UI entry).
- Teams added through the UI (Wave 3 UI triage): "Recent Supabase Syncs" words a staged review as
  a sync; Team Builder ignores a refused `teams` read; a dropped connection reads "Sync failed"
  although the save may have committed (all three persistence clients).
- The mock seed: its other ids are not UUIDs, and its game slots sit at 1:00 and 2:30 AM outside
  the season's dates (Wave 0 entry).
- The import page's "Roll Back Coach Import" button disappears after navigating away; nothing on
  screen reads `player_buddies`; the team portal shows no RSVP time (Wave 4 entry).
- The override panel's "N free" ignores exceptions, and a relocation is counted on its date even
  outside the target slot's validity (M4.7 follow-up entry).
- The catalogue drift check does not compare function bodies; a field imported with halves has no
  sub-surfaces until saved; the mock's direct-table `fields` paths still imitate the dropped
  trigger (schema drift entry).
- `finalize_import_job` writes two `import.completed` rows per import; the Audit Explorer has no
  import action filter; `uploadScheduleExport` still defaults to `upsert: true`, which the
  `exports` bucket refuses (exports entry).
- The real-backend runs' Edge logs show the auto-scheduler's own run record refused ("Not
  authorized: User is not a member of organization"); whether `main` shows it too is unverified
  (exports entry).
- Prettier is held at 3.7.4 and `@tanstack/virtual-core` at 3.13.23 (Dependabot holds them);
  each upgrade is its own PR (M2.1 entry).
