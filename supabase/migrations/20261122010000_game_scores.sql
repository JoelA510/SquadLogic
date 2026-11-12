-- A game's score lives in its own table, a scored game is held, and standings are computed from scores (F11-2).
--
-- Plan of record: docs/changes/2026-11-06-games-table-source-of-truth.md, "The score record (F11-2)", task B1 (the owner
-- approved it on 2026-11-07, decisions D1 to D10 as recommended). AGENTS.md rule 14 applies (persistence and the domain
-- model): this change is the plan's migration for it. Nothing in the solver changes. The readers of the legacy `games`
-- table are repointed by F11-3, not here.
--
-- ## What this adds
--
--   * `game_scores`: one row per SCORED game, keyed by the saved game's id (`game_assignments.id`, the game's id for its
--     whole life since 20261120010000). Both scores are required: a row exists exactly when the game is scored, and
--     clearing deletes it (D10). One foreign key from (game_id, organization_id, home_team_id, away_team_id) to the saved
--     game and its sides, NO ACTION on delete and on update: no writer can delete a scored game or change its sides
--     without dealing with the score first, whatever it remembers to check. NO ACTION and not RESTRICT, so the cascade of
--     a deleted organization (which removes the scores in the same statement) passes. Members read; there is no write
--     policy and no write grant: `update_game_score` is the only writer. The completed-season trigger covers it.
--   * `game_held_ids` gains "or has a score": THE ONE PREDICATE is now "Published or scored", and the guard trigger, the
--     cancel, the save's omission check, the import's apply and the page's pin set follow because they ask it.
--     `game_hold_code(uuid)` (internal) gives the words for a held game: `game_published` or `game_scored`. It asks the
--     predicate first; it never decides whether a game is held.
--   * `game_scored` and `game_scored_omitted`: the refusals of a game held by its score, beside `game_published` and
--     `game_published_omitted` (the Edge function maps all four to the same 409).
--   * `view_league_standings` rebuilt over `teams` and `game_scores`: the same columns in the same order, and one more,
--     last (`results_not_counted`). A row for every own team (an outside club, `teams.is_external`, never has one); a
--     result against an outside club counts for the own team only when `standings_counts_outside(division)` says so
--     (a definer that reads the one setting for a member of the division's organization, because the view runs as its
--     reader and `org_flag` is closed to client roles; today: the organization's `standings_count_outside_results` setting, off unless turned on; the settings cascade
--     of F11-4 replaces that one body); a fixture of two outside clubs counts for nobody.
--   * `current_game_runs` (security invoker): per organization and season, the latest completed game run. The single SQL
--     definition of "the schedule" for the readers F11-3 repoints; it is `useSchedulerRun`'s rule.
--   * `copy_legacy_game_scores()` (internal; no client role may call it): copies a score of the legacy `games` table to
--     the saved game that matches it by home, away and slot, when exactly one does, and REFUSES (55000,
--     legacy_score_unmatched) when a scored legacy row matches none or several. This migration calls it once. Production
--     holds no `games` row (the F11 plan's receipt F-R8, a read of 2026-11-06, NOT re-read by this change), so there it
--     copies nothing; if a scored row exists that it cannot place, the migration stops and nothing is applied.
--
-- ## What this replaces, and the cost said plainly
--
-- Ten functions are replaced WHOLE (a migration cannot patch a function), each copied from the migration that defines
-- it last and behind the md5 of that text, so a body this migration has not seen refuses to be replaced (lesson 87):
-- `game_held_ids`, the guard trigger function, `persist_game_schedule`, `admin_cancel_game_assignment`,
-- `admin_delete_team`, `update_game_score`, `apply_game_import_job`, `rollback_game_import_job`,
-- `cancel_ready_import_job` and `get_schedule_tbd`. The plants that aimed at the old bodies are re-aimed in
-- scripts/dbharness/prove.sh (lesson 70). What changed in each is said above its copy, and marked `20261122010000` in
-- the body.
--
-- Three small changes ride along because their functions are replaced here anyway (the schedule-expansion plan, PR 6's
-- "for the next migration" notes): `cancel_ready_import_job` refuses a job that is not `ready_to_apply` (it marked an
-- APPLIED job failed and took its roll back away); `get_schedule_tbd` returns `game_date` and `external_ref`; the
-- apply's staged-flag list takes `bad-time` and `bad-week` so the two warnings reach the saved result. The preview-stale
-- check inside `apply_game_import_job` is NOT here (a change of signature; it stays recorded in that plan).
--
-- `update_game_score` keeps its name, arguments, result keys, authorization and audit action. What a caller sees
-- change: the id it passes names a saved game (a legacy `games` id is "not found"); one score without the other is
-- refused (22023, score_one_sided); a score is SET only on a game of its season's current run (22023, game_not_current:
-- a score on a game left in an older run would hold a game no screen shows); and a CLEAR is allowed whatever the
-- `score_entry` setting says (entering stays gated), so turning the setting off cannot leave games held. The Scores
-- page still lists the legacy table until F11-3 repoints it.
--
-- Reversible: docs/sql/20261122010000_revert.sql (it refuses while `game_scores` holds a row: a revert never discards a
-- recorded score). Smoke: docs/sql/20261122010000_smoke.sql. pgTAP: supabase/tests/game_scores.sql (CI's).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration replaces are the ones it was written against.
-- ---------------------------------------------------------------------------

DO $guard$
DECLARE
    v_spec record;
    v_md5 text;
BEGIN
    -- Carriage returns stripped, as the other guards do: the text is what matters.
    FOR v_spec IN
        SELECT * FROM (VALUES
            ('public.game_held_ids(uuid[])', '3fba2e17e088e26fbd244f5faf9512f2'),
            ('public.game_assignments_published_guard()', 'b062267c15857e0445fae400a48c4e95'),
            ('public.persist_game_schedule(jsonb, jsonb)', 'ba9883c95e97d4ff1b7ec8c480bc0aea'),
            ('public.admin_cancel_game_assignment(uuid)', '0224547476cf030a1a104b9bc21771d7'),
            ('public.admin_delete_team(uuid)', '434426caefc1b57e632915b5759210bc'),
            ('public.update_game_score(uuid, uuid, smallint, smallint, jsonb)', '645d8b408dc332795d6fa340dcb59643'),
            ('public.apply_game_import_job(uuid, boolean)', '8e3ff9246756dca66db9d0fd8e404ea6'),
            ('public.rollback_game_import_job(uuid)', 'a716509060f1c4eba8bde13dfccfb8c8'),
            ('public.cancel_ready_import_job(uuid, text)', '661ff9f0dce5af7d2f2e18e33560671f'),
            ('public.get_schedule_tbd(uuid)', '03bed361a3575bc2f6bb54ecdf5c1069')
        ) AS s(signature, expected_md5)
    LOOP
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure(v_spec.signature);
        IF v_md5 IS DISTINCT FROM v_spec.expected_md5 THEN
            RAISE EXCEPTION '% has a body this migration has not seen (md5 %): not replacing it',
                v_spec.signature, v_md5 USING ERRCODE = '55000';
        END IF;
    END LOOP;
    -- The view is replaced too. Its text is not compared (pg_get_viewdef's layout is the server's): what this migration
    -- needs of it is that it is the view over the legacy table with the fourteen columns it keeps.
    IF (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = 'public.view_league_standings'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
       IS DISTINCT FROM 'team_id,organization_id,team_name,division_id,games_played,wins,losses,draws,goals_for,goals_against,goal_differential,points,division,season_settings_id' THEN
        RAISE EXCEPTION 'view_league_standings does not have the columns this migration keeps: not replacing it' USING ERRCODE = '55000';
    END IF;
END;
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The score record.
-- ---------------------------------------------------------------------------

CREATE TABLE public.game_scores (
    game_id uuid PRIMARY KEY,
    organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    home_team_id uuid NOT NULL,
    away_team_id uuid NOT NULL,
    score_home smallint NOT NULL CONSTRAINT game_scores_score_home_check CHECK (score_home >= 0),
    score_away smallint NOT NULL CONSTRAINT game_scores_score_away_check CHECK (score_away >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    -- The game AND its sides (game_assignments_id_org_teams_key, 20261120010000). NO ACTION both ways: a scored game is
    -- not deleted and its teams are not changed under the score by ANY writer. Not RESTRICT: an organization's cascade
    -- removes the scores in the same statement, and NO ACTION is checked after it.
    CONSTRAINT game_scores_game_fkey FOREIGN KEY (game_id, organization_id, home_team_id, away_team_id)
        REFERENCES public.game_assignments (id, organization_id, home_team_id, away_team_id)
        ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- The foreign keys are indexed (a delete of an organization or a user is not a sequential scan); the composite key is
-- reached through the primary key's game_id.
CREATE INDEX idx_game_scores_organization_id ON public.game_scores (organization_id);
CREATE INDEX idx_game_scores_updated_by ON public.game_scores (updated_by) WHERE updated_by IS NOT NULL;
CREATE INDEX idx_game_scores_home_team_id ON public.game_scores (home_team_id);
CREATE INDEX idx_game_scores_away_team_id ON public.game_scores (away_team_id);

COMMENT ON TABLE public.game_scores IS
    'The score of a saved game (game_assignments.id), one row per SCORED game: both scores are required and clearing deletes the row. Written only by update_game_score (no write policy, no write grant); read by members. A game with a row here is held where it is (game_held_ids). 20261122010000.';
COMMENT ON COLUMN public.game_scores.home_team_id IS
    'The home side as scored. Part of the foreign key to the saved game, so the game''s sides cannot change under its score.';

ALTER TABLE public.game_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "game_scores_select_member"
    ON public.game_scores FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id));

-- No INSERT, UPDATE or DELETE policy and no such grant: a client never writes the table (lesson 49).
REVOKE ALL ON public.game_scores FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.game_scores TO authenticated;
GRANT ALL ON public.game_scores TO service_role;

-- A completed season's scores are history (lesson 66): the existing function reads the season from home_team_id.
CREATE TRIGGER game_scores_readonly_when_completed
    BEFORE INSERT OR DELETE OR UPDATE ON public.game_scores
    FOR EACH ROW
    EXECUTE FUNCTION public.season_schedule_readonly_when_completed();

COMMENT ON TABLE public.games IS
    'LEGACY, kept and no longer written (F11 decision D9): no schedule save ever filled it, and since 20261122010000 a score is a row of game_scores keyed by the saved game (game_assignments). The pages that still read it are repointed by F11-3; F11-5 drops it on the owner''s word.';

-- ---------------------------------------------------------------------------
-- 2. The legacy copy: a score of the old table goes to the saved game that matches it, or the migration stops.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.copy_legacy_game_scores()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_scored integer;
    v_unmatched uuid[];
    v_copied integer;
BEGIN
    -- A legacy result is a row with BOTH scores (the old standings view counted nothing else; a one-sided entry was
    -- never a result and is not copied: it stays in the legacy table). It is matched only with a game of a season's
    -- CURRENT run (`current_game_runs`): a score on a game left in an older run would hold a game no screen shows, and
    -- every later save would be refused for leaving it out.
    WITH legacy AS (
        SELECT g.id,
               (SELECT count(*) FROM public.game_assignments ga
                 WHERE ga.organization_id = g.organization_id AND ga.home_team_id = g.home_team_id
                   AND ga.away_team_id = g.away_team_id AND ga.game_slot_id = g.game_slot_id
                   AND EXISTS (SELECT 1 FROM public.current_game_runs c
                                WHERE c.organization_id = ga.organization_id AND c.run_id = ga.run_id)) AS matches
          FROM public.games g
         WHERE g.score_home IS NOT NULL AND g.score_away IS NOT NULL
    )
    SELECT count(*), COALESCE(array_agg(l.id ORDER BY l.id) FILTER (WHERE l.matches <> 1), ARRAY[]::uuid[])
      INTO v_scored, v_unmatched
      FROM legacy l;
    IF cardinality(v_unmatched) > 0 THEN
        RAISE EXCEPTION '% scored row(s) of the legacy games table match no saved game, or more than one (by home, away and slot): nothing is copied', cardinality(v_unmatched)
            USING ERRCODE = '55000',
                  DETAIL = format('legacy_score_unmatched count=%s ids=%s', cardinality(v_unmatched), array_to_string(v_unmatched[1:50], ','));
    END IF;
    INSERT INTO public.game_scores (game_id, organization_id, home_team_id, away_team_id, score_home, score_away)
    SELECT ga.id, ga.organization_id, ga.home_team_id, ga.away_team_id, g.score_home, g.score_away
      FROM public.games g
      JOIN public.game_assignments ga
        ON ga.organization_id = g.organization_id AND ga.home_team_id = g.home_team_id
       AND ga.away_team_id = g.away_team_id AND ga.game_slot_id = g.game_slot_id
       AND EXISTS (SELECT 1 FROM public.current_game_runs c
                    WHERE c.organization_id = ga.organization_id AND c.run_id = ga.run_id)
     WHERE g.score_home IS NOT NULL AND g.score_away IS NOT NULL
    ON CONFLICT (game_id) DO NOTHING;
    GET DIAGNOSTICS v_copied = ROW_COUNT;
    RETURN jsonb_build_object('scored', v_scored, 'copied', v_copied, 'already', v_scored - v_copied);
END;
$$;

REVOKE ALL ON FUNCTION public.copy_legacy_game_scores() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.copy_legacy_game_scores() IS
    'Internal (no client role may call it): copies each result of the legacy games table (both scores set) to the saved game of a current run that matches it by organization, home, away and slot when exactly one does; refuses (55000, legacy_score_unmatched) when one matches none or several; a game already scored keeps its score. Called once by 20261122010000; dropped with the legacy table (F11-5).';

-- ---------------------------------------------------------------------------
-- 3. The one predicate: Published OR scored. Every path that asks follows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.game_held_ids(p_game_ids uuid[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT ga.id
      FROM public.game_assignments ga
     WHERE ga.id = ANY (p_game_ids)
       AND (ga.published
            -- 20261122010000 (F11-2): or it has a score. A row of game_scores exists exactly when the game is scored.
            OR EXISTS (SELECT 1 FROM public.game_scores gs WHERE gs.game_id = ga.id))
$$;

-- The words for a held game. It asks the one predicate first and only then says why, so it cannot disagree with it about
-- WHETHER a game is held: a held game that is Published is `game_published` (changes to it must be allowed before
-- anything else, whether or not it also has a score); a held game that is not Published is held by its score. A third
-- reason to hold a game is named here when `game_held_ids` gains it.

CREATE FUNCTION public.game_hold_code(p_game_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT CASE WHEN NOT public.game_is_held(p_game_id) THEN NULL
                WHEN (SELECT ga.published FROM public.game_assignments ga WHERE ga.id = p_game_id) THEN 'game_published'
                ELSE 'game_scored' END
$$;

REVOKE ALL ON FUNCTION public.game_hold_code(uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.game_hold_code(uuid) IS
    'Internal: why a game is held, for the words of a refusal: game_published, game_scored (held and not Published), or NULL when game_is_held says it is not held. Never decides whether a game is held. 20261122010000.';
COMMENT ON FUNCTION public.game_held_ids(uuid[]) IS
    'Internal: the ids, among those given, of games held where they are: Published, or scored (a row of game_scores) since 20261122010000. The one definition of "held": the guard trigger, cancel, delete team, the omission check of the game save and the games import ask it or game_is_held. 20261120010000.';

-- ---------------------------------------------------------------------------
-- 4. The guard trigger, copied whole from 20261121010000. Changed: a game held by its score says so (game_scored).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.game_assignments_published_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job text;
BEGIN
    -- A job with no signed-in user: the retention job, the demo purge, the service role.
    IF auth.uid() IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    -- 20261120010000: THE ONE PREDICATE. A row is guarded when `game_is_held` says it is, asked of the row as the
    -- statement found it (so clearing the flag and moving in one statement is still refused). The trigger used to
    -- fire only for rows already flagged Published, which a second reason to hold a game (a score, F11-2) could not
    -- change.
    IF NOT public.game_is_held(OLD.id) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    -- 20261121010000: THE ROLLBACK OF A GAMES IMPORT (plan 3.3 and 4.7). Imported games arrive Published, so taking an
    -- import back deletes held rows, and an updated one back is a move of a held row. `rollback_game_import_job` names its
    -- job in a transaction-local setting; the guard honours it ONLY for a row that job wrote, and only for exactly what
    -- the rollback does: delete a row the job inserted while it is as the apply left it, or put an updated row back to the
    -- image it had before the apply (while it is as the apply left it). Naming another job lifts nothing; neither does a
    -- row that has changed since (its refusal is the rollback's "changed since", which names the games), and neither does
    -- any other statement on the row: the exemption is a comparison with the stored application record, not a role.
    v_job := NULLIF(current_setting('squadlogic.import_rollback', true), '');
    IF v_job IS NOT NULL AND OLD.import_job_id IS NOT NULL AND OLD.import_job_id::text = v_job THEN
        IF TG_OP = 'DELETE' THEN
            IF EXISTS (SELECT 1 FROM public.import_application_records r
                        WHERE r.import_job_id = OLD.import_job_id AND r.import_type = 'games'
                          AND r.target_table = 'game_assignments' AND r.target_id = OLD.id
                          AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
                          AND public.game_import_image(to_jsonb(OLD)) = public.game_import_image(r.applied_payload)) THEN
                RETURN OLD;
            END IF;
        ELSIF EXISTS (SELECT 1 FROM public.import_application_records r
                       WHERE r.import_job_id = OLD.import_job_id AND r.import_type = 'games'
                         AND r.target_table = 'game_assignments' AND r.target_id = OLD.id
                         AND r.operation = 'updated' AND r.rolled_back_at IS NULL
                         AND public.game_import_image(to_jsonb(OLD)) = public.game_import_image(r.applied_payload)
                         AND public.game_import_image(to_jsonb(NEW)) = public.game_import_image(r.previous_payload)) THEN
            RETURN NEW;
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- The cascade of a deleted organization: the organization is already gone, so its games go with it.
        IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = OLD.organization_id) THEN
            RETURN OLD;
        END IF;
        -- 20261122010000: held by its score and not Published: the words and the code say so.
        IF public.game_hold_code(OLD.id) = 'game_scored' THEN
            RAISE EXCEPTION 'Game % has a score and cannot be deleted: clear its score first', OLD.id
                USING ERRCODE = '22023', DETAIL = 'game_scored';
        END IF;
        RAISE EXCEPTION 'Game % is Published and cannot be deleted: allow changes to it first', OLD.id
            USING ERRCODE = '22023', DETAIL = 'game_published';
    END IF;
    -- An UPDATE of a Published row: only a change to where, when or who plays is refused.
    IF (NEW.game_slot_id, NEW.slot_id, NEW.field_id, NEW.home_team_id, NEW.away_team_id, NEW.week_index, NEW.start, NEW."end")
       IS NOT DISTINCT FROM
       (OLD.game_slot_id, OLD.slot_id, OLD.field_id, OLD.home_team_id, OLD.away_team_id, OLD.week_index, OLD.start, OLD."end") THEN
        RETURN NEW;
    END IF;
    IF public.game_hold_code(OLD.id) = 'game_scored' THEN
        RAISE EXCEPTION 'Game % has a score and cannot be moved: clear its score first', OLD.id
            USING ERRCODE = '22023', DETAIL = 'game_scored';
    END IF;
    RAISE EXCEPTION 'Game % is Published and cannot be moved: allow changes to it first', OLD.id
        USING ERRCODE = '22023', DETAIL = 'game_published';
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The game save, copied whole from 20261120010000. Changed: the omission check names scored games (game_scored_omitted).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.persist_game_schedule(
    run_data jsonb,
    assignments jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $$
DECLARE
    v_run_id uuid;
    v_persisted_run_id uuid;
    v_org_id uuid;
    v_season_id uuid;
    v_season_settings_id uuid;
    v_season_org_id uuid;
    v_run_type text;
    v_status text;
    v_created_by uuid;
    v_started_at timestamptz;
    v_completed_at timestamptz;
    v_missing_home_count integer;
    v_missing_away_count integer;
    v_missing_slot_count integer;
    v_missing_week_count integer;
    v_missing_start_count integer;
    v_missing_end_count integer;
    v_same_team_count integer;
    v_invalid_time_count integer;
    v_invalid_source_count integer;
    v_invalid_week_count integer;
    v_missing_home_ref uuid;
    v_missing_away_ref uuid;
    v_missing_slot_ref uuid;
    v_missing_field_ref uuid;
    v_cross_home_ref uuid;
    v_cross_away_ref uuid;
    v_cross_slot_ref uuid;
    v_cross_field_ref uuid;
    -- 20261108020000: the TIME TBD list
    v_unscheduled jsonb;
    v_tbd_bad_shape integer;
    v_tbd_bad_teams integer;
    v_tbd_same_team integer;
    v_tbd_bad_reason integer;
    v_tbd_missing_team integer;
    v_tbd_other_org integer;
    v_tbd_other_season integer;
    v_tbd_games integer;
    -- 20261119010000: the Published games a save leaves out
    v_omitted_count integer;
    v_omitted_ids uuid[];
    -- 20261122010000: the scored games (not Published) a save leaves out
    v_scored_omitted_count integer;
    v_scored_omitted_ids uuid[];
    -- 20261120010000: IDENTITY (the payload as it will be stored; the games it names by id; a clash)
    v_resolved jsonb;
    v_bad_id text;
    v_dup_id uuid;
    v_missing_id uuid;
    v_named integer;
    v_locked integer;
    v_clash_first uuid;
    v_clash_second uuid;
    v_season_first uuid;
BEGIN
    IF run_data IS NULL OR jsonb_typeof(run_data) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'run_data must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF assignments IS NULL THEN
        assignments := '[]'::jsonb;
    END IF;

    IF jsonb_typeof(assignments) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'assignments must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    v_run_type := COALESCE(NULLIF(run_data->>'run_type', ''), 'game');
    IF v_run_type <> 'game' THEN
        RAISE EXCEPTION 'persist_game_schedule only accepts game runs'
            USING ERRCODE = '22023';
    END IF;

    v_status := COALESCE(NULLIF(run_data->>'status', ''), 'completed');
    IF v_status NOT IN (
        'queued',
        'running',
        'completed',
        'completed_with_warnings',
        'needs_manual_review',
        'failed'
    ) THEN
        RAISE EXCEPTION 'invalid scheduler run status: %', v_status
            USING ERRCODE = '22023';
    END IF;

    -- 20261018070000: the save writes its own audit row (below), and an audit
    -- row needs an actor, so a caller with no user -- the service role -- is
    -- refused before anything is read or written (plan Q2).
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'persist_game_schedule needs a signed-in caller to audit the save'
            USING ERRCODE = '42501';
    END IF;

    v_run_id := COALESCE(NULLIF(run_data->>'id', '')::uuid, gen_random_uuid());
    v_org_id := NULLIF(run_data->>'organization_id', '')::uuid;
    v_season_settings_id := NULLIF(run_data->>'season_settings_id', '')::uuid;
    v_season_id := COALESCE(NULLIF(run_data->>'season_id', '')::uuid, v_season_settings_id);

    -- 20261018070000: an organization admin, not any member (plan Q6), as
    -- persist_team_schedule and persist_practice_schedule require.
    IF v_org_id IS NOT NULL
       AND NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_settings_id IS NOT NULL
       AND v_season_id IS NOT NULL
       AND v_season_settings_id <> v_season_id THEN
        RAISE EXCEPTION 'season_id must match season_settings_id for game persistence'
            USING ERRCODE = '22023';
    END IF;

    IF v_season_id IS NOT NULL THEN
        SELECT ss.organization_id
          INTO v_season_org_id
          FROM public.season_settings ss
         WHERE ss.id = v_season_id;

        IF v_season_org_id IS NULL THEN
            RAISE EXCEPTION 'season_settings_id % does not exist', v_season_id
                USING ERRCODE = '23503';
        END IF;

        IF v_org_id IS NULL THEN
            v_org_id := v_season_org_id;
        ELSIF v_org_id <> v_season_org_id THEN
            RAISE EXCEPTION 'season_settings_id % does not belong to organization %',
                v_season_id, v_org_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'organization_id or season_settings_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- 20261119010000: SERIALIZED WITH THE SWITCH. The omission check below reads `published`, and
    -- admin_set_games_published locks only the rows it changes, which a save never touches when it leaves a game out:
    -- without a shared lock a publish and a save that omits that game could both commit, and the game would be
    -- Published and absent from the new run (reproduced with two sessions, Codex on #707). Both take this one lock,
    -- per organization, as their FIRST lock and hold it to the end of the transaction, so the second waits for the
    -- first and its next statement sees the first's commit (READ COMMITTED). Lock order everywhere: this advisory
    -- lock, then rows (the switch in id order, the save as its upsert goes). The guard trigger takes no lock, and
    -- cancel and delete team take none of this one: a publish racing them meets the trigger, which judges the
    -- latest committed row.
    PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org_id::text, 0));

    IF EXISTS (
        SELECT 1
          FROM public.scheduler_runs sr
         WHERE sr.id = v_run_id
           AND sr.organization_id <> v_org_id
    ) THEN
        RAISE EXCEPTION 'scheduler run % belongs to another organization', v_run_id
            USING ERRCODE = '42501';
    END IF;

    v_created_by := auth.uid();

    v_started_at := COALESCE(NULLIF(run_data->>'started_at', '')::timestamptz, now());
    v_completed_at := COALESCE(NULLIF(run_data->>'completed_at', '')::timestamptz, now());

    INSERT INTO public.scheduler_runs (
        id,
        organization_id,
        season_id,
        season_settings_id,
        run_type,
        status,
        parameters,
        metrics,
        results,
        created_by,
        started_at,
        completed_at
    )
    VALUES (
        v_run_id,
        v_org_id,
        v_season_id,
        v_season_settings_id,
        'game',
        v_status,
        COALESCE(run_data->'parameters', '{}'::jsonb),
        COALESCE(run_data->'metrics', '{}'::jsonb),
        COALESCE(run_data->'results', '{}'::jsonb),
        v_created_by,
        v_started_at,
        v_completed_at
    )
    ON CONFLICT (id) DO UPDATE SET
        season_id = EXCLUDED.season_id,
        season_settings_id = EXCLUDED.season_settings_id,
        status = EXCLUDED.status,
        parameters = EXCLUDED.parameters,
        metrics = EXCLUDED.metrics,
        results = EXCLUDED.results,
        completed_at = EXCLUDED.completed_at,
        updated_at = now()
    WHERE public.scheduler_runs.organization_id = EXCLUDED.organization_id
    RETURNING id INTO v_persisted_run_id;

    IF v_persisted_run_id IS NULL THEN
        RAISE EXCEPTION 'scheduler run % could not be persisted for organization %',
            v_run_id, v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(assignments) AS assignment_items(value)
         WHERE jsonb_typeof(assignment_items.value) IS DISTINCT FROM 'object'
    ) THEN
        RAISE EXCEPTION 'each assignment must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    -- 20261120010000: an assignment may name a saved game by `id`, and that id is a uuid. An absent id, a JSON null and
    -- an empty string are no id (as every other id in this payload reads them); anything else that is not a uuid is
    -- refused by name rather than by a cast error. The page's staged-game placeholders are not uuids and are never sent.
    SELECT left(e.value ->> 'id', 60)
      INTO v_bad_id
      FROM jsonb_array_elements(assignments) WITH ORDINALITY AS e(value, ord)
     WHERE e.value ? 'id'
       AND jsonb_typeof(e.value -> 'id') <> 'null'
       AND NOT (jsonb_typeof(e.value -> 'id') = 'string'
                AND (e.value ->> 'id' = ''
                     OR e.value ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     ORDER BY e.ord
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'assignment id "%" is not a game id (a uuid)', v_bad_id
            USING ERRCODE = '22023', DETAIL = 'game_identity_invalid';
    END IF;

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            COALESCE(
                NULLIF(value->>'home_team_id', '')::uuid,
                NULLIF(value->>'homeTeamId', '')::uuid
            ) AS home_team_id,
            COALESCE(
                NULLIF(value->>'away_team_id', '')::uuid,
                NULLIF(value->>'awayTeamId', '')::uuid
            ) AS away_team_id,
            COALESCE(
                NULLIF(value->>'game_slot_id', '')::uuid,
                NULLIF(value->>'gameSlotId', '')::uuid,
                NULLIF(value->>'slot_id', '')::uuid,
                NULLIF(value->>'slotId', '')::uuid
            ) AS game_slot_id,
            COALESCE(
                NULLIF(value->>'field_id', '')::uuid,
                NULLIF(value->>'fieldId', '')::uuid
            ) AS field_id,
            COALESCE(NULLIF(value->>'division', ''), NULLIF(value->>'division_name', '')) AS division,
            COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index,
            COALESCE(NULLIF(value->>'start', '')::timestamptz, NULLIF(value->>'kickoff', '')::timestamptz) AS start_at,
            NULLIF(value->>'end', '')::timestamptz AS end_at,
            CASE
                WHEN lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto'))
            END AS assignment_source
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    )
    SELECT
        count(*) FILTER (WHERE home_team_id IS NULL),
        count(*) FILTER (WHERE away_team_id IS NULL),
        count(*) FILTER (WHERE game_slot_id IS NULL),
        count(*) FILTER (WHERE week_index IS NULL),
        count(*) FILTER (WHERE start_at IS NULL),
        count(*) FILTER (WHERE end_at IS NULL),
        count(*) FILTER (WHERE home_team_id = away_team_id),
        count(*) FILTER (WHERE end_at <= start_at),
        count(*) FILTER (WHERE assignment_source NOT IN ('auto', 'manual')),
        count(*) FILTER (WHERE week_index IS NOT NULL AND week_index <= 0)
      INTO
        v_missing_home_count,
        v_missing_away_count,
        v_missing_slot_count,
        v_missing_week_count,
        v_missing_start_count,
        v_missing_end_count,
        v_same_team_count,
        v_invalid_time_count,
        v_invalid_source_count,
        v_invalid_week_count
      FROM parsed_assignments;

    IF v_missing_home_count > 0 THEN
        RAISE EXCEPTION 'assignment home_team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_away_count > 0 THEN
        RAISE EXCEPTION 'assignment away_team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_slot_count > 0 THEN
        RAISE EXCEPTION 'assignment game_slot_id or slot_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_week_count > 0 THEN
        RAISE EXCEPTION 'assignment week_index is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_start_count > 0 OR v_missing_end_count > 0 THEN
        RAISE EXCEPTION 'assignment start and end are required'
            USING ERRCODE = '23502';
    END IF;

    IF v_same_team_count > 0 THEN
        RAISE EXCEPTION 'home_team_id and away_team_id must differ'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_time_count > 0 THEN
        RAISE EXCEPTION 'assignment end must be after start'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_source_count > 0 THEN
        RAISE EXCEPTION 'invalid game assignment source'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_week_count > 0 THEN
        RAISE EXCEPTION 'assignment week_index must be positive'
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            COALESCE(
                NULLIF(value->>'home_team_id', '')::uuid,
                NULLIF(value->>'homeTeamId', '')::uuid
            ) AS home_team_id,
            COALESCE(
                NULLIF(value->>'away_team_id', '')::uuid,
                NULLIF(value->>'awayTeamId', '')::uuid
            ) AS away_team_id,
            COALESCE(
                NULLIF(value->>'game_slot_id', '')::uuid,
                NULLIF(value->>'gameSlotId', '')::uuid,
                NULLIF(value->>'slot_id', '')::uuid,
                NULLIF(value->>'slotId', '')::uuid
            ) AS game_slot_id,
            COALESCE(
                NULLIF(value->>'field_id', '')::uuid,
                NULLIF(value->>'fieldId', '')::uuid
            ) AS field_id
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    ),
    validated_assignments AS (
        SELECT
            parsed_assignments.home_team_id,
            parsed_assignments.away_team_id,
            parsed_assignments.game_slot_id,
            parsed_assignments.field_id,
            home_team.id AS existing_home_team_id,
            home_team.organization_id AS home_team_org_id,
            away_team.id AS existing_away_team_id,
            away_team.organization_id AS away_team_org_id,
            game_slot.id AS existing_slot_id,
            game_slot.organization_id AS slot_org_id,
            requested_field.id AS existing_field_id,
            requested_field.organization_id AS field_org_id
        FROM parsed_assignments
        LEFT JOIN public.teams home_team
          ON home_team.id = parsed_assignments.home_team_id
        LEFT JOIN public.teams away_team
          ON away_team.id = parsed_assignments.away_team_id
        LEFT JOIN public.game_slots game_slot
          ON game_slot.id = parsed_assignments.game_slot_id
        LEFT JOIN public.fields requested_field
          ON requested_field.id = parsed_assignments.field_id
    )
    SELECT
        (SELECT home_team_id FROM validated_assignments WHERE existing_home_team_id IS NULL LIMIT 1),
        (SELECT away_team_id FROM validated_assignments WHERE existing_away_team_id IS NULL LIMIT 1),
        (SELECT game_slot_id FROM validated_assignments WHERE existing_slot_id IS NULL LIMIT 1),
        (SELECT field_id FROM validated_assignments WHERE field_id IS NOT NULL AND existing_field_id IS NULL LIMIT 1),
        (SELECT home_team_id FROM validated_assignments WHERE home_team_org_id <> v_org_id LIMIT 1),
        (SELECT away_team_id FROM validated_assignments WHERE away_team_org_id <> v_org_id LIMIT 1),
        (SELECT game_slot_id FROM validated_assignments WHERE slot_org_id <> v_org_id LIMIT 1),
        (SELECT field_id FROM validated_assignments WHERE field_id IS NOT NULL AND field_org_id <> v_org_id LIMIT 1)
      INTO
        v_missing_home_ref,
        v_missing_away_ref,
        v_missing_slot_ref,
        v_missing_field_ref,
        v_cross_home_ref,
        v_cross_away_ref,
        v_cross_slot_ref,
        v_cross_field_ref;

    IF v_missing_home_ref IS NOT NULL THEN
        RAISE EXCEPTION 'home team % does not exist', v_missing_home_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_missing_away_ref IS NOT NULL THEN
        RAISE EXCEPTION 'away team % does not exist', v_missing_away_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_missing_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'game slot % does not exist', v_missing_slot_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_missing_field_ref IS NOT NULL THEN
        RAISE EXCEPTION 'field % does not exist', v_missing_field_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_home_ref IS NOT NULL THEN
        RAISE EXCEPTION 'home team % belongs to another organization', v_cross_home_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_cross_away_ref IS NOT NULL THEN
        RAISE EXCEPTION 'away team % belongs to another organization', v_cross_away_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_cross_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'game slot % belongs to another organization', v_cross_slot_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_cross_field_ref IS NOT NULL THEN
        RAISE EXCEPTION 'field % belongs to another organization', v_cross_field_ref
            USING ERRCODE = '42501';
    END IF;

    -- 20261120010000: THE PAYLOAD AS IT WILL BE STORED, resolved once. Each assignment becomes the row a save writes
    -- (its organization and run, its slot's field when it names none, its division label, its source), as the
    -- insert below used to resolve it in place; the identity checks, the in-place update and the upsert all read this
    -- one list, so they cannot disagree about what a row is. `id` is the saved game the assignment continues, or NULL.
    SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.assignment_ordinal), '[]'::jsonb)
      INTO v_resolved
      FROM (
            WITH parsed_assignments AS MATERIALIZED (
                SELECT
                    assignment_items.ordinality AS assignment_ordinal,
                    NULLIF(value->>'id', '')::uuid AS id,
                    COALESCE(
                        NULLIF(value->>'home_team_id', '')::uuid,
                        NULLIF(value->>'homeTeamId', '')::uuid
                    ) AS home_team_id,
                    COALESCE(
                        NULLIF(value->>'away_team_id', '')::uuid,
                        NULLIF(value->>'awayTeamId', '')::uuid
                    ) AS away_team_id,
                    COALESCE(
                        NULLIF(value->>'game_slot_id', '')::uuid,
                        NULLIF(value->>'gameSlotId', '')::uuid,
                        NULLIF(value->>'slot_id', '')::uuid,
                        NULLIF(value->>'slotId', '')::uuid
                    ) AS game_slot_id,
                    COALESCE(
                        NULLIF(value->>'field_id', '')::uuid,
                        NULLIF(value->>'fieldId', '')::uuid
                    ) AS field_id,
                    COALESCE(NULLIF(value->>'division', ''), NULLIF(value->>'division_name', '')) AS division,
                    COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index,
                    COALESCE(NULLIF(value->>'start', '')::timestamptz, NULLIF(value->>'kickoff', '')::timestamptz) AS start_at,
                    NULLIF(value->>'end', '')::timestamptz AS end_at,
                    CASE
                        WHEN lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto')) = 'locked'
                            THEN 'manual'
                        ELSE lower(COALESCE(NULLIF(value->>'assignment_source', ''), NULLIF(value->>'source', ''), 'auto'))
                    END AS assignment_source
                FROM jsonb_array_elements(assignments) WITH ORDINALITY AS assignment_items(value, ordinality)
            ),
            assignment_rows AS (
                SELECT
                    parsed_assignments.assignment_ordinal,
                    parsed_assignments.id,
                    v_org_id AS organization_id,
                    v_persisted_run_id AS run_id,
                    parsed_assignments.game_slot_id,
                    parsed_assignments.game_slot_id AS slot_id,
                    COALESCE(parsed_assignments.field_id, game_slot.field_id) AS field_id,
                    parsed_assignments.home_team_id,
                    parsed_assignments.away_team_id,
                    COALESCE(parsed_assignments.division, home_division.name, slot_division.name) AS division,
                    parsed_assignments.week_index::smallint AS week_index,
                    parsed_assignments.start_at AS start,
                    parsed_assignments.end_at AS "end",
                    parsed_assignments.assignment_source::public.source_enum AS assignment_source
                FROM parsed_assignments
                JOIN public.game_slots game_slot
                  ON game_slot.id = parsed_assignments.game_slot_id
                JOIN public.teams home_team
                  ON home_team.id = parsed_assignments.home_team_id
                JOIN public.teams away_team
                  ON away_team.id = parsed_assignments.away_team_id
                LEFT JOIN public.divisions home_division
                  ON home_division.id = home_team.division_id
                LEFT JOIN public.divisions slot_division
                  ON slot_division.id = game_slot.division_id
            )
                SELECT * FROM assignment_rows
      ) r;

    -- IDENTITY (plan docs/changes/2026-11-06-games-table-source-of-truth.md, I1). A game is its row's id, and a save
    -- that names a game by id updates THAT row in place: a move, a flip or a carry keeps the id (the Published flag,
    -- the history, a score, a Game ID are all keyed by it), and leaves no row behind. An assignment without an id is
    -- upserted on the matchup tuple (home, away, slot, week) exactly as it always was. The id is the page's proposal
    -- (lesson 53): it is checked here, in this order, and a refusal writes nothing.
    --   1. an id is a uuid (above), and each game is named once;
    --   2. each id is a game of THIS organization, and an id of another organization reads exactly as one that does not
    --      exist (the words of admin_set_games_published, lesson 95): an admin learns nothing of another tenant's games;
    --   3. the rows are locked FOR UPDATE in id order, after the organization's lock and before any is written;
    --   4. a save that names a season names only games of that season: the check above is organization-wide, so a game
    --      STORED in another season of the organization would otherwise be rewritten into this one. It reads the stored
    --      column after the lock, so it cannot change under the check. A game with no stored season (saved before the
    --      column) and a save that names no season are not refused. The id is already known to belong to this
    --      organization, so naming it tells an admin nothing they could not see;
    --   5. no two games end the save at one place: an in-place update whose new tuple is another row's tuple is
    --      refused, both ids named, because the unique index would otherwise refuse it with a message that names no
    --      game, or (for a row without an id) merge two games into one without a word;
    --   6. a game of a completed season, and a held game that would change, are refused by the triggers on the row.
    SELECT x.id
      INTO v_dup_id
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid)
     WHERE x.id IS NOT NULL
     GROUP BY x.id
    HAVING count(*) > 1
     ORDER BY x.id
     LIMIT 1;
    IF v_dup_id IS NOT NULL THEN
        RAISE EXCEPTION 'game % is named more than once in this save', v_dup_id
            USING ERRCODE = '22023', DETAIL = 'game_identity_repeated';
    END IF;

    SELECT x.id
      INTO v_missing_id
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid)
     WHERE x.id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga
                        WHERE ga.id = x.id AND ga.organization_id = v_org_id)
     ORDER BY x.id
     LIMIT 1;
    IF v_missing_id IS NOT NULL THEN
        RAISE EXCEPTION 'game % does not exist in this organization', v_missing_id
            USING ERRCODE = '23503', DETAIL = 'game_not_found';
    END IF;

    SELECT count(*) INTO v_named
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid)
     WHERE x.id IS NOT NULL;
    SELECT count(*) INTO v_locked
      FROM (SELECT ga.id
              FROM public.game_assignments ga
             WHERE ga.organization_id = v_org_id
               AND ga.id IN (SELECT y.id
                               FROM jsonb_to_recordset(v_resolved) AS y(id uuid)
                              WHERE y.id IS NOT NULL)
             ORDER BY ga.id
               FOR UPDATE) l;
    IF v_locked <> v_named THEN
        RAISE EXCEPTION 'a game was removed while this save was being checked: nothing was saved, try again'
            USING ERRCODE = '40001';
    END IF;

    IF v_season_id IS NOT NULL THEN
        SELECT ga.id
          INTO v_season_first
          FROM public.game_assignments ga
         WHERE ga.organization_id = v_org_id
           AND ga.id IN (SELECT y.id
                           FROM jsonb_to_recordset(v_resolved) AS y(id uuid)
                          WHERE y.id IS NOT NULL)
           AND ga.season_settings_id IS NOT NULL
           AND ga.season_settings_id <> v_season_id
         ORDER BY ga.id
         LIMIT 1;
        IF v_season_first IS NOT NULL THEN
            RAISE EXCEPTION 'game % is a game of another season: a save names only games of its own season', v_season_first
                USING ERRCODE = '22023',
                      DETAIL = format('game_identity_season ids=%s', v_season_first);
        END IF;
    END IF;

    WITH i AS (
        SELECT x.id, x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index
          FROM jsonb_to_recordset(v_resolved) AS x(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
         WHERE x.id IS NOT NULL
    ),
    n AS (
        SELECT x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index
          FROM jsonb_to_recordset(v_resolved) AS x(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
         WHERE x.id IS NULL
    ),
    clashes AS (
        -- two games of this save ending at one place
        SELECT a.id AS first_id, b.id AS second_id
          FROM i a
          JOIN i b ON a.id < b.id
                  AND (a.home_team_id, a.away_team_id, a.game_slot_id, a.week_index)
                    = (b.home_team_id, b.away_team_id, b.game_slot_id, b.week_index)
        UNION ALL
        -- a game of this save ending where a stored game the save does not name by id already is (an older row of the
        -- same pair at the same place that no run shows any more, or the row a game without an id would be upserted onto)
        SELECT a.id, ga.id
          FROM i a
          JOIN public.game_assignments ga
            ON (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
             = (a.home_team_id, a.away_team_id, a.game_slot_id, a.week_index)
           AND ga.id <> a.id
         WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.id = ga.id)
        UNION ALL
        -- a game of this save ending where a new game of this save (an assignment without an id) is sent
        SELECT a.id, NULL::uuid
          FROM i a
          JOIN n ON (n.home_team_id, n.away_team_id, n.game_slot_id, n.week_index)
                  = (a.home_team_id, a.away_team_id, a.game_slot_id, a.week_index)
    )
    SELECT c.first_id, c.second_id
      INTO v_clash_first, v_clash_second
      FROM clashes c
     ORDER BY c.first_id, c.second_id NULLS LAST
     LIMIT 1;
    IF v_clash_first IS NOT NULL THEN
        RAISE EXCEPTION 'game % would end where % already is: one place holds one game of a pair (the unique matchup, slot and week)',
                v_clash_first, COALESCE(v_clash_second::text, 'a new game of this save')
            USING ERRCODE = '22023',
                  DETAIL = format('game_identity_conflict ids=%s', concat_ws(',', v_clash_first, v_clash_second));
    END IF;

    -- 20261119010000: A PUBLISHED GAME IS CARRIED, NEVER LEFT OUT. The save upserts and deletes nothing, so a game
    -- the payload leaves out is not removed: it is orphaned in an older run and vanishes from the page. A row
    -- trigger cannot see an absence, so the check is here: every HELD game of the season (of the organization,
    -- when the run names no season) that the payload does not carry refuses the whole save, and nothing is written.
    -- A payload that carries the game but moves it is refused by game_assignments_published_guard; one that carries it
    -- unchanged passes, and the update below reaches it.
    -- 20261120010000: a game is CARRIED if its id OR its matchup tuple (home, away, slot, week) is in the payload. A
    -- game named by its id at another place is present (the update then meets the guard, which says it is held and
    -- moved); one named at another place WITHOUT its id is another tuple, so the original is still an omission. HELD is
    -- not decided here: it is `game_held_ids`, the one predicate (Published today; a score later). The season of a
    -- game is its home team's division's, as the read-only trigger finds it (20261111010000).
    WITH payload AS (
        SELECT
            NULLIF(value->>'id', '')::uuid AS id,
            COALESCE(
                NULLIF(value->>'home_team_id', '')::uuid,
                NULLIF(value->>'homeTeamId', '')::uuid
            ) AS home_team_id,
            COALESCE(
                NULLIF(value->>'away_team_id', '')::uuid,
                NULLIF(value->>'awayTeamId', '')::uuid
            ) AS away_team_id,
            COALESCE(
                NULLIF(value->>'game_slot_id', '')::uuid,
                NULLIF(value->>'gameSlotId', '')::uuid,
                NULLIF(value->>'slot_id', '')::uuid,
                NULLIF(value->>'slotId', '')::uuid
            ) AS game_slot_id,
            COALESCE(NULLIF(value->>'week_index', '')::integer, NULLIF(value->>'weekIndex', '')::integer) AS week_index
        FROM jsonb_array_elements(assignments) AS assignment_items(value)
    ),
    candidates AS (
        SELECT ga.id
          FROM public.game_assignments ga
          LEFT JOIN public.teams home_team ON home_team.id = ga.home_team_id
          LEFT JOIN public.divisions home_division ON home_division.id = home_team.division_id
          LEFT JOIN public.season_settings home_season ON home_season.id = home_division.season_settings_id
         WHERE ga.organization_id = v_org_id
           -- Only a game a save CAN carry is an omission: a complete key (a NULL part matches nothing, so such a game
           -- could never be carried and every season-less save would be refused for it), and a season that is not
           -- completed (a completed season is read-only: the save could not write its games and Allow changes
           -- cannot release them, so they would block every season-less save for good). The guard trigger still
           -- holds both kinds. (Code review, #707.)
           AND ga.home_team_id IS NOT NULL AND ga.away_team_id IS NOT NULL
           AND ga.game_slot_id IS NOT NULL AND ga.week_index IS NOT NULL
           AND home_season.status IS DISTINCT FROM 'completed'
           AND (v_season_id IS NULL OR home_division.season_settings_id = v_season_id)
           -- Two anti-joins and not one with an OR: an OR between the id and the tuple cannot be hashed, and a league of
           -- 2,400 games then compares every game with every row of the payload.
           AND NOT EXISTS (SELECT 1 FROM payload pl WHERE pl.id = ga.id)
           AND NOT EXISTS (SELECT 1
                             FROM payload pl
                            WHERE pl.home_team_id = ga.home_team_id
                              AND pl.away_team_id = ga.away_team_id
                              AND pl.game_slot_id = ga.game_slot_id
                              AND pl.week_index = ga.week_index)
    ),
    missing AS (
        -- 20261122010000: WHETHER a game is held is still the one predicate's answer; the code only chooses the words
        -- (a Published game is said first: changes to it must be allowed before anything else).
        SELECT h.id, public.game_hold_code(h.id) AS code
          FROM public.game_held_ids(ARRAY(SELECT c.id FROM candidates c)) AS h(id)
    )
    SELECT count(*) FILTER (WHERE m.code IS DISTINCT FROM 'game_scored'),
           COALESCE((array_agg(m.id ORDER BY m.id) FILTER (WHERE m.code IS DISTINCT FROM 'game_scored'))[1:50], '{}'::uuid[]),
           count(*) FILTER (WHERE m.code = 'game_scored'),
           COALESCE((array_agg(m.id ORDER BY m.id) FILTER (WHERE m.code = 'game_scored'))[1:50], '{}'::uuid[])
      INTO v_omitted_count, v_omitted_ids, v_scored_omitted_count, v_scored_omitted_ids
      FROM missing m;

    IF v_omitted_count > 0 THEN
        RAISE EXCEPTION 'this save leaves out % Published game(s): a save carries every Published game of its season, unchanged (allow changes to a game first to move or drop it)', v_omitted_count
            USING ERRCODE = '22023',
                  DETAIL = format('game_published_omitted count=%s ids=%s', v_omitted_count, array_to_string(v_omitted_ids, ','));
    END IF;
    IF v_scored_omitted_count > 0 THEN
        RAISE EXCEPTION 'this save leaves out % game(s) that have a score: a save carries every scored game of its season, unchanged (clear a game''s score first to move or drop it)', v_scored_omitted_count
            USING ERRCODE = '22023',
                  DETAIL = format('game_scored_omitted count=%s ids=%s', v_scored_omitted_count, array_to_string(v_scored_omitted_ids, ','));
    END IF;

    -- 20261120010000: THE WRITES. Games named by id are updated in place; assignments without an id are upserted on the
    -- matchup tuple, as they always were. Nothing is deleted by a save.
    --
    -- First, room is made. The unique matchup index is not deferrable, so two games that swap places in one save would
    -- meet in it whichever is written first. A game whose current place another game of this save is about to take is
    -- taken out of the index (its slot set null for the length of this save) and given its final place by the
    -- update that follows, in this transaction. The clashes were refused above, so no game ends where another is.
    UPDATE public.game_assignments ga
       SET game_slot_id = NULL,
           slot_id = NULL
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
     WHERE x.id IS NOT NULL
       AND ga.id = x.id
       AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
           IS DISTINCT FROM (x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index)
       AND EXISTS (SELECT 1
                     FROM jsonb_to_recordset(v_resolved) AS y(id uuid, home_team_id uuid, away_team_id uuid, game_slot_id uuid, week_index smallint)
                    WHERE y.id IS NOT NULL
                      AND y.id <> ga.id
                      AND (y.home_team_id, y.away_team_id, y.game_slot_id, y.week_index)
                        = (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index));

    -- The games named by id: where they are, when, who plays, the run they now belong to and the season. Not the
    -- Published columns: whether a game is Published is the switch's to say.
    UPDATE public.game_assignments ga
       SET run_id = x.run_id,
           game_slot_id = x.game_slot_id,
           slot_id = x.slot_id,
           field_id = x.field_id,
           home_team_id = x.home_team_id,
           away_team_id = x.away_team_id,
           division = x.division,
           week_index = x.week_index,
           start = x."start",
           "end" = x."end",
           assignment_source = x.assignment_source,
           season_settings_id = COALESCE(v_season_id, ga.season_settings_id),
           updated_at = now()
      FROM jsonb_to_recordset(v_resolved) AS x(id uuid, run_id uuid, game_slot_id uuid, slot_id uuid, field_id uuid, home_team_id uuid, away_team_id uuid, division text, week_index smallint, "start" timestamptz, "end" timestamptz, assignment_source public.source_enum)
     WHERE x.id IS NOT NULL
       AND ga.id = x.id;

    -- The assignments without an id: upserted on the matchup tuple. A season-less save leaves the stored season alone.
    WITH deduped_assignment_rows AS (
        SELECT DISTINCT ON (x.home_team_id, x.away_team_id, x.game_slot_id, x.week_index)
            x.organization_id,
            x.run_id,
            x.game_slot_id,
            x.slot_id,
            x.field_id,
            x.home_team_id,
            x.away_team_id,
            x.division,
            x.week_index,
            x."start" AS start,
            x."end" AS "end",
            x.assignment_source
        FROM jsonb_to_recordset(v_resolved) AS x(assignment_ordinal bigint, id uuid, organization_id uuid, run_id uuid, game_slot_id uuid, slot_id uuid, field_id uuid, home_team_id uuid, away_team_id uuid, division text, week_index smallint, "start" timestamptz, "end" timestamptz, assignment_source public.source_enum)
        WHERE x.id IS NULL
        ORDER BY
            x.home_team_id,
            x.away_team_id,
            x.game_slot_id,
            x.week_index,
            x.assignment_ordinal DESC
    )
    INSERT INTO public.game_assignments (
        organization_id,
        run_id,
        game_slot_id,
        slot_id,
        field_id,
        home_team_id,
        away_team_id,
        division,
        week_index,
        start,
        "end",
        assignment_source,
        season_settings_id
    )
    SELECT
        organization_id,
        run_id,
        game_slot_id,
        slot_id,
        field_id,
        home_team_id,
        away_team_id,
        division,
        week_index,
        start,
        "end",
        assignment_source,
        v_season_id
    FROM deduped_assignment_rows
    ON CONFLICT (home_team_id, away_team_id, game_slot_id, week_index)
        WHERE home_team_id IS NOT NULL
          AND away_team_id IS NOT NULL
          AND game_slot_id IS NOT NULL
          AND week_index IS NOT NULL
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        run_id = EXCLUDED.run_id,
        slot_id = EXCLUDED.slot_id,
        field_id = EXCLUDED.field_id,
        division = EXCLUDED.division,
        start = EXCLUDED.start,
        "end" = EXCLUDED."end",
        assignment_source = EXCLUDED.assignment_source,
        season_settings_id = COALESCE(EXCLUDED.season_settings_id, public.game_assignments.season_settings_id),
        updated_at = now();

    -- 20261108020000: THE TIME TBD LIST FOR GAMES (Phase D, E). A run that found games it could
    -- not place says so in `results.unscheduled` (the scheduler's own list: week, division, the
    -- matchup's home and away team, the reason). When the save carries that list -- an array, even
    -- an empty one -- it REPLACES the season's recorded unscheduled games, so the master export
    -- prints each one as a TIME TBD row for both teams instead of leaving the game out. A save
    -- that carries no such list (a manual move, a rollback) changes nothing here. Every entry is
    -- checked: a week, two different teams of this season and organization, a reason on the closed
    -- list; one bad entry refuses the whole save (nothing is written).
    IF jsonb_typeof(run_data->'results'->'unscheduled') = 'array' THEN
        v_unscheduled := run_data->'results'->'unscheduled';
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_unscheduled) e
                    WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object') THEN
            RAISE EXCEPTION 'each unscheduled game must be a JSON object'
                USING ERRCODE = '22023';
        END IF;
        IF jsonb_array_length(v_unscheduled) > 0 AND v_season_id IS NULL THEN
            RAISE EXCEPTION 'season_settings_id is required to record unscheduled games'
                USING ERRCODE = '23502';
        END IF;
        IF v_season_id IS NOT NULL THEN
            WITH u AS (
            SELECT e.value AS j,
                   CASE WHEN e.value->>'weekIndex' ~ '^[0-9]{1,3}$' THEN (e.value->>'weekIndex')::integer END AS wk,
                   CASE WHEN e.value#>>'{matchup,homeTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,homeTeamId}')::uuid END AS h,
                   CASE WHEN e.value#>>'{matchup,awayTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,awayTeamId}')::uuid END AS a,
                   e.value->>'reason' AS reason,
                   NULLIF(btrim(COALESCE(e.value->>'division', '')), '') AS division
              FROM jsonb_array_elements(v_unscheduled) e
        )
            SELECT count(*) FILTER (WHERE u.wk IS NULL OR u.wk < 1 OR u.wk > 255),
                   count(*) FILTER (WHERE u.h IS NULL OR u.a IS NULL),
                   count(*) FILTER (WHERE u.h = u.a),
                   count(*) FILTER (WHERE u.reason IS NULL OR u.reason NOT IN (
                       'unknown-team', 'division-mismatch', 'duplicate-matchup',
                       'coach-coaches-both-teams', 'coach-scheduling-conflict', 'no-slot-available')),
                   count(*) FILTER (WHERE (u.h IS NOT NULL AND th.id IS NULL) OR (u.a IS NOT NULL AND ta.id IS NULL)),
                   count(*) FILTER (WHERE th.organization_id <> v_org_id OR ta.organization_id <> v_org_id),
                   count(*) FILTER (WHERE dh.season_settings_id <> v_season_id OR da.season_settings_id <> v_season_id)
              INTO v_tbd_bad_shape, v_tbd_bad_teams, v_tbd_same_team, v_tbd_bad_reason,
                   v_tbd_missing_team, v_tbd_other_org, v_tbd_other_season
              FROM u
              LEFT JOIN public.teams th ON th.id = u.h
              LEFT JOIN public.divisions dh ON dh.id = th.division_id
              LEFT JOIN public.teams ta ON ta.id = u.a
              LEFT JOIN public.divisions da ON da.id = ta.division_id;
            IF v_tbd_bad_shape > 0 THEN
                RAISE EXCEPTION 'every unscheduled game needs a weekIndex from 1 to 255 (% do not)', v_tbd_bad_shape
                    USING ERRCODE = '22023';
            END IF;
            IF v_tbd_bad_teams > 0 THEN
                RAISE EXCEPTION 'every unscheduled game needs matchup.homeTeamId and matchup.awayTeamId (% do not)', v_tbd_bad_teams
                    USING ERRCODE = '23502';
            END IF;
            IF v_tbd_same_team > 0 THEN
                RAISE EXCEPTION 'an unscheduled game''s home and away team must differ'
                    USING ERRCODE = '22023';
            END IF;
            IF v_tbd_bad_reason > 0 THEN
                RAISE EXCEPTION 'every unscheduled game needs a reason from the scheduler''s list (% do not)', v_tbd_bad_reason
                    USING ERRCODE = '22023';
            END IF;
            IF v_tbd_missing_team > 0 THEN
                RAISE EXCEPTION 'an unscheduled game names a team that does not exist (% such)', v_tbd_missing_team
                    USING ERRCODE = '23503';
            END IF;
            IF v_tbd_other_org > 0 THEN
                RAISE EXCEPTION 'an unscheduled game names a team of another organization'
                    USING ERRCODE = '42501';
            END IF;
            IF v_tbd_other_season > 0 THEN
                RAISE EXCEPTION 'an unscheduled game names a team that is not in season %', v_season_id
                    USING ERRCODE = '42501';
            END IF;

            DELETE FROM public.schedule_tbd s
             WHERE s.organization_id = v_org_id
               AND s.season_settings_id = v_season_id
               AND s.kind = 'game';
            WITH u AS (
            SELECT e.value AS j,
                   CASE WHEN e.value->>'weekIndex' ~ '^[0-9]{1,3}$' THEN (e.value->>'weekIndex')::integer END AS wk,
                   CASE WHEN e.value#>>'{matchup,homeTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,homeTeamId}')::uuid END AS h,
                   CASE WHEN e.value#>>'{matchup,awayTeamId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN (e.value#>>'{matchup,awayTeamId}')::uuid END AS a,
                   e.value->>'reason' AS reason,
                   NULLIF(btrim(COALESCE(e.value->>'division', '')), '') AS division
              FROM jsonb_array_elements(v_unscheduled) e
        )
            INSERT INTO public.schedule_tbd (
                organization_id, season_settings_id, kind, division_id,
                home_team_id, away_team_id, week_index, reason, detail, run_id
            )
            SELECT DISTINCT ON (u.h, u.a, u.wk)
                   v_org_id, v_season_id, 'game', th.division_id,
                   u.h, u.a, u.wk::smallint, u.reason,
                   jsonb_strip_nulls(jsonb_build_object('division', u.division)),
                   v_persisted_run_id
              FROM u
              JOIN public.teams th ON th.id = u.h
             ORDER BY u.h, u.a, u.wk, u.reason;
            SELECT count(*) INTO v_tbd_games
              FROM public.schedule_tbd s
             WHERE s.organization_id = v_org_id AND s.season_settings_id = v_season_id AND s.kind = 'game';
        END IF;
    END IF;

    -- 20261018070000: the audit row, in this transaction (plan section 3.1).
    -- A failed write rolls the whole save back; SLA01 tells the Edge Function
    -- it was the audit, and DETAIL keeps the original SQLSTATE. Every error is
    -- caught and every one is re-raised.
    BEGIN
        PERFORM public.record_audit_event(
            v_org_id, 'game.saved', 'scheduler_run', v_persisted_run_id,
            jsonb_build_object(
                'season_settings_id', COALESCE(v_season_settings_id, v_season_id),
                'game_count', jsonb_array_length(assignments))
            || CASE WHEN v_tbd_games IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('unscheduled_count', v_tbd_games) END);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    RETURN v_persisted_run_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Cancel, copied whole from 20261120010000. Changed: a scored game is refused in its own words (game_scored).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_cancel_game_assignment(p_assignment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id uuid;
BEGIN
    SELECT organization_id INTO v_org_id
    FROM public.game_assignments WHERE id = p_assignment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'game assignment % not found', p_assignment_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- 20261119010000: a Published game is cancelled only after changes to it are allowed (the guard trigger is the
    -- backstop for every other path). 20261120010000: "held" is asked of the one predicate.
    IF public.game_is_held(p_assignment_id) THEN
        -- 20261122010000: held by its score and not Published.
        IF public.game_hold_code(p_assignment_id) = 'game_scored' THEN
            RAISE EXCEPTION 'game % has a score and cannot be cancelled: clear its score first', p_assignment_id
                USING ERRCODE = '22023', DETAIL = 'game_scored';
        END IF;
        RAISE EXCEPTION 'game % is Published and cannot be cancelled: allow changes to it first', p_assignment_id
            USING ERRCODE = '22023', DETAIL = 'game_published';
    END IF;

    DELETE FROM public.game_assignments WHERE id = p_assignment_id;

    PERFORM public.record_audit_event(
        v_org_id,
        'game.cancelled',
        'game_assignments',
        p_assignment_id,
        jsonb_build_object('assignment_id', p_assignment_id)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Delete team, copied whole from 20261120010000. Changed: a game held only by its score goes with the team, its score first, counted (game_scores_deleted).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_team public.teams%ROWTYPE;
    v_uid uuid := auth.uid();
    v_pa record;
    v_row jsonb;
    v_withdrawn jsonb;
    v_archived jsonb;
    v_game_ids uuid[];
    v_player_ids uuid[];
    v_counts jsonb;
    v_published_games integer;
    v_scores_deleted integer;
BEGIN
    SELECT * INTO v_team FROM public.teams WHERE id = p_team_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team % not found', p_team_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_team.organization_id) THEN
        -- Production's own text, which names no organisation to a caller
        -- outside it.
        RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    END IF;

    -- 20261119010000: a team with a Published game is deleted only after changes to its games are allowed. Said
    -- before anything is deleted, with the count (the guard trigger's refusal of the cascade is the backstop).
    -- 20261120010000: counted by the one predicate (`game_held_ids`), over the team's games on either side.
    -- 20261122010000 (F11 decision D5): a game held ONLY by its score does not refuse the delete; it goes with the team
    -- and its score with it, counted below. So the count is of the held games whose hold is Published.
    SELECT count(*) INTO v_published_games
      FROM public.game_held_ids(ARRAY(SELECT ga.id
                                        FROM public.game_assignments ga
                                       WHERE ga.home_team_id = p_team_id OR ga.away_team_id = p_team_id)) AS h(id)
     WHERE public.game_hold_code(h.id) IS DISTINCT FROM 'game_scored';
    IF v_published_games > 0 THEN
        RAISE EXCEPTION 'team % has % Published game(s) and cannot be deleted: allow changes to them first', p_team_id, v_published_games
            USING ERRCODE = '22023', DETAIL = 'game_published';
    END IF;

    -- 2. The practice series, as admin_cancel_practice_assignment does each.
    --    An exception is the team's if it is on one of the team's series or
    --    names the team: the team_id cascade would remove either.
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = now(),
               withdrawn_by = v_uid
         WHERE (pe.team_id = p_team_id
                OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                         WHERE pa.team_id = p_team_id))
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.exception_withdrawn',
            'practice_exception',
            (v_row->>'id')::uuid,
            jsonb_build_object('reason', 'team_deleted', 'team_id', p_team_id,
                               'assignment_id', v_row->'assignment_id', 'row', v_row)
        );
    END LOOP;

    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.team_id = p_team_id
            OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                     WHERE pa.team_id = p_team_id)
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_archived
      FROM gone;
    UPDATE public.scheduler_runs sr
       SET results = COALESCE(sr.results, '{}'::jsonb) || jsonb_build_object(
               'archived_exceptions',
               COALESCE(sr.results->'archived_exceptions', '[]'::jsonb)
               || (SELECT jsonb_agg(e.value) FROM jsonb_array_elements(v_archived) e
                    WHERE (e.value->>'run_id')::uuid = sr.id))
     WHERE sr.id IN (SELECT (e.value->>'run_id')::uuid FROM jsonb_array_elements(v_archived) e
                      WHERE e.value->>'run_id' IS NOT NULL);

    v_counts := jsonb_build_object(
        'practice_exceptions_deleted', jsonb_array_length(v_archived),
        'practice_assignments_deleted',
            (SELECT count(*) FROM public.practice_assignments WHERE team_id = p_team_id)
    );
    FOR v_pa IN
        SELECT pa.id, to_jsonb(pa.*) AS before
          FROM public.practice_assignments pa
         WHERE pa.team_id = p_team_id
         ORDER BY pa.id
    LOOP
        DELETE FROM public.practice_assignments WHERE id = v_pa.id;
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.cancelled',
            'practice_assignments',
            v_pa.id,
            jsonb_build_object(
                'reason', 'team_deleted',
                'team_id', p_team_id,
                'assignment_id', v_pa.id,
                'before', v_pa.before,
                'withdrawn_exception_ids',
                    (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                       FROM jsonb_array_elements(v_withdrawn) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id),
                'archived_exceptions',
                    (SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb)
                       FROM jsonb_array_elements(v_archived) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id)
            )
        );
    END LOOP;

    -- 3. The team's games, held until commit, so the game ids and count
    --    team.deleted records are the rows the cascade removes (a concurrent
    --    write cannot move a game off the team in between). 20261022030000:
    --    their RSVPs are gone with the table.
    SELECT COALESCE(array_agg(g.id ORDER BY g.id), ARRAY[]::uuid[])
      INTO v_game_ids
      FROM (SELECT id FROM public.games
             WHERE home_team_id = p_team_id OR away_team_id = p_team_id
             ORDER BY id
               FOR UPDATE) g;

    -- 4. Players assigned through players.team_id (no foreign key), then the team.
    SELECT COALESCE(array_agg(p.id ORDER BY p.id), ARRAY[]::uuid[])
      INTO v_player_ids
      FROM public.players p
     WHERE p.team_id = p_team_id;

    -- 5. What the cascade takes, counted before it runs.
    v_counts := v_counts || jsonb_build_object(
        'games_deleted', cardinality(v_game_ids),
        'game_assignments_deleted',
            (SELECT count(*) FROM public.game_assignments
              WHERE home_team_id = p_team_id OR away_team_id = p_team_id),
        'team_players_deleted',
            (SELECT count(*) FROM public.team_players WHERE team_id = p_team_id),
        'team_coach_assignments_deleted',
            (SELECT count(*) FROM public.team_coach_assignments WHERE team_id = p_team_id),
        'team_calendar_tokens_deleted',
            (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id = p_team_id),
        -- 20261108020000: the TIME TBD rows the cascade takes (as practice team, or as either side of a game).
        'schedule_tbd_deleted',
            (SELECT count(*) FROM public.schedule_tbd
              WHERE team_id = p_team_id OR home_team_id = p_team_id OR away_team_id = p_team_id),
        -- 20261112010000: the practice preference rules the cascade takes.
        'coach_practice_preferences_deleted',
            (SELECT count(*) FROM public.coach_practice_preferences WHERE team_id = p_team_id)
    );

    UPDATE public.players SET team_id = NULL WHERE id = ANY (v_player_ids);
    -- 20261122010000: the scores of the team's games go first (the foreign key from a score to its game is NO ACTION and
    -- would refuse the cascade, and the guard holds a scored game), and are counted in the audit row.
    DELETE FROM public.game_scores gs
     WHERE gs.game_id IN (SELECT ga.id FROM public.game_assignments ga
                           WHERE ga.home_team_id = p_team_id OR ga.away_team_id = p_team_id);
    GET DIAGNOSTICS v_scores_deleted = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('game_scores_deleted', v_scores_deleted);
    DELETE FROM public.teams WHERE id = p_team_id;

    PERFORM public.record_audit_event(
        v_team.organization_id,
        'team.deleted',
        'teams',
        p_team_id,
        jsonb_build_object('name', v_team.name, 'division_id', v_team.division_id)
            || v_counts
            || jsonb_build_object(
                   'game_ids', to_jsonb(v_game_ids),
                   'player_ids_unassigned', to_jsonb(v_player_ids),
                   'withdrawn_exception_ids',
                       (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                          FROM jsonb_array_elements(v_withdrawn) e),
                   'archived_exceptions', v_archived)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. update_game_score, copied whole from 20261028010000. Changed: it names a saved game and writes game_scores; both scores or none.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_game_score(
    p_organization_id uuid,
    p_game_id uuid,
    p_score_home smallint,
    p_score_away smallint,
    p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$

DECLARE
    v_game record;
    v_effective_role text := COALESCE(auth.role(), current_role, '');
    v_member_role text;
    v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_changed boolean;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_game_id IS NULL THEN
        RAISE EXCEPTION 'p_game_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_score_home IS NOT NULL AND p_score_home < 0 THEN
        RAISE EXCEPTION 'p_score_home must be non-negative'
            USING ERRCODE = '23514';
    END IF;

    IF p_score_away IS NOT NULL AND p_score_away < 0 THEN
        RAISE EXCEPTION 'p_score_away must be non-negative'
            USING ERRCODE = '23514';
    END IF;

    -- 20261122010000 (F11 decision D10): both scores or none. A score row exists exactly when the game is scored, so one
    -- score without the other has nowhere to be stored (it was accepted before, and ignored by the standings).
    IF (p_score_home IS NULL) <> (p_score_away IS NULL) THEN
        RAISE EXCEPTION 'enter both scores, or clear both: one score without the other is not a result'
            USING ERRCODE = '22023', DETAIL = 'score_one_sided';
    END IF;

    IF jsonb_typeof(v_metadata) <> 'object' THEN
        RAISE EXCEPTION 'p_metadata must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF v_effective_role <> 'service_role' THEN
        IF auth.uid() IS NULL THEN
            RAISE EXCEPTION 'authenticated user is required'
                USING ERRCODE = '42501';
        END IF;

        SELECT om.role
          INTO v_member_role
          FROM public.organization_members om
         WHERE om.organization_id = p_organization_id
           AND om.profile_id = auth.uid();

        IF v_member_role IS NULL THEN
            RAISE EXCEPTION 'Access denied: caller cannot update scores for organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- 20261122010000 (F11-2): the game is a SAVED game (game_assignments, whose id is the game's for its whole life since
    -- 20261120010000), and its score is its row of game_scores. The legacy `games` table is not read or written. The lock
    -- is the one the game save and the Published switch take, so a save that leaves this game out and a score entered on
    -- it cannot both succeed (the save's omission check asks whether the game is held).
    PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || p_organization_id::text, 0));
    SELECT g.id,
           g.organization_id,
           g.home_team_id,
           g.away_team_id,
           g.run_id,
           gs.score_home,
           gs.score_away,
           ht.organization_id AS home_team_org_id,
           at.organization_id AS away_team_org_id
      INTO v_game
      FROM public.game_assignments g
      JOIN public.teams ht
        ON ht.id = g.home_team_id
      JOIN public.teams at
        ON at.id = g.away_team_id
      LEFT JOIN public.game_scores gs
        ON gs.game_id = g.id
     WHERE g.id = p_game_id
       AND g.organization_id = p_organization_id
       FOR UPDATE OF g;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Game not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_game.home_team_org_id <> p_organization_id
       OR v_game.away_team_org_id <> p_organization_id THEN
        RAISE EXCEPTION 'Game teams must belong to the requested organization'
            USING ERRCODE = '42501';
    END IF;

    -- 20261028010000: score entry is an admin function (admins and staff,
    -- is_org_admin), and only while the league has turned it on: the
    -- `score_entry` setting, off unless set (owner decision 4; plan
    -- docs/changes/2026-10-22-admin-focus.md, R6). A coach scores nothing.
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin enters scores'
            USING ERRCODE = '42501';
    END IF;

    -- The service role (a server-side job; no client holds it) skips the
    -- setting as it skips the role checks above.
    -- 20261122010000: the setting gates ENTERING a score. A clear (both scores empty) is always allowed to an admin:
    -- a scored game is held, and turning score entry off must not leave games held with no way to release them.
    IF v_effective_role <> 'service_role'
       AND p_score_home IS NOT NULL
       AND NOT public.org_flag(p_organization_id, 'score_entry', false) THEN
        RAISE EXCEPTION 'Score entry is off for organization %: an admin turns it on in Settings', p_organization_id
            USING ERRCODE = '55000';
    END IF;

    v_changed :=
        v_game.score_home IS DISTINCT FROM p_score_home
        OR v_game.score_away IS DISTINCT FROM p_score_away;

    -- 20261122010000: a score is SET only on a game of its season's current game run (`current_game_runs`). A score on
    -- a game left in an older run would hold a game no screen shows, and every later save would be refused for leaving
    -- it out, with nothing on any page to release it. A clear is never refused for this: it releases a hold.
    IF v_changed AND p_score_home IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.current_game_runs c
                        WHERE c.organization_id = p_organization_id AND c.run_id = v_game.run_id) THEN
        RAISE EXCEPTION 'Game % is not in its season''s current schedule, so it takes no score: only a game of the schedule that is shown can be scored', p_game_id
            USING ERRCODE = '22023', DETAIL = 'game_not_current';
    END IF;

    IF v_changed THEN
        -- A completed season refuses here: game_scores carries the completed-season trigger (22023, season_completed).
        IF p_score_home IS NULL THEN
            DELETE FROM public.game_scores WHERE game_id = p_game_id;
        ELSE
            INSERT INTO public.game_scores AS gs (game_id, organization_id, home_team_id, away_team_id, score_home, score_away, updated_by)
            VALUES (p_game_id, p_organization_id, v_game.home_team_id, v_game.away_team_id, p_score_home, p_score_away, auth.uid())
            ON CONFLICT (game_id) DO UPDATE
               SET score_home = EXCLUDED.score_home,
                   score_away = EXCLUDED.score_away,
                   updated_at = now(),
                   updated_by = EXCLUDED.updated_by;
        END IF;

        PERFORM public.record_audit_event(
            p_organization_id,
            'competition.score_updated',
            'game',
            p_game_id,
            jsonb_build_object(
                'game_id', p_game_id,
                'home_team_id', v_game.home_team_id,
                'away_team_id', v_game.away_team_id,
                'previous_score_home', v_game.score_home,
                'previous_score_away', v_game.score_away,
                'score_home', p_score_home,
                'score_away', p_score_away
            ) || v_metadata
        );
    END IF;

    RETURN jsonb_build_object(
        'game_id', p_game_id,
        'organization_id', p_organization_id,
        'score_home', p_score_home,
        'score_away', p_score_away,
        'previous_score_home', v_game.score_home,
        'previous_score_away', v_game.score_away,
        'changed', v_changed
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. The games import's apply, copied whole from 20261121010000. Changed: skipped-scored; the staged flags bad-time and bad-week.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_game_import_job(p_import_job_id uuid, p_dry_run boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    -- The closed list of reasons a row is refused and listed (packages/core/src/scheduleImport/reasonCodes.js,
    -- SCHEDULE_IMPORT_ROW_REFUSALS; tests/gameImportReasonParity.test.js holds this text to it). A staged row refused by
    -- the file check carries one of them in its validation_errors; the apply adds the ones it can only know once labels
    -- are mapped.
    c_row_refusals constant text[] := ARRAY[
        'bad-game-id', 'bad-date', 'bad-time', 'end-not-after-start', 'same-team', 'bad-week', 'missing-week',
        'outside-season-window', 'time-in-dst-gap', 'unknown-division', 'unknown-team', 'unknown-venue', 'unknown-field',
        'label-is-own-team', 'duplicate-row', 'game-id-reused'];
    -- The closed list of reasons a game the file names is NOT written. It can grow by one (F11-2: skipped-scored);
    -- packages/core/src/scheduleImport/reasonCodes.js holds the words for each (SCHEDULE_IMPORT_SKIP_REASONS).
    c_skip_published constant text := 'skipped-published';
    -- 20261122010000: a held game that is not Published is held by its score.
    c_skip_scored constant text := 'skipped-scored';
    v_held_scored uuid[];
    n_skip_scored integer;
    c_listed constant integer := 200;
    c_listed_ids constant integer := 50;
    v_uid uuid := auth.uid();
    v_dry boolean := COALESCE(p_dry_run, false);
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season uuid;
    v_season_status text;
    v_map jsonb;
    v_arrive boolean;
    v_now timestamptz := now();
    v_prev_run uuid;
    v_run_id uuid := gen_random_uuid();
    v_bad_row integer;
    v_bad_code text;
    v_held uuid[];
    v_rc bigint;
    v_planned bigint;
    n_staged integer; n_refused integer; n_skipped integer; n_ok integer; n_tbd integer;
    n_ins integer; n_upd integer; n_unch integer; n_skip_pub integer; n_repoint integer; n_hidden integer;
    n_tbd_ins integer; n_tbd_unch integer; n_tbd_upd integer; n_tbd_rem integer; n_tbd_conflict integer; n_tbd_held integer; n_conv integer;
    n_div integer; n_ven integer; n_fld integer; n_shell integer; n_out integer; n_slot_new integer; n_slot_reused integer;
    n_not_in_file integer; v_not_in_file jsonb;
    v_work integer;
    v_nothing boolean;
    v_warnings jsonb;
    v_refused_by_reason jsonb;
    v_listed_refused jsonb; v_listed_skipped jsonb; v_listed_games jsonb;
    v_skipped_obj jsonb;
    v_result jsonb;
    v_ids jsonb := jsonb_build_object('run_id', NULL, 'team_run_ids', '[]'::jsonb);
    v_team_runs jsonb := '[]'::jsonb;
    v_status text;
    v_published_ids uuid[];
    v_div record;
    v_base jsonb; v_grouped jsonb; v_results jsonb; v_key text; v_label text; v_shell_arr uuid[]; v_team_run uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'apply_game_import_job needs a signed-in caller' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'games' THEN
        RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;

    -- An apply takes the game writers' lock and then the season writers' (every other path takes at most one of the two,
    -- so no order can deadlock), and holds the job row; a dry run only reads.
    IF NOT v_dry THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org::text, 0));
        PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
        SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    END IF;

    -- A finished job answers with the result it stored (a retry after a lost response writes nothing).
    IF v_job.status IN ('completed', 'completed_with_warnings') THEN
        IF v_job.warning_summary ? 'game_import' THEN
            RETURN (v_job.warning_summary -> 'game_import') || jsonb_build_object('replayed', true);
        END IF;
        RAISE EXCEPTION 'Import job % is already %', p_import_job_id, v_job.status USING ERRCODE = '22023';
    END IF;
    IF v_job.status IN ('failed', 'needs_fix') THEN
        RAISE EXCEPTION '% import job % cannot be applied: a new file is a new job', initcap(v_job.status), p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    v_season := v_job.season_settings_id;
    SELECT s.status INTO v_season_status FROM public.season_settings s
     WHERE s.id = v_season AND s.organization_id = v_org;
    IF v_season_status IS NULL THEN
        RAISE EXCEPTION 'Import job % has no season to import into', p_import_job_id USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_season_status <> 'active' THEN
        RAISE EXCEPTION 'Season % is % and takes no games import: only the active season does', v_season, v_season_status
            USING ERRCODE = '22023', DETAIL = 'season_not_active';
    END IF;
    v_map := v_job.warning_summary -> 'game_mapping';
    IF v_map IS NULL THEN
        RAISE EXCEPTION 'Import job % has no mapping: confirm what each label of the file is first', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'mapping_required';
    END IF;
    v_arrive := COALESCE((v_map -> 'options' ->> 'arrive_published')::boolean, true);

    -- ------------------------------------------------------------------ 1. The staged rows, read once.
    DROP TABLE IF EXISTS pg_temp._gi_tbefore, pg_temp._gi_rows, pg_temp._gi_dec, pg_temp._gi_div, pg_temp._gi_venue, pg_temp._gi_field,
        pg_temp._gi_team, pg_temp._gi_res, pg_temp._gi_work, pg_temp._gi_g, pg_temp._gi_slotnew, pg_temp._gi_t,
        pg_temp._gi_carry, pg_temp._gi_final, pg_temp._gi_before, pg_temp._gi_newgames;

    CREATE TEMP TABLE _gi_rows ON COMMIT DROP AS
    SELECT sr.id AS staging_id,
           sr.source_row_number AS rowno,
           (sr.normalized_payload IS NULL OR COALESCE(jsonb_array_length(sr.validation_errors), 0) > 0) AS parse_refused,
           sr.validation_errors -> 0 ->> 'code' AS parse_reason,
           sr.validation_errors -> 0 ->> 'message' AS parse_message,
           sr.normalized_payload ->> 'row_key' AS row_key,
           NULLIF(btrim(sr.normalized_payload ->> 'game_id', E' \t\r\n'), '') AS game_id,
           sr.normalized_payload ->> 'status' AS status,
           sr.normalized_payload ->> 'tbd_reason' AS tbd_reason,
           CASE WHEN sr.normalized_payload ->> 'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN (sr.normalized_payload ->> 'date')::date END AS gdate,
           CASE WHEN sr.normalized_payload ->> 'start_time' ~ '^\d{2}:\d{2}$' THEN (sr.normalized_payload ->> 'start_time')::time END AS start_time,
           CASE WHEN sr.normalized_payload ->> 'end_time' ~ '^\d{2}:\d{2}$' THEN (sr.normalized_payload ->> 'end_time')::time END AS end_time,
           CASE WHEN sr.normalized_payload ->> 'start' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
                THEN (sr.normalized_payload ->> 'start')::timestamptz END AS start_ts,
           CASE WHEN sr.normalized_payload ->> 'end' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
                THEN (sr.normalized_payload ->> 'end')::timestamptz END AS end_ts,
           CASE WHEN sr.normalized_payload ->> 'week_index' ~ '^\d{1,3}$' THEN (sr.normalized_payload ->> 'week_index')::integer END AS week_index,
           CASE WHEN jsonb_typeof(sr.normalized_payload -> 'flags') = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(sr.normalized_payload -> 'flags')) ELSE ARRAY[]::text[] END AS flags,
           btrim(sr.normalized_payload ->> 'division', E' \t\r\n') AS division_label,
           sr.normalized_payload ->> 'division_key' AS division_key,
           btrim(sr.normalized_payload ->> 'venue', E' \t\r\n') AS venue_label,
           sr.normalized_payload ->> 'venue_key' AS venue_key,
           btrim(sr.normalized_payload ->> 'field', E' \t\r\n') AS field_label,
           sr.normalized_payload ->> 'field_key' AS field_key,
           btrim(sr.normalized_payload ->> 'home_team', E' \t\r\n') AS home_label,
           sr.normalized_payload ->> 'home_key' AS home_key,
           btrim(sr.normalized_payload ->> 'away_team', E' \t\r\n') AS away_label,
           sr.normalized_payload ->> 'away_key' AS away_key
      FROM public.staging_import_rows sr
     WHERE sr.import_job_id = p_import_job_id
       AND sr.organization_id = v_org
       AND sr.import_type = 'games';

    SELECT count(*) INTO n_staged FROM _gi_rows;
    IF n_staged = 0 THEN
        RAISE EXCEPTION 'Import job % has no staged games rows', p_import_job_id USING ERRCODE = '22023', DETAIL = 'no_rows';
    END IF;

    -- A staged row is the Edge function's work, and a malformed one is a defect there, not a row to guess at: the whole
    -- apply refuses, naming the first.
    SELECT r.rowno, r.parse_reason INTO v_bad_row, v_bad_code
      FROM _gi_rows r
     WHERE r.parse_refused AND NOT (COALESCE(r.parse_reason, '') = ANY (c_row_refusals))
     ORDER BY r.rowno LIMIT 1;
    IF v_bad_row IS NOT NULL THEN
        RAISE EXCEPTION 'staged row % is refused for a reason this import does not know', v_bad_row
            USING ERRCODE = '22023', DETAIL = 'game_import_staged_invalid';
    END IF;
    SELECT r.rowno INTO v_bad_row
      FROM _gi_rows r
     WHERE NOT r.parse_refused
       AND NOT (r.status IN ('ok', 'tbd') AND r.gdate IS NOT NULL AND r.week_index BETWEEN 1 AND 255
                AND COALESCE(r.row_key, '') <> '' AND COALESCE(char_length(r.game_id), 0) <= 40
                AND COALESCE(r.division_key, '') <> '' AND COALESCE(r.home_key, '') <> '' AND COALESCE(r.away_key, '') <> ''
                AND COALESCE(r.division_label, '') <> '' AND COALESCE(r.home_label, '') <> '' AND COALESCE(r.away_label, '') <> ''
                AND (CASE WHEN r.status = 'ok'
                          THEN r.start_time IS NOT NULL AND r.end_time IS NOT NULL AND r.start_ts IS NOT NULL AND r.end_ts IS NOT NULL
                               AND r.end_ts > r.start_ts AND COALESCE(r.venue_key, '') <> '' AND COALESCE(r.field_key, '') <> ''
                               AND COALESCE(r.venue_label, '') <> '' AND COALESCE(r.field_label, '') <> ''
                          ELSE r.start_ts IS NULL AND r.end_ts IS NULL END)
                -- 20261122010000: the parse's two warnings are staged flags now (a time that could not be read made the
                -- game a dated TIME TBD game; a Week that could not be stored was taken from the date), so they reach the
                -- saved result.
                AND r.flags <@ ARRAY['time-ambiguous', 'week-differs', 'bad-time', 'bad-week'])
     ORDER BY r.rowno LIMIT 1;
    IF v_bad_row IS NOT NULL THEN
        RAISE EXCEPTION 'staged row % is not a games row', v_bad_row
            USING ERRCODE = '22023', DETAIL = 'game_import_staged_invalid';
    END IF;

    -- ------------------------------------------------------------------ 2. What the admin decided, and what each label is.
    CREATE TEMP TABLE _gi_dec ON COMMIT DROP AS
    SELECT g.kind, e.key AS dkey, e.value ->> 'action' AS action,
           CASE WHEN e.value ->> 'action' = 'map'
                 AND e.value ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (e.value ->> 'id')::uuid END AS ref_id,
           NULLIF(btrim(e.value ->> 'name', E' \t\r\n'), '') AS dname
      FROM (VALUES ('division', 'divisions'), ('venue', 'venues'), ('field', 'fields'), ('team', 'teams')) AS g(kind, grp)
      CROSS JOIN LATERAL jsonb_each(COALESCE(v_map -> g.grp, '{}'::jsonb)) AS e(key, value)
     WHERE e.value ->> 'action' = ANY (CASE WHEN g.kind = 'team' THEN ARRAY['map', 'create', 'outside', 'skip']
                                            ELSE ARRAY['map', 'create', 'skip'] END);

    -- Divisions: of this season. A `create` over a name the season already has would meet UNIQUE (season, name), and so
    -- would two labels that create one name: those are ONE creation (the first label by key makes it, the others share its
    -- id), as core's resolveScheduleRows coalesces them. `creator` marks the label whose row writes the record.
    CREATE TEMP TABLE _gi_div ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.division_key AS dkey, (array_agg(r.division_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused GROUP BY r.division_key
    ), j AS (
        SELECT k.dkey, k.label, d.action,
               CASE WHEN d.action = 'map' THEN
                   (SELECT dv.id FROM public.divisions dv
                     WHERE dv.id = d.ref_id AND dv.organization_id = v_org AND dv.season_settings_id = v_season) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k LEFT JOIN _gi_dec d ON d.kind = 'division' AND d.dkey = k.dkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.divisions dv
                    WHERE dv.organization_id = v_org AND dv.season_settings_id = v_season
                      AND public.normalise_external_label(dv.name) = public.normalise_external_label(j.cname))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.dkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.dkey, k3.label, k3.action, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref,
           COALESCE((SELECT dv.name FROM public.divisions dv WHERE dv.id = k3.existing_id), CASE WHEN k3.can_create THEN k3.final_cname END) AS final_name
      FROM k3;

    -- Venues (locations of the organization).
    CREATE TEMP TABLE _gi_venue ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.venue_key AS vkey, (array_agg(r.venue_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused AND r.status = 'ok' GROUP BY r.venue_key
    ), j AS (
        SELECT k.vkey, k.label, d.action,
               CASE WHEN d.action = 'map' THEN
                   (SELECT l.id FROM public.locations l WHERE l.id = d.ref_id AND l.organization_id = v_org) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k LEFT JOIN _gi_dec d ON d.kind = 'venue' AND d.dkey = k.vkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND NOT EXISTS (SELECT 1 FROM public.locations l
                    WHERE l.organization_id = v_org AND public.normalise_external_label(l.name) = public.normalise_external_label(j.cname))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, public.normalise_external_label(k2.cname) ORDER BY k2.vkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.vkey, k3.label, k3.action, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref
      FROM k3;

    -- Fields, judged inside their venue.
    CREATE TEMP TABLE _gi_field ON COMMIT DROP AS
    WITH keys AS (
        SELECT r.field_key AS fkey, (array_agg(r.venue_key ORDER BY r.rowno))[1] AS vkey,
               (array_agg(r.field_label ORDER BY r.rowno))[1] AS label
          FROM _gi_rows r WHERE NOT r.parse_refused AND r.status = 'ok' GROUP BY r.field_key
    ), j AS (
        SELECT k.fkey, k.vkey, k.label, d.action, v.ref AS venue_ref, v.existing_id AS venue_existing,
               CASE WHEN d.action = 'map' AND v.existing_id IS NOT NULL THEN
                   (SELECT f.id FROM public.fields f
                     WHERE f.id = d.ref_id AND f.organization_id = v_org AND f.location_id = v.existing_id) END AS existing_id,
               CASE WHEN d.action = 'create' THEN COALESCE(d.dname, k.label) END AS cname
          FROM keys k
          LEFT JOIN _gi_dec d ON d.kind = 'field' AND d.dkey = k.fkey
          LEFT JOIN _gi_venue v ON v.vkey = k.vkey
    ), k2 AS (
        SELECT j.*,
               (j.action = 'create' AND j.venue_ref IS NOT NULL
                AND NOT (j.venue_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.fields f
                    WHERE f.location_id = j.venue_existing AND public.normalise_external_label(f.name) = public.normalise_external_label(j.cname)))) AS can_create,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               first_value(k2.own_id) OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) AS new_id,
               first_value(k2.cname) OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) AS final_cname,
               (k2.can_create AND row_number() OVER (PARTITION BY k2.can_create, k2.venue_ref, public.normalise_external_label(k2.cname) ORDER BY k2.fkey) = 1) AS creator
          FROM k2
    )
    SELECT k3.fkey, k3.vkey, k3.label, k3.action, k3.venue_ref, k3.existing_id, k3.final_cname AS cname, k3.can_create, k3.creator, k3.new_id,
           COALESCE(k3.existing_id, CASE WHEN k3.can_create THEN k3.new_id END) AS ref
      FROM k3;

    -- Teams, judged inside their division. kind: skip | existing | shell | ext-existing | ext-new | own-name | bad. Two labels
    -- that resolve to one new team (the same final name in the same resolved division) are ONE creation, shell or outside
    -- club, as core coalesces them; and an outside club whose name a shell created here already takes is the same refusal as
    -- one named like an own team (`own-name`), for UNIQUE (division_id, name) holds for both.
    CREATE TEMP TABLE _gi_team ON COMMIT DROP AS
    WITH keys AS (
        SELECT t.tkey, t.dkey, (array_agg(t.label ORDER BY t.rowno, t.side))[1] AS label
          FROM (SELECT r.home_key AS tkey, r.division_key AS dkey, r.home_label AS label, r.rowno, 1 AS side
                  FROM _gi_rows r WHERE NOT r.parse_refused
                UNION ALL
                SELECT r.away_key, r.division_key, r.away_label, r.rowno, 2
                  FROM _gi_rows r WHERE NOT r.parse_refused) t
         GROUP BY t.tkey, t.dkey
    ), j AS (
        SELECT k.tkey, k.dkey, k.label, d.action, d.ref_id, COALESCE(d.dname, k.label) AS cname,
               dv.ref AS division_ref, dv.existing_id AS division_existing
          FROM keys k
          LEFT JOIN _gi_dec d ON d.kind = 'team' AND d.dkey = k.tkey
          LEFT JOIN _gi_div dv ON dv.dkey = k.dkey
    ), k2 AS (
        SELECT j.*,
               CASE WHEN j.action = 'map' AND j.division_existing IS NOT NULL THEN
                   (SELECT t.id FROM public.teams t
                     WHERE t.id = j.ref_id AND t.organization_id = v_org AND t.division_id = j.division_existing) END AS map_id,
               (j.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                    WHERE t.division_id = j.division_existing AND NOT t.is_external
                      AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS own_named,
               (SELECT t.id FROM public.teams t
                 WHERE j.division_existing IS NOT NULL AND t.division_id = j.division_existing AND t.is_external
                   AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname) ORDER BY t.id LIMIT 1) AS ext_id,
               (j.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                    WHERE t.division_id = j.division_existing AND public.normalise_external_label(t.name) = public.normalise_external_label(j.cname))) AS name_taken,
               (j.action = 'outside' AND j.division_ref IS NOT NULL AND EXISTS (SELECT 1 FROM j j2
                    WHERE j2.action = 'create' AND j2.division_ref = j.division_ref AND public.normalise_external_label(j2.cname) = public.normalise_external_label(j.cname)
                      AND NOT (j2.division_existing IS NOT NULL AND EXISTS (SELECT 1 FROM public.teams t
                                WHERE t.division_id = j2.division_existing AND public.normalise_external_label(t.name) = public.normalise_external_label(j2.cname))))) AS shell_here,
               gen_random_uuid() AS own_id
          FROM j
    ), k3 AS (
        SELECT k2.*,
               CASE
                   WHEN k2.action = 'skip' THEN 'skip'
                   WHEN k2.action = 'map' AND k2.map_id IS NOT NULL THEN 'existing'
                   WHEN k2.action = 'create' AND k2.division_ref IS NOT NULL AND NOT k2.name_taken THEN 'shell'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL AND (k2.own_named OR k2.shell_here) THEN 'own-name'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL AND k2.ext_id IS NOT NULL THEN 'ext-existing'
                   WHEN k2.action = 'outside' AND k2.division_ref IS NOT NULL THEN 'ext-new'
                   ELSE 'bad'
               END AS kind
          FROM k2
    ), k4 AS (
        SELECT k3.*,
               first_value(k3.own_id) OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) AS new_id,
               first_value(k3.cname) OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) AS final_cname,
               (row_number() OVER (PARTITION BY k3.kind, k3.division_ref, public.normalise_external_label(k3.cname) ORDER BY k3.tkey) = 1) AS creator
          FROM k3
    )
    SELECT k4.tkey, k4.dkey, k4.label, k4.action, k4.kind,
           CASE WHEN k4.kind IN ('shell', 'ext-new') THEN k4.final_cname ELSE k4.cname END AS cname, k4.division_ref, k4.new_id,
           (k4.kind IN ('shell', 'ext-new') AND k4.creator) AS creator,
           CASE k4.kind WHEN 'existing' THEN k4.map_id WHEN 'ext-existing' THEN k4.ext_id
                        WHEN 'shell' THEN k4.new_id WHEN 'ext-new' THEN k4.new_id END AS ref,
           (k4.kind IN ('ext-existing', 'ext-new')
            OR (k4.kind = 'existing' AND EXISTS (SELECT 1 FROM public.teams t WHERE t.id = k4.map_id AND t.is_external))) AS is_outside
      FROM k4;

    -- ------------------------------------------------------------------ 3. Each row, resolved, in the order core does it.
    CREATE TEMP TABLE _gi_res ON COMMIT DROP AS
    SELECT r.*,
           dv.ref AS division_ref, dv.final_name AS division_name, v.ref AS venue_ref, f.ref AS field_ref,
           th.ref AS home_ref, ta.ref AS away_ref, th.is_outside AS home_out, ta.is_outside AS away_out,
           CASE
               WHEN r.parse_refused THEN 'refused:' || r.parse_reason
               WHEN dv.action = 'skip' THEN 'skipped:division'
               WHEN dv.ref IS NULL THEN 'refused:unknown-division'
               WHEN r.status = 'ok' AND v.action = 'skip' THEN 'skipped:venue'
               WHEN r.status = 'ok' AND v.ref IS NULL THEN 'refused:unknown-venue'
               WHEN r.status = 'ok' AND f.action = 'skip' THEN 'skipped:field'
               WHEN r.status = 'ok' AND f.ref IS NULL THEN 'refused:unknown-field'
               WHEN th.kind = 'skip' THEN 'skipped:team'
               WHEN th.kind = 'own-name' THEN 'refused:label-is-own-team'
               WHEN th.ref IS NULL THEN 'refused:unknown-team'
               WHEN ta.kind = 'skip' THEN 'skipped:team'
               WHEN ta.kind = 'own-name' THEN 'refused:label-is-own-team'
               WHEN ta.ref IS NULL THEN 'refused:unknown-team'
               WHEN th.is_outside AND ta.is_outside THEN 'refused:unknown-team'
               WHEN th.ref = ta.ref THEN 'refused:same-team'
               ELSE 'ok'
           END AS outcome,
           CASE
               WHEN dv.action = 'skip' THEN r.division_label
               WHEN r.status = 'ok' AND v.action = 'skip' THEN r.venue_label
               WHEN r.status = 'ok' AND f.action = 'skip' THEN r.field_label
               WHEN th.kind = 'skip' THEN r.home_label
               WHEN ta.kind = 'skip' THEN r.away_label
           END AS skip_label
      FROM _gi_rows r
      LEFT JOIN _gi_div dv ON dv.dkey = r.division_key
      LEFT JOIN _gi_venue v ON v.vkey = r.venue_key AND r.status = 'ok'
      LEFT JOIN _gi_field f ON f.fkey = r.field_key AND r.status = 'ok'
      LEFT JOIN _gi_team th ON th.tkey = r.home_key AND th.dkey = r.division_key
      LEFT JOIN _gi_team ta ON ta.tkey = r.away_key AND ta.dkey = r.division_key;

    -- The same game twice by the admin's own mapping (two labels mapped onto one team): the first row wins. A TIME TBD
    -- game is one row per (home, away, week) in the table, so a second is refused as a duplicate too. Then one Game ID on
    -- two different games: the first wins.
    CREATE TEMP TABLE _gi_work ON COMMIT DROP AS
    SELECT x.*,
           CASE WHEN x.outcome = 'ok' AND x.dup_rank > 1 THEN 'refused:duplicate-row'
                WHEN x.outcome = 'ok' AND x.game_id IS NOT NULL AND x.gid_rank > 1 THEN 'refused:game-id-reused'
                ELSE x.outcome END AS final_outcome
      FROM (
        SELECT d.*,
               CASE WHEN d.outcome = 'ok' AND d.dup_rank = 1 AND d.game_id IS NOT NULL
                    THEN row_number() OVER (PARTITION BY d.game_id, (d.outcome = 'ok' AND d.dup_rank = 1) ORDER BY d.rowno) END AS gid_rank
          FROM (
            SELECT r.*,
                   CASE WHEN r.outcome = 'ok' THEN row_number() OVER (
                        PARTITION BY (r.outcome = 'ok'), CASE WHEN r.status = 'ok'
                                          THEN concat_ws('|', 'ok', r.home_ref, r.away_ref, r.field_ref, r.gdate, r.start_time)
                                          ELSE concat_ws('|', 'tbd', r.home_ref, r.away_ref, r.week_index) END
                        ORDER BY r.rowno) END AS dup_rank
              FROM _gi_res r) d) x;

    -- ------------------------------------------------------------------ 4. Placed games: the slot, the match, the verdict.
    CREATE TEMP TABLE _gi_g ON COMMIT DROP AS
    WITH base AS (
        SELECT w.rowno, w.row_key, w.game_id, w.home_ref, w.away_ref, w.field_ref, w.gdate, w.start_time, w.end_time,
               w.start_ts, w.end_ts, w.week_index, w.flags, w.division_ref, w.division_name,
               s.id AS slot_id, s.week_index AS slot_week,
               m.id AS match_id
          FROM _gi_work w
          LEFT JOIN LATERAL (SELECT gs.id, gs.week_index FROM public.game_slots gs
                              WHERE gs.organization_id = v_org AND gs.field_id = w.field_ref
                                AND gs.slot_date = w.gdate AND gs.start_time = w.start_time
                              ORDER BY gs.created_at, gs.id LIMIT 1) s ON true
          LEFT JOIN LATERAL (SELECT ga.id FROM public.game_assignments ga
                              WHERE ga.organization_id = v_org
                                AND CASE WHEN w.game_id IS NOT NULL
                                         THEN ga.season_settings_id = v_season AND ga.external_ref = w.game_id
                                         ELSE s.id IS NOT NULL AND ga.home_team_id = w.home_ref AND ga.away_team_id = w.away_ref
                                              AND ga.game_slot_id = s.id AND ga.week_index = w.week_index END
                              LIMIT 1) m ON true
         WHERE w.final_outcome = 'ok' AND w.status = 'ok'
    )
    SELECT b.*, ga.run_id AS m_run, ga.published AS m_published,
           (ga.id IS NOT NULL) AS matched,
           (ga.id IS NOT NULL
            AND ga.field_id IS NOT DISTINCT FROM b.field_ref AND ga.home_team_id = b.home_ref AND ga.away_team_id = b.away_ref
            AND ga.week_index IS NOT DISTINCT FROM b.week_index AND ga.start IS NOT DISTINCT FROM b.start_ts
            AND ga."end" IS NOT DISTINCT FROM b.end_ts AND ga.division IS NOT DISTINCT FROM b.division_name
            AND gsm.slot_date IS NOT DISTINCT FROM b.gdate AND gsm.start_time IS NOT DISTINCT FROM b.start_time) AS same,
           -- The game this row names stands on a place (home, away, slot, week) that is not the one the row puts it on: if the
           -- row is written, the game LEAVES its place. (A game that changes only its division label does not.)
           (ga.id IS NOT NULL
            AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
                IS DISTINCT FROM (b.home_ref, b.away_ref, b.slot_id, b.week_index)) AS leaves
      FROM base b
      LEFT JOIN public.game_assignments ga ON ga.id = b.match_id
      LEFT JOIN public.game_slots gsm ON gsm.id = ga.game_slot_id;

    -- TIME TBD games: a date and no time (the staged row has no instants, and a game with no field has no slot). A row is
    -- found by (season, Game ID) FIRST, in the table's own `external_ref`; a row with no Game ID, and a row whose Game ID
    -- no TIME TBD game carries yet but whose (home, away, week) one does that has no Game ID of its own, is found by the
    -- tuple, as the placed games are. `c_id` is another TIME TBD game that already holds the tuple this row would stand
    -- on (the table is unique on it): a different game, so the row is refused as a duplicate. `ga_id` is the placed game
    -- the row's Game ID names: the file now says it has no time.
    CREATE TEMP TABLE _gi_t ON COMMIT DROP AS
    SELECT w.rowno, w.row_key, w.game_id, w.home_ref, w.away_ref, w.week_index, w.division_ref, w.gdate, w.tbd_reason, w.flags,
           m.id AS m_id, m.external_ref AS m_ref, m.game_date AS m_date, m.week_index AS m_week, m.division_id AS m_div,
           m.home_team_id AS m_home, m.away_team_id AS m_away, m.reason AS m_reason,
           c.id AS c_id, a.id AS ga_id, gen_random_uuid() AS new_id
      FROM _gi_work w
      LEFT JOIN LATERAL (SELECT s.* FROM public.schedule_tbd s
                          WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'game'
                            AND ((w.game_id IS NOT NULL AND s.external_ref = w.game_id)
                                 OR (s.home_team_id = w.home_ref AND s.away_team_id = w.away_ref AND s.week_index = w.week_index
                                     AND (w.game_id IS NULL OR s.external_ref IS NULL)))
                          ORDER BY (s.external_ref IS NOT DISTINCT FROM w.game_id) DESC, s.id LIMIT 1) m ON true
      LEFT JOIN LATERAL (SELECT s.id FROM public.schedule_tbd s
                          WHERE s.season_settings_id = v_season AND s.kind = 'game'
                            AND s.home_team_id = w.home_ref AND s.away_team_id = w.away_ref AND s.week_index = w.week_index
                            AND s.id IS DISTINCT FROM m.id LIMIT 1) c ON true
      LEFT JOIN LATERAL (SELECT ga.id FROM public.game_assignments ga
                          WHERE w.game_id IS NOT NULL AND ga.organization_id = v_org AND ga.season_settings_id = v_season
                            AND ga.external_ref = w.game_id LIMIT 1) a ON true
     WHERE w.final_outcome = 'ok' AND w.status = 'tbd';

    -- The one predicate: a game is held where it is (F11-1's game_held_ids; F11-2 adds a score). The games a row names, a
    -- placed one or one a TIME TBD row would take out.
    SELECT COALESCE(array_agg(DISTINCT x.id), ARRAY[]::uuid[]) INTO v_held
      FROM (SELECT g.match_id AS id FROM _gi_g g UNION SELECT t.ga_id FROM _gi_t t) x WHERE x.id IS NOT NULL;
    v_held := ARRAY(SELECT public.game_held_ids(v_held));
    -- 20261122010000: which of the held games are held by a score and not Published (the words of the skip, nothing else:
    -- whether a game is held is v_held, the one predicate's answer).
    v_held_scored := ARRAY(SELECT h FROM unnest(v_held) AS h WHERE public.game_hold_code(h) = 'game_scored');

    ALTER TABLE _gi_g ADD COLUMN verdict text, ADD COLUMN new_id uuid DEFAULT gen_random_uuid(), ADD COLUMN slot_final uuid, ADD COLUMN flagged text[],
                      ADD COLUMN tbd_id uuid, ADD COLUMN swapped_with uuid, ADD COLUMN dup_target boolean DEFAULT false, ADD COLUMN carry_ref text;
    UPDATE _gi_g g SET verdict = CASE
            WHEN NOT g.matched THEN 'insert'
            WHEN g.same THEN 'unchanged'
            WHEN g.match_id = ANY (v_held) THEN 'skip-held'
            ELSE 'update' END;

    -- The TIME TBD rows' verdicts. A placed game of the Game ID that is held (Published) is not taken out: the row is
    -- skipped, as a held game's row that changed is. Another game on the tuple refuses the row.
    ALTER TABLE _gi_t ADD COLUMN verdict text, ADD COLUMN conv boolean, ADD COLUMN dup_target boolean DEFAULT false;
    UPDATE _gi_t t SET verdict = CASE
            WHEN t.ga_id IS NOT NULL AND t.ga_id = ANY (v_held) THEN 'skip-held'
            WHEN t.c_id IS NOT NULL THEN 'conflict'
            WHEN t.m_id IS NULL THEN 'insert'
            WHEN t.m_date IS NOT DISTINCT FROM t.gdate AND t.m_week = t.week_index AND t.m_div = t.division_ref
                 AND t.m_home = t.home_ref AND t.m_away = t.away_ref AND t.m_ref IS NOT DISTINCT FROM COALESCE(t.game_id, t.m_ref)
                 AND t.m_reason = 'imported-without-time' THEN 'unchanged'
            ELSE 'update' END;

    -- Two rows of the file that resolve to ONE saved record (Codex on e699b1f): a row with no Game ID finds a saved game by
    -- its teams, place and week, and another row finds the same game by its Game ID (or names it to take it out, or both
    -- find one TIME TBD game). One record cannot be written twice (the apply's own row count raised, and the whole import
    -- went with it), so this is a plan the apply cannot execute and a NECESSARY refusal: the row that carries the Game ID
    -- is kept (then the earlier row of the file), and every other row that names the record is refused `duplicate-row`
    -- in words that say so, in the preview as in the apply. A claim is a saved game (a placed row's match, or the game a
    -- TIME TBD row's Game ID names) or a saved TIME TBD game (a TIME TBD row's match).
    WITH claim AS (
        SELECT 'game' AS kind, g.match_id AS target, g.rowno, (g.game_id IS NOT NULL) AS by_id, 'g' AS src FROM _gi_g g WHERE g.match_id IS NOT NULL
        UNION ALL
        SELECT 'game', t.ga_id, t.rowno, true, 't' FROM _gi_t t WHERE t.ga_id IS NOT NULL AND t.verdict <> 'conflict'
        UNION ALL
        SELECT 'tbd', t.m_id, t.rowno, (t.game_id IS NOT NULL AND t.m_ref IS NOT DISTINCT FROM t.game_id), 't' FROM _gi_t t
         WHERE t.m_id IS NOT NULL AND t.verdict <> 'conflict'
    ), lose AS (
        SELECT DISTINCT q.src, q.rowno
          FROM (SELECT c.*, row_number() OVER (PARTITION BY c.kind, c.target ORDER BY c.by_id DESC, c.rowno) AS rn FROM claim c) q
         WHERE q.rn > 1
    ), lost_g AS (
        UPDATE _gi_g g SET verdict = 'collision', dup_target = true FROM lose l WHERE l.src = 'g' AND l.rowno = g.rowno RETURNING 1
    )
    UPDATE _gi_t t SET verdict = 'conflict', dup_target = true FROM lose l WHERE l.src = 't' AND l.rowno = t.rowno;
    UPDATE _gi_t t SET conv = (t.ga_id IS NOT NULL AND t.verdict NOT IN ('skip-held', 'conflict'));

    -- Another game already stands on the place a row would put its game ((home, away, slot, week) is unique): that is a
    -- refusal of the row, the same word as a duplicate, UNLESS the game standing there is one the file itself moves away
    -- (a row that names it, and writes it, to another place): then the row is written after that game has left, and it is
    -- a warning, `games-swapped`. A game that moves is judged against the games the file does NOT move, so a row that
    -- cannot be written (its own place is taken) is not counted among the movers, and the rows that depended on it are
    -- judged again, until no row changes: collisions only ever grow, so this ends. A placed game the file now gives no time
    -- is taken out of the schedule, so it leaves its place too.
    LOOP
        UPDATE _gi_g g SET verdict = 'collision'
         WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.game_assignments g2
                        WHERE g2.home_team_id = g.home_ref AND g2.away_team_id = g.away_ref AND g2.game_slot_id = g.slot_id
                          AND g2.week_index = g.week_index AND g2.id IS DISTINCT FROM g.match_id
                          AND g2.id NOT IN (SELECT x.match_id FROM _gi_g x WHERE x.verdict = 'update' AND x.leaves)
                          AND g2.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        EXIT WHEN v_rc = 0;
    END LOOP;
    -- The rows that take the place of a game this file moves away, named for the warning.
    UPDATE _gi_g g SET swapped_with = (SELECT g2.id FROM public.game_assignments g2
                                        WHERE g2.home_team_id = g.home_ref AND g2.away_team_id = g.away_ref AND g2.game_slot_id = g.slot_id
                                          AND g2.week_index = g.week_index AND g2.id IS DISTINCT FROM g.match_id
                                          AND (g2.id IN (SELECT x.match_id FROM _gi_g x WHERE x.verdict = 'update' AND x.leaves)
                                               OR g2.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv))
                                        LIMIT 1)
     WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NOT NULL;

    -- A TIME TBD row the file now places: the game it names is written (a new or updated placed game) and the row goes.
    UPDATE _gi_g g SET tbd_id = (SELECT s.id FROM public.schedule_tbd s
                                  WHERE s.organization_id = v_org AND s.season_settings_id = v_season AND s.kind = 'game'
                                    AND ((g.game_id IS NOT NULL AND s.external_ref = g.game_id)
                                         OR (s.home_team_id = g.home_ref AND s.away_team_id = g.away_ref AND s.week_index = g.week_index
                                             AND (g.game_id IS NULL OR s.external_ref IS NULL)))
                                  ORDER BY (s.external_ref IS NOT DISTINCT FROM g.game_id) DESC, s.id LIMIT 1)
     WHERE g.verdict IN ('insert', 'update');
    -- One TIME TBD game is placed by ONE row: when two rows of the file would both take it (two games of one pair in one
    -- week, neither with a Game ID), the row that carries its Game ID, then the earlier row, is the game it becomes and
    -- the other is simply a new game.
    UPDATE _gi_g g SET tbd_id = NULL
     WHERE g.tbd_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM _gi_g o WHERE o.tbd_id = g.tbd_id AND o.rowno <> g.rowno AND o.verdict IN ('insert', 'update')
                      AND ((o.game_id IS NOT NULL), -o.rowno) > ((g.game_id IS NOT NULL), -g.rowno));
    -- An identifier a matched record already carries is never erased by a row that omits it (Codex on e699b1f): a TIME TBD
    -- game with a Game ID that a row with NO Game ID places becomes a placed game with that Game ID, so a later row that
    -- carries it finds the game instead of writing a second one. (The other matches keep theirs already: a placed game
    -- changed in place is not given the row's Game ID, and a TIME TBD game changed in place keeps its own when the row has
    -- none.) Not when the TIME TBD row stays (a TIME TBD row of the file writes it), nor when a game already has the Game ID.
    UPDATE _gi_g g SET carry_ref = s.external_ref
      FROM public.schedule_tbd s
     WHERE g.verdict = 'insert' AND g.game_id IS NULL AND s.id = g.tbd_id AND s.external_ref IS NOT NULL
       AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged'))
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.season_settings_id = v_season AND ga.external_ref = s.external_ref)
       AND NOT EXISTS (SELECT 1 FROM _gi_g o WHERE o.game_id = s.external_ref AND o.verdict = 'insert');

    -- The invariant of the plan, checked where the plan ends and before anything is counted: no saved record is named
    -- twice among the rows that are kept. A plan that broke it would be refused here, in the preview too, never half-applied.
    IF EXISTS (SELECT 1 FROM (SELECT g.match_id AS id FROM _gi_g g WHERE g.match_id IS NOT NULL AND g.verdict <> 'collision'
                              UNION ALL SELECT t.ga_id FROM _gi_t t WHERE t.ga_id IS NOT NULL AND t.verdict <> 'conflict') x
                GROUP BY x.id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict <> 'conflict' GROUP BY t.m_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM _gi_g g WHERE g.tbd_id IS NOT NULL AND g.verdict IN ('insert', 'update') GROUP BY g.tbd_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'game import plan names one saved record in two rows' USING ERRCODE = 'XX000';
    END IF;

    -- New slots: one per place no slot stands on yet, among the rows that write (a skipped or unchanged game makes none).
    CREATE TEMP TABLE _gi_slotnew ON COMMIT DROP AS
    SELECT g.field_ref AS field_id, g.gdate, g.start_time,
           (array_agg(g.end_time ORDER BY g.rowno))[1] AS end_time,
           (array_agg(g.start_ts ORDER BY g.rowno))[1] AS start_ts,
           (array_agg(g.end_ts ORDER BY g.rowno))[1] AS end_ts,
           (array_agg(g.week_index ORDER BY g.rowno))[1] AS week_index,
           gen_random_uuid() AS new_id
      FROM _gi_g g
     WHERE g.verdict IN ('insert', 'update') AND g.slot_id IS NULL
     GROUP BY g.field_ref, g.gdate, g.start_time;
    UPDATE _gi_g g SET slot_final = COALESCE(g.slot_id, (SELECT s.new_id FROM _gi_slotnew s
                                                          WHERE s.field_id = g.field_ref AND s.gdate = g.gdate AND s.start_time = g.start_time))
     WHERE g.verdict IN ('insert', 'update');
    UPDATE _gi_g g SET flagged = g.flags
                         || CASE WHEN g.slot_id IS NOT NULL AND g.slot_week IS DISTINCT FROM g.week_index
                                  AND NOT ('week-differs' = ANY (g.flags)) THEN ARRAY['week-differs'] ELSE ARRAY[]::text[] END
     WHERE g.verdict IN ('insert', 'update');

    -- ------------------------------------------------------------------ 5. The schedule it makes, and what is carried.
    SELECT sr.id INTO v_prev_run
      FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'game' AND sr.status = 'completed'
       AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
     ORDER BY sr.completed_at DESC, sr.created_at DESC
     LIMIT 1;

    SELECT count(*) FILTER (WHERE verdict = 'insert'), count(*) FILTER (WHERE verdict = 'update'),
           count(*) FILTER (WHERE verdict = 'unchanged'), count(*) FILTER (WHERE verdict = 'skip-held')
      INTO n_ins, n_upd, n_unch, n_skip_pub
      FROM _gi_g;
    SELECT count(*) FILTER (WHERE verdict = 'insert'), count(*) FILTER (WHERE verdict = 'update'),
           count(*) FILTER (WHERE verdict = 'unchanged'), count(*) FILTER (WHERE verdict = 'conflict'),
           count(*) FILTER (WHERE verdict = 'skip-held'), count(*) FILTER (WHERE conv)
      INTO n_tbd_ins, n_tbd_upd, n_tbd_unch, n_tbd_conflict, n_tbd_held, n_conv
      FROM _gi_t;
    -- TIME TBD rows the file now places: one per row, however many placed rows name it.
    SELECT count(DISTINCT g.tbd_id) INTO n_tbd_rem FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.tbd_id IS NOT NULL
       AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged'));
    n_skip_pub := n_skip_pub + n_tbd_held;

    -- A matched game the file leaves as it is or skips, but that is not in the latest run, becomes visible again.
    SELECT count(*) INTO n_hidden FROM _gi_g g
     WHERE g.verdict IN ('unchanged', 'skip-held') AND g.m_run IS DISTINCT FROM v_prev_run;
    n_hidden := n_hidden + (SELECT count(*) FROM public.game_assignments ga
                             WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') AND ga.run_id IS DISTINCT FROM v_prev_run);
    v_work := n_ins + n_upd + n_tbd_ins + n_tbd_upd + n_tbd_rem + n_conv + n_hidden;
    v_nothing := (v_work = 0);

    -- Carried into the new run without a write to the game but its run: every game of the previous latest run that is
    -- not rewritten, and every hidden game the file found. Nothing is carried when there is nothing to apply.
    CREATE TEMP TABLE _gi_carry ON COMMIT DROP AS
    SELECT ga.id
      FROM public.game_assignments ga
     WHERE NOT v_nothing AND ga.organization_id = v_org
       AND ((v_prev_run IS NOT NULL AND ga.run_id = v_prev_run)
            OR ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict IN ('unchanged', 'skip-held'))
            OR ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held'))
       AND ga.id NOT IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update')
       AND ga.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
    SELECT count(*) INTO n_repoint FROM _gi_carry;

    -- The games the previous run held that no row of the file names (listed, never deleted).
    SELECT count(*), COALESCE(jsonb_agg(x.id ORDER BY x.id) FILTER (WHERE x.rn <= c_listed_ids), '[]'::jsonb)
      INTO n_not_in_file, v_not_in_file
      FROM (SELECT ga.id, row_number() OVER (ORDER BY ga.id) AS rn
              FROM public.game_assignments ga
             WHERE v_prev_run IS NOT NULL AND ga.organization_id = v_org AND ga.run_id = v_prev_run
               AND ga.id NOT IN (SELECT g.match_id FROM _gi_g g WHERE g.match_id IS NOT NULL AND g.verdict <> 'collision')
               AND ga.id NOT IN (SELECT t.ga_id FROM _gi_t t WHERE t.ga_id IS NOT NULL)) x;

    -- The schedule the new run holds, for the conflict flags: carried games as they are, rewritten ones as they will be,
    -- new ones as planned.
    CREATE TEMP TABLE _gi_final ON COMMIT DROP AS
    SELECT ga.id AS gid, NULL::text AS rkey, 'g:' || ga.id::text AS skey, ga.field_id, ga.start, ga."end" AS finish,
           ga.home_team_id AS home_id, ga.away_team_id AS away_id, ga.week_index, ga.division
      FROM public.game_assignments ga JOIN _gi_carry c ON c.id = ga.id
    UNION ALL
    SELECT g.match_id, g.row_key, 'g:' || g.match_id::text, g.field_ref, g.start_ts, g.end_ts, g.home_ref, g.away_ref, g.week_index, g.division_name
      FROM _gi_g g WHERE NOT v_nothing AND g.verdict = 'update'
    UNION ALL
    SELECT NULL::uuid, g.row_key, 'r:' || lpad(g.rowno::text, 8, '0'), g.field_ref, g.start_ts, g.end_ts, g.home_ref, g.away_ref, g.week_index, g.division_name
      FROM _gi_g g WHERE NOT v_nothing AND g.verdict = 'insert';

    -- ------------------------------------------------------------------ 6. What would be created, only what a written row uses.
    CREATE TEMP TABLE _gi_newgames ON COMMIT DROP AS
    SELECT g.division_ref, g.field_ref, g.home_ref, g.away_ref FROM _gi_g g WHERE g.verdict IN ('insert', 'update')
    UNION ALL
    SELECT t.division_ref, NULL, t.home_ref, t.away_ref FROM _gi_t t WHERE t.verdict IN ('insert', 'update');

    SELECT count(*) INTO n_div FROM _gi_div d WHERE d.creator AND d.new_id IN (SELECT division_ref FROM _gi_newgames);
    SELECT count(*) INTO n_fld FROM _gi_field f WHERE f.creator AND f.new_id IN (SELECT field_ref FROM _gi_newgames);
    SELECT count(*) INTO n_ven FROM _gi_venue v WHERE v.creator
       AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames));
    SELECT count(*) FILTER (WHERE t.kind = 'shell' AND t.creator), count(*) FILTER (WHERE t.kind = 'ext-new' AND t.creator) INTO n_shell, n_out
      FROM _gi_team t WHERE t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
    SELECT count(*) INTO n_slot_new FROM _gi_slotnew;
    SELECT count(DISTINCT g.slot_id) INTO n_slot_reused FROM _gi_g g
     WHERE g.verdict IN ('insert', 'update', 'unchanged') AND g.slot_id IS NOT NULL;

    -- ------------------------------------------------------------------ 7. The conflict flags the SQL can judge.
    -- The first overlap per field and per own team, as evaluateGameSchedule finds it: games sorted by start, each judged
    -- against the one before. An outside club merges several real teams, so it is never double-booked.
    v_warnings := '[]'::jsonb;
    IF NOT v_nothing THEN
        WITH seq AS (
            SELECT f.field_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division,
                   lag(f.gid) OVER w AS pgid, lag(f.rkey) OVER w AS prkey, lag(f.start) OVER w AS pstart,
                   lag(f.finish) OVER w AS pfinish, lag(f.week_index) OVER w AS pweek, lag(f.division) OVER w AS pdiv
              FROM _gi_final f
             WHERE f.field_id IS NOT NULL AND f.start IS NOT NULL AND f.finish IS NOT NULL
            WINDOW w AS (PARTITION BY f.field_id ORDER BY f.start, f.skey)
        ), first_overlap AS (
            SELECT DISTINCT ON (s.field_id) s.* FROM seq s WHERE s.pfinish IS NOT NULL AND s.start < s.pfinish
             ORDER BY s.field_id, s.start, s.skey
        ), sides AS (
            SELECT f.home_id AS team_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division FROM _gi_final f
            UNION ALL
            SELECT f.away_id, f.gid, f.rkey, f.skey, f.start, f.finish, f.week_index, f.division FROM _gi_final f
        ), tseq AS (
            SELECT s.team_id, s.gid, s.rkey, s.skey, s.start, s.finish, s.week_index, s.division,
                   lag(s.gid) OVER w AS pgid, lag(s.rkey) OVER w AS prkey, lag(s.start) OVER w AS pstart,
                   lag(s.finish) OVER w AS pfinish, lag(s.week_index) OVER w AS pweek, lag(s.division) OVER w AS pdiv
              FROM sides s
             WHERE s.start IS NOT NULL AND s.finish IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = s.team_id AND t.is_external)
               AND s.team_id NOT IN (SELECT t.ref FROM _gi_team t WHERE t.kind = 'ext-new')
            WINDOW w AS (PARTITION BY s.team_id ORDER BY s.start, s.skey)
        ), team_overlap AS (
            SELECT DISTINCT ON (t.team_id) t.* FROM tseq t WHERE t.pfinish IS NOT NULL AND t.start < t.pfinish
             ORDER BY t.team_id, t.start, t.skey
        ), flag_rows AS (
            SELECT g.rowno, g.row_key, g.game_id, g.gdate, fl AS flag
              FROM _gi_g g, LATERAL unnest(g.flagged) AS fl
             WHERE g.verdict IN ('insert', 'update')
            UNION ALL
            -- A TIME TBD game's week is judged against its date as a placed game's is: the file's week is kept, and said.
            SELECT t.rowno, t.row_key, t.game_id, t.gdate, fl
              FROM _gi_t t, LATERAL unnest(t.flags) AS fl
             WHERE t.verdict IN ('insert', 'update')
        )
        SELECT COALESCE(jsonb_agg(w.warning ORDER BY w.sort_type, w.sort_key), '[]'::jsonb) INTO v_warnings
          FROM (
            SELECT 1 AS sort_type, o.field_id::text AS sort_key,
                   jsonb_build_object('type', 'field-overlap', 'message', format('Field %s has overlapping games', o.field_id),
                       'details', jsonb_build_object('fieldId', o.field_id, 'conflicts', jsonb_build_array(
                           jsonb_build_object('gameId', o.pgid, 'rowKey', o.prkey, 'start', o.pstart, 'end', o.pfinish, 'weekIndex', o.pweek, 'division', o.pdiv),
                           jsonb_build_object('gameId', o.gid, 'rowKey', o.rkey, 'start', o.start, 'end', o.finish, 'weekIndex', o.week_index, 'division', o.division)))) AS warning
              FROM first_overlap o
            UNION ALL
            SELECT 2, o.team_id::text,
                   jsonb_build_object('type', 'team-double-booked', 'message', format('Team %s has overlapping games', o.team_id),
                       'details', jsonb_build_object('teamId', o.team_id, 'conflicts', jsonb_build_array(
                           jsonb_build_object('gameId', o.pgid, 'rowKey', o.prkey, 'start', o.pstart, 'end', o.pfinish, 'weekIndex', o.pweek, 'division', o.pdiv, 'teamId', o.team_id),
                           jsonb_build_object('gameId', o.gid, 'rowKey', o.rkey, 'start', o.start, 'end', o.finish, 'weekIndex', o.week_index, 'division', o.division, 'teamId', o.team_id))))
              FROM team_overlap o
            UNION ALL
            SELECT CASE fr.flag WHEN 'time-ambiguous' THEN 3 ELSE 4 END, lpad(fr.rowno::text, 8, '0'),
                   jsonb_build_object('type', fr.flag,
                       'message', CASE fr.flag WHEN 'time-ambiguous' THEN 'The clocks repeat this time on its date; the first occurrence was taken.'
                                               WHEN 'bad-time' THEN 'The time could not be read: the game is a TIME TBD game on its date.'
                                               WHEN 'bad-week' THEN 'The Week could not be read or stored: the week was taken from the date.'
                                               ELSE 'The week is not the week the date falls in.' END,
                       'details', jsonb_build_object('rowKey', fr.row_key, 'gameId', fr.game_id, 'date', fr.gdate))
              FROM flag_rows fr
            UNION ALL
            -- A game moved onto the place of a game this same file moves away (a swap, or a chain of moves): written, in an
            -- order the unique place allows, and said.
            SELECT 5, lpad(g.rowno::text, 8, '0'),
                   jsonb_build_object('type', 'games-swapped',
                       'message', 'This game takes the place of a game the file moves away: both are written.',
                       'details', jsonb_build_object('rowKey', g.row_key, 'gameId', g.game_id, 'takesPlaceOf', g.swapped_with))
              FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.swapped_with IS NOT NULL
            UNION ALL
            -- A placed game the file now says has no time: taken out, and a dated TIME TBD game stands for it.
            SELECT 6, lpad(t.rowno::text, 8, '0'),
                   jsonb_build_object('type', 'game-made-time-tbd',
                       'message', 'The file gives this game a date and no time: it is no longer placed, and stands on the TIME TBD list.',
                       'details', jsonb_build_object('rowKey', t.row_key, 'gameId', t.game_id, 'game', t.ga_id, 'date', t.gdate))
              FROM _gi_t t WHERE t.conv) w;
    END IF;

    -- ------------------------------------------------------------------ 8. The answer, from the plan.
    SELECT count(*) FILTER (WHERE final_outcome LIKE 'refused:%'), count(*) FILTER (WHERE final_outcome LIKE 'skipped:%'),
           count(*) FILTER (WHERE final_outcome = 'ok' AND status = 'ok'), count(*) FILTER (WHERE final_outcome = 'ok' AND status = 'tbd')
      INTO n_refused, n_skipped, n_ok, n_tbd
      FROM _gi_work;
    -- A placed row another game's place refuses is refused too (listed, counted, nothing written for it).
    n_refused := n_refused + (SELECT count(*) FROM _gi_g WHERE verdict = 'collision') + n_tbd_conflict;
    n_ok := n_ok - (SELECT count(*) FROM _gi_g WHERE verdict = 'collision');
    n_tbd := n_tbd - n_tbd_conflict;

    SELECT COALESCE(jsonb_object_agg(x.reason, x.n), '{}'::jsonb) INTO v_refused_by_reason
      FROM (SELECT z.reason, count(*) AS n FROM (
                SELECT substr(w.final_outcome, 9) AS reason FROM _gi_work w WHERE w.final_outcome LIKE 'refused:%'
                UNION ALL
                SELECT 'duplicate-row' FROM _gi_g g WHERE g.verdict = 'collision'
                UNION ALL
                SELECT 'duplicate-row' FROM _gi_t t WHERE t.verdict = 'conflict') z GROUP BY z.reason) x;

    SELECT COALESCE(jsonb_agg(x.item ORDER BY x.rowno) FILTER (WHERE x.rn <= c_listed), '[]'::jsonb) INTO v_listed_refused
      FROM (SELECT z.rowno, z.item, row_number() OVER (ORDER BY z.rowno) AS rn FROM (
                SELECT w.rowno,
                       jsonb_build_object('row_number', w.rowno, 'row_key', w.row_key, 'reason', substr(w.final_outcome, 9),
                           'message', CASE substr(w.final_outcome, 9)
                               WHEN 'unknown-division' THEN 'The division ' || to_json(COALESCE(w.division_label, ''))::text || ' is not one of yours: map it to a division, create it, or skip its rows.'
                               WHEN 'unknown-venue' THEN 'The venue ' || to_json(COALESCE(w.venue_label, ''))::text || ' is not one of yours: map it to a venue, create it, or skip its rows.'
                               WHEN 'unknown-field' THEN 'The field ' || to_json(COALESCE(w.field_label, ''))::text || ' is not one of its venue''s: map it to a field, create it, or skip its rows.'
                               WHEN 'unknown-team' THEN CASE WHEN w.home_out AND w.away_out THEN 'Neither team is one of yours: both are outside clubs. A game needs at least one of your teams.'
                                                             ELSE 'A team of this row is not one of your teams in its division: map it to a team, create it, mark it an outside club, or skip its rows.' END
                               WHEN 'label-is-own-team' THEN 'A label was marked as an outside club, but the division has a team of that name: map it to that team instead.'
                               WHEN 'same-team' THEN 'The home and away teams were mapped to the same team.'
                               WHEN 'duplicate-row' THEN 'After mapping, this is the same game as an earlier row of the file; the earlier row is the one imported.'
                               WHEN 'game-id-reused' THEN 'The Game ID belongs to a different game earlier in the file.'
                               ELSE COALESCE(w.parse_message, 'The file check refused this row.') END) AS item
                  FROM _gi_work w WHERE w.final_outcome LIKE 'refused:%'
                UNION ALL
                SELECT g.rowno,
                       jsonb_build_object('row_number', g.rowno, 'row_key', g.row_key, 'reason', 'duplicate-row',
                           'message', CASE WHEN g.dup_target
                               THEN 'Another row of this file names the same saved game as this row (one by its Game ID, one by its teams, place and week), and one saved game cannot be written twice. The other row is the one imported; nothing is written for this row.'
                               ELSE 'A game this file does not move already stands on this place, and this row''s Game ID (or the lack of one) does not name it. Nothing is written for the row.' END)
                  FROM _gi_g g WHERE g.verdict = 'collision'
                UNION ALL
                SELECT t.rowno,
                       jsonb_build_object('row_number', t.rowno, 'row_key', t.row_key, 'reason', 'duplicate-row',
                           'message', CASE WHEN t.dup_target
                               THEN 'Another row of this file names the same saved game as this row (one by its Game ID, one by its teams, place and week), and one saved game cannot be written twice. The other row is the one imported; nothing is written for this row.'
                               ELSE 'Another TIME TBD game already holds this home team, away team and week, and this row''s Game ID (or the lack of one) does not name it. Nothing is written for the row.' END)
                  FROM _gi_t t WHERE t.verdict = 'conflict') z) x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('row_number', w.rowno, 'row_key', w.row_key,
                        'kind', substr(w.final_outcome, 9), 'label', w.skip_label) ORDER BY w.rowno)
                    FILTER (WHERE w.rn <= c_listed), '[]'::jsonb) INTO v_listed_skipped
      FROM (SELECT z.*, row_number() OVER (ORDER BY z.rowno) AS rn FROM _gi_work z WHERE z.final_outcome LIKE 'skipped:%') w;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('row_number', g.rowno, 'row_key', g.row_key, 'game_id', g.game_id,
                        'game', g.match_id,
                        'reason', CASE WHEN g.match_id = ANY (v_held_scored) THEN c_skip_scored ELSE c_skip_published END)
                    ORDER BY g.rowno) FILTER (WHERE g.rn <= c_listed), '[]'::jsonb)
      INTO v_listed_games
      FROM (SELECT z.rowno, z.row_key, z.game_id, z.match_id, row_number() OVER (ORDER BY z.rowno) AS rn
              FROM (SELECT g2.rowno, g2.row_key, g2.game_id, g2.match_id FROM _gi_g g2 WHERE g2.verdict = 'skip-held'
                    UNION ALL
                    SELECT t.rowno, t.row_key, t.game_id, t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') z) g;
    SELECT count(*) INTO n_skip_scored
      FROM (SELECT g2.match_id AS id FROM _gi_g g2 WHERE g2.verdict = 'skip-held'
            UNION ALL
            SELECT t.ga_id FROM _gi_t t WHERE t.verdict = 'skip-held') z
     WHERE z.id = ANY (v_held_scored);
    v_skipped_obj := CASE WHEN n_skip_pub - n_skip_scored > 0 THEN jsonb_build_object(c_skip_published, n_skip_pub - n_skip_scored) ELSE '{}'::jsonb END
                  || CASE WHEN n_skip_scored > 0 THEN jsonb_build_object(c_skip_scored, n_skip_scored) ELSE '{}'::jsonb END;

    v_result := jsonb_build_object(
        'dry_run', v_dry,
        'job_id', p_import_job_id,
        'season_settings_id', v_season,
        'arrive_published', v_arrive,
        'rows', jsonb_build_object('staged', n_staged, 'refused', n_refused, 'skipped', n_skipped, 'games', n_ok, 'time_tbd', n_tbd),
        'refused_by_reason', v_refused_by_reason,
        'games', jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'unchanged', n_unch, 'repointed', n_repoint,
                                    'skipped', v_skipped_obj),
        'time_tbd', jsonb_build_object('inserted', n_tbd_ins, 'updated', n_tbd_upd, 'unchanged', n_tbd_unch, 'removed', n_tbd_rem,
                                       'converted', n_conv),
        'created', jsonb_build_object('divisions', n_div, 'venues', n_ven, 'fields', n_fld, 'teams', n_shell,
                                      'outside_teams', n_out, 'slots', n_slot_new),
        'reused', jsonb_build_object('slots', n_slot_reused),
        'not_in_file', jsonb_build_object('count', n_not_in_file, 'ids', v_not_in_file),
        'nothing_to_apply', v_nothing,
        'warnings', v_warnings,
        'not_judged', jsonb_build_array('coach-conflict', 'home-away-imbalance'),
        'listed', jsonb_build_object('refused', v_listed_refused, 'skipped', v_listed_skipped, 'skipped_games', v_listed_games),
        'ids', v_ids);

    IF v_dry THEN
        RETURN v_result;
    END IF;

    -- ------------------------------------------------------------------ 9. The writes, in order, each counted against the plan.
    IF NOT v_nothing THEN
        -- The before-images of every game the run change or the rewrite touches (a rollback puts them back).
        CREATE TEMP TABLE _gi_before ON COMMIT DROP AS
        SELECT ga.id, to_jsonb(ga) AS img FROM public.game_assignments ga
         WHERE ga.id IN (SELECT id FROM _gi_carry) OR ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update');
        -- The before-images of the TIME TBD rows the file changes or removes (a rollback puts them back).
        CREATE TEMP TABLE _gi_tbefore ON COMMIT DROP AS
        SELECT s.id, to_jsonb(s) AS img, (s.id IN (SELECT t.m_id FROM _gi_t t WHERE t.verdict = 'update')) AS changed
          FROM public.schedule_tbd s
         WHERE s.id IN (SELECT t.m_id FROM _gi_t t WHERE t.verdict = 'update')
            OR s.id IN (SELECT g.tbd_id FROM _gi_g g WHERE g.verdict IN ('insert', 'update') AND g.tbd_id IS NOT NULL
                           AND g.tbd_id NOT IN (SELECT t.m_id FROM _gi_t t WHERE t.m_id IS NOT NULL AND t.verdict IN ('insert', 'update', 'unchanged')));

        -- Divisions, venues, fields.
        INSERT INTO public.divisions (id, organization_id, season_settings_id, name)
        SELECT d.new_id, v_org, v_season, d.cname FROM _gi_div d
         WHERE d.creator AND d.new_id IN (SELECT division_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_div THEN RAISE EXCEPTION 'game import planned % divisions and wrote %', n_div, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'divisions', dv.id, 'inserted', NULL, to_jsonb(dv), v_now, v_uid
          FROM public.divisions dv WHERE dv.id IN (SELECT d.new_id FROM _gi_div d WHERE d.can_create AND d.new_id IN (SELECT division_ref FROM _gi_newgames));

        INSERT INTO public.locations (id, organization_id, name)
        SELECT v.new_id, v_org, v.cname FROM _gi_venue v
         WHERE v.creator AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_ven THEN RAISE EXCEPTION 'game import planned % venues and wrote %', n_ven, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'locations', l.id, 'inserted', NULL, to_jsonb(l), v_now, v_uid
          FROM public.locations l WHERE l.id IN (SELECT v.new_id FROM _gi_venue v WHERE v.can_create
               AND v.new_id IN (SELECT f.venue_ref FROM _gi_field f WHERE f.ref IN (SELECT field_ref FROM _gi_newgames)));

        INSERT INTO public.fields (id, organization_id, location_id, name)
        SELECT f.new_id, v_org, f.venue_ref, f.cname FROM _gi_field f
         WHERE f.creator AND f.new_id IN (SELECT field_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_fld THEN RAISE EXCEPTION 'game import planned % fields and wrote %', n_fld, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'fields', f.id, 'inserted', NULL, to_jsonb(f), v_now, v_uid
          FROM public.fields f WHERE f.id IN (SELECT x.new_id FROM _gi_field x WHERE x.can_create AND x.new_id IN (SELECT field_ref FROM _gi_newgames));

        -- Team shells, through the audited team writer, in ONE team run for the whole apply. The Teams, Practices and Games
        -- pages read the LATEST team run (`mapSchedulerRunToSummary` reads `results.teamsByDivision`), so the run is the
        -- latest completed run's results carried forward whole (every key, every division it names) with each division's
        -- shells added to the division: a run of only the new shells, or of one division, would make every other team look
        -- absent, and one run in the keys `TEAM_RUN_RESULT_KEYS` (packages/core/src/utils/teamRunResults.js, which the mock
        -- uses; tests/gameImportTeamRunShape.test.js holds this text to that list) carries what the readers read. A division
        -- is grouped under the key the carried run already uses for it (its id, its name, or the key of a group whose teams
        -- carry its id), else under its name; a division no saved run names is seeded with its own teams as the table has
        -- them (an outside club is not one).
        SELECT COALESCE(array_agg(t.new_id ORDER BY t.new_id), ARRAY[]::uuid[]) INTO v_shell_arr
          FROM _gi_team t
         WHERE t.kind = 'shell' AND t.creator AND t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
        IF cardinality(v_shell_arr) > 0 THEN
            SELECT sr.results INTO v_base
              FROM public.scheduler_runs sr
             WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.status = 'completed'
               AND (sr.season_settings_id = v_season OR sr.season_id = v_season)
             ORDER BY sr.created_at DESC, sr.id DESC
             LIMIT 1;
            IF jsonb_typeof(v_base) IS DISTINCT FROM 'object' THEN v_base := '{}'::jsonb; END IF;
            IF jsonb_typeof(v_base -> 'teamsByDivision') = 'object' THEN
                SELECT COALESCE(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END), '{}'::jsonb)
                  INTO v_grouped FROM jsonb_each(v_base -> 'teamsByDivision') e;
            ELSIF jsonb_typeof(v_base -> 'teams') = 'array' THEN
                SELECT COALESCE(jsonb_object_agg(g.k, g.arr), '{}'::jsonb) INTO v_grouped
                  FROM (SELECT COALESCE(NULLIF(et ->> 'division', ''), NULLIF(et ->> 'division_id', ''), 'Unassigned') AS k,
                               jsonb_agg(et ORDER BY x.ord) AS arr
                          FROM jsonb_array_elements(v_base -> 'teams') WITH ORDINALITY AS x(et, ord) GROUP BY 1) g;
            ELSE
                v_grouped := '{}'::jsonb;
            END IF;
            FOR v_div IN
                SELECT t.division_ref,
                       (SELECT d.final_name FROM _gi_div d WHERE d.ref = t.division_ref ORDER BY d.dkey LIMIT 1) AS dname
                  FROM _gi_team t
                 WHERE t.kind = 'shell' AND t.creator AND t.new_id = ANY (v_shell_arr)
                 GROUP BY t.division_ref
                 ORDER BY t.division_ref
            LOOP
                SELECT e.key INTO v_key
                  FROM jsonb_each(v_grouped) e
                 WHERE lower(e.key) = lower(v_div.division_ref::text) OR e.key = v_div.dname
                    OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.value) et
                                WHERE lower(COALESCE(et ->> 'division_id', et ->> 'divisionId', '')) = lower(v_div.division_ref::text))
                 ORDER BY e.key COLLATE "C"
                 LIMIT 1;
                IF v_key IS NULL THEN
                    v_key := v_div.dname;
                    v_grouped := v_grouped || jsonb_build_object(v_key, COALESCE((
                        SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'division', v_key, 'division_id', v_div.division_ref,
                                   'coachId', t.coach_id, 'assistantCoachIds', to_jsonb(COALESCE(t.assistant_coach_ids, '{}'::uuid[])),
                                   'players', '[]'::jsonb) ORDER BY t.name, t.id)
                          FROM public.teams t
                         WHERE t.division_id = v_div.division_ref AND NOT t.is_external AND t.id <> ALL (v_shell_arr)), '[]'::jsonb));
                END IF;
                v_label := COALESCE(NULLIF(v_grouped -> v_key -> 0 ->> 'division', ''), v_key);
                v_grouped := jsonb_set(v_grouped, ARRAY[v_key], (v_grouped -> v_key) || COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', t.new_id, 'name', t.cname, 'division', v_label, 'division_id', v_div.division_ref,
                               'coachId', NULL, 'assistantCoachIds', '[]'::jsonb, 'players', '[]'::jsonb) ORDER BY t.cname, t.new_id)
                      FROM _gi_team t
                     WHERE t.kind = 'shell' AND t.creator AND t.division_ref = v_div.division_ref AND t.new_id = ANY (v_shell_arr)), '[]'::jsonb));
            END LOOP;
            v_results := v_base || jsonb_build_object(
                'teamsByDivision', v_grouped,
                'teams', COALESCE((SELECT jsonb_agg(x.team) FROM jsonb_each(v_grouped) e, jsonb_array_elements(e.value) AS x(team)), '[]'::jsonb),
                'team_players', CASE WHEN jsonb_typeof(v_base -> 'team_players') = 'array' THEN v_base -> 'team_players' ELSE '[]'::jsonb END);
            v_team_run := public.persist_team_schedule(
                jsonb_build_object('organization_id', v_org, 'season_settings_id', v_season, 'run_type', 'team', 'status', 'completed',
                    'completed_at', clock_timestamp(),
                    'parameters', jsonb_build_object('source', 'import', 'import_job_id', p_import_job_id, 'shell_ids', to_jsonb(v_shell_arr)),
                    'results', v_results),
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.new_id, 'division_id', t.division_ref, 'name', t.cname) ORDER BY t.new_id), '[]'::jsonb)
                   FROM _gi_team t WHERE t.kind = 'shell' AND t.creator AND t.new_id = ANY (v_shell_arr)),
                '[]'::jsonb);
            v_team_runs := v_team_runs || to_jsonb(v_team_run);
        END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'teams', t.id, 'inserted', NULL, to_jsonb(t), v_now, v_uid
          FROM public.teams t WHERE t.id IN (SELECT x.new_id FROM _gi_team x WHERE x.kind = 'shell'
               AND x.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames));
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_shell THEN RAISE EXCEPTION 'game import planned % team shells and wrote %', n_shell, v_rc USING ERRCODE = 'XX000'; END IF;

        -- Outside clubs: team rows flagged is_external, in NO team run.
        INSERT INTO public.teams (id, organization_id, division_id, name, is_external)
        SELECT t.new_id, v_org, t.division_ref, t.cname, true FROM _gi_team t
         WHERE t.kind = 'ext-new' AND t.creator AND t.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_out THEN RAISE EXCEPTION 'game import planned % outside clubs and wrote %', n_out, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'teams', t.id, 'inserted', NULL, to_jsonb(t), v_now, v_uid
          FROM public.teams t WHERE t.is_external AND t.id IN (SELECT x.new_id FROM _gi_team x WHERE x.kind = 'ext-new'
               AND x.ref IN (SELECT home_ref FROM _gi_newgames UNION SELECT away_ref FROM _gi_newgames));

        -- Slots.
        INSERT INTO public.game_slots (id, organization_id, field_id, start, "end", slot_date, start_time, end_time, week_index, capacity)
        SELECT s.new_id, v_org, s.field_id, s.start_ts, s.end_ts, s.gdate, s.start_time, s.end_time, s.week_index, 1 FROM _gi_slotnew s;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_slot_new THEN RAISE EXCEPTION 'game import planned % slots and wrote %', n_slot_new, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_slots', gs.id, 'inserted', NULL, to_jsonb(gs), v_now, v_uid
          FROM public.game_slots gs WHERE gs.id IN (SELECT new_id FROM _gi_slotnew);

        -- The run: made last of the structure, first of the games, so every game can name it.
        INSERT INTO public.scheduler_runs (id, organization_id, season_id, season_settings_id, run_type, status, parameters, metrics, results,
                                           created_by, started_at, completed_at, created_at)
        VALUES (v_run_id, v_org, v_season, v_season, 'game', 'completed',
                jsonb_build_object('source', 'import', 'import_job_id', p_import_job_id, 'arrive_published', v_arrive,
                                   'previous_run_id', v_prev_run),
                '{}'::jsonb,
                jsonb_build_object('summary', jsonb_build_object('totalAssignments', n_ins + n_upd + n_repoint, 'source', 'import'),
                                   'warnings', v_warnings, 'unscheduled', '[]'::jsonb, 'not_judged', jsonb_build_array('coach-conflict', 'home-away-imbalance'),
                                   'import_job_id', p_import_job_id),
                v_uid, clock_timestamp(), clock_timestamp(), clock_timestamp());

        -- Placed games the file now says have no time are taken out (a dated TIME TBD game stands for each, below). Only a
        -- game that is not held is here (a held one was skipped), and its image is kept so a rollback can put it back.
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', ga.id, 'deleted', to_jsonb(ga), '{}'::jsonb, v_now, v_uid
          FROM public.game_assignments ga WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
        DELETE FROM public.game_assignments ga WHERE ga.id IN (SELECT t.ga_id FROM _gi_t t WHERE t.conv);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_conv THEN RAISE EXCEPTION 'game import planned % games made TIME TBD and removed %', n_conv, v_rc USING ERRCODE = 'XX000'; END IF;

        -- Room is made first (as `persist_game_schedule` makes it, 20261120010000): the unique place (home, away, slot, week) is
        -- not deferrable, so a game that leaves a place another row of this file is about to take would meet that row in the
        -- index whichever is written first. A game that moves, and whose place a row of the file takes, is taken out of the
        -- index (its slot set null for the length of this apply) and given its final place by the update below, in this
        -- transaction. The clashes with games the file does NOT move were refused in the plan, so no game ends where another is.
        UPDATE public.game_assignments ga SET game_slot_id = NULL, slot_id = NULL
         WHERE ga.id IN (SELECT g.match_id FROM _gi_g g WHERE g.verdict = 'update' AND g.leaves)
           AND EXISTS (SELECT 1 FROM _gi_g h
                        WHERE h.verdict IN ('insert', 'update') AND h.slot_final = ga.game_slot_id
                          AND h.home_ref = ga.home_team_id AND h.away_ref = ga.away_team_id AND h.week_index = ga.week_index);

        -- New games, Published when the job says so (decision 4).
        INSERT INTO public.game_assignments (id, organization_id, season_settings_id, run_id, game_slot_id, slot_id, field_id, home_team_id,
                                             away_team_id, division, week_index, start, "end", external_ref, import_job_id,
                                             published, published_at, published_by)
        SELECT g.new_id, v_org, v_season, v_run_id, g.slot_final, g.slot_final, g.field_ref, g.home_ref, g.away_ref, g.division_name,
               g.week_index, g.start_ts, g.end_ts, COALESCE(g.game_id, g.carry_ref), p_import_job_id,
               v_arrive, CASE WHEN v_arrive THEN v_now END, CASE WHEN v_arrive THEN v_uid END
          FROM _gi_g g WHERE g.verdict = 'insert';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_ins THEN RAISE EXCEPTION 'game import planned % games and wrote %', n_ins, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', ga.id, 'inserted', NULL, to_jsonb(ga), v_now, v_uid
          FROM public.game_assignments ga WHERE ga.id IN (SELECT new_id FROM _gi_g WHERE verdict = 'insert');
        SELECT COALESCE(array_agg(g.new_id ORDER BY g.new_id), ARRAY[]::uuid[]) INTO v_published_ids FROM _gi_g g WHERE g.verdict = 'insert' AND v_arrive;

        -- Games changed in place, by id: a held game is never here (it was skipped).
        UPDATE public.game_assignments ga
           SET game_slot_id = g.slot_final, slot_id = g.slot_final, field_id = g.field_ref, home_team_id = g.home_ref, away_team_id = g.away_ref,
               division = g.division_name, week_index = g.week_index, start = g.start_ts, "end" = g.end_ts,
               run_id = v_run_id, import_job_id = p_import_job_id
          FROM _gi_g g
         WHERE g.verdict = 'update' AND ga.id = g.match_id;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_upd THEN RAISE EXCEPTION 'game import planned % game updates and wrote %', n_upd, v_rc USING ERRCODE = 'XX000'; END IF;

        -- The rest of the previous schedule, and the hidden games the file found, are carried into the new run.
        UPDATE public.game_assignments ga SET run_id = v_run_id WHERE ga.id IN (SELECT id FROM _gi_carry);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_repoint THEN RAISE EXCEPTION 'game import planned % carried games and moved %', n_repoint, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'game_assignments', b.id, 'updated', b.img, to_jsonb(ga), v_now, v_uid
          FROM _gi_before b JOIN public.game_assignments ga ON ga.id = b.id;

        -- TIME TBD games: a DATE and no time (`game_date`), the Game ID in `external_ref`. A row the file names is changed in
        -- place; one the file now places is removed (the placed game stands for it); a new one is inserted. Every one has an
        -- application record, with the image it had, so the rollback puts it back.
        UPDATE public.schedule_tbd s
           SET division_id = t.division_ref, home_team_id = t.home_ref, away_team_id = t.away_ref, week_index = t.week_index::smallint,
               external_ref = COALESCE(t.game_id, s.external_ref), game_date = t.gdate, reason = 'imported-without-time',
               detail = jsonb_strip_nulls(jsonb_build_object('game_id', COALESCE(t.game_id, s.external_ref), 'import_job_id', p_import_job_id)),
               run_id = v_run_id
          FROM _gi_t t WHERE t.verdict = 'update' AND s.id = t.m_id;
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_upd THEN RAISE EXCEPTION 'game import planned % TIME TBD updates and wrote %', n_tbd_upd, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', s.id, 'updated', b.img, to_jsonb(s), v_now, v_uid
          FROM _gi_tbefore b JOIN public.schedule_tbd s ON s.id = b.id WHERE b.changed;
        DELETE FROM public.schedule_tbd s WHERE s.id IN (SELECT b.id FROM _gi_tbefore b WHERE NOT b.changed);
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_rem THEN RAISE EXCEPTION 'game import planned % TIME TBD removals and made %', n_tbd_rem, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', b.id, 'deleted', b.img, '{}'::jsonb, v_now, v_uid
          FROM _gi_tbefore b WHERE NOT b.changed;
        INSERT INTO public.schedule_tbd (id, organization_id, season_settings_id, kind, division_id, home_team_id, away_team_id, week_index,
                                         reason, detail, run_id, external_ref, game_date)
        SELECT t.new_id, v_org, v_season, 'game', t.division_ref, t.home_ref, t.away_ref, t.week_index::smallint, 'imported-without-time',
               jsonb_strip_nulls(jsonb_build_object('game_id', t.game_id, 'import_job_id', p_import_job_id)), v_run_id, t.game_id, t.gdate
          FROM _gi_t t WHERE t.verdict = 'insert';
        GET DIAGNOSTICS v_rc = ROW_COUNT;
        IF v_rc <> n_tbd_ins THEN RAISE EXCEPTION 'game import planned % TIME TBD games and wrote %', n_tbd_ins, v_rc USING ERRCODE = 'XX000'; END IF;
        INSERT INTO public.import_application_records (organization_id, import_job_id, import_type, target_table, target_id, operation, previous_payload, applied_payload, applied_at, applied_by)
        SELECT v_org, p_import_job_id, 'games', 'schedule_tbd', s.id, 'inserted', NULL, to_jsonb(s), v_now, v_uid
          FROM public.schedule_tbd s WHERE s.id IN (SELECT t.new_id FROM _gi_t t WHERE t.verdict = 'insert');

        v_ids := jsonb_build_object('run_id', v_run_id, 'team_run_ids', v_team_runs);
    END IF;

    v_result := v_result || jsonb_build_object('ids', v_ids);
    v_status := CASE WHEN n_refused > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- The audit rows, in this transaction. A failed write rolls the apply back; SLA01 tells the caller it was the audit.
    BEGIN
        PERFORM public.record_audit_event(v_org, 'import.completed', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'games', 'job_type', 'games', 'season_settings_id', v_season, 'status', v_status,
                               'rows', v_result -> 'rows', 'games', v_result -> 'games', 'time_tbd', v_result -> 'time_tbd',
                               'created', v_result -> 'created', 'reused', v_result -> 'reused',
                               'nothing_to_apply', v_nothing, 'arrive_published', v_arrive));
        IF cardinality(v_published_ids) > 0 THEN
            PERFORM public.record_audit_event(v_org, 'game.published_set', 'game_assignment', NULL,
                jsonb_build_object('published', true, 'scope', jsonb_build_object('kind', 'import', 'value', p_import_job_id::text),
                                   'count', cardinality(v_published_ids), 'unchanged', 0, 'ids', to_jsonb(v_published_ids)));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    UPDATE public.staging_import_rows SET applied_at = v_now, applied_by = v_uid
     WHERE import_job_id = p_import_job_id AND organization_id = v_org AND import_type = 'games';
    UPDATE public.import_jobs
       SET status = v_status, processed_rows = n_staged, progress_percent = 100, completed_at = v_now,
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{game_import}', v_result, true)
     WHERE id = p_import_job_id;

    RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. The games import's rollback, copied whole from 20261121010000. Changed: a score entered since is a change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rollback_game_import_job(p_import_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_listed constant integer := 50;
    v_uid uuid := auth.uid();
    v_job public.import_jobs%ROWTYPE;
    v_org uuid;
    v_season_status text;
    v_run uuid;
    v_pending integer;
    v_changed uuid[];
    v_changed_tbd uuid[];
    n_games_deleted bigint := 0; n_games_restored bigint := 0; n_games_reinserted bigint := 0; n_tbd bigint := 0; n_tbd_restored bigint := 0;
    n_tbd_reinserted bigint := 0; n_tbd_not_reinserted bigint := 0; n_slots bigint := 0;
    n_teams bigint := 0; n_fields bigint := 0; n_venues bigint := 0; n_divs bigint := 0; n_team_runs bigint := 0;
    v_kept jsonb := '[]'::jsonb;
    v_result jsonb;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'rollback_game_import_job needs a signed-in caller to audit the rollback' USING ERRCODE = '42501';
    END IF;
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    v_org := v_job.organization_id;
    IF NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_org USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'games' THEN
        RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE = '22023';
    END IF;

    -- The game writers' lock, then the season writers' (as the apply takes them), before anything is read as it stands.
    PERFORM pg_advisory_xact_lock(hashtextextended('game_published:' || v_org::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    SELECT s.status INTO v_season_status FROM public.season_settings s
     WHERE s.id = v_job.season_settings_id AND s.organization_id = v_org;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed: its games are read-only', v_job.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    SELECT count(*) INTO v_pending FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.rolled_back_at IS NULL;
    IF v_pending = 0 THEN
        RAISE EXCEPTION 'Import job % has no games application records to roll back', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'nothing_to_roll_back';
    END IF;

    SELECT sr.id INTO v_run FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'game' AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
     LIMIT 1;

    -- What changed since: judged BEFORE anything is written. A game of the job that is gone, differs from the image the
    -- apply stored, or is in another run than the import's.
    SELECT COALESCE(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_changed
      FROM (SELECT r.target_id AS id
              FROM public.import_application_records r
              LEFT JOIN public.game_assignments ga ON ga.id = r.target_id
             WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'game_assignments'
               AND r.rolled_back_at IS NULL
               AND CASE WHEN r.operation = 'deleted'
                        -- A game the apply took out is still out: one that stands again would be put back twice.
                        THEN ga.id IS NOT NULL
                        ELSE ga.id IS NULL
                             OR public.game_import_image(to_jsonb(ga)) IS DISTINCT FROM public.game_import_image(r.applied_payload)
                             OR ga.run_id IS DISTINCT FROM v_run
                             -- 20261122010000: a score entered on a game the import wrote is a change since (a game the
                             -- import inserted or updated had no score when it was applied: a scored game is skipped).
                             -- The rollback never deletes a score, and never moves a game under one.
                             OR EXISTS (SELECT 1 FROM public.game_scores gs WHERE gs.game_id = ga.id) END) x;
    -- The same for the TIME TBD games of the job (Codex on 305137b: they were deleted, restored and put back with no
    -- comparison, so rolling import A back deleted the correction import B had made to a game A inserted). One that the
    -- apply inserted or changed must still be there and equal what the apply left (it is not the image from before the
    -- apply that counts: that is what the rollback puts back); one the apply removed must still be absent by its id. A
    -- removed row whose tuple or Game ID another row now holds is NOT a refusal: that row is someone else's, nothing of
    -- theirs is lost, and the rollback counts the row it cannot put back (time_tbd_not_reinserted) and says so.
    SELECT COALESCE(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_changed_tbd
      FROM (SELECT r.target_id AS id
              FROM public.import_application_records r
              LEFT JOIN public.schedule_tbd s ON s.id = r.target_id
             WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'schedule_tbd'
               AND r.rolled_back_at IS NULL
               AND CASE WHEN r.operation = 'deleted'
                        THEN s.id IS NOT NULL
                        ELSE s.id IS NULL OR NOT public.game_import_row_unchanged(to_jsonb(s), r.applied_payload) END) x;
    IF cardinality(v_changed) + cardinality(v_changed_tbd) > 0 THEN
        RAISE EXCEPTION 'The import cannot be rolled back: % game(s) (placed or TIME TBD) it wrote were changed, cancelled, given a score, had changes allowed or were saved into a later run since',
                        cardinality(v_changed) + cardinality(v_changed_tbd)
            USING ERRCODE = '22023',
                  DETAIL = format('game_import_changed count=%s ids=%s', cardinality(v_changed) + cardinality(v_changed_tbd),
                                  array_to_string((SELECT array_agg(c ORDER BY c) FROM (SELECT c FROM unnest(v_changed) c ORDER BY c LIMIT c_listed) q), ','))
                           || CASE WHEN cardinality(v_changed_tbd) = 0 THEN ''
                                   ELSE format(' tbd_ids=%s', array_to_string((SELECT array_agg(c ORDER BY c) FROM (SELECT c FROM unnest(v_changed_tbd) c ORDER BY c LIMIT c_listed) q), ','))
                              END;
    END IF;

    -- The guard's rollback exemption names this job, for the length of this transaction only.
    PERFORM set_config('squadlogic.import_rollback', p_import_job_id::text, true);

    -- Games: what the import inserted goes (frees the places), what it changed in place or only carried is put back.
    DELETE FROM public.game_assignments ga USING public.import_application_records r
     WHERE r.target_id = ga.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_assignments' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_games_deleted = ROW_COUNT;

    -- Games the apply moved are put back. Two games that swapped places meet in the unique place if each is put back in turn, so
    -- a game that is not where it was is first taken out of the index (its slot set null), as the apply took it, and then
    -- given its own place back; none of them is held (a held one has changed since, and the pre-check above refused).
    UPDATE public.game_assignments ga SET game_slot_id = NULL, slot_id = NULL
      FROM public.import_application_records r
     WHERE r.target_id = ga.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_assignments' AND r.operation = 'updated' AND r.rolled_back_at IS NULL
       AND (ga.home_team_id, ga.away_team_id, ga.game_slot_id, ga.week_index)
           IS DISTINCT FROM ((r.previous_payload ->> 'home_team_id')::uuid, (r.previous_payload ->> 'away_team_id')::uuid,
                             (r.previous_payload ->> 'game_slot_id')::uuid, (r.previous_payload ->> 'week_index')::smallint);
    UPDATE public.game_assignments ga
       SET game_slot_id = (r.previous_payload ->> 'game_slot_id')::uuid,
           slot_id = (r.previous_payload ->> 'slot_id')::uuid,
           field_id = (r.previous_payload ->> 'field_id')::uuid,
           home_team_id = (r.previous_payload ->> 'home_team_id')::uuid,
           away_team_id = (r.previous_payload ->> 'away_team_id')::uuid,
           division = r.previous_payload ->> 'division',
           week_index = (r.previous_payload ->> 'week_index')::smallint,
           start = (r.previous_payload ->> 'start')::timestamptz,
           "end" = (r.previous_payload ->> 'end')::timestamptz,
           run_id = (r.previous_payload ->> 'run_id')::uuid,
           import_job_id = (r.previous_payload ->> 'import_job_id')::uuid
      FROM public.import_application_records r
     WHERE r.target_id = ga.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_assignments' AND r.operation = 'updated' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_games_restored = ROW_COUNT;

    -- Games the apply took out (the file gave them no time) stand again, as they were: after the games the import inserted
    -- have gone and the moved ones are back, so the places are free, and before the slots are judged.
    INSERT INTO public.game_assignments
    SELECT (jsonb_populate_record(NULL::public.game_assignments, r.previous_payload)).*
      FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'game_assignments'
       AND r.operation = 'deleted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_games_reinserted = ROW_COUNT;

    -- TIME TBD games: what the import inserted goes, what it changed in place is put back, and what it removed (the file
    -- placed the game) is put back. A removed row whose place in the table has been taken (the table is unique on a Game ID
    -- and on the home team, away team and week) cannot be put back: it is counted and said, never skipped in silence.
    DELETE FROM public.schedule_tbd s USING public.import_application_records r
     WHERE r.target_id = s.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'schedule_tbd' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_tbd = ROW_COUNT;
    UPDATE public.schedule_tbd s
       SET division_id = (r.previous_payload ->> 'division_id')::uuid,
           home_team_id = (r.previous_payload ->> 'home_team_id')::uuid,
           away_team_id = (r.previous_payload ->> 'away_team_id')::uuid,
           week_index = (r.previous_payload ->> 'week_index')::smallint,
           reason = r.previous_payload ->> 'reason',
           detail = COALESCE(r.previous_payload -> 'detail', '{}'::jsonb),
           run_id = (r.previous_payload ->> 'run_id')::uuid,
           external_ref = r.previous_payload ->> 'external_ref',
           game_date = (r.previous_payload ->> 'game_date')::date
      FROM public.import_application_records r
     WHERE r.target_id = s.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'schedule_tbd' AND r.operation = 'updated' AND r.rolled_back_at IS NULL;
    GET DIAGNOSTICS n_tbd_restored = ROW_COUNT;
    INSERT INTO public.schedule_tbd
    SELECT (jsonb_populate_record(NULL::public.schedule_tbd, r.previous_payload)).*
      FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'schedule_tbd'
       AND r.operation = 'deleted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd x
                        WHERE x.id = r.target_id
                           OR (x.kind = 'game' AND x.home_team_id = (r.previous_payload ->> 'home_team_id')::uuid
                               AND x.away_team_id = (r.previous_payload ->> 'away_team_id')::uuid
                               AND x.week_index = (r.previous_payload ->> 'week_index')::smallint)
                           OR (x.season_settings_id = (r.previous_payload ->> 'season_settings_id')::uuid
                               AND x.external_ref = r.previous_payload ->> 'external_ref'));
    GET DIAGNOSTICS n_tbd_reinserted = ROW_COUNT;
    SELECT count(*) INTO n_tbd_not_reinserted FROM public.import_application_records r
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.target_table = 'schedule_tbd'
       AND r.operation = 'deleted' AND r.rolled_back_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd x WHERE x.id = r.target_id);

    -- Slots nothing stands in any more.
    DELETE FROM public.game_slots gs USING public.import_application_records r
     WHERE r.target_id = gs.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'game_slots' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.game_slot_id = gs.id OR ga.slot_id = gs.id)
       AND public.game_import_row_unchanged(to_jsonb(gs), r.applied_payload);
    GET DIAGNOSTICS n_slots = ROW_COUNT;

    -- The ids every OTHER team run of the organization names anywhere in its results, read ONCE. (The check used to cast
    -- each run's whole results to text for every team: 150 shells and ten megabytes of other runs took 7 seconds. An id
    -- found anywhere keeps its team, as before; the scan is for uuid-shaped text, which is what an id is.)
    DROP TABLE IF EXISTS pg_temp._gr_named;
    CREATE TEMP TABLE _gr_named ON COMMIT DROP AS
    SELECT DISTINCT lower(m[1]) AS id
      FROM public.scheduler_runs sr,
           LATERAL regexp_matches(sr.results::text, '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') AS m
     WHERE sr.run_type = 'team' AND sr.organization_id = v_org
       AND sr.parameters ->> 'import_job_id' IS DISTINCT FROM p_import_job_id::text;
    CREATE UNIQUE INDEX ON _gr_named (id);

    -- Teams (shells and outside clubs) nothing references: no game, no TIME TBD game, no player, coach, practice,
    -- preference, assigned player (players.team_id has no foreign key) and no later team run that names it. A shell or
    -- club that is referenced stays, and is reported. The practice TIME TBD rows are derived and go with the cascade,
    -- and so does the feed token a trigger makes for every team.
    DELETE FROM public.teams t USING public.import_application_records r
     WHERE r.target_id = t.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'teams' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.home_team_id = t.id OR ga.away_team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.kind = 'game' AND (s.home_team_id = t.id OR s.away_team_id = t.id))
       AND NOT EXISTS (SELECT 1 FROM public.team_players tp WHERE tp.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.team_coach_assignments tc WHERE tc.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.coach_practice_preferences cp WHERE cp.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.team_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM _gr_named n WHERE n.id = t.id::text)
       AND public.game_import_row_unchanged(to_jsonb(t), r.applied_payload);
    GET DIAGNOSTICS n_teams = ROW_COUNT;

    -- The import's team runs whose shells are all gone (one that still carries a kept shell stays), and that nothing else
    -- names: every foreign key onto scheduler_runs sets null (the pgTAP file derives them from the catalogue and fails unless
    -- each is guarded here), and a null run is a game or an evaluation that lost the run it belongs to.
    DELETE FROM public.scheduler_runs sr
     WHERE sr.organization_id = v_org AND sr.run_type = 'team' AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                        WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid))
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.run_id = sr.id)
       AND NOT EXISTS (SELECT 1 FROM public.evaluation_runs er WHERE er.scheduler_run_id = sr.id);
    GET DIAGNOSTICS n_team_runs = ROW_COUNT;

    -- Fields, venues and divisions the import created and nothing else uses. Everything an admin attached afterwards keeps
    -- its record: a permit scope, a blackout or a subunit would be taken by the cascade, and a field that holds a booking
    -- (the shared producer) or a game or slot does not go either. The pgTAP file derives from the catalogue every
    -- foreign key that cascades or sets null onto the five tables this function deletes from and fails unless the
    -- DELETE guards it (or it is on that file's short, argued list).
    DELETE FROM public.fields f USING public.import_application_records r
     WHERE r.target_id = f.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'fields' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.game_slots gs WHERE gs.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes ps WHERE ps.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_blackouts fb WHERE fb.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_subunits su WHERE su.field_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_bookings(v_org, f.id, NULL) b)
       AND public.game_import_row_unchanged(to_jsonb(f), r.applied_payload);
    GET DIAGNOSTICS n_fields = ROW_COUNT;
    DELETE FROM public.locations l USING public.import_application_records r
     WHERE r.target_id = l.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'locations' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.fields f WHERE f.location_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes ps WHERE ps.location_id = l.id)
       AND NOT EXISTS (SELECT 1 FROM public.field_blackouts fb WHERE fb.location_id = l.id)
       AND public.game_import_row_unchanged(to_jsonb(l), r.applied_payload);
    GET DIAGNOSTICS n_venues = ROW_COUNT;
    DELETE FROM public.divisions d USING public.import_application_records r
     WHERE r.target_id = d.id AND r.import_job_id = p_import_job_id AND r.import_type = 'games'
       AND r.target_table = 'divisions' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.players p WHERE p.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.game_slots gs WHERE gs.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.practice_slots ps WHERE ps.division_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.division_id = d.id)
       AND public.game_import_row_unchanged(to_jsonb(d), r.applied_payload);
    GET DIAGNOSTICS n_divs = ROW_COUNT;

    -- The import's own game run goes last: every game that named it has been deleted or put back into the run it was in. A run
    -- something else still names (a game saved into it since) stays, as above.
    IF v_run IS NOT NULL THEN
        DELETE FROM public.scheduler_runs sr WHERE sr.id = v_run
           AND NOT EXISTS (SELECT 1 FROM public.game_assignments ga WHERE ga.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.schedule_tbd s WHERE s.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe WHERE pe.run_id = sr.id)
           AND NOT EXISTS (SELECT 1 FROM public.evaluation_runs er WHERE er.scheduler_run_id = sr.id);
    END IF;

    -- A run that stays is kept for HISTORY and is never the current one (Codex on e699b1f: the kept game run was still
    -- `completed`, so the Games page and the exports, which read the latest completed game run, showed its games, none,
    -- instead of the restored schedule). It is retired with the status every reader of a latest run skips (`failed`; the
    -- game readers ask for `completed`, the team readers for `completed` or `running`) and marked rolled back. The games
    -- are back in the runs they were in, so the previous run is the latest again. A TEAM run that stays because it carries
    -- a kept shell is NOT retired: it is the only run that lists that shell (retiring it would hide a team that exists),
    -- so it stays the latest. Either way the shells that are gone are taken out of what a kept team run lists (two readers
    -- of team runs do not ask for a status: the run history and `get_latest_team_runs_per_division`), so no reader of
    -- any kept run is shown a team that no longer exists.
    UPDATE public.scheduler_runs sr
       SET status = 'failed', parameters = sr.parameters || jsonb_build_object('rolled_back', true)
     WHERE sr.organization_id = v_org AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
       AND (sr.run_type = 'game'
            OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                            WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid)));
    UPDATE public.scheduler_runs sr
       SET parameters = jsonb_set(sr.parameters, '{shell_ids}',
               (SELECT COALESCE(jsonb_agg(sid), '[]'::jsonb) FROM jsonb_array_elements_text(sr.parameters -> 'shell_ids') sid
                 WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid))),
           results = sr.results
               || CASE WHEN jsonb_typeof(sr.results -> 'teamsByDivision') = 'object' THEN jsonb_build_object('teamsByDivision',
                       (SELECT COALESCE(jsonb_object_agg(d.key, d.kept), '{}'::jsonb)
                          FROM (SELECT e.key, (SELECT COALESCE(jsonb_agg(a.x ORDER BY a.ord), '[]'::jsonb)
                                                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.value) = 'array' THEN e.value ELSE '[]'::jsonb END) WITH ORDINALITY a(x, ord)
                                                WHERE NOT ((a.x ->> 'id') = ANY (g.gone))) AS kept
                                  FROM jsonb_each(sr.results -> 'teamsByDivision') e) d
                         WHERE jsonb_array_length(d.kept) > 0)) ELSE '{}'::jsonb END
               || CASE WHEN jsonb_typeof(sr.results -> 'teams') = 'array' THEN jsonb_build_object('teams',
                       (SELECT COALESCE(jsonb_agg(a.x ORDER BY a.ord), '[]'::jsonb) FROM jsonb_array_elements(sr.results -> 'teams') WITH ORDINALITY a(x, ord)
                         WHERE NOT ((a.x ->> 'id') = ANY (g.gone)))) ELSE '{}'::jsonb END
               || CASE WHEN jsonb_typeof(sr.results -> 'team_players') = 'array' THEN jsonb_build_object('team_players',
                       (SELECT COALESCE(jsonb_agg(a.x ORDER BY a.ord), '[]'::jsonb) FROM jsonb_array_elements(sr.results -> 'team_players') WITH ORDINALITY a(x, ord)
                         WHERE NOT ((a.x ->> 'team_id') = ANY (g.gone)))) ELSE '{}'::jsonb END
      FROM (SELECT x.id, ARRAY(SELECT sid FROM jsonb_array_elements_text(COALESCE(x.parameters -> 'shell_ids', '[]'::jsonb)) sid
                                WHERE NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid)) AS gone
              FROM public.scheduler_runs x
             WHERE x.organization_id = v_org AND x.run_type = 'team' AND x.parameters ->> 'import_job_id' = p_import_job_id::text) g
     WHERE sr.id = g.id AND cardinality(g.gone) > 0;

    -- What was created and is still there (referenced by something that came after, or changed since), named, never
    -- deleted silently; and a run of the import that is still there for a reason of its own (not for a shell it carries).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('table', k.t, 'id', k.id) ORDER BY k.t, k.id), '[]'::jsonb)
      INTO v_kept
      FROM (SELECT r.target_table AS t, r.target_id AS id
              FROM public.import_application_records r
             WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.operation = 'inserted' AND r.rolled_back_at IS NULL
               AND r.target_table IN ('game_slots', 'teams', 'fields', 'locations', 'divisions')
               AND ((r.target_table = 'game_slots' AND EXISTS (SELECT 1 FROM public.game_slots x WHERE x.id = r.target_id))
                 OR (r.target_table = 'teams' AND EXISTS (SELECT 1 FROM public.teams x WHERE x.id = r.target_id))
                 OR (r.target_table = 'fields' AND EXISTS (SELECT 1 FROM public.fields x WHERE x.id = r.target_id))
                 OR (r.target_table = 'locations' AND EXISTS (SELECT 1 FROM public.locations x WHERE x.id = r.target_id))
                 OR (r.target_table = 'divisions' AND EXISTS (SELECT 1 FROM public.divisions x WHERE x.id = r.target_id)))
            UNION ALL
            SELECT 'scheduler_runs', sr.id
              FROM public.scheduler_runs sr
             WHERE sr.organization_id = v_org AND sr.parameters ->> 'import_job_id' = p_import_job_id::text
               AND (sr.run_type = 'game'
                    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(sr.parameters -> 'shell_ids', '[]'::jsonb)) sid
                                    WHERE EXISTS (SELECT 1 FROM public.teams t WHERE t.id::text = sid)))) k;

    UPDATE public.import_application_records r
       SET rolled_back_at = now(), rolled_back_by = v_uid, rollback_payload = jsonb_build_object('rolled_back', true)
     WHERE r.import_job_id = p_import_job_id AND r.import_type = 'games' AND r.rolled_back_at IS NULL;

    v_result := jsonb_build_object(
        'job_id', p_import_job_id,
        'games', jsonb_build_object('deleted', n_games_deleted, 'restored', n_games_restored, 'reinserted', n_games_reinserted),
        'time_tbd_deleted', n_tbd, 'time_tbd_restored', n_tbd_restored, 'time_tbd_reinserted', n_tbd_reinserted,
        'time_tbd_not_reinserted', n_tbd_not_reinserted, 'slots_deleted', n_slots, 'teams_deleted', n_teams, 'team_runs_deleted', n_team_runs,
        'fields_deleted', n_fields, 'venues_deleted', n_venues, 'divisions_deleted', n_divs,
        'kept', v_kept);

    BEGIN
        PERFORM public.record_audit_event(v_org, 'import.rolled_back', 'import_job', p_import_job_id,
            jsonb_build_object('import_type', 'games') || v_result);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'audit write failed, nothing was saved: %', SQLERRM
            USING ERRCODE = 'SLA01', DETAIL = SQLSTATE;
    END;

    UPDATE public.import_jobs
       SET status = 'needs_fix',
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{game_import_rollback}', v_result, true)
     WHERE id = p_import_job_id;

    -- The exemption was for this call only.
    PERFORM set_config('squadlogic.import_rollback', '', true);
    RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 11. cancel_ready_import_job, copied whole from 20261121010000. Changed: it refuses a job that is not ready_to_apply.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_ready_import_job(p_import_job_id uuid, p_import_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences','evaluations','games') THEN RAISE EXCEPTION 'Deferred apply cancellation is only available for coach, field, field_availability, practice_preferences, evaluations, and games imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='evaluations' AND v_job.job_type<>'evaluations' THEN RAISE EXCEPTION 'Import job % is %, not evaluations', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='games' AND v_job.job_type<>'games' THEN RAISE EXCEPTION 'Import job % is %, not games', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  -- 20261122010000: only a staged import that has not been applied is cancelled. Without this check an APPLIED job was
  -- marked failed and audited as canceled while everything it wrote stayed, and it left its roll back.
  IF v_job.status <> 'ready_to_apply' THEN RAISE EXCEPTION 'Import job % is %, not ready_to_apply: only a staged import that has not been applied can be cancelled', p_import_job_id, v_job.status USING ERRCODE='22023', DETAIL='import_not_ready_to_apply'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','canceled','import_type',v_import_type,'staged_rows',v_staged_rows,'canceled_at',now());
  UPDATE public.import_jobs SET status='failed',completed_at=now(),error_summary=jsonb_set(COALESCE(error_summary,'{}'::jsonb),'{deferred_apply}',v_result,true),warning_summary=jsonb_set(COALESCE(warning_summary,'{}'::jsonb),'{deferred_apply}',v_result,true) WHERE id=p_import_job_id;
  PERFORM public.record_audit_event(v_job.organization_id,'import.canceled','import_job',p_import_job_id,v_result);
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 12. get_schedule_tbd, copied whole from 20261108020000. Changed: it returns game_date and external_ref.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_schedule_tbd(p_season_settings_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_org uuid;
    v_rows jsonb;
BEGIN
    IF p_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'p_season_settings_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT ss.organization_id INTO v_org
      FROM public.season_settings ss
     WHERE ss.id = p_season_settings_id;

    -- A season that does not exist and a season of another organization read alike.
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: the TIME TBD list is read by an administrator of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'kind', s.kind,
               'season_settings_id', s.season_settings_id,
               'division_id', s.division_id,
               'division_name', d.name,
               'team_id', s.team_id,
               'team_name', t.name,
               'home_team_id', s.home_team_id,
               'home_team_name', th.name,
               'away_team_id', s.away_team_id,
               'away_team_name', ta.name,
               'week_index', s.week_index,
               'missing_count', s.missing_count,
               'reason', s.reason,
               'detail', s.detail,
               'run_id', s.run_id,
               -- 20261122010000: the date a file gave a TIME TBD game, and its Game ID (20261121010000's columns).
               'game_date', s.game_date,
               'external_ref', s.external_ref,
               'created_at', s.created_at)
             ORDER BY s.kind, d.name, COALESCE(t.name, th.name), s.week_index NULLS FIRST, ta.name, s.id), '[]'::jsonb)
      INTO v_rows
      FROM public.schedule_tbd s
      JOIN public.divisions d ON d.id = s.division_id AND d.organization_id = s.organization_id
      LEFT JOIN public.teams t ON t.id = s.team_id AND t.organization_id = s.organization_id
      LEFT JOIN public.teams th ON th.id = s.home_team_id AND th.organization_id = s.organization_id
      LEFT JOIN public.teams ta ON ta.id = s.away_team_id AND ta.organization_id = s.organization_id
     WHERE s.organization_id = v_org
       AND s.season_settings_id = p_season_settings_id;

    RETURN v_rows;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 13. Standings: computed from scores; an outside club has no row and is not counted unless the organization says so.
