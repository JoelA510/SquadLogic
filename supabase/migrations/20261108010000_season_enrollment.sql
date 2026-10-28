-- Players and coaches belong to one season; imports match within it (Phase E3, PR E3a;
-- plan docs/changes/2026-10-27-season-enrollment.md, settled by the owner 2026-10-27; the
-- AGENTS.md rule 14 plan for this domain-model and persistence change).
--
-- **Why.** A player row mixed the person with the season: no season column, the season reachable
-- only through `division_id`, and the import matching an existing row by organization and
-- registration id across every season. That is why E1 refused an import into any season but the
-- active one. The owner decided (Decision 11 of the Phase E plan, and 2026-10-27) that a new
-- season starts from its own import data and nothing is assumed to be returning: a registration
-- id or an email seen in another season is a new row in this one. Coaches are imported data that
-- admins manage (no coach signs in), so they are handled exactly as players are.
--
-- **The change.**
--   1. `players.season_settings_id` and `coaches.season_settings_id` (FK to `season_settings`,
--      ON DELETE CASCADE, NOT NULL, indexed). Backfill: a player takes its division's season, else
--      the organization's active season; a coach takes the organization's active season. The
--      migration refuses (naming the organizations) if a row would be left without one. The
--      fence, timestamp and attribute-validation triggers are switched off for the backfill only
--      (a backfill is not an edit by anyone: it must not bump `updated_at`, be refused as a
--      change to a demo league's read-only people, or re-run custom-attribute validation on
--      legacy rows) and switched on again before the migration ends.
--   2. Unique keys: players `(season_settings_id, external_registration_id)` where the id is
--      present, replacing the organization-wide lookup index; coaches `(organization_id,
--      season_settings_id, lower(email))`, replacing `coaches_organization_id_email_key` (20261104010000).
--      `coaches_email_normalised` is kept: it still states what the importer stores.
--   3. Triggers, since a CHECK cannot read another table. A player's `season_settings_id` is filled
--      on insert when absent (its division's season, else the active one: every existing writer
--      and fixture that names no season keeps working), must belong to the player's organization,
--      cannot change once set, and must equal the season of its `division_id` and of its team. The
--      same for a coach (and the coach's own player link). The seasons of both ends must also match
--      for a buddy pair (`player_buddies`), a roster row (`team_players`, which is what makes
--      `persist_team_schedule` refuse a roster naming another season's player), a team's coach
--      assignment (`team_coach_assignments`, and the `teams` columns `coach_id` and
--      `assistant_coach_ids`), and a coach's child link (`coach_team_requests`).
--   4. Writers replaced (each behind the md5 of its current text): `finalize_import_job` matches,
--      updates and creates players in the destination season only, resolves a division by id or name
--      within it, and refuses an organization with no season to import into (22023,
--      `season_missing`); `finalize_coach_import_job` does the same for coaches and for the child
--      registration ids of its link column, and now resolves the season (the job's, else the active
--      one) and refuses a completed or non-active one as the player finalizer does;
--      `materialize_import_buddy_pairs` resolves a registration id within the job's season;
--      `apply_player_patch` refuses a division or team outside the player's season (22023,
--      `season_mismatch`); `admin_create_player` takes `p_season_settings_id` (default: the active
--      season; a completed season is refused); `start_demo_session` sets the demo's season. The E1
--      guard still allows only the active season: widening it to drafts is E3b.
--   5. `view_org_metrics` gains a last column, `season_settings_id`, and one row per season of an
--      organization (one row, with NULL, for an organization with none): `total_players` and
--      `total_teams` count that season's, `total_users` the organization's.
--   6. An end-state check.
--
-- **Production (read-only, 2026-10-28).** 1 organization, 1 season (active), 0 players, 130 coaches
-- (the plan expected 0; they all take the active season, which is what a coach takes), 0 buddy
-- pairs, 0 coach child links. Nothing there can be left without a season or break a unique key. It has
-- the index, the constraint and the six triggers this migration drops or switches off for the backfill.
-- Ledger at 20261105010000; `finalize_import_job` and `apply_player_patch` are still the bodies
-- that 20261106010000 replaces, and by the time this migration runs they are the ones it expects.
--
-- **Production's bodies are not read from here.** The migration refuses to replace a function whose
-- text it has not seen (the md5 of `prosrc`, carriage returns stripped, below; read off a build of
-- the repository at 20261106010000). `finalize_coach_import_job`, `materialize_import_buddy_pairs`,
-- `admin_create_player` and `start_demo_session` were equal in production on 2026-10-28.
--
-- Reversible in structure: docs/sql/20261108010000_revert.sql restores the bodies, drops the
-- triggers, indexes and columns (the season of each row is lost; every row stays) and puts the view
-- back. Smoke: docs/sql/20261108010000_smoke.sql. pgTAP: supabase/tests/season_enrollment.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting bodies are checked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected constant jsonb := '{
        "finalize_import_job(uuid,jsonb)": "d8f151cedffe668ac0ec049665a3b68a",
        "finalize_coach_import_job(uuid,jsonb)": "e27d83126e3bfe8fff964c0814d93372",
        "materialize_import_buddy_pairs(uuid)": "87f352ac2cd06aa451d3cd5a6f923034",
        "apply_player_patch(uuid,jsonb)": "1a30ec2a89e0e4ab7c1eaf9305631daa",
        "admin_create_player(uuid,jsonb)": "4363a47d00f08e9bb7e8be363d0afe3b",
        "start_demo_session()": "09adc994497a8c5c16e5233437b26f2f"
    }';
    v_sig text;
    v_md5 text;
BEGIN
    FOR v_sig IN SELECT jsonb_object_keys(v_expected) LOOP
        -- Carriage returns stripped, as 20261101010000 does: a body stored with CRLF line ends
        -- is the same text.
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig);
        IF v_md5 IS DISTINCT FROM v_expected ->> v_sig THEN
            RAISE EXCEPTION 'public.% has a body this migration has not seen (md5 %, expected %): not replacing it',
                v_sig, v_md5, v_expected ->> v_sig;
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The columns, backfilled.
-- ---------------------------------------------------------------------------

ALTER TABLE public.players
    ADD COLUMN season_settings_id uuid REFERENCES public.season_settings (id) ON DELETE CASCADE;
ALTER TABLE public.coaches
    ADD COLUMN season_settings_id uuid REFERENCES public.season_settings (id) ON DELETE CASCADE;

-- Off for the backfill only (see the header); every one is switched on again below.
ALTER TABLE public.players DISABLE TRIGGER demo_fence_players;
ALTER TABLE public.players DISABLE TRIGGER players_set_timestamp;
ALTER TABLE public.players DISABLE TRIGGER tr_validate_player_attributes;
ALTER TABLE public.coaches DISABLE TRIGGER demo_fence_coaches;
ALTER TABLE public.coaches DISABLE TRIGGER coaches_set_timestamp;
ALTER TABLE public.coaches DISABLE TRIGGER tr_validate_coach_attributes;

DO $$
DECLARE
    v_players bigint;
    v_coaches bigint;
    v_by_division bigint;
    v_left_players bigint;
    v_left_coaches bigint;
    v_orgs text;
BEGIN
    SELECT count(*) INTO v_players FROM public.players;
    SELECT count(*) INTO v_coaches FROM public.coaches;

    UPDATE public.players p
       SET season_settings_id = d.season_settings_id
      FROM public.divisions d
     WHERE d.id = p.division_id;
    GET DIAGNOSTICS v_by_division = ROW_COUNT;

    UPDATE public.players p
       SET season_settings_id = s.id
      FROM public.season_settings s
     WHERE p.season_settings_id IS NULL
       AND s.organization_id = p.organization_id
       AND s.status = 'active';

    UPDATE public.coaches c
       SET season_settings_id = s.id
      FROM public.season_settings s
     WHERE s.organization_id = c.organization_id
       AND s.status = 'active';

    SELECT count(*) INTO v_left_players FROM public.players WHERE season_settings_id IS NULL;
    SELECT count(*) INTO v_left_coaches FROM public.coaches WHERE season_settings_id IS NULL;
    IF v_left_players + v_left_coaches > 0 THEN
        SELECT string_agg(DISTINCT x.organization_id::text, ', ') INTO v_orgs
          FROM (SELECT organization_id FROM public.players WHERE season_settings_id IS NULL
                UNION ALL
                SELECT organization_id FROM public.coaches WHERE season_settings_id IS NULL) x;
        RAISE EXCEPTION '% player(s) and % coach(es) have no season to take (no division, and the organization has no active season): organization(s) %',
            v_left_players, v_left_coaches, v_orgs
            USING ERRCODE = '23502';
    END IF;

    RAISE NOTICE 'season_settings_id backfilled on % player(s) (% from their division, the rest from the active season) and % coach(es)',
        v_players, v_by_division, v_coaches;
END;
$$;

