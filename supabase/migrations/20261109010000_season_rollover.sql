-- Start the next season from this one; draft editing, activation, the age cutoff and division
-- windows; drafts take imports; completed seasons are read-only (Phase E3, PR E3b; plans
-- docs/changes/2026-10-22-phase-e-seasons.md, "The seven points", "Concurrency", Decisions 4-7, and
-- docs/changes/2026-10-27-season-enrollment.md, C3; both settled by the owner).
--
-- **Why.** E3a made a player and a coach belong to one season, so an import into another season
-- touches no other season's row. Nothing could yet make a second season, edit it, or import
-- into it: E1 refused every import but the active season's (22023, `season_not_active`) and no
-- RPC created a draft. This is the first migration able to make one.
--
-- **The change.**
--   1. `season_settings.age_cutoff_month` and `age_cutoff_day`; `age_cutoff_mode` gains `custom`
--      (a club's own cutoff day, applied every season year). The default `school_year_aug_jul`
--      and `birth_year` stand. `divisions.birthdate_start/end` already exist and core treats them
--      as authoritative; the import's natural age now honours them too (Edge Function and core).
--   2. Four admin RPCs, each SECURITY DEFINER, `is_org_admin` of the season's own organization (one
--      refusal, 42501, for a missing row and another organization's), each taking the
--      organization's season lock (`pg_advisory_xact_lock(hashtextextended('season:' || org, 0))`,
--      the one the program writers take) and re-reading what it changes, each audited:
--        * `admin_create_season_from(source, name, season_year, start, end)` copies the source's
--          divisions and programs and no player, coach or team; every division column comes from
--          `rollover_division_columns()` (a column added later fails pgTAP until it is classified
--          as copied or skipped), a birth-date window shifts by the difference in season years, the
--          new season's trigger-made default program is the source default's copy. The new season is
--          a draft. Audited as `season.created_from`.
--        * `admin_update_draft_season(season, patch)`: name and dates on a draft or the active
--          season; `age_cutoff_mode`, the custom cutoff and `season_year` on a draft only. A key
--          present with JSON null clears. Audited as `season.updated`.
--        * `admin_set_division_birthdate_window(division, start, end)`: a division's optional window.
--          Audited as `division.window_changed`.
--        * `admin_activate_season(season)`: a draft only (a completed season is never reactivated),
--          needing a known timezone, both dates (end not before start) and a season year; completes
--          the previous active season, then activates this one, in two statements so the partial
--          index never sees two. Audited as `season.activated`.
--   3. Once a season has players, or a player import is in progress for it (a job not yet
--      finished with staged rows not yet promoted: validation has already staged each natural age
--      under the old rule and finalization copies it), its cutoff, season year and its divisions'
--      windows cannot change (22023, `season_has_players` / `import_pending`): triggers on
--      `season_settings` and `divisions`, so every writer meets them, not only the RPCs above. Ages
--      are not recomputed: the admin finishes or cancels the import first.
--   4. Completed seasons are read-only, players, coaches and schedules included: a trigger on each
--      of `players`, `coaches`, `teams`, `team_players`, `team_coach_assignments`,
--      `practice_assignments`, `practice_exceptions` and `game_assignments` refuses any insert,
--      update or delete by a signed-in caller (an RPC or a direct write; 22023, `season_completed`).
--      Triggers, not edits to the schedule writers, so the writers stay as they are. A job with no
--      signed-in user (the retention job, the demo purge) and a cascade from a deleted season or
--      organization pass: an admin's own "delete this season's data" is a later change.
--   5. The E1 guard changes from "the active season only" to "the active season or a draft; never a
--      completed one", in `create_import_job` (registration jobs), `finalize_import_job` and
--      `finalize_coach_import_job`, each behind the md5 of its current text. A field import
--      (`finalize_field_import_job`, organization-level locations and fields) stays active-only.
--   6. A player file is stamped with the revision of the age rule it was validated under. A season's
--      `age_rule_revision` only ever goes up, bumped by a trigger on every change that moves an age
--      (the cutoff, the season year, and a window-bearing division's window, band or, where the
--      name supplies the band, name). One service-role RPC, `import_age_rule`, returns the rule the
--      validation counts ages with and its revision from one statement, and stamps the job with
--      that revision; the validation computes from what it returned. `finalize_import_job` refuses,
--      under the season lock, a job whose stamp is not the season's revision now (22023,
--      `age_rule_changed`): the window between the validation's read and its first staged row, which
--      the pending-import guard cannot see, including a change and its reversal (A, B, A). A job with
--      no stamp is not refused.
--   7. An end-state check.
--
-- **Production's bodies are not read from here.** The migration refuses to replace a function
-- whose text it has not seen (the md5 of `prosrc`, carriage returns stripped, below; read off a
-- build of the repository at 20261108010000 and compared with production's on 2026-10-28).
--
-- Reversible in structure: docs/sql/20261109010000_revert.sql restores the three bodies and drops
-- everything else here. Smoke: docs/sql/20261109010000_smoke.sql. pgTAP: supabase/tests/season_rollover.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting bodies are checked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected constant jsonb := '{
        "create_import_job(uuid,text,text,uuid)": "53aed1ffa0c6cea863e60f7ceaba3b02",
        "finalize_import_job(uuid,jsonb)": "883613a7e965168c40e909fb6537dcae",
        "finalize_coach_import_job(uuid,jsonb)": "1199debf6d15fcd15eacc1eeee77054f"
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

-- Audit actions are registered (`audit_log.action` is a foreign key to `audit_actions`).
INSERT INTO public.audit_actions (action) VALUES
    ('season.created_from'),
    ('season.updated'),
    ('season.activated'),
    ('division.window_changed')
ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The custom cutoff.
-- ---------------------------------------------------------------------------

ALTER TABLE public.season_settings
    ADD COLUMN age_cutoff_month smallint,
    ADD COLUMN age_cutoff_day smallint;

ALTER TABLE public.season_settings DROP CONSTRAINT season_settings_age_cutoff_mode_check;
ALTER TABLE public.season_settings
    ADD CONSTRAINT season_settings_age_cutoff_mode_check
    CHECK (age_cutoff_mode IN ('birth_year', 'school_year_aug_jul', 'custom'));
-- A custom season has a real calendar day (February 29 is accepted) and no other mode has one.
ALTER TABLE public.season_settings
    ADD CONSTRAINT season_settings_age_cutoff_day_check
    CHECK (
        (age_cutoff_mode = 'custom'
         AND age_cutoff_month BETWEEN 1 AND 12
         AND age_cutoff_day BETWEEN 1 AND CASE age_cutoff_month
                                              WHEN 2 THEN 29
                                              WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
                                              ELSE 31 END)
        OR (age_cutoff_mode <> 'custom' AND age_cutoff_month IS NULL AND age_cutoff_day IS NULL)
    );

COMMENT ON COLUMN public.season_settings.age_cutoff_mode IS
    'Age-group cutoff model: school_year_aug_jul (Aug 1; the default), birth_year (Jan 1 - Dec 31) or custom (age_cutoff_month / age_cutoff_day, every season year). Changed only on a draft season with no players (admin_update_draft_season; season_settings_cutoff_guard). 20261109010000.';
COMMENT ON COLUMN public.season_settings.age_cutoff_month IS
    'The custom cutoff''s month (1-12); NULL unless age_cutoff_mode is custom. A player born on or after the cutoff day is in the cohort one U-number younger; Jan 1 is the calendar year. 20261109010000.';
COMMENT ON COLUMN public.season_settings.age_cutoff_day IS
    'The custom cutoff''s day of the month; NULL unless age_cutoff_mode is custom. 20261109010000.';

-- ---------------------------------------------------------------------------
-- 3. What a rollover copies, from a catalogue the tests hold to the table.
-- ---------------------------------------------------------------------------
--
-- A copied column is read by name; a column nobody has classified fails supabase/tests/season_rollover.sql
-- (and the smoke), so a division or season setting added later is either copied or deliberately not.

CREATE FUNCTION public.rollover_division_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT ARRAY[
        'organization_id', 'name', 'gender_policy', 'max_roster_size', 'play_format', 'format',
        'min_roster_size', 'target_team_size', 'team_count_override', 'min_teams', 'max_teams',
        'min_age', 'max_age', 'birthdate_start', 'birthdate_end', 'plays_games',
        'practices_per_week', 'practice_minutes'
    ]::text[];
$$;

CREATE FUNCTION public.rollover_division_skipped_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    -- program_id is remapped to the new season's program; season_start and season_end are the
    -- source season's own dates.
    SELECT ARRAY['id', 'season_settings_id', 'program_id', 'season_start', 'season_end',
                 'created_at', 'updated_at']::text[];
$$;

CREATE FUNCTION public.rollover_season_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT ARRAY['timezone', 'age_cutoff_mode', 'age_cutoff_month', 'age_cutoff_day',
                 'school_day_end', 'roster_formula', 'exports_config']::text[];
$$;

CREATE FUNCTION public.rollover_season_skipped_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    -- name, season_year, season_start and season_end are the new season's own; the dated daylight
    -- adjustments belong to the source season's calendar; the age-rule revision counts this season's
    -- own changes.
    SELECT ARRAY['id', 'organization_id', 'name', 'status', 'season_label', 'season_year',
                 'season_start', 'season_end', 'daylight_adjustments', 'age_rule_revision', 'created_at', 'updated_at']::text[];
$$;

REVOKE ALL ON FUNCTION public.rollover_division_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollover_division_skipped_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollover_season_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollover_season_skipped_columns() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.rollover_division_columns() IS
    'The divisions columns admin_create_season_from copies. With rollover_division_skipped_columns() it names every column of divisions (held by supabase/tests/season_rollover.sql). 20261109010000.';
COMMENT ON FUNCTION public.rollover_season_columns() IS
    'The season_settings columns admin_create_season_from copies. With rollover_season_skipped_columns() it names every column (held by supabase/tests/season_rollover.sql). 20261109010000.';

-- ---------------------------------------------------------------------------
-- 4. Once a season has players, its age rule does not change.
-- ---------------------------------------------------------------------------
--
-- Their stored natural ages were computed with the rule in force. Triggers, so every writer meets
-- them: the RPCs below, a direct write, a future writer. SECURITY DEFINER so the players are
-- counted whatever the caller's row level security shows.

-- A player import in progress for the season: an unfinished registration job (not completed, not
-- failed, which is what cancelling one is) with staged player rows not yet promoted. A legacy job with
-- no season (made before 20261101010000) finalizes into the organization's active season.
CREATE FUNCTION public.season_has_pending_player_import(p_season_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.season_settings s
          JOIN public.import_jobs j
            ON j.organization_id = s.organization_id
           AND (j.season_settings_id = s.id OR (j.season_settings_id IS NULL AND s.status = 'active'))
         WHERE s.id = p_season_id
           AND j.job_type = 'registration'
           AND j.status NOT IN ('completed', 'completed_with_warnings', 'failed')
           AND EXISTS (SELECT 1 FROM public.staging_players sp
                        WHERE sp.import_job_id = j.id AND sp.promoted_at IS NULL)
    );
$$;

REVOKE ALL ON FUNCTION public.season_has_pending_player_import(uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.season_has_pending_player_import(uuid) IS
    'True while a player import is in progress for the season (an unfinished registration job with staged rows not yet promoted): its natural ages are staged under the rule in force, so the rule does not change until the import is finished or cancelled. 20261109010000.';

-- The age rule a player file was checked under. import-validation counts each natural age under the
-- season's rule and stages it; a rule change made after its read but before its first staged row
-- finds nothing pending to refuse (the guard above), and a change followed by its reversal leaves
-- a rule that looks unchanged. So the season carries a revision that only goes up, bumped by a
-- trigger on every change that moves an age; the validation takes the rule and its revision from
-- one statement (`import_age_rule`), stamps the job with that revision and counts ages from what the
-- statement returned; the finalizer refuses a job whose stamp is not the season's revision now
-- (22023, `age_rule_changed`): the file is validated again.
ALTER TABLE public.season_settings ADD COLUMN age_rule_revision bigint NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.season_settings.age_rule_revision IS
    'Goes up by one on every change that moves a natural age: the cutoff mode, month or day, the season year, and a window-bearing division''s window, age band or (where the name supplies the band) name. Never reset. import_age_rule stamps a player file with it; finalize_import_job refuses a file stamped with another (age_rule_changed). 20261109010000.';

ALTER TABLE public.import_jobs ADD COLUMN age_rule_season_id uuid;
ALTER TABLE public.import_jobs ADD COLUMN age_rule_revision bigint;
COMMENT ON COLUMN public.import_jobs.age_rule_season_id IS
    'The season whose age rule the player file was validated under (with age_rule_revision). NULL: not stamped. 20261109010000.';
COMMENT ON COLUMN public.import_jobs.age_rule_revision IS
    'season_settings.age_rule_revision when the player file was validated; finalize_import_job refuses the job when the season''s revision is another (age_rule_changed). NULL: not stamped (a coach or field job, or one made before 20261109010000), never refused. 20261109010000.';

-- The rule the validation counts ages with, and its revision, from ONE statement (one snapshot), so
-- the revision is the revision of exactly the data returned. With a job it also stamps the job with
-- that revision: `p_restart` (the first batch of a file) replaces an earlier stamp, a later batch
-- keeps the first's. The season is the job's own, else the organization's active one (as the
-- finalizer resolves it); no season: NULL, and nothing is stamped.
CREATE FUNCTION public.import_age_rule(p_organization_id uuid, p_import_job_id uuid DEFAULT NULL, p_restart boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job_season uuid;
    v_rule jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF p_import_job_id IS NOT NULL THEN
        SELECT j.season_settings_id INTO v_job_season
          FROM public.import_jobs j
         WHERE j.id = p_import_job_id AND j.organization_id = p_organization_id AND j.job_type = 'registration';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Import job % not found for organization %', p_import_job_id, p_organization_id
                USING ERRCODE = 'P0002';
        END IF;
    END IF;

    SELECT jsonb_build_object(
               'season_id', s.id,
               'status', s.status,
               'season_year', s.season_year,
               'age_cutoff_mode', s.age_cutoff_mode,
               'age_cutoff_month', s.age_cutoff_month,
               'age_cutoff_day', s.age_cutoff_day,
               'revision', s.age_rule_revision,
               -- Only a division with both ends can take a player by birth date.
               'divisions', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                              'name', d.name, 'min_age', d.min_age, 'max_age', d.max_age,
                              'birthdate_start', d.birthdate_start, 'birthdate_end', d.birthdate_end)
                          ORDER BY d.id)
                     FROM public.divisions d
                    WHERE d.season_settings_id = s.id
                      AND d.birthdate_start IS NOT NULL AND d.birthdate_end IS NOT NULL), '[]'::jsonb))
      INTO v_rule
      FROM public.season_settings s
     WHERE s.organization_id = p_organization_id
       AND (CASE WHEN v_job_season IS NULL THEN s.status = 'active' ELSE s.id = v_job_season END);

    IF v_rule IS NOT NULL AND p_import_job_id IS NOT NULL THEN
        UPDATE public.import_jobs
           SET age_rule_season_id = (v_rule ->> 'season_id')::uuid,
               age_rule_revision = (v_rule ->> 'revision')::bigint
         WHERE id = p_import_job_id
           AND (p_restart OR age_rule_revision IS NULL);
    END IF;
    RETURN v_rule;
