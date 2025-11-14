# Row Level Security Strategy

This document converts the data-modeling plan into an actionable Row Level Security (RLS) policy outline for the Supabase Postgres database.  It assumes tables were provisioned using `docs/sql/initial_schema.sql` and focuses on protecting personally identifiable information while still enabling administrators to operate scheduling workflows.

## Roles & Auth Model

Supabase ships with the following JWT claims that map to database roles.  We will lean on three logical personas:

| Persona | Supabase Role | Description |
| --- | --- | --- |
| **Platform services** | `service_role` | Trusted service key used exclusively by serverless functions (ingestion, schedulers, exports). Has full access via `bypassrls`. |
| **League administrator** | `authenticated` with `role = 'admin'` | Primary scheduler using the web UI. Can manage all season data. |
| **Coach/readonly (future)** | `authenticated` with `role = 'coach'` | Optional persona for future portal access. Limited to teams they coach. |
| **Unauthenticated** | `anon` | No direct access.  Only used during onboarding flows that do not touch protected tables. |

Policies reference the claim `auth.jwt() ->> 'role'` to discriminate between personas.  Additional predicates use helper views described below.

## Helper Views & Functions

1. **`public.current_profile()`** – SQL function returning the active user’s Supabase UID and declared `role`.  Simplifies policy predicates.
2. **`public.admin_users`** – View projecting users flagged as administrators (backed by Supabase auth metadata table).
3. **`public.coach_team_map`** – View joining `coaches`, `teams`, and `team_players` to list team IDs accessible to a coach account.
4. **`public.mask_guardian_contacts(raw jsonb)`** – Function that strips phone/email data when a coach without admin permissions queries player records.

These helpers will be added in the first migration that activates RLS so policies can stay concise.

## Policy Matrix

The following table summarizes desired permissions once RLS is enabled.

| Table | Admin | Coach | Notes |
| --- | --- | --- | --- |
| `season_settings` | Full CRUD | Read-only (subset) | Coaches may read season label/dates to show context. |
| `divisions` | Full CRUD | Read-only | Needed to display team divisions. |
| `players` | Full CRUD | Read with masked PII | Coaches can read roster names but guardian contacts/emails are redacted via view/function. |
| `coaches` | Full CRUD | Self-manage (update own availability/contact) | Coach persona may update their own record but cannot view other coach contact info except names. |
| `teams` | Full CRUD | Read teams they coach | Determined via `coach_team_map`. |
| `team_players` | Full CRUD | Read assignments for teams they coach | No cross-team access. |
| `practice_slots` | Full CRUD | Read-only | Enables viewing available slots when exposing schedule dashboards. |
| `practice_assignments` | Full CRUD | Read teams they coach | Allows coaches to view practice schedules. |
| `game_slots` / `games` | Full CRUD | Read teams they coach | Supports schedule visibility. |
| `import_jobs`, `staging_players` | Full CRUD | No access | Contains raw PII and logs reserved for administrators. |
| `player_buddies` | Full CRUD | Read-only via team context | Coaches can see confirmed buddy pairings only for their teams (for communication). |

## Example Policy Definitions

The snippet below illustrates how policies will be authored (final SQL will live in migrations once validated).

```sql
alter table public.players enable row level security;

create policy "Admins can manage players"
    on public.players
    for all
    to authenticated
    using ((auth.jwt() ->> 'role') = 'admin')
    with check ((auth.jwt() ->> 'role') = 'admin');

create policy "Coaches can view roster names"
    on public.players
    for select
    to authenticated
    using (
        (auth.jwt() ->> 'role') = 'coach'
        and exists (
            select 1
            from public.coach_team_map ctm
            join public.team_players tp on tp.team_id = ctm.team_id
            where tp.player_id = players.id
              and ctm.coach_user_id = auth.uid()
        )
    );
```

Additional column-level masking can be handled by exposing roster data to the front end through a security-definer view that calls `mask_guardian_contacts`.  When using `SECURITY DEFINER`, ensure the owning role has only the privileges required for the view and explicitly set a safe `search_path` (for example, `set search_path = ''`) inside the function definition to avoid privilege escalation.  The base table remains protected by RLS policies.

## Enforcement Plan

1. **Migration sequencing** – Introduce helper views/functions, enable RLS, and add policies in the same migration to avoid downtime.
2. **Default deny** – After enabling RLS on a table, add explicit policies for admin/coach personas and rely on the absence of an anonymous policy to deny unauthenticated users.
3. **Testing** – Extend automated tests to cover:
   - Admin JWT performing CRUD across all tables.
   - Coach JWT reading only their team data; ensure attempts to access other teams fail.
   - Anonymous access blocked from all tables.
   - Masking function removes guardian contact info for coaches.
4. **Monitoring** – Instrument serverless functions to log when queries that normally return data instead come back empty, which can signal an unexpected RLS denial, and pair this with database-level auditing (e.g., PostgreSQL `pgaudit`) when available.

## Next Steps

- Translate this strategy into timestamped Supabase migrations under `supabase/migrations/` once local stack is configured.
- Implement Jest integration tests that call Supabase with admin vs. coach JWTs using the test dataset described in `docs/data-modeling.md`.
- Document the helper views/functions in `docs/architecture.md` once implemented so the agent modules know which endpoints to call.