ALTER TABLE public.players ENABLE TRIGGER demo_fence_players;
ALTER TABLE public.players ENABLE TRIGGER players_set_timestamp;
ALTER TABLE public.players ENABLE TRIGGER tr_validate_player_attributes;
ALTER TABLE public.coaches ENABLE TRIGGER demo_fence_coaches;
ALTER TABLE public.coaches ENABLE TRIGGER coaches_set_timestamp;
ALTER TABLE public.coaches ENABLE TRIGGER tr_validate_coach_attributes;

ALTER TABLE public.players ALTER COLUMN season_settings_id SET NOT NULL;
ALTER TABLE public.coaches ALTER COLUMN season_settings_id SET NOT NULL;

COMMENT ON COLUMN public.players.season_settings_id IS
    'The season this row is enrolled in. One row per person per season: nothing carries over, and a registration id seen in another season is another row. Equal to the season of division_id and of the team; filled on insert when absent (the division''s season, else the active one) and never changed. 20261108010000.';
COMMENT ON COLUMN public.coaches.season_settings_id IS
    'The season this row is imported for. One row per organization, season and email; nothing carries over. Filled on insert when absent (the active season) and never changed. 20261108010000.';

-- ---------------------------------------------------------------------------
-- 3. The keys.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_dupes bigint;
BEGIN
    SELECT count(*) INTO v_dupes FROM (
        SELECT 1 FROM public.players
         WHERE external_registration_id IS NOT NULL
         GROUP BY season_settings_id, external_registration_id
        HAVING count(*) > 1) d;
    IF v_dupes > 0 THEN
        RAISE EXCEPTION '% (season, registration id) pair(s) hold more than one player: the owner decides which to keep before this key can exist', v_dupes
            USING ERRCODE = '23505';
    END IF;
END;
$$;

DROP INDEX public.idx_players_org_external_registration_id;
CREATE UNIQUE INDEX players_season_external_registration_id_key
    ON public.players (season_settings_id, external_registration_id)
    WHERE external_registration_id IS NOT NULL;
CREATE INDEX idx_players_season_settings_id ON public.players (season_settings_id);

ALTER TABLE public.coaches DROP CONSTRAINT coaches_organization_id_email_key;
CREATE UNIQUE INDEX coaches_organization_season_email_key
    ON public.coaches (organization_id, season_settings_id, lower(email));
CREATE INDEX idx_coaches_season_settings_id ON public.coaches (season_settings_id);

COMMENT ON COLUMN public.coaches.email IS
    'The import''s key and an admin''s contact; no coach signs in. Lower-case and trimmed (coaches_email_normalised), unique within the organization and season (coaches_organization_season_email_key). 20261104010000; per season 20261108010000.';

-- ---------------------------------------------------------------------------
-- 4. The season triggers.
-- ---------------------------------------------------------------------------
--
-- A CHECK cannot read another table, so these are triggers. They run for every writer, a definer
-- RPC or a direct write alike. Each refuses with 23514 (check_violation) and a DETAIL naming the
-- rule. They are SECURITY DEFINER so that they read `divisions`, `teams`, `coaches` and
-- `season_settings` whatever the caller's rows are (the same as enforce_division_season_org_match);
-- none is executable by a client role.

CREATE FUNCTION public.enforce_player_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_season_org uuid;
    v_division_season uuid;
    v_team_season uuid;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.season_settings_id IS NULL THEN
        IF NEW.division_id IS NOT NULL THEN
            SELECT d.season_settings_id INTO NEW.season_settings_id
              FROM public.divisions d WHERE d.id = NEW.division_id;
        END IF;
        IF NEW.season_settings_id IS NULL THEN
            SELECT s.id INTO NEW.season_settings_id
              FROM public.season_settings s
             WHERE s.organization_id = NEW.organization_id AND s.status = 'active';
        END IF;
        IF NEW.season_settings_id IS NULL THEN
            RAISE EXCEPTION 'a player needs a season: the organization has no active season and the player names no division'
                USING ERRCODE = '23502';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.season_settings_id IS DISTINCT FROM OLD.season_settings_id THEN
        RAISE EXCEPTION 'a player belongs to one season: season_settings_id cannot change'
            USING ERRCODE = '23514', DETAIL = 'season_immutable';
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT s.organization_id INTO v_season_org
          FROM public.season_settings s WHERE s.id = NEW.season_settings_id;
        IF v_season_org IS DISTINCT FROM NEW.organization_id THEN
            RAISE EXCEPTION 'the player''s season belongs to another organization'
                USING ERRCODE = '23514', DETAIL = 'season_mismatch';
        END IF;
    END IF;

    IF NEW.division_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.division_id IS DISTINCT FROM OLD.division_id) THEN
        SELECT d.season_settings_id INTO v_division_season
          FROM public.divisions d WHERE d.id = NEW.division_id;
        IF v_division_season IS DISTINCT FROM NEW.season_settings_id THEN
            RAISE EXCEPTION 'the player''s division is in another season'
                USING ERRCODE = '23514', DETAIL = 'season_mismatch';
        END IF;
    END IF;

    IF NEW.team_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.team_id IS DISTINCT FROM OLD.team_id) THEN
        SELECT d.season_settings_id INTO v_team_season
          FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
         WHERE t.id = NEW.team_id;
        -- A team that does not exist is the foreign key's to refuse, not this rule's.
        IF FOUND AND v_team_season IS DISTINCT FROM NEW.season_settings_id THEN
            RAISE EXCEPTION 'the player''s team is in another season'
                USING ERRCODE = '23514', DETAIL = 'season_mismatch';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_player_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.enforce_player_season() IS
    'Trigger function: fills a new player''s season (its division''s, else the active one), and refuses a season of another organization, a change of season, and a division or team of another season (23514). 20261108010000.';

CREATE TRIGGER players_enforce_season
    BEFORE INSERT OR UPDATE OF season_settings_id, division_id, team_id ON public.players
    FOR EACH ROW EXECUTE FUNCTION public.enforce_player_season();

CREATE FUNCTION public.enforce_coach_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_season_org uuid;
    v_player_season uuid;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.season_settings_id IS NULL THEN
        SELECT s.id INTO NEW.season_settings_id
          FROM public.season_settings s
         WHERE s.organization_id = NEW.organization_id AND s.status = 'active';
        IF NEW.season_settings_id IS NULL THEN
            RAISE EXCEPTION 'a coach needs a season: the organization has no active season'
                USING ERRCODE = '23502';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.season_settings_id IS DISTINCT FROM OLD.season_settings_id THEN
        RAISE EXCEPTION 'a coach row belongs to one season: season_settings_id cannot change'
            USING ERRCODE = '23514', DETAIL = 'season_immutable';
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT s.organization_id INTO v_season_org
          FROM public.season_settings s WHERE s.id = NEW.season_settings_id;
        IF v_season_org IS DISTINCT FROM NEW.organization_id THEN
            RAISE EXCEPTION 'the coach''s season belongs to another organization'
                USING ERRCODE = '23514', DETAIL = 'season_mismatch';
        END IF;
    END IF;

    IF NEW.player_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.player_id IS DISTINCT FROM OLD.player_id) THEN
        SELECT p.season_settings_id INTO v_player_season
          FROM public.players p WHERE p.id = NEW.player_id;
        IF FOUND AND v_player_season IS DISTINCT FROM NEW.season_settings_id THEN
            RAISE EXCEPTION 'the coach''s player record is in another season'
                USING ERRCODE = '23514', DETAIL = 'season_mismatch';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_coach_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.enforce_coach_season() IS
    'Trigger function: fills a new coach''s season (the active one), and refuses a season of another organization, a change of season, and a player record of another season (23514). 20261108010000.';

CREATE TRIGGER coaches_enforce_season
    BEFORE INSERT OR UPDATE OF season_settings_id, player_id ON public.coaches
    FOR EACH ROW EXECUTE FUNCTION public.enforce_coach_season();

-- A buddy pair, a roster row, a coach's child link and a team's coaches name two rows each: the
-- seasons of both must be the same one.

CREATE FUNCTION public.player_buddies_same_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF (SELECT p.season_settings_id FROM public.players p WHERE p.id = NEW.player_id)
       IS DISTINCT FROM
       (SELECT p.season_settings_id FROM public.players p WHERE p.id = NEW.buddy_player_id) THEN
        RAISE EXCEPTION 'a buddy pair is two players of the same season'
            USING ERRCODE = '23514', DETAIL = 'season_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.player_buddies_same_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.player_buddies_same_season() IS
    'Trigger function: refuses a buddy pair whose two players are in different seasons (23514). 20261108010000.';

CREATE TRIGGER player_buddies_same_season
    BEFORE INSERT OR UPDATE OF player_id, buddy_player_id ON public.player_buddies
    FOR EACH ROW EXECUTE FUNCTION public.player_buddies_same_season();

CREATE FUNCTION public.team_players_same_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_team_season uuid;
    v_player_season uuid;