END;
$$;

REVOKE ALL ON FUNCTION public.import_age_rule(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_age_rule(uuid, uuid, boolean) TO service_role;
COMMENT ON FUNCTION public.import_age_rule(uuid, uuid, boolean) IS
    'Service role only (import-validation): the age rule a player file is counted under (season, cutoff, season year, window-bearing divisions) and its revision, from one statement; with a job it stamps the job with that revision (p_restart replaces an earlier stamp). NULL when the organization has no season for the job. 20261109010000.';

CREATE FUNCTION public.season_settings_cutoff_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.players p WHERE p.season_settings_id = OLD.id) THEN
        RAISE EXCEPTION 'Season % has players: its age cutoff and season year cannot change', OLD.id
            USING ERRCODE = '22023', DETAIL = 'season_has_players';
    END IF;
    IF public.season_has_pending_player_import(OLD.id) THEN
        RAISE EXCEPTION 'Season % has a player import in progress: finish or cancel it before its age cutoff or season year changes', OLD.id
            USING ERRCODE = '22023', DETAIL = 'import_pending';
    END IF;
    -- A change that moves an age: the revision a validated file is checked against.
    NEW.age_rule_revision := OLD.age_rule_revision + 1;
    RETURN NEW;
END;
$$;

CREATE TRIGGER season_settings_cutoff_guard
    BEFORE UPDATE OF age_cutoff_mode, age_cutoff_month, age_cutoff_day, season_year ON public.season_settings
    FOR EACH ROW
    WHEN (OLD.age_cutoff_mode IS DISTINCT FROM NEW.age_cutoff_mode
          OR OLD.age_cutoff_month IS DISTINCT FROM NEW.age_cutoff_month
          OR OLD.age_cutoff_day IS DISTINCT FROM NEW.age_cutoff_day
          OR OLD.season_year IS DISTINCT FROM NEW.season_year)
    EXECUTE FUNCTION public.season_settings_cutoff_guard();

