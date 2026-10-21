[← Back to Documentation Index](docs/README.md)
---

# Row Level Security — Implementation Reference

This document describes the **implemented** Row Level Security (RLS) strategy for the SquadLogic Supabase PostgreSQL database. All policies are organization-scoped via the `is_org_member()` helper function.

## Roles & Auth Model

SquadLogic uses Supabase Auth with five logical roles stored in the `organization_members` table:

| Role     | Description                                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| `admin`  | Full access to all organization data. Can manage users, import data, and run schedulers. |
| `coach`  | View team data they are assigned to. Can update RSVP and participate in team chat.       |
| `player` | Limited access to own team data and schedule views.                                      |
| `parent` | View child's team schedule and public calendar feeds.                                    |
| `staff`  | An admin: `is_org_admin()` admits staff since `20261020030000`.                          |

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
until `20261021020000` narrowed its read to admins and the player's guardians; `teams` still has a
member read):

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
`(select ...)`. `registration_forms` and `season_settings` test the role inline,
`om.role IN ('admin', 'staff')`, narrower than `is_org_admin()` by `tenant_admin` (remediation plan,
RLS Q5, open), as do the `audit_log` and `organization_schema_history` SELECT policies.
`supabase/tests/staff_is_admin.sql` fails on any policy or function that names `'admin'` as a role
without `'staff'`. `registration_forms` (INSERT shown; UPDATE carries the same expression in
`USING` and `WITH CHECK`, DELETE in `USING`):

```sql
CREATE POLICY "registration_forms_admin_insert" ON public.registration_forms
  FOR INSERT TO authenticated
  WITH CHECK (
    is_org_member(organization_id) AND
    EXISTS (
      SELECT 1 FROM public.organization_members om
      WHERE om.profile_id = (select auth.uid())
        AND om.organization_id = registration_forms.organization_id
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

Who may read people's data is the access table in `docs/changes/2026-10-20-phase-a-privacy.md`
(A3). Admins and staff read the tables directly. Everyone else reads through definer functions
that apply the table (migration `20261021010000`; pgTAP `supabase/tests/server_side_reads.sql`):

| Function                       | Admits                                                         | Returns                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_team_roster(team)`        | admins, staff; a current coach of the team; a guardian on it   | names, jersey number; guardian contacts in full to admins, staff, the coach and a player's own guardians, a teammate's primary contact to other guardians unless `guardian_contact_sharing` is off; balance fields to admins and staff only |
| `get_team_staff(team)`         | the same                                                       | every current coach's name, role, phone and email                                                                                                                                                                                              |
| `get_coach_directory(org)`     | admins, staff; a current coach while `coach_directory` is on   | every current coach's contact details                                                                                                                                                                                                            |
| `get_my_coached_team_ids(org)` | any member                                                     | the teams the caller currently coaches                                                                                                                                                                                                           |
| `admin_get_coached_team_ids(org, user)` | admins, staff                                         | the teams another member currently coaches (an admin's role preview)                                                                                                                                                                             |

"Current coach" is a `team_coach_assignments` row of the caller's linked coach (`coaches.user_id`,
set by `link_my_coach_record()`) whose inclusive window holds today in the team's season timezone
(`team_local_today()`, UTC when unset). "Guardian" is a `profile_players` link, written by in-app
registration or by `link_my_guardian_records()` from a matching verified email; the link keeps
the imported address it matched (`profile_players.matched_email`). A refused call
raises 42501, the same for a team that does not exist. A user's contact card
(`profiles.contact_phone`, `contact_email`, `share_contact`, written only by
`set_my_contact_card()`) replaces imported details wherever these functions return them; an
unshared card returns none.

