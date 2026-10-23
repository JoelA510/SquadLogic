-- Smoke checks for 20260611000000_player_roster_fields.sql

-- 1. New columns exist with expected types (since 20261022020000 dropped
--    paid, waiver_received and medical_form_received, expect the other three).
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'players'
  and column_name in ('years_played', 'rating', 'jersey_number', 'paid',
                      'waiver_received', 'medical_form_received')
order by column_name;

-- 2. status CHECK accepts 'waitlist'.
select 'status check includes waitlist' as check,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.players'::regclass and conname = 'players_status_check';

-- 3. Rating backfill: no novice/developing/advanced player without a rating.
select 'unbackfilled tiered players (expect 0)' as check, count(*)
from public.players
where skill_tier in ('novice', 'developing', 'advanced') and rating is null;

-- 4. Grid filter index exists.
select 'idx_players_org_status' as check, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'idx_players_org_status';
