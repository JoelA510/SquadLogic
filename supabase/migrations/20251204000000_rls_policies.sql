-- Enable Row Level Security (RLS) on all tables
-- and provide full access policies for administrators.

begin;

-- 1. Helper Functions
create or replace function public.current_user_role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')::text;
$$;

create or replace view public.coach_team_map as
select
    c.user_id as coach_user_id,
    t.id as team_id
from coaches c
join teams t on t.coach_id = c.id
where c.user_id is not null
union
select
    c.user_id as coach_user_id,
    t.id as team_id
from coaches c
join teams t on c.id = any(t.assistant_coach_ids)
where c.user_id is not null;

-- 2. Enable RLS on all tables
alter table season_settings enable row level security;
alter table divisions enable row level security;
alter table players enable row level security;
alter table coaches enable row level security;
alter table locations enable row level security;
alter table fields enable row level security;
alter table field_subunits enable row level security;
alter table practice_slots enable row level security;
alter table game_slots enable row level security;
alter table teams enable row level security;
alter table team_players enable row level security;
alter table practice_assignments enable row level security;
alter table games enable row level security;
alter table import_jobs enable row level security;
alter table staging_players enable row level security;
alter table player_buddies enable row level security;
alter table scheduler_runs enable row level security;
alter table evaluation_runs enable row level security;
alter table evaluation_findings enable row level security;
alter table evaluation_metrics enable row level security;
alter table evaluation_run_events enable row level security;
alter table export_jobs enable row level security;
alter table email_log enable row level security;

-- 3. Create Admin Policies (Full Access)
-- Pattern: Allow ALL operations if the user has the 'admin' role.

-- season_settings
create policy "Admins can do everything on season_settings"
  on season_settings for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- divisions
create policy "Admins can do everything on divisions"
  on divisions for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- players
create policy "Admins can do everything on players"
  on players for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

create policy "Coaches can view roster names (masked)"
  on players for select
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

-- coaches
create policy "Admins can do everything on coaches"
  on coaches for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

create policy "Coaches can view own profile"
  on coaches for select
  to authenticated
  using (
    (auth.jwt() ->> 'role') = 'coach'
    and user_id = auth.uid()
  );

create policy "Coaches can update own profile"
  on coaches for update
  to authenticated
  using (
    (auth.jwt() ->> 'role') = 'coach'
    and user_id = auth.uid()
  )
  with check (
    (auth.jwt() ->> 'role') = 'coach'
    and user_id = auth.uid()
  );

-- locations
create policy "Admins can do everything on locations"
  on locations for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- fields
create policy "Admins can do everything on fields"
  on fields for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- field_subunits
create policy "Admins can do everything on field_subunits"
  on field_subunits for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- practice_slots
create policy "Admins can do everything on practice_slots"
  on practice_slots for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- game_slots
create policy "Admins can do everything on game_slots"
  on game_slots for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- teams
create policy "Admins can do everything on teams"
  on teams for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

create policy "Coaches can view their teams"
  on teams for select
  to authenticated
  using (
    (auth.jwt() ->> 'role') = 'coach'
    and exists (
      select 1
      from public.coach_team_map ctm
      where ctm.team_id = teams.id
        and ctm.coach_user_id = auth.uid()
    )
  );

-- team_players
create policy "Admins can do everything on team_players"
  on team_players for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- practice_assignments
create policy "Admins can do everything on practice_assignments"
  on practice_assignments for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- games
create policy "Admins can do everything on games"
  on games for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- import_jobs
create policy "Admins can do everything on import_jobs"
  on import_jobs for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- staging_players
create policy "Admins can do everything on staging_players"
  on staging_players for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- player_buddies
create policy "Admins can do everything on player_buddies"
  on player_buddies for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- scheduler_runs
create policy "Admins can do everything on scheduler_runs"
  on scheduler_runs for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- evaluation_runs
create policy "Admins can do everything on evaluation_runs"
  on evaluation_runs for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- evaluation_findings
create policy "Admins can do everything on evaluation_findings"
  on evaluation_findings for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- evaluation_metrics
create policy "Admins can do everything on evaluation_metrics"
  on evaluation_metrics for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- evaluation_run_events
create policy "Admins can do everything on evaluation_run_events"
  on evaluation_run_events for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- export_jobs
create policy "Admins can do everything on export_jobs"
  on export_jobs for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

-- email_log
create policy "Admins can do everything on email_log"
  on email_log for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

commit;
