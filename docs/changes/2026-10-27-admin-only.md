# Admin only: no coach sign-in, admins across organizations, permits for admins

Kind: REFACTOR (removal) and FEATURE (multi-organization admins) · Drawn up: 2026-10-27 · Owner:
the product owner · Status: **APPROVED by the owner 2026-10-27** (AGENTS.md rule 14: roles,
persistence and the domain model); all six decisions as recommended, decision 5 amended (see the
end).

Every claim about the code is _statically reviewed_ at `origin/main` `9128db9` unless marked
_executed_. Production figures are _executed (read-only)_, catalogue and counts only, 2026-10-27,
through the SQL endpoint; no personal value was read.

## The owner's decision (2026-10-27)

"Scrap the coach access. [...] We're just going to focus on league admins for now, and admins may
have access to multiple orgs [...] A coach may be in multiple orgs too, but there's no longer a
coach view or targeted functionality. The permits are now uploadable by and for league admins to
have consolidated and quick access to them."

So the only people who sign in are league admins (`admin`, `staff`, `tenant_admin`: `ADMIN_ROLES`,
`permissions.js:51`; staff since `20261020030000`). Coaches stay as **imported data admins
manage**: they anchor teams, are assigned to teams, and appear in admin exports, but never sign in.

## What production holds (_executed (read-only)_, 2026-10-27; ledger at `20261102010000`)

| Object | Count | Note |
| --- | --- | --- |
| `organizations` / `organization_members` | 1 / 1 | the one member is an `admin`; 0 `coach`, `staff`, `tenant_admin` |
| profiles in more than one organization | 0 | 1 profile holds 1 membership |
| `organization_invites` | 0 | none open, none used |
| `profiles` | 4 | all `role = 'user'`; `organization_id` set on **0** |
| `coaches` | 130 | one organization; emails all already lower-case and trimmed; 0 case-insensitive duplicates |
| `coaches.user_id` set | 1 | the **admin's own account** (its member role is `admin`); one `coach.linked` audit row |
| `coaches.profile_id` set | 0 | a column **in production only** (FK to `profiles`), added by no repo migration: drift |
| `team_calendar_tokens`, `teams`, `team_coach_assignments`, `games`, `practice_slots` | 0 each | |
| `coach_practice_preferences`, `practice_lighting_overrides`, `coach_team_requests` | 0 each | the prefs plan counted 3 preference rows on 2026-10-26; 0 today |
| `facility_permits`, scopes, objects in bucket `facility-permits` | 0 each | |
| demo organizations, anonymous users | 0 / 0 | |

Deploy role: `postgres` is not superuser; `auth.users` is owned by `supabase_auth_admin`
(_executed_). So: no DDL on `auth.*`; `storage.objects` policies by `ALTER POLICY`, which
`20261030010000:441-452` already ran in production.

## Inventory: coach-facing and coach-access code

Disposition: **R** remove, **A** keep as admin-only (narrowed), **K** keep unchanged.

**Database** (latest definitions; callers from the production catalogue, _executed_):