BEGIN
    SELECT d.season_settings_id INTO v_team_season
      FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
     WHERE t.id = NEW.team_id;
    SELECT p.season_settings_id INTO v_player_season
      FROM public.players p WHERE p.id = NEW.player_id;
    -- A team or player that does not exist is the foreign key's to refuse, not this rule's.
    IF v_team_season IS NOT NULL AND v_player_season IS NOT NULL
       AND v_team_season <> v_player_season THEN
        RAISE EXCEPTION 'a roster names players of its own season: player % is in another season than team %',
            NEW.player_id, NEW.team_id
            USING ERRCODE = '23514', DETAIL = 'season_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.team_players_same_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.team_players_same_season() IS
    'Trigger function: refuses a roster row whose player is in another season than its team (23514); persist_team_schedule, the player patch and the demo seed all write through it. 20261108010000.';

CREATE TRIGGER team_players_same_season
    BEFORE INSERT OR UPDATE OF team_id, player_id ON public.team_players
    FOR EACH ROW EXECUTE FUNCTION public.team_players_same_season();

CREATE FUNCTION public.team_coach_assignments_same_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_team_season uuid;
    v_coach_season uuid;
BEGIN
    SELECT d.season_settings_id INTO v_team_season
      FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
     WHERE t.id = NEW.team_id;
    SELECT c.season_settings_id INTO v_coach_season
      FROM public.coaches c WHERE c.id = NEW.coach_id;
    IF v_team_season IS NOT NULL AND v_coach_season IS NOT NULL
       AND v_team_season <> v_coach_season THEN
        RAISE EXCEPTION 'a team''s coaches are of its own season: coach % is in another season than team %',
            NEW.coach_id, NEW.team_id
            USING ERRCODE = '23514', DETAIL = 'season_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.team_coach_assignments_same_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.team_coach_assignments_same_season() IS
    'Trigger function: refuses a coach assignment whose coach is in another season than its team (23514). 20261108010000.';

CREATE TRIGGER team_coach_assignments_same_season
    BEFORE INSERT OR UPDATE OF team_id, coach_id ON public.team_coach_assignments
    FOR EACH ROW EXECUTE FUNCTION public.team_coach_assignments_same_season();

-- The denormalised columns teams.coach_id and assistant_coach_ids, which persist_team_schedule
-- and set_team_coaches write, are held to the same rule.
CREATE FUNCTION public.teams_coaches_same_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_team_season uuid;
    v_other uuid;
BEGIN
    SELECT d.season_settings_id INTO v_team_season
      FROM public.divisions d WHERE d.id = NEW.division_id;
    SELECT c.id INTO v_other
      FROM public.coaches c
     WHERE (c.id = NEW.coach_id OR c.id = ANY(COALESCE(NEW.assistant_coach_ids, '{}'::uuid[])))
       AND c.season_settings_id <> v_team_season
     LIMIT 1;
    IF v_other IS NOT NULL THEN
        RAISE EXCEPTION 'a team''s coaches are of its own season: coach % is in another season than team %',
            v_other, NEW.id
            USING ERRCODE = '23514', DETAIL = 'season_mismatch';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.teams_coaches_same_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.teams_coaches_same_season() IS
    'Trigger function: refuses a team whose lead or assistant coach is in another season than its division (23514). 20261108010000.';

CREATE TRIGGER teams_coaches_same_season
    BEFORE INSERT OR UPDATE OF coach_id, assistant_coach_ids, division_id ON public.teams
    FOR EACH ROW EXECUTE FUNCTION public.teams_coaches_same_season();

CREATE FUNCTION public.coach_team_requests_same_season()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_coach_season uuid;
    v_player_season uuid;
BEGIN
    IF NEW.player_id IS NOT NULL THEN
        SELECT c.season_settings_id INTO v_coach_season
          FROM public.coaches c WHERE c.id = NEW.coach_id;
        SELECT p.season_settings_id INTO v_player_season
          FROM public.players p WHERE p.id = NEW.player_id;
        IF v_coach_season IS NOT NULL AND v_player_season IS NOT NULL
           AND v_coach_season <> v_player_season THEN
            RAISE EXCEPTION 'a coach''s child is a player of the coach''s own season'
                USING ERRCODE = '23514', DETAIL = 'season_mismatch';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.coach_team_requests_same_season() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.coach_team_requests_same_season() IS
    'Trigger function: refuses a coach-to-child link whose player is in another season than its coach (23514). 20261108010000.';

CREATE TRIGGER coach_team_requests_same_season
    BEFORE INSERT OR UPDATE OF coach_id, player_id ON public.coach_team_requests
    FOR EACH ROW EXECUTE FUNCTION public.coach_team_requests_same_season();

-- ---------------------------------------------------------------------------
-- 5. The writers.
-- ---------------------------------------------------------------------------
--
-- Each body below is the one the md5 guard above read, with the season change only; the UTC idiom
-- and every grant are kept (CREATE OR REPLACE keeps the grants).

