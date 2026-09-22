# Changelog

All notable changes to SquadLogic are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- CI now runs on Node 24 (parity with the Vercel production runtime, which has reported Node `24.x` since the 2026-05-02 release-prep check) and all GitHub Actions are on their Node 24-native majors (`checkout@v5`, `setup-node@v5`, `upload-artifact@v6`, `supabase/setup-cli@v2`), ahead of the June 16 2026 runner default switch.
- Refreshed all in-range npm dependencies (`npm update`): notably `@supabase/supabase-js` 2.108, `@playwright/test` 1.60, Tailwind 4.3, zod 4.4, React 19.2.7, Sentry 10.57. Major bumps (`vite` 8, `eslint` 10, `typescript` 6, `jsdom` 29, `@vitejs/plugin-react` 6, `lucide-react` 1.x) deliberately deferred to a dedicated upgrade PR, and `eslint-plugin-react-hooks` is pinned at 7.0.1 — its 7.1 minor enables new rules (`set-state-in-effect`, `preserve-manual-memoization`) that flag 63 pre-existing patterns and deserve their own refactor pass.
- Normalized the remaining deep-relative `../../../packages/core/src/...` frontend imports to the canonical `@squadlogic/core/...` alias.
- Release hygiene: CI now uses `npm ci`, explicit docs-only diff checks, concurrency, full E2E artifacts, and a hosted full E2E path restored in PR #209.
- Release hygiene: local and CI pgTAP now use a pinned Supabase CLI, committed `supabase/config.toml`, repaired fresh migration replay, and reproducible full/single-file DB test commands from PR #211.
- Team review now stages generated teams and manual roster edits for explicit Supabase persistence instead of writing scheduler/player tables directly from routed UI controls.
- Replaced the routed game scheduling mock timer and direct assignment updates with core round-robin generation, staged review/apply/discard UI, and a game-persistence backed apply flow.
- Replaced the routed practice scheduling mock timer with the real auto-scheduler trigger, staged review/apply/discard UI, and practice-persistence backed apply flow.

### Fixed

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

- Removed dead client-side persistence modules from `@squadlogic/core` (`evaluationPersistence`, the team/game/practice `*PersistenceEdgeHandler` factories, and `teamPersistenceEdgeConfig`) — evaluation persistence goes through the `persist_evaluation_run` RPC and the deployed Deno Edge Functions carry their own self-contained handlers; dropped their orphaned tests and the unused `getSignedUrl`, `DEFAULT_AGE_CUTOFF_MODE`, and `SCHEDULING` exports.
- Removed unreferenced development scripts (`benchmark_phase_5/6`, `benchmark_teaming_weighted`, `clear-remote-storage`, `lint-node-check`, `verify_security_e2e`) — none were wired into `package.json`, CI, or docs.
- Removed tracked Supabase CLI temp metadata from `supabase/.temp/`; the directory was already ignored and should remain local-only.
- Removed the legacy `current_user_role()` helper after confirming current RLS/RPC code uses org-scoped auth helpers.
- Removed the legacy four-argument `persist_evaluation_run` RPC overload, leaving the JSONB evaluation persistence contract used by Edge Functions.
- Removed an unused direct `practice_assignments` update helper from the practice assignments hook.

### Documentation

- Added the Edge Function budget runbook covering cost, dependency, logging, rate-limit, and review guardrails.
- Recorded live Supabase advisor evidence in release prep: production currently has WARN-level security advisor findings that must be remediated or accepted before final release sign-off.
- Refreshed release-prep and architecture evidence after the latest RPC cleanup PRs, including current `main`, migration inventory, pgTAP inventory, branch-protection evidence, and Vercel preview/production deployment distinctions.
- Clarified that GotSport CSV import validation, durable player promotion, coach CSV, field-slot, buddy-pair materialization, and player-import coach lead capture are shipped, while team import promotion remains pending v1.1 work.
- Added release-prep closure documentation covering current Vercel evidence, Node runtime drift, Lighthouse/performance deferrals, cleanup secrets, Sentry verification, and final sign-off blockers.
- Added durable GotSport player-import staging and admin-only finalize promotion into `players`, with pgTAP coverage and rollback/smoke SQL.

### Security

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