-- Does this change to a division move an age? Its window (new, moved or removed); or, for a division
-- that bears a window (before or after), its age band; or its name where the name supplies the band
-- (a band column is empty: "U4"). Shared by the guard and the revision trigger below.
CREATE FUNCTION public.division_age_rule_differs(p_old public.divisions, p_new public.divisions)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT p_old.birthdate_start IS DISTINCT FROM p_new.birthdate_start
        OR p_old.birthdate_end IS DISTINCT FROM p_new.birthdate_end
        OR (
            ((p_old.birthdate_start IS NOT NULL AND p_old.birthdate_end IS NOT NULL)
              OR (p_new.birthdate_start IS NOT NULL AND p_new.birthdate_end IS NOT NULL))
            AND (
                p_old.min_age IS DISTINCT FROM p_new.min_age
                OR p_old.max_age IS DISTINCT FROM p_new.max_age
                OR (p_old.name IS DISTINCT FROM p_new.name
                    AND (p_old.min_age IS NULL OR p_old.max_age IS NULL
                         OR p_new.min_age IS NULL OR p_new.max_age IS NULL))
            )
        );
$$;
REVOKE ALL ON FUNCTION public.division_age_rule_differs(public.divisions, public.divisions) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.division_age_rule_differs(public.divisions, public.divisions) IS
    'True when a change to a division moves a natural age: its birth-date window, or (for a division that bears one) its age band, or its name where the name supplies the band. 20261109010000.';

CREATE FUNCTION public.divisions_window_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NOT public.division_age_rule_differs(OLD, NEW) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.birthdate_start IS NULL AND NEW.birthdate_end IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.players p WHERE p.season_settings_id = NEW.season_settings_id) THEN
        RAISE EXCEPTION 'Season % has players: a division''s birth-date window or age band cannot change', NEW.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_has_players';
    END IF;
    IF public.season_has_pending_player_import(NEW.season_settings_id) THEN
        RAISE EXCEPTION 'Season % has a player import in progress: finish or cancel it before a division''s birth-date window or age band changes', NEW.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'import_pending';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER divisions_window_guard
    BEFORE INSERT OR UPDATE OF birthdate_start, birthdate_end, min_age, max_age, name ON public.divisions
    FOR EACH ROW EXECUTE FUNCTION public.divisions_window_guard();

-- The revision of the season's age rule goes up with every such change (after it is allowed), and
-- with the arrival or removal of a window-bearing division.
CREATE FUNCTION public.divisions_age_rule_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.birthdate_start IS NULL OR NEW.birthdate_end IS NULL THEN RETURN NEW; END IF;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.birthdate_start IS NULL OR OLD.birthdate_end IS NULL THEN RETURN OLD; END IF;
    ELSIF NOT public.division_age_rule_differs(OLD, NEW) THEN
        RETURN NEW;
    END IF;
    UPDATE public.season_settings
       SET age_rule_revision = age_rule_revision + 1
     WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.season_settings_id ELSE NEW.season_settings_id END;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER divisions_age_rule_revision
    AFTER INSERT OR UPDATE OR DELETE ON public.divisions
    FOR EACH ROW EXECUTE FUNCTION public.divisions_age_rule_revision();