Since `20261021020000` (A3b) those functions are the only non-admin path. A member who is not an
admin or staff reads `players` and `team_players` only for their own children (and only while a
member of the child's organization), `coaches` and `team_coach_assignments` only for their own
coach record (again only while a member), `profile_players` only their own links (the same), and `staging_players` and
`staging_import_rows` not at all. A team's calendar feed token lives in `team_calendar_tokens`,
readable by admins and staff, the team's current coaches and its guardians;
`rotate_calendar_token` admits admins, staff and a current coach. `update_game_score` admits admins
and staff for any game and anyone else only for a game of a team they currently coach. The
migration refuses to commit if any other `SELECT` or `ALL` policy is left on one of these tables,
since Postgres would OR it with the narrowed one. Pinned by `supabase/tests/rls_policy_matrix.sql`
and `supabase/tests/restricted_reads.sql`.

## Organization Scoping

Every data table has a direct `organization_id` column (either native or backfilled via migration). This eliminates the need for multi-table JOINs in RLS policies and ensures consistent, performant access control:

| Table Group         | Tables                                                                                                    | Scope Method                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Core Admin**      | `season_settings`, `divisions`, `import_jobs`                                                             | Direct `organization_id`                            |
| **People**          | `players`, `coaches`, `profiles`                                                                          | Direct `organization_id` (profiles: self-only)      |
| **Teams & Rosters** | `teams`, `team_players`                                                                                   | Direct `organization_id`                            |
| **Facilities**      | `locations`, `fields`, `field_subunits`                                                                   | Direct `organization_id`                            |
| **Scheduling**      | `practice_slots`, `game_slots`, `practice_assignments`, `games`                                           | Direct `organization_id`                            |
| **Communication**   | `event_rsvps`, `team_messages`, `profile_players`                                                         | Direct `organization_id`                            |
| **Evaluation**      | `scheduler_runs`, `evaluation_runs`, `evaluation_findings`, `evaluation_metrics`, `evaluation_run_events` | Direct `organization_id`                            |
| **Exports & Logs**  | `export_jobs`, `email_log`, `audit_log`                                                                   | Direct `organization_id`                            |
| **Registration**    | `registration_forms`, `registrations`                                                                     | Direct `organization_id` via `organization_members` |
| **Staging**         | `staging_players`, `player_buddies`                                                                       | Direct `organization_id`                            |
| **Heat forecast**   | `organization_heat_settings`                                                                              | Direct `organization_id` (PK); members SELECT, no write policy -- `admin_set_org_heat_settings` only |

## Storage buckets

Both buckets are private, and their `storage.objects` policies scope every object to the
organization named by the first folder of its path (`<organization_id>/...`):

| Bucket        | Who may                                                                                                                 | Migration                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `raw-imports` | Members read and upload under their organization's folder; no delete                                                    | `20260421001043`, `20260602010000` |
| `exports`     | Members read (`is_org_member`); admins upload and remove (`is_org_admin`), under their organization's folder; no update | `20261017000000`                   |

Only an administrator uploads or removes exports, as only an administrator reaches the Exports page
and records the publication baseline beside the upload. The admin DELETE makes a publish all or
nothing: when one file is refused, the panel removes the ones that uploaded, through the Storage API
(Supabase refuses SQL deletes on `storage.objects`), and names any it could not remove. The
`exports` policies are `TO authenticated` and refuse, rather than fail on, a first folder that is
not a UUID. The Exports page's "Upload to Storage" builds its paths with `exportObjectPath`
(`packages/core/src/storageSupabase.js`) and uploads without upsert, since there is no UPDATE
policy. Retention, if wanted, runs as the service role. pgTAP:
`supabase/tests/storage_exports_bucket.sql`.

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

| Phase            | Migration        | What Changed                                                       |
| ---------------- | ---------------- | ------------------------------------------------------------------ |
| Original         | `20251208000000` | Admin-only role check policies (no org scope)                      |
| Auth             | `20251214000004` | Core auth schema, profiles, organization_members                   |
| Communication    | `20251217000000` | Team messages, RSVP tables with partial org scope                  |
| RLS Remediation  | `20260309000000` | `coach_team_map` security_invoker fix                              |
| Unified RLS      | `20260310000002` | `organization_id` denormalization, `is_org_member()` on all tables |
| Registration Fix | `20260310000003` | Fixed policies referencing non-existent `organization_roles` table |
| Audit Logging    | `20260324000004` | Append-only `audit_log` table with admin-read-only RLS             |
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