| Object | Where | Disposition |
| --- | --- | --- |
| `organization_members_role_check` (`admin, coach, staff, tenant_admin`), `organization_invites_role_check` (`admin, coach, staff`) | `20261024010000:283-289` | **A**: drop `coach` from both; a guard refuses while any member or unused invite holds it (production: 0) |
| `create_org_invite`, `admin_change_member_role` role whitelists | `20261024010000:291`, `:341` | **A**: replace (md5 guard) with `('admin','staff')` |
| `is_org_member(uuid)` | `20261030010000:271-285` | **K**: with no `coach` role a member is an admin-equivalent, so every member-wide read (teams, games, slots, `exports` and `raw-imports` storage) becomes an admin read by construction; pinned by a catalogue test (Tasks, B4) |
| `link_my_coach_record()`, audit action `coach.linked` | `20261020040000:49` | **R** the function; the action stays registered for the old row |
| `coaches.user_id` (FK `auth.users`, UNIQUE), `coaches_user_id_key` | `20260331000000:415,435` | **R** (second migration, Risks) |
| `coaches.email` UNIQUE across organizations, `coaches_email_key` | `20260331000000:434` | **A**: per organization (below) |
| `coached_team_ids_of`, `get_my_coached_team_ids`, `admin_get_coached_team_ids` | `20261021010000:226,253,265` | **R** (callers: the division and permit helpers below, all removed) |
| `is_current_team_coach(uuid)` | `20261021010000:188` | **R**; first replace its callers `get_team_roster` (`20261025010000:183`), `get_team_staff` (`:129`) and `rotate_calendar_token` (`20261021020000:170`) without the coach arm (md5 guards) |
| `division_teams_of`, `get_my_division_teams` (R6), `admin_get_division_teams` | `20261028010000:342,386,411` | **R** |
| `update_game_score` | `20261028010000:108` | **K**: already admin-only behind `score_entry` (R6) |
| `request_coach_practice_preference` | `20260927000000:135` | **R**; admins keep `admin_set_` and `admin_decide_coach_practice_preference` (`:341`, `:216`) |
| `withdraw_practice_lighting_override` | `20261028010000:274` | **K**: admin-only since R6; no coach request RPC exists |
| `caller_coaches_practice_slot(uuid)` | `20261003000000:142` | **R** after its policy below |
| Policies `coaches_select_admin_or_self`, `team_coach_assignments_select_admin_or_self` | `20261021020000:74,85` | **A**: `is_org_admin(organization_id)` only (ALTER POLICY, renamed `..._select_admin`) |
| `team_calendar_tokens_select` | `20261024010000:122` | **A**: admin only |
| "Coach practice preferences: admins and the coach read" | `20260927000000:106` | **A**: admin only |
| "Practice lighting overrides: admins and the slot's coaches read" | `20261003000000:178` | **A**: admin only |
| Permits: `coach_field_ids_of`, `coach_covers_permit_scope`, `coach_reads_facility_permit`, `coach_reads_facility_permit_file` | `20261102010000:227,262,281,297` | **R** |
| `facility_permit_json(uuid, date, boolean p_coach_only)`, `get_facility_permits(uuid)` | `20261102010000:348,733` | **A**: `get_facility_permits` admin branch only (42501 otherwise); `facility_permit_json` recreated without `p_coach_only` (a parameter nobody passes `true` to would be parsed and unread) |
| Permit policies on `facility_permits`, `facility_permit_scopes`; storage "facility-permits select" | `20261102010000:331,336,809` | **A**: admin only; the five admin RPCs and the insert/delete storage policies **K** |
| `reconcile_prod_rls_drift()` spec | `20261022030000:270-271,464-467` | **A**: its spec states `coaches_select_admin_or_self` **with `user_id`**; once the column goes, the function's probe `CREATE POLICY` fails. Replaced (md5 guard) with the new name and expression, as R2 did |
| `finalize_coach_import_job` cross-organization refusal | `20261022010000:969-986` | **A**: the email lookup is scoped to the job's organization; "Coach email already belongs to another organization" goes |
| `auto-scheduler`, `fairness-scoring` member checks; `record_audit_event`'s any-member arm | `supabase/functions/_shared/auth.ts:92-102`; R6 "found for later" | **K**: closed by the role check (a member is an admin); declared, not rewritten |

**Frontend** (all **R** unless marked):

