# Changelog

All notable changes to SquadLogic are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Field heat-stress (WBGT) forecast** (`/schedule/heat`, admin-only, behind the new `heat_forecast` org feature): per venue, surface and kickoff window from the current game run (or per hour with no games), the forecast WBGT from the NOAA NWS gridpoint forecast, its U.S. Soccer Recognize to Recover band, and the regional air temperatures that would push the field into Red and Black; NWS update and retrieval times, a stale-forecast warning, the on-site-readings-govern disclaimer, refused rows kept visible with their reason, and a sources panel rendered from row provenance. The model (`packages/core/src/heat/`) is a port of the Python reference in `scripts/heat/reference/` (Liljegren 2008 WBGT, turf/grass surface model, NREL SPA, Ineichen clear sky) held to it by parity tests; the one substitution, a 0.5-degree Linke turbidity table, and its measured effect are in `docs/architecture/heat-forecast.md`.
- **Org heat settings**: `organization_heat_settings` (threshold category 1-3, up to 10 governing-body guidance links) written only by the audited `admin_set_org_heat_settings` RPC (migration `20261006000000`, revert and smoke in `docs/sql/`, pgTAP), edited under Settings → General → Heat Safety. No row reads as Category 1, labelled as the default.
- **Season-2026 practice corpus and the Phase 8 groundwork** (#358, #359, #371, #374): the anonymised season-2026 practice, registration, permit and field corpus; a strict corpus loader whose integrity test reports findings by code instead of fixing data; the practice layer of the facility graph, with sub-surfaces under the game surfaces; and a core `fieldAdmin` import / export / change set for fields and blackouts that persists nothing and stamps every change set `CHANGE_SET_NOT_APPLIED`.
- **Field lifecycle and blackout administration** (#376, #387, #389). Migration `20260906000000` adds field effective dating, plus `admin_retire_field`, which refuses booked ground unless the caller confirms. Migration `20260906000100` adds admin-authored `field_blackouts` with RLS, and `field_closures`, one reader across both blackout tables. Field Management now retires and unretires fields, with a preview listing the affected bookings, and adds or removes blackouts, showing the affected games and practices as conflicts. Migration `20260910000000` adds `admin_update_field_blackout`, so a blackout is edited in place: it keeps its id and writes one before/after audit row.
- **Venue and sub-surface effective dating** (#391, #393). Migration `20260911000000`: retiring a venue retires its fields and sub-surfaces by containment, worked out when the estate is read, and no dates are copied down onto the children. Migration `20260912000000`: `admin_retire_location` also refuses while the venue still contains live fields or sub-surfaces, unless the caller confirms. The app can now retire a venue or a sub-surface.
- **Season timezone writer** (#396, #398). Migration `20260913000000` adds `admin_set_season_timezone()`, the first writer of `season_settings.timezone`, which audits inside the RPC. Migration `20260917000000` writes one complete audit row for a timezone change made while impersonating another user. Core's season clock composes slot instants in the season's own timezone. The unplaceable-slot banner now groups its reasons instead of growing without bound.
- **Published schedule baselines** (#416). Migration `20260920000000` adds `publication_baselines`. Uploading from the Output Generation panel now records the published baseline, and the same panel reads it back for a parity check.
- **Effective-dated coach assignments** (#432). Migration `20260923000000` makes `team_coach_assignments` the source of truth for who coaches which team, and when. `teams.coach_id` and `assistant_coach_ids` are written only through `set_team_coaches()`. A drift check compares the two, and a sole-coach risk preview shows what a change does before it is saved.
- **Core scheduling-engine modules** (#405, #413, #418, #423, #429, #434, #443): a serialise/read seam for publication snapshots; two-sided, priced move-request analysis (`analyseMoveRequest`, 8.7); a Date-free recurring practice-slot model (8.5, declared unwired); bounded local repair on the games side, with a repair scope, a change budget and published-time hold (8.6 PR 1); accepted baseline breaches keyed per instance and per published slot (8.6 PR 2); classification of the corpus change log with as-of queries (8.8 PR 1, core only); and bounded local practice repair for a field lost mid-season (8.6 PR 3a).
- **Coach practice preferences** (#453, #463, #464, #477).
  - Migration `20260927000000` adds `coach_practice_preferences` with three audited definer RPCs. A coach requests for themself, and only an admin approves, rejects or sets a preference.
  - A new `/coaches/practice-preferences` page sits behind `REQUEST_PRACTICE_PREFERENCE` and `DECIDE_PRACTICE_PREFERENCE`. When an admin approves a `must_keep`, the dialog lists the coach's current series that the approval would make unsatisfiable.
  - Practice repair and the auto-scheduler both treat `must_keep` as a hard filter: a team left with no legal slot goes TIME TBD with reason `coach-preference`. They treat `prefer_keep` as a soft preference.
  - The auto-scheduler Edge Function loads approved preferences itself, through RLS. It refuses with 403 `COACH_PREFERENCES_NOT_VISIBLE` when the caller cannot see every approved row.
- **Practice repair for blackouts, and the recommendation panel** (#458, #468, #497, #498, #501):
  - Repair handles bounded losses (blackouts) as temporary overrides.
  - A joint cross-venue search makes one recommendation per displaced series-window, with a decline/undo re-offer chain.
  - An adapter turns database rows into repair input, and the repair result into the `persist_practice_schedule` payload.
  - A read-only, admin-only repair recommendation panel opens from the field retirement dialog and the blackout editor.
  - The repair avoids ground that existing blackouts and retirements already close.
- **Enacting a repair recommendation, retirements only** (#505, #511, #514).
  - Migration `20261004000000` adds the `enact_practice_recommendation` wrapper. It checks that the caller is an admin, that the base fingerprint is current and that the retirement is committed, and it is idempotent. It writes a `practice.recommendation_enacted` audit row in the same transaction.
  - An admin-only Enact button opens a confirmation dialog with one checkbox per affected team, and a retired field's card gets a "Repair practices" launcher.
  - Enact is disabled, with a visible reason, in the retirement preview and for blackouts.
- **Practice readers apply saved exceptions** (#518, #521, #525, #527). Core `applyPracticeExceptions`, with a Deno twin, is applied by the readers below.
  - In the calendar feed, a moved practice appears on its relocated slot as `Practice (moved)`, and each TIME TBD date appears as an all-day tentative event. A failed exceptions read marks the feed INCOMPLETE.
  - The team portal shows "Moved from ..." and "Time TBD on ..." lines.
  - Exports state how many practices have temporary changes they do not show.
  - Migration `20261005000000` changes `upsert_team_event_rsvp` so RSVPs follow the applied calendar: allowed on moved practices, refused on TIME TBD dates.
- **Sunset and daylight model (8.9)** (#452, #459, #472, #474):
  - NOAA sunset in core, with an Edge (Deno) twin and drift controls. The corpus sunset rows for 11/07 and 11/14 were corrected per the operator's ruling.
  - A daylight provider: the date-keyed sunset table first, then the venue's coordinates, then unknown.
  - The DST end date is derived from the zone's offset change.
  - A practice daylight evaluator: an unlit or undeclared practice must end at or before sunset (margin 0, `PRACTICE_PAST_SUNSET`).
  - Duration-phase, compression and DST-survival reports. These only report; nothing is applied.
- **Venue coordinates** (#467, #470). Migration `20260930000000` adds nullable `locations.latitude` / `longitude`, with `coordinates_set_at` / `coordinates_set_by`. It also adds `admin_set_location_coordinates`, which rounds to 2 decimals and is audited as `location.coordinates_set`. Field Management gets a per-venue coordinates form, and a "No coordinates" badge on unlit or undeclared venues.
- **Daylight enforcement in scheduling** (#479, #480, #494, #495):
  - Repair candidates pass a daylight gate, with new TIME TBD reasons `past-sunset` and `sunset-unknown`.
  - An auto-scheduler post-pass truncates each new placement on unlit ground at its first date past sunset. The remainder becomes TIME TBD `past-sunset`.
  - Core adds a 10-minute shortening ladder (minimum 40 minutes) and shift-earlier proposals.
  - Migration `20261002000000` saves daylight TIME TBD windows as `practice_exceptions` on Apply.
- **Portable lighting overrides** (#499, #503, #506).
  - Migration `20261003000000` adds `practice_lighting_overrides`. An exclusion constraint forbids overlapping approved windows on a slot. Request, decide, set and withdraw RPCs are audited, and RLS lets a coach see only their own slots' rows.
  - The auto-scheduler exempts approved override dates from the daylight post-pass.
  - A new `/schedule/practice-lighting` page has a coach request form and an admin approval queue, behind `REQUEST_PRACTICE_LIGHTING_OVERRIDE` and `DECIDE_PRACTICE_LIGHTING_OVERRIDE`.
- **Lightning-class enterprise redesign** (PR #322): cobalt light + dark design system driven by CSS tokens (`data-theme`, persisted preference) with self-hosted Public Sans; new app chrome (TopBar with org/season switchers, global search, role preview; nested collapsible SideNav with role-scoped views); Excel-grade virtualized editable DataGrid powering the new `/players` workspace; tabbed player (`/players/:id`) and team (`/team/:id`) record pages absorbing the team portal; drag-and-drop Team Builder (`/teams/builder`) with serpentine signal balancing, buddy links, and coach-parent spreading; org feature configuration (player rating, years played, buddy requests, coaching interest, medical forms, waitlist) plus a division `gender_model` (gendered U8B/U8G vs co-ed) with merge/split transitions; resumable Season Setup checklist replacing the progress-wiping wizard; role-scoped Home dashboards (admin/coach/parent); new Scores, Blackouts, Members, and Exports pages.
- Added player roster schema fields (`rating` 1–5 with `skill_tier` backfill, `years_played`, `jersey_number`, `paid`, `waiver_received`, `medical_form_received`, `waitlist` status) with audited admin mutation RPCs (`admin_update_player`, bulk/create/delete, `coach_update_player_compliance`) and expanded GotSport import mapping (years played, payment status, waitlist, guardian contacts, gendered division derivation honoring `gender_model`). Migrations `20260611000000`–`20260611000400`, including a `team_players` → `players.team_id` sync trigger and an extended `audit_log` action whitelist.
- Added an admin-only `/coaches` review page with registered/interested status filters, program filtering, search, team assignment visibility, and source-player context for player-import coach leads.
- Added admin-only coach status/promotion and team coach assignment RPCs plus `/coaches` mutation controls for operationalizing volunteer leads.
- Added durable coach CSV import staging, admin-only coach apply/rollback RPCs, and `/import` rollback controls for coach imports.
- Added durable field-slot CSV import apply/rollback for locations, fields, subunits, practice slots, and game slots through the non-player import staging ledger.
- Added deferred coach/field import apply review: `/import` can validate only, mark jobs `ready_to_apply`, apply later through existing RPCs, or cancel before domain writes.
- Added heartbeat-backed stale import cleanup so interrupted `queued`/`processing`/`importing` jobs fail safely for operator retry instead of rehydrating as stuck active imports.
- Added durable player-import buddy materialization that writes reciprocal external-id or buddy-code matches into `player_buddies` with warning summaries for unmatched requests.
- Added player-import coach volunteer lead capture: finalized GotSport player imports now submit interested coach leads through `upsert_coach_leads`, atomically persist per-job lead summaries, and cover payload shaping with Vitest plus pgTAP.
- Added a current-schema `persist_game_schedule` RPC and `game_assignments` run linkage/idempotency columns to unblock org-scoped, persisted game scheduling apply flows.
- Added a current-schema `persist_team_schedule` RPC that returns the persisted run id and treats submitted roster rows as authoritative for each team in the payload.

### Changed

- `FeatureGuard` reads flags through `useFeatures`, so an absent key takes its `FEATURE_DEFAULTS` value as every other reader sees it; it read the raw stored JSONB, so a default-on feature rendered as off there only.
- The mock Supabase client refuses an RPC it has no arm for (`PGRST202`) instead of returning a silent `{ data: null, error: null }`; `admin_update_registration_medical_status`, `admin_upsert_division_settings`, `create_org_invite` and `redeem_org_invite`, the four that relied on the silent success, have arms mirroring their SQL refusals (`frontend/src/lib/mockAdminWrites.js`).
- SideNav honours a nav item's `feature` gate (`useFeatures().isEnabled`) as well as its `permission`.
- **One coach model** (#368): the coach slot is a clash-breaking order, not a role, and is no longer displayed as a role. Every coach appears on every exported artifact, and disagreements between coach sources are surfaced. The game solver now checks every coach on a team for conflicts, not only the head coach.
- **Practice writer supersedes what it replaces** (#444). Migration `20260924000000`: `persist_practice_schedule` prunes superseded rows in the same transaction. Manual rows are kept and reported, and an empty payload is refused unless explicit. Each removed row gets one `practice.superseded` audit row. Only org admins can Apply a practice schedule; for everyone else the button is disabled with a visible reason.
- **Practice lock by default** (#461, #471).
  - Migration `20260929000000` (writer v3) refuses any save that would delete, re-range or move an existing assignment unless an admin unlocks that row. Each unlock is audited as `practice.unlock_accepted`.
  - The same migration adds `practice_exceptions` for overrides and TIME TBD windows, `assigned_via`, a `base_fingerprint` that refuses stale plans, and `admin_cancel_practice_assignment`.
  - The auto-scheduler loads and locks the season's existing assignments itself. A mismatch with the client refuses with 409, audited as `scheduler.auto_refused`. An ordinary run places only roster teams that have no practice yet.
- **Games repair rule gate** (#436, #439, #441, #515, #519, #522):
  - The placer refuses a coach overlap or turnover shortfall it would introduce.
  - A coach overlap is the last resort before TIME TBD, and always warns (`RESOLVE_COACH_OVERLAP_CARRIED`).
  - Relocation proposals are judged by `resolve/` in `change-request-apply`, with up to three opt-in cross-venue options per game.
  - `evaluateCoachTravel` judges overlap over every pair of a coach's commitments.
  - A solver placement that would grow a group's coach-conflict spread is refused (`CONFLICT_SPREAD_EXCEEDED`). A requested move that grows it is allowed with `RESOLVE_CONFLICT_SPREAD_CARRIED`.
  - The gate honours the waiver ledger. `conflict-fairness` stays non-waivable.
- **School-day end** (#420, #425, #438): core practice scheduling and evaluation now refuse a `schoolDayEnd` or timezone they cannot read, instead of passing every slot or reporting no warnings. The auto-scheduler request no longer sends `schoolDayEnd`, which nothing enforced; the schema strips it.
- **CI gates and deploys** (#363, #457, #485, #486, #524):
  - A new Deno Mirror Tests job.
  - A `deploy-migrations` job applies migrations to production on push to `main`, behind `scripts/ci/migrationGuard.mjs`. A PR-time `scripts/ci/migrationVersions.mjs` check rejects malformed names, duplicate versions, versions below the base branch's latest, and edits to existing migrations.
  - `deno check` runs on every Edge entrypoint.
  - The Supabase CLI is pinned to 2.118.0.
  - The bundle gate fails rules that match no files and reads first paint from `dist/index.html`.
- **Mock Supabase client leaves the main bundle** (#488): the mock now loads lazily behind a `supabaseReady` promise, which cut the main entry from 140,447 B to 117,125 B. E2E steps wait for it through `waitForMockClient`.
- Normalized the remaining deep-relative `../../../packages/core/src/...` frontend imports to the canonical `@squadlogic/core/...` alias.
- Release hygiene: CI now uses `npm ci`, explicit docs-only diff checks, concurrency, full E2E artifacts, and a hosted full E2E path restored in PR #209.
- Release hygiene: local and CI pgTAP now use a pinned Supabase CLI, committed `supabase/config.toml`, repaired fresh migration replay, and reproducible full/single-file DB test commands from PR #211.
- Team review now stages generated teams and manual roster edits for explicit Supabase persistence instead of writing scheduler/player tables directly from routed UI controls.
- Replaced the routed game scheduling mock timer and direct assignment updates with core round-robin generation, staged review/apply/discard UI, and a game-persistence backed apply flow.
- Replaced the routed practice scheduling mock timer with the real auto-scheduler trigger, staged review/apply/discard UI, and practice-persistence backed apply flow.

### Fixed

- `WorkflowPage`'s organization panel never rendered: it sat behind `FeatureGuard` on `FEATURE_FLAGS.MULTI_TENANCY`, a key the registry never defined. The guard is gone, and `tests/featureFlagReferences.test.js` fails on any `FEATURE_FLAGS.<KEY>` the registry lacks.
- **Assistant coaches enter the practice conflict check** (#363): the core practice modules, the `auto-scheduler` Edge Function and the page's team normaliser had all considered only the head coach.
- **Field deletion and import guards** (#378, #381, #383):
  - Migration `20260907000000` gives `admin_delete_field` a booking guard and `practice_assignments.field_id` a foreign key. `admin_retire_field` now uses the shared booking enumerator and no longer retires when `p_confirm` is NULL.
  - Migration `20260908000000`: the availability import refuses a row that resolves to no field.
  - Migration `20260909000000`: `rollback_field_import_job` uses the shared booking guard instead of reading slots only.
- **Calendar feed** (#400, #449):
  - The practice recurrence loop never terminated on a PostgREST `daterange`, which hung the feed for every team with practices.
  - Games carried a `NaN` DTSTART.
  - The feed silently used `America/New_York`. It now reads the season timezone and refuses rather than default.
  - Practice readers (feed, portal, player record, `usePracticeAssignments`) now hint `practice_slots!practice_slot_id` and no longer fail with PGRST201.
  - A failed read shows as INCOMPLETE or an alert instead of an empty schedule.
- **Workflow dashboard** (#402, #407, #411, #427):
  - The practice status no longer reads "Unscheduled" over a scheduled season.
  - Run timestamps come from the run's `completed_at` and render on the viewer's clock.
  - Practice runs now save the summary the practice readiness panel reads, and an empty roster no longer reports a falsely perfect result.
  - The game, practice, exports and team-analysis pages, and `useSetupProgress`, now surface `useDashboardData` errors through a shared `DataErrorBanner`. Before, a failed load rendered as an empty season.
- **Exports** (#430, #530): a failed or in-flight read now blocks Generate and Upload, so a zero-row CSV is never shipped or recorded as a published baseline. Exports and coach email drafts read every current practice row of the season, not only the latest run's.
- **Persistence panel** (#489): each sync state (idle, submitting, ready, blocked, error) has its own label, announced through live regions. A timeout now reports an error and aborts its request.
- Fixed self-serve onboarding dead-end: new-org creators (role `admin` via `initialize_new_tenant`) were locked out of Season Setup with "Unauthorized access" because `MANAGE_GLOBAL_SETTINGS` was granted only to `tenant_admin` in the frontend, while the backend (`is_org_admin`) treats both roles as equivalent. `admin` now carries the permission — which also means an admin of a not-yet-onboarded org is taken straight to Season Setup on login (previously tenant_admin-only behavior).
- `useTeamSummary` uses `maybeSingle()` so an org/season with no scheduler runs renders the idle empty summary without the spurious 406 the previous `single()` call logged to the console.
- Adopted `fetchAllPages` at the remaining unbounded org-wide reads (players-grid data layer, co-ed transition inputs, admin Home dashboard) so they are no longer silently truncated at PostgREST's server-side row cap on large orgs.
- Bulk coach status changes now run in bounded chunks of 8 RPCs (shared `mapInChunks` helper, also adopted by the team-builder and co-ed transition fan-outs) instead of an unbounded `Promise.all`.
- The admin reporting roster export pages through teams/players with the shared `fetchAllPages` helper so large orgs are neither silently truncated at PostgREST's row cap nor fetched in one oversized request, and builds its CSV with core's `formatCsv` instead of a hand-rolled escaper.
- The storage retention workflow now also expires the `exports` bucket (timestamped schedule CSVs previously accumulated without bound) and recurses into bucket folders it previously skipped.
- Replaced the team-portal hardcoded medical-clearance display with a season-scoped, role-gated roster status RPC.
- Replaced Setup Wizard telemetry session `Math.random()` IDs with Web Crypto generation.
- Replaced mock Supabase `Math.random()` IDs and tokens with a Web Crypto helper to avoid insecure-randomness scan paths.
- Removed the team-portal calendar modal's fallback `mock-token`; missing calendar tokens now require regeneration before sharing or copying.
- Removed the artificial CSV generation delay and added explicit button metadata to output-generation controls.
- Reduced team summary polling so completed or absent scheduler runs stop re-querying while active runs still refresh.
- Added explicit button metadata, decorative icon hiding, and Home/End keyboard navigation to Organization Settings tabs.
- Made branding logo upload, detected-color actions, and base theme choices keyboard-accessible with explicit labels and pressed state.
- Added tab semantics and arrow-key navigation to General Settings section switching.
- Added pressed-state semantics to season-format and season quick-select controls in settings.
- Exposed settings feature-flag controls as named switches with checked state and descriptions.
- Added explicit labels, button metadata, and progress semantics to the import ingestion overlay.
- Added tab semantics, explicit field labels, and focus-visible delete controls to the settings schema builder.
- Added pressed state to import column-mapping mode controls and explicit labels to mapping selects.
- Added explicit labels, pressed state, and button metadata to practice assignment lock controls.
- Made game schedule invalid drop-target reasons keyboard focusable and screen-reader described instead of hover-only.
- Made import file-picker and completion notification controls keyboard focusable with explicit screen-reader labels and pressed/checkbox state.
- Made import smart-mapping confidence tooltips keyboard focusable and screen-reader described instead of hover-only.

### Removed

- Removed the direct-insert practice writer `persistPracticeAssignments`, and added a source guard against any direct write to `practice_assignments` (#481). Also removed the orphaned `PracticePersistencePanel` and `GamePersistencePanel` (#482).
- Migration `20261001000000` drops `coaches.preferred_practice_days` and `preferred_practice_window`; it refuses if any coach still holds a value. The Edge `unavailableSlotIds` preference path is retired; approved `coach_practice_preferences` replace both (#477).
- Removed dead client-side persistence modules from `@squadlogic/core` (`evaluationPersistence`, the team/game/practice `*PersistenceEdgeHandler` factories, and `teamPersistenceEdgeConfig`) — evaluation persistence goes through the `persist_evaluation_run` RPC and the deployed Deno Edge Functions carry their own self-contained handlers; dropped their orphaned tests and the unused `getSignedUrl`, `DEFAULT_AGE_CUTOFF_MODE`, and `SCHEDULING` exports.
- Removed unreferenced development scripts (`benchmark_phase_5/6`, `benchmark_teaming_weighted`, `clear-remote-storage`, `lint-node-check`, `verify_security_e2e`) — none were wired into `package.json`, CI, or docs.
- Removed tracked Supabase CLI temp metadata from `supabase/.temp/`; the directory was already ignored and should remain local-only.
- Removed the legacy `current_user_role()` helper after confirming current RLS/RPC code uses org-scoped auth helpers.
- Removed the legacy four-argument `persist_evaluation_run` RPC overload, leaving the JSONB evaluation persistence contract used by Edge Functions.
- Removed an unused direct `practice_assignments` update helper from the practice assignments hook.

### Documentation

- `docs/architecture/heat-forecast.md` (new); `data-modeling.md` now carries the venue coordinates (`latitude`/`longitude`, `coordinates_set_at/by`, `20260930000000`), `effective_to` on `locations`/`fields`/`field_subunits`, and `organization_heat_settings`; RPC inventory, RLS catalogue, routes table and ROADMAP open items updated.
- Added the Phase 8 plans of record: `PHASE_8_PLAN.md` (#358); `PHASE_8_6_PR3B_PLAN.md` and `PHASE_8_9_PLAN.md` (#451); `PHASE_8_9_D14_PLAN.md` (#493); `PHASE_8_6_PR11_ENACT_PLAN.md` (#502); `PLAN_60_62_GATE_GAPS.md` (#513); and `PHASE_8_6_PR12_READERS_PLAN.md` (#516).
- Added `docs/PHASE_8_PROGRESS.md`, the per-task Phase 8 progress log, opened in #360 and updated after each merge. Also corrected and extended `BUILD_PLAN_STATUS.md` and `MODEL_GAPS.md` (#394, #401, #415), and recorded the 2026-09-29 operator rulings plus the Deno job in CLAUDE.md §11 (#491). Added `docs/operations/migration-ledger-normalisation.md`, the production ledger re-key executed on 2026-09-28 (#457), and `docs/testing/test-timeouts.md`, the measured per-test timeout rule (#476).
- Added the Edge Function budget runbook covering cost, dependency, logging, rate-limit, and review guardrails.
- Recorded live Supabase advisor evidence in release prep: production currently has WARN-level security advisor findings that must be remediated or accepted before final release sign-off.
- Refreshed release-prep and architecture evidence after the latest RPC cleanup PRs, including current `main`, migration inventory, pgTAP inventory, branch-protection evidence, and Vercel preview/production deployment distinctions.
- Clarified that GotSport CSV import validation, durable player promotion, coach CSV, field-slot, buddy-pair materialization, and player-import coach lead capture are shipped, while team import promotion remains pending v1.1 work.
- Added release-prep closure documentation covering current Vercel evidence, Node runtime drift, Lighthouse/performance deferrals, cleanup secrets, Sentry verification, and final sign-off blockers.
- Added durable GotSport player-import staging and admin-only finalize promotion into `players`, with pgTAP coverage and rollback/smoke SQL.

### Security

- CSP `connect-src` adds `https://api.weather.gov` (exact host) for the heat forecast, with the security review in `docs/security/csp.md`; verified live in Chromium under the production policy (refused before, allowed after). `tests/cspPolicy.test.js` holds `vercel.json` and the document to the same `connect-src` set.
- Migration `20260928000000` reconciles production RLS drift to the repo's policy set. Broad member `FOR ALL` policies are replaced with member-read policies. Member-write holes on `practice_slots`, `field_subunits` and `scheduler_runs` are closed. A catalogue-wide assertion fails if any `public` write policy can be satisfied by a plain member without an allowlisted reason (#454).
- The practice persistence Edge Function calls `persist_practice_schedule` as the calling user, not as the service role, so the RPC's admin check applies and live saves reach the audit log (#444).
- Pseudonymised opposing-club and town names that the corpus leak audit missed, and added a corpus vocabulary guard test (`tests/season2026CorpusVocabulary.test.js`) (#366).
- Cleared the npm audit / Dependabot findings (react-router 7 turbo-stream RCE + open-redirect/DoS advisories, brace-expansion DoS) via in-range dependency bumps.
- Migration `20260614000000`: pinned `search_path = public` on the 16 advisor-flagged functions that can carry it, re-ran the property-based anon/PUBLIC EXECUTE revoke for SECURITY DEFINER functions created since `20260603120000`, and changed default privileges so new functions in `public` no longer inherit PUBLIC/anon EXECUTE (authenticated + service_role retained). Remaining advisor warnings are documented exceptions: `submit_registration` (public registration links), the `min(uuid)` aggregate (cannot carry a SET clause; its SFUNC is pinned), and leaked-password protection (Pro-plan-only — see `docs/operations/leaked-password-protection.md`).
- Added shared per-user rate limiting to the `fairness-scoring` Edge Function.
- Routed organization invite revocation through an org-admin `revoke_org_invite` RPC with audit logging and removed the direct invite DELETE policy.
- Routed settings schema-builder saves through an org-admin `admin_upsert_organization_schema` RPC with validation and audit logging, leaving `organization_schemas` read-only for org members.
- Routed team-generation division rule saves through an org-admin RPC with atomic `settings.updated` audit logging instead of direct browser writes to `divisions`.
- Routed registration-form creation through an org-admin RPC with atomic `registration.form_created` audit logging instead of direct browser writes to `registration_forms`.
- Routed league standings score entry through an org-scoped schedule-manager RPC with atomic audit logging instead of direct browser writes to `games`.
- Routed admin compliance medical-clearance updates through an org-admin RPC with atomic audit logging instead of direct browser writes to `registrations`.
- Routed setup wizard telemetry writes through the org-scoped `log_telemetry_event` RPC.
- Linked persisted practice assignment rows to their scheduler run id so practice schedules can reload by the latest org-scoped run after apply.
- Hardened the game persistence Edge Function so service-role RPC calls are scoped to the requested organization, season, and assignment teams before writing.
- Hardened team persistence so service-role RPC calls require one resolved target organization and an org-admin caller before writing roster state.
- Routed coach status and team head-coach changes through org-admin RPCs with audit logging and cross-org rejection instead of direct table writes.
- Repaired `persist_practice_schedule` for the current UUID scheduler schema with org-scoped run persistence, cross-org assignment rejection, idempotent practice assignment upserts, and pgTAP coverage.
- Scoped scheduler summary reads to the active organization and season, and guarded team/practice/game routes plus edit controls by view/manage permissions.
- Hardened `upsert_coach_leads` and `coach_interested_programs` so security-definer lead capture rejects division/player references outside the lead organization.
- Routed field-management location/field mutations through org-admin facility RPCs with audit logging, leaving facility tables read-only to org members.
- Routed team portal RSVP and chat message writes through org-scoped RPCs with participant checks and metadata-only audit logging, removing direct browser write policies for `event_rsvps` and `team_messages`.
- Routed browser-driven import job creation, progress, and failure writes through org-admin RPCs with audit logging, removing the broad member-write `import_jobs` policy.

## [1.0.1] - 2026-04-23

### Added

- Wave 3a: Shared test factories under `tests/factories/**` (`audit`, `organization`, `player`, `run`, `scheduling`, `season`, `team`, `user`) for deterministic test data seeding. (#188)
- Wave 6a: Bundle-budget CI gate (`npm run check:bundle`, `scripts/check-bundle-size.js`, `config/bundle-budget.json`) and advisor-lint CI gate (`npm run check:advisors`, `scripts/advisor-lint.js`); wired into `.github/workflows/ci.yml`. (#173)
- Wave 6b: 15 hot-path database indexes covering org-scoped queries on `scheduler_runs`, `event_rsvps`, `team_players`, `import_jobs`, `games`, and 8 multi-tenancy tables (`divisions`, `teams`, `players`, `coaches`, `locations`, `fields`, `field_subunits`, `practice_slots`). Migration `20260421005642_add_free_tier_indexes.sql`. (#174)
- Wave 7b: `docs/security/csp.md` documenting the full Content Security Policy, Sentry ingest + Supabase wildcard additions to `connect-src`, waivers for `style-src 'unsafe-inline'` (Tailwind 4 compatibility), and a nonce-based tightening follow-up plan. (#175)

### Changed

- Wave 1b: Repo-wide trivial sweep — removed dead `expect` imports from 19 vitest files, underscore-prefixed unused locals/args across ~25 files, and applied 8 accessibility attribute fixes (`type=button`, `htmlFor`, `aria-label`, `aria-required`, screenReaderInstructions). Lint baseline collapsed from 66 warnings to 4. (#173)
- Wave 2: Flipped `vercel.json` CSP header from `Content-Security-Policy-Report-Only` to enforcing (also added `object-src 'none'` and `upgrade-insecure-requests`); switched `public.import_efficiency_metrics` view to `SECURITY INVOKER`; scoped the `raw-imports` storage bucket to private with org-member path-prefix RLS; pinned `search_path` on 7 `ALTER FUNCTION` statements across 6 definer functions (including both `persist_evaluation_run` overloads). (#157, #173)
- Main: `frontend/src/components/ImportPanel.jsx` and `frontend/src/components/ui/Button.jsx` type-narrowed to unblock `main` CI after PRs #184, #185, #186, and #187. Extracted shared `ImportType` typedef and froze the constant set. (#189)

### Fixed

- Wave 3a: `makeAuthSession` no longer returns a pre-expired session; the `user` subobject now shallow-merges under partial overrides so test callers can override without clobbering defaults. (#188)
- Main: Pre-existing TypeScript errors in `frontend/src/components/ImportPanel.jsx:517,623`; narrowed `importType` union and documented the `Button` `title` prop. (#189)

### Security

- Wave 2: Closed the repo-owned NEXT_SESSION_PLAN §1–§3 Supabase security advisor findings for `import_efficiency_metrics`, public `raw-imports`, and mutable `search_path` on 6 definer functions. Operator runbooks shipped at `docs/operations/sentry-smoke.md` and `docs/operations/leaked-password-protection.md`; production Sentry/leaked-password dashboard verification remains operator-owned. Dependabot prod-clean; vitest/vite dev-only finding waived in `docs/security/dependabot-waivers.md`. (#173)
- Wave 6a: Advisor-lint CI gate now blocks PRs that introduce `SECURITY DEFINER` without pinned `search_path`, `CREATE VIEW` without `security_invoker` on RLS-sensitive migrations, `CREATE TABLE` without RLS, `USING/WITH CHECK (true)` policies, or suspicious `VITE_*SECRET*` env keys. Corrective migration `20260421002500_lock_search_path_remaining_definers.sql` pinned `search_path` on 4 additional definer functions (`is_org_admin`, `is_org_member`, `handle_field_subunits`, `prune_old_audit_logs`) and flipped `coach_team_map` view to `security_invoker = on`. (#173)
- Wave 7b: Hardened CSP `connect-src` with the Sentry ingest domain and the Supabase project wildcard; documented policy + waivers in `docs/security/csp.md`. Production response headers verified live. (#175)

## [1.0.0] - 2026-03-10

### Added

- Initial v1.0 MVP: team generation, practice scheduling, game scheduling, roster management, CSV import pipeline, team portal, admin compliance dashboard, calendar feeds, league standings.
- Deep Space Glass design system with four themes (`dark`, `light`, `party`, `club`).
- Supabase multi-tenancy with RLS across the core domain tables.
- Playwright-BDD E2E suite (63/63 passing post-Epic 19 Phase 3 cutover).
- Sentry error monitoring + BetterStack/Logtail Edge Function logging.
- Maintenance-mode overlay + OfflineGuard.

The full build-out chronology is preserved in git history; durable lessons live in [`docs/LESSONS_LEARNED.md`](docs/LESSONS_LEARNED.md).