-- ---------------------------------------------------------------------------
--
-- The seam the settings cascade (F11-4) extends: today the organization's setting, off unless it is a boolean true.

-- SECURITY DEFINER, and it has to be: the view is security_invoker, so this runs as the signed-in reader, and `org_flag`
-- is closed to every client role (20261021010000). As an invoker it failed every member's read of the standings with
-- 42501 as soon as an own team had a result against an outside club. As a definer it reads ONE boolean of ONE setting
-- for a division, and only for a member of that division's organization (`is_org_member`, as the table policies ask):
-- for anyone else it answers false, so it is not a way to read another organization's setting.
CREATE FUNCTION public.standings_counts_outside(p_division_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE((SELECT public.org_flag(d.organization_id, 'standings_count_outside_results', false)
                       FROM public.divisions d
                      WHERE d.id = p_division_id
                        AND public.is_org_member(d.organization_id)), false)
$$;

REVOKE ALL ON FUNCTION public.standings_counts_outside(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.standings_counts_outside(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.standings_counts_outside(uuid) IS
    'Whether a division''s standings count its teams'' results against outside clubs (teams.is_external). Today the organization''s standings_count_outside_results setting, false unless set; the program and division levels (F11-4) replace this one body. SECURITY DEFINER because view_league_standings calls it as its reader and org_flag is closed to client roles; it answers false for a division of an organization the caller is not a member of. 20261122010000.';

-- The same fourteen columns in the same order (CREATE OR REPLACE keeps the grants and the reader''s rights), and one
-- appended. The CTE is still named game_results; it now reads the score table.
CREATE OR REPLACE VIEW public.view_league_standings
WITH (security_invoker = true)
AS
WITH sides AS (
    SELECT gs.game_id, gs.home_team_id AS team_id, gs.away_team_id AS opponent_id,
           gs.score_home AS goals_for, gs.score_away AS goals_against
      FROM public.game_scores gs
    UNION ALL
    SELECT gs.game_id, gs.away_team_id AS team_id, gs.home_team_id AS opponent_id,
           gs.score_away AS goals_for, gs.score_home AS goals_against
      FROM public.game_scores gs
),
game_results AS (
    SELECT s.game_id, s.team_id, s.goals_for, s.goals_against,
           -- A result counts for a team when its opponent is one of the organization's own teams, or the opponent is an
           -- outside club and the own team's division counts those.
           (NOT opp.is_external OR public.standings_counts_outside(own.division_id)) AS counted
      FROM sides s
      JOIN public.teams own ON own.id = s.team_id
      JOIN public.teams opp ON opp.id = s.opponent_id
     WHERE NOT own.is_external
)
SELECT
    t.id AS team_id,
    t.organization_id,
    t.name AS team_name,
    t.division_id,
    COUNT(gr.game_id) FILTER (WHERE gr.counted) AS games_played,
    COALESCE(SUM(CASE WHEN gr.goals_for > gr.goals_against THEN 1 ELSE 0 END) FILTER (WHERE gr.counted), 0::bigint) AS wins,
    COALESCE(SUM(CASE WHEN gr.goals_for < gr.goals_against THEN 1 ELSE 0 END) FILTER (WHERE gr.counted), 0::bigint) AS losses,
    COALESCE(SUM(CASE WHEN gr.goals_for = gr.goals_against THEN 1 ELSE 0 END) FILTER (WHERE gr.counted), 0::bigint) AS draws,
    COALESCE(SUM(gr.goals_for) FILTER (WHERE gr.counted), 0::bigint) AS goals_for,
    COALESCE(SUM(gr.goals_against) FILTER (WHERE gr.counted), 0::bigint) AS goals_against,
    COALESCE(SUM(gr.goals_for) FILTER (WHERE gr.counted), 0::bigint)
        - COALESCE(SUM(gr.goals_against) FILTER (WHERE gr.counted), 0::bigint) AS goal_differential,
    COALESCE(SUM(CASE WHEN gr.goals_for > gr.goals_against THEN 1 ELSE 0 END) FILTER (WHERE gr.counted), 0::bigint) * 3
        + COALESCE(SUM(CASE WHEN gr.goals_for = gr.goals_against THEN 1 ELSE 0 END) FILTER (WHERE gr.counted), 0::bigint) AS points,
    d.name AS division,
    d.season_settings_id,
    -- 20261122010000: how many of the team's results are NOT counted above (against an outside club, the setting off),
    -- so the page can say what its numbers leave out.
    COUNT(gr.game_id) FILTER (WHERE NOT gr.counted) AS results_not_counted
FROM public.teams t
LEFT JOIN public.divisions d ON d.id = t.division_id
LEFT JOIN game_results gr ON gr.team_id = t.id
-- An outside club is not one of the organization's teams: it never has a standings row.
WHERE NOT t.is_external
GROUP BY t.id, t.organization_id, t.name, t.division_id, d.name, d.season_settings_id;

-- ---------------------------------------------------------------------------
-- 14. "The schedule": per organization and season, the latest completed game run.
-- ---------------------------------------------------------------------------
--
-- `useSchedulerRun('game')` in SQL: a game run that is completed, of the season (named in season_settings_id or in the
-- older season_id), the latest by completed_at (descending, as PostgREST orders it: a NULL first), then by created_at
-- and id so the choice is one row whatever the ties. A run that names no season is in no row, as the page reads none
-- without a season. The readers F11-3 repoints ask this view; a parity test holds it to the hook.

CREATE VIEW public.current_game_runs
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (s.organization_id, s.id)
       s.organization_id,
       s.id AS season_settings_id,
       sr.id AS run_id,
       sr.completed_at
  FROM public.season_settings s
  JOIN public.scheduler_runs sr
    ON sr.organization_id = s.organization_id
   AND sr.run_type = 'game'
   AND sr.status = 'completed'
   AND (sr.season_settings_id = s.id OR sr.season_id = s.id)
 ORDER BY s.organization_id, s.id, sr.completed_at DESC, sr.created_at DESC, sr.id DESC;

REVOKE ALL ON public.current_game_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.current_game_runs TO authenticated, service_role;
COMMENT ON VIEW public.current_game_runs IS
    'Per organization and season, the latest completed game run: the one SQL definition of "the schedule" (the rule of useSchedulerRun). Security invoker: a reader sees the runs scheduler_runs lets them see. 20261122010000.';

-- ---------------------------------------------------------------------------
-- 15. The legacy scores are copied, or the migration stops (nothing applied).
-- ---------------------------------------------------------------------------

DO $copy$
DECLARE
    v jsonb;
BEGIN
    v := public.copy_legacy_game_scores();
    RAISE NOTICE 'legacy scores: % scored row(s) in games, % copied to game_scores', v ->> 'scored', v ->> 'copied';
END;
$copy$;

-- ---------------------------------------------------------------------------
-- 16. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_fn text;
    v_src text;
BEGIN
    -- The score table: RLS on, one SELECT policy, no write grant to a client role, the completed-season trigger, the key.
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.game_scores'::regclass) THEN
        RAISE EXCEPTION 'game_scores has no row level security';
    END IF;
    IF (SELECT string_agg(p.polcmd::text, ',') FROM pg_policy p WHERE p.polrelid = 'public.game_scores'::regclass) IS DISTINCT FROM 'r' THEN
        RAISE EXCEPTION 'game_scores must have exactly one policy, for SELECT';
    END IF;
    IF has_table_privilege('anon', 'public.game_scores', 'SELECT')
       OR has_table_privilege('authenticated', 'public.game_scores', 'INSERT')
       OR has_table_privilege('authenticated', 'public.game_scores', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.game_scores', 'DELETE')
       OR NOT has_table_privilege('authenticated', 'public.game_scores', 'SELECT') THEN
        RAISE EXCEPTION 'game_scores: a signed-in user reads and nothing else; anon nothing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.game_scores'::regclass
                      AND t.tgname = 'game_scores_readonly_when_completed' AND NOT t.tgisinternal) THEN
        RAISE EXCEPTION 'the completed-season trigger on game_scores is gone';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.game_scores'::regclass AND c.contype = 'f'
                      AND c.confrelid = 'public.game_assignments'::regclass AND c.confdeltype = 'a' AND c.confupdtype = 'a'
                      AND cardinality(c.conkey) = 4) THEN
        RAISE EXCEPTION 'game_scores is not keyed to the saved game and its sides with NO ACTION';
    END IF;

    -- The predicate and its helpers: STABLE invoker functions pinned to search_path, closed to every client role and PUBLIC.
    FOREACH v_fn IN ARRAY ARRAY['game_held_ids(uuid[])', 'game_is_held(uuid)', 'game_hold_code(uuid)'] LOOP
        IF NOT (SELECT p.provolatile = 's' AND NOT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
                  FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn)) THEN
            RAISE EXCEPTION '% is not a STABLE invoker function pinned to search_path=public', v_fn;
        END IF;
        IF has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = to_regprocedure('public.' || v_fn) AND a.grantee = 0) THEN
            RAISE EXCEPTION '% is executable by a client role or PUBLIC', v_fn;
        END IF;
    END LOOP;
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.game_held_ids(uuid[])')) !~ 'game_scores' THEN
        RAISE EXCEPTION 'game_held_ids does not read game_scores';
    END IF;
    -- The setting read the standings view makes as its reader: a definer with a pinned search path (org_flag is closed
    -- to client roles), open to a signed-in user and to nobody anonymous.
    IF NOT (SELECT p.prosecdef AND p.provolatile = 's' AND p.proconfig @> ARRAY['search_path=public']
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.standings_counts_outside(uuid)'))
       OR NOT has_function_privilege('authenticated', 'public.standings_counts_outside(uuid)', 'EXECUTE')
       OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.standings_counts_outside(uuid)')) !~ 'is_org_member' THEN
        RAISE EXCEPTION 'standings_counts_outside is not the member-checked definer the standings view needs';
    END IF;
    IF has_function_privilege('anon', 'public.copy_legacy_game_scores()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.copy_legacy_game_scores()', 'EXECUTE')
       OR has_function_privilege('anon', 'public.standings_counts_outside(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'copy_legacy_game_scores or standings_counts_outside is open to a role it should not be';
    END IF;

    -- Every definer function this migration replaced is still a definer with a pinned search path, closed to anon and
    -- PUBLIC, and open to a signed-in user exactly when it is not the trigger function.
    FOREACH v_fn IN ARRAY ARRAY[
        'game_assignments_published_guard()',
        'persist_game_schedule(jsonb, jsonb)',
        'admin_cancel_game_assignment(uuid)',
        'admin_delete_team(uuid)',
        'update_game_score(uuid, uuid, smallint, smallint, jsonb)',
        'apply_game_import_job(uuid, boolean)',
        'rollback_game_import_job(uuid)',
        'cancel_ready_import_job(uuid, text)',
        'get_schedule_tbd(uuid)'
    ] LOOP
        IF NOT (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public'] FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn)) THEN
            RAISE EXCEPTION '% is not a definer function with a pinned search path', v_fn;
        END IF;
        IF has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.oid = to_regprocedure('public.' || v_fn) AND a.grantee = 0) THEN
            RAISE EXCEPTION '% is executable by anon or PUBLIC', v_fn;
        END IF;
        IF (v_fn <> 'game_assignments_published_guard()')
           IS DISTINCT FROM has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE') THEN
            RAISE EXCEPTION '%: authenticated may execute it exactly when it is not the trigger function', v_fn;
        END IF;
    END LOOP;

    -- Each replaced body is this migration's (a marker the old body did not have), and keeps what it had.
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.persist_game_schedule(jsonb, jsonb)');
    IF v_src !~ 'game_scored_omitted' OR v_src !~ 'game_published_omitted' OR v_src !~ 'game_identity_conflict' OR v_src !~ 'game_held_ids' THEN
        RAISE EXCEPTION 'persist_game_schedule is not the 20261120010000 body naming scored games';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.game_assignments_published_guard()');
    IF v_src !~ 'game_scored' OR v_src !~ 'game_published' OR v_src !~ 'game_is_held' OR v_src !~ 'squadlogic.import_rollback' THEN
        RAISE EXCEPTION 'the guard is not the 20261121010000 body naming scored games';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_cancel_game_assignment(uuid)');
    IF v_src !~ 'game_scored' OR v_src !~ 'game\.cancelled' OR v_src !~ 'game_is_held' THEN
        RAISE EXCEPTION 'admin_cancel_game_assignment is not the body naming scored games';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_delete_team(uuid)');
    IF v_src !~ 'game_scores_deleted' OR v_src !~ 'game_published' OR v_src !~ 'schedule_tbd_deleted' OR v_src !~ 'game_held_ids' THEN
        RAISE EXCEPTION 'admin_delete_team is not the body that takes the scores with it';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.update_game_score(uuid, uuid, smallint, smallint, jsonb)');
    IF v_src !~ 'game_scores' OR v_src ~ 'public\.games\M' OR v_src !~ 'score_one_sided' OR v_src !~ 'competition\.score_updated' OR v_src !~ 'score_entry' THEN
        RAISE EXCEPTION 'update_game_score is not the body that writes game_scores';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.apply_game_import_job(uuid, boolean)');
    IF v_src !~ 'skipped-scored' OR v_src !~ 'skipped-published' OR v_src !~ 'bad-week' OR v_src !~ 'game_held_ids' THEN
        RAISE EXCEPTION 'apply_game_import_job is not the body that skips scored games';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.rollback_game_import_job(uuid)');
    IF v_src !~ 'game_scores' OR v_src !~ 'game_import_changed' THEN
        RAISE EXCEPTION 'rollback_game_import_job is not the body that refuses after a score';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.cancel_ready_import_job(uuid, text)');
    IF v_src !~ 'import_not_ready_to_apply' OR v_src !~ 'import\.canceled' THEN
        RAISE EXCEPTION 'cancel_ready_import_job does not refuse a job that is not ready_to_apply';
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_schedule_tbd(uuid)');
    IF v_src !~ 'game_date' OR v_src !~ 'external_ref' THEN
        RAISE EXCEPTION 'get_schedule_tbd does not return game_date and external_ref';
    END IF;

    -- The standings view: the reader's rights, no legacy table, no outside club; the runs view the same rights.
    IF NOT (SELECT c.reloptions @> ARRAY['security_invoker=true'] FROM pg_class c WHERE c.oid = 'public.view_league_standings'::regclass)
       OR NOT (SELECT c.reloptions @> ARRAY['security_invoker=true'] FROM pg_class c WHERE c.oid = 'public.current_game_runs'::regclass) THEN
        RAISE EXCEPTION 'a view of this migration is not security_invoker';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
                WHERE r.ev_class = 'public.view_league_standings'::regclass AND d.refobjid = 'public.games'::regclass) THEN
        RAISE EXCEPTION 'view_league_standings still reads the legacy games table';
    END IF;
    IF pg_get_viewdef('public.view_league_standings'::regclass) !~ 'is_external' THEN
        RAISE EXCEPTION 'view_league_standings does not leave outside clubs out';
    END IF;
    IF has_table_privilege('anon', 'public.current_game_runs', 'SELECT') THEN
        RAISE EXCEPTION 'current_game_runs is readable by anon';
    END IF;
END;
$check$;

COMMIT;