REVOKE ALL ON FUNCTION public.season_settings_cutoff_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.divisions_window_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.divisions_age_rule_revision() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.season_settings_cutoff_guard() IS
    'Trigger function: refuses a change of a season''s age cutoff or season year once it has players (22023, season_has_players) or while a player import is in progress for it (22023, import_pending). 20261109010000.';
COMMENT ON FUNCTION public.divisions_window_guard() IS
    'Trigger function: refuses a new or changed division birth-date window, or the age band (or band-supplying name) of a division that bears one, once the division''s season has players (22023, season_has_players) or while a player import is in progress for it (22023, import_pending). 20261109010000.';
COMMENT ON FUNCTION public.divisions_age_rule_revision() IS
    'Trigger function: raises the season''s age_rule_revision when a division change moves a natural age, or a window-bearing division arrives or goes. 20261109010000.';

-- ---------------------------------------------------------------------------
-- 5. A completed season is read-only, players and coaches included.
-- ---------------------------------------------------------------------------
--
-- A caller who is signed in (an admin through an RPC, or a direct write) is refused; a job with no
-- signed-in user is not: the retention job (`minimise_import_people_data`) and the demo purge must
-- still reach every row. A delete that is the cascade of a deleted season or organization finds the
-- parent gone and passes, so removing an organization is not blocked by its completed seasons.

CREATE FUNCTION public.season_rows_readonly_when_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_season uuid;
    v_org uuid;
    v_status text;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'DELETE' THEN
        v_season := OLD.season_settings_id;
        v_org := OLD.organization_id;
    ELSE
        v_season := NEW.season_settings_id;
        v_org := NEW.organization_id;
    END IF;
    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_season;
    IF v_status = 'completed' THEN
        -- The cascade of a deleted organization: the season may not have been removed yet.
        IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org) THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'Season % is completed and read-only: its % cannot be changed', v_season, TG_TABLE_NAME
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Named to fire after `players_enforce_season` / `coaches_enforce_season`, which fill an insert's season.
CREATE TRIGGER players_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.players
    FOR EACH ROW EXECUTE FUNCTION public.season_rows_readonly_when_completed();
CREATE TRIGGER coaches_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.coaches
    FOR EACH ROW EXECUTE FUNCTION public.season_rows_readonly_when_completed();

-- The schedules of a completed season, by the same rule. A row's season is its team's division's
-- (a team has no season column), or `practice_exceptions.season_settings_id`. An update is judged on
-- the old row and the new, so a row cannot be moved out of a completed season either.
CREATE FUNCTION public.season_schedule_readonly_when_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_row jsonb;
    v_team uuid;
    v_division uuid;
    v_season uuid;
    v_status text;
    v_org uuid;
    v_pass integer;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    FOR v_pass IN 1 .. CASE WHEN TG_OP = 'UPDATE' THEN 2 ELSE 1 END LOOP
        v_row := to_jsonb(CASE WHEN TG_OP = 'DELETE' OR v_pass = 2 THEN OLD ELSE NEW END);
        IF TG_TABLE_NAME = 'practice_exceptions' THEN
            v_season := (v_row ->> 'season_settings_id')::uuid;
        ELSE
            IF TG_TABLE_NAME = 'teams' THEN
                v_division := (v_row ->> 'division_id')::uuid;
            ELSE
                v_team := COALESCE((v_row ->> 'team_id')::uuid, (v_row ->> 'home_team_id')::uuid,
                                   (v_row ->> 'away_team_id')::uuid);
                SELECT t.division_id INTO v_division FROM public.teams t WHERE t.id = v_team;
            END IF;
            SELECT d.season_settings_id INTO v_season FROM public.divisions d WHERE d.id = v_division;
        END IF;
        SELECT s.status, s.organization_id INTO v_status, v_org
          FROM public.season_settings s WHERE s.id = v_season;
        IF v_status = 'completed' THEN
            -- The cascade of a deleted organization: the season may not have been removed yet.
            IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org) THEN
                CONTINUE;
            END IF;
            RAISE EXCEPTION 'Season % is completed and read-only: its schedule (%) cannot be changed', v_season, TG_TABLE_NAME
                USING ERRCODE = '22023', DETAIL = 'season_completed';
        END IF;
    END LOOP;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER teams_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.teams
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();
CREATE TRIGGER team_players_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.team_players
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();
CREATE TRIGGER team_coach_assignments_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.team_coach_assignments
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();
CREATE TRIGGER practice_assignments_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.practice_assignments
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();
CREATE TRIGGER practice_exceptions_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.practice_exceptions
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();
CREATE TRIGGER game_assignments_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.game_assignments
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();

REVOKE ALL ON FUNCTION public.season_schedule_readonly_when_completed() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.season_schedule_readonly_when_completed() IS
    'Trigger function on teams, team_players, team_coach_assignments, practice_assignments, practice_exceptions and game_assignments: a signed-in caller cannot insert, update or delete a row of a completed season (22023, season_completed). Callers with no signed-in user and cascades from a deleted season, team or organization pass. 20261109010000.';

REVOKE ALL ON FUNCTION public.season_rows_readonly_when_completed() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.season_rows_readonly_when_completed() IS
    'Trigger function on players and coaches: a signed-in caller cannot insert, update or delete a row of a completed season (22023, season_completed). Callers with no signed-in user and cascades from a deleted season or organization pass. 20261109010000.';