- Coach home: `CoachDashboard` (`DashboardPage.jsx:594-673`) and its pick (`:718-723`); cards
  `components/coach/CoachScheduleCard.jsx` (R7's coach CSV/XLSX/ICS), `DivisionTeamsCard.jsx`,
  `CoachPermitsCard.jsx` (#670), `useMyCoachedTeams.js`, `MyTeamPage.jsx` and `/my-team`
  (`App.jsx:364`). **K**: the admin per-team exports on the team page's Schedule tab and the master
  XLSX (R7), and the shared `ScheduleExports.jsx`.
- `/permits` (`App.jsx:366-370`, `PermitsPage.jsx`): **A**, the admins' consolidated permits page
  (decision 4). `PermitStatusBadge.jsx` moves out of `components/coach/`.
- Practice preferences: `CoachPreferenceRequests.jsx`, its branch in `CoachPreferencesPage.jsx:47-51`,
  `REQUEST_PRACTICE_PREFERENCE` (`permissions.js:27-30`); **A** `AdminPreferenceReview.jsx`.
- Roles and nav: `ROLES.COACH` and its permissions (`permissions.js:4,95-106`), `ASSIGNABLE_ROLES`
  (`:62`) becomes admin and staff; `ROLE_NAV.coach` (`navigation.js:234-247`); SideNav's coach arm
  (`SideNav.jsx:82-91,114`); `MembersPage.jsx:21` and `InvitesSettings.jsx:18,41` (default `coach`).
- Role preview: "Preview as Coach" (`TopBar.jsx:121-191,239-254`, its only target),
  `impersonateUser`/`stopImpersonation` and `isCoach` (`AuthContext.jsx:222-277,299`),
  `ShadowBanner` (`DashboardLayout.jsx:34`) and the `isImpersonating` branches (16 files): decision 2.
- `OrganizationContext.jsx:69-84,176-193`: the `link_my_coach_record` call on every sign-in.
- `useScorableGames.js:69-77`: coached-team read and `coachesTeam`; the team page's calendar
  `canRotate` (`TeamRecordPage.jsx:68-71,458`) becomes "is admin".
- `AdminLightingQueue.jsx:49-50` names requesters through `coaches.user_id`: names them from the
  members read instead (requests now come only from admins).
- Mock: the coach persona (`mockSupabaseClient.js:124-137`), `link_my_coach_record` (`:4797`), the
  coach arms in `mockServerSideReads.js`, `mockFacilityPermits.js:282`, `mockCoachPreferences.js:140`,
  `mockReadPolicies.js`; the cross-organization email refusal (`mockSupabaseClient.js:5728`).
- Demo: no coach view was built ("a later change", `2026-10-22-demo-mode.md:61`); it is dropped.
  The demo and Programs seeds tag coach emails per organization only because of the global unique
  (`20261030010000:562`, `20261101020000:753`); harmless, left.

**Tests and E2E.** Deleted: `coach_view.feature`, `field_permits_coach.feature`,
`Pillar2_CoachDailyLoop.feature`, `privacy_server_reads.feature`; Vitest `coachHome`,
`coachHomePermits`, `coachHomeServerReads`, `coachPermitsPage` (re-aimed at the admin page),
`coachViewRbac`, `linkMyCoachRecord`, `impersonationAudit`, `teamRecordNonAdmin`; pgTAP
`coach_view.sql`. Moved to an admin persona: `calendar_sync`, `team_portal_practice_changes`,
`schedule_exports` (coach scenario goes), `rbac_multi_tenancy` (Coach Alice becomes an account
with no membership), `visual_rbac_enforcement`, `practice_lighting_overrides`, `accessibility`
(four coach scans, `:89,100,184,195`), real-backend `real_backend_permits.feature` and its seed
(`tests/e2e/real-backend/seed.sql:150-245`). pgTAP personas: `_fixtures.sql` and
`rls_policy_matrix.sql` seed `coach` members (Charlie, coach2_a), which the new role check
refuses; they become signed-in accounts with no membership whose coach rows stay as data.
`coach@squadlogic.app` and `TEST_COACH_EMAIL` go from `auth_setup.ts:20,130`, the steps files and
`ci.yml:253`.

**Docs.** AGENTS.md section 2 ("Coaches are stored with name and the email they sign in with"),
`docs/product.md:19-24,44-45` (the Coach user row; decision log), `docs/security/rls-policies.md`,
`docs/agents-reference.md` (RBAC, `TEST_COACH_EMAIL`), `README.md`,
`docs/architecture/frontend-architecture.md`, `docs/architecture/gotsport-import-contract.md`
("sign-in email"), `docs/operations/ENVIRONMENT.md`, and a note atop the admin-focus, Phase C and
prefs plans pointing here.

## Calendar subscription feed

Today (_statically reviewed_): `TeamRecordPage.jsx:183-187` offers "Subscribe to Calendar" to
whoever opens a team page (admins, and a team's current coaches); the token is read under
`team_calendar_tokens_select` and rotated by `rotate_calendar_token` (admin or current coach); the
`calendar-feed` Edge Function serves the `webcal://` URL to **anyone holding the token**, with no
sign-in. So it is the one way a coach or a family gets a live schedule, through a link an admin
hands out. Production: 0 tokens, 0 teams. **Recommendation: keep it, admin-only** (decision 1):
it costs nothing to keep, it is an admin's distribution channel rather than a coach screen, and
removing it means an Edge Function, a table, a trigger, an RPC and `admin_delete_team`'s counter.

## Admins in more than one organization

What holds today (_statically reviewed_ unless marked):

- **Membership allows it.** `organization_members` has `PRIMARY KEY (organization_id, profile_id)`
  and no unique on `profile_id` (`20260331000000:226-232`; no later index or constraint, grep).
- **The server has no "active organization".** Every policy and RPC takes the row's or the
  argument's organization (`is_org_admin(organization_id)`); no function or policy authorizes
  through `profiles.organization_id` (_executed_ catalogue scan). The Edge Functions check
  membership per (organization, user) (`auth.ts:92-139`).
- **Joining and creating work for a member elsewhere.** `redeem_org_invite` only short-circuits a
  member of the *same* organization (`20260421034626:164-234`); `initialize_new_tenant` has no
  membership test (`20260913000000:73`).
- **The app loads and switches.** `OrganizationContext.jsx:194-229` reads every membership, picks
  the stored one (`squadlogic_active_org`) or the first; `switchOrganization` (`:247-258`) swaps
  organization, role and seasons; the TopBar menu lists them (`TopBar.jsx:205-212`).

Gaps and fixes:

1. **A redeemed invite leaves the admin in their old organization.** `InvitePage.jsx:73-80` and
   `AccountSettingsPage.jsx:153-157` refetch, and the refetch prefers the stored organization.
   Fix: `refetchOrgs(preferredOrgId)` stores the redeemed organization's id first.
2. **Audits addressed by `profiles.organization_id`.** `AccountModule.jsx:33`,
   `SeasonModule.jsx:66,96,140,202` and `AuthContext.jsx:191-198` take the organization from the
   profile, which is null on every production profile (_executed_), so those audit rows are skipped
   today; the password fallback reads `organization_members ... .single()`, which errors for an
   admin of two. Fix: the active organization (`currentOrganization.id`) everywhere.
3. **The stored season id is one global key** (`seasonSelection.js:66-73`). It is validated against
   the switched-to organization's seasons and falls back to the active one (`:55-62`): safe, left.
4. **Nothing proves it.** No test switches a two-organization admin. Fix: Vitest and E2E (Tasks).

## Coaches as data in more than one organization

- **Drop `coaches.user_id`** with its FK and unique (nothing reads it once the functions above go)
  and the production-only `coaches.profile_id` (`DROP COLUMN IF EXISTS`; 0 set; decision 6).
- **Per-organization uniqueness.** Replace `coaches_email_key` with
  `CHECK (email = lower(btrim(email)))` (production: 0 rows violate it) and
  `UNIQUE (organization_id, email)`. A coach serving two clubs is two rows, one per organization,
  each assigned within its own organization. `finalize_coach_import_job` (md5 guard) looks up
  `organization_id = job's AND email = v_email` and loses the cross-organization refusal; its mock
  twin follows. `supabase/seed.sql:430,456,482,508` (`ON CONFLICT (email)`) becomes
  `ON CONFLICT (organization_id, email)`.
- **Compatible with Phase E3** (one coach row per season per organization): E3 replaces this key
  with `UNIQUE (organization_id, season_settings_id, email)`, a strictly looser key, and scopes the
  finalizer's lookup by season too. Nothing here assumes one row per (organization, email) beyond
  that lookup, and the normalisation CHECK carries over unchanged.
- **The email stays**, as the import's identity key and the admins' contact (the master export's
  "Coach Emails" column, admin-only); it is no longer a sign-in (decision 3).

## Effect on approved plans

- **Coach preference rules (`2026-10-26-coach-preference-rules.md`, branch `...-prefs-plan`).**
  Recommendation, not a rewrite: **admins record each team's rules directly.** Keep rules per team,
  several values per condition, keep-current, the date window, must and prefer, the solver and
  repair changes, conflicts on the approval preview, and the backfill (nothing to move today:
  0 rows). Drop: coach screens, "ask for must", `requested_level`, `must_decision`, the Pending
  musts list, `admin_decide_must_preference`, withdraw-by-coach and every admin notification and
  the bell (decision 4 there). `coach_priority` stays optional, recorded by the admin as the coach
  said it (decision 5). RLS: admins only. P2 shrinks to the admin rule editor and conflicts view.
- **Phase C permits (`2026-10-22-phase-c-permits.md`).** C1 and C2 stand (admin upload in Fields &
  Venues, `FieldPermitsSection.jsx`, and the admin home's warnings, `DashboardPage.jsx:141`). C3's
  coach read is withdrawn; its page becomes the admins' (decision 4).
- **Admin focus (`2026-10-22-admin-focus.md`).** R6 and R7's coach halves are undone here; R6's
  admin-only score entry, standings and lighting stand.

## Against the rules

- **Rule 14** (persistence, domain model, roles): this plan, waiting for the owner.
- **Rule 2 / refactor in its own PR:** none is needed first; every edit is a removal or narrowing.
- **No Broken Main / backward compatible:** PR 1 stops every caller before PR 2 drops anything.
- **Never edit an applied migration; CI is the only writer:** new migrations only; the catalogue
  snapshot regenerated by `scripts/dbharness/catalog_snapshot.py`.
- **Data minimisation (section 2):** narrowed further (a coach's account link goes); text updated.
- No ADR folder exists; the decision is recorded here and in `docs/LESSONS_LEARNED.md` once built.

## Design (server, PR 2)

Migration `20261103010000_admin_only.sql`, in this order: header naming each object and its
source line; md5 guards (`md5(replace(p.prosrc, E'\r', ''))`, as `20261102010000:870`) for every
replaced body (`create_org_invite`, `admin_change_member_role`, `get_team_roster`,
`get_team_staff`, `rotate_calendar_token`, `get_facility_permits`, `facility_permit_json`,
`finalize_coach_import_job`, `reconcile_prod_rls_drift`) read from production and equal to the
repo's latest; the role guard (refuse while a `coach` member or unused invite exists; NOTICE the
counts); policies narrowed by ALTER POLICY (storage by ALTER POLICY only); callers replaced; then
the coach-only functions dropped by exact signature, no CASCADE; the role checks; the coach email
key; an end-state check (no function body or policy names `user_id` on `coaches`, `'coach'` as a
role, or a dropped helper; each narrowed policy's expression is admin-only).
Migration `20261103020000_drop_coach_user_link.sql`: drops `coaches.user_id` (its FK to
`auth.users` goes with it) and `profile_id`, apart, so a refusal there leaves the first applied.
Each has `docs/sql/<v>_revert.sql` and `_smoke.sql`; a revert restores structure (role values,
functions, policies, the columns, the global email unique, refused while two organizations share
an email) and never the deleted link (stated in its header: production loses one link, the
admin's own).

## Risks and rollback

- **Dropping a column with an FK to `auth.users`** removes the FK's internal triggers on a table
  `postgres` does not own; a plain `DROP TRIGGER` there has failed before. — **watch:** the
  second migration's CI deploy. — **if refused:** the first migration stands; replace the second
  with "NULL the column, drop its unique" and record the column as dead, declared.
- **A body differs in production** (CRLF has bitten before). — **watch:** the md5 guards stop the
  deploy. — **if it happens:** read production's body, reconcile, re-guard.
- **A writer inserts a non-normalised email** after the CHECK. — **watch:** 23514 in an import or
  the demo seed. — the finalizer already lowercases; the smoke runs the demo seed and Programs.
- **Rollback:** each revert script; the frontend reverts with its PR.

## Tasks

**PR 1, frontend, mock and tests (no migration).** Merges first; nothing it changes needs the
server change, and nothing it leaves calls an object PR 2 drops.

- [ ] F1 Remove the coach role from `permissions.js`, `navigation.js`, SideNav, Members and
  Invites; invite roles admin and staff — `tests/usePermission.test.js` and
  `tests/adminRolesParity.test.js`: no role outside `ADMIN_ROLES` has a permission or a nav;
  `tests/InvitesSettings.test.jsx`: the role options are exactly Admin and Staff (planted: coach
  left in `ASSIGNABLE_ROLES` fails).
- [ ] F2 Remove the coach home, its cards, My Team, `useMyCoachedTeams`, the preference request
  UI, the role preview and impersonation, the link call — `tests/dashboardHomeRole.test.jsx`
  (new): an admin, staff and tenant_admin get the admin home, any other role `NoRoleHome`;
  `tests/organizationContextSeasonDefault.test.jsx` asserts no `link_my_coach_record` call; knip
  green proves nothing left orphaned.
- [ ] F3 `/permits` as the admins' "Field Permits" page in the Scheduling nav, linking to Fields
  & Venues for upload — `tests/coachPermitsPage.test.jsx` renamed `permitsPage.test.jsx`: an admin
  sees every permit with Open and Download; a non-admin route redirects.
- [ ] F4 Calendar rotate and lighting names admin-only; `useScorableGames` admin-only —
  `tests/useScorableGames.test.jsx`, `tests/practiceLightingOverridesUi.test.jsx`.
- [ ] F5 Multi-organization gaps 1 and 2 — `tests/organizationSwitch.test.jsx` (new): a two-org
  admin switches and each page read carries the switched organization's id; a redeemed invite
  lands in the redeemed organization (planted: the old refetch); every audit call from Account
  and Season settings and the password change names the active organization. E2E
  `multi_org_admin.feature` (new): an admin of Org A and Org B switches and sees each one's teams.
- [ ] F6 Mock: coach persona and coach arms out; the coach account becomes a non-member —
  `tests/mockReadPolicies.test.js`, `tests/mockServerSideReads.test.js`,
  `tests/mockFacilityPermits.test.js`: a non-member reads nothing.
- [ ] F7 E2E features and steps as inventoried; `TEST_COACH_EMAIL` out of `ci.yml` and docs —
  `npm run test:e2e` (mock) and the real-backend permits scenario as admin.

**PR 2, server.**

- [ ] S1 `20261103010000` as designed — pgTAP `supabase/tests/admin_only.sql` (new): the role checks
  refuse `coach` (23514) and `create_org_invite(..., 'coach')` raises 22023; each dropped function
  is absent; each narrowed policy and `get_facility_permits` admit an admin and refuse an
  authenticated non-member and another organization's admin; the coach-read storage object is
  refused to a non-admin; `reconcile_prod_rls_drift()` runs clean; a catalogue check that every
  role `organization_members_role_check` admits is in `ADMIN_ROLES` (so `is_org_member` stays an
  admin test).
- [ ] S2 Coach email per organization — pgTAP `import_allowlist.sql` gains: one email imported
  into two organizations makes two rows; a re-import in one organization updates its row; a
  mixed-case email is stored lower-case; `ON CONFLICT (organization_id, email)` in `seed.sql`.
- [ ] S3 `20261103020000` — pgTAP: `coaches` has no `user_id` or `profile_id`.
- [ ] S4 Existing pgTAP moved off the coach persona: `_fixtures.sql`, `rls_policy_matrix.sql`,
  `identity_guards.sql`, `server_side_reads.sql`, `facility_permits.sql`,
  `storage_facility_permits_bucket.sql`, `coach_practice_preferences_rpc.sql`, `game_score_rpc.sql`,
  `staff_is_admin.sql`, `definer_function_grants.sql`; deleted `coach_view.sql`.
- [ ] S5 Harness `scripts/dbharness/prove.sh`: `M53`/`R53` and `M54`/`R54`; plants, each run and
  failing: a coach arm back in `get_facility_permits`; `coach` left in the role check; the
  finalizer's lookup unscoped by organization; `reconcile_prod_rls_drift`'s spec still naming
  `user_id`; an md5 guard skipped on a changed body; reverts checked by catalogue fingerprint
  against a build at `20261102010000`. Older smokes that call dropped objects reduced to "stays
  gone", their plants retired or re-aimed, as R2 did.
- [ ] S6 `supabase/catalog-snapshot.json` regenerated; docs listed above.

- [ ] S7 **Coach-to-child link in the coach import** (owner, 2026-10-27). Today nothing in
  production writes `coach_team_requests`, so no coach anchors a team. The coach import gains an
  optional column naming the coach's children by player registration id (one or more, separated by
  `;` or `,`; header aliases such as `Child Registration ID`, `Player ID`), on the import
  allowlist. `finalize_coach_import_job` writes one `coach_team_requests` row per id that matches a
  player of the same organization (the same season once E3a lands); an id that matches nothing is
  listed in the import's result and is never fatal; a re-import replaces that coach's imported
  links. Players are imported before coaches; the import screen says so. pgTAP: two ids make two
  links; an unknown id is reported and writes nothing; another organization's player is never
  linked; a re-import replaces the links. Mock twin and an E2E: import players, then coaches with a
  child column, then generate teams: the coach's child anchors the coach's team.

## Done when

- [ ] Every task's test passes on its branch and every new check was shown failing first.
- [ ] Unchanged, each tested: an admin's per-team CSV, XLSX and calendar downloads and the master
  XLSX (`teamScheduleExport.test.js`, `schedule_exports.feature` admin scenarios); admin permit
  upload and delete (`facility_permits.sql`); score entry and standings behind their settings
  (`game_score_rpc.sql`); the coach import and rollback (`ingestion_hardening.feature`); team
  coach assignment (`teamCoaches.test.js`); the season fixture suite.
- [ ] The Definition of Done gates (AGENTS.md section 3), and the full gate, pass.

## Decisions for the owner (each with a recommendation)

1. **Calendar subscription feed:** keep, admin-only (recommended), or remove it.
2. **Role preview and impersonation:** remove entirely (recommended: its only target was a coach,
   and nothing could start it), or keep the machinery dormant.
3. **Coach email:** keep as the import key and admin contact, unique per organization
   (recommended).
4. **Permits:** `/permits` becomes the admins' Field Permits page with Open and Download, upload
   stays in Fields & Venues (recommended), or upload on `/permits` too.
5. **Coach preference rules:** admins record rules directly as above (recommended); keep
   `coach_priority` as an admin-recorded optional field (recommended) or drop it.
6. **`coaches.profile_id`** (production-only drift, 0 rows set): drop with `user_id`
   (recommended).

No question blocks PR 1; decisions 1, 2 and 4 shape it, and each has a default.

## Owner decisions (2026-10-27)

All six accepted as recommended. Decision 5 is amended: coaches never enter preferences; admins
collect them by other means (a Google Form, for example) and **import** them. A preference may be
requested as a must in the file, but it counts as a must only after an admin accepts it in the app;
an **Accept all** action covers a file an admin already reviewed before importing. The preference
plan (`2026-10-26-coach-preference-rules.md`) records the details. The coach-to-child link comes in
through the coach import (S7).
