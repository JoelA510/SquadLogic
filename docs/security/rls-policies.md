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
| `staff`  | Extended read access similar to coach, for non-coaching staff.                           |

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

Most table policies follow this organization-scoped member-access pattern:

```sql
CREATE POLICY "org_scoped_access" ON public.<table_name>
  FOR ALL TO authenticated
  USING (is_org_member(organization_id))
  WITH CHECK (is_org_member(organization_id));
```

Admin-owned configuration tables may be narrower. `divisions` allow organization members to
read division settings, but only organization admins can insert, update, or delete division
rows because roster-size and team-count constraints control downstream generation behavior.
The `enforce_division_season_org_match` trigger also requires each division row to match its
season settings organization.

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

The pre-production security audit that produced these policies is closed; its remediations are reflected in the migration history (`20260602010000_consolidated_rls_security_hardening.sql` and earlier).

## Testing

RLS enforcement is validated at multiple levels:

- **Unit tests**: `tests/usePermission.test.js` — role-based permission checks
- **Unit tests**: `tests/verifyRpcUsage.test.js` — verifies RPC calls use correct org-scoped patterns
- **E2E tests**: `rbac_multi_tenancy.feature` — cross-org isolation scenarios
- **E2E tests**: `visual_rbac_enforcement.feature` — UI element visibility based on role
- **Edge Function tests**: `tests/calendarFeed.test.js` — token validation and expiry
