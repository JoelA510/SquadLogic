-- Create table for storing schedule evaluations
create table if not exists schedule_evaluations (
    id uuid primary key default gen_random_uuid(),
    run_id text, -- Optional link to a scheduler run
    evaluation_type text not null check (evaluation_type in ('practice', 'game', 'combined')),
    status text not null check (status in ('ok', 'attention-needed', 'action-required')),
    summary jsonb not null default '{}'::jsonb, -- High-level metrics
    issues jsonb not null default '[]'::jsonb, -- Array of issue objects
    details jsonb not null default '{}'::jsonb, -- Full evaluation payload
    created_at timestamptz not null default timezone('utc', now()),
    created_by text -- Optional user identifier
);

-- Enable RLS
alter table schedule_evaluations enable row level security;

-- Policies
create policy "Admins can do everything on schedule_evaluations"
  on schedule_evaluations for all
  to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

create policy "Service role can do everything on schedule_evaluations"
  on schedule_evaluations for all
  to service_role
  using (true)
  with check (true);

-- Allow read-only access to authenticated users (e.g. coaches viewing status)
create policy "Authenticated users can view schedule_evaluations"
  on schedule_evaluations for select
  to authenticated
  using (true);