CREATE OR REPLACE FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_error_count integer := 0;
    v_total_promoted_count integer := 0;
    v_status text;
    v_result jsonb;
    v_gender_model text;
    v_season_settings_id uuid;
    v_season_status text;
    v_waitlist_enabled boolean := true;
    v_created_divisions integer := 0;
    v_declared jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- The organization's declared player fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'player');

    v_error_count := jsonb_array_length(v_validation_errors);
    v_status := CASE WHEN v_error_count > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- Org division format: 'split' (default) -> gendered U8B/U8G; 'coed' -> U8.
    SELECT COALESCE(o.feature_flags->>'gender_model', 'split'),
           COALESCE((o.feature_flags->>'waitlist')::boolean, true)
    INTO v_gender_model, v_waitlist_enabled
    FROM public.organizations o
    WHERE o.id = v_job.organization_id;
    IF v_gender_model NOT IN ('split', 'coed') THEN
        v_gender_model := 'split';
    END IF;

    -- Season that auto-created divisions attach to (divisions are per-season):
    -- the job's own (20261101010000), or, for a job made before jobs carried one,
    -- the organization's active season. Nothing picks a season by its dates or its
    -- age any more, so a draft season is never imported into by accident. A
    -- completed season takes no import.
    SELECT s.id, s.status
    INTO v_season_settings_id, v_season_status
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);

    -- A player belongs to one season (20261108010000), so an import needs one to add to.
    IF v_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no season to import into', v_job.organization_id
            USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    -- Enrollment is per season now (20261108010000): this import matches, updates and creates
    -- players in the destination season only, and a registration id seen in another season is
    -- a new row here. The guard stays "the active season only" until draft seasons take imports
    -- (E3b widens it).
    IF v_season_status IS NOT NULL AND v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no import: only the active season does', v_season_settings_id, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;

    -- Auto-create derived divisions that don't exist yet for that season.
    IF v_season_settings_id IS NOT NULL THEN
        WITH staged AS (
            SELECT
                public.import_payload_text(
                    sp.normalized_payload, 'age group', 'age_group', 'age'
                ) AS age_text,
                lower(left(COALESCE(
                    public.import_payload_text(sp.normalized_payload, 'gender'), ''
                ), 1)) AS g
            FROM public.staging_players sp
            WHERE sp.import_job_id = p_import_job_id
              AND sp.organization_id = v_job.organization_id
              AND sp.promoted_at IS NULL
              AND sp.normalized_payload IS NOT NULL
              AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
        ),
        derived AS (
            SELECT DISTINCT
                'U' || (age_text::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN g IN ('m', 'b') THEN 'B'
                        WHEN g IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END AS name,
                CASE
                    WHEN v_gender_model = 'coed' THEN 'coed'
                    WHEN g IN ('m', 'b') THEN 'boys'
                    WHEN g IN ('f', 'g') THEN 'girls'
                    ELSE 'coed'
                END AS gender_policy
            FROM staged
            WHERE age_text ~ '^[0-9]+$'
        ),
        created AS (
            INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy)
            SELECT v_job.organization_id, v_season_settings_id, d.name, d.gender_policy::gender_policy_enum
            FROM derived d
            WHERE NOT EXISTS (
                SELECT 1 FROM public.divisions x
                WHERE x.organization_id = v_job.organization_id
                  AND x.season_settings_id = v_season_settings_id
                  AND lower(x.name) = lower(d.name)
            )
            ON CONFLICT (season_settings_id, name) DO NOTHING
            RETURNING id
        )
        SELECT count(*) INTO v_created_divisions FROM created;
    END IF;

    WITH pending AS MATERIALIZED (
        SELECT
            sp.id AS staging_id,
            sp.source_row_number,
            sp.organization_id,
            sp.normalized_payload,
            public.import_payload_text(
                sp.normalized_payload,
                'external_registration_id', 'gotsport_id', 'registration_id', 'player_id'
            ) AS external_registration_id,
            public.import_payload_text(sp.normalized_payload, 'division_id') AS division_id_text,
            public.import_payload_text(
                sp.normalized_payload,
                'division_name', 'division', 'group', 'program'
            ) AS explicit_division_name,
            -- Gendered division derived from age group + gender, honoring the
            -- org gender_model. A player of age N plays in division U(N+1).
            CASE
                WHEN public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age') ~ '^[0-9]+$'
                THEN 'U' || ((public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age'))::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('m', 'b') THEN 'B'
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END
            END AS derived_division_name,
            public.import_payload_text(sp.normalized_payload, 'first_name') AS first_name,
            public.import_payload_text(sp.normalized_payload, 'last_name') AS last_name,
            public.import_payload_text(sp.normalized_payload, 'preferred_name', 'nickname') AS preferred_name,
            -- The natural age (R5): the one import-validation computed from the
            -- file's birth date with the season's cutoff (else from the age
            -- group), else, for a row staged without it, the age group the
            -- export states. No birth date is staged or stored.
            public.import_payload_text(
                sp.normalized_payload, 'age group', 'age_group', 'age'
            ) AS age_group_text,
            public.import_payload_text(sp.normalized_payload, 'natural_age') AS natural_age_text,
            public.import_payload_text(sp.normalized_payload, 'grade') AS grade,
            public.import_payload_text(sp.normalized_payload, 'gender') AS gender,
            lower(public.import_payload_text(sp.normalized_payload, 'skill_tier', 'skill_level')) AS skill_tier_text,
            public.import_payload_text(
                sp.normalized_payload,
                'years_played', 'years played',
                'how many years has your player played in an organized soccer program?'
            ) AS years_played_text,
            lower(COALESCE(public.import_payload_text(
                sp.normalized_payload, 'waitlist', 'waitlisted'
            ), '')) AS waitlist_text,
            public.import_payload_text(
                sp.normalized_payload,
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ) AS play_up_text,
            (sp.normalized_payload ?| ARRAY[
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ]) AS play_up_present,
            public.import_payload_text(sp.normalized_payload, 'buddy_request') AS buddy_request,
            -- Nullable: NULL means the coaching-interest column is genuinely
            -- absent from this row's payload (re-import should preserve the
            -- existing player's willing_to_coach), distinct from a present-
            -- but-negative answer, which lower()s to a non-matching string.
            lower(public.import_payload_text(
                sp.normalized_payload,
                'willing_to_coach', 'coach_volunteer',
                'can you coach for this player''s team?'
            )) AS coaching_answer,
            public.import_payload_text(sp.normalized_payload, 'team name') AS team_name,
            public.import_payload_text(sp.normalized_payload, 'team age') AS team_age,
            public.import_payload_text(sp.normalized_payload, 'team gender') AS team_gender,
            -- The allowlist (R0): only the fields the organization declared
            -- for players, keyed by their declared names. Every other column
            -- of the export is dropped here, whatever reached staging.
            public.import_declared_attributes(v_declared, sp.normalized_payload)
                AS custom_attributes
        FROM public.staging_players sp
        WHERE sp.import_job_id = p_import_job_id
          AND sp.organization_id = v_job.organization_id
          AND sp.promoted_at IS NULL
          AND sp.normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
    ),
    valid_candidates AS MATERIALIZED (
        SELECT
            p.*,
            COALESCE(p.explicit_division_name, p.derived_division_name) AS division_name,
            d.id AS division_id,
            CASE
                WHEN p.natural_age_text ~ '^[0-9]{1,2}$' AND p.natural_age_text::int BETWEEN 1 AND 25
                    THEN p.natural_age_text::smallint
                WHEN p.age_group_text ~ '^[0-9]{1,2}$' AND p.age_group_text::int BETWEEN 1 AND 25
                    THEN p.age_group_text::smallint
            END AS natural_age,
            CASE
                WHEN p.skill_tier_text IN ('novice', 'developing', 'advanced') THEN p.skill_tier_text
                ELSE NULL
            END AS skill_tier,
            CASE
                WHEN p.years_played_text ~ '^[0-9]{1,2}$'
                     AND p.years_played_text::int BETWEEN 0 AND 30
                THEN p.years_played_text::smallint
            END AS years_played,
            CASE
                WHEN v_waitlist_enabled
                     AND p.waitlist_text IN ('true', 't', 'yes', 'y', '1') THEN 'waitlist'
                ELSE 'active'
            END AS import_status,
            -- The play-up column is the player's request (20261106010000): yes, true, y, t, 1
            -- or x is a request, anything else is none, a blank cell included (a request
            -- withdrawn in the file). NULL only when the column is absent from the row, so a
            -- re-import leaves the stored request alone. `import_payload_text` returns NULL for
            -- a blank cell and for a missing key alike, so presence is read from the key itself.
            CASE
                WHEN NOT p.play_up_present THEN NULL
                ELSE COALESCE(lower(p.play_up_text) IN ('yes', 'true', 'y', 't', '1', 'x'), false)
            END AS play_up_requested,
            -- NULL when the coaching-interest column is absent (preserve
            -- existing value on re-import); a boolean otherwise.
            CASE
                WHEN p.coaching_answer IS NULL THEN NULL
                ELSE p.coaching_answer IN ('true', 't', 'yes', 'y', '1', 'maybe', 'coach',
                    'head coach', 'assistant coach', 'volunteer', 'willing')
            END AS willing_to_coach,
            (p.custom_attributes
                || jsonb_strip_nulls(jsonb_build_object(
                    'team_name', p.team_name,
                    'team_age', p.team_age,
                    'team_gender', p.team_gender
                ))
                || CASE
                    WHEN p.coaching_answer IS NOT NULL AND p.coaching_answer <> ''
                    THEN jsonb_build_object('coaching_answer', p.coaching_answer)
                    ELSE '{}'::jsonb
                END
            ) AS final_custom_attributes
        FROM pending p
        LEFT JOIN LATERAL (
            SELECT divisions.id
            FROM public.divisions
            WHERE divisions.organization_id = p.organization_id
              -- Every match is in the destination season (divisions are unique per season, and
              -- a player's division is always in the player's own season): an explicit division
              -- id from another season matches nothing and is counted as unmatched.
              AND divisions.season_settings_id = v_season_settings_id
              AND (
                  divisions.id = CASE
                      WHEN p.division_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN p.division_id_text::uuid
                      ELSE NULL
                  END
                  OR lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))
                  OR lower(divisions.name) = lower(COALESCE(p.derived_division_name, ''))
              )
            ORDER BY
                -- Prefer explicit id, then explicit name, then derived name.
                (divisions.id::text = p.division_id_text) DESC,
                (lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))) DESC,
                divisions.created_at DESC, divisions.id
            LIMIT 1
        ) d ON true
        WHERE p.first_name IS NOT NULL
          AND p.last_name IS NOT NULL
    ),
    deduped_external AS MATERIALIZED (
        SELECT DISTINCT ON (organization_id, external_registration_id) *
        FROM valid_candidates
        WHERE external_registration_id IS NOT NULL
        ORDER BY organization_id, external_registration_id, source_row_number NULLS LAST, staging_id
    ),
    existing_matches AS MATERIALIZED (
        SELECT de.staging_id, matched_players.id AS player_id
        FROM deduped_external de
        JOIN LATERAL (
            SELECT players.id
            FROM public.players
            WHERE players.organization_id = de.organization_id
              AND players.season_settings_id = v_season_settings_id
              AND players.external_registration_id = de.external_registration_id
            ORDER BY players.created_at, players.id
            LIMIT 1
        ) matched_players ON true
    ),
    updated_existing AS (
        UPDATE public.players p
        SET
            division_id = COALESCE(de.division_id, p.division_id),
            first_name = de.first_name,
            last_name = de.last_name,
            preferred_name = COALESCE(de.preferred_name, p.preferred_name),
            natural_age = de.natural_age,
            grade = COALESCE(de.grade, p.grade),
            gender = COALESCE(de.gender, p.gender),
            skill_tier = COALESCE(de.skill_tier, p.skill_tier),
            years_played = COALESCE(de.years_played, p.years_played),
            status = CASE
                WHEN de.import_status = 'waitlist' THEN 'waitlist'
                WHEN p.status = 'waitlist' AND de.import_status = 'active' THEN 'active'
                ELSE p.status
            END,
            willing_to_coach = COALESCE(de.willing_to_coach, p.willing_to_coach),
            coach_volunteer = COALESCE(de.willing_to_coach, p.coach_volunteer),
            play_up_requested = COALESCE(de.play_up_requested, p.play_up_requested),
            buddy_request = COALESCE(de.buddy_request, p.buddy_request),
            -- An existing player's undeclared keys go too; the import's own
            -- keys (coaching answer, team placement) stay. The play-up column is
            -- `play_up_requested` now, and kept as text only where the organization
            -- declared it as its own field.
            custom_attributes = public.import_kept_player_attributes(v_declared, p.custom_attributes)
                || de.final_custom_attributes,
            last_imported_at = v_now,
            import_source = 'gotsport',
            registration_history = COALESCE(p.registration_history, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                    'import_job_id', p_import_job_id,
                    'imported_at', v_now,
                    'source', 'gotsport',
                    'operation', 'updated'
                ))
        FROM deduped_external de
        JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE p.id = em.player_id
        RETURNING p.id
    ),
    insert_source AS MATERIALIZED (
        SELECT de.*
        FROM deduped_external de
        LEFT JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE em.player_id IS NULL

        UNION ALL

        SELECT vc.*
        FROM valid_candidates vc
        WHERE vc.external_registration_id IS NULL
    ),
    inserted_new AS (
        INSERT INTO public.players (
            organization_id,
            season_settings_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            natural_age,
            grade,
            gender,
            skill_tier,
            years_played,
            status,
            coach_volunteer,
            willing_to_coach,
            play_up_requested,
            buddy_request,
            registration_history,
            last_imported_at,
            import_source,
            custom_attributes
        )
        SELECT
            organization_id,
            v_season_settings_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            natural_age,
            grade,
            gender,
            skill_tier,
            years_played,
            import_status,
            COALESCE(willing_to_coach, false),
            COALESCE(willing_to_coach, false),
            COALESCE(play_up_requested, false),
            buddy_request,
            jsonb_build_array(jsonb_build_object(
                'import_job_id', p_import_job_id,
                'imported_at', v_now,
                'source', 'gotsport',
                'operation', 'inserted'
            )),
            v_now,
            'gotsport',
            final_custom_attributes
        FROM insert_source
        RETURNING id
    ),
    promoted AS (
        UPDATE public.staging_players sp
        SET
            promoted_at = v_now,
            promoted_by = auth.uid()
        WHERE sp.id IN (SELECT staging_id FROM valid_candidates)
        RETURNING sp.id
    )
    SELECT jsonb_build_object(
        'staged_rows', (SELECT count(*) FROM pending),
        'valid_staged_rows', (SELECT count(*) FROM valid_candidates),
        'promoted_rows', (SELECT count(*) FROM promoted),
        'updated_players', (SELECT count(*) FROM updated_existing),
        'inserted_players', (SELECT count(*) FROM inserted_new),
        'duplicate_external_rows',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NOT NULL)
            - (SELECT count(*) FROM deduped_external),
        'without_external_id',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NULL),
        'unmatched_division_rows',
            (SELECT count(*) FROM valid_candidates WHERE division_name IS NOT NULL AND division_id IS NULL),
        'waitlisted_rows',
            (SELECT count(*) FROM valid_candidates WHERE import_status = 'waitlist'),
        'created_divisions', v_created_divisions,
        'validation_error_rows', v_error_count,
        'status', v_status
    )
    INTO v_result;

    SELECT count(*)
    INTO v_total_promoted_count
    FROM public.staging_players
    WHERE import_job_id = p_import_job_id
      AND promoted_at IS NOT NULL;

    v_result := v_result || jsonb_build_object('total_promoted_rows', v_total_promoted_count);

    UPDATE public.import_jobs
    SET
        status = v_status,
        processed_rows = v_total_promoted_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{finalize}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        v_result
    );

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_coach_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_row public.staging_import_rows%ROWTYPE;
    v_existing public.coaches%ROWTYPE;
    v_after public.coaches%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_email text;
    v_full_name text;
    v_status text;
    v_can_multi_text text;
    v_can_multi boolean;
    v_certifications jsonb;
    v_contact_info jsonb;
    v_custom_attributes jsonb;
    v_declared jsonb;
    v_season_settings_id uuid;
    v_season_status text;
    v_previous_payload jsonb;
    v_existing_found boolean;
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
    v_invalid_count integer := 0;
    -- S7 (admin-only plan): the coach's children, named by player registration id.
    v_child record;
    v_player_id uuid;
    v_slot integer;
    v_previous_links jsonb;
    v_linked_count integer := 0;
    v_unmatched jsonb := '[]'::jsonb;
    v_unmatched_count integer := 0;
    v_blocked_assignment_count integer := 0;
    v_total_applied_count integer := 0;
    v_status_result text;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- A coach row belongs to one season (20261108010000), as a player row does: the job's own
    -- season, or for a job made before jobs carried one the organization's active season.
    -- Only the active season takes an import until draft seasons do (E3b widens this, with
    -- the player finalizer's guard); a completed one never does.
    SELECT s.id, s.status
    INTO v_season_settings_id, v_season_status
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);
    IF v_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no season to import into', v_job.organization_id
            USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no import: only the active season does', v_season_settings_id, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;

    -- The organization's declared coach fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'coach');

    -- Deliberately row-oriented for the coach slice: each applied row needs an
    -- exact rollback snapshot and independent conflict outcome. The Edge
    -- Function caps imports at 5,000 rows; set-based promotion can replace
    -- this once field-slot promotion shares the same ledger.
    FOR v_row IN
        SELECT *
        FROM public.staging_import_rows
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'coaches'
          AND applied_at IS NULL
          AND normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(validation_errors), 0) = 0
        ORDER BY source_row_number NULLS LAST, id
    LOOP
        v_email := lower(public.import_payload_text(v_row.normalized_payload, 'email'));
        v_full_name := public.import_payload_text(v_row.normalized_payload, 'full_name');
        v_status := lower(COALESCE(
            public.import_payload_text(v_row.normalized_payload, 'status', 'coach_status'),
            'active'
        ));
        v_can_multi_text := public.import_payload_text(
            v_row.normalized_payload,
            'can_coach_multiple_teams',
            'multiple_teams',
            'multi_team'
        );
        v_certifications := public.import_text_to_jsonb_array(
            public.import_payload_text(v_row.normalized_payload, 'certifications', 'certification')
        );
        -- The coach's email is the import's key and an admin's contact; no coach signs in
        -- and no phone is stored (R0).
        v_contact_info := jsonb_strip_nulls(jsonb_build_object('email', v_email));
        -- The allowlist (R0): only the fields the organization declared for
        -- coaches, keyed by their declared names. Every other column of the
        -- export (a child's details, guardians' addresses and phones, the
        -- coach's own birth date) is dropped here, whatever reached staging.
        v_custom_attributes := public.import_declared_attributes(v_declared, v_row.normalized_payload);

        IF v_email IS NULL
           OR v_full_name IS NULL
           OR v_status NOT IN ('active', 'pending-confirmation', 'inactive') THEN
            v_invalid_count := v_invalid_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Coach row is missing full_name/email or has an invalid status',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        -- A coach is one row per organization, season and email (20261108010000): the same
        -- address in another season, or another organization, is another coach, never a
        -- conflict, and nothing is read from or written to that row.
        SELECT *
        INTO v_existing
        FROM public.coaches c
        WHERE c.organization_id = v_job.organization_id
          AND c.season_settings_id = v_season_settings_id
          AND c.email = v_email;
        v_existing_found := FOUND;

        IF v_existing_found
           AND v_status = 'inactive'
           AND EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.organization_id = v_job.organization_id
                  AND (
                    t.coach_id = v_existing.id
                    OR v_existing.id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
                  )
           ) THEN
            v_blocked_assignment_count := v_blocked_assignment_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Assigned coaches cannot be marked inactive by import',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        IF v_existing_found THEN
            v_previous_payload := to_jsonb(v_existing);
            -- The links this row is about to replace, kept for the rollback.
            IF v_row.normalized_payload ? 'child_registration_id' THEN
                SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', r.player_id, 'slot', r.slot)
                                          ORDER BY r.slot), '[]'::jsonb)
                  INTO v_previous_links
                  FROM public.coach_team_requests r
                 WHERE r.organization_id = v_job.organization_id
                   AND r.coach_id = v_existing.id
                   AND r.player_id IS NOT NULL;
                v_previous_payload := v_previous_payload || jsonb_build_object('child_links', v_previous_links);
            END IF;
            v_can_multi := CASE
                WHEN v_can_multi_text IS NULL THEN COALESCE(v_existing.can_coach_multiple_teams, false)
                ELSE public.import_text_to_bool(v_can_multi_text)
            END;

            UPDATE public.coaches
            SET
                full_name = v_full_name,
                email = v_email,
                certifications = COALESCE(NULLIF(v_certifications, '[]'::jsonb), v_existing.certifications),
                can_coach_multiple_teams = v_can_multi,
                status = v_status,
                contact_info = (COALESCE(v_existing.contact_info, '{}'::jsonb) - 'phone') || v_contact_info,
                last_imported_at = v_now,
                import_source = 'coach_csv',
                custom_attributes = public.import_declared_attributes(
                    v_declared, COALESCE(v_existing.custom_attributes, '{}'::jsonb)
                ) || v_custom_attributes,
                updated_at = v_now
            WHERE id = v_existing.id
              AND organization_id = v_job.organization_id
            RETURNING * INTO v_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'coaches',
                'coaches',
                v_after.id,
                'updated',
                v_previous_payload,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_updated_count := v_updated_count + 1;
        ELSE
            v_can_multi := COALESCE(public.import_text_to_bool(v_can_multi_text), false);

            INSERT INTO public.coaches (
                organization_id,
                season_settings_id,
                full_name,
                email,
                certifications,
                can_coach_multiple_teams,
                status,
                contact_info,
                last_imported_at,
                import_source,
                custom_attributes
            )
            VALUES (
                v_job.organization_id,
                v_season_settings_id,
                v_full_name,
                v_email,
                v_certifications,
                v_can_multi,
                v_status,
                v_contact_info,
                v_now,
                'coach_csv',
                v_custom_attributes
            )
            RETURNING * INTO v_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'coaches',
                'coaches',
                v_after.id,
                'inserted',
                NULL,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            );

            v_inserted_count := v_inserted_count + 1;
        END IF;

        -- S7: the coach's children. A file with the column names them (one or more registration
        -- ids, separated by ; or ,); the coach's links become exactly those that match a player
        -- of THIS organization and season, one row each, in the order the file lists them. An id
        -- that matches no player here (not imported yet, mistyped, or another season's or
        -- organization's) is
        -- reported in the result and writes nothing. A file without the column leaves the
        -- coach's links alone. Nothing but this import writes coach_team_requests.
        IF v_row.normalized_payload ? 'child_registration_id' THEN
            DELETE FROM public.coach_team_requests
             WHERE organization_id = v_job.organization_id
               AND coach_id = v_after.id;
            v_slot := 0;
            FOR v_child IN
                SELECT x.registration_id
                  FROM (
                      SELECT btrim(part) AS registration_id, min(ord) AS first_at
                        FROM regexp_split_to_table(
                                 COALESCE(public.import_payload_text(v_row.normalized_payload, 'child_registration_id'), ''),
                                 '[;,]'
                             ) WITH ORDINALITY AS s(part, ord)
                       WHERE btrim(part) <> ''
                       GROUP BY btrim(part)
                  ) x
                 ORDER BY x.first_at
            LOOP
                SELECT p.id
                  INTO v_player_id
                  FROM public.players p
                 WHERE p.organization_id = v_job.organization_id
                   AND p.season_settings_id = v_season_settings_id
                   AND p.external_registration_id = v_child.registration_id
                 ORDER BY p.updated_at DESC, p.id
                 LIMIT 1;
                IF v_player_id IS NULL THEN
                    v_unmatched_count := v_unmatched_count + 1;
                    IF jsonb_array_length(v_unmatched) < 200 THEN
                        v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
                            'coach_id', v_after.id,
                            'registration_id', left(v_child.registration_id, 100)
                        ));
                    END IF;
                ELSE
                    v_slot := v_slot + 1;
                    INSERT INTO public.coach_team_requests (organization_id, coach_id, player_id, slot)
                    VALUES (v_job.organization_id, v_after.id, v_player_id, v_slot);
                    v_linked_count := v_linked_count + 1;
                END IF;
            END LOOP;
        END IF;

        UPDATE public.staging_import_rows
        SET
            applied_at = v_now,
            applied_by = auth.uid()
        WHERE id = v_row.id;
    END LOOP;

    SELECT count(*)
    INTO v_total_applied_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND import_type = 'coaches';

    v_status_result := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR v_invalid_count > 0
          OR v_blocked_assignment_count > 0
          OR v_unmatched_count > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    v_result := jsonb_build_object(
        'status', v_status_result,
        'staged_rows', (
            SELECT count(*)
            FROM public.staging_import_rows
            WHERE import_job_id = p_import_job_id
              AND import_type = 'coaches'
        ),
        'inserted_coaches', v_inserted_count,
        'updated_coaches', v_updated_count,
        'invalid_rows', v_invalid_count,
        'blocked_assignment_rows', v_blocked_assignment_count,
        'linked_children', v_linked_count,
        'unmatched_child_id_count', v_unmatched_count,
        'unmatched_child_ids', v_unmatched,
        'validation_error_rows', jsonb_array_length(v_validation_errors),
        'total_applied_rows', v_total_applied_count
    );

    UPDATE public.import_jobs
    SET
        status = v_status_result,
        processed_rows = v_total_applied_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{coach_finalize}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        v_result
    );

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.materialize_import_buddy_pairs(p_import_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    -- The session's TimeZone is pinned to UTC by this function's SET, so now() is the UTC instant
    -- (20261021040000's idiom, which new migrations hold to: no timezone('utc', now()) as a timestamp).
    v_now timestamptz := now();
    v_result jsonb;
    v_warning_count integer;
    v_season_settings_id uuid;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    -- The season the job imported into (20261108010000): the job's own, or for a job made
    -- before jobs carried one the organization's active season. A registration id names a
    -- player of that season only, so a pair never reaches a player of another season.
    SELECT s.id
    INTO v_season_settings_id
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
      AND (CASE WHEN v_job.season_settings_id IS NULL
                THEN s.status = 'active'
                ELSE s.id = v_job.season_settings_id END);

    WITH promoted_payloads AS MATERIALIZED (
        SELECT
            sp.id AS staging_id,
            sp.source_row_number,
            sp.organization_id,
            sp.normalized_payload,
            NULLIF(lower(public.import_payload_text(
                sp.normalized_payload,
                'external_registration_id', 'gotsport_id', 'registration_id', 'player_id'
            )), '') AS external_key,
            NULLIF(lower(public.import_payload_text(
                sp.normalized_payload,
                'buddy_request', 'buddy_id', 'buddy_external_registration_id',
                'buddy_registration_id', 'friend_request'
            )), '') AS buddy_request_key,
            NULLIF(lower(public.import_payload_text(
                sp.normalized_payload,
                'mutual_buddy_code', 'buddy_code', 'friend_code'
            )), '') AS mutual_code_key
        FROM public.staging_players sp
        WHERE sp.import_job_id = p_import_job_id
          AND sp.organization_id = v_job.organization_id
          AND sp.promoted_at IS NOT NULL
          AND sp.normalized_payload IS NOT NULL
    ),
    matched_sources AS MATERIALIZED (
        SELECT DISTINCT ON (p.id)
            pp.staging_id,
            pp.source_row_number,
            pp.external_key,
            pp.buddy_request_key,
            pp.mutual_code_key,
            p.id AS player_id,
            p.division_id
        FROM promoted_payloads pp
        JOIN public.players p
          ON p.organization_id = pp.organization_id
         AND p.season_settings_id = v_season_settings_id
         AND lower(p.external_registration_id) = pp.external_key
        WHERE pp.external_key IS NOT NULL
          AND (pp.buddy_request_key IS NOT NULL OR pp.mutual_code_key IS NOT NULL)
        ORDER BY p.id, pp.source_row_number NULLS LAST, pp.staging_id
    ),
    request_matches AS MATERIALIZED (
        SELECT
            source.player_id,
            source.division_id,
            source.external_key,
            source.buddy_request_key,
            buddy.player_id AS buddy_player_id,
            buddy.division_id AS buddy_division_id,
            buddy.buddy_request_key AS reciprocal_request_key
        FROM matched_sources source
        LEFT JOIN matched_sources buddy
          ON buddy.external_key = source.buddy_request_key
        WHERE source.buddy_request_key IS NOT NULL
    ),
    request_candidate_pairs AS MATERIALIZED (
        SELECT DISTINCT
            LEAST(player_id, buddy_player_id) AS player_a_id,
            GREATEST(player_id, buddy_player_id) AS player_b_id
        FROM request_matches
        WHERE buddy_player_id IS NOT NULL
          AND player_id <> buddy_player_id
          AND reciprocal_request_key = external_key
          AND division_id IS NOT DISTINCT FROM buddy_division_id
    ),
    code_group_players AS MATERIALIZED (
        SELECT
            mutual_code_key,
            player_id,
            division_id,
            min(source_row_number) AS source_row_number
        FROM matched_sources
        WHERE mutual_code_key IS NOT NULL
        GROUP BY mutual_code_key, player_id, division_id
    ),
    code_groups AS MATERIALIZED (
        SELECT
            mutual_code_key,
            array_agg(player_id ORDER BY source_row_number NULLS LAST, player_id) AS player_ids,
            count(*) AS player_count,
            count(DISTINCT division_id) FILTER (WHERE division_id IS NOT NULL) AS division_count,
            count(*) FILTER (WHERE division_id IS NULL) AS null_division_count
        FROM code_group_players
        GROUP BY mutual_code_key
    ),
    code_candidate_pairs AS MATERIALIZED (
        SELECT DISTINCT
            LEAST(player_ids[1], player_ids[2]) AS player_a_id,
            GREATEST(player_ids[1], player_ids[2]) AS player_b_id
        FROM code_groups
        WHERE player_count = 2
          AND (
              (division_count = 1 AND null_division_count = 0)
              OR (division_count = 0 AND null_division_count = 2)
          )
    ),
    candidate_pairs AS MATERIALIZED (
        SELECT player_a_id, player_b_id FROM request_candidate_pairs
        UNION
        SELECT player_a_id, player_b_id FROM code_candidate_pairs
    ),
    directional_pairs AS MATERIALIZED (
        SELECT player_a_id AS player_id, player_b_id AS buddy_player_id
        FROM candidate_pairs
        UNION ALL
        SELECT player_b_id AS player_id, player_a_id AS buddy_player_id
        FROM candidate_pairs
    ),
    inserted AS (
        INSERT INTO public.player_buddies (
            player_id,
            buddy_player_id,
            organization_id,
            source_import_job,
            is_mutual
        )
        SELECT
            dp.player_id,
            dp.buddy_player_id,
            v_job.organization_id,
            p_import_job_id,
            true
        FROM directional_pairs dp
        ON CONFLICT (player_id, buddy_player_id) DO NOTHING
        RETURNING player_id, buddy_player_id
    ),
    counts_base AS (
        SELECT
            (SELECT count(*) FROM promoted_payloads) AS promoted_rows,
            (SELECT count(*) FROM matched_sources) AS requested_rows,
            (SELECT count(*) FROM promoted_payloads
              WHERE (buddy_request_key IS NOT NULL OR mutual_code_key IS NOT NULL)
                AND external_key IS NULL) AS missing_external_id_rows,
            (SELECT count(*) FROM promoted_payloads pp
              WHERE pp.external_key IS NOT NULL
                AND (pp.buddy_request_key IS NOT NULL OR pp.mutual_code_key IS NOT NULL)
                AND NOT EXISTS (
                    SELECT 1
                    FROM matched_sources ms
                    WHERE ms.external_key = pp.external_key
                )) AS unmatched_promoted_rows,
            (SELECT count(*) FROM request_matches
              WHERE buddy_player_id IS NULL) AS unmatched_request_rows,
            (SELECT count(*) FROM request_matches
              WHERE buddy_player_id = player_id) AS self_request_rows,
            (SELECT count(*) FROM request_matches
              WHERE buddy_player_id IS NOT NULL
                AND buddy_player_id <> player_id
                AND reciprocal_request_key IS DISTINCT FROM external_key) AS nonreciprocal_request_rows,
            (SELECT count(*) FROM request_matches
              WHERE buddy_player_id IS NOT NULL
                AND buddy_player_id <> player_id
                AND reciprocal_request_key = external_key
                AND division_id IS DISTINCT FROM buddy_division_id) AS cross_division_request_rows,
            (SELECT count(*) FROM code_groups
              WHERE NOT (
                  player_count = 2
                  AND (
                      (division_count = 1 AND null_division_count = 0)
                      OR (division_count = 0 AND null_division_count = 2)
                  )
              )) AS invalid_code_groups,
            (SELECT count(*) FROM candidate_pairs) AS materialized_pairs,
            (SELECT count(*) FROM directional_pairs) AS candidate_relationships,
            (SELECT count(*) FROM inserted) AS inserted_relationships
    ),
    counts AS (
        SELECT
            counts_base.*,
            (
                missing_external_id_rows
                + unmatched_promoted_rows
                + unmatched_request_rows
                + self_request_rows
                + nonreciprocal_request_rows
                + cross_division_request_rows
                + invalid_code_groups
            ) AS total_warnings
        FROM counts_base
    )
    SELECT jsonb_build_object(
        'status',
            CASE WHEN total_warnings > 0 THEN 'completed_with_warnings' ELSE 'completed' END,
        'promoted_rows', promoted_rows,
        'requested_rows', requested_rows,
        'materialized_pairs', materialized_pairs,
        'candidate_relationships', candidate_relationships,
        'inserted_relationships', inserted_relationships,
        'existing_relationships', candidate_relationships - inserted_relationships,
        'missing_external_id_rows', missing_external_id_rows,
        'unmatched_promoted_rows', unmatched_promoted_rows,
        'unmatched_request_rows', unmatched_request_rows,
        'self_request_rows', self_request_rows,
        'nonreciprocal_request_rows', nonreciprocal_request_rows,
        'cross_division_request_rows', cross_division_request_rows,
        'invalid_code_groups', invalid_code_groups
    ),
    total_warnings
    INTO v_result, v_warning_count
    FROM counts;

    UPDATE public.import_jobs
    SET
        status = CASE
            WHEN v_warning_count > 0 THEN 'completed_with_warnings'
            ELSE status
        END,
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{buddy_pairs}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        v_result || jsonb_build_object('stage', 'buddy_pairs', 'processed_at', v_now)
    );

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_season uuid;
BEGIN
    -- A player's division and team are in the player's own season (20261108010000). The
    -- trigger on players refuses the same write whoever makes it; this names the cause first.
    -- A player who does not exist has nothing to check (the UPDATE below writes no row).
    SELECT p.season_settings_id INTO v_season FROM public.players p WHERE p.id = p_player_id;
    IF FOUND THEN
        IF p_sanitized ? 'division_id' AND p_sanitized->>'division_id' IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.divisions d
                            WHERE d.id = (p_sanitized->>'division_id')::uuid
                              AND d.season_settings_id = v_season) THEN
            RAISE EXCEPTION 'division % is not in the player''s season', p_sanitized->>'division_id'
                USING ERRCODE = '22023', DETAIL = 'season_mismatch';
        END IF;
        IF p_sanitized ? 'team_id' AND p_sanitized->>'team_id' IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.teams t
                             JOIN public.divisions d ON d.id = t.division_id
                            WHERE t.id = (p_sanitized->>'team_id')::uuid
                              AND d.season_settings_id = v_season) THEN
            RAISE EXCEPTION 'team % is not in the player''s season', p_sanitized->>'team_id'
                USING ERRCODE = '22023', DETAIL = 'season_mismatch';
        END IF;
    END IF;

    UPDATE public.players p
    SET
        first_name      = COALESCE(CASE WHEN p_sanitized ? 'first_name' THEN p_sanitized->>'first_name' END, p.first_name),
        last_name       = COALESCE(CASE WHEN p_sanitized ? 'last_name' THEN p_sanitized->>'last_name' END, p.last_name),
        preferred_name  = CASE WHEN p_sanitized ? 'preferred_name' THEN p_sanitized->>'preferred_name' ELSE p.preferred_name END,
        gender          = CASE WHEN p_sanitized ? 'gender' THEN p_sanitized->>'gender' ELSE p.gender END,
        grade           = CASE WHEN p_sanitized ? 'grade' THEN p_sanitized->>'grade' ELSE p.grade END,
        notes           = CASE WHEN p_sanitized ? 'notes' THEN p_sanitized->>'notes' ELSE p.notes END,
        buddy_request   = CASE WHEN p_sanitized ? 'buddy_request' THEN p_sanitized->>'buddy_request' ELSE p.buddy_request END,
        status          = CASE WHEN p_sanitized ? 'status' THEN p_sanitized->>'status' ELSE p.status END,
        rating          = CASE WHEN p_sanitized ? 'rating' THEN (p_sanitized->>'rating')::smallint ELSE p.rating END,
        years_played    = CASE WHEN p_sanitized ? 'years_played' THEN (p_sanitized->>'years_played')::smallint ELSE p.years_played END,
        jersey_number   = CASE WHEN p_sanitized ? 'jersey_number' THEN (p_sanitized->>'jersey_number')::smallint ELSE p.jersey_number END,
        willing_to_coach = COALESCE(CASE WHEN p_sanitized ? 'willing_to_coach' THEN (p_sanitized->>'willing_to_coach')::boolean END, p.willing_to_coach),
        play_up_requested = COALESCE(CASE WHEN p_sanitized ? 'play_up_requested' THEN (p_sanitized->>'play_up_requested')::boolean END, p.play_up_requested),
        division_id     = CASE WHEN p_sanitized ? 'division_id' THEN (p_sanitized->>'division_id')::uuid ELSE p.division_id END,
        team_id         = CASE WHEN p_sanitized ? 'team_id' THEN (p_sanitized->>'team_id')::uuid ELSE p.team_id END,
        updated_at      = now()
    WHERE p.id = p_player_id;

    -- team_players is the relational source of truth for rosters (portals,
    -- summaries, scheduler filters read it). Keep it in sync whenever the
    -- denormalized players.team_id is patched, so Team Builder moves are
    -- visible everywhere.
    IF p_sanitized ? 'team_id' THEN
        DELETE FROM public.team_players tp WHERE tp.player_id = p_player_id;
        IF p_sanitized->>'team_id' IS NOT NULL THEN
            INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
            SELECT (p_sanitized->>'team_id')::uuid, p.id, p.organization_id, 'player', 'manual'
            FROM public.players p
            WHERE p.id = p_player_id
            ON CONFLICT (team_id, player_id) DO NOTHING;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_demo_session()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
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

    -- 20261101020000: the league's programs, which span divisions (Minis is U4, Micro U5-U6,
    -- Junior U7-U8, Select U14-U19; U9, U10 and U12 stay in the season's default program). The
    -- season's default program exists already (a trigger on season_settings made it).
    INSERT INTO public.programs (organization_id, season_settings_id, name)
    SELECT v_org, v_season, p.program_name
      FROM (SELECT DISTINCT dp.program_name FROM demo_seed.division_programs dp) p;
    UPDATE public.divisions dv
       SET program_id = pr.id
      FROM demo_seed.division_programs dp
      JOIN public.programs pr ON pr.season_settings_id = v_season AND pr.name = dp.program_name
     WHERE dv.season_settings_id = v_season AND dv.name = dp.division_key;

    INSERT INTO public.teams (organization_id, division_id, name)
    SELECT v_org, dv.id, t.name
      FROM demo_seed.teams t
      JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = t.division_key;

    -- `coaches.email` is unique across organizations: each copy's addresses carry its own tag.
    INSERT INTO public.coaches (organization_id, season_settings_id, full_name, email, status)
    SELECT v_org, v_season, c.full_name,
           replace(c.email, '@', '+' || substr(replace(v_org::text, '-', ''), 1, 12) || '@'), c.status
      FROM demo_seed.coaches c;

    INSERT INTO public.players (organization_id, season_settings_id, division_id, team_id, first_name,
                                last_name, external_registration_id, gender, status, years_played,
                                willing_to_coach, play_up_requested, buddy_request, natural_age)
    SELECT v_org, v_season, t.division_id, t.id, p.first_name, p.last_name, p.external_registration_id,
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
$function$;

