-- The demo organization (plan docs/changes/2026-10-22-demo-mode.md, D3; agreed by the owner
-- 2026-10-22, the AGENTS.md rule 14 plan for this persistence, authentication and scheduler
-- change).
--
-- **Why.** A prospective league judges SquadLogic from a ready-made league: one RPC copies the demo
-- league into a private organization for an anonymous visitor, who is its administrator for 30
-- minutes. The same organization is a real one (same policies, same RPCs), so everything below
-- is about what a demo must NOT be able to do, and about removing it.
--
-- **The change.**
--   1. `organizations.demo_expires_at` (set means demo) and `demo_owner` (the visitor), a unique
--      partial index so one visitor has one demo even if the lock below is bypassed, and a
--      BEFORE INSERT OR UPDATE trigger that refuses a client (`authenticated`, `anon`) any change to
--      either: "Organizations: admins update" would otherwise let the demo's own admin clear its
--      expiry, and a real organization's admin mark theirs a demo (to be purged).
--   2. `demo_seed`, a schema PostgREST does not expose, holding the league as
--      `fixtures/demo-2026/` shapes it (generated rows, section 10: `scripts/build-demo-seed.mjs`,
--      held by tests/demoSeed.test.js), and `demo_purge_log`, the purge's own record (the
--      organizations it deletes take their audit rows with them).
--   3. `is_org_member` and `is_org_admin` return false for an organization whose
--      `demo_expires_at` has passed, so every policy and RPC that asks them refuses an expired demo
--      between expiry and the purge, whatever the browser does (replaced from their latest bodies:
--      20261020030000 and 20260421025831, md5 checked; `is_org_member` keeps its parameter name).
--   4. The fences, at the data layer so a path cannot go round them (a definer RPC, the
--      invoker `apply_player_patch`, and a direct PostgREST write to a table whose policy admits
--      an admin all reach the same trigger):
--        * `players`: no insert, no delete, and an update may change only the roster and
--          teaming fields (team, division, status, rating, years played, jersey number, coaching
--          willingness, eligibility) in a demo organization; every other column, the names
--          included, is read-only. `coaches`: no write. `import_jobs`, `staging_players` and
--          `staging_import_rows`: no insert, so no import job exists in a demo and every
--          finalize and rollback RPC, each of which starts from a job, has nothing to act on.
--        * an anonymous session may join only its own demo organization (`organization_members`
--          trigger) and mints no invite (`organization_invites` trigger): `initialize_new_tenant`,
--          `redeem_org_invite` and `create_org_invite` then refuse it where they write.
--        * the `exports` and `raw-imports` buckets' insert policies refuse a demo
--          organization's folder (a purge cannot delete the bytes of an object).
--        * `prune_old_audit_logs()` and `prune_old_evaluation_runs()` are closed to the client
--          roles: ungated definers any signed-in user (so any visitor) could call to delete
--          past-retention rows of every organization. Only `pg_cron` calls them.
--      Nothing here loosens a policy or grant; a real organization's rows pass every trigger
--      unchanged.
--   5. `demo.started` registered in `audit_actions`.
--   6. `start_demo_session()` (definer, authenticated, anonymous callers only): serialized
--      on one advisory lock, refuses at the cap of 10 live demos, returns the caller's live
--      demo instead of a second, and otherwise copies `demo_seed` into a new organization with fresh
--      ids, flags it last (so the fences never see its own seed), adds the caller as admin
--      and records one `demo.started` row. `purge_expired_demos()` (definer, service role
--      only) deletes expired demo organizations and the anonymous users left with no
--      membership, and logs its counts; `demo_health()` (service role only) reports whether
--      the purge is running, for the hourly workflow. `pg_cron` runs the purge every 10 minutes.
--   7. An end-state check.
--
-- Every drop names its object, with no CASCADE.
--
-- **Declared, not enforced at expiry.** Three policies and one RPC read `organization_members`
-- themselves instead of asking the helpers: `telemetry_log` insert and select,
-- `organization_schema_history` select, and `persist_evaluation_run`. After expiry they still
-- see the doomed demo's own log rows until the purge (at most ~10 minutes); nothing else.
-- Edge Functions check membership with the service role: `_shared/auth.ts` refuses an expired demo
-- itself, and `import-validation` refuses a demo.
--
-- Reversible: docs/sql/20261030010000_revert.sql. Smoke: docs/sql/20261030010000_smoke.sql.
-- pgTAP: supabase/tests/demo_sessions.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What it touches.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'organizations: % (none is a demo yet)', (SELECT count(*) FROM public.organizations);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The columns, the indexes, the trigger that keeps them out of a client's hands.
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
    ADD COLUMN demo_expires_at timestamptz NULL,
    ADD COLUMN demo_owner uuid NULL REFERENCES auth.users (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX organizations_demo_owner_live_key
    ON public.organizations (demo_owner)
    WHERE demo_expires_at IS NOT NULL;

CREATE INDEX organizations_demo_expires_at_idx
    ON public.organizations (demo_expires_at)
    WHERE demo_expires_at IS NOT NULL;

CREATE FUNCTION public.organizations_guard_demo_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        IF TG_OP = 'INSERT' AND (NEW.demo_expires_at IS NOT NULL OR NEW.demo_owner IS NOT NULL) THEN
            RAISE EXCEPTION 'demo_expires_at and demo_owner are set by the server only'
                USING ERRCODE = '42501';
        END IF;
        IF TG_OP = 'UPDATE'
           AND (NEW.demo_expires_at IS DISTINCT FROM OLD.demo_expires_at
                OR NEW.demo_owner IS DISTINCT FROM OLD.demo_owner) THEN
            RAISE EXCEPTION 'demo_expires_at and demo_owner are set by the server only'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_guard_demo_columns
    BEFORE INSERT OR UPDATE ON public.organizations
    FOR EACH ROW EXECUTE FUNCTION public.organizations_guard_demo_columns();

-- ---------------------------------------------------------------------------
-- 3. `demo_seed` (the league as the fixture shapes it) and `demo_purge_log`.
--    demo_seed is not in PostgREST's `schemas`; the grants below also close it to every
--    client role, and row level security is on with no policy.
-- ---------------------------------------------------------------------------
CREATE SCHEMA demo_seed;
REVOKE ALL ON SCHEMA demo_seed FROM PUBLIC;

-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.league (
    organization_name text NOT NULL,
    timezone          text NOT NULL,
    season_weeks      integer NOT NULL CHECK (season_weeks > 0)
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.divisions (
    key             text PRIMARY KEY,
    name            text NOT NULL UNIQUE,
    gender_policy   public.gender_policy_enum NOT NULL,
    play_format     text NOT NULL,
    min_age         smallint NOT NULL,
    max_age         smallint NOT NULL,
    max_roster_size integer NOT NULL,
    plays_games     boolean NOT NULL
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.teams (
    name         text PRIMARY KEY,
    division_key text NOT NULL REFERENCES demo_seed.divisions (key)
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.players (
    external_registration_id text PRIMARY KEY,
    first_name               text NOT NULL,
    last_name                text NOT NULL,
    gender                   text NOT NULL,
    natural_age              smallint NOT NULL,
    status                   text NOT NULL,
    years_played             smallint NOT NULL,
    willing_to_coach         boolean NOT NULL,
    play_up_requested        boolean NOT NULL,
    buddy_request            text,
    team_name                text NOT NULL REFERENCES demo_seed.teams (name)
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.coaches (
    full_name text PRIMARY KEY,
    email     text NOT NULL UNIQUE,
    status    text NOT NULL
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.team_coaches (
    team_name  text NOT NULL REFERENCES demo_seed.teams (name),
    coach_name text NOT NULL REFERENCES demo_seed.coaches (full_name),
    role       text NOT NULL CHECK (role IN ('lead', 'assistant')),
    PRIMARY KEY (team_name, coach_name)
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.locations (
    name      text PRIMARY KEY,
    latitude  numeric(7, 4) NOT NULL,
    longitude numeric(7, 4) NOT NULL
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.fields (
    location_name   text NOT NULL REFERENCES demo_seed.locations (name),
    name            text NOT NULL,
    surface_type    text NOT NULL,
    supports_halves boolean NOT NULL,
    PRIMARY KEY (location_name, name)
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.field_subunits (
    location_name text NOT NULL,
    field_name    text NOT NULL,
    label         text NOT NULL,
    PRIMARY KEY (location_name, field_name, label),
    FOREIGN KEY (location_name, field_name) REFERENCES demo_seed.fields (location_name, name)
);
-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.practice_slots (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    location_name text NOT NULL,
    field_name    text NOT NULL,
    subunit_label text,
    day_of_week   text NOT NULL,
    start_time    time NOT NULL,
    end_time      time NOT NULL,
    capacity      smallint NOT NULL,
    division_key  text REFERENCES demo_seed.divisions (key),
    FOREIGN KEY (location_name, field_name) REFERENCES demo_seed.fields (location_name, name)
);

ALTER TABLE demo_seed.league ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.divisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.coaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.team_coaches ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.field_subunits ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed.practice_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA demo_seed FROM PUBLIC, anon, authenticated;

CREATE TABLE public.demo_purge_log (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ran_at        timestamptz NOT NULL DEFAULT now(),
    orgs_deleted  integer NOT NULL,
    users_deleted integer NOT NULL,
    users_skipped integer NOT NULL,
    live_demos    integer NOT NULL,
    note          text
);
ALTER TABLE public.demo_purge_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.demo_purge_log FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.demo_purge_log IS
    'One row per run of purge_expired_demos(): what it deleted, and the proof it ran. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. The helpers. `is_demo_org` is what the bucket policies ask (a policy runs as the
--    caller); `caller_is_anonymous` is internal.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.is_demo_org(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.organizations o
         WHERE o.id = p_org_id AND o.demo_expires_at IS NOT NULL
    );
$$;
REVOKE ALL ON FUNCTION public.is_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_demo_org(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.is_demo_org(uuid) IS
    'True for a demo organization (live or expired, not yet purged). Asked by the storage insert policies.';

CREATE FUNCTION public.caller_is_anonymous()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT COALESCE((auth.jwt() ->> 'is_anonymous') = 'true', false);
$$;
REVOKE ALL ON FUNCTION public.caller_is_anonymous() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The membership helpers, from their latest bodies, now false for an expired demo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_org_member(org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.organization_members
        JOIN public.organizations o ON o.id = organization_id
        WHERE organization_id = org_id
          AND profile_id = auth.uid()
          AND (o.demo_expires_at IS NULL OR o.demo_expires_at > now())
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_org_admin(p_org_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM public.organization_members
        JOIN public.organizations o ON o.id = organization_id
        WHERE organization_id = p_org_id
          AND profile_id = auth.uid()
          AND role IN ('admin', 'tenant_admin', 'staff')
          AND (o.demo_expires_at IS NULL OR o.demo_expires_at > now())
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The fences (trigger functions are definers: they read `organizations` whoever fires them).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.demo_fence_player_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- What a demo's players may still change: where they play and how they are rated.
    -- Everything else (names, gender, grade, notes, buddy request, registration id, natural
    -- age, attributes) is read-only, so no visitor can type a child's details into a demo.
    c_allowed constant text[] := ARRAY[
        'team_id', 'division_id', 'status', 'rating', 'years_played', 'jersey_number',
        'willing_to_coach', 'placement_eligible', 'updated_at'
    ];
    v_org uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.organization_id ELSE OLD.organization_id END;
    v_new uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
BEGIN
    -- A row moved between organizations is judged by both.
    IF NOT EXISTS (SELECT 1 FROM public.organizations o
                    WHERE o.id IN (v_org, v_new) AND o.demo_expires_at IS NOT NULL) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - c_allowed) IS NOT DISTINCT FROM (to_jsonb(OLD) - c_allowed) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The demo league''s people are read-only (players % refused)', lower(TG_OP)
        USING ERRCODE = '42501', DETAIL = 'demo_read_only';
END;
$$;
CREATE TRIGGER demo_fence_players
    BEFORE INSERT OR UPDATE OR DELETE ON public.players
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_player_write();

CREATE FUNCTION public.demo_fence_coach_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.organization_id ELSE OLD.organization_id END;
    v_new uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.organizations o
                    WHERE o.id IN (v_org, v_new) AND o.demo_expires_at IS NOT NULL) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The demo league''s people are read-only (coaches % refused)', lower(TG_OP)
        USING ERRCODE = '42501', DETAIL = 'demo_read_only';
END;
$$;
CREATE TRIGGER demo_fence_coaches
    BEFORE INSERT OR UPDATE OR DELETE ON public.coaches
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_coach_write();

CREATE FUNCTION public.demo_fence_import_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.organizations o
                WHERE o.id = NEW.organization_id AND o.demo_expires_at IS NOT NULL) THEN
        RAISE EXCEPTION 'The demo league cannot import files (% refused)', TG_TABLE_NAME
            USING ERRCODE = '42501', DETAIL = 'demo_import_refused';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER demo_fence_import_jobs
    BEFORE INSERT ON public.import_jobs
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_import_write();
CREATE TRIGGER demo_fence_staging_players
    BEFORE INSERT ON public.staging_players
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_import_write();
CREATE TRIGGER demo_fence_staging_import_rows
    BEFORE INSERT ON public.staging_import_rows
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_import_write();

CREATE FUNCTION public.demo_fence_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF public.caller_is_anonymous()
       AND (NEW.profile_id IS DISTINCT FROM auth.uid()
            OR NOT EXISTS (SELECT 1 FROM public.organizations o
                            WHERE o.id = NEW.organization_id AND o.demo_expires_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'A demo visitor cannot create or join an organization'
            USING ERRCODE = '42501', DETAIL = 'demo_anonymous_refused';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER demo_fence_organization_members
    BEFORE INSERT ON public.organization_members
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_membership();

CREATE FUNCTION public.demo_fence_invite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF public.caller_is_anonymous() THEN
        RAISE EXCEPTION 'A demo visitor cannot invite anyone'
            USING ERRCODE = '42501', DETAIL = 'demo_anonymous_refused';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER demo_fence_organization_invites
    BEFORE INSERT ON public.organization_invites
    FOR EACH ROW EXECUTE FUNCTION public.demo_fence_invite();

REVOKE ALL ON FUNCTION
    public.organizations_guard_demo_columns(), public.demo_fence_player_write(),
    public.demo_fence_coach_write(), public.demo_fence_import_write(),
    public.demo_fence_membership(), public.demo_fence_invite()
    FROM PUBLIC, anon, authenticated;

-- The buckets: no object may be created that the purge would have to clean (a storage delete from
-- SQL leaves the bytes behind). Each expression is the policy's own with one conjunct added.
ALTER POLICY "exports org-admin insert" ON storage.objects
    WITH CHECK (
        bucket_id = 'exports'
        AND CASE
            WHEN (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
                 AND NOT public.is_demo_org(((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

ALTER POLICY "raw-imports org-member insert" ON storage.objects
    WITH CHECK (
        bucket_id = 'raw-imports'
        AND auth.role() = 'authenticated'
        AND ((storage.foldername(name))[1])::uuid IN (
            SELECT organization_id FROM public.organization_members WHERE profile_id = auth.uid()
        )
        AND NOT public.is_demo_org(((storage.foldername(name))[1])::uuid)
    );

-- Two retention sweeps were granted to every signed-in user (`prune_old_audit_logs`,
-- `prune_old_evaluation_runs`: definers with no authorization check that delete past-retention rows of
-- EVERY organization). Only `pg_cron` calls them, as the owner, and no client does. An anonymous
-- visitor is a signed-in user, so they are closed to the client roles: no behavior is lost.
REVOKE EXECUTE ON FUNCTION public.prune_old_audit_logs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prune_old_evaluation_runs() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. The audit action.
-- ---------------------------------------------------------------------------
INSERT INTO public.audit_actions (action) VALUES ('demo.started')
ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 8. `start_demo_session()`.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.start_demo_session()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    c_minutes constant integer := 30;   -- decision 8
    c_cap     constant integer := 10;   -- decision 2
    v_uid     uuid := auth.uid();
    v_org     uuid;
    v_expires timestamptz;
    v_live    integer;
    v_name    text;
    v_tz      text;
    v_weeks   integer;
    v_season  uuid;
    v_start   date;
    v_end     date;
    v_year    integer;
    v_team    record;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT public.caller_is_anonymous() THEN
        RAISE EXCEPTION 'Only a demo visitor can start a demo'
            USING ERRCODE = '42501', DETAIL = 'demo_requires_anonymous';
    END IF;

    -- One caller at a time past this point, so the cap and the one-per-visitor rule are judged
    -- against what the callers before this one committed.
    PERFORM pg_advisory_xact_lock(hashtextextended('squadlogic.start_demo_session', 0));

    SELECT o.id, o.demo_expires_at INTO v_org, v_expires
      FROM public.organizations o WHERE o.demo_owner = v_uid;
    IF FOUND THEN
        IF v_expires > now() THEN
            RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', true);
        END IF;
        -- The visitor's own demo has ended and is waiting for the purge: it goes now.
        DELETE FROM public.organizations WHERE id = v_org;
    END IF;

    SELECT count(*) INTO v_live FROM public.organizations WHERE demo_expires_at > now();
    IF v_live >= c_cap THEN
        RAISE LOG 'start_demo_session refused: % live demos, the cap is %', v_live, c_cap;
        RAISE EXCEPTION 'The demo is busy right now. Try again in a few minutes.'
            USING ERRCODE = 'P0001', DETAIL = 'demo_capacity';
    END IF;

    SELECT l.organization_name, l.timezone, l.season_weeks INTO v_name, v_tz, v_weeks FROM demo_seed.league l;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The demo league is not available' USING ERRCODE = 'P0001', DETAIL = 'demo_seed_empty';
    END IF;

    -- The season is the coming twelve weeks whenever the demo starts.
    v_start := date_trunc('week', now() AT TIME ZONE v_tz)::date + 7;
    v_end := v_start + v_weeks * 7 - 1;
    v_year := extract(year FROM v_start)::integer;

    -- Not yet marked a demo: the fences would refuse the seed. It is marked below, last.
    INSERT INTO public.organizations (name, slug, contact_info, is_onboarded)
    VALUES (v_name, 'demo-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
            jsonb_build_object('timezone', v_tz), true)
    RETURNING id INTO v_org;

    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_label, timezone,
                                        season_start, season_end)
    VALUES (v_org, v_year || ' Season', 'active', v_year, v_year || ' Season', v_tz, v_start, v_end)
    RETURNING id INTO v_season;

    INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy, play_format,
                                  min_age, max_age, max_roster_size, plays_games, season_start, season_end)
    SELECT v_org, v_season, d.name, d.gender_policy, d.play_format, d.min_age, d.max_age,
           d.max_roster_size, d.plays_games, v_start, v_end
      FROM demo_seed.divisions d;

    INSERT INTO public.teams (organization_id, division_id, name)
    SELECT v_org, dv.id, t.name
      FROM demo_seed.teams t
      JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = t.division_key;

    -- `coaches.email` is unique across organizations: each copy's addresses carry its own tag.
    INSERT INTO public.coaches (organization_id, full_name, email, status)
    SELECT v_org, c.full_name,
           replace(c.email, '@', '+' || substr(replace(v_org::text, '-', ''), 1, 12) || '@'), c.status
      FROM demo_seed.coaches c;

    INSERT INTO public.players (organization_id, division_id, team_id, first_name, last_name,
                                external_registration_id, gender, status, years_played, willing_to_coach,
                                play_up_requested, buddy_request, natural_age)
    SELECT v_org, t.division_id, t.id, p.first_name, p.last_name, p.external_registration_id,
           p.gender, p.status, p.years_played, p.willing_to_coach, p.play_up_requested,
           p.buddy_request, p.natural_age
      FROM demo_seed.players p
      JOIN public.teams t ON t.organization_id = v_org AND t.name = p.team_name;

    INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
    SELECT pl.team_id, pl.id, v_org, 'player', 'auto'
      FROM public.players pl
     WHERE pl.organization_id = v_org AND pl.team_id IS NOT NULL;

    INSERT INTO public.locations (organization_id, name, lighting_available, latitude, longitude)
    SELECT v_org, l.name, true, l.latitude, l.longitude FROM demo_seed.locations l;

    INSERT INTO public.fields (organization_id, location_id, name, surface_type, supports_halves)
    SELECT v_org, loc.id, f.name, f.surface_type, f.supports_halves
      FROM demo_seed.fields f
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = f.location_name;

    INSERT INTO public.field_subunits (organization_id, field_id, label)
    SELECT v_org, fl.id, s.label
      FROM demo_seed.field_subunits s
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name;

    INSERT INTO public.practice_slots (organization_id, field_id, field_subunit_id, day_of_week, start_time,
                                       end_time, capacity, division_id)
    SELECT v_org, fl.id, su.id, s.day_of_week::public.day_of_week, s.start_time, s.end_time, s.capacity, dv.id
      FROM demo_seed.practice_slots s
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name
      LEFT JOIN public.field_subunits su ON su.field_id = fl.id AND su.label = s.subunit_label
      LEFT JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = s.division_key;

    -- Marked last, then the visitor joins: both pass the fences, which now see a demo.
    v_expires := now() + make_interval(mins => c_minutes);
    UPDATE public.organizations SET demo_expires_at = v_expires, demo_owner = v_uid WHERE id = v_org;
    -- A SELECT, not a VALUES list: the role is the creator's (as in initialize_new_tenant), not a role
    -- test, and tests/staff_is_admin.sql reads any parenthesised list naming 'admin' as a role list.
    INSERT INTO public.organization_members (organization_id, profile_id, role)
    SELECT v_org, v_uid, 'admin';

    -- The one writer of a team's coaches (it keeps teams.coach_id, assistant_coach_ids and the assignment
    -- rows together; the catalogue allows no other). It audits as the caller, who is a member by now: one
    -- team.coach_assignments_changed row per team, as an admin's own assignments would leave.
    FOR v_team IN
        SELECT t.id AS team_id,
               (array_agg(c.id) FILTER (WHERE tc.role = 'lead'))[1] AS lead_id,
               COALESCE(array_agg(c.id ORDER BY c.full_name) FILTER (WHERE tc.role = 'assistant'), ARRAY[]::uuid[]) AS assistant_ids
          FROM demo_seed.team_coaches tc
          JOIN public.teams t ON t.organization_id = v_org AND t.name = tc.team_name
          JOIN public.coaches c ON c.organization_id = v_org AND c.full_name = tc.coach_name
         GROUP BY t.id
    LOOP
        PERFORM public.set_team_coaches(v_team.team_id, v_team.lead_id, v_team.assistant_ids, current_date, 'demo_seed');
    END LOOP;

    -- The team run the Teams, Practices and Games pages read their teams from (`scheduler_runs`, the
    -- latest completed `team` run of the season; `mapSchedulerRunToSummary`). A league formed some other
    -- way than by a team run has none, and those pages treat it as a cold start: the auto-scheduler
    -- stays disabled with "no teams". So the seeded league gets the run its teams would have left,
    -- built from the copied rows: each division's teams (their stored coaches) and each team's roster.
    WITH team_rows AS (
        SELECT dv.name AS division_name, dv.max_roster_size, t.id, t.name, t.division_id, t.coach_id,
               t.assistant_coach_ids,
               (SELECT count(*) FROM public.team_players tp WHERE tp.team_id = t.id) AS n_players
          FROM public.teams t
          JOIN public.divisions dv ON dv.id = t.division_id
         WHERE t.organization_id = v_org
    ), by_division AS (
        SELECT division_name,
               jsonb_agg(jsonb_build_object(
                   'id', id, 'name', name, 'division', division_name, 'divisionId', division_id,
                   'coachId', coach_id,
                   'assistantCoachIds', to_jsonb(COALESCE(assistant_coach_ids, ARRAY[]::uuid[]))
               ) ORDER BY name) AS teams,
               sum(n_players)::integer AS players,
               sum(COALESCE(max_roster_size, 0))::integer AS capacity
          FROM team_rows
         GROUP BY division_name
    )
    INSERT INTO public.scheduler_runs (organization_id, season_id, season_settings_id, run_type, status,
                                       parameters, metrics, results, created_by, started_at, completed_at)
    SELECT v_org, v_season, v_season, 'team', 'completed',
           jsonb_build_object('source', 'demo_seed'), '{}'::jsonb,
           jsonb_build_object(
               'teamsByDivision', (SELECT jsonb_object_agg(division_name, teams) FROM by_division),
               'rosterBalanceByDivision', (SELECT jsonb_object_agg(division_name, jsonb_build_object(
                   'summary', jsonb_build_object(
                       'totalPlayers', players, 'totalCapacity', capacity,
                       'averageFillRate', CASE WHEN capacity > 0 THEN round(players::numeric / capacity, 4) ELSE 0 END)))
                   FROM by_division),
               'team_players', COALESCE((SELECT jsonb_agg(jsonb_build_object('team_id', tp.team_id, 'player_id', tp.player_id))
                                           FROM public.team_players tp WHERE tp.organization_id = v_org), '[]'::jsonb)
           ),
           v_uid, now(), now();

    PERFORM public.record_audit_event(
        v_org, 'demo.started', 'organization', v_org,
        jsonb_build_object('expires_at', v_expires, 'minutes', c_minutes)
    );

    RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', false);
END;
$$;
REVOKE ALL ON FUNCTION public.start_demo_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_demo_session() TO authenticated;
COMMENT ON FUNCTION public.start_demo_session() IS
    'An anonymous visitor''s demo: copies demo_seed into a new organization that expires in 30 minutes. Returns {organization_id, expires_at, existing}.';

-- ---------------------------------------------------------------------------
-- 9. The purge and its health read.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.purge_expired_demos()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_orgs    integer;
    v_owners  uuid[];
    v_user    uuid;
    v_users   integer := 0;
    v_skipped integer := 0;
    v_live    integer;
BEGIN
    -- A run that overlaps another leaves the work to it.
    IF NOT pg_try_advisory_xact_lock(hashtextextended('squadlogic.purge_expired_demos', 0)) THEN
        RETURN jsonb_build_object('skipped', true);
    END IF;

    WITH gone AS (
        DELETE FROM public.organizations
         WHERE demo_expires_at IS NOT NULL AND demo_expires_at <= now()
        RETURNING demo_owner
    )
    SELECT count(*), COALESCE(array_agg(demo_owner) FILTER (WHERE demo_owner IS NOT NULL), ARRAY[]::uuid[])
      INTO v_orgs, v_owners
      FROM gone;

    -- The visitors of those demos, and any anonymous user an hour old with no membership (a start
    -- that was refused at the cap leaves one). Never one who still belongs to an organization.
    FOR v_user IN
        SELECT u.id FROM auth.users u
         WHERE u.is_anonymous
           AND (u.id = ANY (v_owners) OR u.created_at < now() - interval '1 hour')
           AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.profile_id = u.id)
    LOOP
        BEGIN
            DELETE FROM auth.users WHERE id = v_user;
            v_users := v_users + 1;
        EXCEPTION WHEN foreign_key_violation THEN
            -- Something still references this user: counted, left for the next run, and visible
            -- in the log. Every other error ends the run.
            v_skipped := v_skipped + 1;
        END;
    END LOOP;

    SELECT count(*) INTO v_live FROM public.organizations WHERE demo_expires_at > now();
    INSERT INTO public.demo_purge_log (orgs_deleted, users_deleted, users_skipped, live_demos)
    VALUES (v_orgs, v_users, v_skipped, v_live);
    DELETE FROM public.demo_purge_log WHERE ran_at < now() - interval '30 days';

    RETURN jsonb_build_object('orgs_deleted', v_orgs, 'users_deleted', v_users,
                              'users_skipped', v_skipped, 'live_demos', v_live);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_expired_demos() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_demos() TO service_role;

CREATE FUNCTION public.demo_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    c_grace  constant interval := interval '30 minutes';
    v_stale  integer;
    v_oldest numeric;
    v_last   timestamptz;
    v_live   integer;
    v_problems text[] := ARRAY[]::text[];
BEGIN
    SELECT count(*), round(max(extract(epoch FROM now() - demo_expires_at)) / 60)
      INTO v_stale, v_oldest
      FROM public.organizations
     WHERE demo_expires_at IS NOT NULL AND demo_expires_at < now() - c_grace;
    SELECT max(ran_at) INTO v_last FROM public.demo_purge_log;
    SELECT count(*) INTO v_live FROM public.organizations WHERE demo_expires_at > now();

    IF v_stale > 0 THEN
        v_problems := array_append(v_problems, format('%s expired demo organization(s) are over 30 minutes past expiry (oldest %s minutes)', v_stale, v_oldest));
    END IF;
    IF v_last IS NULL THEN
        v_problems := array_append(v_problems, 'the purge has never logged a run');
    ELSIF v_last < now() - c_grace THEN
        v_problems := array_append(v_problems, format('the newest purge log row is %s minutes old', round(extract(epoch FROM now() - v_last) / 60)));
    END IF;

    RETURN jsonb_build_object(
        'healthy', cardinality(v_problems) = 0,
        'problems', to_jsonb(v_problems),
        'live_demos', v_live,
        'expired_stale', v_stale,
        'minutes_since_purge', CASE WHEN v_last IS NULL THEN NULL ELSE round(extract(epoch FROM now() - v_last) / 60) END,
        'checked_at', now()
    );
END;
$$;
REVOKE ALL ON FUNCTION public.demo_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.demo_health() TO service_role;

SELECT cron.schedule('purge-expired-demos', '*/10 * * * *', $$ SELECT public.purge_expired_demos() $$);

-- The first run is logged by the migration, so the health read has a row to age from until the
-- job's first tick.
INSERT INTO public.demo_purge_log (orgs_deleted, users_deleted, users_skipped, live_demos, note)
VALUES (0, 0, 0, 0, 'migration 20261030010000');

-- ---------------------------------------------------------------------------
-- 10. The league, generated from fixtures/demo-2026/ (scripts/build-demo-seed.mjs).
-- ---------------------------------------------------------------------------
-- BEGIN GENERATED demo_seed rows (scripts/build-demo-seed.mjs; do not edit)
INSERT INTO demo_seed.league (organization_name, timezone, season_weeks) VALUES
  ('Demo league', 'America/Los_Angeles', 12);

INSERT INTO demo_seed.divisions (key, name, gender_policy, play_format, min_age, max_age, max_roster_size, plays_games) VALUES
  ('U4', 'U4', 'coed', 'Minis', 3, 4, 15, false),
  ('U5B', 'U5B', 'boys', '4v4', 5, 5, 5, true),
  ('U5G', 'U5G', 'girls', '4v4', 5, 5, 5, true),
  ('U6B', 'U6B', 'boys', '4v4', 6, 6, 5, true),
  ('U6G', 'U6G', 'girls', '4v4', 6, 6, 5, true),
  ('U7B', 'U7B', 'boys', '5v5', 7, 7, 7, true),
  ('U7G', 'U7G', 'girls', '5v5', 7, 7, 7, true),
  ('U8B', 'U8B', 'boys', '5v5', 8, 8, 7, true),
  ('U8G', 'U8G', 'girls', '5v5', 8, 8, 7, true),
  ('U9B', 'U9B', 'boys', '7v7', 9, 9, 11, true),
  ('U9G', 'U9G', 'girls', '7v7', 9, 9, 11, true),
  ('U10B', 'U10B', 'boys', '7v7', 10, 10, 11, true),
  ('U10G', 'U10G', 'girls', '7v7', 10, 10, 11, true),
  ('U12B', 'U12B', 'boys', '9v9', 11, 12, 15, true),
  ('U12G', 'U12G', 'girls', '9v9', 11, 12, 15, true),
  ('U14B', 'U14B', 'boys', '11v11', 13, 14, 19, true),
  ('U14G', 'U14G', 'girls', '11v11', 13, 14, 19, true),
  ('U16B', 'U16B', 'boys', '11v11', 15, 16, 19, true),
  ('U16G', 'U16G', 'girls', '11v11', 15, 16, 19, true),
  ('U19B', 'U19B', 'boys', '11v11', 17, 19, 19, true),
  ('U19G', 'U19G', 'girls', '11v11', 17, 19, 19, true);

INSERT INTO demo_seed.teams (name, division_key) VALUES
  ('U05B01', 'U5B'),
  ('U05B02', 'U5B'),
  ('U05B03', 'U5B'),
  ('U05B04', 'U5B'),
  ('U05B05', 'U5B'),
  ('U05B06', 'U5B'),
  ('U05B07', 'U5B'),
  ('U05B08', 'U5B'),
  ('U05G01', 'U5G'),
  ('U05G02', 'U5G'),
  ('U05G03', 'U5G'),
  ('U05G04', 'U5G'),
  ('U05G05', 'U5G'),
  ('U05G06', 'U5G'),
  ('U05G07', 'U5G'),
  ('U05G08', 'U5G'),
  ('U06B01', 'U6B'),
  ('U06B02', 'U6B'),
  ('U06B03', 'U6B'),
  ('U06B04', 'U6B'),
  ('U06B05', 'U6B'),
  ('U06B06', 'U6B'),
  ('U06B07', 'U6B'),
  ('U06B08', 'U6B'),
  ('U06G01', 'U6G'),
  ('U06G02', 'U6G'),
  ('U06G03', 'U6G'),
  ('U06G04', 'U6G'),
  ('U06G05', 'U6G'),
  ('U06G06', 'U6G'),
  ('U06G07', 'U6G'),
  ('U06G08', 'U6G'),
  ('U07B01', 'U7B'),
  ('U07B02', 'U7B'),
  ('U07B03', 'U7B'),
  ('U07B04', 'U7B'),
  ('U07B05', 'U7B'),
  ('U07B06', 'U7B'),
  ('U07B07', 'U7B'),
  ('U07B08', 'U7B'),
  ('U07G01', 'U7G'),
  ('U07G02', 'U7G'),
  ('U07G03', 'U7G'),
  ('U07G04', 'U7G'),
  ('U07G05', 'U7G'),
  ('U07G06', 'U7G'),
  ('U07G07', 'U7G'),
  ('U07G08', 'U7G'),
  ('U08B01', 'U8B'),
  ('U08B02', 'U8B'),
  ('U08B03', 'U8B'),
  ('U08B04', 'U8B'),
  ('U08B05', 'U8B'),
  ('U08B06', 'U8B'),
  ('U08B07', 'U8B'),
  ('U08B08', 'U8B'),
  ('U08G01', 'U8G'),
  ('U08G02', 'U8G'),
  ('U08G03', 'U8G'),
  ('U08G04', 'U8G'),
  ('U08G05', 'U8G'),
  ('U08G06', 'U8G'),
  ('U08G07', 'U8G'),
  ('U08G08', 'U8G'),
  ('U09B01', 'U9B'),
  ('U09B02', 'U9B'),
  ('U09B03', 'U9B'),
  ('U09B04', 'U9B'),
  ('U09B05', 'U9B'),
  ('U09B06', 'U9B'),
  ('U09B07', 'U9B'),
  ('U09B08', 'U9B'),
  ('U09G01', 'U9G'),
  ('U09G02', 'U9G'),
  ('U09G03', 'U9G'),
  ('U09G04', 'U9G'),
  ('U09G05', 'U9G'),
  ('U09G06', 'U9G'),
  ('U09G07', 'U9G'),
  ('U09G08', 'U9G'),
  ('U10B01', 'U10B'),
  ('U10B02', 'U10B'),
  ('U10B03', 'U10B'),
  ('U10B04', 'U10B'),
  ('U10B05', 'U10B'),
  ('U10B06', 'U10B'),
  ('U10B07', 'U10B'),
  ('U10B08', 'U10B'),
  ('U10G01', 'U10G'),
  ('U10G02', 'U10G'),
  ('U10G03', 'U10G'),
  ('U10G04', 'U10G'),
  ('U10G05', 'U10G'),
  ('U10G06', 'U10G'),
  ('U10G07', 'U10G'),
  ('U10G08', 'U10G'),
  ('U12B01', 'U12B'),
  ('U12B02', 'U12B'),
  ('U12B03', 'U12B'),
  ('U12B04', 'U12B'),
  ('U12B05', 'U12B'),
  ('U12B06', 'U12B'),
  ('U12B07', 'U12B'),
  ('U12B08', 'U12B'),
  ('U12G01', 'U12G'),
  ('U12G02', 'U12G'),
  ('U12G03', 'U12G'),
  ('U12G04', 'U12G'),
  ('U12G05', 'U12G'),
  ('U12G06', 'U12G'),
  ('U12G07', 'U12G'),
  ('U12G08', 'U12G'),
  ('U14B01', 'U14B'),
  ('U14B02', 'U14B'),
  ('U14G01', 'U14G'),
  ('U14G02', 'U14G'),
  ('U16B01', 'U16B'),
  ('U16B02', 'U16B'),
  ('U16G01', 'U16G'),
  ('U16G02', 'U16G'),
  ('U19B01', 'U19B'),
  ('U19B02', 'U19B'),
  ('U19G01', 'U19G'),
  ('U19G02', 'U19G'),
  ('U4A', 'U4'),
  ('U4B', 'U4'),
  ('U4C', 'U4'),
  ('U4D', 'U4');

INSERT INTO demo_seed.players (external_registration_id, first_name, last_name, gender, natural_age, status, years_played, willing_to_coach, play_up_requested, buddy_request, team_name) VALUES
  ('50000001', 'First1', 'Last1', 'm', 4, 'active', 0, true, false, NULL, 'U4A'),
  ('50000002', 'First2', 'Last2', 'm', 4, 'active', 1, false, false, NULL, 'U4A'),
  ('50000003', 'First3', 'Last3', 'm', 4, 'active', 0, false, false, NULL, 'U4A'),
  ('50000004', 'First4', 'Last4', 'm', 4, 'active', 0, false, false, 'UnregisteredFirst4 UnregisteredLast4', 'U4A'),
  ('50000005', 'First5', 'Last5', 'f', 4, 'active', 0, false, false, NULL, 'U4A'),
  ('50000006', 'First6', 'Last6', 'm', 4, 'active', 0, false, false, NULL, 'U4A'),
  ('50000007', 'First7', 'Last7', 'm', 4, 'active', 0, false, false, 'First10 Last10', 'U4A'),
  ('50000008', 'First8', 'Last8', 'm', 4, 'active', 0, false, false, 'UnregisteredFirst5 UnregisteredLast5', 'U4A'),
  ('50000009', 'First9', 'Last9', 'm', 4, 'active', 0, true, false, NULL, 'U4A'),
  ('50000010', 'First10', 'Last10', 'm', 4, 'active', 0, false, false, 'First7 Last7', 'U4A'),
  ('50000011', 'First11', 'Last11', 'm', 4, 'active', 0, false, false, NULL, 'U4A'),
  ('50000012', 'First12', 'Last12', 'f', 4, 'active', 0, false, false, NULL, 'U4A'),
  ('50000013', 'First13', 'Last13', 'f', 3, 'active', 0, false, false, NULL, 'U4A'),
  ('50000014', 'First14', 'Last14', 'm', 4, 'active', 0, false, false, 'UnregisteredFirst6 UnregisteredLast6', 'U4A'),
  ('50000015', 'First15', 'Last15', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000016', 'First16', 'Last16', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000017', 'First17', 'Last17', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000018', 'First18', 'Last18', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000019', 'First19', 'Last19', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000020', 'First20', 'Last20', 'm', 4, 'active', 1, false, false, 'First24 Last24', 'U4B'),
  ('50000021', 'First21', 'Last21', 'f', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000022', 'First22', 'Last22', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000023', 'First23', 'Last23', 'f', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000024', 'First24', 'Last24', 'm', 4, 'active', 1, false, false, 'First20 Last20', 'U4B'),
  ('50000025', 'First25', 'Last25', 'f', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000026', 'First26', 'Last26', 'f', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000027', 'First27', 'Last27', 'm', 4, 'active', 0, false, false, NULL, 'U4B'),
  ('50000028', 'First28', 'Last28', 'f', 4, 'active', 0, false, false, 'N/A', 'U4B'),
  ('50000029', 'First29', 'Last29', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000030', 'First30', 'Last30', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000031', 'First31', 'Last31', 'f', 4, 'active', 0, false, false, 'First32 Last32', 'U4C'),
  ('50000032', 'First32', 'Last32', 'f', 4, 'active', 0, true, false, 'First31 Last31', 'U4C'),
  ('50000033', 'First33', 'Last33', 'm', 4, 'active', 0, false, false, 'N/A', 'U4C'),
  ('50000034', 'First34', 'Last34', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000035', 'First35', 'Last35', 'm', 4, 'active', 0, false, false, 'First44 Last44', 'U4C'),
  ('50000036', 'First36', 'Last36', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000037', 'First37', 'Last37', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000038', 'First38', 'Last38', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000039', 'First39', 'Last39', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000040', 'First40', 'Last40', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000041', 'First41', 'Last41', 'f', 4, 'active', 1, false, false, NULL, 'U4C'),
  ('50000042', 'First42', 'Last42', 'm', 4, 'active', 0, false, false, NULL, 'U4C'),
  ('50000043', 'First43', 'Last43', 'f', 4, 'active', 0, false, false, 'N/A', 'U4D'),
  ('50000044', 'First44', 'Last44', 'm', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000045', 'First45', 'Last45', 'm', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000046', 'First46', 'Last46', 'f', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000047', 'First47', 'Last47', 'f', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000048', 'First48', 'Last48', 'm', 4, 'active', 0, false, false, 'UnregisteredFirst7 UnregisteredLast7', 'U4D'),
  ('50000049', 'First49', 'Last49', 'f', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000050', 'First50', 'Last50', 'm', 4, 'active', 0, false, false, 'N/A', 'U4D'),
  ('50000051', 'First51', 'Last51', 'f', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000052', 'First52', 'Last52', 'f', 4, 'active', 0, false, false, NULL, 'U4D'),
  ('50000053', 'First53', 'Last53', 'm', 4, 'active', 1, false, false, 'First76 Last76', 'U4D'),
  ('50000054', 'First54', 'Last54', 'm', 4, 'active', 1, false, false, NULL, 'U4D'),
  ('50000055', 'First55', 'Last55', 'f', 3, 'active', 0, false, false, NULL, 'U4D'),
  ('50000056', 'First56', 'Last56', 'm', 5, 'active', 0, false, false, 'N/A', 'U05B01'),
  ('50000057', 'First57', 'Last57', 'm', 5, 'active', 1, false, false, NULL, 'U05B01'),
  ('50000058', 'First58', 'Last58', 'm', 5, 'active', 1, false, false, 'First59 Last59', 'U05B01'),
  ('50000059', 'First59', 'Last59', 'm', 5, 'active', 0, false, false, 'First58 Last58', 'U05B01'),
  ('50000060', 'First60', 'Last60', 'm', 5, 'active', 0, true, false, NULL, 'U05B01'),
  ('50000061', 'First61', 'Last61', 'm', 5, 'active', 1, false, false, 'First63 Last63', 'U05B02'),
  ('50000062', 'First62', 'Last62', 'm', 5, 'active', 1, true, false, 'First97 Last97', 'U05B02'),
  ('50000063', 'First63', 'Last63', 'm', 5, 'active', 1, true, false, 'First61 Last61', 'U05B02'),
  ('50000064', 'First64', 'Last64', 'm', 5, 'active', 1, false, false, 'First70 Last70', 'U05B02'),
  ('50000065', 'First65', 'Last65', 'm', 5, 'active', 0, false, false, NULL, 'U05B02'),
  ('50000066', 'First66', 'Last66', 'm', 5, 'active', 0, false, false, NULL, 'U05B03'),
  ('50000067', 'First67', 'Last67', 'm', 5, 'active', 0, false, false, 'UnregisteredFirst8 UnregisteredLast8', 'U05B03'),
  ('50000068', 'First68', 'Last68', 'm', 5, 'active', 0, false, false, NULL, 'U05B03'),
  ('50000069', 'First69', 'Last69', 'm', 5, 'active', 0, false, false, 'First175 Last175', 'U05B03'),
  ('50000070', 'First70', 'Last70', 'm', 5, 'active', 1, true, false, NULL, 'U05B03'),
  ('50000071', 'First71', 'Last71', 'm', 5, 'active', 0, false, false, 'N/A', 'U05B04'),
  ('50000072', 'First72', 'Last72', 'm', 5, 'active', 0, false, false, NULL, 'U05B04'),
  ('50000073', 'First73', 'Last73', 'm', 5, 'active', 0, false, false, 'First86 Last86', 'U05B04'),
  ('50000074', 'First74', 'Last74', 'm', 5, 'active', 1, false, false, 'First170 Last170', 'U05B04'),
  ('50000075', 'First75', 'Last75', 'm', 5, 'active', 0, false, false, 'N/A', 'U05B04'),
  ('50000076', 'First76', 'Last76', 'm', 5, 'active', 0, false, false, 'UnregisteredFirst9 UnregisteredLast9', 'U05B05'),
  ('50000077', 'First77', 'Last77', 'm', 5, 'active', 1, false, false, 'First76 Last76', 'U05B05'),
  ('50000078', 'First78', 'Last78', 'm', 5, 'active', 0, false, false, 'First79 Last79', 'U05B05'),
  ('50000079', 'First79', 'Last79', 'm', 5, 'active', 0, true, false, 'First78 Last78', 'U05B05'),
  ('50000080', 'First80', 'Last80', 'm', 5, 'active', 1, false, false, NULL, 'U05B05'),
  ('50000081', 'First81', 'Last81', 'm', 5, 'active', 1, false, false, 'First82 Last82', 'U05B06'),
  ('50000082', 'First82', 'Last82', 'm', 5, 'active', 0, false, false, 'First81 Last81', 'U05B06'),
  ('50000083', 'First83', 'Last83', 'm', 5, 'active', 0, false, false, NULL, 'U05B06'),
  ('50000084', 'First84', 'Last84', 'm', 5, 'active', 0, false, false, 'UnregisteredFirst10 UnregisteredLast10', 'U05B06'),
  ('50000085', 'First85', 'Last85', 'm', 5, 'active', 0, false, false, NULL, 'U05B06'),
  ('50000086', 'First86', 'Last86', 'm', 5, 'active', 2, false, false, 'N/A', 'U05B07'),
  ('50000087', 'First87', 'Last87', 'm', 5, 'active', 1, true, false, 'First166 Last166', 'U05B07'),
  ('50000088', 'First88', 'Last88', 'm', 5, 'active', 0, false, false, NULL, 'U05B07'),
  ('50000089', 'First89', 'Last89', 'm', 5, 'active', 0, false, false, NULL, 'U05B07'),
  ('50000090', 'First90', 'Last90', 'm', 5, 'active', 0, false, false, NULL, 'U05B07'),
  ('50000091', 'First91', 'Last91', 'm', 5, 'active', 0, true, false, NULL, 'U05B08'),
  ('50000092', 'First92', 'Last92', 'm', 5, 'active', 0, false, false, 'First94 Last94', 'U05B08'),
  ('50000093', 'First93', 'Last93', 'm', 5, 'active', 0, false, false, NULL, 'U05B08'),
  ('50000094', 'First94', 'Last94', 'm', 5, 'active', 2, false, false, 'First92 Last92', 'U05B08'),
  ('50000095', 'First95', 'Last95', 'm', 5, 'active', 1, false, false, NULL, 'U05B08'),
  ('50000096', 'First96', 'Last96', 'f', 5, 'active', 0, false, false, 'N/A', 'U05G01'),
  ('50000097', 'First97', 'Last97', 'f', 5, 'active', 1, false, false, 'First62 Last62', 'U05G01'),
  ('50000098', 'First98', 'Last98', 'f', 5, 'active', 1, false, false, NULL, 'U05G01'),
  ('50000099', 'First99', 'Last99', 'f', 5, 'active', 0, false, false, NULL, 'U05G01'),
  ('50000100', 'First100', 'Last100', 'f', 5, 'active', 0, true, false, 'First114 Last114', 'U05G01'),
  ('50000101', 'First101', 'Last101', 'f', 5, 'active', 1, false, false, 'UnregisteredFirst11 UnregisteredLast11', 'U05G02'),
  ('50000102', 'First102', 'Last102', 'f', 5, 'active', 1, false, false, 'First104 Last104', 'U05G02'),
  ('50000103', 'First103', 'Last103', 'f', 5, 'active', 0, false, false, NULL, 'U05G02'),
  ('50000104', 'First104', 'Last104', 'f', 5, 'active', 0, true, false, 'First102 Last102', 'U05G02'),
  ('50000105', 'First105', 'Last105', 'f', 5, 'active', 1, false, false, NULL, 'U05G02'),
  ('50000106', 'First106', 'Last106', 'f', 5, 'active', 1, false, false, 'First128 Last128', 'U05G03'),
  ('50000107', 'First107', 'Last107', 'f', 5, 'active', 2, false, false, 'First110 Last110', 'U05G03'),
  ('50000108', 'First108', 'Last108', 'f', 5, 'active', 0, false, false, NULL, 'U05G03'),
  ('50000109', 'First109', 'Last109', 'f', 5, 'active', 0, false, false, NULL, 'U05G03'),
  ('50000110', 'First110', 'Last110', 'f', 5, 'active', 0, false, false, 'First107 Last107', 'U05G03'),
  ('50000111', 'First111', 'Last111', 'f', 5, 'active', 0, false, false, NULL, 'U05G04'),
  ('50000112', 'First112', 'Last112', 'f', 5, 'active', 0, false, false, NULL, 'U05G04'),
  ('50000113', 'First113', 'Last113', 'f', 4, 'active', 1, true, true, 'First114 Last114', 'U05G04'),
  ('50000114', 'First114', 'Last114', 'f', 5, 'active', 0, false, false, 'First113 Last113', 'U05G04'),
  ('50000115', 'First115', 'Last115', 'f', 5, 'active', 0, false, false, NULL, 'U05G04'),
  ('50000116', 'First116', 'Last116', 'f', 5, 'active', 0, false, false, NULL, 'U05G05'),
  ('50000117', 'First117', 'Last117', 'f', 5, 'active', 0, false, false, NULL, 'U05G05'),
  ('50000118', 'First118', 'Last118', 'f', 5, 'active', 0, false, false, NULL, 'U05G05'),
  ('50000119', 'First119', 'Last119', 'f', 5, 'active', 0, false, false, 'First120 Last120', 'U05G05'),
  ('50000120', 'First120', 'Last120', 'f', 4, 'active', 0, true, true, 'First119 Last119', 'U05G05'),
  ('50000121', 'First121', 'Last121', 'f', 5, 'active', 0, false, false, NULL, 'U05G06'),
  ('50000122', 'First122', 'Last122', 'f', 5, 'active', 0, false, false, 'First123 Last123', 'U05G06'),
  ('50000123', 'First123', 'Last123', 'f', 5, 'active', 0, true, false, 'First122 Last122', 'U05G06'),
  ('50000124', 'First124', 'Last124', 'f', 5, 'active', 1, false, false, NULL, 'U05G06'),
  ('50000125', 'First125', 'Last125', 'f', 5, 'active', 0, false, false, 'UnregisteredFirst12 UnregisteredLast12', 'U05G06'),
  ('50000126', 'First126', 'Last126', 'f', 5, 'active', 0, false, false, NULL, 'U05G07'),
  ('50000127', 'First127', 'Last127', 'f', 5, 'active', 0, false, false, NULL, 'U05G07'),
  ('50000128', 'First128', 'Last128', 'f', 5, 'active', 2, true, false, 'First130 Last130', 'U05G07'),
  ('50000129', 'First129', 'Last129', 'f', 5, 'active', 0, false, false, 'UnregisteredFirst13 UnregisteredLast13', 'U05G07'),
  ('50000130', 'First130', 'Last130', 'f', 5, 'active', 1, false, false, 'First128 Last128', 'U05G07'),
  ('50000131', 'First131', 'Last131', 'f', 5, 'active', 0, false, false, NULL, 'U05G08'),
  ('50000132', 'First132', 'Last132', 'f', 5, 'active', 0, false, false, NULL, 'U05G08'),
  ('50000133', 'First133', 'Last133', 'f', 5, 'active', 0, false, false, 'First134 Last134', 'U05G08'),
  ('50000134', 'First134', 'Last134', 'f', 5, 'active', 1, true, false, 'First133 Last133', 'U05G08'),
  ('50000135', 'First135', 'Last135', 'f', 5, 'active', 0, false, false, NULL, 'U05G08'),
  ('50000136', 'First136', 'Last136', 'm', 6, 'active', 1, false, false, 'First137 Last137', 'U06B01'),
  ('50000137', 'First137', 'Last137', 'm', 6, 'active', 1, true, false, 'First136 Last136', 'U06B01'),
  ('50000138', 'First138', 'Last138', 'm', 6, 'active', 0, false, false, 'First139 Last139', 'U06B01'),
  ('50000139', 'First139', 'Last139', 'm', 6, 'active', 0, false, false, 'First138 Last138', 'U06B01'),
  ('50000140', 'First140', 'Last140', 'm', 6, 'active', 0, false, false, NULL, 'U06B01'),
  ('50000141', 'First141', 'Last141', 'm', 5, 'active', 0, true, true, NULL, 'U06B02'),
  ('50000142', 'First142', 'Last142', 'm', 6, 'active', 1, false, false, 'First144 Last144', 'U06B02'),
  ('50000143', 'First143', 'Last143', 'm', 6, 'active', 0, false, false, 'First171 Last171', 'U06B02'),
  ('50000144', 'First144', 'Last144', 'm', 6, 'active', 0, false, false, 'First142 Last142', 'U06B02'),
  ('50000145', 'First145', 'Last145', 'm', 6, 'active', 2, false, false, NULL, 'U06B02'),
  ('50000146', 'First146', 'Last146', 'm', 6, 'active', 1, false, false, 'First147 Last147', 'U06B03'),
  ('50000147', 'First147', 'Last147', 'm', 6, 'active', 0, false, false, 'First146 Last146', 'U06B03'),
  ('50000148', 'First148', 'Last148', 'm', 6, 'active', 0, false, false, 'First150 Last150', 'U06B03'),
  ('50000149', 'First149', 'Last149', 'm', 6, 'active', 0, true, false, NULL, 'U06B03'),
  ('50000150', 'First150', 'Last150', 'm', 6, 'active', 0, false, false, 'First148 Last148', 'U06B03'),
  ('50000151', 'First151', 'Last151', 'm', 6, 'active', 1, false, false, 'First152 Last152', 'U06B04'),
  ('50000152', 'First152', 'Last152', 'm', 6, 'active', 1, true, false, 'First151 Last151', 'U06B04'),
  ('50000153', 'First153', 'Last153', 'm', 5, 'active', 0, false, true, 'First155 Last155', 'U06B04'),
  ('50000154', 'First154', 'Last154', 'm', 6, 'active', 0, false, false, 'First155 Last155', 'U06B04'),
  ('50000155', 'First155', 'Last155', 'm', 6, 'active', 3, true, false, 'First153 Last153 and First154 Last154', 'U06B04'),
  ('50000156', 'First156', 'Last156', 'm', 6, 'active', 2, true, false, 'First157 Last157', 'U06B05'),
  ('50000157', 'First157', 'Last157', 'm', 6, 'active', 0, false, false, 'First156 Last156', 'U06B05'),
  ('50000158', 'First158', 'Last158', 'm', 6, 'active', 2, true, false, NULL, 'U06B05'),
  ('50000159', 'First159', 'Last159', 'm', 6, 'active', 1, false, false, 'First160 Last160', 'U06B05'),
  ('50000160', 'First160', 'Last160', 'm', 6, 'active', 1, false, false, 'First159 Last159', 'U06B05'),
  ('50000161', 'First161', 'Last161', 'm', 6, 'active', 0, true, false, NULL, 'U06B06'),
  ('50000162', 'First162', 'Last162', 'm', 6, 'active', 0, true, false, NULL, 'U06B06'),
  ('50000163', 'First163', 'Last163', 'm', 6, 'active', 0, false, false, 'First164 Last164', 'U06B06'),
  ('50000164', 'First164', 'Last164', 'm', 6, 'active', 0, false, false, 'First163 Last163', 'U06B06'),
  ('50000165', 'First165', 'Last165', 'm', 6, 'active', 0, false, false, 'First162 Last162', 'U06B06'),
  ('50000166', 'First166', 'Last166', 'm', 6, 'active', 1, false, false, 'First87 Last87', 'U06B07'),
  ('50000167', 'First167', 'Last167', 'm', 6, 'active', 2, false, false, NULL, 'U06B07'),
  ('50000168', 'First168', 'Last168', 'm', 6, 'active', 0, false, false, 'First169 Last169', 'U06B07'),
  ('50000169', 'First169', 'Last169', 'm', 6, 'active', 0, true, false, 'First168 Last168', 'U06B07'),
  ('50000170', 'First170', 'Last170', 'm', 6, 'active', 2, false, false, 'First74 Last74', 'U06B07'),
  ('50000171', 'First171', 'Last171', 'm', 6, 'active', 1, false, false, NULL, 'U06B08'),
  ('50000172', 'First172', 'Last172', 'm', 6, 'active', 1, false, false, 'First173 Last173', 'U06B08'),
  ('50000173', 'First173', 'Last173', 'm', 6, 'active', 0, true, false, 'First172 Last172', 'U06B08'),
  ('50000174', 'First174', 'Last174', 'm', 6, 'active', 3, false, false, NULL, 'U06B08'),
  ('50000175', 'First175', 'Last175', 'm', 6, 'active', 0, false, false, 'First69 Last69', 'U06B08'),
  ('50000176', 'First176', 'Last176', 'f', 6, 'active', 3, false, false, 'First177 Last177', 'U06G01'),
  ('50000177', 'First177', 'Last177', 'f', 6, 'active', 1, false, false, 'First176 Last176', 'U06G01'),
  ('50000178', 'First178', 'Last178', 'f', 6, 'active', 1, true, false, 'First179 Last179', 'U06G01'),
  ('50000179', 'First179', 'Last179', 'f', 6, 'active', 1, false, false, 'First178 Last178', 'U06G01'),
  ('50000180', 'First180', 'Last180', 'f', 6, 'active', 1, false, false, NULL, 'U06G01'),
  ('50000181', 'First181', 'Last181', 'f', 6, 'active', 0, false, false, 'First185 Last185', 'U06G02'),
  ('50000182', 'First182', 'Last182', 'f', 6, 'active', 0, false, false, NULL, 'U06G02'),
  ('50000183', 'First183', 'Last183', 'f', 6, 'active', 1, true, false, 'First184 Last184', 'U06G02'),
  ('50000184', 'First184', 'Last184', 'f', 6, 'active', 0, false, false, 'First183 Last183', 'U06G02'),
  ('50000185', 'First185', 'Last185', 'f', 6, 'active', 0, false, false, 'First181 Last181', 'U06G02'),
  ('50000186', 'First186', 'Last186', 'f', 6, 'active', 0, false, false, 'First187 Last187', 'U06G03'),
  ('50000187', 'First187', 'Last187', 'f', 6, 'active', 2, false, false, 'First186 Last186', 'U06G03'),
  ('50000188', 'First188', 'Last188', 'f', 6, 'active', 0, false, false, 'First189 Last189', 'U06G03'),
  ('50000189', 'First189', 'Last189', 'f', 6, 'active', 1, true, false, 'First188 Last188', 'U06G03'),
  ('50000190', 'First190', 'Last190', 'f', 6, 'active', 1, false, false, NULL, 'U06G03'),
  ('50000191', 'First191', 'Last191', 'f', 6, 'active', 2, false, false, NULL, 'U06G04'),
  ('50000192', 'First192', 'Last192', 'f', 6, 'active', 0, true, false, NULL, 'U06G04'),
  ('50000193', 'First193', 'Last193', 'f', 6, 'active', 0, false, false, 'First194 Last194', 'U06G04'),
  ('50000194', 'First194', 'Last194', 'f', 6, 'active', 0, false, false, 'First193 Last193', 'U06G04'),
  ('50000195', 'First195', 'Last195', 'f', 6, 'active', 0, false, false, 'First188 Last188', 'U06G04'),
  ('50000196', 'First196', 'Last196', 'f', 6, 'active', 1, false, false, NULL, 'U06G05'),
  ('50000197', 'First197', 'Last197', 'f', 6, 'active', 2, false, false, NULL, 'U06G05'),
  ('50000198', 'First198', 'Last198', 'f', 6, 'active', 0, false, false, 'First200 Last200', 'U06G05'),
  ('50000199', 'First199', 'Last199', 'f', 6, 'active', 1, false, false, 'First319 Last319', 'U06G05'),
  ('50000200', 'First200', 'Last200', 'f', 6, 'active', 0, false, false, 'First198 Last198', 'U06G05'),
  ('50000201', 'First201', 'Last201', 'f', 6, 'active', 2, false, false, 'First204 Last204 and First205 Last205', 'U06G06'),
  ('50000202', 'First202', 'Last202', 'f', 6, 'active', 0, false, false, NULL, 'U06G06'),
  ('50000203', 'First203', 'Last203', 'f', 6, 'active', 0, false, false, NULL, 'U06G06'),
  ('50000204', 'First204', 'Last204', 'f', 6, 'active', 1, false, false, 'First205 Last205 and First201 Last201', 'U06G06'),
  ('50000205', 'First205', 'Last205', 'f', 6, 'active', 3, false, false, 'First204 Last204', 'U06G06'),
  ('50000206', 'First206', 'Last206', 'f', 6, 'active', 0, false, false, 'N/A', 'U06G07'),
  ('50000207', 'First207', 'Last207', 'f', 6, 'active', 0, false, false, 'First208 Last208', 'U06G07'),
  ('50000208', 'First208', 'Last208', 'f', 6, 'active', 1, true, false, 'First207 Last207', 'U06G07'),
  ('50000209', 'First209', 'Last209', 'f', 6, 'active', 1, false, false, 'UnregisteredFirst14 UnregisteredLast14', 'U06G07'),
  ('50000210', 'First210', 'Last210', 'f', 6, 'active', 0, false, false, NULL, 'U06G07'),
  ('50000211', 'First211', 'Last211', 'f', 6, 'active', 1, false, false, 'First212 Last212', 'U06G08'),
  ('50000212', 'First212', 'Last212', 'f', 6, 'active', 2, false, false, 'First211 Last211', 'U06G08'),
  ('50000213', 'First213', 'Last213', 'f', 6, 'active', 1, false, false, NULL, 'U06G08'),
  ('50000214', 'First214', 'Last214', 'f', 6, 'active', 0, false, false, 'First186 Last186', 'U06G08'),
  ('50000215', 'First215', 'Last215', 'f', 6, 'active', 1, false, false, NULL, 'U06G08'),
  ('50000216', 'First216', 'Last216', 'm', 7, 'active', 1, false, false, 'First217 Last217', 'U07B01'),
  ('50000217', 'First217', 'Last217', 'm', 7, 'active', 2, true, false, 'First216 Last216', 'U07B01'),
  ('50000218', 'First218', 'Last218', 'm', 7, 'active', 2, true, false, 'First222 Last222', 'U07B01'),
  ('50000219', 'First219', 'Last219', 'm', 7, 'active', 2, false, false, 'First265 Last265', 'U07B01'),
  ('50000220', 'First220', 'Last220', 'm', 7, 'active', 2, true, false, 'First221 Last221', 'U07B01'),
  ('50000221', 'First221', 'Last221', 'm', 6, 'active', 0, true, true, 'First220 Last220', 'U07B01'),
  ('50000222', 'First222', 'Last222', 'm', 7, 'active', 2, false, false, 'First218 Last218', 'U07B01'),
  ('50000223', 'First223', 'Last223', 'm', 7, 'active', 3, false, false, 'First229 Last229', 'U07B02'),
  ('50000224', 'First224', 'Last224', 'm', 7, 'active', 3, false, false, 'First226 Last226', 'U07B02'),
  ('50000225', 'First225', 'Last225', 'm', 6, 'active', 2, true, true, 'First226 Last226', 'U07B02'),
  ('50000226', 'First226', 'Last226', 'm', 7, 'active', 2, false, false, 'First225 Last225', 'U07B02'),
  ('50000227', 'First227', 'Last227', 'm', 7, 'active', 2, true, false, 'First219 Last219', 'U07B02'),
  ('50000228', 'First228', 'Last228', 'm', 7, 'active', 2, false, false, NULL, 'U07B02'),
  ('50000229', 'First229', 'Last229', 'm', 7, 'active', 3, false, false, 'First223 Last223', 'U07B02'),
  ('50000230', 'First230', 'Last230', 'm', 7, 'active', 3, true, false, 'UnregisteredFirst15 UnregisteredLast15', 'U07B03'),
  ('50000231', 'First231', 'Last231', 'm', 7, 'active', 1, false, false, 'First234 Last234', 'U07B03'),
  ('50000232', 'First232', 'Last232', 'm', 7, 'active', 1, false, false, 'First233 Last233', 'U07B03'),
  ('50000233', 'First233', 'Last233', 'm', 7, 'active', 2, false, false, 'First232 Last232', 'U07B03'),
  ('50000234', 'First234', 'Last234', 'm', 7, 'active', 2, false, false, 'First231 Last231', 'U07B03'),
  ('50000235', 'First235', 'Last235', 'm', 7, 'active', 1, false, false, NULL, 'U07B03'),
  ('50000236', 'First236', 'Last236', 'm', 7, 'active', 2, true, false, 'UnregisteredFirst16 UnregisteredLast16', 'U07B03'),
  ('50000237', 'First237', 'Last237', 'm', 7, 'active', 1, false, false, 'First242 Last242', 'U07B04'),
  ('50000238', 'First238', 'Last238', 'm', 7, 'active', 3, true, false, 'First262 Last262', 'U07B04'),
  ('50000239', 'First239', 'Last239', 'm', 7, 'active', 1, false, false, 'UnregisteredFirst17 UnregisteredLast17', 'U07B04'),
  ('50000240', 'First240', 'Last240', 'm', 7, 'active', 1, false, false, 'First241 Last241', 'U07B04'),
  ('50000241', 'First241', 'Last241', 'm', 7, 'active', 1, false, false, 'First240 Last240', 'U07B04'),
  ('50000242', 'First242', 'Last242', 'm', 7, 'active', 1, true, false, 'First237 Last237', 'U07B04'),
  ('50000243', 'First243', 'Last243', 'm', 7, 'active', 1, false, false, NULL, 'U07B04'),
  ('50000244', 'First244', 'Last244', 'm', 7, 'active', 2, false, false, 'First249 Last249', 'U07B05'),
  ('50000245', 'First245', 'Last245', 'm', 7, 'active', 1, true, false, 'First250 Last250', 'U07B05'),
  ('50000246', 'First246', 'Last246', 'm', 7, 'active', 0, false, false, 'First231 Last231 and First261 Last261', 'U07B05'),
  ('50000247', 'First247', 'Last247', 'm', 7, 'active', 1, false, false, 'First248 Last248', 'U07B05'),
  ('50000248', 'First248', 'Last248', 'm', 7, 'active', 3, false, false, 'First247 Last247', 'U07B05'),
  ('50000249', 'First249', 'Last249', 'm', 7, 'active', 3, false, false, 'UnregisteredFirst18 UnregisteredLast18', 'U07B05'),
  ('50000250', 'First250', 'Last250', 'm', 7, 'active', 2, true, false, 'First245 Last245', 'U07B05'),
  ('50000251', 'First251', 'Last251', 'm', 6, 'active', 3, true, true, 'First229 Last229', 'U07B06'),
  ('50000252', 'First252', 'Last252', 'm', 7, 'active', 1, false, false, 'First253 Last253', 'U07B06'),
  ('50000253', 'First253', 'Last253', 'm', 7, 'active', 1, false, false, 'First252 Last252', 'U07B06'),
  ('50000254', 'First254', 'Last254', 'm', 6, 'active', 2, true, true, 'First250 Last250', 'U07B06'),
  ('50000255', 'First255', 'Last255', 'm', 7, 'active', 1, false, false, 'First257 Last257', 'U07B06'),
  ('50000256', 'First256', 'Last256', 'm', 7, 'active', 2, false, false, 'First224 Last224', 'U07B06'),
  ('50000257', 'First257', 'Last257', 'm', 7, 'active', 1, false, false, 'First255 Last255', 'U07B06'),
  ('50000258', 'First258', 'Last258', 'm', 7, 'active', 2, true, false, 'First259 Last259', 'U07B07'),
  ('50000259', 'First259', 'Last259', 'm', 7, 'active', 3, false, false, 'First258 Last258', 'U07B07'),
  ('50000260', 'First260', 'Last260', 'm', 7, 'active', 1, false, false, 'UnregisteredFirst19 UnregisteredLast19', 'U07B07'),
  ('50000261', 'First261', 'Last261', 'm', 7, 'active', 0, false, false, 'UnregisteredFirst20 UnregisteredLast20', 'U07B07'),
  ('50000262', 'First262', 'Last262', 'm', 7, 'active', 2, true, false, 'First217 Last217', 'U07B07'),
  ('50000263', 'First263', 'Last263', 'm', 7, 'active', 0, false, false, 'First269 Last269', 'U07B07'),
  ('50000264', 'First264', 'Last264', 'm', 7, 'active', 3, true, false, 'First239 Last239', 'U07B07'),
  ('50000265', 'First265', 'Last265', 'm', 7, 'active', 2, false, false, NULL, 'U07B08'),
  ('50000266', 'First266', 'Last266', 'm', 7, 'active', 3, true, false, 'UnregisteredFirst21 UnregisteredLast21', 'U07B08'),
  ('50000267', 'First267', 'Last267', 'm', 7, 'active', 3, true, false, 'First268 Last268', 'U07B08'),
  ('50000268', 'First268', 'Last268', 'm', 7, 'active', 4, true, false, 'First267 Last267', 'U07B08'),
  ('50000269', 'First269', 'Last269', 'm', 7, 'active', 1, false, false, NULL, 'U07B08'),
  ('50000270', 'First270', 'Last270', 'm', 7, 'active', 1, false, false, NULL, 'U07B08'),
  ('50000271', 'First271', 'Last271', 'm', 7, 'active', 0, true, false, NULL, 'U07B08'),
  ('50000272', 'First272', 'Last272', 'f', 7, 'active', 1, false, false, 'UnregisteredFirst22 UnregisteredLast22', 'U07G01'),
  ('50000273', 'First273', 'Last273', 'f', 7, 'active', 2, true, false, 'First276 Last276', 'U07G01'),
  ('50000274', 'First274', 'Last274', 'f', 7, 'active', 1, false, false, 'First275 Last275', 'U07G01'),
  ('50000275', 'First275', 'Last275', 'f', 7, 'active', 0, false, false, 'First274 Last274', 'U07G01'),
  ('50000276', 'First276', 'Last276', 'f', 7, 'active', 2, false, false, 'First273 Last273', 'U07G01'),
  ('50000277', 'First277', 'Last277', 'f', 7, 'active', 1, false, false, NULL, 'U07G01'),
  ('50000278', 'First278', 'Last278', 'f', 7, 'active', 3, false, false, NULL, 'U07G01'),
  ('50000279', 'First279', 'Last279', 'f', 7, 'active', 0, true, false, 'UnregisteredFirst23 UnregisteredLast23', 'U07G02'),
  ('50000280', 'First280', 'Last280', 'f', 7, 'active', 2, false, false, NULL, 'U07G02'),
  ('50000281', 'First281', 'Last281', 'f', 7, 'active', 2, true, false, 'UnregisteredFirst24 UnregisteredLast24', 'U07G02'),
  ('50000282', 'First282', 'Last282', 'f', 7, 'active', 2, false, false, 'First283 Last283', 'U07G02'),
  ('50000283', 'First283', 'Last283', 'f', 7, 'active', 2, false, false, 'First282 Last282', 'U07G02'),
  ('50000284', 'First284', 'Last284', 'f', 7, 'active', 1, false, false, NULL, 'U07G02'),
  ('50000285', 'First285', 'Last285', 'f', 7, 'active', 0, false, false, NULL, 'U07G02'),
  ('50000286', 'First286', 'Last286', 'f', 7, 'active', 0, false, false, NULL, 'U07G03'),
  ('50000287', 'First287', 'Last287', 'f', 7, 'active', 2, false, false, 'First314 Last314', 'U07G03'),
  ('50000288', 'First288', 'Last288', 'f', 7, 'active', 1, true, false, 'First273 Last273', 'U07G03'),
  ('50000289', 'First289', 'Last289', 'f', 7, 'active', 0, false, false, 'First279 Last279', 'U07G03'),
  ('50000290', 'First290', 'Last290', 'f', 7, 'active', 0, false, false, 'First291 Last291', 'U07G03'),
  ('50000291', 'First291', 'Last291', 'f', 7, 'active', 0, false, false, 'First290 Last290', 'U07G03'),
  ('50000292', 'First292', 'Last292', 'f', 7, 'active', 0, false, false, NULL, 'U07G03'),
  ('50000293', 'First293', 'Last293', 'f', 7, 'active', 2, true, false, 'UnregisteredFirst25 UnregisteredLast25', 'U07G04'),
  ('50000294', 'First294', 'Last294', 'f', 7, 'active', 1, false, false, NULL, 'U07G04'),
  ('50000295', 'First295', 'Last295', 'f', 7, 'active', 1, false, false, NULL, 'U07G04'),
  ('50000296', 'First296', 'Last296', 'f', 7, 'active', 1, false, false, 'First297 Last297', 'U07G04'),
  ('50000297', 'First297', 'Last297', 'f', 7, 'active', 0, false, false, 'First296 Last296', 'U07G04'),
  ('50000298', 'First298', 'Last298', 'f', 7, 'active', 0, true, false, NULL, 'U07G04'),
  ('50000299', 'First299', 'Last299', 'f', 7, 'active', 0, false, false, NULL, 'U07G04'),
  ('50000300', 'First300', 'Last300', 'f', 7, 'active', 2, false, false, 'UnregisteredFirst26 UnregisteredLast26', 'U07G05'),
  ('50000301', 'First301', 'Last301', 'f', 6, 'active', 1, true, true, 'UnregisteredFirst22 UnregisteredLast22', 'U07G05'),
  ('50000302', 'First302', 'Last302', 'f', 7, 'active', 0, false, false, 'First304 Last304', 'U07G05'),
  ('50000303', 'First303', 'Last303', 'f', 7, 'active', 1, false, false, NULL, 'U07G05'),
  ('50000304', 'First304', 'Last304', 'f', 7, 'active', 0, false, false, 'First302 Last302', 'U07G05'),
  ('50000305', 'First305', 'Last305', 'f', 7, 'active', 0, false, false, NULL, 'U07G05'),
  ('50000306', 'First306', 'Last306', 'f', 7, 'active', 0, false, false, NULL, 'U07G05'),
  ('50000307', 'First307', 'Last307', 'f', 7, 'active', 0, true, false, NULL, 'U07G06'),
  ('50000308', 'First308', 'Last308', 'f', 7, 'active', 1, true, false, 'First300 Last300', 'U07G06'),
  ('50000309', 'First309', 'Last309', 'f', 7, 'active', 2, false, false, 'First321 Last321', 'U07G06'),
  ('50000310', 'First310', 'Last310', 'f', 7, 'active', 0, false, false, 'First312 Last312', 'U07G06'),
  ('50000311', 'First311', 'Last311', 'f', 7, 'active', 0, false, false, NULL, 'U07G06'),
  ('50000312', 'First312', 'Last312', 'f', 7, 'active', 0, false, false, 'First310 Last310', 'U07G06'),
  ('50000313', 'First313', 'Last313', 'f', 7, 'active', 2, false, false, NULL, 'U07G06'),
  ('50000314', 'First314', 'Last314', 'f', 7, 'active', 1, false, false, 'UnregisteredFirst27 UnregisteredLast27', 'U07G07'),
  ('50000315', 'First315', 'Last315', 'f', 7, 'active', 2, false, false, 'First320 Last320', 'U07G07'),
  ('50000316', 'First316', 'Last316', 'f', 7, 'active', 0, false, false, NULL, 'U07G07'),
  ('50000317', 'First317', 'Last317', 'f', 7, 'active', 1, false, false, 'First281 Last281', 'U07G07'),
  ('50000318', 'First318', 'Last318', 'f', 7, 'active', 0, false, false, NULL, 'U07G07'),
  ('50000319', 'First319', 'Last319', 'f', 7, 'active', 2, false, false, 'First199 Last199', 'U07G07'),
  ('50000320', 'First320', 'Last320', 'f', 7, 'active', 1, false, false, 'First315 Last315', 'U07G07'),
  ('50000321', 'First321', 'Last321', 'f', 7, 'active', 1, false, false, 'UnregisteredFirst28 UnregisteredLast28', 'U07G08'),
  ('50000322', 'First322', 'Last322', 'f', 7, 'active', 1, false, false, NULL, 'U07G08'),
  ('50000323', 'First323', 'Last323', 'f', 7, 'active', 1, false, false, 'First324 Last324', 'U07G08'),
  ('50000324', 'First324', 'Last324', 'f', 7, 'active', 1, false, false, 'First323 Last323', 'U07G08'),
  ('50000325', 'First325', 'Last325', 'f', 7, 'active', 2, false, false, 'UnregisteredFirst29 UnregisteredLast29', 'U07G08'),
  ('50000326', 'First326', 'Last326', 'f', 7, 'active', 1, false, false, NULL, 'U07G08'),
  ('50000327', 'First327', 'Last327', 'f', 7, 'active', 1, false, false, 'First288 Last288', 'U07G08'),
  ('50000328', 'First328', 'Last328', 'm', 8, 'active', 3, false, false, 'First331 Last331', 'U08B01'),
  ('50000329', 'First329', 'Last329', 'm', 8, 'active', 1, false, false, NULL, 'U08B01'),
  ('50000330', 'First330', 'Last330', 'm', 8, 'active', 2, false, false, 'First383 Last383', 'U08B01'),
  ('50000331', 'First331', 'Last331', 'm', 8, 'active', 3, false, false, 'First328 Last328', 'U08B01'),
  ('50000332', 'First332', 'Last332', 'm', 8, 'active', 2, true, false, 'UnregisteredFirst30 UnregisteredLast30', 'U08B01'),
  ('50000333', 'First333', 'Last333', 'm', 7, 'active', 0, true, true, 'First334 Last334', 'U08B01'),
  ('50000334', 'First334', 'Last334', 'm', 7, 'active', 1, false, true, 'First333 Last333', 'U08B01'),
  ('50000335', 'First335', 'Last335', 'm', 8, 'active', 0, false, false, 'First336 Last336', 'U08B02'),
  ('50000336', 'First336', 'Last336', 'm', 8, 'active', 0, false, false, 'First335 Last335', 'U08B02'),
  ('50000337', 'First337', 'Last337', 'm', 8, 'active', 3, false, false, NULL, 'U08B02'),
  ('50000338', 'First338', 'Last338', 'm', 8, 'active', 0, false, false, NULL, 'U08B02'),
  ('50000339', 'First339', 'Last339', 'm', 8, 'active', 3, false, false, 'First341 Last341', 'U08B02'),
  ('50000340', 'First340', 'Last340', 'm', 7, 'active', 1, false, true, 'N/A', 'U08B02'),
  ('50000341', 'First341', 'Last341', 'm', 8, 'active', 0, false, false, 'First339 Last339', 'U08B02'),
  ('50000342', 'First342', 'Last342', 'm', 8, 'active', 2, false, false, 'First345 Last345', 'U08B03'),
  ('50000343', 'First343', 'Last343', 'm', 8, 'active', 3, false, false, 'First344 Last344', 'U08B03'),
  ('50000344', 'First344', 'Last344', 'm', 8, 'active', 0, false, false, 'First343 Last343', 'U08B03'),
  ('50000345', 'First345', 'Last345', 'm', 7, 'active', 3, true, true, 'First342 Last342', 'U08B03'),
  ('50000346', 'First346', 'Last346', 'm', 8, 'active', 4, false, false, NULL, 'U08B03'),
  ('50000347', 'First347', 'Last347', 'm', 8, 'active', 2, false, false, 'First348 Last348', 'U08B03'),
  ('50000348', 'First348', 'Last348', 'm', 8, 'active', 2, false, false, 'First347 Last347', 'U08B03'),
  ('50000349', 'First349', 'Last349', 'm', 8, 'active', 3, false, false, 'First351 Last351', 'U08B04'),
  ('50000350', 'First350', 'Last350', 'm', 8, 'active', 0, false, false, NULL, 'U08B04'),
  ('50000351', 'First351', 'Last351', 'm', 8, 'active', 4, false, false, 'First349 Last349', 'U08B04'),
  ('50000352', 'First352', 'Last352', 'm', 8, 'active', 1, false, false, 'First330 Last330', 'U08B04'),
  ('50000353', 'First353', 'Last353', 'm', 8, 'active', 2, true, false, 'UnregisteredFirst31 UnregisteredLast31', 'U08B04'),
  ('50000354', 'First354', 'Last354', 'm', 8, 'active', 3, false, false, 'First355 Last355', 'U08B04'),
  ('50000355', 'First355', 'Last355', 'm', 8, 'active', 0, false, false, 'First354 Last354', 'U08B04'),
  ('50000356', 'First356', 'Last356', 'm', 8, 'active', 2, false, false, NULL, 'U08B05'),
  ('50000357', 'First357', 'Last357', 'm', 8, 'active', 3, false, false, 'First358 Last358', 'U08B05'),
  ('50000358', 'First358', 'Last358', 'm', 8, 'active', 4, false, false, 'First357 Last357', 'U08B05'),
  ('50000359', 'First359', 'Last359', 'm', 8, 'active', 1, false, false, 'First360 Last360', 'U08B05'),
  ('50000360', 'First360', 'Last360', 'm', 8, 'active', 0, false, false, 'First359 Last359', 'U08B05'),
  ('50000361', 'First361', 'Last361', 'm', 8, 'active', 0, false, false, 'First362 Last362', 'U08B05'),
  ('50000362', 'First362', 'Last362', 'm', 8, 'active', 0, false, false, 'First361 Last361', 'U08B05'),
  ('50000363', 'First363', 'Last363', 'm', 8, 'active', 2, false, false, 'First364 Last364', 'U08B06'),
  ('50000364', 'First364', 'Last364', 'm', 7, 'active', 2, true, true, 'First363 Last363', 'U08B06'),
  ('50000365', 'First365', 'Last365', 'm', 8, 'active', 1, false, false, 'First366 Last366', 'U08B06'),
  ('50000366', 'First366', 'Last366', 'm', 8, 'active', 0, false, false, 'First365 Last365', 'U08B06'),
  ('50000367', 'First367', 'Last367', 'm', 8, 'active', 0, false, false, NULL, 'U08B06'),
  ('50000368', 'First368', 'Last368', 'm', 8, 'active', 0, false, false, 'First369 Last369', 'U08B06'),
  ('50000369', 'First369', 'Last369', 'm', 8, 'active', 0, false, false, 'First368 Last368', 'U08B06'),
  ('50000370', 'First370', 'Last370', 'm', 8, 'active', 3, false, false, NULL, 'U08B07'),
  ('50000371', 'First371', 'Last371', 'm', 8, 'active', 1, false, false, NULL, 'U08B07'),
  ('50000372', 'First372', 'Last372', 'm', 8, 'active', 1, false, false, 'First379 Last379', 'U08B07'),
  ('50000373', 'First373', 'Last373', 'm', 8, 'active', 4, true, false, 'First374 Last374', 'U08B07'),
  ('50000374', 'First374', 'Last374', 'm', 8, 'active', 4, false, false, 'First373 Last373', 'U08B07'),
  ('50000375', 'First375', 'Last375', 'm', 8, 'active', 3, false, false, 'First376 Last376', 'U08B07'),
  ('50000376', 'First376', 'Last376', 'm', 8, 'active', 2, false, false, 'First375 Last375', 'U08B07'),
  ('50000377', 'First377', 'Last377', 'm', 8, 'active', 3, false, false, 'First382 Last382', 'U08B08'),
  ('50000378', 'First378', 'Last378', 'm', 8, 'active', 2, false, false, NULL, 'U08B08'),
  ('50000379', 'First379', 'Last379', 'm', 8, 'active', 2, false, false, NULL, 'U08B08'),
  ('50000380', 'First380', 'Last380', 'm', 8, 'active', 1, false, false, 'First381 Last381', 'U08B08'),
  ('50000381', 'First381', 'Last381', 'm', 8, 'active', 0, false, false, 'First380 Last380', 'U08B08'),
  ('50000382', 'First382', 'Last382', 'm', 8, 'active', 3, true, false, 'First377 Last377', 'U08B08'),
  ('50000383', 'First383', 'Last383', 'm', 8, 'active', 2, false, false, 'UnregisteredFirst32 UnregisteredLast32', 'U08B08'),
  ('50000384', 'First384', 'Last384', 'f', 8, 'active', 1, false, false, 'UnregisteredFirst33 UnregisteredLast33', 'U08G01'),
  ('50000385', 'First385', 'Last385', 'f', 7, 'active', 2, true, true, 'UnregisteredFirst34 UnregisteredLast34', 'U08G01'),
  ('50000386', 'First386', 'Last386', 'f', 8, 'active', 1, false, false, NULL, 'U08G01'),
  ('50000387', 'First387', 'Last387', 'f', 8, 'active', 3, false, false, NULL, 'U08G01'),
  ('50000388', 'First388', 'Last388', 'f', 8, 'active', 1, false, false, 'First389 Last389', 'U08G01'),
  ('50000389', 'First389', 'Last389', 'f', 7, 'active', 1, true, true, 'First388 Last388', 'U08G01'),
  ('50000390', 'First390', 'Last390', 'f', 8, 'active', 0, false, false, NULL, 'U08G01'),
  ('50000391', 'First391', 'Last391', 'f', 8, 'active', 1, false, false, 'N/A', 'U08G02'),
  ('50000392', 'First392', 'Last392', 'f', 8, 'active', 2, false, false, NULL, 'U08G02'),
  ('50000393', 'First393', 'Last393', 'f', 8, 'active', 1, false, false, 'First396 Last396', 'U08G02'),
  ('50000394', 'First394', 'Last394', 'f', 8, 'active', 0, false, false, 'UnregisteredFirst35 UnregisteredLast35', 'U08G02'),
  ('50000395', 'First395', 'Last395', 'f', 8, 'active', 0, false, false, NULL, 'U08G02'),
  ('50000396', 'First396', 'Last396', 'f', 8, 'active', 1, false, false, 'First393 Last393', 'U08G02'),
  ('50000397', 'First397', 'Last397', 'f', 8, 'active', 0, false, false, NULL, 'U08G02'),
  ('50000398', 'First398', 'Last398', 'f', 8, 'active', 2, false, false, 'N/A', 'U08G03'),
  ('50000399', 'First399', 'Last399', 'f', 8, 'active', 0, false, false, NULL, 'U08G03'),
  ('50000400', 'First400', 'Last400', 'f', 8, 'active', 3, true, false, 'First401 Last401', 'U08G03'),
  ('50000401', 'First401', 'Last401', 'f', 8, 'active', 3, false, false, 'First400 Last400', 'U08G03'),
  ('50000402', 'First402', 'Last402', 'f', 8, 'active', 3, false, false, NULL, 'U08G03'),
  ('50000403', 'First403', 'Last403', 'f', 8, 'active', 2, false, false, 'First404 Last404', 'U08G03'),
  ('50000404', 'First404', 'Last404', 'f', 8, 'active', 3, false, false, 'First403 Last403', 'U08G03'),
  ('50000405', 'First405', 'Last405', 'f', 8, 'active', 3, false, false, 'First406 Last406', 'U08G04'),
  ('50000406', 'First406', 'Last406', 'f', 8, 'active', 4, false, false, 'First405 Last405', 'U08G04'),
  ('50000407', 'First407', 'Last407', 'f', 8, 'active', 1, false, false, NULL, 'U08G04'),
  ('50000408', 'First408', 'Last408', 'f', 8, 'active', 2, false, false, NULL, 'U08G04'),
  ('50000409', 'First409', 'Last409', 'f', 8, 'active', 0, false, false, 'N/A', 'U08G04'),
  ('50000410', 'First410', 'Last410', 'f', 8, 'active', 1, true, false, 'First419 Last419', 'U08G04'),
  ('50000411', 'First411', 'Last411', 'f', 8, 'active', 0, false, false, NULL, 'U08G04'),
  ('50000412', 'First412', 'Last412', 'f', 8, 'active', 3, false, false, 'First416 Last416', 'U08G05'),
  ('50000413', 'First413', 'Last413', 'f', 8, 'active', 1, false, false, NULL, 'U08G05'),
  ('50000414', 'First414', 'Last414', 'f', 8, 'active', 3, false, false, NULL, 'U08G05'),
  ('50000415', 'First415', 'Last415', 'f', 8, 'active', 1, false, false, NULL, 'U08G05'),
  ('50000416', 'First416', 'Last416', 'f', 8, 'active', 2, false, false, 'First412 Last412', 'U08G05'),
  ('50000417', 'First417', 'Last417', 'f', 8, 'active', 2, false, false, NULL, 'U08G05'),
  ('50000418', 'First418', 'Last418', 'f', 8, 'active', 4, true, false, 'UnregisteredFirst36 UnregisteredLast36', 'U08G05'),
  ('50000419', 'First419', 'Last419', 'f', 8, 'active', 2, false, false, NULL, 'U08G06'),
  ('50000420', 'First420', 'Last420', 'f', 8, 'active', 1, false, false, 'First422 Last422', 'U08G06'),
  ('50000421', 'First421', 'Last421', 'f', 8, 'active', 1, false, false, 'First413 Last413', 'U08G06'),
  ('50000422', 'First422', 'Last422', 'f', 8, 'active', 4, true, false, 'First420 Last420', 'U08G06'),
  ('50000423', 'First423', 'Last423', 'f', 8, 'active', 1, false, false, NULL, 'U08G06'),
  ('50000424', 'First424', 'Last424', 'f', 8, 'active', 0, false, false, NULL, 'U08G06'),
  ('50000425', 'First425', 'Last425', 'f', 8, 'active', 2, false, false, NULL, 'U08G06'),
  ('50000426', 'First426', 'Last426', 'f', 8, 'active', 3, false, false, 'N/A', 'U08G07'),
  ('50000427', 'First427', 'Last427', 'f', 8, 'active', 1, false, false, 'First554 Last554', 'U08G07'),
  ('50000428', 'First428', 'Last428', 'f', 8, 'active', 1, false, false, NULL, 'U08G07'),
  ('50000429', 'First429', 'Last429', 'f', 8, 'active', 3, false, false, 'First329 Last329', 'U08G07'),
  ('50000430', 'First430', 'Last430', 'f', 8, 'active', 3, false, false, 'First432 Last432', 'U08G07'),
  ('50000431', 'First431', 'Last431', 'f', 8, 'active', 3, false, false, NULL, 'U08G07'),
  ('50000432', 'First432', 'Last432', 'f', 8, 'active', 2, true, false, 'First430 Last430', 'U08G07'),
  ('50000433', 'First433', 'Last433', 'f', 8, 'active', 0, false, false, 'N/A', 'U08G08'),
  ('50000434', 'First434', 'Last434', 'f', 8, 'active', 3, false, false, 'First394 Last394', 'U08G08'),
  ('50000435', 'First435', 'Last435', 'f', 8, 'active', 4, false, false, 'First436 Last436', 'U08G08'),
  ('50000436', 'First436', 'Last436', 'f', 8, 'active', 2, false, false, 'First435 Last435', 'U08G08'),
  ('50000437', 'First437', 'Last437', 'f', 8, 'active', 2, false, false, NULL, 'U08G08'),
  ('50000438', 'First438', 'Last438', 'f', 8, 'active', 1, false, false, 'First439 Last439', 'U08G08'),
  ('50000439', 'First439', 'Last439', 'f', 8, 'active', 0, false, false, 'First438 Last438', 'U08G08'),
  ('50000440', 'First440', 'Last440', 'm', 9, 'active', 1, false, false, 'N/A', 'U09B01'),
  ('50000441', 'First441', 'Last441', 'm', 9, 'active', 2, false, false, NULL, 'U09B01'),
  ('50000442', 'First442', 'Last442', 'm', 9, 'active', 3, false, false, 'First507 Last507', 'U09B01'),
  ('50000443', 'First443', 'Last443', 'm', 9, 'active', 4, false, false, 'First448 Last448', 'U09B01'),
  ('50000444', 'First444', 'Last444', 'm', 9, 'active', 0, false, false, NULL, 'U09B01'),
  ('50000445', 'First445', 'Last445', 'm', 9, 'active', 1, true, false, 'First446 Last446', 'U09B01'),
  ('50000446', 'First446', 'Last446', 'm', 9, 'active', 2, false, false, 'First445 Last445', 'U09B01'),
  ('50000447', 'First447', 'Last447', 'm', 9, 'active', 4, true, false, 'First450 Last450', 'U09B01'),
  ('50000448', 'First448', 'Last448', 'm', 9, 'active', 1, false, false, 'First443 Last443', 'U09B01'),
  ('50000449', 'First449', 'Last449', 'm', 9, 'active', 1, false, false, NULL, 'U09B01'),
  ('50000450', 'First450', 'Last450', 'm', 9, 'active', 4, false, false, 'First447 Last447', 'U09B01'),
  ('50000451', 'First451', 'Last451', 'm', 9, 'active', 3, false, false, NULL, 'U09B02'),
  ('50000452', 'First452', 'Last452', 'm', 9, 'active', 2, false, false, 'First456 Last456', 'U09B02'),
  ('50000453', 'First453', 'Last453', 'm', 9, 'active', 0, false, false, 'First454 Last454', 'U09B02'),
  ('50000454', 'First454', 'Last454', 'm', 9, 'active', 2, false, false, 'First453 Last453', 'U09B02'),
  ('50000455', 'First455', 'Last455', 'm', 9, 'active', 3, false, false, NULL, 'U09B02'),
  ('50000456', 'First456', 'Last456', 'm', 9, 'active', 4, true, false, 'First452 Last452', 'U09B02'),
  ('50000457', 'First457', 'Last457', 'm', 9, 'active', 1, false, false, NULL, 'U09B02'),
  ('50000458', 'First458', 'Last458', 'm', 9, 'active', 2, false, false, 'First632 Last632', 'U09B02'),
  ('50000459', 'First459', 'Last459', 'm', 9, 'active', 2, false, false, NULL, 'U09B02'),
  ('50000460', 'First460', 'Last460', 'm', 9, 'active', 1, false, false, NULL, 'U09B02'),
  ('50000461', 'First461', 'Last461', 'm', 9, 'active', 0, false, false, 'UnregisteredFirst37 UnregisteredLast37', 'U09B02'),
  ('50000462', 'First462', 'Last462', 'm', 9, 'active', 1, false, false, 'N/A', 'U09B03'),
  ('50000463', 'First463', 'Last463', 'm', 9, 'active', 0, true, false, NULL, 'U09B03'),
  ('50000464', 'First464', 'Last464', 'm', 9, 'active', 0, false, false, NULL, 'U09B03'),
  ('50000465', 'First465', 'Last465', 'm', 9, 'active', 1, false, false, 'First470 Last470', 'U09B03'),
  ('50000466', 'First466', 'Last466', 'm', 9, 'active', 0, false, false, NULL, 'U09B03'),
  ('50000467', 'First467', 'Last467', 'm', 9, 'active', 3, false, false, 'First468 Last468', 'U09B03'),
  ('50000468', 'First468', 'Last468', 'm', 9, 'active', 1, false, false, 'First467 Last467', 'U09B03'),
  ('50000469', 'First469', 'Last469', 'm', 9, 'active', 1, false, false, 'First440 Last440 and First473 Last473', 'U09B03'),
  ('50000470', 'First470', 'Last470', 'm', 9, 'active', 2, false, false, 'First465 Last465', 'U09B03'),
  ('50000471', 'First471', 'Last471', 'm', 9, 'active', 1, false, false, 'First487 Last487 and First474 Last474', 'U09B03'),
  ('50000472', 'First472', 'Last472', 'm', 9, 'active', 0, false, false, 'First440 Last440 and First454 Last454 and First453 Last453', 'U09B03'),
  ('50000473', 'First473', 'Last473', 'm', 9, 'active', 1, false, false, 'N/A', 'U09B04'),
  ('50000474', 'First474', 'Last474', 'm', 9, 'active', 3, false, false, 'First475 Last475', 'U09B04'),
  ('50000475', 'First475', 'Last475', 'm', 9, 'active', 4, false, false, 'First474 Last474', 'U09B04'),
  ('50000476', 'First476', 'Last476', 'm', 9, 'active', 2, true, false, 'First460 Last460', 'U09B04'),
  ('50000477', 'First477', 'Last477', 'm', 9, 'active', 1, false, false, 'First478 Last478', 'U09B04'),
  ('50000478', 'First478', 'Last478', 'm', 9, 'active', 1, false, false, 'First477 Last477', 'U09B04'),
  ('50000479', 'First479', 'Last479', 'm', 9, 'active', 3, false, false, NULL, 'U09B04'),
  ('50000480', 'First480', 'Last480', 'm', 9, 'active', 1, false, false, NULL, 'U09B04'),
  ('50000481', 'First481', 'Last481', 'm', 9, 'active', 0, false, false, NULL, 'U09B04'),
  ('50000482', 'First482', 'Last482', 'm', 9, 'active', 1, false, false, NULL, 'U09B04'),
  ('50000483', 'First483', 'Last483', 'm', 9, 'active', 0, false, false, NULL, 'U09B04'),
  ('50000484', 'First484', 'Last484', 'm', 9, 'active', 2, false, false, 'First485 Last485', 'U09B05'),
  ('50000485', 'First485', 'Last485', 'm', 9, 'active', 1, false, false, 'First484 Last484', 'U09B05'),
  ('50000486', 'First486', 'Last486', 'm', 9, 'active', 2, true, false, 'First487 Last487', 'U09B05'),
  ('50000487', 'First487', 'Last487', 'm', 9, 'active', 2, true, false, 'First486 Last486', 'U09B05'),
  ('50000488', 'First488', 'Last488', 'm', 9, 'active', 1, false, false, 'First462 Last462', 'U09B05'),
  ('50000489', 'First489', 'Last489', 'm', 9, 'active', 0, false, false, NULL, 'U09B05'),
  ('50000490', 'First490', 'Last490', 'm', 9, 'active', 2, false, false, NULL, 'U09B05'),
  ('50000491', 'First491', 'Last491', 'm', 9, 'active', 2, false, false, 'First492 Last492', 'U09B05'),
  ('50000492', 'First492', 'Last492', 'm', 9, 'active', 2, false, false, 'First491 Last491', 'U09B05'),
  ('50000493', 'First493', 'Last493', 'm', 9, 'active', 2, false, false, NULL, 'U09B05'),
  ('50000494', 'First494', 'Last494', 'm', 9, 'active', 3, false, false, 'First524 Last524', 'U09B05'),
  ('50000495', 'First495', 'Last495', 'm', 9, 'active', 2, false, false, 'First496 Last496', 'U09B06'),
  ('50000496', 'First496', 'Last496', 'm', 9, 'active', 2, false, false, 'First495 Last495', 'U09B06'),
  ('50000497', 'First497', 'Last497', 'm', 9, 'active', 1, false, false, NULL, 'U09B06'),
  ('50000498', 'First498', 'Last498', 'm', 9, 'active', 4, true, false, 'First505 Last505', 'U09B06'),
  ('50000499', 'First499', 'Last499', 'm', 9, 'active', 4, false, false, 'UnregisteredFirst38 UnregisteredLast38', 'U09B06'),
  ('50000500', 'First500', 'Last500', 'm', 9, 'active', 3, false, false, 'First501 Last501', 'U09B06'),
  ('50000501', 'First501', 'Last501', 'm', 9, 'active', 2, false, false, 'First500 Last500', 'U09B06'),
  ('50000502', 'First502', 'Last502', 'm', 9, 'active', 4, false, false, NULL, 'U09B06'),
  ('50000503', 'First503', 'Last503', 'm', 9, 'active', 0, false, false, NULL, 'U09B06'),
  ('50000504', 'First504', 'Last504', 'm', 9, 'active', 2, false, false, NULL, 'U09B06'),
  ('50000505', 'First505', 'Last505', 'm', 9, 'active', 3, false, false, 'First498 Last498', 'U09B06'),
  ('50000506', 'First506', 'Last506', 'm', 8, 'active', 1, false, true, NULL, 'U09B07'),
  ('50000507', 'First507', 'Last507', 'm', 9, 'active', 3, false, false, 'UnregisteredFirst39 UnregisteredLast39', 'U09B07'),
  ('50000508', 'First508', 'Last508', 'm', 9, 'active', 1, false, false, NULL, 'U09B07'),
  ('50000509', 'First509', 'Last509', 'm', 9, 'active', 3, false, false, NULL, 'U09B07'),
  ('50000510', 'First510', 'Last510', 'm', 9, 'active', 2, false, false, 'First511 Last511', 'U09B07'),
  ('50000511', 'First511', 'Last511', 'm', 9, 'active', 4, false, false, 'First510 Last510', 'U09B07'),
  ('50000512', 'First512', 'Last512', 'm', 9, 'active', 4, false, false, NULL, 'U09B07'),
  ('50000513', 'First513', 'Last513', 'm', 9, 'active', 1, false, false, 'First514 Last514', 'U09B07'),
  ('50000514', 'First514', 'Last514', 'm', 9, 'active', 1, false, false, 'First513 Last513', 'U09B07'),
  ('50000515', 'First515', 'Last515', 'm', 9, 'active', 1, true, false, NULL, 'U09B07'),
  ('50000516', 'First516', 'Last516', 'm', 9, 'active', 4, false, false, 'UnregisteredFirst40 UnregisteredLast40', 'U09B07'),
  ('50000517', 'First517', 'Last517', 'm', 9, 'active', 2, false, false, 'First627 Last627 and First522 Last522', 'U09B08'),
  ('50000518', 'First518', 'Last518', 'm', 9, 'active', 0, false, false, 'First698 Last698', 'U09B08'),
  ('50000519', 'First519', 'Last519', 'm', 8, 'active', 5, true, true, 'First524 Last524', 'U09B08'),
  ('50000520', 'First520', 'Last520', 'm', 9, 'active', 2, false, false, 'UnregisteredFirst41 UnregisteredLast41', 'U09B08'),
  ('50000521', 'First521', 'Last521', 'm', 9, 'active', 2, false, false, NULL, 'U09B08'),
  ('50000522', 'First522', 'Last522', 'm', 9, 'active', 1, false, false, 'First517 Last517', 'U09B08'),
  ('50000523', 'First523', 'Last523', 'm', 9, 'active', 1, false, false, 'First337 Last337', 'U09B08'),
  ('50000524', 'First524', 'Last524', 'm', 9, 'active', 4, true, false, 'First519 Last519', 'U09B08'),
  ('50000525', 'First525', 'Last525', 'm', 9, 'active', 2, false, false, 'First520 Last520', 'U09B08'),
  ('50000526', 'First526', 'Last526', 'm', 9, 'active', 1, false, false, NULL, 'U09B08'),
  ('50000527', 'First527', 'Last527', 'm', 9, 'active', 3, false, false, NULL, 'U09B08'),
  ('50000528', 'First528', 'Last528', 'f', 9, 'active', 2, true, false, 'First530 Last530', 'U09G01'),
  ('50000529', 'First529', 'Last529', 'f', 9, 'active', 2, false, false, NULL, 'U09G01'),
  ('50000530', 'First530', 'Last530', 'f', 9, 'active', 2, false, false, 'First528 Last528', 'U09G01'),
  ('50000531', 'First531', 'Last531', 'f', 9, 'active', 1, false, false, 'N/A', 'U09G01'),
  ('50000532', 'First532', 'Last532', 'f', 8, 'active', 4, true, true, 'First533 Last533', 'U09G01'),
  ('50000533', 'First533', 'Last533', 'f', 9, 'active', 3, false, false, 'First532 Last532', 'U09G01'),
  ('50000534', 'First534', 'Last534', 'f', 9, 'active', 0, false, false, NULL, 'U09G01'),
  ('50000535', 'First535', 'Last535', 'f', 9, 'active', 2, false, false, NULL, 'U09G01'),
  ('50000536', 'First536', 'Last536', 'f', 9, 'active', 2, false, false, 'UnregisteredFirst42 UnregisteredLast42', 'U09G01'),
  ('50000537', 'First537', 'Last537', 'f', 9, 'active', 0, false, false, NULL, 'U09G01'),
  ('50000538', 'First538', 'Last538', 'f', 9, 'active', 2, false, false, NULL, 'U09G01'),
  ('50000539', 'First539', 'Last539', 'f', 9, 'active', 4, false, false, 'First536 Last536', 'U09G02'),
  ('50000540', 'First540', 'Last540', 'f', 9, 'active', 3, true, false, 'First544 Last544', 'U09G02'),
  ('50000541', 'First541', 'Last541', 'f', 9, 'active', 1, false, false, NULL, 'U09G02'),
  ('50000542', 'First542', 'Last542', 'f', 9, 'active', 1, false, false, 'N/A', 'U09G02'),
  ('50000543', 'First543', 'Last543', 'f', 9, 'active', 2, false, false, NULL, 'U09G02'),
  ('50000544', 'First544', 'Last544', 'f', 9, 'active', 3, false, false, 'First540 Last540', 'U09G02'),
  ('50000545', 'First545', 'Last545', 'f', 9, 'active', 1, false, false, 'First546 Last546', 'U09G02'),
  ('50000546', 'First546', 'Last546', 'f', 9, 'active', 0, false, false, 'First545 Last545', 'U09G02'),
  ('50000547', 'First547', 'Last547', 'f', 9, 'active', 0, false, false, NULL, 'U09G02'),
  ('50000548', 'First548', 'Last548', 'f', 9, 'active', 4, false, false, NULL, 'U09G02'),
  ('50000549', 'First549', 'Last549', 'f', 9, 'active', 2, false, false, NULL, 'U09G02'),
  ('50000550', 'First550', 'Last550', 'f', 9, 'active', 3, true, false, 'First552 Last552', 'U09G03'),
  ('50000551', 'First551', 'Last551', 'f', 8, 'active', 0, true, true, NULL, 'U09G03'),
  ('50000552', 'First552', 'Last552', 'f', 9, 'active', 3, false, false, 'First550 Last550', 'U09G03'),
  ('50000553', 'First553', 'Last553', 'f', 9, 'active', 2, false, false, 'First568 Last568', 'U09G03'),
  ('50000554', 'First554', 'Last554', 'f', 9, 'active', 3, true, false, 'First427 Last427', 'U09G03'),
  ('50000555', 'First555', 'Last555', 'f', 9, 'active', 1, false, false, NULL, 'U09G03'),
  ('50000556', 'First556', 'Last556', 'f', 9, 'active', 2, true, false, 'UnregisteredFirst43 UnregisteredLast43', 'U09G03'),
  ('50000557', 'First557', 'Last557', 'f', 9, 'active', 0, false, false, 'First558 Last558 and First531 Last531', 'U09G03'),
  ('50000558', 'First558', 'Last558', 'f', 9, 'active', 1, false, false, 'First557 Last557', 'U09G03'),
  ('50000559', 'First559', 'Last559', 'f', 9, 'active', 3, false, false, NULL, 'U09G03'),
  ('50000560', 'First560', 'Last560', 'f', 9, 'active', 2, false, false, NULL, 'U09G03'),
  ('50000561', 'First561', 'Last561', 'f', 7, 'active', 0, true, true, 'N/A', 'U09G04'),
  ('50000562', 'First562', 'Last562', 'f', 9, 'active', 1, false, false, 'First566 Last566', 'U09G04'),
  ('50000563', 'First563', 'Last563', 'f', 9, 'active', 4, false, false, 'UnregisteredFirst44 UnregisteredLast44', 'U09G04'),
  ('50000564', 'First564', 'Last564', 'f', 9, 'active', 3, false, false, 'First529 Last529', 'U09G04'),
  ('50000565', 'First565', 'Last565', 'f', 9, 'active', 2, false, false, NULL, 'U09G04'),
  ('50000566', 'First566', 'Last566', 'f', 9, 'active', 2, false, false, 'First562 Last562', 'U09G04'),
  ('50000567', 'First567', 'Last567', 'f', 9, 'active', 4, false, false, NULL, 'U09G04'),
  ('50000568', 'First568', 'Last568', 'f', 9, 'active', 5, false, false, NULL, 'U09G04'),
  ('50000569', 'First569', 'Last569', 'f', 9, 'active', 0, false, false, NULL, 'U09G04'),
  ('50000570', 'First570', 'Last570', 'f', 9, 'active', 4, false, false, NULL, 'U09G04'),
  ('50000571', 'First571', 'Last571', 'f', 9, 'active', 1, false, false, NULL, 'U09G04'),
  ('50000572', 'First572', 'Last572', 'f', 9, 'active', 0, false, false, NULL, 'U09G05'),
  ('50000573', 'First573', 'Last573', 'f', 9, 'active', 1, false, false, NULL, 'U09G05'),
  ('50000574', 'First574', 'Last574', 'f', 9, 'active', 1, false, false, 'First577 Last577', 'U09G05'),
  ('50000575', 'First575', 'Last575', 'f', 9, 'active', 3, false, false, 'First556 Last556', 'U09G05'),
  ('50000576', 'First576', 'Last576', 'f', 9, 'active', 0, false, false, NULL, 'U09G05'),
  ('50000577', 'First577', 'Last577', 'f', 9, 'active', 1, false, false, 'First574 Last574', 'U09G05'),
  ('50000578', 'First578', 'Last578', 'f', 9, 'active', 4, true, false, NULL, 'U09G05'),
  ('50000579', 'First579', 'Last579', 'f', 9, 'active', 2, false, false, NULL, 'U09G05'),
  ('50000580', 'First580', 'Last580', 'f', 9, 'active', 0, false, false, NULL, 'U09G05'),
  ('50000581', 'First581', 'Last581', 'f', 9, 'active', 1, false, false, NULL, 'U09G05'),
  ('50000582', 'First582', 'Last582', 'f', 9, 'active', 2, false, false, NULL, 'U09G05'),
  ('50000583', 'First583', 'Last583', 'f', 8, 'active', 2, true, true, 'First585 Last585', 'U09G06'),
  ('50000584', 'First584', 'Last584', 'f', 9, 'active', 3, false, false, 'UnregisteredFirst45 UnregisteredLast45', 'U09G06'),
  ('50000585', 'First585', 'Last585', 'f', 9, 'active', 1, true, false, 'First588 Last588', 'U09G06'),
  ('50000586', 'First586', 'Last586', 'f', 9, 'active', 1, false, false, 'UnregisteredFirst46 UnregisteredLast46', 'U09G06'),
  ('50000587', 'First587', 'Last587', 'f', 9, 'active', 0, false, false, NULL, 'U09G06'),
  ('50000588', 'First588', 'Last588', 'f', 8, 'active', 2, true, true, 'First585 Last585', 'U09G06'),
  ('50000589', 'First589', 'Last589', 'f', 9, 'active', 2, false, false, 'First590 Last590', 'U09G06'),
  ('50000590', 'First590', 'Last590', 'f', 9, 'active', 3, false, false, 'First589 Last589', 'U09G06'),
  ('50000591', 'First591', 'Last591', 'f', 9, 'active', 3, false, false, NULL, 'U09G06'),
  ('50000592', 'First592', 'Last592', 'f', 9, 'active', 1, false, false, NULL, 'U09G06'),
  ('50000593', 'First593', 'Last593', 'f', 9, 'active', 0, false, false, NULL, 'U09G06'),
  ('50000594', 'First594', 'Last594', 'f', 9, 'active', 3, false, false, 'UnregisteredFirst47 UnregisteredLast47', 'U09G07'),
  ('50000595', 'First595', 'Last595', 'f', 9, 'active', 3, false, false, NULL, 'U09G07'),
  ('50000596', 'First596', 'Last596', 'f', 9, 'active', 4, false, false, 'First597 Last597', 'U09G07'),
  ('50000597', 'First597', 'Last597', 'f', 9, 'active', 1, false, false, 'First596 Last596', 'U09G07'),
  ('50000598', 'First598', 'Last598', 'f', 9, 'active', 4, false, false, 'First606 Last606', 'U09G07'),
  ('50000599', 'First599', 'Last599', 'f', 9, 'active', 3, false, false, 'UnregisteredFirst48 UnregisteredLast48', 'U09G07'),
  ('50000600', 'First600', 'Last600', 'f', 9, 'active', 0, false, false, NULL, 'U09G07'),
  ('50000601', 'First601', 'Last601', 'f', 9, 'active', 3, true, false, 'UnregisteredFirst49 UnregisteredLast49', 'U09G07'),
  ('50000602', 'First602', 'Last602', 'f', 9, 'active', 0, false, false, NULL, 'U09G07'),
  ('50000603', 'First603', 'Last603', 'f', 9, 'active', 2, false, false, NULL, 'U09G07'),
  ('50000604', 'First604', 'Last604', 'f', 9, 'active', 0, false, false, NULL, 'U09G07'),
  ('50000605', 'First605', 'Last605', 'f', 9, 'active', 3, false, false, 'First726 Last726', 'U09G08'),
  ('50000606', 'First606', 'Last606', 'f', 9, 'active', 2, false, false, NULL, 'U09G08'),
  ('50000607', 'First607', 'Last607', 'f', 9, 'active', 3, false, false, 'First611 Last611', 'U09G08'),
  ('50000608', 'First608', 'Last608', 'f', 9, 'active', 3, false, false, NULL, 'U09G08'),
  ('50000609', 'First609', 'Last609', 'f', 9, 'active', 2, false, false, 'First599 Last599', 'U09G08'),
  ('50000610', 'First610', 'Last610', 'f', 9, 'active', 4, false, false, 'UnregisteredFirst50 UnregisteredLast50', 'U09G08'),
  ('50000611', 'First611', 'Last611', 'f', 9, 'active', 3, true, false, 'First607 Last607', 'U09G08'),
  ('50000612', 'First612', 'Last612', 'f', 9, 'active', 1, false, false, 'First772 Last772', 'U09G08'),
  ('50000613', 'First613', 'Last613', 'f', 9, 'active', 3, false, false, NULL, 'U09G08'),
  ('50000614', 'First614', 'Last614', 'f', 9, 'active', 2, false, false, NULL, 'U09G08'),
  ('50000615', 'First615', 'Last615', 'f', 9, 'active', 1, false, false, NULL, 'U09G08'),
  ('50000616', 'First616', 'Last616', 'm', 10, 'active', 3, false, false, NULL, 'U10B01'),
  ('50000617', 'First617', 'Last617', 'm', 10, 'active', 2, false, false, 'First618 Last618', 'U10B01'),
  ('50000618', 'First618', 'Last618', 'm', 10, 'active', 5, false, false, 'First617 Last617', 'U10B01'),
  ('50000619', 'First619', 'Last619', 'm', 10, 'active', 2, true, false, 'UnregisteredFirst51 UnregisteredLast51', 'U10B01'),
  ('50000620', 'First620', 'Last620', 'm', 10, 'active', 1, false, false, NULL, 'U10B01'),
  ('50000621', 'First621', 'Last621', 'm', 10, 'active', 3, false, false, 'First622 Last622', 'U10B01'),
  ('50000622', 'First622', 'Last622', 'm', 10, 'active', 3, false, false, 'First621 Last621', 'U10B01'),
  ('50000623', 'First623', 'Last623', 'm', 10, 'active', 5, false, false, 'UnregisteredFirst52 UnregisteredLast52', 'U10B01'),
  ('50000624', 'First624', 'Last624', 'm', 10, 'active', 0, false, false, 'First625 Last625', 'U10B01'),
  ('50000625', 'First625', 'Last625', 'm', 10, 'active', 3, false, false, 'First624 Last624', 'U10B01'),
  ('50000626', 'First626', 'Last626', 'm', 10, 'active', 3, false, false, NULL, 'U10B01'),
  ('50000627', 'First627', 'Last627', 'm', 10, 'active', 1, false, false, 'First663 Last663', 'U10B02'),
  ('50000628', 'First628', 'Last628', 'm', 10, 'active', 3, false, false, 'First695 Last695', 'U10B02'),
  ('50000629', 'First629', 'Last629', 'm', 10, 'active', 4, false, false, 'First633 Last633', 'U10B02'),
  ('50000630', 'First630', 'Last630', 'm', 10, 'active', 4, false, false, NULL, 'U10B02'),
  ('50000631', 'First631', 'Last631', 'm', 10, 'active', 3, false, false, 'First635 Last635', 'U10B02'),
  ('50000632', 'First632', 'Last632', 'm', 10, 'active', 1, false, false, 'First458 Last458', 'U10B02'),
  ('50000633', 'First633', 'Last633', 'm', 10, 'active', 3, true, false, 'First629 Last629', 'U10B02'),
  ('50000634', 'First634', 'Last634', 'm', 10, 'active', 1, false, false, NULL, 'U10B02'),
  ('50000635', 'First635', 'Last635', 'm', 10, 'active', 5, false, false, 'First631 Last631', 'U10B02'),
  ('50000636', 'First636', 'Last636', 'm', 10, 'active', 0, false, false, NULL, 'U10B02'),
  ('50000637', 'First637', 'Last637', 'm', 10, 'active', 1, false, false, NULL, 'U10B02'),
  ('50000638', 'First638', 'Last638', 'm', 10, 'active', 2, false, false, NULL, 'U10B03'),
  ('50000639', 'First639', 'Last639', 'm', 10, 'active', 0, true, false, 'First640 Last640', 'U10B03'),
  ('50000640', 'First640', 'Last640', 'm', 10, 'active', 4, false, false, 'First639 Last639', 'U10B03'),
  ('50000641', 'First641', 'Last641', 'm', 10, 'active', 0, false, false, 'N/A', 'U10B03'),
  ('50000642', 'First642', 'Last642', 'm', 10, 'active', 4, false, false, 'First643 Last643', 'U10B03'),
  ('50000643', 'First643', 'Last643', 'm', 10, 'active', 3, false, false, 'First642 Last642', 'U10B03'),
  ('50000644', 'First644', 'Last644', 'm', 10, 'active', 4, false, false, NULL, 'U10B03'),
  ('50000645', 'First645', 'Last645', 'm', 10, 'active', 4, false, false, 'First671 Last671', 'U10B03'),
  ('50000646', 'First646', 'Last646', 'm', 10, 'active', 3, false, false, NULL, 'U10B03'),
  ('50000647', 'First647', 'Last647', 'm', 10, 'active', 4, false, false, 'UnregisteredFirst53 UnregisteredLast53', 'U10B03'),
  ('50000648', 'First648', 'Last648', 'm', 9, 'active', 4, true, true, 'First647 Last647', 'U10B03'),
  ('50000649', 'First649', 'Last649', 'm', 10, 'active', 4, false, false, NULL, 'U10B04'),
  ('50000650', 'First650', 'Last650', 'm', 10, 'active', 0, false, false, 'First685 Last685', 'U10B04'),
  ('50000651', 'First651', 'Last651', 'm', 10, 'active', 1, false, false, 'First652 Last652', 'U10B04'),
  ('50000652', 'First652', 'Last652', 'm', 10, 'active', 1, false, false, 'First651 Last651', 'U10B04'),
  ('50000653', 'First653', 'Last653', 'm', 10, 'active', 4, false, false, 'UnregisteredFirst54 UnregisteredLast54', 'U10B04'),
  ('50000654', 'First654', 'Last654', 'm', 10, 'active', 5, false, false, NULL, 'U10B04'),
  ('50000655', 'First655', 'Last655', 'm', 10, 'active', 2, false, false, NULL, 'U10B04'),
  ('50000656', 'First656', 'Last656', 'm', 10, 'active', 3, true, false, 'First657 Last657', 'U10B04'),
  ('50000657', 'First657', 'Last657', 'm', 10, 'active', 3, false, false, 'First656 Last656', 'U10B04'),
  ('50000658', 'First658', 'Last658', 'm', 10, 'active', 0, false, false, NULL, 'U10B04'),
  ('50000659', 'First659', 'Last659', 'm', 10, 'active', 4, false, false, NULL, 'U10B04'),
  ('50000660', 'First660', 'Last660', 'm', 10, 'active', 5, false, false, 'First648 Last648', 'U10B05'),
  ('50000661', 'First661', 'Last661', 'm', 10, 'active', 2, false, false, NULL, 'U10B05'),
  ('50000662', 'First662', 'Last662', 'm', 10, 'active', 0, false, false, NULL, 'U10B05'),
  ('50000663', 'First663', 'Last663', 'm', 10, 'active', 1, false, false, 'UnregisteredFirst55 UnregisteredLast55', 'U10B05'),
  ('50000664', 'First664', 'Last664', 'm', 10, 'active', 1, false, false, NULL, 'U10B05'),
  ('50000665', 'First665', 'Last665', 'm', 10, 'active', 0, false, false, 'First666 Last666', 'U10B05'),
  ('50000666', 'First666', 'Last666', 'm', 10, 'active', 0, false, false, 'First665 Last665', 'U10B05'),
  ('50000667', 'First667', 'Last667', 'm', 10, 'active', 4, false, false, NULL, 'U10B05'),
  ('50000668', 'First668', 'Last668', 'm', 10, 'active', 4, true, false, 'First669 Last669', 'U10B05'),
  ('50000669', 'First669', 'Last669', 'm', 10, 'active', 0, false, false, 'First668 Last668', 'U10B05'),
  ('50000670', 'First670', 'Last670', 'm', 10, 'active', 1, false, false, NULL, 'U10B05'),
  ('50000671', 'First671', 'Last671', 'm', 10, 'active', 2, true, false, 'UnregisteredFirst56 UnregisteredLast56', 'U10B06'),
  ('50000672', 'First672', 'Last672', 'm', 9, 'active', 2, true, true, 'First673 Last673', 'U10B06'),
  ('50000673', 'First673', 'Last673', 'm', 10, 'active', 1, false, false, 'First672 Last672', 'U10B06'),
  ('50000674', 'First674', 'Last674', 'm', 10, 'active', 1, false, false, 'First675 Last675', 'U10B06'),
  ('50000675', 'First675', 'Last675', 'm', 10, 'active', 1, false, false, 'First674 Last674', 'U10B06'),
  ('50000676', 'First676', 'Last676', 'm', 10, 'active', 2, false, false, NULL, 'U10B06'),
  ('50000677', 'First677', 'Last677', 'm', 10, 'active', 4, false, false, 'UnregisteredFirst57 UnregisteredLast57', 'U10B06'),
  ('50000678', 'First678', 'Last678', 'm', 10, 'active', 1, true, false, NULL, 'U10B06'),
  ('50000679', 'First679', 'Last679', 'm', 10, 'active', 1, false, false, NULL, 'U10B06'),
  ('50000680', 'First680', 'Last680', 'm', 10, 'active', 0, false, false, NULL, 'U10B06'),
  ('50000681', 'First681', 'Last681', 'm', 10, 'active', 2, false, false, 'UnregisteredFirst58 UnregisteredLast58', 'U10B06'),
  ('50000682', 'First682', 'Last682', 'm', 10, 'active', 4, false, false, 'First686 Last686', 'U10B07'),
  ('50000683', 'First683', 'Last683', 'm', 10, 'active', 5, false, false, NULL, 'U10B07'),
  ('50000684', 'First684', 'Last684', 'm', 10, 'active', 3, false, false, 'N/A', 'U10B07'),
  ('50000685', 'First685', 'Last685', 'm', 9, 'active', 4, true, true, 'First681 Last681', 'U10B07'),
  ('50000686', 'First686', 'Last686', 'm', 10, 'active', 4, false, false, 'First682 Last682', 'U10B07'),
  ('50000687', 'First687', 'Last687', 'm', 10, 'active', 5, false, false, 'First877 Last877', 'U10B07'),
  ('50000688', 'First688', 'Last688', 'm', 10, 'active', 3, true, false, 'First623 Last623', 'U10B07'),
  ('50000689', 'First689', 'Last689', 'm', 10, 'active', 0, false, false, NULL, 'U10B07'),
  ('50000690', 'First690', 'Last690', 'm', 10, 'active', 4, false, false, NULL, 'U10B07'),
  ('50000691', 'First691', 'Last691', 'm', 10, 'active', 4, false, false, 'First692 Last692', 'U10B07'),
  ('50000692', 'First692', 'Last692', 'm', 10, 'active', 2, false, false, 'First691 Last691', 'U10B07'),
  ('50000693', 'First693', 'Last693', 'm', 10, 'active', 1, false, false, 'UnregisteredFirst59 UnregisteredLast59', 'U10B08'),
  ('50000694', 'First694', 'Last694', 'm', 10, 'active', 5, false, false, 'First695 Last695', 'U10B08'),
  ('50000695', 'First695', 'Last695', 'm', 10, 'active', 5, false, false, 'First694 Last694', 'U10B08'),
  ('50000696', 'First696', 'Last696', 'm', 10, 'active', 3, false, false, 'UnregisteredFirst60 UnregisteredLast60', 'U10B08'),
  ('50000697', 'First697', 'Last697', 'm', 10, 'active', 3, true, false, 'First696 Last696', 'U10B08'),
  ('50000698', 'First698', 'Last698', 'm', 10, 'active', 0, false, false, 'First518 Last518', 'U10B08'),
  ('50000699', 'First699', 'Last699', 'm', 10, 'active', 1, false, false, NULL, 'U10B08'),
  ('50000700', 'First700', 'Last700', 'm', 10, 'active', 0, false, false, NULL, 'U10B08'),
  ('50000701', 'First701', 'Last701', 'm', 10, 'active', 0, false, false, NULL, 'U10B08'),
  ('50000702', 'First702', 'Last702', 'm', 10, 'active', 5, true, false, 'UnregisteredFirst61 UnregisteredLast61', 'U10B08'),
  ('50000703', 'First703', 'Last703', 'm', 10, 'active', 0, false, false, NULL, 'U10B08'),
  ('50000704', 'First704', 'Last704', 'f', 10, 'active', 4, false, false, 'N/A', 'U10G01'),
  ('50000705', 'First705', 'Last705', 'f', 10, 'active', 1, false, false, NULL, 'U10G01'),
  ('50000706', 'First706', 'Last706', 'f', 9, 'active', 4, true, true, 'First709 Last709', 'U10G01'),
  ('50000707', 'First707', 'Last707', 'f', 10, 'active', 1, false, false, 'UnregisteredFirst62 UnregisteredLast62', 'U10G01'),
  ('50000708', 'First708', 'Last708', 'f', 10, 'active', 5, false, false, 'N/A', 'U10G01'),
  ('50000709', 'First709', 'Last709', 'f', 10, 'active', 2, false, false, 'First706 Last706', 'U10G01'),
  ('50000710', 'First710', 'Last710', 'f', 10, 'active', 2, false, false, NULL, 'U10G01'),
  ('50000711', 'First711', 'Last711', 'f', 10, 'active', 0, false, false, NULL, 'U10G01'),
  ('50000712', 'First712', 'Last712', 'f', 10, 'active', 2, false, false, NULL, 'U10G01'),
  ('50000713', 'First713', 'Last713', 'f', 10, 'active', 0, false, false, NULL, 'U10G01'),
  ('50000714', 'First714', 'Last714', 'f', 10, 'active', 3, false, false, NULL, 'U10G01'),
  ('50000715', 'First715', 'Last715', 'f', 10, 'active', 2, false, false, 'N/A', 'U10G02'),
  ('50000716', 'First716', 'Last716', 'f', 10, 'active', 2, true, false, NULL, 'U10G02'),
  ('50000717', 'First717', 'Last717', 'f', 10, 'active', 3, true, false, 'First566 Last566', 'U10G02'),
  ('50000718', 'First718', 'Last718', 'f', 10, 'active', 4, false, false, NULL, 'U10G02'),
  ('50000719', 'First719', 'Last719', 'f', 10, 'active', 2, false, false, NULL, 'U10G02'),
  ('50000720', 'First720', 'Last720', 'f', 10, 'active', 4, false, false, 'First739 Last739', 'U10G02'),
  ('50000721', 'First721', 'Last721', 'f', 10, 'active', 0, false, false, NULL, 'U10G02'),
  ('50000722', 'First722', 'Last722', 'f', 10, 'active', 3, false, false, NULL, 'U10G02'),
  ('50000723', 'First723', 'Last723', 'f', 10, 'active', 2, false, false, NULL, 'U10G02'),
  ('50000724', 'First724', 'Last724', 'f', 10, 'active', 0, false, false, NULL, 'U10G02'),
  ('50000725', 'First725', 'Last725', 'f', 10, 'active', 3, false, false, NULL, 'U10G02'),
  ('50000726', 'First726', 'Last726', 'f', 10, 'active', 3, false, false, 'First605 Last605', 'U10G03'),
  ('50000727', 'First727', 'Last727', 'f', 10, 'active', 4, true, false, 'UnregisteredFirst63 UnregisteredLast63', 'U10G03'),
  ('50000728', 'First728', 'Last728', 'f', 10, 'active', 3, true, false, 'First729 Last729', 'U10G03'),
  ('50000729', 'First729', 'Last729', 'f', 10, 'active', 1, false, false, 'First728 Last728', 'U10G03'),
  ('50000730', 'First730', 'Last730', 'f', 10, 'active', 4, false, false, 'First786 Last786', 'U10G03'),
  ('50000731', 'First731', 'Last731', 'f', 10, 'active', 0, false, false, NULL, 'U10G03'),
  ('50000732', 'First732', 'Last732', 'f', 10, 'active', 2, false, false, 'First708 Last708', 'U10G03'),
  ('50000733', 'First733', 'Last733', 'f', 10, 'active', 1, false, false, NULL, 'U10G03'),
  ('50000734', 'First734', 'Last734', 'f', 10, 'active', 3, false, false, NULL, 'U10G03'),
  ('50000735', 'First735', 'Last735', 'f', 10, 'active', 2, false, false, NULL, 'U10G03'),
  ('50000736', 'First736', 'Last736', 'f', 10, 'active', 2, false, false, NULL, 'U10G03'),
  ('50000737', 'First737', 'Last737', 'f', 10, 'active', 3, false, false, 'First738 Last738', 'U10G04'),
  ('50000738', 'First738', 'Last738', 'f', 10, 'active', 3, false, false, 'First737 Last737', 'U10G04'),
  ('50000739', 'First739', 'Last739', 'f', 10, 'active', 3, false, false, NULL, 'U10G04'),
  ('50000740', 'First740', 'Last740', 'f', 10, 'active', 1, false, false, NULL, 'U10G04'),
  ('50000741', 'First741', 'Last741', 'f', 10, 'active', 4, true, false, 'UnregisteredFirst64 UnregisteredLast64', 'U10G04'),
  ('50000742', 'First742', 'Last742', 'f', 10, 'active', 0, false, false, NULL, 'U10G04'),
  ('50000743', 'First743', 'Last743', 'f', 10, 'active', 5, false, false, 'UnregisteredFirst65 UnregisteredLast65', 'U10G04'),
  ('50000744', 'First744', 'Last744', 'f', 10, 'active', 0, false, false, NULL, 'U10G04'),
  ('50000745', 'First745', 'Last745', 'f', 10, 'active', 4, false, false, NULL, 'U10G04'),
  ('50000746', 'First746', 'Last746', 'f', 10, 'active', 2, false, false, NULL, 'U10G04'),
  ('50000747', 'First747', 'Last747', 'f', 10, 'active', 5, false, false, NULL, 'U10G04'),
  ('50000748', 'First748', 'Last748', 'f', 10, 'active', 3, false, false, 'First749 Last749', 'U10G05'),
  ('50000749', 'First749', 'Last749', 'f', 10, 'active', 4, false, false, 'First748 Last748', 'U10G05'),
  ('50000750', 'First750', 'Last750', 'f', 10, 'active', 4, false, false, 'UnregisteredFirst66 UnregisteredLast66', 'U10G05'),
  ('50000751', 'First751', 'Last751', 'f', 10, 'active', 3, false, false, NULL, 'U10G05'),
  ('50000752', 'First752', 'Last752', 'f', 10, 'active', 4, false, false, 'First730 Last730', 'U10G05'),
  ('50000753', 'First753', 'Last753', 'f', 10, 'active', 5, false, false, NULL, 'U10G05'),
  ('50000754', 'First754', 'Last754', 'f', 10, 'active', 0, false, false, NULL, 'U10G05'),
  ('50000755', 'First755', 'Last755', 'f', 10, 'active', 2, false, false, NULL, 'U10G05'),
  ('50000756', 'First756', 'Last756', 'f', 10, 'active', 3, false, false, NULL, 'U10G05'),
  ('50000757', 'First757', 'Last757', 'f', 10, 'active', 2, false, false, NULL, 'U10G05'),
  ('50000758', 'First758', 'Last758', 'f', 10, 'active', 4, false, false, NULL, 'U10G05'),
  ('50000759', 'First759', 'Last759', 'f', 10, 'active', 3, false, false, 'First760 Last760', 'U10G06'),
  ('50000760', 'First760', 'Last760', 'f', 10, 'active', 3, false, false, 'First759 Last759', 'U10G06'),
  ('50000761', 'First761', 'Last761', 'f', 10, 'active', 2, false, false, NULL, 'U10G06'),
  ('50000762', 'First762', 'Last762', 'f', 10, 'active', 5, false, false, 'First707 Last707', 'U10G06'),
  ('50000763', 'First763', 'Last763', 'f', 10, 'active', 0, false, false, NULL, 'U10G06'),
  ('50000764', 'First764', 'Last764', 'f', 10, 'active', 0, true, false, NULL, 'U10G06'),
  ('50000765', 'First765', 'Last765', 'f', 10, 'active', 2, true, false, 'First730 Last730', 'U10G06'),
  ('50000766', 'First766', 'Last766', 'f', 10, 'active', 4, false, false, NULL, 'U10G06'),
  ('50000767', 'First767', 'Last767', 'f', 10, 'active', 3, false, false, NULL, 'U10G06'),
  ('50000768', 'First768', 'Last768', 'f', 10, 'active', 2, false, false, NULL, 'U10G06'),
  ('50000769', 'First769', 'Last769', 'f', 10, 'active', 5, false, false, NULL, 'U10G06'),
  ('50000770', 'First770', 'Last770', 'f', 10, 'active', 0, false, false, 'UnregisteredFirst67 UnregisteredLast67', 'U10G07'),
  ('50000771', 'First771', 'Last771', 'f', 10, 'active', 4, true, false, 'First775 Last775', 'U10G07'),
  ('50000772', 'First772', 'Last772', 'f', 10, 'active', 2, false, false, 'First612 Last612', 'U10G07'),
  ('50000773', 'First773', 'Last773', 'f', 10, 'active', 4, false, false, 'First715 Last715', 'U10G07'),
  ('50000774', 'First774', 'Last774', 'f', 10, 'active', 0, false, false, 'First771 Last771', 'U10G07'),
  ('50000775', 'First775', 'Last775', 'f', 10, 'active', 3, false, false, 'First771 Last771', 'U10G07'),
  ('50000776', 'First776', 'Last776', 'f', 10, 'active', 3, false, false, NULL, 'U10G07'),
  ('50000777', 'First777', 'Last777', 'f', 10, 'active', 2, false, false, NULL, 'U10G07'),
  ('50000778', 'First778', 'Last778', 'f', 10, 'active', 3, false, false, NULL, 'U10G07'),
  ('50000779', 'First779', 'Last779', 'f', 10, 'active', 2, false, false, NULL, 'U10G07'),
  ('50000780', 'First780', 'Last780', 'f', 10, 'active', 2, false, false, NULL, 'U10G07'),
  ('50000781', 'First781', 'Last781', 'f', 10, 'active', 2, false, false, 'First783 Last783', 'U10G08'),
  ('50000782', 'First782', 'Last782', 'f', 10, 'active', 2, false, false, NULL, 'U10G08'),
  ('50000783', 'First783', 'Last783', 'f', 10, 'active', 2, false, false, 'First781 Last781', 'U10G08'),
  ('50000784', 'First784', 'Last784', 'f', 10, 'active', 3, false, false, 'UnregisteredFirst68 UnregisteredLast68', 'U10G08'),
  ('50000785', 'First785', 'Last785', 'f', 10, 'active', 4, false, false, NULL, 'U10G08'),
  ('50000786', 'First786', 'Last786', 'f', 10, 'active', 2, true, false, 'UnregisteredFirst69 UnregisteredLast69', 'U10G08'),
  ('50000787', 'First787', 'Last787', 'f', 10, 'active', 0, false, false, 'First720 Last720', 'U10G08'),
  ('50000788', 'First788', 'Last788', 'f', 10, 'active', 3, false, false, NULL, 'U10G08'),
  ('50000789', 'First789', 'Last789', 'f', 10, 'active', 2, false, false, NULL, 'U10G08'),
  ('50000790', 'First790', 'Last790', 'f', 10, 'active', 1, false, false, NULL, 'U10G08'),
  ('50000791', 'First791', 'Last791', 'f', 10, 'active', 4, false, false, NULL, 'U10G08'),
  ('50000792', 'First792', 'Last792', 'm', 12, 'active', 6, true, false, 'First799 Last799', 'U12B01'),
  ('50000793', 'First793', 'Last793', 'm', 12, 'active', 2, false, false, 'First794 Last794', 'U12B01'),
  ('50000794', 'First794', 'Last794', 'm', 11, 'active', 4, false, false, 'First793 Last793', 'U12B01'),
  ('50000795', 'First795', 'Last795', 'm', 11, 'active', 4, false, false, 'UnregisteredFirst70 UnregisteredLast70', 'U12B01'),
  ('50000796', 'First796', 'Last796', 'm', 11, 'active', 3, false, false, 'First901 Last901', 'U12B01'),
  ('50000797', 'First797', 'Last797', 'm', 11, 'active', 3, false, false, 'First838 Last838', 'U12B01'),
  ('50000798', 'First798', 'Last798', 'm', 11, 'active', 3, false, false, 'First803 Last803', 'U12B01'),
  ('50000799', 'First799', 'Last799', 'm', 12, 'active', 1, false, false, 'First792 Last792', 'U12B01'),
  ('50000800', 'First800', 'Last800', 'm', 12, 'active', 2, true, false, 'UnregisteredFirst71 UnregisteredLast71', 'U12B01'),
  ('50000801', 'First801', 'Last801', 'm', 11, 'active', 5, false, false, 'First844 Last844', 'U12B01'),
  ('50000802', 'First802', 'Last802', 'm', 11, 'active', 2, true, false, NULL, 'U12B01'),
  ('50000803', 'First803', 'Last803', 'm', 11, 'active', 3, false, false, 'First798 Last798', 'U12B01'),
  ('50000804', 'First804', 'Last804', 'm', 11, 'active', 7, false, false, NULL, 'U12B01'),
  ('50000805', 'First805', 'Last805', 'm', 11, 'active', 5, false, false, 'UnregisteredFirst72 UnregisteredLast72', 'U12B01'),
  ('50000806', 'First806', 'Last806', 'm', 11, 'active', 5, true, false, 'UnregisteredFirst73 UnregisteredLast73', 'U12B01'),
  ('50000807', 'First807', 'Last807', 'm', 11, 'active', 3, true, false, 'First808 Last808', 'U12B02'),
  ('50000808', 'First808', 'Last808', 'm', 11, 'active', 4, false, false, 'First807 Last807', 'U12B02'),
  ('50000809', 'First809', 'Last809', 'm', 11, 'active', 1, false, false, 'First810 Last810', 'U12B02'),
  ('50000810', 'First810', 'Last810', 'm', 11, 'active', 3, false, false, 'First809 Last809', 'U12B02'),
  ('50000811', 'First811', 'Last811', 'm', 11, 'active', 2, false, false, NULL, 'U12B02'),
  ('50000812', 'First812', 'Last812', 'm', 11, 'active', 3, false, false, NULL, 'U12B02'),
  ('50000813', 'First813', 'Last813', 'm', 12, 'active', 0, false, false, NULL, 'U12B02'),
  ('50000814', 'First814', 'Last814', 'm', 12, 'active', 8, true, false, 'First815 Last815', 'U12B02'),
  ('50000815', 'First815', 'Last815', 'm', 12, 'active', 5, false, false, 'First814 Last814', 'U12B02'),
  ('50000816', 'First816', 'Last816', 'm', 12, 'active', 2, false, false, 'First911 Last911', 'U12B02'),
  ('50000817', 'First817', 'Last817', 'm', 12, 'active', 2, false, false, NULL, 'U12B02'),
  ('50000818', 'First818', 'Last818', 'm', 11, 'active', 1, false, false, NULL, 'U12B02'),
  ('50000819', 'First819', 'Last819', 'm', 12, 'active', 2, false, false, NULL, 'U12B02'),
  ('50000820', 'First820', 'Last820', 'm', 11, 'active', 5, true, false, 'First823 Last823', 'U12B02'),
  ('50000821', 'First821', 'Last821', 'm', 11, 'active', 3, false, false, NULL, 'U12B02'),
  ('50000822', 'First822', 'Last822', 'm', 12, 'active', 6, false, false, 'N/A', 'U12B03'),
  ('50000823', 'First823', 'Last823', 'm', 11, 'active', 6, false, false, NULL, 'U12B03'),
  ('50000824', 'First824', 'Last824', 'm', 12, 'active', 3, false, false, 'First872 Last872', 'U12B03'),
  ('50000825', 'First825', 'Last825', 'm', 12, 'active', 0, false, false, NULL, 'U12B03'),
  ('50000826', 'First826', 'Last826', 'm', 12, 'active', 6, false, false, 'First829 Last829', 'U12B03'),
  ('50000827', 'First827', 'Last827', 'm', 12, 'active', 4, true, false, 'First828 Last828', 'U12B03'),
  ('50000828', 'First828', 'Last828', 'm', 10, 'active', 3, true, true, 'First827 Last827', 'U12B03'),
  ('50000829', 'First829', 'Last829', 'm', 12, 'active', 1, false, false, 'First826 Last826', 'U12B03'),
  ('50000830', 'First830', 'Last830', 'm', 12, 'active', 6, false, false, 'UnregisteredFirst74 UnregisteredLast74', 'U12B03'),
  ('50000831', 'First831', 'Last831', 'm', 11, 'active', 0, false, false, 'First832 Last832', 'U12B03'),
  ('50000832', 'First832', 'Last832', 'm', 11, 'active', 0, false, false, 'First831 Last831', 'U12B03'),
  ('50000833', 'First833', 'Last833', 'm', 12, 'active', 4, false, false, 'First834 Last834', 'U12B03'),
  ('50000834', 'First834', 'Last834', 'm', 12, 'active', 4, true, false, 'First833 Last833', 'U12B03'),
  ('50000835', 'First835', 'Last835', 'm', 11, 'active', 3, false, false, 'UnregisteredFirst75 UnregisteredLast75', 'U12B03'),
  ('50000836', 'First836', 'Last836', 'm', 12, 'active', 3, false, false, NULL, 'U12B03'),
  ('50000837', 'First837', 'Last837', 'm', 11, 'active', 5, true, false, 'First843 Last843', 'U12B04'),
  ('50000838', 'First838', 'Last838', 'm', 10, 'active', 4, false, true, 'First1061 Last1061', 'U12B04'),
  ('50000839', 'First839', 'Last839', 'm', 12, 'active', 3, false, false, NULL, 'U12B04'),
  ('50000840', 'First840', 'Last840', 'm', 11, 'active', 3, false, false, 'First841 Last841', 'U12B04'),
  ('50000841', 'First841', 'Last841', 'm', 11, 'active', 2, false, false, 'First840 Last840', 'U12B04'),
  ('50000842', 'First842', 'Last842', 'm', 11, 'active', 0, false, false, NULL, 'U12B04'),
  ('50000843', 'First843', 'Last843', 'm', 11, 'active', 5, false, false, 'First837 Last837', 'U12B04'),
  ('50000844', 'First844', 'Last844', 'm', 11, 'active', 6, false, false, 'First846 Last846', 'U12B04'),
  ('50000845', 'First845', 'Last845', 'm', 11, 'active', 1, false, false, NULL, 'U12B04'),
  ('50000846', 'First846', 'Last846', 'm', 11, 'active', 7, true, false, 'First844 Last844', 'U12B04'),
  ('50000847', 'First847', 'Last847', 'm', 11, 'active', 5, false, false, 'First848 Last848', 'U12B04'),
  ('50000848', 'First848', 'Last848', 'm', 11, 'active', 3, false, false, 'First847 Last847', 'U12B04'),
  ('50000849', 'First849', 'Last849', 'm', 11, 'active', 1, false, false, NULL, 'U12B04'),
  ('50000850', 'First850', 'Last850', 'm', 12, 'active', 4, false, false, NULL, 'U12B04'),
  ('50000851', 'First851', 'Last851', 'm', 11, 'active', 3, false, false, 'First821 Last821', 'U12B04'),
  ('50000852', 'First852', 'Last852', 'm', 12, 'active', 5, false, false, 'First855 Last855', 'U12B05'),
  ('50000853', 'First853', 'Last853', 'm', 11, 'active', 2, false, false, NULL, 'U12B05'),
  ('50000854', 'First854', 'Last854', 'm', 11, 'active', 3, false, false, 'First800 Last800', 'U12B05'),
  ('50000855', 'First855', 'Last855', 'm', 12, 'active', 4, false, false, 'First852 Last852', 'U12B05'),
  ('50000856', 'First856', 'Last856', 'm', 11, 'active', 4, false, false, 'First860 Last860', 'U12B05'),
  ('50000857', 'First857', 'Last857', 'm', 11, 'active', 4, false, false, NULL, 'U12B05'),
  ('50000858', 'First858', 'Last858', 'm', 11, 'active', 6, false, false, NULL, 'U12B05'),
  ('50000859', 'First859', 'Last859', 'm', 11, 'active', 3, false, false, 'First866 Last866', 'U12B05'),
  ('50000860', 'First860', 'Last860', 'm', 11, 'active', 6, false, false, 'First856 Last856', 'U12B05'),
  ('50000861', 'First861', 'Last861', 'm', 11, 'active', 4, false, false, NULL, 'U12B05'),
  ('50000862', 'First862', 'Last862', 'm', 11, 'active', 0, false, false, NULL, 'U12B05'),
  ('50000863', 'First863', 'Last863', 'm', 11, 'active', 5, false, false, 'First864 Last864', 'U12B05'),
  ('50000864', 'First864', 'Last864', 'm', 11, 'active', 0, false, false, 'First863 Last863', 'U12B05'),
  ('50000865', 'First865', 'Last865', 'm', 11, 'active', 0, false, false, NULL, 'U12B05'),
  ('50000866', 'First866', 'Last866', 'm', 11, 'active', 1, false, false, 'First859 Last859', 'U12B05'),
  ('50000867', 'First867', 'Last867', 'm', 11, 'active', 5, false, false, NULL, 'U12B06'),
  ('50000868', 'First868', 'Last868', 'm', 12, 'active', 2, false, false, 'N/A', 'U12B06'),
  ('50000869', 'First869', 'Last869', 'm', 12, 'active', 3, false, false, 'First870 Last870', 'U12B06'),
  ('50000870', 'First870', 'Last870', 'm', 12, 'active', 2, false, false, 'First869 Last869', 'U12B06'),
  ('50000871', 'First871', 'Last871', 'm', 11, 'active', 3, false, false, NULL, 'U12B06'),
  ('50000872', 'First872', 'Last872', 'm', 11, 'active', 3, false, false, 'UnregisteredFirst76 UnregisteredLast76', 'U12B06'),
  ('50000873', 'First873', 'Last873', 'm', 12, 'active', 6, false, false, 'First877 Last877', 'U12B06'),
  ('50000874', 'First874', 'Last874', 'm', 12, 'active', 5, true, false, 'First875 Last875', 'U12B06'),
  ('50000875', 'First875', 'Last875', 'm', 12, 'active', 4, false, false, 'First874 Last874', 'U12B06'),
  ('50000876', 'First876', 'Last876', 'm', 12, 'active', 4, false, false, 'First905 Last905', 'U12B06'),
  ('50000877', 'First877', 'Last877', 'm', 12, 'active', 7, false, false, 'First873 Last873', 'U12B06'),
  ('50000878', 'First878', 'Last878', 'm', 12, 'active', 1, false, false, NULL, 'U12B06'),
  ('50000879', 'First879', 'Last879', 'm', 12, 'active', 2, false, false, NULL, 'U12B06'),
  ('50000880', 'First880', 'Last880', 'm', 11, 'active', 1, true, false, 'UnregisteredFirst77 UnregisteredLast77', 'U12B06'),
  ('50000881', 'First881', 'Last881', 'm', 12, 'active', 5, false, false, 'UnregisteredFirst78 UnregisteredLast78', 'U12B06'),
  ('50000882', 'First882', 'Last882', 'm', 11, 'active', 1, false, false, 'N/A', 'U12B07'),
  ('50000883', 'First883', 'Last883', 'm', 10, 'active', 2, true, true, 'First881 Last881', 'U12B07'),
  ('50000884', 'First884', 'Last884', 'm', 12, 'active', 1, false, false, NULL, 'U12B07'),
  ('50000885', 'First885', 'Last885', 'm', 11, 'active', 2, false, false, 'First887 Last887', 'U12B07'),
  ('50000886', 'First886', 'Last886', 'm', 12, 'active', 5, false, false, 'First888 Last888', 'U12B07'),
  ('50000887', 'First887', 'Last887', 'm', 11, 'active', 3, false, false, 'First885 Last885', 'U12B07'),
  ('50000888', 'First888', 'Last888', 'm', 11, 'active', 7, true, false, 'First886 Last886', 'U12B07'),
  ('50000889', 'First889', 'Last889', 'm', 11, 'active', 6, false, false, NULL, 'U12B07'),
  ('50000890', 'First890', 'Last890', 'm', 12, 'active', 4, false, false, NULL, 'U12B07'),
  ('50000891', 'First891', 'Last891', 'm', 11, 'active', 4, false, false, 'First892 Last892', 'U12B07'),
  ('50000892', 'First892', 'Last892', 'm', 11, 'active', 2, false, false, 'First891 Last891', 'U12B07'),
  ('50000893', 'First893', 'Last893', 'm', 11, 'active', 3, false, false, NULL, 'U12B07'),
  ('50000894', 'First894', 'Last894', 'm', 12, 'active', 1, true, false, NULL, 'U12B07'),
  ('50000895', 'First895', 'Last895', 'm', 11, 'active', 2, false, false, 'First882 Last882', 'U12B07'),
  ('50000896', 'First896', 'Last896', 'm', 12, 'active', 5, false, false, 'First1064 Last1064', 'U12B07'),
  ('50000897', 'First897', 'Last897', 'm', 11, 'active', 6, true, false, 'First902 Last902', 'U12B08'),
  ('50000898', 'First898', 'Last898', 'm', 11, 'active', 4, false, false, NULL, 'U12B08'),
  ('50000899', 'First899', 'Last899', 'm', 11, 'active', 5, false, false, 'First795 Last795', 'U12B08'),
  ('50000900', 'First900', 'Last900', 'm', 12, 'active', 4, false, false, NULL, 'U12B08'),
  ('50000901', 'First901', 'Last901', 'm', 11, 'active', 3, false, false, 'UnregisteredFirst79 UnregisteredLast79', 'U12B08'),
  ('50000902', 'First902', 'Last902', 'm', 11, 'active', 4, false, false, 'First897 Last897', 'U12B08'),
  ('50000903', 'First903', 'Last903', 'm', 11, 'active', 4, false, false, 'First906 Last906', 'U12B08'),
  ('50000904', 'First904', 'Last904', 'm', 11, 'active', 2, false, false, NULL, 'U12B08'),
  ('50000905', 'First905', 'Last905', 'm', 12, 'active', 3, true, false, 'UnregisteredFirst74 UnregisteredLast74', 'U12B08'),
  ('50000906', 'First906', 'Last906', 'm', 11, 'active', 1, false, false, 'First903 Last903', 'U12B08'),
  ('50000907', 'First907', 'Last907', 'm', 12, 'active', 2, false, false, NULL, 'U12B08'),
  ('50000908', 'First908', 'Last908', 'm', 11, 'active', 2, false, false, 'First909 Last909', 'U12B08'),
  ('50000909', 'First909', 'Last909', 'm', 11, 'active', 4, false, false, 'First908 Last908', 'U12B08'),
  ('50000910', 'First910', 'Last910', 'm', 11, 'active', 0, false, false, NULL, 'U12B08'),
  ('50000911', 'First911', 'Last911', 'm', 12, 'active', 3, false, false, 'First834 Last834', 'U12B08'),
  ('50000912', 'First912', 'Last912', 'f', 11, 'active', 2, false, false, 'UnregisteredFirst80 UnregisteredLast80', 'U12G01'),
  ('50000913', 'First913', 'Last913', 'f', 12, 'active', 2, false, false, NULL, 'U12G01'),
  ('50000914', 'First914', 'Last914', 'f', 11, 'active', 4, false, false, 'First916 Last916', 'U12G01'),
  ('50000915', 'First915', 'Last915', 'f', 12, 'active', 6, false, false, NULL, 'U12G01'),
  ('50000916', 'First916', 'Last916', 'f', 11, 'active', 0, false, false, 'First914 Last914', 'U12G01'),
  ('50000917', 'First917', 'Last917', 'f', 11, 'active', 2, false, false, NULL, 'U12G01'),
  ('50000918', 'First918', 'Last918', 'f', 11, 'active', 3, false, false, NULL, 'U12G01'),
  ('50000919', 'First919', 'Last919', 'f', 12, 'active', 2, false, false, NULL, 'U12G01'),
  ('50000920', 'First920', 'Last920', 'f', 12, 'active', 3, true, false, 'First993 Last993', 'U12G01'),
  ('50000921', 'First921', 'Last921', 'f', 11, 'active', 2, false, false, NULL, 'U12G01'),
  ('50000922', 'First922', 'Last922', 'f', 12, 'active', 3, false, false, NULL, 'U12G01'),
  ('50000923', 'First923', 'Last923', 'f', 11, 'active', 0, false, false, NULL, 'U12G01'),
  ('50000924', 'First924', 'Last924', 'f', 12, 'active', 7, false, false, NULL, 'U12G01'),
  ('50000925', 'First925', 'Last925', 'f', 11, 'active', 5, false, false, NULL, 'U12G01'),
  ('50000926', 'First926', 'Last926', 'f', 12, 'active', 6, false, false, NULL, 'U12G01'),
  ('50000927', 'First927', 'Last927', 'f', 11, 'active', 1, false, false, NULL, 'U12G02'),
  ('50000928', 'First928', 'Last928', 'f', 11, 'active', 4, false, false, NULL, 'U12G02'),
  ('50000929', 'First929', 'Last929', 'f', 12, 'active', 3, false, false, 'First931 Last931', 'U12G02'),
  ('50000930', 'First930', 'Last930', 'f', 12, 'active', 2, false, false, NULL, 'U12G02'),
  ('50000931', 'First931', 'Last931', 'f', 12, 'active', 4, false, false, 'First929 Last929', 'U12G02'),
  ('50000932', 'First932', 'Last932', 'f', 12, 'active', 3, false, false, NULL, 'U12G02'),
  ('50000933', 'First933', 'Last933', 'f', 12, 'active', 0, false, false, NULL, 'U12G02'),
  ('50000934', 'First934', 'Last934', 'f', 12, 'active', 6, true, false, 'First947 Last947', 'U12G02'),
  ('50000935', 'First935', 'Last935', 'f', 11, 'active', 3, false, false, NULL, 'U12G02'),
  ('50000936', 'First936', 'Last936', 'f', 11, 'active', 5, false, false, 'First993 Last993', 'U12G02'),
  ('50000937', 'First937', 'Last937', 'f', 11, 'active', 4, false, false, NULL, 'U12G02'),
  ('50000938', 'First938', 'Last938', 'f', 12, 'active', 0, false, false, NULL, 'U12G02'),
  ('50000939', 'First939', 'Last939', 'f', 12, 'active', 3, false, false, NULL, 'U12G02'),
  ('50000940', 'First940', 'Last940', 'f', 11, 'active', 3, false, false, NULL, 'U12G02'),
  ('50000941', 'First941', 'Last941', 'f', 12, 'active', 0, false, false, NULL, 'U12G02'),
  ('50000942', 'First942', 'Last942', 'f', 11, 'active', 4, false, false, NULL, 'U12G03'),
  ('50000943', 'First943', 'Last943', 'f', 11, 'active', 1, false, false, 'First1002 Last1002', 'U12G03'),
  ('50000944', 'First944', 'Last944', 'f', 11, 'active', 5, false, false, 'First945 Last945', 'U12G03'),
  ('50000945', 'First945', 'Last945', 'f', 11, 'active', 4, false, false, 'First944 Last944', 'U12G03'),
  ('50000946', 'First946', 'Last946', 'f', 12, 'active', 3, false, false, 'UnregisteredFirst81 UnregisteredLast81', 'U12G03'),
  ('50000947', 'First947', 'Last947', 'f', 12, 'active', 4, false, false, 'First949 Last949', 'U12G03'),
  ('50000948', 'First948', 'Last948', 'f', 12, 'active', 3, false, false, NULL, 'U12G03'),
  ('50000949', 'First949', 'Last949', 'f', 12, 'active', 5, true, false, 'First947 Last947', 'U12G03'),
  ('50000950', 'First950', 'Last950', 'f', 12, 'active', 1, false, false, NULL, 'U12G03'),
  ('50000951', 'First951', 'Last951', 'f', 12, 'active', 5, false, false, NULL, 'U12G03'),
  ('50000952', 'First952', 'Last952', 'f', 11, 'active', 4, false, false, NULL, 'U12G03'),
  ('50000953', 'First953', 'Last953', 'f', 12, 'active', 5, false, false, NULL, 'U12G03'),
  ('50000954', 'First954', 'Last954', 'f', 11, 'active', 5, false, false, NULL, 'U12G03'),
  ('50000955', 'First955', 'Last955', 'f', 11, 'active', 5, false, false, NULL, 'U12G03'),
  ('50000956', 'First956', 'Last956', 'f', 11, 'active', 5, false, false, NULL, 'U12G03'),
  ('50000957', 'First957', 'Last957', 'f', 12, 'active', 0, false, false, NULL, 'U12G04'),
  ('50000958', 'First958', 'Last958', 'f', 11, 'active', 4, true, false, 'First961 Last961', 'U12G04'),
  ('50000959', 'First959', 'Last959', 'f', 11, 'active', 5, false, false, 'N/A', 'U12G04'),
  ('50000960', 'First960', 'Last960', 'f', 11, 'active', 4, false, false, 'First1024 Last1024', 'U12G04'),
  ('50000961', 'First961', 'Last961', 'f', 11, 'active', 5, true, false, 'First958 Last958', 'U12G04'),
  ('50000962', 'First962', 'Last962', 'f', 11, 'active', 3, false, false, 'First963 Last963', 'U12G04'),
  ('50000963', 'First963', 'Last963', 'f', 11, 'active', 3, false, false, 'First962 Last962', 'U12G04'),
  ('50000964', 'First964', 'Last964', 'f', 11, 'active', 2, false, false, NULL, 'U12G04'),
  ('50000965', 'First965', 'Last965', 'f', 11, 'active', 3, true, false, NULL, 'U12G04'),
  ('50000966', 'First966', 'Last966', 'f', 12, 'active', 5, false, false, NULL, 'U12G04'),
  ('50000967', 'First967', 'Last967', 'f', 11, 'active', 7, false, false, NULL, 'U12G04'),
  ('50000968', 'First968', 'Last968', 'f', 11, 'active', 3, false, false, NULL, 'U12G04'),
  ('50000969', 'First969', 'Last969', 'f', 12, 'active', 6, false, false, NULL, 'U12G04'),
  ('50000970', 'First970', 'Last970', 'f', 12, 'active', 0, false, false, NULL, 'U12G04'),
  ('50000971', 'First971', 'Last971', 'f', 11, 'active', 5, false, false, NULL, 'U12G04'),
  ('50000972', 'First972', 'Last972', 'f', 12, 'active', 5, false, false, NULL, 'U12G05'),
  ('50000973', 'First973', 'Last973', 'f', 12, 'active', 4, false, false, NULL, 'U12G05'),
  ('50000974', 'First974', 'Last974', 'f', 12, 'active', 4, false, false, 'First1003 Last1003', 'U12G05'),
  ('50000975', 'First975', 'Last975', 'f', 11, 'active', 5, true, false, 'First976 Last976', 'U12G05'),
  ('50000976', 'First976', 'Last976', 'f', 11, 'active', 3, false, false, 'First975 Last975', 'U12G05'),
  ('50000977', 'First977', 'Last977', 'f', 11, 'active', 2, false, false, 'First978 Last978', 'U12G05'),
  ('50000978', 'First978', 'Last978', 'f', 11, 'active', 4, false, false, 'First977 Last977', 'U12G05'),
  ('50000979', 'First979', 'Last979', 'f', 11, 'active', 1, false, false, 'First936 Last936', 'U12G05'),
  ('50000980', 'First980', 'Last980', 'f', 11, 'active', 1, false, false, NULL, 'U12G05'),
  ('50000981', 'First981', 'Last981', 'f', 11, 'active', 2, false, false, NULL, 'U12G05'),
  ('50000982', 'First982', 'Last982', 'f', 12, 'active', 5, false, false, NULL, 'U12G05'),
  ('50000983', 'First983', 'Last983', 'f', 11, 'active', 0, false, false, NULL, 'U12G05'),
  ('50000984', 'First984', 'Last984', 'f', 11, 'active', 3, false, false, NULL, 'U12G05'),
  ('50000985', 'First985', 'Last985', 'f', 12, 'active', 0, false, false, NULL, 'U12G05'),
  ('50000986', 'First986', 'Last986', 'f', 12, 'active', 5, false, false, NULL, 'U12G05'),
  ('50000987', 'First987', 'Last987', 'f', 11, 'active', 3, false, false, 'UnregisteredFirst63 UnregisteredLast63', 'U12G06'),
  ('50000988', 'First988', 'Last988', 'f', 11, 'active', 3, false, false, NULL, 'U12G06'),
  ('50000989', 'First989', 'Last989', 'f', 11, 'active', 2, false, false, 'First991 Last991', 'U12G06'),
  ('50000990', 'First990', 'Last990', 'f', 12, 'active', 1, false, false, NULL, 'U12G06'),
  ('50000991', 'First991', 'Last991', 'f', 11, 'active', 4, true, false, 'First989 Last989', 'U12G06'),
  ('50000992', 'First992', 'Last992', 'f', 11, 'active', 0, false, false, NULL, 'U12G06'),
  ('50000993', 'First993', 'Last993', 'f', 11, 'active', 5, true, false, NULL, 'U12G06'),
  ('50000994', 'First994', 'Last994', 'f', 11, 'active', 1, false, false, NULL, 'U12G06'),
  ('50000995', 'First995', 'Last995', 'f', 12, 'active', 1, false, false, NULL, 'U12G06'),
  ('50000996', 'First996', 'Last996', 'f', 12, 'active', 3, false, false, NULL, 'U12G06'),
  ('50000997', 'First997', 'Last997', 'f', 11, 'active', 5, false, false, NULL, 'U12G06'),
  ('50000998', 'First998', 'Last998', 'f', 12, 'active', 2, false, false, NULL, 'U12G06'),
  ('50000999', 'First999', 'Last999', 'f', 12, 'active', 2, false, false, NULL, 'U12G06'),
  ('50001000', 'First1000', 'Last1000', 'f', 11, 'active', 3, false, false, NULL, 'U12G06'),
  ('50001001', 'First1001', 'Last1001', 'f', 11, 'active', 4, false, false, NULL, 'U12G06'),
  ('50001002', 'First1002', 'Last1002', 'f', 11, 'active', 5, false, false, 'UnregisteredFirst82 UnregisteredLast82', 'U12G07'),
  ('50001003', 'First1003', 'Last1003', 'f', 11, 'active', 6, false, false, 'First1006 Last1006', 'U12G07'),
  ('50001004', 'First1004', 'Last1004', 'f', 11, 'active', 1, false, false, NULL, 'U12G07'),
  ('50001005', 'First1005', 'Last1005', 'f', 12, 'active', 1, false, false, NULL, 'U12G07'),
  ('50001006', 'First1006', 'Last1006', 'f', 12, 'active', 6, true, false, 'First1003 Last1003', 'U12G07'),
  ('50001007', 'First1007', 'Last1007', 'f', 12, 'active', 6, true, false, 'First1009 Last1009', 'U12G07'),
  ('50001008', 'First1008', 'Last1008', 'f', 12, 'active', 3, false, false, NULL, 'U12G07'),
  ('50001009', 'First1009', 'Last1009', 'f', 12, 'active', 6, true, false, 'First1007 Last1007', 'U12G07'),
  ('50001010', 'First1010', 'Last1010', 'f', 12, 'active', 3, false, false, NULL, 'U12G07'),
  ('50001011', 'First1011', 'Last1011', 'f', 11, 'active', 3, false, false, NULL, 'U12G07'),
  ('50001012', 'First1012', 'Last1012', 'f', 12, 'active', 0, false, false, NULL, 'U12G07'),
  ('50001013', 'First1013', 'Last1013', 'f', 12, 'active', 5, false, false, NULL, 'U12G07'),
  ('50001014', 'First1014', 'Last1014', 'f', 11, 'active', 3, false, false, NULL, 'U12G07'),
  ('50001015', 'First1015', 'Last1015', 'f', 11, 'active', 0, false, false, NULL, 'U12G07'),
  ('50001016', 'First1016', 'Last1016', 'f', 11, 'active', 3, false, false, NULL, 'U12G07'),
  ('50001017', 'First1017', 'Last1017', 'f', 12, 'active', 4, false, false, 'UnregisteredFirst83 UnregisteredLast83', 'U12G08'),
  ('50001018', 'First1018', 'Last1018', 'f', 11, 'active', 3, false, false, 'UnregisteredFirst84 UnregisteredLast84', 'U12G08'),
  ('50001019', 'First1019', 'Last1019', 'f', 11, 'active', 3, false, false, NULL, 'U12G08'),
  ('50001020', 'First1020', 'Last1020', 'f', 11, 'active', 1, false, false, 'First1021 Last1021', 'U12G08'),
  ('50001021', 'First1021', 'Last1021', 'f', 11, 'active', 0, false, false, 'First1020 Last1020', 'U12G08'),
  ('50001022', 'First1022', 'Last1022', 'f', 11, 'active', 0, false, false, NULL, 'U12G08'),
  ('50001023', 'First1023', 'Last1023', 'f', 11, 'active', 3, false, false, 'First1024 Last1024', 'U12G08'),
  ('50001024', 'First1024', 'Last1024', 'f', 11, 'active', 4, false, false, 'First1023 Last1023', 'U12G08'),
  ('50001025', 'First1025', 'Last1025', 'f', 11, 'active', 4, false, false, NULL, 'U12G08'),
  ('50001026', 'First1026', 'Last1026', 'f', 11, 'active', 4, false, false, NULL, 'U12G08'),
  ('50001027', 'First1027', 'Last1027', 'f', 11, 'active', 6, false, false, NULL, 'U12G08'),
  ('50001028', 'First1028', 'Last1028', 'f', 12, 'active', 6, false, false, NULL, 'U12G08'),
  ('50001029', 'First1029', 'Last1029', 'f', 11, 'active', 3, false, false, NULL, 'U12G08'),
  ('50001030', 'First1030', 'Last1030', 'f', 11, 'active', 3, false, false, NULL, 'U12G08'),
  ('50001031', 'First1031', 'Last1031', 'f', 11, 'active', 5, false, false, NULL, 'U12G08'),
  ('50001032', 'First1032', 'Last1032', 'm', 13, 'active', 1, false, false, NULL, 'U14B01'),
  ('50001033', 'First1033', 'Last1033', 'm', 13, 'active', 4, false, false, 'First1034 Last1034', 'U14B01'),
  ('50001034', 'First1034', 'Last1034', 'm', 13, 'active', 1, false, false, 'First1033 Last1033', 'U14B01'),
  ('50001035', 'First1035', 'Last1035', 'm', 14, 'active', 5, true, false, 'First1036 Last1036', 'U14B01'),
  ('50001036', 'First1036', 'Last1036', 'm', 14, 'active', 2, false, false, 'First1035 Last1035', 'U14B01'),
  ('50001037', 'First1037', 'Last1037', 'm', 13, 'active', 6, false, false, 'First1038 Last1038', 'U14B01'),
  ('50001038', 'First1038', 'Last1038', 'm', 13, 'active', 4, false, false, 'First1037 Last1037', 'U14B01'),
  ('50001039', 'First1039', 'Last1039', 'm', 14, 'active', 2, false, false, 'UnregisteredFirst85 UnregisteredLast85', 'U14B01'),
  ('50001040', 'First1040', 'Last1040', 'm', 14, 'active', 8, true, false, 'First1041 Last1041', 'U14B01'),
  ('50001041', 'First1041', 'Last1041', 'm', 13, 'active', 7, true, false, 'First1040 Last1040', 'U14B01'),
  ('50001042', 'First1042', 'Last1042', 'm', 13, 'active', 4, false, false, 'First1043 Last1043', 'U14B01'),
  ('50001043', 'First1043', 'Last1043', 'm', 13, 'active', 6, false, false, 'First1042 Last1042', 'U14B01'),
  ('50001044', 'First1044', 'Last1044', 'm', 13, 'active', 6, false, false, 'First1045 Last1045', 'U14B01'),
  ('50001045', 'First1045', 'Last1045', 'm', 13, 'active', 9, false, false, 'First1044 Last1044', 'U14B01'),
  ('50001046', 'First1046', 'Last1046', 'm', 13, 'active', 8, false, false, 'First1049 Last1049', 'U14B01'),
  ('50001047', 'First1047', 'Last1047', 'm', 14, 'active', 4, false, false, NULL, 'U14B01'),
  ('50001048', 'First1048', 'Last1048', 'm', 14, 'active', 7, true, false, 'First1121 Last1121', 'U14B01'),
  ('50001049', 'First1049', 'Last1049', 'm', 13, 'active', 5, false, false, 'First1046 Last1046', 'U14B01'),
  ('50001050', 'First1050', 'Last1050', 'm', 13, 'active', 2, false, false, NULL, 'U14B01'),
  ('50001051', 'First1051', 'Last1051', 'm', 13, 'active', 3, false, false, 'First1056 Last1056', 'U14B02'),
  ('50001052', 'First1052', 'Last1052', 'm', 13, 'active', 4, false, false, 'First1053 Last1053', 'U14B02'),
  ('50001053', 'First1053', 'Last1053', 'm', 13, 'active', 4, false, false, 'First1052 Last1052', 'U14B02'),
  ('50001054', 'First1054', 'Last1054', 'm', 13, 'active', 2, false, false, NULL, 'U14B02'),
  ('50001055', 'First1055', 'Last1055', 'm', 13, 'active', 8, false, false, 'First1057 Last1057', 'U14B02'),
  ('50001056', 'First1056', 'Last1056', 'm', 12, 'active', 3, false, true, 'First1051 Last1051', 'U14B02'),
  ('50001057', 'First1057', 'Last1057', 'm', 13, 'active', 4, false, false, 'First1055 Last1055', 'U14B02'),
  ('50001058', 'First1058', 'Last1058', 'm', 14, 'active', 8, false, false, 'First1039 Last1039', 'U14B02'),
  ('50001059', 'First1059', 'Last1059', 'm', 14, 'active', 6, false, false, 'First1060 Last1060', 'U14B02'),
  ('50001060', 'First1060', 'Last1060', 'm', 14, 'active', 5, false, false, 'First1059 Last1059', 'U14B02'),
  ('50001061', 'First1061', 'Last1061', 'm', 13, 'active', 2, false, false, NULL, 'U14B02'),
  ('50001062', 'First1062', 'Last1062', 'm', 14, 'active', 2, true, false, NULL, 'U14B02'),
  ('50001063', 'First1063', 'Last1063', 'm', 13, 'active', 2, false, false, 'First1067 Last1067', 'U14B02'),
  ('50001064', 'First1064', 'Last1064', 'm', 13, 'active', 10, false, false, NULL, 'U14B02'),
  ('50001065', 'First1065', 'Last1065', 'm', 13, 'active', 7, false, false, 'First1051 Last1051', 'U14B02'),
  ('50001066', 'First1066', 'Last1066', 'm', 13, 'active', 3, false, false, NULL, 'U14B02'),
  ('50001067', 'First1067', 'Last1067', 'm', 13, 'active', 7, false, false, 'First1063 Last1063', 'U14B02'),
  ('50001068', 'First1068', 'Last1068', 'm', 13, 'active', 2, false, false, 'First1069 Last1069', 'U14B02'),
  ('50001069', 'First1069', 'Last1069', 'm', 13, 'active', 2, false, false, 'First1068 Last1068', 'U14B02'),
  ('50001070', 'First1070', 'Last1070', 'f', 13, 'active', 4, false, false, 'First1071 Last1071', 'U14G01'),
  ('50001071', 'First1071', 'Last1071', 'f', 13, 'active', 3, false, false, 'First1070 Last1070', 'U14G01'),
  ('50001072', 'First1072', 'Last1072', 'f', 14, 'active', 5, false, false, 'First1077 Last1077', 'U14G01'),
  ('50001073', 'First1073', 'Last1073', 'f', 13, 'active', 0, false, false, 'N/A', 'U14G01'),
  ('50001074', 'First1074', 'Last1074', 'f', 14, 'active', 8, false, false, 'First1085 Last1085', 'U14G01'),
  ('50001075', 'First1075', 'Last1075', 'f', 14, 'active', 5, true, false, 'First1079 Last1079', 'U14G01'),
  ('50001076', 'First1076', 'Last1076', 'f', 14, 'active', 7, false, false, 'First1084 Last1084', 'U14G01'),
  ('50001077', 'First1077', 'Last1077', 'f', 14, 'active', 5, false, false, 'UnregisteredFirst86 UnregisteredLast86', 'U14G01'),
  ('50001078', 'First1078', 'Last1078', 'f', 13, 'active', 4, false, false, 'First1090 Last1090', 'U14G01'),
  ('50001079', 'First1079', 'Last1079', 'f', 14, 'active', 8, true, false, 'First1075 Last1075', 'U14G01'),
  ('50001080', 'First1080', 'Last1080', 'f', 13, 'active', 5, false, false, 'First1088 Last1088', 'U14G01'),
  ('50001081', 'First1081', 'Last1081', 'f', 12, 'active', 7, true, true, 'First1083 Last1083', 'U14G01'),
  ('50001082', 'First1082', 'Last1082', 'f', 12, 'active', 6, false, true, 'First1089 Last1089', 'U14G01'),
  ('50001083', 'First1083', 'Last1083', 'f', 13, 'active', 8, false, false, 'First1081 Last1081', 'U14G01'),
  ('50001084', 'First1084', 'Last1084', 'f', 14, 'active', 4, true, false, 'First1076 Last1076', 'U14G01'),
  ('50001085', 'First1085', 'Last1085', 'f', 14, 'active', 2, false, false, 'First1074 Last1074', 'U14G01'),
  ('50001086', 'First1086', 'Last1086', 'f', 13, 'active', 3, false, false, NULL, 'U14G01'),
  ('50001087', 'First1087', 'Last1087', 'f', 13, 'active', 4, false, false, NULL, 'U14G01'),
  ('50001088', 'First1088', 'Last1088', 'f', 14, 'active', 3, false, false, 'First1080 Last1080', 'U14G01'),
  ('50001089', 'First1089', 'Last1089', 'f', 13, 'active', 6, true, false, 'First1098 Last1098', 'U14G02'),
  ('50001090', 'First1090', 'Last1090', 'f', 13, 'active', 4, false, false, 'UnregisteredFirst87 UnregisteredLast87', 'U14G02'),
  ('50001091', 'First1091', 'Last1091', 'f', 13, 'active', 1, false, false, NULL, 'U14G02'),
  ('50001092', 'First1092', 'Last1092', 'f', 14, 'active', 5, false, false, 'First1168 Last1168', 'U14G02'),
  ('50001093', 'First1093', 'Last1093', 'f', 14, 'active', 7, false, false, 'First1103 Last1103', 'U14G02'),
  ('50001094', 'First1094', 'Last1094', 'f', 13, 'active', 8, false, false, 'First1017 Last1017', 'U14G02'),
  ('50001095', 'First1095', 'Last1095', 'f', 14, 'active', 5, false, false, 'First1104 Last1104', 'U14G02'),
  ('50001096', 'First1096', 'Last1096', 'f', 14, 'active', 5, false, false, 'First1169 Last1169', 'U14G02'),
  ('50001097', 'First1097', 'Last1097', 'f', 14, 'active', 3, false, false, NULL, 'U14G02'),
  ('50001098', 'First1098', 'Last1098', 'f', 13, 'active', 5, false, false, 'First1089 Last1089', 'U14G02'),
  ('50001099', 'First1099', 'Last1099', 'f', 13, 'active', 6, false, false, NULL, 'U14G02'),
  ('50001100', 'First1100', 'Last1100', 'f', 13, 'active', 4, true, false, 'N/A', 'U14G02'),
  ('50001101', 'First1101', 'Last1101', 'f', 14, 'active', 4, false, false, NULL, 'U14G02'),
  ('50001102', 'First1102', 'Last1102', 'f', 13, 'active', 4, false, false, NULL, 'U14G02'),
  ('50001103', 'First1103', 'Last1103', 'f', 13, 'active', 5, false, false, 'First1093 Last1093', 'U14G02'),
  ('50001104', 'First1104', 'Last1104', 'f', 14, 'active', 5, false, false, 'First1095 Last1095', 'U14G02'),
  ('50001105', 'First1105', 'Last1105', 'f', 13, 'active', 3, false, false, NULL, 'U14G02'),
  ('50001106', 'First1106', 'Last1106', 'f', 12, 'active', 5, true, true, 'First1107 Last1107', 'U14G02'),
  ('50001107', 'First1107', 'Last1107', 'f', 12, 'active', 5, true, true, 'First1106 Last1106', 'U14G02'),
  ('50001108', 'First1108', 'Last1108', 'm', 15, 'active', 3, false, false, NULL, 'U16B01'),
  ('50001109', 'First1109', 'Last1109', 'm', 13, 'active', 7, false, true, 'First1110 Last1110', 'U16B01'),
  ('50001110', 'First1110', 'Last1110', 'm', 13, 'active', 5, false, true, 'First1109 Last1109', 'U16B01'),
  ('50001111', 'First1111', 'Last1111', 'm', 16, 'active', 4, false, false, NULL, 'U16B01'),
  ('50001112', 'First1112', 'Last1112', 'm', 16, 'active', 9, false, false, NULL, 'U16B01'),
  ('50001113', 'First1113', 'Last1113', 'm', 15, 'active', 7, false, false, NULL, 'U16B01'),
  ('50001114', 'First1114', 'Last1114', 'm', 15, 'active', 8, true, false, 'UnregisteredFirst88 UnregisteredLast88', 'U16B01'),
  ('50001115', 'First1115', 'Last1115', 'm', 16, 'active', 7, true, false, NULL, 'U16B01'),
  ('50001116', 'First1116', 'Last1116', 'm', 15, 'active', 10, false, false, 'First1117 Last1117 and First1133 Last1133', 'U16B01'),
  ('50001117', 'First1117', 'Last1117', 'm', 15, 'active', 7, false, false, 'First1133 Last1133', 'U16B01'),
  ('50001118', 'First1118', 'Last1118', 'm', 13, 'active', 3, false, true, NULL, 'U16B01'),
  ('50001119', 'First1119', 'Last1119', 'm', 16, 'active', 4, false, false, NULL, 'U16B01'),
  ('50001120', 'First1120', 'Last1120', 'm', 15, 'active', 10, false, false, NULL, 'U16B01'),
  ('50001121', 'First1121', 'Last1121', 'm', 14, 'active', 8, true, true, 'First1048 Last1048', 'U16B01'),
  ('50001122', 'First1122', 'Last1122', 'm', 15, 'active', 3, false, false, NULL, 'U16B01'),
  ('50001123', 'First1123', 'Last1123', 'm', 14, 'active', 7, false, true, NULL, 'U16B01'),
  ('50001124', 'First1124', 'Last1124', 'm', 14, 'active', 3, false, true, 'UnregisteredFirst89 UnregisteredLast89', 'U16B01'),
  ('50001125', 'First1125', 'Last1125', 'm', 15, 'active', 7, false, false, NULL, 'U16B01'),
  ('50001126', 'First1126', 'Last1126', 'm', 15, 'active', 9, false, false, NULL, 'U16B01'),
  ('50001127', 'First1127', 'Last1127', 'm', 15, 'active', 5, false, false, NULL, 'U16B02'),
  ('50001128', 'First1128', 'Last1128', 'm', 16, 'active', 8, false, false, NULL, 'U16B02'),
  ('50001129', 'First1129', 'Last1129', 'm', 16, 'active', 7, false, false, 'First1130 Last1130', 'U16B02'),
  ('50001130', 'First1130', 'Last1130', 'm', 16, 'active', 9, false, false, 'First1129 Last1129', 'U16B02'),
  ('50001131', 'First1131', 'Last1131', 'm', 16, 'active', 3, false, false, 'First1129 Last1129', 'U16B02'),
  ('50001132', 'First1132', 'Last1132', 'm', 13, 'active', 6, true, true, 'UnregisteredFirst90 UnregisteredLast90', 'U16B02'),
  ('50001133', 'First1133', 'Last1133', 'm', 15, 'active', 10, false, false, NULL, 'U16B02'),
  ('50001134', 'First1134', 'Last1134', 'm', 16, 'active', 4, false, false, NULL, 'U16B02'),
  ('50001135', 'First1135', 'Last1135', 'm', 15, 'active', 10, false, false, 'First1111 Last1111', 'U16B02'),
  ('50001136', 'First1136', 'Last1136', 'm', 15, 'active', 3, false, false, NULL, 'U16B02'),
  ('50001137', 'First1137', 'Last1137', 'm', 16, 'active', 3, false, false, 'First1115 Last1115', 'U16B02'),
  ('50001138', 'First1138', 'Last1138', 'm', 15, 'active', 2, false, false, NULL, 'U16B02'),
  ('50001139', 'First1139', 'Last1139', 'm', 15, 'active', 0, false, false, NULL, 'U16B02'),
  ('50001140', 'First1140', 'Last1140', 'm', 14, 'active', 4, false, true, NULL, 'U16B02'),
  ('50001141', 'First1141', 'Last1141', 'm', 15, 'active', 9, false, false, NULL, 'U16B02'),
  ('50001142', 'First1142', 'Last1142', 'm', 16, 'active', 2, false, false, NULL, 'U16B02'),
  ('50001143', 'First1143', 'Last1143', 'm', 15, 'active', 0, false, false, 'First1139 Last1139', 'U16B02'),
  ('50001144', 'First1144', 'Last1144', 'm', 16, 'active', 9, false, false, NULL, 'U16B02'),
  ('50001145', 'First1145', 'Last1145', 'm', 15, 'active', 7, false, false, NULL, 'U16B02'),
  ('50001146', 'First1146', 'Last1146', 'f', 15, 'active', 8, false, false, 'First1173 Last1173 and First1154 Last1154', 'U16G01'),
  ('50001147', 'First1147', 'Last1147', 'f', 15, 'active', 6, false, false, NULL, 'U16G01'),
  ('50001148', 'First1148', 'Last1148', 'f', 16, 'active', 5, false, false, NULL, 'U16G01'),
  ('50001149', 'First1149', 'Last1149', 'f', 15, 'active', 8, true, false, 'First1150 Last1150', 'U16G01'),
  ('50001150', 'First1150', 'Last1150', 'f', 15, 'active', 7, false, false, 'First1149 Last1149', 'U16G01'),
  ('50001151', 'First1151', 'Last1151', 'f', 15, 'active', 5, false, false, NULL, 'U16G01'),
  ('50001152', 'First1152', 'Last1152', 'f', 16, 'active', 1, false, false, NULL, 'U16G01'),
  ('50001153', 'First1153', 'Last1153', 'f', 16, 'active', 8, false, false, 'First1156 Last1156', 'U16G01'),
  ('50001154', 'First1154', 'Last1154', 'f', 16, 'active', 3, false, false, 'First1146 Last1146', 'U16G01'),
  ('50001155', 'First1155', 'Last1155', 'f', 15, 'active', 9, false, false, NULL, 'U16G01'),
  ('50001156', 'First1156', 'Last1156', 'f', 16, 'active', 7, false, false, 'First1153 Last1153', 'U16G01'),
  ('50001157', 'First1157', 'Last1157', 'f', 16, 'active', 10, false, false, 'First1154 Last1154', 'U16G01'),
  ('50001158', 'First1158', 'Last1158', 'f', 15, 'active', 3, false, false, NULL, 'U16G01'),
  ('50001159', 'First1159', 'Last1159', 'f', 16, 'active', 6, false, false, 'UnregisteredFirst91 UnregisteredLast91', 'U16G01'),
  ('50001160', 'First1160', 'Last1160', 'f', 15, 'active', 7, false, false, 'UnregisteredFirst92 UnregisteredLast92', 'U16G01'),
  ('50001161', 'First1161', 'Last1161', 'f', 15, 'active', 3, false, false, NULL, 'U16G01'),
  ('50001162', 'First1162', 'Last1162', 'f', 15, 'active', 2, true, false, NULL, 'U16G01'),
  ('50001163', 'First1163', 'Last1163', 'f', 16, 'active', 10, true, false, 'First1146 Last1146', 'U16G01'),
  ('50001164', 'First1164', 'Last1164', 'f', 16, 'active', 5, false, false, NULL, 'U16G01'),
  ('50001165', 'First1165', 'Last1165', 'f', 15, 'active', 7, false, false, NULL, 'U16G02'),
  ('50001166', 'First1166', 'Last1166', 'f', 15, 'active', 6, false, false, 'UnregisteredFirst93 UnregisteredLast93', 'U16G02'),
  ('50001167', 'First1167', 'Last1167', 'f', 15, 'active', 15, false, false, 'First1159 Last1159', 'U16G02'),
  ('50001168', 'First1168', 'Last1168', 'f', 15, 'active', 5, false, false, 'UnregisteredFirst94 UnregisteredLast94', 'U16G02'),
  ('50001169', 'First1169', 'Last1169', 'f', 15, 'active', 5, false, false, 'First1096 Last1096', 'U16G02'),
  ('50001170', 'First1170', 'Last1170', 'f', 15, 'active', 8, false, false, 'First1171 Last1171', 'U16G02'),
  ('50001171', 'First1171', 'Last1171', 'f', 15, 'active', 10, false, false, 'First1170 Last1170', 'U16G02'),
  ('50001172', 'First1172', 'Last1172', 'f', 16, 'active', 2, false, false, 'First1146 Last1146', 'U16G02'),
  ('50001173', 'First1173', 'Last1173', 'f', 16, 'active', 4, true, false, 'First1172 Last1172', 'U16G02'),
  ('50001174', 'First1174', 'Last1174', 'f', 16, 'active', 9, false, false, 'UnregisteredFirst95 UnregisteredLast95', 'U16G02'),
  ('50001175', 'First1175', 'Last1175', 'f', 16, 'active', 0, false, false, NULL, 'U16G02'),
  ('50001176', 'First1176', 'Last1176', 'f', 15, 'active', 8, false, false, 'First1178 Last1178', 'U16G02'),
  ('50001177', 'First1177', 'Last1177', 'f', 16, 'active', 3, false, false, NULL, 'U16G02'),
  ('50001178', 'First1178', 'Last1178', 'f', 16, 'active', 10, false, false, 'First1176 Last1176', 'U16G02'),
  ('50001179', 'First1179', 'Last1179', 'f', 15, 'active', 2, false, false, NULL, 'U16G02'),
  ('50001180', 'First1180', 'Last1180', 'f', 15, 'active', 1, false, false, NULL, 'U16G02'),
  ('50001181', 'First1181', 'Last1181', 'f', 15, 'active', 8, false, false, NULL, 'U16G02'),
  ('50001182', 'First1182', 'Last1182', 'f', 17, 'active', 1, false, false, NULL, 'U16G02'),
  ('50001183', 'First1183', 'Last1183', 'f', 16, 'active', 4, false, false, NULL, 'U16G02'),
  ('50001184', 'First1184', 'Last1184', 'm', 17, 'active', 1, false, false, 'UnregisteredFirst96 UnregisteredLast96', 'U19B01'),
  ('50001185', 'First1185', 'Last1185', 'm', 18, 'active', 14, true, false, 'UnregisteredFirst97 UnregisteredLast97', 'U19B01'),
  ('50001186', 'First1186', 'Last1186', 'm', 17, 'active', 9, false, false, NULL, 'U19B01'),
  ('50001187', 'First1187', 'Last1187', 'm', 17, 'active', 9, false, false, NULL, 'U19B01'),
  ('50001188', 'First1188', 'Last1188', 'm', 18, 'active', 10, false, false, NULL, 'U19B01'),
  ('50001189', 'First1189', 'Last1189', 'm', 17, 'active', 6, false, false, 'First1191 Last1191', 'U19B01'),
  ('50001190', 'First1190', 'Last1190', 'm', 16, 'active', 9, false, true, 'UnregisteredFirst98 UnregisteredLast98', 'U19B01'),
  ('50001191', 'First1191', 'Last1191', 'm', 17, 'active', 7, false, false, 'First1189 Last1189', 'U19B01'),
  ('50001192', 'First1192', 'Last1192', 'm', 18, 'active', 12, false, false, 'First1185 Last1185', 'U19B01'),
  ('50001193', 'First1193', 'Last1193', 'm', 18, 'active', 10, false, false, NULL, 'U19B01'),
  ('50001194', 'First1194', 'Last1194', 'm', 17, 'active', 1, false, false, NULL, 'U19B01'),
  ('50001195', 'First1195', 'Last1195', 'm', 18, 'active', 1, false, false, NULL, 'U19B01'),
  ('50001196', 'First1196', 'Last1196', 'm', 17, 'active', 12, false, false, NULL, 'U19B01'),
  ('50001197', 'First1197', 'Last1197', 'm', 17, 'active', 9, false, false, NULL, 'U19B01'),
  ('50001198', 'First1198', 'Last1198', 'm', 19, 'active', 9, false, false, NULL, 'U19B01'),
  ('50001199', 'First1199', 'Last1199', 'm', 18, 'active', 11, false, false, NULL, 'U19B01'),
  ('50001200', 'First1200', 'Last1200', 'm', 17, 'active', 11, false, false, NULL, 'U19B01'),
  ('50001201', 'First1201', 'Last1201', 'm', 17, 'active', 10, false, false, NULL, 'U19B01'),
  ('50001202', 'First1202', 'Last1202', 'm', 18, 'active', 11, false, false, NULL, 'U19B01'),
  ('50001203', 'First1203', 'Last1203', 'm', 18, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001204', 'First1204', 'Last1204', 'm', 17, 'active', 8, false, false, NULL, 'U19B02'),
  ('50001205', 'First1205', 'Last1205', 'm', 18, 'active', 10, true, false, NULL, 'U19B02'),
  ('50001206', 'First1206', 'Last1206', 'm', 18, 'active', 12, false, false, 'First1185 Last1185', 'U19B02'),
  ('50001207', 'First1207', 'Last1207', 'm', 17, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001208', 'First1208', 'Last1208', 'm', 19, 'active', 11, false, false, NULL, 'U19B02'),
  ('50001209', 'First1209', 'Last1209', 'm', 17, 'active', 11, false, false, NULL, 'U19B02'),
  ('50001210', 'First1210', 'Last1210', 'm', 17, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001211', 'First1211', 'Last1211', 'm', 18, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001212', 'First1212', 'Last1212', 'm', 18, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001213', 'First1213', 'Last1213', 'm', 18, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001214', 'First1214', 'Last1214', 'm', 17, 'active', 12, false, false, NULL, 'U19B02'),
  ('50001215', 'First1215', 'Last1215', 'm', 17, 'active', 12, false, false, NULL, 'U19B02'),
  ('50001216', 'First1216', 'Last1216', 'm', 18, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001217', 'First1217', 'Last1217', 'm', 18, 'active', 11, false, false, NULL, 'U19B02'),
  ('50001218', 'First1218', 'Last1218', 'm', 18, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001219', 'First1219', 'Last1219', 'm', 17, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001220', 'First1220', 'Last1220', 'm', 17, 'active', 10, false, false, NULL, 'U19B02'),
  ('50001221', 'First1221', 'Last1221', 'm', 17, 'active', 7, false, false, NULL, 'U19B02'),
  ('50001222', 'First1222', 'Last1222', 'f', 18, 'active', 12, false, false, 'First1223 Last1223', 'U19G01'),
  ('50001223', 'First1223', 'Last1223', 'f', 18, 'active', 13, false, false, NULL, 'U19G01'),
  ('50001224', 'First1224', 'Last1224', 'f', 16, 'active', 2, false, true, 'UnregisteredFirst99 UnregisteredLast99', 'U19G01'),
  ('50001225', 'First1225', 'Last1225', 'f', 17, 'active', 11, true, false, 'First1223 Last1223 and First1222 Last1222', 'U19G01'),
  ('50001226', 'First1226', 'Last1226', 'f', 18, 'active', 6, false, false, NULL, 'U19G01'),
  ('50001227', 'First1227', 'Last1227', 'f', 16, 'active', 2, false, true, NULL, 'U19G01'),
  ('50001228', 'First1228', 'Last1228', 'f', 16, 'active', 6, false, true, 'First1246 Last1246', 'U19G01'),
  ('50001229', 'First1229', 'Last1229', 'f', 18, 'active', 8, false, false, NULL, 'U19G01'),
  ('50001230', 'First1230', 'Last1230', 'f', 18, 'active', 12, false, false, NULL, 'U19G01'),
  ('50001231', 'First1231', 'Last1231', 'f', 18, 'active', 12, false, false, NULL, 'U19G01'),
  ('50001232', 'First1232', 'Last1232', 'f', 17, 'active', 12, false, false, NULL, 'U19G01'),
  ('50001233', 'First1233', 'Last1233', 'f', 17, 'active', 5, false, false, NULL, 'U19G01'),
  ('50001234', 'First1234', 'Last1234', 'f', 18, 'active', 11, false, false, NULL, 'U19G01'),
  ('50001235', 'First1235', 'Last1235', 'f', 18, 'active', 11, false, false, NULL, 'U19G01'),
  ('50001236', 'First1236', 'Last1236', 'f', 18, 'active', 13, false, false, NULL, 'U19G01'),
  ('50001237', 'First1237', 'Last1237', 'f', 18, 'active', 13, false, false, NULL, 'U19G01'),
  ('50001238', 'First1238', 'Last1238', 'f', 18, 'active', 10, false, false, NULL, 'U19G01'),
  ('50001239', 'First1239', 'Last1239', 'f', 18, 'active', 6, false, false, NULL, 'U19G01'),
  ('50001240', 'First1240', 'Last1240', 'f', 18, 'active', 6, false, false, NULL, 'U19G01'),
  ('50001241', 'First1241', 'Last1241', 'f', 15, 'active', 4, true, true, 'UnregisteredFirst100 UnregisteredLast100', 'U19G02'),
  ('50001242', 'First1242', 'Last1242', 'f', 16, 'active', 10, false, true, 'First1244 Last1244', 'U19G02'),
  ('50001243', 'First1243', 'Last1243', 'f', 18, 'active', 5, false, false, 'First1223 Last1223', 'U19G02'),
  ('50001244', 'First1244', 'Last1244', 'f', 16, 'active', 9, false, true, 'First1242 Last1242', 'U19G02'),
  ('50001245', 'First1245', 'Last1245', 'f', 19, 'active', 13, true, false, 'First1225 Last1225', 'U19G02'),
  ('50001246', 'First1246', 'Last1246', 'f', 18, 'active', 10, false, false, NULL, 'U19G02'),
  ('50001247', 'First1247', 'Last1247', 'f', 17, 'active', 6, false, false, 'UnregisteredFirst101 UnregisteredLast101', 'U19G02'),
  ('50001248', 'First1248', 'Last1248', 'f', 18, 'active', 12, false, false, NULL, 'U19G02'),
  ('50001249', 'First1249', 'Last1249', 'f', 17, 'active', 12, false, false, NULL, 'U19G02'),
  ('50001250', 'First1250', 'Last1250', 'f', 17, 'active', 13, false, false, NULL, 'U19G02'),
  ('50001251', 'First1251', 'Last1251', 'f', 17, 'active', 5, false, false, NULL, 'U19G02'),
  ('50001252', 'First1252', 'Last1252', 'f', 17, 'active', 5, false, false, NULL, 'U19G02'),
  ('50001253', 'First1253', 'Last1253', 'f', 18, 'active', 5, false, false, NULL, 'U19G02'),
  ('50001254', 'First1254', 'Last1254', 'f', 18, 'active', 13, false, false, NULL, 'U19G02'),
  ('50001255', 'First1255', 'Last1255', 'f', 17, 'active', 6, false, false, NULL, 'U19G02'),
  ('50001256', 'First1256', 'Last1256', 'f', 19, 'active', 6, false, false, NULL, 'U19G02'),
  ('50001257', 'First1257', 'Last1257', 'f', 18, 'active', 10, false, false, NULL, 'U19G02'),
  ('50001258', 'First1258', 'Last1258', 'f', 17, 'active', 8, false, false, NULL, 'U19G02'),
  ('50001259', 'First1259', 'Last1259', 'f', 19, 'active', 1, false, false, NULL, 'U19G02');

INSERT INTO demo_seed.coaches (full_name, email, status) VALUES
  ('Parent1First9 Parent1Last9', 'email9@example.com', 'active'),
  ('First24 Last24', 'email25@example.com', 'active'),
  ('Parent1First37 Parent1Last37', 'email38@example.com', 'active'),
  ('Parent1First47 Parent1Last47', 'email48@example.com', 'active'),
  ('Parent1First60 Parent1Last60', 'email61@example.com', 'active'),
  ('Parent1First56 Parent1Last56', 'email57@example.com', 'active'),
  ('Parent1First35 Parent1Last35', 'email36@example.com', 'active'),
  ('CoachFirst1 CoachLast1', 'email1523@example.com', 'active'),
  ('Parent1First66 Parent1Last66', 'email67@example.com', 'active'),
  ('CoachFirst2 CoachLast2', 'email1524@example.com', 'active'),
  ('Parent1First72 Parent1Last72', 'email73@example.com', 'active'),
  ('Parent1First79 Parent1Last79', 'email81@example.com', 'active'),
  ('Parent1First78 Parent1Last78', 'email80@example.com', 'active'),
  ('Parent1First82 Parent1Last82', 'email84@example.com', 'active'),
  ('Parent1First81 Parent1Last81', 'email83@example.com', 'active'),
  ('Parent1First87 Parent1Last87', 'email90@example.com', 'active'),
  ('Parent2First88 Parent2Last88', 'email92@example.com', 'active'),
  ('Parent1First91 Parent1Last91', 'email95@example.com', 'active'),
  ('Parent1First100 Parent1Last100', 'email105@example.com', 'active'),
  ('Parent1First98 Parent1Last98', 'email103@example.com', 'active'),
  ('Parent1First104 Parent1Last104', 'email109@example.com', 'active'),
  ('Parent1First106 Parent1Last106', 'email111@example.com', 'active'),
  ('Parent1First113 Parent1Last113', 'email119@example.com', 'active'),
  ('CoachFirst3 CoachLast3', 'email1526@example.com', 'active'),
  ('Parent1First122 Parent1Last122', 'email128@example.com', 'active'),
  ('Parent1First128 Parent1Last128', 'email136@example.com', 'active'),
  ('CoachFirst4 CoachLast4', 'email1527@example.com', 'active'),
  ('CoachFirst5 CoachLast5', 'email1528@example.com', 'active'),
  ('Parent1First138 Parent1Last138', 'email146@example.com', 'active'),
  ('Parent1First137 Parent1Last137', 'email145@example.com', 'active'),
  ('CoachFirst6 CoachLast6', 'email1529@example.com', 'active'),
  ('Parent1First143 Parent1Last143', 'email151@example.com', 'active'),
  ('CoachFirst7 CoachLast7', 'email1530@example.com', 'active'),
  ('Parent1First149 Parent1Last149', 'email159@example.com', 'active'),
  ('Parent1First146 Parent1Last146', 'email156@example.com', 'active'),
  ('Parent1First54 Parent1Last54', 'email55@example.com', 'active'),
  ('Parent1First153 Parent1Last153', 'email164@example.com', 'active'),
  ('Parent1First156 Parent1Last156', 'email167@example.com', 'active'),
  ('Parent1First158 Parent1Last158', 'email170@example.com', 'active'),
  ('CoachFirst8 CoachLast8', 'email1531@example.com', 'active'),
  ('Parent1First162 Parent1Last162', 'email173@example.com', 'active'),
  ('CoachFirst9 CoachLast9', 'email1532@example.com', 'active'),
  ('Parent1First168 Parent1Last168', 'email180@example.com', 'active'),
  ('Parent1First167 Parent1Last167', 'email179@example.com', 'active'),
  ('Parent1First173 Parent1Last173', 'email184@example.com', 'active'),
  ('Parent1First174 Parent1Last174', 'email185@example.com', 'active'),
  ('Parent2First178 Parent2Last178', 'email191@example.com', 'active'),
  ('Parent1First183 Parent1Last183', 'email196@example.com', 'active'),
  ('CoachFirst10 CoachLast10', 'email1533@example.com', 'active'),
  ('Parent1First189 Parent1Last189', 'email205@example.com', 'active'),
  ('Parent1First192 Parent1Last192', 'email209@example.com', 'active'),
  ('Parent1First191 Parent1Last191', 'email207@example.com', 'active'),
  ('Parent1First198 Parent1Last198', 'email216@example.com', 'active'),
  ('Parent1First200 Parent1Last200', 'email219@example.com', 'active'),
  ('Parent1First202 Parent1Last202', 'email221@example.com', 'active'),
  ('Parent2First202 Parent2Last202', 'email222@example.com', 'active'),
  ('CoachFirst11 CoachLast11', 'email1534@example.com', 'active'),
  ('CoachFirst12 CoachLast12', 'email1535@example.com', 'active'),
  ('Parent1First217 Parent1Last217', 'email239@example.com', 'active'),
  ('Parent1First129 Parent1Last129', 'email137@example.com', 'active'),
  ('Parent1First221 Parent1Last221', 'email243@example.com', 'active'),
  ('Parent1First228 Parent1Last228', 'email254@example.com', 'active'),
  ('Parent2First227 Parent2Last227', 'email253@example.com', 'active'),
  ('Parent1First225 Parent1Last225', 'email248@example.com', 'active'),
  ('Parent2First230 Parent2Last230', 'email256@example.com', 'active'),
  ('CoachFirst13 CoachLast13', 'email1536@example.com', 'active'),
  ('Parent1First235 Parent1Last235', 'email263@example.com', 'active'),
  ('Parent1First242 Parent1Last242', 'email274@example.com', 'active'),
  ('Parent2First238 Parent2Last238', 'email269@example.com', 'active'),
  ('Parent1First243 Parent1Last243', 'email275@example.com', 'active'),
  ('Parent2First250 Parent2Last250', 'email282@example.com', 'active'),
  ('CoachFirst14 CoachLast14', 'email1537@example.com', 'active'),
  ('Parent2First244 Parent2Last244', 'email276@example.com', 'active'),
  ('Parent2First251 Parent2Last251', 'email284@example.com', 'active'),
  ('Parent1First254 Parent1Last254', 'email287@example.com', 'active'),
  ('CoachFirst15 CoachLast15', 'email1538@example.com', 'active'),
  ('Parent1First264 Parent1Last264', 'email300@example.com', 'active'),
  ('Parent1First261 Parent1Last261', 'email296@example.com', 'active'),
  ('CoachFirst16 CoachLast16', 'email1539@example.com', 'active'),
  ('Parent1First92 Parent1Last92', 'email97@example.com', 'active'),
  ('Parent1First271 Parent1Last271', 'email310@example.com', 'active'),
  ('CoachFirst17 CoachLast17', 'email308@example.com', 'active'),
  ('Parent1First32 Parent1Last32', 'email33@example.com', 'active'),
  ('Parent2First281 Parent2Last281', 'email323@example.com', 'active'),
  ('Parent2First619 Parent2Last619', 'email706@example.com', 'active'),
  ('CoachFirst18 CoachLast18', 'email1540@example.com', 'active'),
  ('CoachFirst19 CoachLast19', 'email1541@example.com', 'active'),
  ('Parent1First293 Parent1Last293', 'email335@example.com', 'active'),
  ('Parent1First298 Parent1Last298', 'email341@example.com', 'active'),
  ('Parent2First301 Parent2Last301', 'email345@example.com', 'active'),
  ('Parent1First302 Parent1Last302', 'email346@example.com', 'active'),
  ('CoachFirst20 CoachLast20', 'email1542@example.com', 'active'),
  ('CoachFirst21 CoachLast21', 'email1543@example.com', 'active'),
  ('Parent2First315 Parent2Last315', 'email356@example.com', 'active'),
  ('CoachFirst22 CoachLast22', 'email1544@example.com', 'active'),
  ('CoachFirst23 CoachLast23', 'email1545@example.com', 'active'),
  ('Parent1First28 Parent1Last28', 'email29@example.com', 'active'),
  ('Parent1First334 Parent1Last334', 'email376@example.com', 'active'),
  ('Parent1First332 Parent1Last332', 'email373@example.com', 'active'),
  ('First340 Last340', 'email381@example.com', 'active'),
  ('Parent1First203 Parent1Last203', 'email224@example.com', 'active'),
  ('Parent1First340 Parent1Last340', 'email381.2@example.com', 'active'),
  ('Parent1First345 Parent1Last345', 'email389@example.com', 'active'),
  ('Parent1First84 Parent1Last84', 'email86@example.com', 'active'),
  ('First350 Last350', 'email394@example.com', 'active'),
  ('CoachFirst24 CoachLast24', 'email1546@example.com', 'active'),
  ('Parent2First364 Parent2Last364', 'email413@example.com', 'active'),
  ('Parent2First372 Parent2Last372', 'email422@example.com', 'active'),
  ('Parent1First375 Parent1Last375', 'email425@example.com', 'active'),
  ('Parent2First382 Parent2Last382', 'email435@example.com', 'active'),
  ('Parent1First385 Parent1Last385', 'email440@example.com', 'active'),
  ('Parent1First390 Parent1Last390', 'email446@example.com', 'active'),
  ('CoachFirst25 CoachLast25', 'email1547@example.com', 'active'),
  ('Parent1First396 Parent1Last396', 'email452@example.com', 'active'),
  ('Parent1First400 Parent1Last400', 'email457@example.com', 'active'),
  ('Parent1First169 Parent1Last169', 'email181@example.com', 'active'),
  ('Parent2First418 Parent2Last418', 'email480@example.com', 'active'),
  ('Parent1First425 Parent1Last425', 'email487@example.com', 'active'),
  ('Parent1First427 Parent1Last427', 'email489@example.com', 'active'),
  ('Parent1First438 Parent1Last438', 'email1548@example.com', 'active'),
  ('Parent1First447 Parent1Last447', 'email508@example.com', 'active'),
  ('Parent1First445 Parent1Last445', 'email504@example.com', 'active'),
  ('CoachFirst26 CoachLast26', 'email1549@example.com', 'active'),
  ('CoachFirst27 CoachLast27', 'email1550@example.com', 'active'),
  ('Parent1First463 Parent1Last463', 'email526@example.com', 'active'),
  ('CoachFirst28 CoachLast28', 'email1551@example.com', 'active'),
  ('Parent1First476 Parent1Last476', 'email536@example.com', 'active'),
  ('AdultFirst2 AdultLast2', 'email1525@example.com', 'active'),
  ('Parent1First486 Parent1Last486', 'email550@example.com', 'active'),
  ('Parent1First197 Parent1Last197', 'email215@example.com', 'active'),
  ('Parent1First515 Parent1Last515', 'email580@example.com', 'active'),
  ('CoachFirst29 CoachLast29', 'email1552@example.com', 'active'),
  ('Parent1First150 Parent1Last150', 'email160@example.com', 'active'),
  ('Parent1First519 Parent1Last519', 'email586@example.com', 'active'),
  ('Parent1First524 Parent1Last524', 'email593@example.com', 'active'),
  ('Parent1First528 Parent1Last528', 'email598@example.com', 'active'),
  ('Parent2First540 Parent2Last540', 'email611@example.com', 'active'),
  ('Parent1First544 Parent1Last544', 'email615@example.com', 'active'),
  ('Parent2First554 Parent2Last554', 'email628@example.com', 'active'),
  ('Parent1First287 Parent1Last287', 'email327@example.com', 'active'),
  ('Parent2First573 Parent2Last573', 'email650@example.com', 'active'),
  ('Parent1First573 Parent1Last573', 'email649@example.com', 'active'),
  ('Parent2First585 Parent2Last585', 'email666@example.com', 'active'),
  ('Parent2First588 Parent2Last588', 'email670@example.com', 'active'),
  ('Parent1First281 Parent1Last281', 'email322@example.com', 'active'),
  ('Parent2First612 Parent2Last612', 'email697@example.com', 'active'),
  ('Parent2First343 Parent2Last343', 'email387@example.com', 'active'),
  ('Parent1First621 Parent1Last621', 'email709@example.com', 'active'),
  ('Parent1First633 Parent1Last633', 'email721@example.com', 'active'),
  ('Parent1First627 Parent1Last627', 'email715@example.com', 'active'),
  ('CoachFirst30 CoachLast30', 'email1553@example.com', 'active'),
  ('Parent2First648 Parent2Last648', 'email739@example.com', 'active'),
  ('Parent1First656 Parent1Last656', 'email749@example.com', 'active'),
  ('Parent1First659 Parent1Last659', 'email754@example.com', 'active'),
  ('Parent1First668 Parent1Last668', 'email765@example.com', 'active'),
  ('Parent1First411 Parent1Last411', 'email470@example.com', 'active'),
  ('Parent2First672 Parent2Last672', 'email771@example.com', 'active'),
  ('Parent1First671 Parent1Last671', 'email768@example.com', 'active'),
  ('Parent1First688 Parent1Last688', 'email792@example.com', 'active'),
  ('Parent2First844 Parent2Last844', 'email986@example.com', 'active'),
  ('Parent1First697 Parent1Last697', 'email804@example.com', 'active'),
  ('Parent1First702 Parent1Last702', 'email809@example.com', 'active'),
  ('CoachFirst31 CoachLast31', 'email1554@example.com', 'active'),
  ('Parent2First720 Parent2Last720', 'email832@example.com', 'active'),
  ('Parent1First716 Parent1Last716', 'email826@example.com', 'active'),
  ('Parent1First728 Parent1Last728', 'email846@example.com', 'active'),
  ('Parent1First64 Parent1Last64', 'email65@example.com', 'active'),
  ('Parent2First750 Parent2Last750', 'email869@example.com', 'active'),
  ('Parent2First765 Parent2Last765', 'email888@example.com', 'active'),
  ('Parent2First771 Parent2Last771', 'email899@example.com', 'active'),
  ('Parent1First389 Parent1Last389', 'email444@example.com', 'active'),
  ('Parent1First678 Parent1Last678', 'email781@example.com', 'active'),
  ('Parent1First742 Parent1Last742', 'email859@example.com', 'active'),
  ('Parent2First806 Parent2Last806', 'email940@example.com', 'active'),
  ('CoachFirst32 CoachLast32', 'email1555@example.com', 'active'),
  ('Parent1First820 Parent1Last820', 'email960@example.com', 'active'),
  ('Parent1First819 Parent1Last819', 'email959@example.com', 'active'),
  ('Parent2First533 Parent2Last533', 'email603@example.com', 'active'),
  ('Parent1First834 Parent1Last834', 'email973@example.com', 'active'),
  ('Parent2First550 Parent2Last550', 'email623@example.com', 'active'),
  ('UnregisteredFirst1 UnregisteredLast1', 'email977@example.com', 'active'),
  ('Parent1First846 Parent1Last846', 'email988@example.com', 'active'),
  ('CoachFirst33 CoachLast33', 'email116@example.com', 'active'),
  ('Parent1First351 Parent1Last351', 'email14@example.com', 'active'),
  ('Parent2First874 Parent2Last874', 'email1014@example.com', 'active'),
  ('Parent1First880 Parent1Last880', 'email1022@example.com', 'active'),
  ('Parent1First321 Parent1Last321', 'email362@example.com', 'active'),
  ('Parent1First814 Parent1Last814', 'email951@example.com', 'active'),
  ('Parent1First894 Parent1Last894', 'email1042@example.com', 'active'),
  ('UnregisteredFirst2 UnregisteredLast2', 'email1556@example.com', 'active'),
  ('Parent1First609 Parent1Last609', 'email694@example.com', 'active'),
  ('Parent2First920 Parent2Last920', 'email1070@example.com', 'active'),
  ('Parent1First934 Parent1Last934', 'email1088@example.com', 'active'),
  ('CoachFirst34 CoachLast34', 'email1558@example.com', 'active'),
  ('Parent2First1038 Parent2Last1038', 'email1223@example.com', 'active'),
  ('Parent1First975 Parent1Last975', 'email1131@example.com', 'active'),
  ('Parent1First993 Parent1Last993', 'email1157@example.com', 'active'),
  ('Parent2First1006 Parent2Last1006', 'email1172@example.com', 'active'),
  ('CoachFirst35 CoachLast35', 'email1559@example.com', 'active'),
  ('Parent1First1035 Parent1Last1035', 'email1220@example.com', 'active'),
  ('Parent2First583 Parent2Last583', 'email664@example.com', 'active'),
  ('Parent1First1048 Parent1Last1048', 'email1228@example.com', 'active'),
  ('CoachFirst36 CoachLast36', 'email427@example.com', 'active'),
  ('Parent1First1062 Parent1Last1062', 'email1246@example.com', 'active'),
  ('CoachFirst37 CoachLast37', 'email1561@example.com', 'active'),
  ('Parent2First1079 Parent2Last1079', 'email1263@example.com', 'active'),
  ('Parent1First1081 Parent1Last1081', 'email1268@example.com', 'active'),
  ('Parent1First195 Parent1Last195', 'email212@example.com', 'active'),
  ('Parent1First897 Parent1Last897', 'email1045@example.com', 'active'),
  ('Parent1First1100 Parent1Last1100', 'email1284@example.com', 'active'),
  ('Parent1First1106 Parent1Last1106', 'email1291@example.com', 'active'),
  ('Parent1First1115 Parent1Last1115', 'email1301@example.com', 'active'),
  ('Parent1First1114 Parent1Last1114', 'email1300@example.com', 'active'),
  ('Parent2First1121 Parent2Last1121', 'email1312@example.com', 'active'),
  ('Parent1First1136 Parent1Last1136', 'email1330@example.com', 'active'),
  ('Parent1First1141 Parent1Last1141', 'email1336@example.com', 'active'),
  ('First1114 Last1114', 'email1300.2@example.com', 'active'),
  ('Parent1First1149 Parent1Last1149', 'email1347@example.com', 'active'),
  ('CoachFirst38 CoachLast38', 'email1563@example.com', 'active'),
  ('Parent1First1146 Parent1Last1146', 'email1341@example.com', 'active'),
  ('Parent1First1173 Parent1Last1173', 'email1377@example.com', 'active'),
  ('Parent1First1168 Parent1Last1168', 'email1371@example.com', 'active'),
  ('Parent2First1178 Parent2Last1178', 'email1383@example.com', 'active'),
  ('Parent1First1185 Parent1Last1185', 'email1392@example.com', 'active'),
  ('Parent1First1205 Parent1Last1205', 'email1433@example.com', 'active'),
  ('CoachFirst39 CoachLast39', 'email1564@example.com', 'active'),
  ('Parent1First1227 Parent1Last1227', 'email1468@example.com', 'active'),
  ('Parent1First1121 Parent1Last1121', 'email1311@example.com', 'active'),
  ('Parent1First965 Parent1Last965', 'email1121@example.com', 'active'),
  ('Parent1First152 Parent1Last152', 'email163@example.com', 'active'),
  ('CoachFirst40 CoachLast40', 'email1565@example.com', 'active'),
  ('CoachFirst41 CoachLast41', 'email1566@example.com', 'active'),
  ('Parent1First522 Parent1Last522', 'email590@example.com', 'active'),
  ('CoachFirst42 CoachLast42', 'email1567@example.com', 'active'),
  ('Parent1First126 Parent1Last126', 'email132@example.com', 'active'),
  ('Parent1First279 Parent1Last279', 'email319@example.com', 'active'),
  ('CoachFirst43 CoachLast43', 'email1568@example.com', 'active'),
  ('First806 Last806', 'email940.2@example.com', 'active'),
  ('CoachFirst44 CoachLast44', 'email1570@example.com', 'active'),
  ('CoachFirst45 CoachLast45', 'email1571@example.com', 'active'),
  ('CoachFirst46 CoachLast46', 'email1572@example.com', 'active'),
  ('UnregisteredFirst3 UnregisteredLast3', 'email1201@example.com', 'active'),
  ('Parent1First905 Parent1Last905', 'email1052@example.com', 'active'),
  ('CoachFirst47 CoachLast47', 'email1573@example.com', 'active'),
  ('CoachFirst48 CoachLast48', 'email1574@example.com', 'active'),
  ('Parent2First799 Parent2Last799', 'email930@example.com', 'active'),
  ('CoachFirst49 CoachLast49', 'email1575@example.com', 'active'),
  ('Parent2First278 Parent2Last278', 'email317@example.com', 'active'),
  ('Parent1First141 Parent1Last141', 'email149@example.com', 'active'),
  ('Parent2First991 Parent2Last991', 'email1154@example.com', 'active'),
  ('Parent2First1135 Parent2Last1135', 'email1329@example.com', 'active');

INSERT INTO demo_seed.team_coaches (team_name, coach_name, role) VALUES
  ('U4A', 'Parent1First9 Parent1Last9', 'lead'),
  ('U4B', 'First24 Last24', 'lead'),
  ('U4C', 'Parent1First37 Parent1Last37', 'lead'),
  ('U4D', 'Parent1First47 Parent1Last47', 'lead'),
  ('U05B01', 'Parent1First60 Parent1Last60', 'lead'),
  ('U05B01', 'Parent1First56 Parent1Last56', 'assistant'),
  ('U05B02', 'Parent1First35 Parent1Last35', 'lead'),
  ('U05B03', 'CoachFirst1 CoachLast1', 'lead'),
  ('U05B03', 'Parent1First66 Parent1Last66', 'assistant'),
  ('U05B04', 'CoachFirst2 CoachLast2', 'lead'),
  ('U05B04', 'Parent1First72 Parent1Last72', 'assistant'),
  ('U05B05', 'Parent1First79 Parent1Last79', 'lead'),
  ('U05B05', 'Parent1First78 Parent1Last78', 'assistant'),
  ('U05B06', 'Parent1First82 Parent1Last82', 'lead'),
  ('U05B06', 'Parent1First81 Parent1Last81', 'assistant'),
  ('U05B07', 'Parent1First87 Parent1Last87', 'lead'),
  ('U05B07', 'Parent2First88 Parent2Last88', 'assistant'),
  ('U05B08', 'Parent1First91 Parent1Last91', 'lead'),
  ('U05G01', 'Parent1First100 Parent1Last100', 'lead'),
  ('U05G01', 'Parent1First98 Parent1Last98', 'assistant'),
  ('U05G02', 'Parent1First104 Parent1Last104', 'lead'),
  ('U05G03', 'Parent1First106 Parent1Last106', 'lead'),
  ('U05G04', 'Parent1First113 Parent1Last113', 'lead'),
  ('U05G05', 'CoachFirst3 CoachLast3', 'lead'),
  ('U05G06', 'Parent1First122 Parent1Last122', 'lead'),
  ('U05G07', 'Parent1First128 Parent1Last128', 'lead'),
  ('U05G08', 'CoachFirst4 CoachLast4', 'lead'),
  ('U06B01', 'CoachFirst5 CoachLast5', 'lead'),
  ('U06B01', 'Parent1First138 Parent1Last138', 'assistant'),
  ('U06B01', 'Parent1First137 Parent1Last137', 'assistant'),
  ('U06B02', 'CoachFirst6 CoachLast6', 'lead'),
  ('U06B02', 'Parent1First143 Parent1Last143', 'assistant'),
  ('U06B02', 'CoachFirst7 CoachLast7', 'assistant'),
  ('U06B03', 'Parent1First149 Parent1Last149', 'lead'),
  ('U06B03', 'Parent1First146 Parent1Last146', 'assistant'),
  ('U06B04', 'Parent1First54 Parent1Last54', 'lead'),
  ('U06B04', 'Parent1First153 Parent1Last153', 'assistant'),
  ('U06B05', 'Parent1First156 Parent1Last156', 'lead'),
  ('U06B05', 'Parent1First158 Parent1Last158', 'assistant'),
  ('U06B06', 'CoachFirst8 CoachLast8', 'lead'),
  ('U06B06', 'Parent1First162 Parent1Last162', 'assistant'),
  ('U06B06', 'CoachFirst9 CoachLast9', 'assistant'),
  ('U06B07', 'Parent1First168 Parent1Last168', 'lead'),
  ('U06B07', 'Parent1First167 Parent1Last167', 'assistant'),
  ('U06B08', 'Parent1First173 Parent1Last173', 'lead'),
  ('U06B08', 'Parent1First174 Parent1Last174', 'assistant'),
  ('U06G01', 'Parent2First178 Parent2Last178', 'lead'),
  ('U06G02', 'Parent1First183 Parent1Last183', 'lead'),
  ('U06G02', 'CoachFirst10 CoachLast10', 'assistant'),
  ('U06G03', 'Parent1First189 Parent1Last189', 'lead'),
  ('U06G04', 'Parent1First192 Parent1Last192', 'lead'),
  ('U06G04', 'Parent1First191 Parent1Last191', 'assistant'),
  ('U06G05', 'Parent1First198 Parent1Last198', 'lead'),
  ('U06G05', 'Parent1First200 Parent1Last200', 'assistant'),
  ('U06G06', 'Parent1First202 Parent1Last202', 'lead'),
  ('U06G06', 'Parent2First202 Parent2Last202', 'assistant'),
  ('U06G07', 'CoachFirst11 CoachLast11', 'lead'),
  ('U06G08', 'CoachFirst12 CoachLast12', 'lead'),
  ('U07B01', 'Parent1First217 Parent1Last217', 'lead'),
  ('U07B01', 'Parent1First129 Parent1Last129', 'assistant'),
  ('U07B01', 'Parent1First221 Parent1Last221', 'assistant'),
  ('U07B02', 'Parent1First228 Parent1Last228', 'lead'),
  ('U07B02', 'Parent2First227 Parent2Last227', 'assistant'),
  ('U07B02', 'Parent1First225 Parent1Last225', 'assistant'),
  ('U07B03', 'Parent2First230 Parent2Last230', 'lead'),
  ('U07B03', 'CoachFirst13 CoachLast13', 'assistant'),
  ('U07B03', 'Parent1First235 Parent1Last235', 'assistant'),
  ('U07B04', 'Parent1First242 Parent1Last242', 'lead'),
  ('U07B04', 'Parent2First238 Parent2Last238', 'assistant'),
  ('U07B04', 'Parent1First243 Parent1Last243', 'assistant'),
  ('U07B05', 'Parent2First250 Parent2Last250', 'lead'),
  ('U07B05', 'CoachFirst14 CoachLast14', 'assistant'),
  ('U07B05', 'Parent2First244 Parent2Last244', 'assistant'),
  ('U07B06', 'Parent2First251 Parent2Last251', 'lead'),
  ('U07B06', 'Parent1First254 Parent1Last254', 'assistant'),
  ('U07B06', 'CoachFirst15 CoachLast15', 'assistant'),
  ('U07B07', 'Parent1First264 Parent1Last264', 'lead'),
  ('U07B07', 'Parent1First261 Parent1Last261', 'assistant'),
  ('U07B07', 'CoachFirst16 CoachLast16', 'assistant'),
  ('U07B08', 'Parent1First92 Parent1Last92', 'lead'),
  ('U07B08', 'Parent1First271 Parent1Last271', 'assistant'),
  ('U07B08', 'CoachFirst17 CoachLast17', 'assistant'),
  ('U07G01', 'Parent1First32 Parent1Last32', 'lead'),
  ('U07G02', 'Parent2First281 Parent2Last281', 'lead'),
  ('U07G02', 'Parent2First619 Parent2Last619', 'assistant'),
  ('U07G03', 'CoachFirst18 CoachLast18', 'lead'),
  ('U07G03', 'CoachFirst19 CoachLast19', 'assistant'),
  ('U07G04', 'Parent1First293 Parent1Last293', 'lead'),
  ('U07G04', 'Parent1First298 Parent1Last298', 'assistant'),
  ('U07G05', 'Parent2First301 Parent2Last301', 'lead'),
  ('U07G05', 'Parent1First302 Parent1Last302', 'assistant'),
  ('U07G05', 'CoachFirst20 CoachLast20', 'assistant'),
  ('U07G06', 'CoachFirst21 CoachLast21', 'lead'),
  ('U07G07', 'Parent2First315 Parent2Last315', 'lead'),
  ('U07G08', 'CoachFirst22 CoachLast22', 'lead'),
  ('U07G08', 'CoachFirst23 CoachLast23', 'assistant'),
  ('U08B01', 'Parent1First28 Parent1Last28', 'lead'),
  ('U08B01', 'Parent1First334 Parent1Last334', 'assistant'),
  ('U08B01', 'Parent1First332 Parent1Last332', 'assistant'),
  ('U08B02', 'First340 Last340', 'lead'),
  ('U08B02', 'Parent1First203 Parent1Last203', 'assistant'),
  ('U08B02', 'Parent1First340 Parent1Last340', 'assistant'),
  ('U08B03', 'Parent1First345 Parent1Last345', 'lead'),
  ('U08B04', 'Parent1First84 Parent1Last84', 'lead'),
  ('U08B04', 'First350 Last350', 'assistant'),
  ('U08B05', 'CoachFirst24 CoachLast24', 'lead'),
  ('U08B06', 'Parent2First364 Parent2Last364', 'lead'),
  ('U08B07', 'Parent2First372 Parent2Last372', 'lead'),
  ('U08B07', 'Parent1First375 Parent1Last375', 'assistant'),
  ('U08B08', 'Parent2First382 Parent2Last382', 'lead'),
  ('U08G01', 'Parent1First385 Parent1Last385', 'lead'),
  ('U08G01', 'Parent1First390 Parent1Last390', 'assistant'),
  ('U08G02', 'CoachFirst25 CoachLast25', 'lead'),
  ('U08G02', 'Parent1First396 Parent1Last396', 'assistant'),
  ('U08G03', 'Parent1First400 Parent1Last400', 'lead'),
  ('U08G04', 'Parent1First169 Parent1Last169', 'lead'),
  ('U08G05', 'Parent2First418 Parent2Last418', 'lead'),
  ('U08G06', 'Parent1First425 Parent1Last425', 'lead'),
  ('U08G07', 'Parent1First427 Parent1Last427', 'lead'),
  ('U08G08', 'Parent1First438 Parent1Last438', 'lead'),
  ('U09B01', 'Parent1First447 Parent1Last447', 'lead'),
  ('U09B01', 'Parent1First445 Parent1Last445', 'assistant'),
  ('U09B02', 'CoachFirst26 CoachLast26', 'lead'),
  ('U09B02', 'CoachFirst27 CoachLast27', 'assistant'),
  ('U09B03', 'Parent1First463 Parent1Last463', 'lead'),
  ('U09B03', 'CoachFirst28 CoachLast28', 'assistant'),
  ('U09B04', 'Parent1First476 Parent1Last476', 'lead'),
  ('U09B04', 'AdultFirst2 AdultLast2', 'assistant'),
  ('U09B05', 'Parent1First486 Parent1Last486', 'lead'),
  ('U09B06', 'Parent1First197 Parent1Last197', 'lead'),
  ('U09B07', 'Parent1First515 Parent1Last515', 'lead'),
  ('U09B07', 'CoachFirst29 CoachLast29', 'assistant'),
  ('U09B07', 'Parent1First150 Parent1Last150', 'assistant'),
  ('U09B08', 'Parent1First519 Parent1Last519', 'lead'),
  ('U09B08', 'Parent1First524 Parent1Last524', 'assistant'),
  ('U09G01', 'Parent1First528 Parent1Last528', 'lead'),
  ('U09G02', 'Parent2First540 Parent2Last540', 'lead'),
  ('U09G02', 'Parent1First544 Parent1Last544', 'assistant'),
  ('U09G03', 'Parent2First554 Parent2Last554', 'lead'),
  ('U09G04', 'Parent1First287 Parent1Last287', 'lead'),
  ('U09G05', 'Parent2First573 Parent2Last573', 'lead'),
  ('U09G05', 'Parent1First573 Parent1Last573', 'assistant'),
  ('U09G06', 'Parent2First585 Parent2Last585', 'lead'),
  ('U09G06', 'Parent2First588 Parent2Last588', 'assistant'),
  ('U09G07', 'Parent1First281 Parent1Last281', 'lead'),
  ('U09G08', 'Parent2First612 Parent2Last612', 'lead'),
  ('U10B01', 'Parent2First343 Parent2Last343', 'lead'),
  ('U10B01', 'Parent1First621 Parent1Last621', 'assistant'),
  ('U10B02', 'Parent1First633 Parent1Last633', 'lead'),
  ('U10B02', 'Parent1First627 Parent1Last627', 'assistant'),
  ('U10B03', 'CoachFirst30 CoachLast30', 'lead'),
  ('U10B03', 'Parent2First648 Parent2Last648', 'assistant'),
  ('U10B04', 'Parent1First656 Parent1Last656', 'lead'),
  ('U10B04', 'Parent1First659 Parent1Last659', 'assistant'),
  ('U10B05', 'Parent1First668 Parent1Last668', 'lead'),
  ('U10B05', 'Parent1First411 Parent1Last411', 'assistant'),
  ('U10B06', 'Parent2First672 Parent2Last672', 'lead'),
  ('U10B06', 'Parent1First671 Parent1Last671', 'assistant'),
  ('U10B07', 'Parent1First688 Parent1Last688', 'lead'),
  ('U10B07', 'Parent2First844 Parent2Last844', 'assistant'),
  ('U10B08', 'Parent1First697 Parent1Last697', 'lead'),
  ('U10B08', 'Parent1First702 Parent1Last702', 'assistant'),
  ('U10G01', 'CoachFirst31 CoachLast31', 'lead'),
  ('U10G02', 'Parent2First720 Parent2Last720', 'lead'),
  ('U10G02', 'Parent1First716 Parent1Last716', 'assistant'),
  ('U10G03', 'Parent1First728 Parent1Last728', 'lead'),
  ('U10G04', 'Parent1First64 Parent1Last64', 'lead'),
  ('U10G05', 'Parent2First750 Parent2Last750', 'lead'),
  ('U10G06', 'Parent2First765 Parent2Last765', 'lead'),
  ('U10G07', 'Parent2First771 Parent2Last771', 'lead'),
  ('U10G08', 'Parent1First389 Parent1Last389', 'lead'),
  ('U12B01', 'Parent1First678 Parent1Last678', 'lead'),
  ('U12B01', 'Parent1First742 Parent1Last742', 'assistant'),
  ('U12B01', 'Parent2First806 Parent2Last806', 'assistant'),
  ('U12B02', 'CoachFirst32 CoachLast32', 'lead'),
  ('U12B02', 'Parent1First820 Parent1Last820', 'assistant'),
  ('U12B02', 'Parent1First819 Parent1Last819', 'assistant'),
  ('U12B03', 'Parent2First533 Parent2Last533', 'lead'),
  ('U12B03', 'Parent1First834 Parent1Last834', 'assistant'),
  ('U12B04', 'Parent2First550 Parent2Last550', 'lead'),
  ('U12B04', 'UnregisteredFirst1 UnregisteredLast1', 'assistant'),
  ('U12B04', 'Parent1First846 Parent1Last846', 'assistant'),
  ('U12B05', 'CoachFirst33 CoachLast33', 'lead'),
  ('U12B05', 'Parent1First351 Parent1Last351', 'assistant'),
  ('U12B06', 'Parent2First874 Parent2Last874', 'lead'),
  ('U12B06', 'Parent1First880 Parent1Last880', 'assistant'),
  ('U12B07', 'Parent1First321 Parent1Last321', 'lead'),
  ('U12B07', 'Parent1First814 Parent1Last814', 'assistant'),
  ('U12B07', 'Parent1First894 Parent1Last894', 'assistant'),
  ('U12B08', 'UnregisteredFirst2 UnregisteredLast2', 'lead'),
  ('U12B08', 'Parent1First609 Parent1Last609', 'assistant'),
  ('U12G01', 'Parent2First920 Parent2Last920', 'lead'),
  ('U12G02', 'Parent1First934 Parent1Last934', 'lead'),
  ('U12G03', 'CoachFirst34 CoachLast34', 'lead'),
  ('U12G04', 'Parent2First1038 Parent2Last1038', 'lead'),
  ('U12G05', 'Parent1First975 Parent1Last975', 'lead'),
  ('U12G06', 'Parent1First993 Parent1Last993', 'lead'),
  ('U12G07', 'Parent2First1006 Parent2Last1006', 'lead'),
  ('U12G08', 'CoachFirst35 CoachLast35', 'lead'),
  ('U14B01', 'Parent1First1035 Parent1Last1035', 'lead'),
  ('U14B01', 'Parent2First583 Parent2Last583', 'assistant'),
  ('U14B01', 'Parent1First1048 Parent1Last1048', 'assistant'),
  ('U14B02', 'CoachFirst36 CoachLast36', 'lead'),
  ('U14B02', 'Parent1First1062 Parent1Last1062', 'assistant'),
  ('U14B02', 'CoachFirst37 CoachLast37', 'assistant'),
  ('U14G01', 'Parent2First1079 Parent2Last1079', 'lead'),
  ('U14G01', 'Parent1First1081 Parent1Last1081', 'assistant'),
  ('U14G01', 'Parent1First195 Parent1Last195', 'assistant'),
  ('U14G02', 'Parent1First897 Parent1Last897', 'lead'),
  ('U14G02', 'Parent1First1100 Parent1Last1100', 'assistant'),
  ('U14G02', 'Parent1First1106 Parent1Last1106', 'assistant'),
  ('U16B01', 'Parent1First1115 Parent1Last1115', 'lead'),
  ('U16B01', 'Parent1First1114 Parent1Last1114', 'assistant'),
  ('U16B01', 'Parent2First1121 Parent2Last1121', 'assistant'),
  ('U16B02', 'Parent1First1136 Parent1Last1136', 'lead'),
  ('U16B02', 'Parent1First1141 Parent1Last1141', 'assistant'),
  ('U16B02', 'First1114 Last1114', 'assistant'),
  ('U16G01', 'Parent1First1149 Parent1Last1149', 'lead'),
  ('U16G01', 'CoachFirst38 CoachLast38', 'assistant'),
  ('U16G01', 'Parent1First1146 Parent1Last1146', 'assistant'),
  ('U16G02', 'Parent1First1173 Parent1Last1173', 'lead'),
  ('U16G02', 'Parent1First1168 Parent1Last1168', 'assistant'),
  ('U16G02', 'Parent2First1178 Parent2Last1178', 'assistant'),
  ('U19B01', 'Parent1First1185 Parent1Last1185', 'lead'),
  ('U19B02', 'Parent1First1205 Parent1Last1205', 'lead'),
  ('U19G01', 'CoachFirst39 CoachLast39', 'lead'),
  ('U19G01', 'Parent1First1227 Parent1Last1227', 'assistant'),
  ('U19G02', 'Parent1First1121 Parent1Last1121', 'lead');

INSERT INTO demo_seed.locations (name, latitude, longitude) VALUES
  ('Eastgate Sports Complex', 37.3000, -121.6500),
  ('Orchard Park', 37.3100, -121.6600),
  ('Riverside Fields', 37.2900, -121.6400);

INSERT INTO demo_seed.fields (location_name, name, surface_type, supports_halves) VALUES
  ('Eastgate Sports Complex', 'Field 1', 'Turf', true),
  ('Orchard Park', 'Field 1', 'Grass', true),
  ('Orchard Park', 'Field 2', 'Grass', true),
  ('Orchard Park', 'Field 3', 'Grass', true),
  ('Orchard Park', 'Tot Lot', 'Grass', false),
  ('Riverside Fields', 'Field A', 'Grass', true),
  ('Riverside Fields', 'Field B', 'Grass', true);

INSERT INTO demo_seed.field_subunits (location_name, field_name, label) VALUES
  ('Eastgate Sports Complex', 'Field 1', 'A'),
  ('Eastgate Sports Complex', 'Field 1', 'B'),
  ('Orchard Park', 'Field 1', 'A'),
  ('Orchard Park', 'Field 1', 'B'),
  ('Orchard Park', 'Field 2', 'A'),
  ('Orchard Park', 'Field 2', 'B'),
  ('Orchard Park', 'Field 3', 'A'),
  ('Orchard Park', 'Field 3', 'B'),
  ('Riverside Fields', 'Field A', 'A'),
  ('Riverside Fields', 'Field A', 'B'),
  ('Riverside Fields', 'Field B', 'A'),
  ('Riverside Fields', 'Field B', 'B');

INSERT INTO demo_seed.practice_slots (location_name, field_name, subunit_label, day_of_week, start_time, end_time, capacity, division_key) VALUES
  ('Orchard Park', 'Field 1', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 1', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 2', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Orchard Park', 'Field 3', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field A', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Riverside Fields', 'Field B', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'mon', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'tue', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'wed', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'A', 'thu', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'mon', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'tue', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'wed', '18:15', '19:00', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '16:00', '16:45', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '16:45', '17:30', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '17:30', '18:15', 1, NULL),
  ('Eastgate Sports Complex', 'Field 1', 'B', 'thu', '18:15', '19:00', 1, NULL),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '09:00', '09:30', 1, 'U4'),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '09:45', '10:15', 1, 'U4'),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '10:30', '11:00', 1, 'U4'),
  ('Orchard Park', 'Tot Lot', NULL, 'sat', '11:15', '11:45', 1, 'U4');
-- END GENERATED demo_seed rows

-- ---------------------------------------------------------------------------
-- 11. End state.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_bad text;
BEGIN
    IF to_regclass('public.organizations_demo_owner_live_key') IS NULL THEN
        RAISE EXCEPTION 'the one-live-demo-per-visitor index is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = 'public.organizations'::regclass
                      AND tgname = 'organizations_guard_demo_columns' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'the demo-columns trigger is missing';
    END IF;

    SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('start_demo_session', 'purge_expired_demos', 'demo_health', 'is_demo_org',
                         'is_org_member', 'is_org_admin', 'demo_fence_player_write',
                         'demo_fence_coach_write', 'demo_fence_import_write', 'demo_fence_membership',
                         'demo_fence_invite')
       AND NOT (p.prosecdef AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')
                AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'not a pinned definer closed to anon: %', v_bad;
    END IF;

    IF has_function_privilege('authenticated', 'public.purge_expired_demos()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.demo_health()', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.start_demo_session()', 'EXECUTE') THEN
        RAISE EXCEPTION 'the demo functions have the wrong client grants';
    END IF;
    IF has_schema_privilege('anon', 'demo_seed', 'USAGE') OR has_schema_privilege('authenticated', 'demo_seed', 'USAGE') THEN
        RAISE EXCEPTION 'demo_seed is open to a client role';
    END IF;

    IF has_function_privilege('authenticated', 'public.prune_old_audit_logs()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.prune_old_evaluation_runs()', 'EXECUTE') THEN
        RAISE EXCEPTION 'a retention sweep is still callable by a client role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-demos') THEN
        RAISE EXCEPTION 'the purge is not scheduled';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'demo.started') THEN
        RAISE EXCEPTION 'demo.started is not registered';
    END IF;

    -- The league: every player on a team, every team in a division, U4 practice-only with its four
    -- 30-minute sessions reserved to it and a 15-minute gap between them.
    IF (SELECT count(*) FROM demo_seed.teams) <> 128
       OR (SELECT count(*) FROM demo_seed.divisions) <> 21
       OR (SELECT count(*) FROM demo_seed.players) <> 1259
       OR (SELECT count(*) FROM demo_seed.coaches) <> 251 THEN
        RAISE EXCEPTION 'demo_seed does not hold the demo league (128 teams, 21 divisions, 1259 players, 251 coaches)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM demo_seed.divisions WHERE key = 'U4' AND NOT plays_games)
       OR (SELECT count(*) FROM demo_seed.divisions WHERE NOT plays_games) <> 1 THEN
        RAISE EXCEPTION 'U4 must be the one practice-only division';
    END IF;
    IF (SELECT count(*) FROM demo_seed.practice_slots WHERE division_key = 'U4') <> 4
       OR EXISTS (SELECT 1 FROM demo_seed.practice_slots WHERE division_key = 'U4'
                   AND end_time - start_time <> interval '30 minutes')
       OR EXISTS (SELECT 1
                    FROM (SELECT start_time - lag(end_time) OVER (ORDER BY start_time) AS gap
                            FROM demo_seed.practice_slots WHERE division_key = 'U4') g
                   WHERE g.gap IS NOT NULL AND g.gap < interval '15 minutes') THEN
        RAISE EXCEPTION 'the U4 sessions are not four 30-minute slots at least 15 minutes apart';
    END IF;
END;
$$;

COMMIT;
