## [← Back to Documentation Index](docs/README.md)

# Row Level Security — Implementation Reference

This document describes the **implemented** Row Level Security (RLS) strategy for the SquadLogic Supabase PostgreSQL database. All policies are organization-scoped via the `is_org_member()` helper function.

## Roles & Auth Model

SquadLogic uses Supabase Auth with the organization roles stored in the `organization_members`
table (`organization_members_role_check`):

| Role    | Description                                                                              |
| ------- | ---------------------------------------------------------------------------------------- |
| `admin` | Full access to all organization data. Can manage users, import data, and run schedulers. |
| `staff` | An admin: `is_org_admin()` admits staff since `20261020030000`.                          |

`tenant_admin` is also an admin to `is_org_admin()`, and is never invited or assigned. **Only league
admins sign in.** There is no `parent` or `player` role since `20261024010000` (the guardian view was
removed; plan `docs/changes/2026-10-22-admin-focus.md`, R3) and no `coach` role since `20261104010000`
(plan `docs/changes/2026-10-27-admin-only.md`): the member check admits `admin`, `staff` and
`tenant_admin`, the invite check `admin` and `staff`, and `create_org_invite` and
`admin_change_member_role` refuse any other role (22023). A coach is a row in `coaches` that admins
manage (imported data); no coach signs in, and `coaches` has no `user_id` or `profile_id`
(`20261104020000`). Because every member is therefore an admin, `is_org_member()` is an admin test
by construction; `supabase/tests/admin_only.sql` pins the role list so that stays true.

Roles are defined in `frontend/src/constants/permissions.js` and enforced via:

- **Database**: `is_org_member(organization_id)` RLS policies on every table
- **Frontend**: `usePermission` hook + `<ProtectedRoute>` component
- **Edge Functions**: JWT validation + role allowlist checks

## Primary RLS Helper: `is_org_member()`

The `is_org_member(org_id UUID)` SQL function is the cornerstone of all RLS policies. It verifies that the authenticated user has an active membership in the specified organization by checking the `organization_members` table:

```sql
CREATE OR REPLACE FUNCTION is_org_member(org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members
    WHERE organization_id = org_id
      AND profile_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

A table that members read and admins write follows this shape (`players` as it stood from the
rewrite `20261018030000_rls_advisor_rewrite.sql`, which split the admin `FOR ALL` policy by command,
until `20261021020000` narrowed its read to admins and the player's guardians, and
`20261024010000` to admins; `teams` still has a member read):

```sql
-- Members read: one SELECT policy, the only one a SELECT evaluates.
CREATE POLICY "players_select_member" ON public.players
  FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

-- Admins write: one policy per command, not FOR ALL.
CREATE POLICY "players_insert_admin" ON public.players
  FOR INSERT TO authenticated
  WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY "players_update_admin" ON public.players
  FOR UPDATE TO authenticated
  USING (public.is_org_admin(organization_id))
  WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY "players_delete_admin" ON public.players
  FOR DELETE TO authenticated
  USING (public.is_org_admin(organization_id));
```

`is_org_admin()` admits the roles `admin`, `tenant_admin` and `staff` (staff since
`20261020030000`: staff are admins). A policy that reads the caller itself wraps `auth.uid()` in
`(select ...)`. `season_settings` tests the role inline,
`om.role IN ('admin', 'staff')`, narrower than `is_org_admin()` by `tenant_admin` (remediation plan,
RLS Q5, open), as do the `audit_log` and `organization_schema_history` SELECT policies
(`registration_forms` did too, until `20261022020000` dropped it with the in-app registration
flow). `supabase/tests/staff_is_admin.sql` fails on any policy or function that names `'admin'` as
a role without `'staff'`. `season_settings` (INSERT shown; UPDATE carries the same expression in
`USING` and `WITH CHECK`, DELETE in `USING`):

```sql
CREATE POLICY "Season Settings: admins insert" ON public.season_settings
  FOR INSERT TO authenticated
  WITH CHECK (
    is_org_member(organization_id) AND
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.profile_id = (select auth.uid())
        AND om.organization_id = season_settings.organization_id
        AND om.role IN ('admin', 'staff')
    )
  );