-- ---------------------------------------------------------------------------
-- 6. The four writers.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.admin_create_season_from(
    p_source_season_id uuid,
    p_name text,
    p_season_year integer,
    p_season_start date DEFAULT NULL,
    p_season_end date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_org uuid;
    v_source public.season_settings%ROWTYPE;
    v_new_id uuid;
    v_shift integer;
    v_season_cols text;
    v_division_cols text;
    v_division_exprs text;
    v_programs integer := 0;
    v_divisions integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_source_season_id IS NULL THEN
        RAISE EXCEPTION 'p_source_season_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT s.organization_id INTO v_org FROM public.season_settings s WHERE s.id = p_source_season_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    -- The organization's season lock, then every season of it, so two admins at once are
    -- serialised and the source cannot change under the copy.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM 1 FROM public.season_settings s WHERE s.organization_id = v_org ORDER BY s.id FOR UPDATE;

    SELECT * INTO v_source FROM public.season_settings s WHERE s.id = p_source_season_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'season % no longer exists', p_source_season_id USING ERRCODE = '42501';
    END IF;

    IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'a season name must be 1 to 80 characters' USING ERRCODE = '22023';
    END IF;
    IF p_season_year IS NULL OR p_season_year NOT BETWEEN 2000 AND 2100 THEN
        RAISE EXCEPTION 'the season year (the year the season starts) must be between 2000 and 2100'
            USING ERRCODE = '22023', DETAIL = 'season_year_invalid';
    END IF;
    IF p_season_start IS NOT NULL AND p_season_end IS NOT NULL AND p_season_end < p_season_start THEN
        RAISE EXCEPTION 'the season cannot end before it starts' USING ERRCODE = '22023', DETAIL = 'season_dates_invalid';
    END IF;

    -- Decision 4: a division's birth-date window moves with the season year (one year for
    -- the next season). A source with no year moves it one year.
    v_shift := COALESCE(p_season_year - v_source.season_year, 1);

    -- The season: the catalogue's columns copied, the rest the new season's own. A draft.
    SELECT string_agg(quote_ident(c), ', ') INTO v_season_cols
      FROM unnest(public.rollover_season_columns()) AS c;
    BEGIN
        EXECUTE format(
            'INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, %s) '
            'SELECT s.organization_id, $2, ''draft'', $3, $4, $5, %s FROM public.season_settings s WHERE s.id = $1 '
            'RETURNING id',
            v_season_cols,
            (SELECT string_agg('s.' || quote_ident(c), ', ') FROM unnest(public.rollover_season_columns()) AS c))
        INTO v_new_id
        USING p_source_season_id, v_name, p_season_year, p_season_start, p_season_end;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'a season named "%" already exists', v_name USING ERRCODE = '23505';
    END;

    -- Programs: the source's own (non-default) programs, linked by copied_from_program_id; the
    -- new season's trigger-made default is the source default's copy.
    INSERT INTO public.programs (organization_id, season_settings_id, name, copied_from_program_id)
    SELECT p.organization_id, v_new_id, p.name, p.id
      FROM public.programs p
     WHERE p.season_settings_id = p_source_season_id AND NOT p.is_default;
    GET DIAGNOSTICS v_programs = ROW_COUNT;
    UPDATE public.programs np
       SET copied_from_program_id = sp.id
      FROM public.programs sp
     WHERE np.season_settings_id = v_new_id AND np.is_default
       AND sp.season_settings_id = p_source_season_id AND sp.is_default;

    -- Divisions: every catalogue column, a window shifted, each in the copy of its program.
    SELECT string_agg(quote_ident(c), ', ') INTO v_division_cols
      FROM unnest(public.rollover_division_columns()) AS c;
    SELECT string_agg(
               CASE WHEN c IN ('birthdate_start', 'birthdate_end')
                    THEN format('(d.%I + make_interval(years => $3))::date', c)
                    ELSE format('d.%I', c) END, ', ')
      INTO v_division_exprs
      FROM unnest(public.rollover_division_columns()) AS c;
    EXECUTE format(
        'INSERT INTO public.divisions (season_settings_id, program_id, %s) '
        'SELECT $2, np.id, %s FROM public.divisions d '
        'JOIN public.programs sp ON sp.id = d.program_id '
        'JOIN public.programs np ON np.season_settings_id = $2 AND np.copied_from_program_id = sp.id '
        'WHERE d.season_settings_id = $1',
        v_division_cols, v_division_exprs)
    USING p_source_season_id, v_new_id, v_shift;
    GET DIAGNOSTICS v_divisions = ROW_COUNT;

    -- A division the join dropped would be silently lost: the copy must be whole.
    IF v_divisions <> (SELECT count(*) FROM public.divisions d WHERE d.season_settings_id = p_source_season_id) THEN
        RAISE EXCEPTION 'season % was not copied whole: % of its divisions found a program', p_source_season_id, v_divisions
            USING ERRCODE = 'XX000';
    END IF;

    PERFORM public.record_audit_event(
        v_org,
        'season.created_from',
        'season_settings',
        v_new_id,
        jsonb_build_object(
            'source_season_id', p_source_season_id,
            'name', v_name,
            'season_year', p_season_year,
            'divisions_copied', v_divisions,
            'programs_copied', v_programs,
            'window_shift_years', v_shift
        )
    );

    RETURN jsonb_build_object(
        'id', v_new_id,
        'organization_id', v_org,
        'name', v_name,
        'status', 'draft',
        'season_year', p_season_year,
        'source_season_id', p_source_season_id,
        'divisions_copied', v_divisions,
        'programs_copied', v_programs
    );
END;
$$;