-- admin_create_player takes the season, as create_import_job does (20261101010000): the old
-- signature is dropped by its exact name and signature (no CASCADE) and the new one created, so
-- every call by name (the app, a cached browser mid-deploy) still resolves.
DROP FUNCTION public.admin_create_player(uuid, jsonb);

CREATE FUNCTION public.admin_create_player(p_organization_id uuid, p_fields jsonb DEFAULT '{}'::jsonb, p_season_settings_id uuid DEFAULT NULL::uuid)
 RETURNS players
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_player public.players%ROWTYPE;
    v_sanitized jsonb;
    v_season uuid;
    v_season_status text;
BEGIN
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    -- 20261108010000: a player belongs to one season. None named is the organization's active
    -- season; a named one must be this organization's and not completed.
    IF p_season_settings_id IS NULL THEN
        SELECT s.id INTO v_season
          FROM public.season_settings s
         WHERE s.organization_id = p_organization_id AND s.status = 'active';
        IF v_season IS NULL THEN
            RAISE EXCEPTION 'Organization % has no active season to add a player to', p_organization_id
                USING ERRCODE = '22023', DETAIL = 'season_missing';
        END IF;
    ELSE
        SELECT s.id, s.status INTO v_season, v_season_status
          FROM public.season_settings s
         WHERE s.id = p_season_settings_id AND s.organization_id = p_organization_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'season % does not belong to organization %', p_season_settings_id, p_organization_id
                USING ERRCODE = '42501';
        END IF;
        IF v_season_status = 'completed' THEN
            RAISE EXCEPTION 'season % is completed and takes no new player', p_season_settings_id
                USING ERRCODE = '22023', DETAIL = 'season_completed';
        END IF;
    END IF;

    v_sanitized := public.sanitize_player_patch(
        COALESCE(p_fields, '{}'::jsonb)
            || jsonb_build_object(
                'first_name', COALESCE(p_fields->>'first_name', 'New'),
                'last_name', COALESCE(p_fields->>'last_name', 'Player')
            )
    );

    INSERT INTO public.players (organization_id, season_settings_id, first_name, last_name, status)
    VALUES (
        p_organization_id,
        v_season,
        v_sanitized->>'first_name',
        v_sanitized->>'last_name',
        COALESCE(v_sanitized->>'status', 'pending')
    )
    RETURNING * INTO v_player;

    PERFORM public.apply_player_patch(v_player.id, v_sanitized);

    PERFORM public.record_audit_event(
        p_organization_id,
        'player.created',
        'players',
        v_player.id,
        jsonb_build_object('fields', v_sanitized, 'season_settings_id', v_season)
    );

    SELECT * INTO v_player FROM public.players WHERE id = v_player.id;
    RETURN v_player;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_create_player(uuid, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_player(uuid, jsonb, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_create_player(uuid, jsonb, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. view_org_metrics, per season.
-- ---------------------------------------------------------------------------
--
-- One row per season of an organization (one row, season NULL, for an organization with none),
-- with the season's player and team counts and the organization's user count. Appended last, so
-- CREATE OR REPLACE stays valid over the existing view (the same as view_league_standings'
-- `season_settings_id`, 20261023010000). Its one reader, the Reports page, asks for the season
-- the header shows. security_invoker and the grants are unchanged.

CREATE OR REPLACE VIEW public.view_org_metrics
WITH (security_invoker = true)
AS
SELECT
    o.id AS organization_id,
    o.name AS organization_name,
    (SELECT COUNT(p.id) FROM public.players p
      WHERE p.organization_id = o.id AND p.season_settings_id IS NOT DISTINCT FROM s.id) AS total_players,
    (SELECT COUNT(t.id) FROM public.teams t
       JOIN public.divisions d ON d.id = t.division_id
      WHERE t.organization_id = o.id AND d.season_settings_id IS NOT DISTINCT FROM s.id) AS total_teams,
    (SELECT COUNT(om.profile_id) FROM public.organization_members om WHERE om.organization_id = o.id) AS total_users,
    s.id AS season_settings_id
FROM public.organizations o
LEFT JOIN public.season_settings s ON s.organization_id = o.id;

-- ---------------------------------------------------------------------------
-- 7. End state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_bad text;
BEGIN
    SELECT string_agg(t.tbl, ', ') INTO v_bad
      FROM (VALUES ('players'), ('coaches')) AS t(tbl)
     WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = ('public.' || t.tbl)::regclass AND a.attname = 'season_settings_id'
                          AND a.attnotnull AND NOT a.attisdropped);
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'season_settings_id is missing or nullable on %', v_bad;
    END IF;

    SELECT string_agg(i.name, ', ') INTO v_bad
      FROM (VALUES ('players_season_external_registration_id_key'), ('coaches_organization_season_email_key'),
                   ('idx_players_season_settings_id'), ('idx_coaches_season_settings_id')) AS i(name)
     WHERE to_regclass('public.' || i.name) IS NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'missing index(es) %', v_bad;
    END IF;
    IF to_regclass('public.idx_players_org_external_registration_id') IS NOT NULL
       OR EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.coaches'::regclass AND conname = 'coaches_organization_id_email_key') THEN
        RAISE EXCEPTION 'an organization-wide key survived';
    END IF;

    -- Every trigger of this migration, and every one it switched off for the backfill, is on.
    SELECT string_agg(t.name, ', ') INTO v_bad
      FROM (VALUES ('players_enforce_season'), ('coaches_enforce_season'), ('player_buddies_same_season'),
                   ('team_players_same_season'), ('team_coach_assignments_same_season'),
                   ('teams_coaches_same_season'), ('coach_team_requests_same_season'),
                   ('demo_fence_players'), ('players_set_timestamp'), ('tr_validate_player_attributes'),
                   ('demo_fence_coaches'), ('coaches_set_timestamp'), ('tr_validate_coach_attributes')) AS t(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                        WHERE g.tgname = t.name AND NOT g.tgisinternal AND g.tgenabled = 'O');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'trigger(s) missing or not enabled: %', v_bad;
    END IF;

    -- Each replaced body reads the season.
    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('finalize_import_job(uuid,jsonb)'), ('finalize_coach_import_job(uuid,jsonb)'),
                   ('materialize_import_buddy_pairs(uuid)'), ('apply_player_patch(uuid,jsonb)'),
                   ('admin_create_player(uuid,jsonb,uuid)'), ('start_demo_session()')) AS f(sig)
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc p
                        WHERE p.oid = to_regprocedure('public.' || f.sig)
                          AND p.prosrc LIKE '%season_settings_id%');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'body(ies) not replaced: %', v_bad;
    END IF;
    IF to_regprocedure('public.admin_create_player(uuid,jsonb)') IS NOT NULL THEN
        RAISE EXCEPTION 'the two-argument admin_create_player survived';
    END IF;

    IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = 'public.view_org_metrics'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM ARRAY['organization_id', 'organization_name', 'total_players', 'total_teams',
                              'total_users', 'season_settings_id'] THEN
        RAISE EXCEPTION 'view_org_metrics has the wrong columns';
    END IF;
END;
$$;

COMMIT;