```

Admin-owned configuration tables may be narrower. `divisions` allow organization members to
read division settings, but only organization admins can insert, update, or delete division
rows because roster-size and team-count constraints control downstream generation behavior.
The `enforce_division_season_org_match` trigger also requires each division row to match its
season settings organization.

Since `20261018030000_rls_advisor_rewrite.sql`, a table with both a member `SELECT` policy and
an admin write policy carries the write as three policies, `FOR INSERT`, `FOR UPDATE` and
`FOR DELETE` (`players_select_member`, `players_insert_admin`, `players_update_admin`,
`players_delete_admin`), not as one `FOR ALL`: beside the member policy, an admin `FOR ALL` is a
second permissive `SELECT` policy, which Supabase's `multiple_permissive_policies` advisor flags.
A table whose only policy is an admin `FOR ALL` (`coach_team_requests`) has no second one. A policy that
reads the caller calls `(select auth.uid())`, not `auth.uid()`, so Postgres evaluates it once
per statement (the `auth_rls_initplan` advisor). The advisors gate in the pgTAP job fails a
pull request that brings either back (`docs/operations/ci-cd.md`, "Supabase advisors").

## Server-side reads (Phase A3)

Who may read people's data was the access table in `docs/changes/2026-10-20-phase-a-privacy.md` (A3);
since `20261104010000` every row of it that admitted a coach is gone, and only admins and staff read.
Admins and staff read the tables directly, and the roster and staff reads for a team (migrations
`20261021010000`, `20261104010000`; pgTAP `supabase/tests/server_side_reads.sql`):

| Function                | Admits        | Returns                                                                                                |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `get_team_roster(team)` | admins, staff | the team's players: names, jersey number, gender, years played, rating, coaching interest; no contacts |
| `get_team_staff(team)`  | admins, staff | the team's current coaches: name, role and status (no phone or email since `20261025010000`)           |

A coach is "current" when a `team_coach_assignments` row of theirs has an inclusive window that holds today
in the team's season timezone (`team_local_today()`, UTC when unset); that is data an admin reads, not a
sign-in. A refused call (a non-admin, another organization's admin, an unknown team) raises 42501. There is no
guardian since `20261024010000` and no coach caller since `20261104010000`: the coached-team and
division-team reads, `link_my_coach_record()` and the role preview that used them are dropped.

**No read returns an email or phone to a non-admin** (`20261025010000`, R4 of
`docs/changes/2026-10-22-admin-focus.md`): the contact card, `get_coach_directory()` and the
`coach_directory` setting are gone, and `get_organization_members()`, which returns every member's sign-in
email, admits admins and staff only. The only functions `authenticated` may execute whose result names an
email, phone, contact or guardian column are `get_organization_members` and `get_settings_audit_log`, both
admin-only; the migration's end-state check, its smoke and `supabase/tests/contact_surfaces_removed.sql` hold
the catalogue to that (a function returning `jsonb` or a bare `record` is not seen). Admins read a coach's
email from `coaches` directly, on the Coaches page; it is the coach import's key and an admin's contact, not a
sign-in (unique per organization, stored lower-case and trimmed).

The reads that had a coach arm are admin reads (`is_org_admin(organization_id)`) since `20261104010000`:
`coaches` (`coaches_select_admin`, the only read policy on the table), `team_coach_assignments`,
`team_calendar_tokens` (an admin reads and `rotate_calendar_token` rotates the feed token; the calendar
subscription links stay, admin-only), `coach_practice_preferences`, `practice_lighting_overrides`,
`facility_permits`, `facility_permit_scopes` and the `facility-permits` storage objects. `players` and
`team_players` are read by admins and staff only (`20261024010000`), and `staging_players` and
`staging_import_rows` likewise. `update_game_score` admits admins and staff only, and only while the
organization's `score_entry` setting is on (`20261028010000`). No coach requests anything: the coach
preference request RPC and the lighting request RPC are dropped; admins record preferences
(`admin_set_coach_practice_preference`) and decide them. The migration refuses to commit if any other
`SELECT` or `ALL` policy is left on `coaches`, since Postgres would OR it with the narrowed one, and
`reconcile_prod_rls_drift()` holds that too. Pinned by `supabase/tests/rls_policy_matrix.sql`,
`supabase/tests/restricted_reads.sql` and `supabase/tests/admin_only.sql`.

## Organization Scoping

Every data table has a direct `organization_id` column (either native or backfilled via migration). This eliminates the need for multi-table JOINs in RLS policies and ensures consistent, performant access control:

| Table Group         | Tables                                                                                                      | Scope Method                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Core Admin**      | `season_settings`, `divisions`, `import_jobs`                                                               | Direct `organization_id`                                                                             |
| **People**          | `players`, `coaches`, `profiles`                                                                            | Direct `organization_id` (profiles: self-only)                                                       |
| **Teams & Rosters** | `teams`, `team_players`                                                                                     | Direct `organization_id`                                                                             |
| **Facilities**      | `locations`, `fields`, `field_subunits`                                                                     | Direct `organization_id`                                                                             |
| **Scheduling**      | `practice_slots`, `game_slots`, `practice_assignments`, `games`                                             | Direct `organization_id`                                                                             |
| **Communication**   | none (`event_rsvps` and `team_messages` dropped by `20261022030000`, `profile_players` by `20261024010000`) | Direct `organization_id`                                                                             |
| **Evaluation**      | `scheduler_runs`, `evaluation_runs`, `evaluation_findings`, `evaluation_metrics`, `evaluation_run_events`   | Direct `organization_id`                                                                             |
| **Exports & Logs**  | `export_jobs`, `email_log`, `audit_log`                                                                     | Direct `organization_id`                                                                             |
| **Staging**         | `staging_players`, `player_buddies`                                                                         | Direct `organization_id`                                                                             |
| **Heat forecast**   | `organization_heat_settings`                                                                                | Direct `organization_id` (PK); members SELECT, no write policy -- `admin_set_org_heat_settings` only |

## Storage buckets

Both buckets are private, and their `storage.objects` policies scope every object to the
organization named by the first folder of its path (`<organization_id>/...`):

| Bucket             | Who may                                                                                                                                                    | Migration                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `raw-imports`      | Members read and upload under their organization's folder; no delete                                                                                       | `20260421001043`, `20260602010000` |
| `exports`          | Members read (`is_org_member`); admins upload and remove (`is_org_admin`), under their organization's folder; no update                                    | `20261017000000`                   |
| `facility-permits` | Admins read, upload and remove, under `<organization>/<permit>/<uuid>.<ext>` for a permit that exists there (no upload for a demo organization); no update | `20261102010000`, `20261104010000` |

Only an administrator uploads or removes exports, as only an administrator reaches the Exports page
and records the publication baseline beside the upload. The admin DELETE makes a publish all or
nothing: when one file is refused, the panel removes the ones that uploaded, through the Storage API
(Supabase refuses SQL deletes on `storage.objects`), and names any it could not remove. The
`exports` policies are `TO authenticated` and refuse, rather than fail on, a first folder that is
not a UUID. The Exports page's "Upload to Storage" builds its paths with `exportObjectPath`
(`packages/core/src/storageSupabase.js`) and uploads without upsert, since there is no UPDATE
policy. Retention, if wanted, runs as the service role. pgTAP:
`supabase/tests/storage_exports_bucket.sql`.

`facility-permits` (private; 10 MiB; PDF, JPEG, PNG) holds permit documents. Its SELECT policy is
admin-only (an object's first folder is the organization, and the name must be
`<organization>/<permit>/<uuid>.<ext>`); until `20261104010000` it also admitted a coach of a team scheduled
on a permitted field, through `coach_reads_facility_permit_file`, which is dropped. The two tables (`facility_permits`,
`facility_permit_scopes`) have one SELECT policy each and no write policy; the five permit RPCs write.
Files open by a signed link made on tap (120 s). pgTAP: `supabase/tests/facility_permits.sql` and
`supabase/tests/storage_facility_permits_bucket.sql`.

## Edge Function Security

Edge Functions use a dual-client pattern:

1. **Service role client** — Used only for the initial `auth.getUser()` call to validate the JWT
2. **Per-request scoped client** — Created using the user's JWT for all data queries, ensuring RLS enforcement

Each Edge Function also performs explicit `organization_id` validation: the user's org membership is verified before any write operation.

Role allowlists per Edge Function:

- `team-persistence`: `admin`, `scheduler` (configurable via `TEAM_PERSISTENCE_ALLOWED_ROLES`)
- `game-persistence`, `practice-persistence`: `admin`
- `calendar-feed`: No JWT required (uses token-based auth with 90-day expiry)
- `import-validation`: `admin`

## Security Views

- **`coach_team_map`** — View joining coaches, teams, and team_players. Created with `security_invoker = true` to ensure RLS applies to the querying user's context.

## Remediation History

The RLS system evolved through multiple migrations, consolidated during a 4-phase security audit (March 2026):

| Phase            | Migration        | What Changed                                                              |
| ---------------- | ---------------- | ------------------------------------------------------------------------- |
| Original         | `20251208000000` | Admin-only role check policies (no org scope)                             |
| Auth             | `20251214000004` | Core auth schema, profiles, organization_members                          |
| Communication    | `20251217000000` | Team messages, RSVP tables with partial org scope (dropped, R2)           |
| RLS Remediation  | `20260309000000` | `coach_team_map` security_invoker fix                                     |
| Unified RLS      | `20260310000002` | `organization_id` denormalization, `is_org_member()` on all tables        |
| Registration Fix | `20260310000003` | Fixed policies referencing non-existent `organization_roles` table        |
| Audit Logging    | `20260324000004` | Append-only `audit_log` table with admin-read-only RLS                    |
| Advisor rewrite  | `20261018030000` | Admin `FOR ALL` split by command; `(select auth.uid())`; no access change |

The pre-production security audit that produced these policies is closed; its remediations are reflected in the migration history (`20260602010000_consolidated_rls_security_hardening.sql` and earlier).

## Testing

RLS enforcement is validated at multiple levels:

- **pgTAP**: `supabase/tests/rls_policy_matrix.sql` — seven personas' read and write access on the 26 tables the advisor rewrite touched, against a literal expected table
- **Unit tests**: `tests/usePermission.test.js` — role-based permission checks
- **Unit tests**: `tests/verifyRpcUsage.test.js` — verifies RPC calls use correct org-scoped patterns
- **E2E tests**: `rbac_multi_tenancy.feature` — cross-org isolation scenarios
- **E2E tests**: `visual_rbac_enforcement.feature` — UI element visibility based on role
- **Edge Function tests**: `tests/calendarFeed.test.js` — token validation and expiry