CREATE FUNCTION public.admin_update_draft_season(
    p_season_id uuid,
    p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_allowed constant text[] := ARRAY['name', 'season_start', 'season_end', 'season_year',
                                       'age_cutoff_mode', 'age_cutoff_month', 'age_cutoff_day'];
    v_cutoff_keys constant text[] := ARRAY['season_year', 'age_cutoff_mode', 'age_cutoff_month', 'age_cutoff_day'];
    v_key text;
    v_org uuid;
    v_old public.season_settings%ROWTYPE;
    v_new public.season_settings%ROWTYPE;
    v_changed jsonb := '{}'::jsonb;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_season_id IS NULL THEN
        RAISE EXCEPTION 'p_season_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'p_patch must be a json object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'a season''s % cannot be changed here', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;

    SELECT s.organization_id INTO v_org FROM public.season_settings s WHERE s.id = p_season_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM 1 FROM public.season_settings s WHERE s.organization_id = v_org ORDER BY s.id FOR UPDATE;

    SELECT * INTO v_old FROM public.season_settings s WHERE s.id = p_season_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'season % no longer exists', p_season_id USING ERRCODE = '42501';
    END IF;
    IF v_old.status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and cannot be changed', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    v_new := v_old;
    BEGIN
        IF p_patch ? 'name' THEN
            v_new.name := btrim(COALESCE(p_patch ->> 'name', ''));
            IF char_length(v_new.name) NOT BETWEEN 1 AND 80 THEN
                RAISE EXCEPTION 'a season name must be 1 to 80 characters' USING ERRCODE = '22023';
            END IF;
        END IF;
        IF p_patch ? 'season_start' THEN v_new.season_start := (p_patch ->> 'season_start')::date; END IF;
        IF p_patch ? 'season_end' THEN v_new.season_end := (p_patch ->> 'season_end')::date; END IF;
        IF p_patch ? 'season_year' THEN v_new.season_year := (p_patch ->> 'season_year')::integer; END IF;
        IF p_patch ? 'age_cutoff_mode' THEN v_new.age_cutoff_mode := p_patch ->> 'age_cutoff_mode'; END IF;
        IF p_patch ? 'age_cutoff_month' THEN v_new.age_cutoff_month := (p_patch ->> 'age_cutoff_month')::smallint; END IF;
        IF p_patch ? 'age_cutoff_day' THEN v_new.age_cutoff_day := (p_patch ->> 'age_cutoff_day')::smallint; END IF;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow
              OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'a value in the patch is not valid for its field' USING ERRCODE = '22023';
    END;

    IF v_new.season_start IS NOT NULL AND v_new.season_end IS NOT NULL AND v_new.season_end < v_new.season_start THEN
        RAISE EXCEPTION 'the season cannot end before it starts' USING ERRCODE = '22023', DETAIL = 'season_dates_invalid';
    END IF;
    IF v_new.season_year IS NOT NULL AND v_new.season_year NOT BETWEEN 2000 AND 2100 THEN
        RAISE EXCEPTION 'the season year (the year the season starts) must be between 2000 and 2100'
            USING ERRCODE = '22023', DETAIL = 'season_year_invalid';
    END IF;
    IF v_new.age_cutoff_mode IS NULL OR v_new.age_cutoff_mode NOT IN ('school_year_aug_jul', 'birth_year', 'custom') THEN
        RAISE EXCEPTION 'age_cutoff_mode must be school_year_aug_jul, birth_year or custom' USING ERRCODE = '22023';
    END IF;
    -- Only the custom mode carries a cutoff day; leaving it clears the day, and choosing it needs one.
    IF v_new.age_cutoff_mode <> 'custom' THEN
        v_new.age_cutoff_month := NULL;
        v_new.age_cutoff_day := NULL;
    ELSIF v_new.age_cutoff_month IS NULL OR v_new.age_cutoff_day IS NULL THEN
        RAISE EXCEPTION 'a custom age cutoff needs a month and a day' USING ERRCODE = '22023', DETAIL = 'cutoff_day_missing';
    ELSIF NOT (v_new.age_cutoff_month BETWEEN 1 AND 12
               AND v_new.age_cutoff_day BETWEEN 1 AND CASE v_new.age_cutoff_month
                                                         WHEN 2 THEN 29
                                                         WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
                                                         ELSE 31 END) THEN
        RAISE EXCEPTION 'the age cutoff is not a calendar day' USING ERRCODE = '22023', DETAIL = 'cutoff_day_invalid';
    END IF;

    IF v_new.name IS DISTINCT FROM v_old.name THEN
        v_changed := v_changed || jsonb_build_object('name', jsonb_build_object('old', v_old.name, 'new', v_new.name));
    END IF;
    IF v_new.season_start IS DISTINCT FROM v_old.season_start THEN
        v_changed := v_changed || jsonb_build_object('season_start', jsonb_build_object('old', v_old.season_start, 'new', v_new.season_start));
    END IF;
    IF v_new.season_end IS DISTINCT FROM v_old.season_end THEN
        v_changed := v_changed || jsonb_build_object('season_end', jsonb_build_object('old', v_old.season_end, 'new', v_new.season_end));
    END IF;
    IF v_new.season_year IS DISTINCT FROM v_old.season_year THEN
        v_changed := v_changed || jsonb_build_object('season_year', jsonb_build_object('old', v_old.season_year, 'new', v_new.season_year));
    END IF;
    IF v_new.age_cutoff_mode IS DISTINCT FROM v_old.age_cutoff_mode THEN
        v_changed := v_changed || jsonb_build_object('age_cutoff_mode', jsonb_build_object('old', v_old.age_cutoff_mode, 'new', v_new.age_cutoff_mode));
    END IF;
    IF v_new.age_cutoff_month IS DISTINCT FROM v_old.age_cutoff_month THEN
        v_changed := v_changed || jsonb_build_object('age_cutoff_month', jsonb_build_object('old', v_old.age_cutoff_month, 'new', v_new.age_cutoff_month));
    END IF;
    IF v_new.age_cutoff_day IS DISTINCT FROM v_old.age_cutoff_day THEN
        v_changed := v_changed || jsonb_build_object('age_cutoff_day', jsonb_build_object('old', v_old.age_cutoff_day, 'new', v_new.age_cutoff_day));
    END IF;

    IF v_changed = '{}'::jsonb THEN
        RETURN jsonb_build_object('id', v_old.id, 'status', v_old.status, 'changed', false);
    END IF;

    -- The year and the cutoff are the rule that counts a player's age: a draft only, and not
    -- once the season has players (season_settings_cutoff_guard says the second again).
    IF v_changed ?| v_cutoff_keys THEN
        IF v_old.status <> 'draft' THEN
            RAISE EXCEPTION 'Season % is % and its age cutoff and season year can only change on a draft', p_season_id, v_old.status
                USING ERRCODE = '22023', DETAIL = 'season_not_draft';
        END IF;
        IF EXISTS (SELECT 1 FROM public.players p WHERE p.season_settings_id = p_season_id) THEN
            RAISE EXCEPTION 'Season % has players: its age cutoff and season year cannot change', p_season_id
                USING ERRCODE = '22023', DETAIL = 'season_has_players';
        END IF;
        IF public.season_has_pending_player_import(p_season_id) THEN
            RAISE EXCEPTION 'Season % has a player import in progress: finish or cancel it before its age cutoff or season year changes', p_season_id
                USING ERRCODE = '22023', DETAIL = 'import_pending';
        END IF;
    END IF;

    BEGIN
        UPDATE public.season_settings
           SET name = v_new.name,
               season_start = v_new.season_start,
               season_end = v_new.season_end,
               season_year = v_new.season_year,
               age_cutoff_mode = v_new.age_cutoff_mode,
               age_cutoff_month = v_new.age_cutoff_month,
               age_cutoff_day = v_new.age_cutoff_day
         WHERE id = p_season_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'a season named "%" already exists', v_new.name USING ERRCODE = '23505';
    END;

    PERFORM public.record_audit_event(
        v_org,
        'season.updated',
        'season_settings',
        p_season_id,
        jsonb_build_object('status', v_old.status, 'changed', v_changed)
    );

    RETURN jsonb_build_object('id', p_season_id, 'status', v_old.status, 'changed', true, 'fields', v_changed);
END;
$$;

CREATE FUNCTION public.admin_set_division_birthdate_window(
    p_division_id uuid,
    p_birthdate_start date,
    p_birthdate_end date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_org uuid;
    v_division public.divisions%ROWTYPE;
    v_status text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_division_id IS NULL THEN
        RAISE EXCEPTION 'p_division_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT d.organization_id INTO v_org FROM public.divisions d WHERE d.id = p_division_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the division''s organization'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));

    SELECT * INTO v_division FROM public.divisions d WHERE d.id = p_division_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'division % no longer exists', p_division_id USING ERRCODE = '42501';
    END IF;
    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_division.season_settings_id;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its divisions cannot be changed', v_division.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    IF (p_birthdate_start IS NULL) <> (p_birthdate_end IS NULL) THEN
        RAISE EXCEPTION 'a birth-date window needs both a start and an end, or neither' USING ERRCODE = '22023', DETAIL = 'window_incomplete';
    END IF;
    IF p_birthdate_start > p_birthdate_end THEN
        RAISE EXCEPTION 'the window cannot end before it starts' USING ERRCODE = '22023', DETAIL = 'window_invalid';
    END IF;

    IF v_division.birthdate_start IS NOT DISTINCT FROM p_birthdate_start
       AND v_division.birthdate_end IS NOT DISTINCT FROM p_birthdate_end THEN
        RETURN jsonb_build_object('id', p_division_id, 'changed', false);
    END IF;

    IF EXISTS (SELECT 1 FROM public.players p WHERE p.season_settings_id = v_division.season_settings_id) THEN
        RAISE EXCEPTION 'Season % has players: a division''s birth-date window cannot change', v_division.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_has_players';
    END IF;
    IF public.season_has_pending_player_import(v_division.season_settings_id) THEN
        RAISE EXCEPTION 'Season % has a player import in progress: finish or cancel it before a division''s birth-date window changes', v_division.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'import_pending';
    END IF;

    UPDATE public.divisions
       SET birthdate_start = p_birthdate_start, birthdate_end = p_birthdate_end
     WHERE id = p_division_id;

    PERFORM public.record_audit_event(
        v_org,
        'division.window_changed',
        'division',
        p_division_id,
        jsonb_build_object(
            'season_settings_id', v_division.season_settings_id,
            'name', v_division.name,
            'old_start', v_division.birthdate_start,
            'old_end', v_division.birthdate_end,
            'new_start', p_birthdate_start,
            'new_end', p_birthdate_end
        )
    );

    RETURN jsonb_build_object('id', p_division_id, 'changed', true,
                              'birthdate_start', p_birthdate_start, 'birthdate_end', p_birthdate_end);
