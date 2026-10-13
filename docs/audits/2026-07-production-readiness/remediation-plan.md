# SquadLogic Remediation Plan — July 2026 Production Readiness Audit

**Companion to:** [`docs/audits/2026-07-production-readiness/audit.md`](./audit.md)
**Repo:** `D:\SquadLogic\SquadLogic`, main branch, HEAD `1dccab7` (PR #330, 2026-06-12)
**Scope:** Gap analysis and remediation sequencing only. No rewrite, no TypeScript conversion, no ORM/auth/framework swap, no monorepo retooling. No item in this plan proposes payments/billing collection, CMS/public-site hosting, sensitive-document file uploads, e-commerce, sponsor CRM, or an AI assistant/chatbot — the CLAUDE.md §2 hard exclusions are not touched anywhere below.

**Status:** SUPERSEDED on 2026-10-13 by the October plan,
[`../2026-10-production-readiness/remediation-plan.md`](../2026-10-production-readiness/remediation-plan.md).
This plan was never closed item by item; the table below gives every item its disposition as of
`main` at `64bd751` (2026-10-13), each checked against the code then (*statically reviewed*
unless a cell says otherwise; the PB-1 to PB-4 fixes were also applied and smoke-tested by the
migration harness, per the October audit). "Oct x.y" is the October audit's finding; an item
still open there is tracked by that finding's plan item. The 37 items cover the July audit's 38
findings (DS-12 also closes the `sentry-smoke.md` release-tag finding).

| Item | Disposition |
| --- | --- |
| PB-1 | Closed in #333 (`20260726000000_drop_stale_broad_write_policies.sql`) |
| PB-2 | Closed in #333 (`20260726000100_fix_organizations_write_policy.sql`) |
| PB-3 | Closed in #333 (`20260726000200_record_audit_event_authz.sql`) |
| PB-4 | Closed in #333 (`20260726000300_finalize_import_reimport_coalesce.sql`) |
| DS-1 | Open: Oct 4.1 (deferred, with reason). Four of the ten were added after the revert/smoke convention began and still have no scripts; see the October plan's "Discovered during execution" |
| DS-2 | Open: Oct 2.3 (M4.4) |
| DS-3 | Open: Oct 8.1 (M2.1) |
| DS-4 | Open, not carried by the October audit: `escapeCsvValue` still quotes only `"`, `,`, CR and LF |
| DS-5 | Open, not carried by the October audit: `submit_registration` has no throttle |
| DS-6 | Closed in #551 (a failed evaluation now renders "The evaluation failed, so nothing was checked") |
| DS-7 | Open: Oct 5.2 (M2.5) |
| DS-8 | Closed in #553 for failures: every Edge Function is wrapped in `withFailureLogging` (BetterStack); the residual gaps are in the October plan (PR 1-C) |
| DS-9 | Open, not carried by the October audit: `TopBar` still swallows `impersonateUser` failures and `AdminComplianceDashboard` leaves them unhandled |
| DS-10 | Closed in #553 (`logger.setUser` from `AuthContext` and `OrganizationContext`) |
| DS-11 | Closed in #553 with DS-8 (function, request and organization IDs on every failure log) |
| DS-12 | Closed in #545 (`release` from `VITE_APP_VERSION`, defined in `vite.config.js`) |
| DS-13 | Closed in #553 (the failure log carries the request and organization IDs) |
| DS-14 | Open, not carried by the October audit: `dashboardCache` is still used only by its own test |
| DS-15 | Open, not carried by the October audit: both dashboards still await their queries in sequence |
| DS-16 | Closed in #488 (the mock client left the main bundle) |
| DS-17 | Open: Oct 11.1 (M4.2) |
| DS-18 | Open: Oct 11.2 (M4.3) |
| DD-1 | Open, not carried by the October audit: `frontend-architecture.md` still lists `/compliance`, `/reporting` and `/registration/:formId`; `AdminReportingDashboard.jsx` is still unrouted (baselined in `knip.jsonc`) |
| DD-2 | Open, not carried by the October audit: `03_ROADMAP.md` still lists division team-size configuration as backlog |
| DD-3 | Open, not carried by the October audit: `data-modeling.md` and `team-generation.md` unchanged |
| DD-4 | Open, not carried by the October audit: `persistence-rpc-layer.md` still lacks the `20260613*` RPCs |
| DD-5 | Open, not carried by the October audit: `v1.1-planning.md` still quotes the old M2.2 wording |
| DD-6 | Closed by M5.1 (Oct 12.3): `AGENTS.md` §10 names `VITE_SUPABASE_PERSISTENCE_URL` |
| DD-7 | Open, not carried by the October audit: `ENVIRONMENT.md` still omits the `VITE_TEST_*` variables |
| DD-8 | Closed in #553 (`sentry-smoke.md` sets the flag instead of calling it) |
| DD-9 | Open, not carried by the October audit: `playwright.config.ts` still loads only `.env` |
| TG-1 | Open: Oct 6.1 (M3.1) |
| TG-2 | Open: Oct 6.6 and 13.3 (M4.6) |
| TG-3 | Open, not carried by the October audit: no scenario for DST-boundary splitting, rainout acknowledgement or a late registrant on a locked roster |
| TG-4 | Open within Oct 6.1 (M3.1): the 20,000 ms coverage-mode budget is unchanged; M3.1's coverage run passed on `565e980` |
| TG-5 | Open: Oct 6.4 (M4.1) |
| TG-6 | Open: Oct 6.4 (M4.1) |

The items marked "not carried" are listed in the October plan's "Discovered during execution"
for the owner to place.

## How to read this plan

Every remediation item lists: **Gap**, **Fix approach**, **Files touched**, **Effort** (S/M/L), the **exact verification command(s)** that prove the fix, and whether it is a **minimal-diff fix** (small, low-blast-radius, reviewable in the normal PR flow) or a **flagged refactor** (larger blast radius — call it out for separate design sign-off before starting). Items are numbered `<section-prefix>-<n>` and referenced by that ID from the Milestones table at the end.

Sections are ordered: (1) Production blockers, (2) Data integrity, security & reliability, (3) Docs-drift corrections, (4) Testing gaps, (5) v1.1 completeness, (6) Polish. Every one of the 38 findings in `audit.md` is addressed exactly once below (a small number are cross-referenced from a second section when one code fix closes two symptoms — those are marked "resolved by").

---

## 1. Production Blockers

These four items either (a) let an authenticated user bypass an explicit governance-framework mandate *today*, with no additional access required beyond a normal login, or (b) silently destroy admin-entered production data through a workflow the project itself documents as safe. All four are elevated to **blocker** severity in this plan even though `audit.md` capped them at "high" — the audit's own evidence for each meets the blocker bar ("breaks production or violates a hard governance mandate right now") defined for this remediation pass. All four ship together in **Milestone 1**.

### PB-1 — Stale broad write policies let any org member bypass the admin-RPC gate on locations, coaches, and teams

- **Gap:** `supabase/migrations/20260310000002_unified_rls_schema.sql:45,69,77` created `"Unified org access on teams/coaches/locations"` policies (`FOR ALL ... USING (is_org_member(organization_id))`) that were never dropped when later migrations (`20260503050000_coach_admin_mutations.sql`, `20260613000003_schedule_team_delete_rpcs.sql`, `20260613000000_coach_delete_rpc.sql`, `20260613000004_team_update_rpc.sql`, `20260504060000_admin_facility_mutation_rpcs.sql`) moved writes to admin-gated, audit-logged RPCs. `20260504060000_admin_facility_mutation_rpcs.sql:11` drops `"Strict org access on locations"`, a policy name already renamed away in `20260310000002`, so the drop is a no-op and the real live policy survives. Net effect: any authenticated org member (player/parent/coach role, not just admin) can `supabase.from('coaches').update(...)`/`.delete()` directly and it succeeds — bypassing `is_org_admin()` and the `record_audit_event()` call the intended RPC path performs. `fields` went through a different rename lineage and is **not** affected.
- **Fix approach:** New migration that `DROP POLICY IF EXISTS "Unified org access on teams/coaches/locations"` and replaces each with the SELECT-only `"... members access"` pattern already used elsewhere in the schema (`20260331000000_definitive_schema.sql:1007,1027,1037`), leaving INSERT/UPDATE/DELETE ungranted at the RLS layer — the SECURITY DEFINER RPCs don't need a row-level write policy since they run with elevated privilege and do their own `is_org_admin()` check.
- **Files touched:** new `supabase/migrations/2026MMDDHHMMSS_drop_stale_broad_write_policies.sql`; matching `docs/sql/<ts>_revert.sql` + `docs/sql/<ts>_smoke.sql`.
- **Effort:** M
- **Verification:** No vitest coverage is possible here (LESSONS_LEARNED #4 — RLS/CHECK behavior only exists in the real database). Apply the migration locally (`supabase db reset` or the Supabase MCP `apply_migration`), run the new smoke script asserting a non-admin authenticated role's direct `update`/`insert`/`delete` on `locations`/`coaches`/`teams` now fails with an RLS denial, then run the full local sequence as a regression guard: `npm run lint && npm run typecheck && npm run test && npm run frontend:build && npm run check:advisors && npm run check:bundle`.
- **Diff type:** minimal-diff fix (one migration + revert/smoke; no application code changes since the app never wrote these tables directly to begin with — confirmed via grep, no `frontend/src` call sites exist).

### PB-2 — `organizations` table write policy trusts an unvalidated JWT claim instead of org membership

- **Gap:** `supabase/migrations/20251214000003_organizations_schema.sql:30-34` is the *only* INSERT/UPDATE/DELETE policy ever created on `organizations` (the tenant root — everything else cascades from `organizations.id`): `USING (auth.jwt() -> 'app_metadata' ->> 'role' = 'admin')`, with no `organization_id`/`is_org_admin()` check at all. Every sibling "Admins can manage X" JWT-role policy in the schema was explicitly dropped by a later migration; this one was not (confirmed by repo-wide search and by `supabase/migrations/20260416000000_security_hardening.sql`'s remediation-target table array, which excludes `organizations`). `docs/architecture/multi_tenancy.md` states "there is no cross-org data access even for admin users" — this policy contradicts that for the one table where it would matter most. Mitigating factor: nothing in the codebase currently *writes* `app_metadata.role` (only reads it as a fallback), so the claim is NULL for every real user today — but it is directly settable through Supabase's own supported Auth Admin API/Studio "Edit user" UI without any custom exploit, so it is a live latent cross-tenant takeover surface, not a theoretical one.
- **Fix approach:** New migration that drops `"Admins can manage organizations"` and replaces it with an `organization_members`-scoped policy consistent with the rest of the schema, e.g. `USING (is_org_admin(id))` (using the table's own `id`, since `organizations` is the tenant root and has no `organization_id` column).
- **Files touched:** new `supabase/migrations/2026MMDDHHMMSS_fix_organizations_write_policy.sql`; matching `docs/sql/<ts>_revert.sql` + `docs/sql/<ts>_smoke.sql`.
- **Effort:** S
- **Verification:** Real-DB smoke script asserting (a) an `is_org_admin()`-true member of org A can still update org A, (b) the same member cannot update org B, (c) a non-admin member of org A cannot update org A. Then the full local sequence per PB-1.
- **Diff type:** minimal-diff fix.

### PB-3 — `record_audit_event`, the sole write path into the audit log, performs no authorization check

- **Gap:** `public.record_audit_event` (`supabase/migrations/20260331000000_definitive_schema.sql:915-946`, originally `20260324000004_audit_log.sql:60-91`) is `SECURITY DEFINER`, granted to `authenticated`, and does a bare `INSERT` using `auth.uid()` for `user_id` — it never calls `is_org_member()`/`is_org_admin()` on the caller-supplied `p_organization_id`, and never checks that `p_action`/`p_resource_type` correspond to anything the caller actually did. It is called directly from browser code in 12+ places (`frontend/src/contexts/AuthContext.jsx:170,198,220`, `frontend/src/hooks/useCoedTransition.js:91,116`, `frontend/src/pages/TeamBuilderPage.jsx:139`, `frontend/src/components/settings/FeatureFlagSettings.jsx:98`, `frontend/src/components/settings/modules/AccountModule.jsx:35`, `SeasonModule.jsx:28,58,102,162`). Any authenticated user can run `supabase.rpc('record_audit_event', { p_organization_id: '<any-org-uuid>', p_action: '<any-whitelisted-action>', ... })` from devtools and write a permanent, convincing fake entry into a different organization's append-only compliance history — a direct breach of governance mandate #4 (audit immutability) that is exploitable today with no privilege beyond a valid login.
- **Fix approach:** Replace the function (per LESSONS_LEARNED — migrations replace RPCs wholesale, they don't `ALTER`) to add `IF NOT is_org_member(p_organization_id) THEN RAISE EXCEPTION ... END IF;` before the insert, closing the cross-org fabrication path. As a second, low-cost hardening step, gate the small set of admin-only actions already known to be audited from the client (the `impersonation.*` family) behind `is_org_admin()` inside the same function, since `AuthContext.jsx:192`'s `if (user?.profile?.role !== 'admin')` is currently a client-only gate with no server-side backstop (governance mandate #6 — "session integrity, UI gating never the only gate").
- **Files touched:** new `supabase/migrations/2026MMDDHHMMSS_record_audit_event_authz.sql` (function replacement only — no call-site changes needed, the signature is unchanged); matching `docs/sql/<ts>_revert.sql` + `docs/sql/<ts>_smoke.sql`.
- **Effort:** M
- **Verification:** Real-DB smoke script: authenticated user of org A calling `record_audit_event(p_organization_id => org_B_id, ...)` must now raise; a non-admin user calling it with `p_action => 'impersonation.started'` must now raise. Then the full local sequence.
- **Diff type:** minimal-diff fix. (A fuller fix — wrapping impersonation start/stop in a dedicated `admin_start_impersonation` RPC so the audit write and the authz check are atomic — is a legitimate follow-on but is a **flagged refactor**, not required to close the blocker; note it as a candidate for a later, separately-scoped PR rather than bundling it into Milestone 1.)

### PB-4 — Re-importing a GotSport CSV silently wipes guardian contacts and coaching-interest flags on existing players

- **Gap:** In `finalize_import_job`'s existing-player `UPDATE` (`supabase/migrations/20260611000200_import_gotsport_expanded_mapping.sql:409-448`), `years_played`/`paid` are correctly `COALESCE(de.field, p.field)` (lines 421-422), but `first_name`/`last_name`/`preferred_name`/`date_of_birth`/`grade`/`gender`/`skill_tier` (413-420) and `willing_to_coach`/`coach_volunteer`/`buddy_request`/`medical_info`/`contact_info`/`guardian_contacts`/`custom_attributes` (428-434) are unconditional `field = de.field` overwrites. `guardian_contacts` resolves to `'[]'::jsonb` and `willing_to_coach` resolves to plain `FALSE` (not `NULL`) whenever the re-imported CSV lacks those columns (lines 306-307, 316-344) — so a second/corrected GotSport export with a narrower column set silently erases admin-entered guardian contacts and coaching-interest flags for every matched player, with no error or warning. The same split (one tri-stated field, several unconditional overwrites) recurs in the coach-import finalize function: `can_coach_multiple_teams` is correctly protected (`supabase/migrations/20260503060000_coach_import_apply_rollback.sql:279-282`) while `certifications`/`contact_info`/`custom_attributes` (289,292,295) are not. `admin_update_player` (`supabase/migrations/20260611000100_player_admin_mutation_rpcs.sql:141-148`) already implements the correct field-presence-conditional pattern for the same fields — the pattern exists in the codebase, it just wasn't carried into the import-finalize path. Re-imports are an explicitly endorsed, "safe" workflow per LESSONS_LEARNED #8 ("stage, validate, then promote... makes re-imports safe") and #9 (re-import "must COALESCE rather than overwrite fields the new file doesn't carry").
- **Fix approach:** Replace `finalize_import_job` and the coach-import finalize function so every currently-unconditional field falls back to the existing row's value when the staged row's value is the "not present" sentinel for that column (`NULL` for most fields; `'[]'::jsonb` specifically for `guardian_contacts`, so use `COALESCE(NULLIF(de.guardian_contacts, '[]'::jsonb), p.guardian_contacts)`; `willing_to_coach` needs the staging layer to distinguish "column absent" from "column present and false" — mirror the `CASE`-based tri-state pattern already used for `years_played`/`paid` and in `admin_update_player`).
- **Files touched:** new `supabase/migrations/2026MMDDHHMMSS_finalize_import_reimport_coalesce.sql` (replaces `finalize_import_job`) and a matching migration replacing the coach-import finalize function; matching `docs/sql/<ts>_revert.sql` + `docs/sql/<ts>_smoke.sql`; mock-parity follow-up tracked separately as TG-6 (Milestone 3) so `frontend/src/lib/mockSupabaseClient.js`'s copy of `finalize_import_job` matches.
- **Effort:** M
- **Verification:** Real-DB smoke script: import a full CSV (sets guardian_contacts + willing_to_coach), then re-import a second CSV lacking those columns for the same players, assert the DB row still has the original values. Then the full local sequence.
- **Diff type:** minimal-diff fix.

---

## 2. Data Integrity, Security & Reliability

This section covers the remaining RLS/RPC/data-layer/security findings plus the error-handling, observability, performance, and accessibility findings — everything bearing on whether the deployed system behaves correctly and safely under real production conditions, once the four Section 1 blockers are closed. High-severity items in this section ship in **Milestone 1** alongside the blockers (per the "Milestone 1 = every blocker and high-severity finding" rule); medium items are grouped into Milestones 3, 5, and 6.

### 2.1 RLS / RPC / Data layer (non-blocker)

**DS-1 — 10 migrations since the revert/smoke convention began have no matching revert or smoke script, including the flagship RLS-hardening migration.** *(High — Milestone 1)*

- **Gap:** Cross-checking all 100 files in `supabase/migrations/` against `docs/sql/reverts/`+`docs/sql/tests/` and the `docs/sql/` root by exact 14-digit timestamp confirms these 10 have neither: `20260421060000_coach_leads.sql`, `20260502001000_division_roster_constraints.sql`, `20260503000000_secure_coach_lead_scoping.sql`, `20260522120000_field_availability_phase1.sql`, `20260522130000_field_availability_phase1_hardening.sql`, `20260522153000_field_availability_finalize_hardening.sql`, `20260602010000_consolidated_rls_security_hardening.sql` (274 lines; its own header says it "closes live authorization gaps" across 14 tables — exactly the kind of change that most needs a tested rollback path), `20260603190000_import_division_from_age_group.sql`, `20260612000000_min_uuid_aggregate.sql`, `20260612000001_min_uuid_aggregate_hardening.sql`. Confirmed directly: `ls docs/sql/reverts docs/sql/tests docs/sql | grep -E '<these 10 timestamps>'` returns nothing. CLAUDE.md §3 Definition of Done requires "matching revert + smoke scripts under `docs/sql/`" for every migration; LESSONS_LEARNED #11 restates it.
- **Fix approach:** Author `docs/sql/<ts>_revert.sql` + `docs/sql/<ts>_smoke.sql` for each of the 10, following the existing pattern (e.g. `docs/sql/20260611000400_revert.sql`). To prevent regression, add a small new script `scripts/check-migration-reverts.js` (a lightweight Node script in the same family as `scripts/advisor-lint.js`, not a new tool/dependency) that fails if any `supabase/migrations/<ts>_*.sql` file lacks a corresponding revert+smoke pair, wired up as a new `npm run check:migration-pairs` and added as a CI step next to `check:advisors`.
- **Files touched:** 20 new files under `docs/sql/`; new `scripts/check-migration-reverts.js`; `package.json` (new script); `.github/workflows/ci.yml` (new step).
- **Effort:** L (the field-availability trio and the 274-line RLS-hardening migration each touch 5+ tables/RPCs and need careful smoke assertions).
- **Verification:** `npm run check:migration-pairs` (new gate, exits 0); each new smoke script executed manually against a scratch DB; full local sequence.
- **Diff type:** minimal-diff fix (additive docs/tooling only — no migration content changes).

**DS-2 — Client-side Zod pre-transmission validation is dead code or entirely absent on the app's largest mutation surfaces.** *(Medium — Milestone 3)*

- **Gap:** `packages/core/src/schemas/index.js:64-75` exports `PersistencePayloadSchema` with zero call sites anywhere in `frontend/src` or `packages/core/src` — `frontend/src/utils/teamPersistenceClient.js:46-48`'s actual pre-flight check is `typeof snapshot !== 'object'`. `frontend/src/contexts/ImportContext.jsx:723-728` builds a Zod row schema (`_rowSchema`, the underscore prefix itself signaling "unused" per project convention) that is never invoked. The Players admin surface (5 RPCs per `docs/architecture/persistence-rpc-layer.md` §2.18) has no Zod schema anywhere in its call chain — `frontend/src/hooks/usePlayersData.js:62-76`, `frontend/src/pages/PlayersPage.jsx:108-134`, `frontend/src/pages/PlayerRecordPage.jsx:103-120` all pass a raw patch object straight to `supabase.rpc()`. Governance-framework.md §1 mandate 3 and CLAUDE.md §3 both require client-side Zod validation before transmission, with DB-side re-validation as the second layer — only the second layer is implemented. Not currently exploitable (every path traced has a working server-side backstop), but it is a real, systemic gap against a documented, named mandate, and `PersistencePayloadSchema` is unreachable code that can silently drift from the Edge Function's own copy of the same shape.
- **Fix approach:** Wire `PersistencePayloadSchema.safeParse()` into `teamPersistenceClient.js` before the network call (reject client-side on failure, matching the Edge Function's own schema); wire the already-built `_rowSchema` into `ImportContext.jsx`'s per-row validation loop (drop the underscore prefix once it's used); add a `PlayerPatchSchema` to `packages/core/src/schemas/index.js` mirroring `sanitize_player_patch`'s rules (rating 1-5, years_played 0-30, jersey_number 0-999, status enum, boolean fields, guardian_contacts shape/cap) and call `.safeParse()` in `usePlayersData.js`/`PlayersPage.jsx`/`PlayerRecordPage.jsx` before each RPC call.
- **Files touched:** `frontend/src/utils/teamPersistenceClient.js`; `frontend/src/contexts/ImportContext.jsx`; `packages/core/src/schemas/index.js`; `frontend/src/hooks/usePlayersData.js`; `frontend/src/pages/PlayersPage.jsx`; `frontend/src/pages/PlayerRecordPage.jsx`.
- **Effort:** M
- **Verification:** `npm run test -- tests/teamPersistenceClient.test.js tests/schemas.test.js` (new/extended cases for invalid payloads rejected client-side); full local sequence.
- **Diff type:** minimal-diff fix.

### 2.2 Dependency & application security

**DS-3 — 6 of 7 npm-audit vulnerabilities are closeable with a lockfile refresh inside the existing `package.json` semver ranges; the 7th needs a documented waiver, not a version migration.** *(High — Milestone 1)*

- **Gap:** `package.json` already declares `"react-router-dom": "^7.10.1"`, `"vite": "^7.3.2"`, `"postcss": "^8.5.13"` — ranges wide enough to admit the patched versions. `package-lock.json` is pinned to the vulnerable versions (`react-router`/`react-router-dom` 7.17.0, `vite` 7.3.2, `postcss` 8.5.13), confirmed by reading `node_modules/vite/package.json` and `node_modules/postcss/package.json` directly, not just `npm audit`'s report. `npm view` confirms 7.18.1 (react-router-dom), 7.3.6 (vite), 8.5.23 (postcss), 8.3.0 (js-yaml), 1.1.16/5.0.8 (brace-expansion) are already published and satisfy the existing ranges — a lockfile refresh, not a `package.json` edit, closes 6 of 7. `react-router-dom` is a direct production dependency, imported at `frontend/src/App.jsx:3` and mounted at `App.jsx:316`, so it ships to and executes in every visitor's browser (unlike postcss/vite/babel/js-yaml/brace-expansion, which are devDependency/build-tool-only exposure). Of the react-router CVEs closed by 7.18.1: the open-redirect advisory (backslash in `<Link>`/`useNavigate`) has no framework-mode restriction and is reachable given this app's classic `<BrowserRouter>` usage; three others (RSCErrorHandler XSS, SSR-hydration constructor injection, DoS via route matching) are scoped by their own GHSA text to Framework Mode/Data Mode/RSC applications, which this app is not (verified: no `createBrowserRouter`/`RouterProvider`/RSC anywhere in `frontend/src`) — they close as a side effect of the same version bump, not as independently-active production risks. The one remaining CVE (RSC-mode CSRF bypass, GHSA-qwww-vcr4-c8h2) is fixed only at react-router **8.3.0+** — a major-version bump.
- **What is explicitly out of scope and why:** Bumping react-router-dom to 8.x is a major-version change to the routing library this project's own ground rules name as staying as-is ("react-router-dom... stay as-is") — it is not implemented here, and should not be, regardless of the CVE. **Smallest compliant alternative:** the CSRF advisory's own scope note limits it to Framework Mode/Data Mode (RSC) applications; this app uses classic Declarative Mode (`<BrowserRouter>`, no `createBrowserRouter`, no SSR) and is therefore not reachable by it. Add a documented waiver entry to `docs/security/dependabot-waivers.md` for GHSA-qwww-vcr4-c8h2 citing non-applicability, rather than upgrading the major version.
- **Fix approach:** `npm update` (no `package.json` edits needed) to refresh `package-lock.json` to the patched versions within the existing ranges; add the one waiver entry using `dependabot-waivers.md`'s existing template.
- **Files touched:** `package-lock.json`; `docs/security/dependabot-waivers.md`.
- **Effort:** S
- **Verification:** `npm audit` reports 0 vulnerabilities except the one waived CSRF advisory; full local sequence, since a lockfile refresh can shift transitive resolution.
- **Diff type:** minimal-diff fix.

**DS-4 — The one CSV export path for player/roster data doesn't neutralize spreadsheet-formula-trigger characters.** *(Medium — Milestone 4)*

- **Gap:** `escapeCsvValue` (`packages/core/src/outputGeneration.js:271-285`), used by `formatCsv` (255-269), quotes only on `"`, `,`, `\n`, `\r` — it does not check for a leading `=`, `+`, `-`, `@`, tab, or CR (the Excel/Sheets/LibreOffice formula-trigger set). `frontend/src/pages/AdminReportingDashboard.jsx:117-174` feeds player/team/coach names (sourced from the GotSport CSV import path) into `formatCsv` and triggers a browser download for an admin to open. A CSV/Formula Injection (CWE-1236) payload in a self-entered registration name (e.g. `=HYPERLINK(...)`) passes through unchanged. Only test coverage is `tests/outputGeneration.test.js:71-96` (comma/quote/CR only).
- **Fix approach:** Extend `escapeCsvValue` to also prefix a value with a single quote (`'`) — or wrap in a formula-neutralizing quote per OWASP's CSV-injection guidance — whenever the value (after any leading whitespace) starts with `=`, `+`, `-`, `@`, tab, or CR.
- **Files touched:** `packages/core/src/outputGeneration.js`; `tests/outputGeneration.test.js` (new cases).
- **Effort:** S
- **Verification:** `npm run test -- tests/outputGeneration.test.js`; full local sequence.
- **Diff type:** minimal-diff fix.

**DS-5 — `submit_registration`, the RPC deliberately left `anon`-executable for public registration links, has no rate limiting anywhere.** *(Medium — Milestone 4)*

- **Gap:** `supabase/migrations/20260603120000_revoke_anon_execute_on_definer_functions.sql:26-28` explicitly keeps `anon` EXECUTE on `submit_registration` because "youth-sports registration forms are shared as public links." The function body (`20260602010000_consolidated_rls_security_hardening.sql:70-99`) does require `auth.uid()` + `is_org_member()`, so true anonymous calls are rejected — but nothing throttles repeat authenticated calls. The repo's only rate-limit utility, `supabase/functions/_shared/rateLimit.ts`, is used exclusively by the six Edge Functions and is architecturally inapplicable to a Postgres RPC invoked via PostgREST; `supabase/config.toml`'s `[auth.rate_limit]` governs Auth endpoints only. An authenticated org member can script unlimited repeat calls to `submit_registration` for a form they legitimately belong to, with no per-user/per-form cap — a mass-row-creation and, on the free-tier ~60-connection cap (LESSONS_LEARNED #6), availability concern.
- **Fix approach:** Add a lightweight per-user/per-form throttle inside `submit_registration` itself (e.g. a `registration_submission_log` check-and-insert with a short window, or reuse the existing rate-limit table pattern from the Edge Functions' shared utility, ported to SQL) that raises once a caller exceeds N submissions per form per minute.
- **Files touched:** new `supabase/migrations/2026MMDDHHMMSS_submit_registration_rate_limit.sql`; matching `docs/sql/<ts>_revert.sql` + `docs/sql/<ts>_smoke.sql`.
- **Effort:** M
- **Verification:** Real-DB smoke script asserting the (N+1)th rapid call from the same user/form is rejected while a normal single submission still succeeds; full local sequence.
- **Diff type:** minimal-diff fix.

### 2.3 Reliability / error handling

**DS-6 — EvaluationPanel's computed error message is unreachable on a first-load failure; the panel silently renders nothing.** *(High — Milestone 1)*

- **Gap:** `frontend/src/components/EvaluationPanel.jsx`'s effect (39-88) sets `message` to `'Engine connectivity issue. Retrying...'` in its catch block (81-85) but never actually retries. The early-return guard `if (!evaluation && !loading) return null;` (163) fires before the JSX that renders `{message && (...)}` (255-259) is ever reached, because on a first-call failure `evaluation` stays `null` and `loading` is `false` (set in the `finally` at 87). Any transient failure on the very first fairness-scoring call makes the whole panel vanish with zero feedback in the core Practice Scheduling flow (`frontend/src/pages/PracticeSchedulingPage.jsx`).
- **Fix approach:** Move the `message`-render condition ahead of the `!evaluation && !loading` guard (or track a separate `hasError` boolean that the null-guard also checks), so the computed error text renders instead of returning `null`. Either implement the actually-promised retry (e.g. one bounded retry via `withTimeout`/backoff) or change the copy to not claim a retry is happening.
- **Files touched:** `frontend/src/components/EvaluationPanel.jsx`.
- **Effort:** S
- **Verification:** `npm run test -- tests/EvaluationPanel.test.jsx` (new case: force the Edge Function call to reject, assert the error text is visible in the rendered output); full local sequence.
- **Diff type:** minimal-diff fix.

**DS-7 — Game/practice schedule "Apply" flows have no timeout or abort on their Edge Function fetch, so a hung call leaves the UI stuck in "applying" forever.** *(High — Milestone 1)*

- **Gap:** `frontend/src/utils/gamePersistenceClient.js:33-44` and `frontend/src/utils/practicePersistenceClient.js:26-37` issue raw `fetch()` calls with no `AbortController`/`signal`/timeout. Their callers (`GameSchedulingPage.jsx:558-587`, `PracticeSchedulingPage.jsx:501-544`) `await` with only a rejection-path `catch`, so a call that never resolves leaves `applyStatus` at `'applying'` indefinitely. The codebase has already fixed this exact failure mode once for `import-validation` (`ImportContext.jsx:741-759` wraps the call in `withTimeout(..., 60000, ...)`, `frontend/src/lib/withTimeout.js`) and partially for team persistence (`TeamPersistencePanel.jsx:113-116` has a UI-only pseudo-timeout that doesn't actually abort the fetch).
- **Fix approach:** Wrap the `fetch()` in `gamePersistenceClient.js` and `practicePersistenceClient.js` with the existing `withTimeout` helper (same 60s budget used for import-validation, or a smaller one appropriate to these calls) and thread an `AbortController` through so the underlying request is actually cancelled, not just reported as timed out. Apply the same `AbortController` wiring to `TeamPersistencePanel.jsx`'s existing pseudo-timeout while touching this code, since it's the same bug shape one file over.
- **Files touched:** `frontend/src/utils/gamePersistenceClient.js`; `frontend/src/utils/practicePersistenceClient.js`; `frontend/src/components/TeamPersistencePanel.jsx`.
- **Effort:** M
- **Verification:** `npm run test -- tests/gamePersistenceClient.test.js tests/practicePersistenceClient.test.js tests/TeamPersistencePanel.test.jsx` (new cases: mock a never-resolving fetch, assert the client rejects/aborts within the configured budget and the UI status leaves "applying"); full local sequence.
- **Diff type:** minimal-diff fix.

**DS-8 — BetterStack/Logtail structured logging is wired into only 1 of 7 Edge Functions, though the roadmap credits it to "Edge Functions" generally.** *(Medium — Milestone 5)*

- **Gap:** `supabase/functions/_shared/logtail.ts` defines `edgeLogger`; only `auto-scheduler/index.ts` imports it (26,486-493,742-751,773-777). `calendar-feed`, `fairness-scoring`, `game-persistence`, `import-validation`, `practice-persistence`, `team-persistence` all use bare `console.log`/`console.error` only (confirmed by reading each file in full). `docs/expansion/03_ROADMAP.md:75` (Phase 9, "Certified — Prime") overstates coverage as "for Edge Functions" without qualifying it to one function — the doc correction for this is folded into DD-5 below; the code fix is here.
- **Fix approach:** Import and call `edgeLogger` in the remaining six functions' existing `console.error`/`console.warn` call sites (a mechanical swap — the logger's call signature already matches `console.error(message, context)` usage patterns), starting with the three persistence functions and `import-validation` (highest production-triage value).
- **Files touched:** `supabase/functions/team-persistence/index.ts`; `supabase/functions/game-persistence/index.ts`; `supabase/functions/practice-persistence/index.ts`; `supabase/functions/import-validation/index.ts`; `supabase/functions/fairness-scoring/index.ts`; `supabase/functions/calendar-feed/index.ts`.
- **Effort:** M (six files, mechanical but needs care to preserve existing log content and add `flush()` calls at each function's exit paths, mirroring `auto-scheduler`'s pattern).
- **Verification:** No local unit-test harness runs Edge Functions directly in this repo's `npm run test`; verify by deploying to a scratch Supabase project and confirming `BETTERSTACK_SOURCE_TOKEN`-gated log lines appear for each function, or at minimum `npm run typecheck` (Edge Functions are typechecked) plus a manual `deno check` if available locally; full local sequence for the rest of the gate.
- **Diff type:** minimal-diff fix.

**DS-9 — Admin impersonation failures are never surfaced to the user.** *(Medium — Milestone 5)*

- **Gap:** `AuthContext.jsx:191-213`'s `impersonateUser()` re-throws on RPC failure; `TopBar.jsx:179` calls it with `.catch(() => {})` (fully swallowed); `AdminComplianceDashboard.jsx:365` calls it with no `.catch()` at all (unhandled rejection). Neither file imports `useToast`/`ToastHost`. An admin clicking "Preview as Coach/Parent" on a transient RPC failure sees the button silently do nothing.
- **Fix approach:** Import `useToast` in both call sites and show an error toast on catch, matching the pattern already used elsewhere in the admin UI for RPC failures.
- **Files touched:** `frontend/src/components/chrome/TopBar.jsx`; `frontend/src/pages/AdminComplianceDashboard.jsx`.
- **Effort:** S
- **Verification:** `npm run test -- tests/TopBar.test.jsx tests/AdminComplianceDashboard.test.jsx` (new cases: mock `impersonateUser` rejection, assert a toast/error message renders); full local sequence.
- **Diff type:** minimal-diff fix.

### 2.4 Observability

**DS-10 — Sentry events carry no user/organization identity; `logger.setUser()` is defined but never called.** *(High — Milestone 1)*

- **Gap:** `frontend/src/lib/logger.js:78-84` defines `setUser()`, documented in its own header as the mechanism to attach identity to Sentry events — but it's exported and never invoked. `AuthContext.jsx` (the only place session state changes: sign-in/out, token refresh, `applySession()` 64-101) doesn't import `logger` at all. `ErrorBoundary.jsx:47-52` sets only `tags: { boundary: 'root' }` and `extra: { componentStack }`. Once `VITE_SENTRY_DSN` is set in Vercel (a separately-tracked operator open item), every captured event will be anonymous — "what failed for user X yesterday" is unanswerable from Sentry alone.
- **Fix approach:** Call `logger.setUser({ id, email, role, organizationId })` from `AuthContext.jsx`'s `applySession()` whenever a session resolves to a user, and `logger.setUser(null)` on sign-out, mirroring the documented contract in `logger.js`'s header.
- **Files touched:** `frontend/src/contexts/AuthContext.jsx`; `frontend/src/lib/logger.js` (if the `setUser` signature needs a small extension for role/org).
- **Effort:** S
- **Verification:** `npm run test -- tests/AuthContext.test.jsx` (new case: assert `logger.setUser` is called with the resolved user on sign-in and with `null` on sign-out, via a mocked `logger`); full local sequence.
- **Diff type:** minimal-diff fix.

**DS-11 — 6 of 7 Edge Functions log via plain `console.error` with no organization/user correlation fields.** *(High — Milestone 1)*

- **Gap:** Same root cause and same fix as DS-8 (both are closed by wiring `edgeLogger` into the six non-`auto-scheduler` functions) — this instance of the finding specifically emphasizes the missing `organization_id`/`user_id` fields at each of `team-persistence/index.ts:397`, `game-persistence/index.ts:379`, `fairness-scoring/index.ts:225`, `calendar-feed/index.ts:217`, and `_shared/auth.ts:33,58,84,104,128,158-159`. `docs/architecture/edge-functions-inventory.md:120` already documents the logger as "Used by `auto-scheduler`" (singular), so the doc is accurate — this is a pure code gap, not a docs-drift item.
- **Fix approach / files / effort:** Same as DS-8 — when implementing DS-8, ensure every `edgeLogger.error(...)` call includes `{ userId, orgId, ... }` extracted the same way `auto-scheduler`'s success-path log does (see DS-14 below for the one place `auto-scheduler` itself gets this wrong).
- **Verification:** Same as DS-8.
- **Diff type:** minimal-diff fix. *(Tracked as one work package with DS-8 in Milestone 1 — do not implement twice.)*

**DS-12 — Sentry `Sentry.init()` sets no `release`; `VITE_APP_VERSION` is documented but wired nowhere.** *(Medium — Milestone 5; resolves the related doc-only symptom in DD-8)*

- **Gap:** `frontend/src/main.jsx:17-34`'s `Sentry.init()` has no `release` key. `docs/operations/sentry-smoke.md:60` already prescribes the fix ("Add `release: import.meta.env.VITE_APP_VERSION`... ensure Vercel sets `VITE_APP_VERSION` from `package.json:version`") but it was never implemented — `VITE_APP_VERSION`'s only repo occurrence is an allow-listed key name in `scripts/advisor-lint.js:192`, never assigned or read.
- **Fix approach:** Add `release: import.meta.env.VITE_APP_VERSION` to the `Sentry.init()` call; define `VITE_APP_VERSION` via Vite's `define` in `vite.config.js` sourced from `package.json`'s `version` field at build time (no new env var needs to be set in Vercel — it's derived at build time from the committed `package.json`, which is simpler and less failure-prone than relying on an operator-set Vercel env var).
- **Files touched:** `frontend/src/main.jsx`; `vite.config.js`.
- **Effort:** S
- **Verification:** `npm run frontend:build` then inspect the built bundle for the injected version string; `npm run test -- tests/main.test.js` if one exists, otherwise a smoke check per `docs/operations/sentry-smoke.md`; full local sequence.
- **Diff type:** minimal-diff fix.

**DS-13 — Auto-scheduler's own failure-path log drops the `userId`/`orgId` fields its success-path log includes.** *(Medium — Milestone 5)*

- **Gap:** `supabase/functions/auto-scheduler/index.ts:486-493`'s invocation-start log includes `userId`/`orgId`; the top-level `catch` block's failure log (773-776) does not, because `user`/`input` are scoped to the earlier `try` block. The code two lines later (780-794) re-fetches those same IDs — but only for the `audit_log` DB write, after `edgeLogger.error()`/`flush()` have already fired without them.
- **Fix approach:** Hoist `user`/`input` (or just the two IDs) to a scope visible from the `catch` block (e.g. declare `let userId, orgId;` before the `try`, assign inside it), and pass them into the existing `edgeLogger.error()` call before the re-fetch that currently only serves the audit-log write.
- **Files touched:** `supabase/functions/auto-scheduler/index.ts`.
- **Effort:** S
- **Verification:** Manual/scratch-project check that a forced failure now logs `userId`/`orgId` in the BetterStack payload; full local sequence (`typecheck` covers Edge Function TS).
- **Diff type:** minimal-diff fix.

### 2.5 Performance

**DS-14 — `dashboardCache` is exported and unit-tested but never wired into the hot dashboard-data hooks it was built for.** *(High — Milestone 1)*

- **Gap:** `frontend/src/lib/cache.js` defines `dashboardCache` (30s TTL, doc comment: "enforce the 200ms interaction ceiling") — referenced nowhere outside its own doc comment and `tests/cache.test.js:120-137`. The actual dashboard read path (`useDashboardData.js` composing `useTeamSummary.js`, `useSchedulerRun.js`, `usePracticeAssignments.js`, `useGameAssignments.js`) issues a fresh, uncached Supabase query on every mount/org-switch. `edgeFunctionCache` (a sibling cache) *is* wired, but only into two Edge Function invocations (`useAutoScheduler.js`, `EvaluationPanel.jsx`). `docs/expansion/03_ROADMAP.md:77` credits Phase 9 with delivering this for "the 200ms dashboard interaction ceiling" — the actual dashboard-summary queries never got it, generating avoidable Supabase read traffic on every navigation, working against the documented free-tier connection pressure.
- **Fix approach:** Wrap the read calls in `useTeamSummary.js`, `useSchedulerRun.js`, `usePracticeAssignments.js`, `useGameAssignments.js` with `dashboardCache`'s get/set (same pattern `cachedInvoke` already establishes for `edgeFunctionCache`), keyed by `organizationId`/`seasonId`/whatever the hook already scopes by.
- **Files touched:** `frontend/src/hooks/useTeamSummary.js`; `frontend/src/hooks/useSchedulerRun.js`; `frontend/src/hooks/usePracticeAssignments.js`; `frontend/src/hooks/useGameAssignments.js`.
- **Effort:** M
- **Verification:** `npm run test -- tests/useDashboardData.test.js tests/useTeamSummary.test.js tests/cache.test.js` (extend to assert a second call within the TTL window doesn't re-issue the Supabase query); full local sequence.
- **Diff type:** minimal-diff fix.

**DS-15 — Two admin dashboards await 3-5 independent Supabase queries strictly in sequence; one query in AdminReportingDashboard is entirely wasted.** *(Medium — Milestone 6)*

- **Gap:** `AdminReportingDashboard.jsx:38-91` awaits five mutually-independent queries back-to-back, and the `view_league_standings` query at lines 70-76 discards its own `data` and is immediately re-queried at 79-82 for the data actually used — a 100%-wasted round trip on every dashboard load. `EnterpriseDashboard.jsx:75-90` has the same serial-await pattern across three independent queries.
- **Fix approach:** Replace the sequential `await` chains with `Promise.all([...])` for the independent queries in both files; delete the redundant first `view_league_standings` query in `AdminReportingDashboard.jsx` entirely (its `data` was never used).
- **Files touched:** `frontend/src/pages/AdminReportingDashboard.jsx`; `frontend/src/pages/EnterpriseDashboard.jsx`.
- **Effort:** S
- **Verification:** `npm run test -- tests/AdminReportingDashboard.test.jsx tests/EnterpriseDashboard.test.jsx` (assert query call count drops by one for the reporting dashboard, and that all queries fire concurrently rather than serially); full local sequence.
- **Diff type:** minimal-diff fix.

**DS-16 — Main-entry bundle headroom is thinner than the blended figure suggests, and the mock-client code-split named as the reason for the current budget has not shipped.** *(Medium — Milestone 6, flagged)*

- **Gap:** `check:bundle` currently reports the main entry chunk at 130.99 KB gz against its 140 KB cap (93.6% used — `config/bundle-budget.json:5-8`) versus the blended 89.3% total-first-paint figure. The cap's own rationale names the fix: "dynamic-import the mock client and route-split chart-vendor, then tighten." `frontend/src/lib/supabaseClient.js:14` still statically imports `mockSupabaseClient.js` (~4,969 lines) into the production main-entry chunk regardless of mode, because `frontend/src/config.js:6-14` reads `import.meta.env[key]` via bracket notation, which Vite can't statically tree-shake. `docs/operations/bundle-budget.md` states bumps are meant to be a last resort after lazy-loading/replacing — here the budget was already loosened in anticipation of this exact follow-up, which hasn't landed, so the remaining ~9 KB of main-entry headroom is already earmarked, not free capacity for new work.
- **Fix approach:** Convert the mock-client import in `supabaseClient.js` to a dynamic `import()` gated behind the mock-mode check, and switch `config.js`'s env-var access to literal dot-notation (`import.meta.env.VITE_USE_MOCK_SUPABASE`) so Vite can statically branch and tree-shake the mock client out of the real-mode production bundle.
- **Files touched:** `frontend/src/lib/supabaseClient.js`; `frontend/src/config.js`.
- **Effort:** L — **flagged refactor.** Converting the app's Supabase client bootstrap from synchronous to async (dynamic import resolves asynchronously) touches every consumer that currently assumes `supabaseClient` is ready at import time; this needs a dedicated design review of the initialization sequence (loading states, provider mounting order in `App.jsx`) before implementation, not a same-PR mechanical change. Do not bundle into Milestone 1 or 6 without that sign-off; track as its own follow-on branch once scoped.
- **Verification (once scoped):** `npm run check:bundle` (main entry drops meaningfully below 140 KB cap in real mode); `npm run test:e2e` in mock mode to confirm the dynamic import still resolves correctly under Playwright; full local sequence.
- **Diff type:** flagged refactor (do not ship as part of a "polish" milestone without separate design sign-off).

### 2.6 Accessibility

**DS-17 — No automated accessibility testing exists anywhere in the pipeline, and no WCAG 2.2 AA re-certification has run since the June 2026 UI rewrite.** *(High — Milestone 1)*

- **Gap:** No `@axe-core/playwright` in `package.json`/`package-lock.json`; no `eslint-plugin-jsx-a11y` in `eslint.config.js`. The only automated a11y assertions are three hand-written Playwright steps (`tests/e2e/steps/auto_scheduler.ts:326-348`) scoped to one panel, exercised by one scenario (`tests/e2e/features/auto_scheduler.feature:79-83`). `docs/expansion/03_ROADMAP.md:114` already lists this exact gap as open engineering backlog. Governance-framework.md states WCAG 2.2 AA is "a core requirement" — since the full "Lightning-class" rewrite (PR #322), that claim has been unverified.
- **Fix approach:** Add `@axe-core/playwright` as a devDependency; add a new Playwright-BDD step (or a lightweight standalone Playwright spec outside the Gherkin suite, whichever fits the existing `tests/e2e/` layout better) that runs an axe scan against each top-level page after login, asserting zero critical/serious violations; run it once manually across the app's main pages as the "re-certification" pass this finding calls for, and file any violations found as new, separately-scoped follow-up items (not fabricated here without evidence).
- **Files touched:** `package.json`; new `tests/e2e/steps/accessibility.ts` (or equivalent); new `tests/e2e/features/accessibility.feature`.
- **Effort:** L (adding the tooling is S; running and triaging a first full-app axe pass, and fixing whatever it finds, is the larger unknown — scope the triage as a fast-follow once the scan is running, not blocked on it).
- **Verification:** `npx bddgen && npx playwright test --workers=1 --grep "Accessibility"`; full local sequence.
- **Diff type:** minimal-diff fix for the tooling addition; any violations the first scan surfaces are out-of-scope for this item and should be triaged separately once found (per the "do not guess" rule — this plan cannot enumerate a11y defects that haven't been scanned for yet).

**DS-18 — The Game Scheduling drag-and-drop grid has no non-drag alternative and doesn't use the project's own established accessible dnd-kit pattern.** *(High — Milestone 1)*

- **Gap:** `GameSchedulingPage.jsx:828`'s `<DndContext>` has no `sensors` prop (falls back to dnd-kit defaults); `GameCard.jsx:22-26,52-53` spreads raw `useDraggable` listeners with no companion move/reassign control. The only non-drag affordances on the page are "Cancel Assignment" (removes, doesn't move) and "Auto-Generate" (regenerates the whole schedule) — neither lets a user place one game into a specific field/slot without dragging. `RosterManager.jsx:184-193`, the codebase's other dnd-kit surface, already configures `PointerSensor` + `KeyboardSensor` with `sortableKeyboardCoordinates` — a working, deliberate pattern that was never carried over. LESSONS_LEARNED #16 and CLAUDE.md §9.3 both require a non-drag alternative.
- **Fix approach:** Configure `GameSchedulingPage.jsx`'s `DndContext` with the same `useSensor(PointerSensor, ...)` + `useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })` pattern used in `RosterManager.jsx`; add a "Move to..." button/menu on `GameCard.jsx` (or the grid's context menu) that opens a lightweight field/slot picker and calls the same reassignment handler `handleDragEnd` already calls, so keyboard-only and switch-device users have a working non-drag path.
- **Files touched:** `frontend/src/pages/GameSchedulingPage.jsx`; `frontend/src/components/scheduling/GameCard.jsx`.
- **Effort:** M
- **Verification:** `npm run test -- tests/GameCard.test.jsx tests/GameScheduleGrid.test.jsx` (new keyboard-interaction and "Move to..." cases, matching the format LESSONS_LEARNED #16 implies is expected); full local sequence.
- **Diff type:** minimal-diff fix.

---

## 3. Docs-Drift Corrections

All items in this section are documentation-only edits (a few pair a doc fix with a one-line config fix where the doc's instructions are currently inert). They ship together in **Milestone 2**. CI's `docs_only` change-detection (`.github/workflows/ci.yml`'s `steps.changes.outputs.docs_only`) will fast-path this milestone's PR, but the full local sequence is still run once locally per this plan's policy.

**DD-1 — `docs/architecture/frontend-architecture.md`'s route table has wrong paths, a dead-component reference, and omits several live routes including v1.1 Area D's coach-review page.** *(High — Milestone 1, not Milestone 2, because of severity)*

- **Gap:** The table (`docs/architecture/frontend-architecture.md:18-40`) lists `/compliance`, `/reporting`, `/registration/:formId` as current routes. The real routes (`frontend/src/App.jsx`) are `/admin/compliance` (241), `/register/:formId` (151); there is no `/reporting` route at all — `/admin/reports` (273) renders `EnterpriseDashboard.jsx`, while `AdminReportingDashboard.jsx` (the component the doc names) is never imported or routed anywhere and has zero test references — it's dead code the doc presents as live. The fully-built, permission-gated `/coaches` page (`CoachesPage.jsx`, `App.jsx:224-231` — v1.1 Area D's coach lead/review surface) has no entry at all.
- **Fix approach:** Rewrite the route table to match `App.jsx:217-279` exactly (path, component, guard); remove the `/reporting` → `AdminReportingDashboard` row or mark `AdminReportingDashboard.jsx` explicitly as unrouted dead code pending a decision (see V11 note below — do not silently delete the component in a docs-only PR); add `/coaches` → `CoachesPage.jsx`; add the other omitted routes (`/admin/forms`, `/admin/audit-logs`, `/admin/analytics`, `/account`).
- **Files touched:** `docs/architecture/frontend-architecture.md`.
- **Effort:** S
- **Verification:** Manual line-by-line diff against `App.jsx:217-279`; no automated gate exists for doc-route accuracy — this is intentionally a human-verified fix. Full local sequence still run as regression guard (trivially passes, no code changed).
- **Diff type:** minimal-diff fix. *(Kept in Milestone 1's scope note even though it's a pure doc fix, since the rule is "every blocker and high-severity finding" ships in Milestone 1 regardless of category — see Milestones table.)*

**DD-2 — `docs/expansion/03_ROADMAP.md` still lists division-level team-size configuration as open backlog; it shipped end-to-end.** *(Medium — Milestone 2. Confirms/updates v1.1 Area B — see Section 5.)*

- **Gap:** `ROADMAP.md:117` groups "division team-size configuration" with genuinely-open items under Engineering backlog, pointing at `v1.1-planning.md` Area B, whose own section (85-95) still reads as an unstarted proposal. In reality: `supabase/migrations/20260504020000_admin_upsert_division_settings_rpc.sql` defines the audited `admin_upsert_division_settings` RPC, backed by CHECK constraints in `20260502001000_division_roster_constraints.sql`, editable at `frontend/src/pages/TeamAnalysisPage.jsx:487-523`, and actually consumed by `packages/core/src/rosterSizing.js`/`teamGeneration.js` — not hardcoded as the doc claims.
- **Fix approach:** Move the "division team-size configuration" line out of `ROADMAP.md`'s open Engineering backlog into its Completed-phases history; add a "Landed" annotation to `v1.1-planning.md` Area B matching the style already used for Areas A and D, citing the four files above.
- **Files touched:** `docs/expansion/03_ROADMAP.md`; `docs/expansion/v1.1-planning.md`.
- **Effort:** S
- **Verification:** Manual review against the four cited source files; full local sequence.
- **Diff type:** minimal-diff fix.

**DD-3 — `docs/architecture/data-modeling.md` and `docs/architecture/team-generation.md` omit two fully-shipped subsystems that a sibling doc already documents correctly.** *(Medium — Milestone 2)*

- **Gap:** `data-modeling.md`'s Divisions schema (43-54) lists only `max_roster_size` (missing `min_teams`/`max_teams`/`min_roster_size`/`target_team_size`/`team_count_override`); its Coaches schema (27-41) and Data Ingestion Utilities (135-153) never mention `coach_interested_programs` or coach-lead capture. `team-generation.md:42` still states team count as `ceil(totalPlayers / maxRosterSize)` with no mention of the min/max/target bounds, and its "Next Steps" (123-127) lists already-shipped work as future. `docs/architecture/persistence-rpc-layer.md:118-121` already documents both subsystems accurately — these two sibling docs just weren't updated in step.
- **Fix approach:** Update the Divisions/Coaches schema sections in `data-modeling.md` to list the full current column set (cross-reference `persistence-rpc-layer.md` §2.x for the RPC-level detail, keep this doc schema-focused); update `team-generation.md`'s algorithm description to reflect the min/max/target-bounds logic actually implemented in `rosterSizing.js`; remove the two already-shipped bullets from "Next Steps."
- **Files touched:** `docs/architecture/data-modeling.md`; `docs/architecture/team-generation.md`.
- **Effort:** M (schema table needs to be regenerated accurately against the live migrations, not just patched in place).
- **Verification:** Manual cross-check against `supabase/migrations/20260421060000_coach_leads.sql`, `20260504020000_admin_upsert_division_settings_rpc.sql`, `packages/core/src/rosterSizing.js`; full local sequence.
- **Diff type:** minimal-diff fix.

**DD-4 — `persistence-rpc-layer.md`, the canonical RPC inventory, is missing ~10 RPCs shipped in the `20260613000000`-`20260613000006` batch, and its own "Known Gaps" note describes a problem migration `20260613000006` already fixed.** *(Medium — Milestone 2)*

- **Gap:** The doc's inventory (§2.1-2.18) stops at migration `20260611000100`. `admin_delete_coaches`, `admin_update_registration_form`, `admin_delete_registration_form`, `admin_remove_member`, `admin_change_member_role`, `admin_cancel_game_assignment`, `admin_cancel_practice_assignment`, `admin_delete_team`, `admin_update_team`, `get_organization_members` (all real, correctly-guarded, actively called from `CoachesPage.jsx:419-525` and other admin pages) are absent. §5 "Known Gaps" still describes the audit-action CHECK-lag problem that `20260613000006_audit_actions_lookup.sql` already solved with a lookup table + FK.
- **Fix approach:** Add §2.19-2.28 entries for the 10 missing RPCs (signature, authz pattern, audit action, call site) following the doc's existing format; remove or update the resolved "Known Gaps" bullet.
- **Files touched:** `docs/architecture/persistence-rpc-layer.md`.
- **Effort:** M (10 RPC entries to write accurately).
- **Verification:** Manual cross-check against the six `20260613*` migration files and their frontend call sites; full local sequence.
- **Diff type:** minimal-diff fix.

**DD-5 — `v1.1-planning.md` quotes an outdated version of `ROADMAP.md`'s M2.2 wording that current `ROADMAP.md` no longer contains.** *(Low — Milestone 2)*

- **Gap:** `v1.1-planning.md:36,138` quotes M2.2 as claiming ingestion is "finalized with robust validation and error recovery." Current `ROADMAP.md:33-34` already reads "Shipped CSV validation, import-job tracking, and error recovery. Durable staged promotion... has since shipped" — i.e. `ROADMAP.md` was already reconciled for the player/coach/field slice; `v1.1-planning.md`'s quoted evidence is stale even though its underlying point (team-import promotion still pending — confirmed, no team-promotion RPC or import type exists in `supabase/migrations/**` or `ImportContext.jsx`) remains true. *(This confirms v1.1 Area A is still genuinely open — see Section 5.)*
- **Fix approach:** Update the quoted M2.2 excerpt in `v1.1-planning.md`'s Gap and Related Artifacts tables to match current `ROADMAP.md:33-34` wording, while keeping the substantive Area A gap statement (team-import promotion pending) unchanged.
- **Files touched:** `docs/expansion/v1.1-planning.md`.
- **Effort:** S
- **Verification:** Manual diff against `ROADMAP.md:33-34`; full local sequence.
- **Diff type:** minimal-diff fix.

**DD-6 — CLAUDE.md's environment-variable table documents `VITE_PERSISTENCE_ENDPOINT`, a name that exists nowhere in the code; the real variable is `VITE_SUPABASE_PERSISTENCE_URL`.** *(Medium — Milestone 2)*

- **Gap:** `CLAUDE.md` §10 lists `VITE_PERSISTENCE_ENDPOINT`. The code reads `VITE_SUPABASE_PERSISTENCE_URL` (`frontend/src/config.js:21`, `scripts/configurePersistenceEndpoint.js:45-57`, `tests/configurePersistenceEndpoint.test.js`). `docs/operations/ENVIRONMENT.md:28` already has the correct name. A developer following CLAUDE.md's table would set a variable Vite silently ignores (unknown `VITE_` vars aren't bundled), and the persistence-endpoint override would never take effect.
- **Fix approach:** Correct the variable name in `CLAUDE.md` §10's table to `VITE_SUPABASE_PERSISTENCE_URL`.
- **Files touched:** `CLAUDE.md`.
- **Effort:** S
- **Verification:** Manual check against `frontend/src/config.js:21`; full local sequence.
- **Diff type:** minimal-diff fix.

**DD-7 — `docs/operations/ENVIRONMENT.md` points to `.env.test.example` for E2E credentials but never lists the variables that file actually defines.** *(Low — Milestone 2)*

- **Gap:** `ENVIRONMENT.md:96` says "Optionally copy `.env.test.example`..." but none of its three variable tables mention `VITE_TEST_ADMIN_EMAIL`, `VITE_TEST_COACH_EMAIL`, `VITE_TEST_PASSWORD` — the three variables `.env.test.example:9-11` actually defines and `mockSupabaseClient.js:63,72,1027` consume.
- **Fix approach:** Add a fourth table (or extend an existing one) listing these three variables, their purpose, and that they're optional/test-only.
- **Files touched:** `docs/operations/ENVIRONMENT.md`.
- **Effort:** S
- **Verification:** Manual cross-check against `.env.test.example` and `mockSupabaseClient.js`; full local sequence.
- **Diff type:** minimal-diff fix.

**DD-8 — `sentry-smoke.md`'s documented trigger command calls `__FORCE_ERROR__` as a function; the code implements it as a boolean flag.** *(Medium — Milestone 2)*

- **Gap:** `docs/operations/sentry-smoke.md:41` instructs `window.__FORCE_ERROR__()`. The actual contract (`frontend/src/global.d.ts:9`) is `__FORCE_ERROR__: boolean | undefined`; `DashboardPage.jsx:775-780` and `WorkflowPage.jsx:18-23` check `=== true`. Running the documented command throws `TypeError: window.__FORCE_ERROR__ is not a function` instead of exercising the intended path.
- **Fix approach:** Correct the doc to `window.__FORCE_ERROR__ = true` followed by a navigation/reload of `/` or `/workflow`.
- **Files touched:** `docs/operations/sentry-smoke.md`.
- **Effort:** S
- **Verification:** Manually run the corrected command against a local dev build and confirm the ErrorBoundary/Sentry capture fires; full local sequence.
- **Diff type:** minimal-diff fix. *(The release-tag portion of this same runbook, line 60, is resolved by DS-12's code fix, not a separate doc edit — once DS-12 ships, no further change is needed here.)*

**DD-9 — `.env.test` setup, as documented, has no effect on either of its two intended consumers.** *(Medium — Milestone 5, paired with the observability/reliability work since it's a test-tooling config fix, not a pure doc edit)*

- **Gap:** `.env.test.example`'s header and `ENVIRONMENT.md:96` both instruct copying to `.env.test`. `playwright.config.ts:6` calls `dotenv.config()` with no path (loads `.env` only, never `.env.test`), so the Node-side `TEST_*` vars `auth_setup.ts:121-135` reads are never sourced from it. The Playwright `webServer` starts plain `vite` (mode `development`), which never loads `.env.test` either, so the `VITE_TEST_*` vars are also unreachable. CI is unaffected because `ci.yml:170-173` injects `TEST_*` directly as job env, which is likely why this has gone unnoticed.
- **Fix approach:** Change `playwright.config.ts:6` to `dotenv.config({ path: '.env.test' })` (falling back to `.env` if absent, e.g. via `dotenv.config(); dotenv.config({ path: '.env.test', override: true })`) so local runs actually pick up `.env.test` when present, matching the documented workflow.
- **Files touched:** `playwright.config.ts`.
- **Effort:** S
- **Verification:** `npm run test:e2e` locally with a populated `.env.test` overriding one test credential, confirm the overridden value is used (e.g. via a temporary log or by observing the auth step target the overridden email); full local sequence.
- **Diff type:** minimal-diff fix.

---

## 4. Testing Gaps

**TG-1 — Coverage thresholds are never enforced by CI, and `frontend/src/hooks/**` falls far below the documented gate when actually measured — masked by a single global aggregate.** *(High — Milestone 1)*

- **Gap:** `vitest.config.js:25-36` scopes coverage to `packages/core/src/**` + `frontend/src/hooks/**` with thresholds 60/50/55/60, no `perFile` override (checked as one combined total). `.github/workflows/ci.yml`'s 8-step pipeline runs `npm run test` (142) but never `npm run test:coverage` — the only coverage-related step is a non-blocking artifact upload with nothing to upload. Executed locally (`NODE_OPTIONS=--no-experimental-webstorage PERF_TEAM_GEN_MAX_MS=120000 npm run test:coverage`): aggregate 76.95%/71.35%/79.28%/78.06% passes, but the `frontend/src/hooks` subtotal alone is 33.26%/19.17%/31.73%/35.52%, with literal 0% on `useAutoScheduler.js`, `useConflicts.js`, `useConnectivityMonitor.js`, `useGameSlots.js`/`useGameAssignments.js`, `useMaintenanceMode.js`, `usePlayersData.js`, `useSetupProgress.js`, `useTeamPersistence.js`, `useTeamPortal.js` — all live, imported hooks with no dedicated test file.
- **Fix approach:** (1) Add `npm run test:coverage` as a CI step (after "Unit & Integration Tests"), so a threshold regression actually fails the build. (2) Add `coverage.thresholds.perFile: true` (or migrate to per-directory thresholds) in `vitest.config.js` so `frontend/src/hooks/**`'s weak coverage can't hide behind `packages/core/src`'s strong coverage. (3) As the immediate unblock for (2) not failing CI on day one, add baseline tests for at minimum `useTeamPersistence.js` (used by `TeamAnalysisPage.jsx`, `WorkflowPage.jsx`, `teamReviewPersistence.js`) and `useConflicts.js`/`useTeamPortal.js` (both have live page consumers) before flipping `perFile` on. Note this item depends on resolving TG-5 (coverage-mode perf-budget failure) first, since `test:coverage` currently fails outright without `PERF_TEAM_GEN_MAX_MS` override.
- **Files touched:** `.github/workflows/ci.yml`; `vitest.config.js`; new `tests/useTeamPersistence.test.js`, `tests/useConflicts.test.js`, `tests/useTeamPortal.test.js` (at minimum).
- **Effort:** L (new CI-blocking gate plus real net-new test coverage on previously-untested hooks — not a quick config flip).
- **Verification:** `npm run test:coverage` exits 0 in CI with `perFile` thresholds enforced; `npm run test`; full local sequence.
- **Diff type:** minimal-diff fix for the CI wiring and threshold config; the new hook tests are ordinary, low-risk test additions (no production code changes).

**TG-2 — Several E2E step definitions assert on mock-DB/sessionStorage internals the same scenario just injected, violating the project's own "DOM-based assertions only" rule.** *(High — Milestone 1)*

- **Gap:** CLAUDE.md §8 rule 2: "Use DOM-based assertions only — never assert on mock internal state or sessionStorage directly." `tests/e2e/steps/scheduling_and_overrides.ts`'s `When('the scheduler runs', ...)` (349-373) writes a hand-built `scheduler_runs` record straight into `sessionStorage.__MOCK_DB__` with a hardcoded `timezone_offset`, and the `Then` steps (375-403) re-read that same blob and assert on it directly — never exercising the real scheduling engine's timezone logic. `tests/e2e/steps/coach_and_calendar.ts`'s calendar-feed step (181-197) fully mocks the network response via `page.route(...)` with a fixed literal ICS body, and the corresponding "no data leakage" assertion (`Pillar2_CoachDailyLoop.feature:21`) just checks the self-supplied mock string contains `END:VCALENDAR` — it never verifies the real `calendar-feed` Edge Function excludes another team's events. Both scenarios pass trivially today (confirmed: `npx bddgen && npx playwright test --workers=1 --grep "Calendar Sync|Practice Scheduling with Timezone"`, 2 passed in 10.5s) precisely because the assertions only check data the test itself wrote — a regression in either the real scheduling engine's DST handling or the real `calendar-feed` function's per-team isolation would not be caught.
- **Fix approach:** Rewrite the `When` steps to drive the actual `packages/core/src` scheduling engine (for the timezone scenario) and the real `calendar-feed` Edge Function response (for the data-isolation scenario) instead of pre-writing the expected result, then assert on rendered DOM output only, per rule 2. For calendar-feed specifically, seed two teams' events in the mock DB and assert the rendered/downloaded ICS for team A's token does not contain team B's event identifiers.
- **Files touched:** `tests/e2e/steps/scheduling_and_overrides.ts`; `tests/e2e/steps/coach_and_calendar.ts`.
- **Effort:** L (both scenarios need to be re-architected around real engine/function output, not just re-asserted).
- **Verification:** `npx bddgen && npx playwright test --workers=1 --grep "Calendar Sync|Practice Scheduling with Timezone"`; deliberately introduce a temporary regression in the real DST/isolation logic locally to confirm the rewritten test actually fails (then revert), as the concrete proof the assertion is no longer tautological; full local sequence including `npm run test:e2e -- --workers=1`.
- **Diff type:** flagged refactor for the calendar-feed scenario specifically (touches how the E2E harness intercepts vs. exercises the Edge Function — worth a design check on mock-vs-real boundary before implementation); minimal-diff fix for the scheduler-timezone scenario (contained within one step file).

**TG-3 — `docs/testing/e2e_master_plan.md` documents journeys with no corresponding `.feature` scenario: DST-boundary practice splitting, rainout/urgent-alert acknowledgment, mid-season late-registrant additions to a locked roster.** *(Medium — Milestone 7)*

- **Gap:** `e2e_master_plan.md:31,42,59` names these three journeys as in-scope. Repo-wide grep across `tests/e2e/features/*.feature` for `daylight|dst|savings time|rainout|acknowledg|late registra|mid-season` returns zero matches; the closest existing scenarios (`Pillar1_Engine.feature:19-26` timezone test, `admin_overrides.feature`, `registration_compliance.feature`) don't cover any of the three.
- **Fix approach:** Add one new `.feature` scenario per journey to the appropriate pillar file, with matching step definitions. Scope each to the minimum meaningful assertion (e.g. DST: a practice slot spanning a DST transition splits/adjusts correctly and the split is visible in the DOM; late-registrant: adding a player to a division whose roster is already at `max_roster_size` surfaces the expected UI state rather than silently succeeding or crashing).
- **Files touched:** `tests/e2e/features/Pillar1_Engine.feature` (or a new file); `tests/e2e/features/Pillar2_CoachDailyLoop.feature`; `tests/e2e/features/registration_compliance.feature`; corresponding new/extended step files under `tests/e2e/steps/`.
- **Effort:** L (three new, independent E2E journeys).
- **Verification:** `npx bddgen && npx playwright test --workers=1 --grep "DST|Rainout|Late Registrant"`; full local sequence including `npm run test:e2e -- --workers=1`.
- **Diff type:** minimal-diff fix (additive test scenarios; no production code changes required unless the scan surfaces an actual behavioral gap, in which case that becomes its own separately-scoped item).

**TG-4 — The coverage-mode performance budget in `tests/performance.test.js` is not reliably met, so `npm run test:coverage` fails and skips generating a report entirely.** *(Medium — Milestone 7)*

- **Gap:** `tests/performance.test.js:16-29` sets a 20000ms budget for the team-generation benchmark under `test:coverage`. Executed: `AssertionError: expected 20865.3613 to be less than 20000` at line 63 — v8 coverage instrumentation overhead pushes the benchmark past its own budget, and Vitest exits without writing any `coverage/` output. A re-run with `PERF_TEAM_GEN_MAX_MS=120000` was needed to get a usable report.
- **Fix approach:** Raise the coverage-mode budget constant in `tests/performance.test.js` to a value with realistic headroom over instrumentation overhead (e.g. 30000-35000ms, informed by the observed 20865ms actual, not the current 20000ms with zero margin), rather than requiring every future coverage run to set `PERF_TEAM_GEN_MAX_MS` manually. This directly unblocks TG-1's CI wiring, which depends on `test:coverage` succeeding unattended.
- **Files touched:** `tests/performance.test.js`.
- **Effort:** S
- **Verification:** `npm run test:coverage` (no env override) exits 0 and produces `coverage/coverage-summary.json`; full local sequence.
- **Diff type:** minimal-diff fix.

**TG-5 — The mock's player-mutation RPCs whitelist patch field names but skip all value validation the real RPCs enforce.** *(Medium — Milestone 3)*

- **Gap:** The real `sanitize_player_patch` (`20260611000100_player_admin_mutation_rpcs.sql:18-117`) validates `rating` (1-5), `years_played` (0-30), `jersey_number` (0-999), `status` enum, boolean fields, and guardian_contacts shape/cap — backed by CHECK constraints. The mock's copy (`mockSupabaseClient.js:2599-2734`) only checks patch *key names* against an allow-list, then does a raw `Object.assign` with zero value/type/range checks; `admin_bulk_update_players`'s forbidden-field check is entirely absent in the mock; `admin_create_player`'s mock spreads `p_fields` directly with no whitelist, so it would even accept an `organization_id` override the real RPC rejects. A patch like `{ rating: 999 }` or `{ status: 'bogus' }` passes every mock-backed unit/E2E test but aborts the transaction in production (LESSONS_LEARNED #4). Two sibling RPCs added the same week (`admin_update_registration_form`, `admin_update_team`) *do* mirror this validation in the mock (`mockSupabaseClient.js:4485-4489,4743-4769`) — the established mitigation pattern exists, just wasn't applied here.
- **Fix approach:** Port the same value-range/enum/shape checks from `sanitize_player_patch` into the mock's `admin_update_player`/`admin_bulk_update_players`/`admin_create_player` implementations, following the exact pattern already used for `admin_update_team`'s mock validation.
- **Files touched:** `frontend/src/lib/mockSupabaseClient.js`.
- **Effort:** M
- **Verification:** `npm run test -- tests/mockSupabaseClient.test.js` (new cases: assert the mock now rejects out-of-range `rating`/invalid `status`/forbidden bulk fields, matching the real RPC's error shape); full local sequence.
- **Diff type:** minimal-diff fix.

**TG-6 — The mock `finalize_import_job` unconditionally resets an existing player's status on every re-import; the real RPC preserves a manually-set status except for waitlist transitions.** *(Medium — Milestone 3, paired with PB-4's server-side fix)*

- **Gap:** The real `finalize_import_job` (`20260611000200_import_gotsport_expanded_mapping.sql:409-427`) only ever moves a player onto/off the waitlist, otherwise preserving `p.status` unchanged. The mock's version (`mockSupabaseClient.js:2881-2933`, esp. 2910,2924) computes one `status` value per row and applies it identically to inserts and updates via `Object.assign`, with no reference to the existing player's current status — so an admin-deactivated player is silently reset to `'active'` in mock/E2E runs but correctly stays `'inactive'` against the real database, an undetected divergence (no test currently asserts on `finalize_import_job`'s status handling).
- **Fix approach:** Update the mock to replicate the real RPC's `CASE` logic: preserve `existing.status` unless the staged row's `import_status` is `'waitlist'`, or the existing status is `'waitlist'` and the staged row is `'active'`.
- **Files touched:** `frontend/src/lib/mockSupabaseClient.js`.
- **Effort:** S
- **Verification:** `npm run test -- tests/playerImportBuddyMaterialization.test.js` (extend with a status-preservation case: pre-set a player to `'inactive'`, re-import, assert status is still `'inactive'`); full local sequence.
- **Diff type:** minimal-diff fix.

---

## 5. v1.1 Completeness

This section reconciles four audit findings against `docs/expansion/v1.1-planning.md`'s Areas A-E. No new v1.1 feature work is proposed here — building out any of Areas A-C would be net-new functionality, not a gap-analysis remediation, and is explicitly out of this plan's scope. The doc corrections below ship in **Milestone 2**; no separate milestone is needed.

- **Area A (Import write path — team/coach promotion).** DD-5 confirms Area A's core claim is still accurate today: no team-promotion RPC or import type exists anywhere in `supabase/migrations/**` or `frontend/src/contexts/ImportContext.jsx`. The only correction needed is `v1.1-planning.md`'s stale quoted evidence (DD-5, Milestone 2) — the underlying gap statement itself needs no change. Separately, `frontend/src/pages/EnterpriseDashboard.jsx:106`'s `coaches: Math.floor(orgData.total_users * 0.4)` stub (confirmed by direct read) is explicitly a placeholder pending Area A landing, per its own inline comment — this is expected/accepted given Area A's status, not a new finding; no action proposed beyond what `v1.1-planning.md` already documents.
- **Area B (Division-level teaming config).** DD-2 (Milestone 2) updates this from "not yet built" to "shipped" — `admin_upsert_division_settings`, the CHECK constraints, the `TeamAnalysisPage.jsx` admin UI, and `rosterSizing.js`'s consumption of the bounds are all confirmed live. `ROADMAP.md` and `v1.1-planning.md` both need the "Landed" annotation DD-2 adds.
- **Area C (Placeholder coaches + admin swap).** No finding in this audit examined Area C's build status one way or the other — nothing is asserted here, per the rule against reporting findings not personally verified.
- **Area D (Coach lead capture / coach review UI).** DD-1 (Milestone 1, since it's high-severity) confirms Area D is fully shipped and live at `/coaches` (`CoachesPage.jsx`, status pills, program/search filters, `admin_update_coach_status`/`admin_assign_team_coach` RPCs) — the only gap is that `frontend-architecture.md`'s route table never listed it, which DD-1 fixes.
- **Area E (non-coach volunteer intent capture).** Explicitly out of scope per `v1.1-planning.md`; nothing in this audit touches it, and nothing here proposes building it.
- **Coaches.email global-uniqueness scaling risk** (named in `ROADMAP.md`'s Open Items and in `supabase/migrations/20260421060000_coach_leads.sql:17-22`'s own header comment) is a deliberate, already-documented single-tenant tradeoff the C1.6 migration explicitly chose to preserve rather than reshape — not a new finding from this audit, and not actioned here; whoever scopes Area C should read that migration comment first.

---

## 6. Polish

No items remain unassigned to a section above at "low" severity beyond what's already listed inline in Sections 3 (DD-5, DD-7) and 5. All "medium" items that don't rise to blocker/high are captured in their respective thematic subsections of Section 2 and Section 4 and are sequenced into Milestones 3-7 below — this plan does not hold back a separate low-priority backlog beyond what's already itemized; every finding in `audit.md` has a home above.

---

## Milestones

Branch names follow CLAUDE.md's `feat/...`/`fix/...`/`docs/...` convention. Every milestone ends with the same verification sequence (per CLAUDE.md §8/§3):

```bash
npm run lint
npm run typecheck
npm run test              # NODE_OPTIONS=--no-experimental-webstorage locally on Node >=22
npm run frontend:build
npm run check:advisors
npm run check:bundle
```

E2E-touching milestones additionally require `npx bddgen && npm run test:e2e -- --workers=1` after any `.feature` file edit.

| # | Milestone | Branch | Items | Notes |
|---|---|---|---|---|
| 1 | Blockers + all high-severity findings | `fix/2026-07-audit-blockers-and-high-severity` | PB-1, PB-2, PB-3, PB-4, DS-1, DS-3, DS-6, DS-7, DS-10, DS-11, DS-14, DS-17, DS-18, DD-1, TG-1, TG-2 | 16 items spanning SQL/RLS, RPC hardening, data-import correctness, npm lockfile, frontend error handling, observability wiring, dashboard caching, accessibility tooling, and E2E-assertion rewrites. Per this plan's brief this is tracked as **one milestone with one final green gate**, but given the blast-radius spread, recommend sequencing it as 4-5 internally-ordered PRs onto the same branch (SQL/RLS first — PB-1/PB-2/PB-3/PB-4/DS-1; then dependency/security — DS-3; then frontend reliability — DS-6/DS-7/DS-10/DS-11/DS-14; then testing — TG-1/TG-2 [TG-1 depends on TG-4 landing first, see Milestone 7 ordering note below]; then accessibility — DS-17/DS-18; then the one docs item DD-1) rather than one enormous diff, while still gating the final merge on the single verification sequence above. |
| 2 | Docs-drift correction pass | `docs/2026-07-audit-corrections` | DD-2, DD-3, DD-4, DD-5, DD-6, DD-7, DD-8 | Pure documentation edits (CLAUDE.md, docs/architecture/**, docs/expansion/**, docs/operations/**). CI's `docs_only` detection fast-paths this PR; full sequence still run locally once as a sanity check. |
| 3 | Mock/real validation parity | `fix/mock-and-client-validation-parity` | DS-2, TG-5, TG-6 | Brings the mock client's RPC validation and the client-side Zod layer up to match the real database's rules, closing the gap that lets invalid data pass every mock-backed test and only fail in production. |
| 4 | Export & registration hardening | `fix/csv-export-and-registration-throttling` | DS-4, DS-5 | Small, independent security hardening items (formula-injection escaping, registration RPC rate limit). |
| 5 | Reliability & observability follow-through | `fix/reliability-and-observability-gaps` | DS-8/DS-11 (one work package), DS-9, DS-12, DS-13, DD-9 | Note: DS-11's Edge Function logging fix ships as part of Milestone 1 (bundled with DS-8 as one work package per the cross-reference) — do not re-list it here as separate work; this row exists to sequence DS-9/DS-12/DS-13/DD-9, which are independent of Milestone 1's timeline. |
| 6 | Dashboard query batching | `fix/dashboard-query-batching` | DS-15 | DS-16 (bundle-headroom / mock-client dynamic import) is explicitly **not** included — it's a flagged refactor requiring separate design sign-off on the Supabase client's async bootstrap; scope and branch it independently once that review happens. |
| 7 | E2E completeness | `fix/e2e-coverage-completeness` | TG-3, TG-4 | **Sequencing note:** land TG-4 (coverage-mode perf budget fix) before or alongside Milestone 1's TG-1 work, since TG-1's new CI coverage gate depends on `npm run test:coverage` succeeding unattended. If Milestone 1 reaches TG-1 first, pull TG-4 forward into Milestone 1 rather than waiting for Milestone 7. |

### Explicitly out of scope (do not implement, per ground rules)

- **React Router 8.x major upgrade** (closes the RSC-mode CSRF CVE, GHSA-qwww-vcr4-c8h2) — would be a major-version change to a library this project's ground rules name as staying as-is. Fixed instead via a documented waiver (DS-3) since the app's classic-`BrowserRouter` usage is outside that CVE's own stated scope.
- **DS-16 (mock-client dynamic import / bundle headroom)** is flagged, not implemented, pending a design review of the Supabase client's synchronous-to-async bootstrap change — see Section 2.5.
- Nothing in this plan proposes payments/billing, CMS/public-site hosting, sensitive-document file uploads, e-commerce, sponsor CRM, or AI assistant/chatbot functionality, and nothing proposes a TypeScript conversion, ORM/auth/framework swap, or monorepo retooling.