END;
$$;

CREATE FUNCTION public.admin_activate_season(p_season_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_org uuid;
    v_target public.season_settings%ROWTYPE;
    v_previous uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_season_id IS NULL THEN
        RAISE EXCEPTION 'p_season_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT s.organization_id INTO v_org FROM public.season_settings s WHERE s.id = p_season_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    -- The organization's lock, then its seasons, then the target's status re-read: two admins at
    -- once, the second finds the target no longer a draft and is refused (without the lock the
    -- partial unique index would raise 23505).
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM 1 FROM public.season_settings s WHERE s.organization_id = v_org ORDER BY s.id FOR UPDATE;

    SELECT * INTO v_target FROM public.season_settings s WHERE s.id = p_season_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'season % no longer exists', p_season_id USING ERRCODE = '42501';
    END IF;
    IF v_target.status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and cannot be activated again; start a new season from it', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_target.status <> 'draft' THEN
        RAISE EXCEPTION 'Season % is % and only a draft can be activated', p_season_id, v_target.status
            USING ERRCODE = '22023', DETAIL = 'season_not_draft';
    END IF;

    -- A season needs a clock, dates and a year before it is the one everything shows
    -- (age groups read the year; scheduling reads the zone).
    IF v_target.timezone IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = v_target.timezone) THEN
        RAISE EXCEPTION 'Season % needs a known timezone before it is activated', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_timezone_missing';
    END IF;
    IF v_target.season_start IS NULL OR v_target.season_end IS NULL THEN
        RAISE EXCEPTION 'Season % needs a start and an end date before it is activated', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_dates_missing';
    END IF;
    IF v_target.season_end < v_target.season_start THEN
        RAISE EXCEPTION 'Season % ends before it starts', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_dates_invalid';
    END IF;
    IF v_target.season_year IS NULL THEN
        RAISE EXCEPTION 'Season % needs a season year before it is activated', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_year_missing';
    END IF;

    -- Two statements, so the partial unique index never sees two active seasons.
    UPDATE public.season_settings
       SET status = 'completed'
     WHERE organization_id = v_org AND status = 'active'
    RETURNING id INTO v_previous;
    UPDATE public.season_settings SET status = 'active' WHERE id = p_season_id;

    PERFORM public.record_audit_event(
        v_org,
        'season.activated',
        'season_settings',
        p_season_id,
        jsonb_build_object('name', v_target.name, 'previous_active_season_id', v_previous)
    );

    RETURN jsonb_build_object('id', p_season_id, 'status', 'active', 'previous_active_season_id', v_previous);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_season_from(uuid, text, integer, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_draft_season(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_division_birthdate_window(uuid, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_activate_season(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_season_from(uuid, text, integer, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_draft_season(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_division_birthdate_window(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_activate_season(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_create_season_from(uuid, text, integer, date, date) IS
    'Admin-only: a new draft season from any season of the organization: its divisions (every column of rollover_division_columns(), birth-date windows shifted by the difference in season years) and programs, and no player, coach or team; season settings from rollover_season_columns(). Takes the organization''s season lock. Audited as season.created_from. 20261109010000.';
COMMENT ON FUNCTION public.admin_update_draft_season(uuid, jsonb) IS
    'Admin-only: patch a season''s name and dates (draft or active) and its season year and age cutoff (a draft with no players only); a key present with null clears. A completed season is refused. Audited as season.updated with the old and new values. 20261109010000.';
COMMENT ON FUNCTION public.admin_set_division_birthdate_window(uuid, date, date) IS
    'Admin-only: set or clear (both null) a division''s birth-date window, refused once the season has players or is completed. Audited as division.window_changed. 20261109010000.';
COMMENT ON FUNCTION public.admin_activate_season(uuid) IS
    'Admin-only: activate a draft season (a known timezone, both dates and a season year are required) and complete the previous active season, under the organization''s season lock. A completed season cannot be reactivated. Audited as season.activated. 20261109010000.';

-- ---------------------------------------------------------------------------
-- 7. The E1 guard: the active season or a draft; never a completed one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_import_job(p_organization_id uuid, p_import_type text, p_file_name text, p_season_settings_id uuid DEFAULT NULL::uuid)
 RETURNS import_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_import_type text := lower(NULLIF(btrim(COALESCE(p_import_type, '')), ''));
    v_file_name text := btrim(COALESCE(p_file_name, ''));
    v_job_type text;
    v_now timestamptz := now();
    v_job public.import_jobs%ROWTYPE;
    v_season_id uuid;
    v_season_status text;
BEGIN
    IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_org_admin(p_organization_id) THEN
      RAISE EXCEPTION 'Only organization admins can create import jobs' USING ERRCODE='42501';
    END IF;
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability') THEN
      RAISE EXCEPTION 'invalid import type: %', p_import_type USING ERRCODE='22023';
    END IF;
    v_file_name := regexp_replace(v_file_name, '[/\\:]+', '_', 'g');
    IF v_file_name = '' THEN RAISE EXCEPTION 'file_name is required' USING ERRCODE='22023'; END IF;

    v_job_type := CASE WHEN v_import_type = 'fields' THEN 'fields' WHEN v_import_type='field_availability' THEN 'field_availability' ELSE 'registration' END;

    -- 20261101010000: the season the import adds to is fixed now, not when it is
    -- finalized. A named season must be this organization's and not completed;
    -- none named is the organization's active season (none at all leaves the job
    -- without one, as a job made before this migration is). Divisions and field
    -- practice reservations land in it.
    IF p_season_settings_id IS NULL THEN
      SELECT s.id INTO v_season_id
        FROM public.season_settings s
       WHERE s.organization_id = p_organization_id AND s.status = 'active';
    ELSE
      SELECT s.id, s.status INTO v_season_id, v_season_status
        FROM public.season_settings s
       WHERE s.id = p_season_settings_id AND s.organization_id = p_organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'season % does not belong to organization %', p_season_settings_id, p_organization_id
          USING ERRCODE='42501';
      END IF;
      IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'season % is completed and takes no import', p_season_settings_id
          USING ERRCODE='22023', DETAIL='season_completed';
      END IF;
      -- 20261109010000: the active season or a draft takes a registration or coach import (a
      -- club prepares next season from its own registration data); a field import stays with the
      -- active season, as finalize_field_import_job still requires.
      IF v_season_status <> 'active' AND (v_season_status <> 'draft' OR v_job_type <> 'registration') THEN
        RAISE EXCEPTION 'season % is % and takes no % import: only the active season does', p_season_settings_id, v_season_status, v_import_type
          USING ERRCODE='22023', DETAIL='season_not_active';
      END IF;
    END IF;

    INSERT INTO public.import_jobs (organization_id,job_type,storage_path,status,total_rows,processed_rows,progress_percent,last_heartbeat_at,created_by,started_at,season_settings_id)
    VALUES (p_organization_id,v_job_type,format('imports/%s/%s', auth.uid(), v_file_name),'importing',0,0,0,v_now,auth.uid(),v_now,v_season_id)
    RETURNING * INTO v_job;

    PERFORM public.record_audit_event(p_organization_id,'import.started','import_job',v_job.id,jsonb_build_object('import_type',v_import_type,'job_type',v_job_type,'status','importing'));
    RETURN v_job;
END;
$function$;

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
    -- a new row here. So the active season and a draft season both take an import (20261109010000:
    -- a club prepares next season from its own registration data), and a completed one never does.

    -- The ages in the staged rows were counted under the season's rule when the file was validated
    -- (the job's stamp: the season and its age-rule revision). Under the season lock the rule writers
    -- take, a job whose stamp is not the season's revision now is refused, a change and its reversal
    -- included: the file is validated again. A job with no stamp is not refused.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_job.organization_id::text, 0));
    IF v_job.age_rule_revision IS NOT NULL
       AND (v_job.age_rule_season_id IS DISTINCT FROM v_season_settings_id
            OR v_job.age_rule_revision IS DISTINCT FROM
               (SELECT s.age_rule_revision FROM public.season_settings s WHERE s.id = v_season_settings_id)) THEN
        RAISE EXCEPTION 'The age rules of season % changed since this file was checked; validate it again', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'age_rule_changed';
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
    -- The active season and a draft season take an import (20261109010000), as the player
    -- finalizer's guard; a completed one never does.
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

COMMENT ON FUNCTION public.create_import_job(uuid, text, text, uuid) IS
    'Admin-only: start an import job for the named season (none named: the organization''s active season), fixed now. A player or coach import may name the active season or a draft; a field import only the active season; a completed season is refused (22023, season_completed). 20261109010000 (was active-only since 20261101010000).';

-- ---------------------------------------------------------------------------
-- 8. End state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_bad text;
    v_n bigint;
BEGIN
    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('admin_create_season_from(uuid,text,integer,date,date)'),
                   ('admin_update_draft_season(uuid,jsonb)'),
                   ('admin_set_division_birthdate_window(uuid,date,date)'),
                   ('admin_activate_season(uuid)')) AS f(sig)
     WHERE to_regprocedure('public.' || f.sig) IS NULL
        OR NOT has_function_privilege('authenticated', to_regprocedure('public.' || f.sig), 'EXECUTE')
        OR has_function_privilege('anon', to_regprocedure('public.' || f.sig), 'EXECUTE');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'writer(s) missing or wrongly granted: %', v_bad;
    END IF;

    -- The rule read is for the service role alone, and nobody signed in may call it.
    IF to_regprocedure('public.import_age_rule(uuid,uuid,boolean)') IS NULL
       OR NOT has_function_privilege('service_role', 'public.import_age_rule(uuid,uuid,boolean)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.import_age_rule(uuid,uuid,boolean)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.import_age_rule(uuid,uuid,boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'import_age_rule is missing or wrongly granted';
    END IF;

    SELECT count(*) INTO v_n FROM public.audit_actions
     WHERE action IN ('season.created_from', 'season.updated', 'season.activated', 'division.window_changed');
    IF v_n <> 4 THEN RAISE EXCEPTION 'the 4 season audit actions are not all registered (found %)', v_n; END IF;

    -- The catalogues name every column, copied or skipped, once.
    SELECT string_agg(c.column_name, ', ') INTO v_bad
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'divisions'
       AND NOT (c.column_name = ANY (public.rollover_division_columns() || public.rollover_division_skipped_columns()));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'divisions column(s) neither copied nor skipped by a rollover: %', v_bad;
    END IF;
    SELECT string_agg(c.column_name, ', ') INTO v_bad
      FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'season_settings'
       AND NOT (c.column_name = ANY (public.rollover_season_columns() || public.rollover_season_skipped_columns()));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'season_settings column(s) neither copied nor skipped by a rollover: %', v_bad;
    END IF;

    SELECT string_agg(t.name, ', ') INTO v_bad
      FROM (VALUES ('season_settings_cutoff_guard'), ('divisions_window_guard'), ('divisions_age_rule_revision'),
                   ('players_readonly_when_completed'), ('coaches_readonly_when_completed'),
                   ('teams_readonly_when_completed'), ('team_players_readonly_when_completed'),
                   ('team_coach_assignments_readonly_when_completed'),
                   ('practice_assignments_readonly_when_completed'),
                   ('practice_exceptions_readonly_when_completed'),
                   ('game_assignments_readonly_when_completed')) AS t(name)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger g
                        WHERE g.tgname = t.name AND NOT g.tgisinternal AND g.tgenabled = 'O');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'trigger(s) missing or not enabled: %', v_bad;
    END IF;

    -- The three finalizers no longer require the active season (and say so nowhere).
    SELECT string_agg(f.sig, ', ') INTO v_bad
      FROM (VALUES ('finalize_import_job(uuid,jsonb)'), ('finalize_coach_import_job(uuid,jsonb)')) AS f(sig)
     WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || f.sig))
           LIKE '%only the active season does%';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'body(ies) still active-only: %', v_bad;
    END IF;
END;
$$;

COMMIT;
