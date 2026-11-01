-- Practice preferences become rules per team, imported by admins, with must decisions (Phase D, C1;
-- owner approval 2026-10-26, revised 2026-10-27; plans docs/changes/2026-10-26-coach-preference-rules.md
-- "Revised 2026-10-27" and docs/changes/2026-10-27-phase-d-scheduling.md, section C).
--
-- **Why.** `coach_practice_preferences` held one scalar value per (coach, dimension), at most one
-- approved row each, for a coach and not a team. Clubs collect "prefers Tuesday and Thursday" and "must
-- start at 5:00 or 6:00" for each team, and since the admin-only change (20261104010000) nobody but an
-- admin signs in, so the rules arrive in an admin's import and the admin decides which requested musts
-- count.
--
-- **The model.** A row is one RULE for one team, asked by one of the team's coaches:
--   * three conditions, each optional: `weekdays` (SUN..SAT), `start_minutes` (minutes past local
--     midnight) and `venue_ids` (locations). Several values in one condition mean "any of"; the
--     conditions of one rule must all hold. Per condition a flag says "keep the current one" instead
--     (`keep_weekday`, `keep_start`, `keep_venue`): met by any value the team's live practices hold, and
--     it does nothing, and says so, when the team has none.
--   * `level` is what is in force (`prefer` or `must`); `requested_level` is what was asked. A requested
--     must is in force as prefer and `must_decision` = `pending` until an admin accepts it (`accepted`:
--     level `must`) or keeps it as prefer (`kept_prefer`). Only an admin makes a rule a must.
--   * `coach_priority` (high, medium, low or none) is for visibility only; it changes nothing the solver
--     weighs. `effective_from` / `effective_to` are an optional date window (they used to be the span a
--     decision was in force).
--   * `source` is `import` (with `import_job_id`) or `admin`; `status` is `in_force`, `removed` (an
--     admin removed it) or `replaced` (a re-import replaced it).
--   Judging is per practice and every rule in force and in window applies (core `coachPreferences.js`
--   and its Edge twin): a must filters, a prefer counts one breach per unmet rule.
--
-- **The change.**
--   1. md5 guards on every function body this migration replaces or drops.
--   2. The table: new columns; the old CHECKs and the one-approved index dropped; the rows moved (a
--      scalar becomes a one-element array, NULL becomes keep-current, and each row is copied once per
--      team its coach coaches today; `dont_care` rows carry no rule and are not copied; a row whose coach
--      coaches no team is kept as history, status `removed`, team NULL); an end-state check that counts
--      what moved; then `dimension` and `value` dropped and the new CHECKs added. Production holds 0
--      rows (read-only, 2026-11-01), so nothing moves there; the backfill is written and tested anyway
--      (the harness plants old-shape rows and applies this migration over them).
--   3. A tenancy trigger: the team and the venues belong to the row's organization, the coach to the
--      team's season.
--   4. Five admin RPCs, each audited, each refusing a non-admin (42501) and a completed season
--      (22023 `season_completed`): `admin_add_practice_preference`, `admin_edit_practice_preference`,
--      `admin_remove_practice_preference`, `admin_decide_must_preference` and
--      `admin_accept_all_musts(p_import_job_id, p_expected_count)`, which refuses when the pending
--      count differs from the one the confirmation showed (22023 `expected_count_mismatch`).
--   5. The import type `practice_preferences`: `staging_import_rows` takes it; `create_import_job`,
--      `mark_import_job_ready_to_apply`, `cancel_ready_import_job` and `import_allowed_keys` are
--      replaced to know it; and `finalize_practice_preference_import_job` applies a staged file: coach
--      by email within the job's season, team by name within the season, a blank team for a coach of
--      several teams makes one rule per team, an unknown coach or team is listed and never created, a
--      re-import replaces the imported rules of the teams the file names and leaves admin rules alone.
--      The active season or a draft takes a preference file and a completed one never does, as E3b
--      (20261111010000) set for players and coaches: `create_import_job` is E3b's body with the new
--      type added, and the finalizer refuses a completed season again.
--   6. `admin_delete_team` counts the rules its cascade takes (`coach_practice_preferences_deleted`).
--   7. The two old RPCs, `admin_decide_coach_practice_preference` and `admin_set_coach_practice_preference`,
--      are dropped by exact signature (no CASCADE): they read the columns this drops. The request RPC went
--      with 20261104010000.
--   8. A completed season's rules are read-only: the table joins the schedule tables E3b guards
--      (`season_schedule_readonly_when_completed`).
--   9. An end-state check.
--
-- No DDL touches the auth or storage schemas. Every drop names its object.
--
-- Reversible: docs/sql/20261112010000_revert.sql restores the scalar columns from one-element rows and
-- refuses while a rule holds more than one value (which only exists once an admin writes one). Smoke:
-- docs/sql/20261112010000_smoke.sql. pgTAP: supabase/tests/practice_preference_rules.sql and
-- supabase/tests/practice_preference_import.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting bodies are checked.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected jsonb := '{
        "create_import_job(uuid,text,text,uuid)": "8fa633ffce974933fc75f25f3227f26e",
        "mark_import_job_ready_to_apply(uuid,text,jsonb)": "d52d2e864a595fa879ba72a4c1b4dd32",
        "cancel_ready_import_job(uuid,text)": "15748232fe403a2a976627ee2801f92f",
        "import_allowed_keys(text)": "974e958ba912ccb2a3fe13c4bcd484d1",
        "admin_delete_team(uuid)": "e3344d10e5d1cf60f3d0ef04f4e74504",
        "admin_decide_coach_practice_preference(uuid,text,text,jsonb)": "af9d4a75fce06aeeb69d2248b0269901",
        "admin_set_coach_practice_preference(uuid,text,text,jsonb)": "318db46455620d3f7cba83398e668c3f",
        "season_schedule_readonly_when_completed()": "cfc4abe75eab99cb46cbdc32e5e68d43"
    }';
    v_key text;
    v_md5 text;
BEGIN
    FOR v_key IN SELECT jsonb_object_keys(v_expected) ORDER BY 1 LOOP
        -- Carriage returns stripped, as 20261101010000 does: a body stored with CRLF line ends is the same text.
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_key);
        IF v_md5 IS DISTINCT FROM (v_expected ->> v_key) THEN
            RAISE EXCEPTION '% is not the body this migration replaces (md5 %, expected %)', v_key, v_md5, v_expected ->> v_key;
        END IF;
    END LOOP;
    RAISE NOTICE 'coach_practice_preferences holds % row(s) before this migration', (SELECT count(*) FROM public.coach_practice_preferences);
END;
$$;

INSERT INTO public.audit_actions (action) VALUES
    ('practice_preference.added'),
    ('practice_preference.edited'),
    ('practice_preference.removed'),
    ('practice_preference.must_decided'),
    ('practice_preference.musts_accepted'),
    ('practice_preference.imported')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The table: columns, the rows moved, the old shape dropped, the new CHECKs.
-- ---------------------------------------------------------------------------

-- The helpers the CHECKs call (a CHECK may not hold a subquery). Not callable by a client: every writer is
-- a definer RPC (the table's owner), and a CHECK is evaluated as the writing role.
CREATE FUNCTION public.practice_preference_set_ok(p_values anyarray)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT p_values IS NULL OR (
        cardinality(p_values) > 0
        AND NOT EXISTS (SELECT 1 FROM unnest(p_values) v WHERE v IS NULL)
        AND cardinality(p_values) = (SELECT count(DISTINCT v) FROM unnest(p_values) v)
    );
$$;

CREATE FUNCTION public.practice_preference_minutes_ok(p_minutes integer[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
    SELECT p_minutes IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(p_minutes) m WHERE m IS NULL OR m < 0 OR m > 1439
    );
$$;

REVOKE ALL ON FUNCTION public.practice_preference_set_ok(anyarray) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.practice_preference_minutes_ok(integer[]) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.practice_preference_set_ok(anyarray) IS
  'Internal (CHECK helper): NULL, or a non-empty array with no NULL and no duplicate. 20261112010000.';
COMMENT ON FUNCTION public.practice_preference_minutes_ok(integer[]) IS
  'Internal (CHECK helper): NULL, or every element is minutes past local midnight, 0 to 1439. 20261112010000.';

ALTER TABLE public.coach_practice_preferences
    ADD COLUMN team_id          uuid REFERENCES public.teams(id) ON DELETE CASCADE,
    ADD COLUMN weekdays         text[],
    ADD COLUMN start_minutes    integer[],
    ADD COLUMN venue_ids        uuid[],
    ADD COLUMN keep_weekday     boolean NOT NULL DEFAULT false,
    ADD COLUMN keep_start       boolean NOT NULL DEFAULT false,
    ADD COLUMN keep_venue       boolean NOT NULL DEFAULT false,
    ADD COLUMN coach_priority   text,
    ADD COLUMN requested_level  text,
    ADD COLUMN must_decision    text,
    ADD COLUMN source           text NOT NULL DEFAULT 'admin',
    ADD COLUMN import_job_id    uuid REFERENCES public.import_jobs(id) ON DELETE SET NULL,
    ADD COLUMN updated_by       uuid,
    ADD COLUMN updated_at       timestamptz;

ALTER TABLE public.coach_practice_preferences RENAME COLUMN requested_by TO created_by;
ALTER TABLE public.coach_practice_preferences RENAME COLUMN requested_at TO created_at;

ALTER TABLE public.coach_practice_preferences
    DROP CONSTRAINT coach_practice_preferences_dimension_known,
    DROP CONSTRAINT coach_practice_preferences_level_known,
    DROP CONSTRAINT coach_practice_preferences_status_known,
    DROP CONSTRAINT coach_practice_preferences_value_valid,
    DROP CONSTRAINT coach_practice_preferences_decision_recorded,
    DROP CONSTRAINT coach_practice_preferences_in_force_dated,
    DROP CONSTRAINT coach_practice_preferences_window_ordered;
DROP INDEX public.coach_practice_preferences_one_approved;

-- The rows moved. The new rows are computed first (the old ones still carry dimension and value), the old
-- rows deleted, the old columns dropped, and the new rows inserted: each old row keeps its id on its first
-- copy, so the audit rows that name it still do.
CREATE TEMP TABLE _cpp_moved ON COMMIT DROP AS
WITH old AS (
    SELECT * FROM public.coach_practice_preferences WHERE level <> 'dont_care'
),
teams_of AS (
    SELECT o.id AS old_id, t.team_id,
           row_number() OVER (PARTITION BY o.id ORDER BY t.team_id NULLS LAST) AS rn
      FROM old o
      LEFT JOIN LATERAL (
          SELECT DISTINCT a.team_id
            FROM public.team_coach_assignments a
           WHERE a.organization_id = o.organization_id
             AND a.coach_id = o.coach_id
             AND a.effective_from <= current_date
             AND (a.effective_to IS NULL OR a.effective_to >= current_date)
      ) t ON true
)
SELECT CASE WHEN x.rn = 1 THEN o.id ELSE gen_random_uuid() END AS id,
       o.organization_id,
       o.coach_id,
       x.team_id,
       CASE WHEN o.dimension = 'weekday' AND o.value IS NOT NULL
            THEN ARRAY[o.value #>> '{}'] END AS weekdays,
       CASE WHEN o.dimension = 'start_time' AND o.value IS NOT NULL
            THEN ARRAY[(o.value #>> '{}')::integer] END AS start_minutes,
       CASE WHEN o.dimension = 'venue' AND o.value IS NOT NULL
            THEN ARRAY[(o.value #>> '{}')::uuid] END AS venue_ids,
       (o.dimension = 'weekday' AND o.value IS NULL) AS keep_weekday,
       (o.dimension = 'start_time' AND o.value IS NULL) AS keep_start,
       (o.dimension = 'venue' AND o.value IS NULL) AS keep_venue,
       -- A row nobody decided, or one that was rejected, was never in force: it becomes history.
       CASE WHEN o.status IN ('approved', 'superseded') AND o.level = 'must_keep' THEN 'must' ELSE 'prefer' END AS level,
       CASE WHEN o.level = 'must_keep' THEN 'must' ELSE 'prefer' END AS requested_level,
       CASE WHEN o.level <> 'must_keep' THEN NULL
            WHEN o.status IN ('approved', 'superseded') THEN 'accepted'
            ELSE 'kept_prefer' END AS must_decision,
       CASE WHEN x.team_id IS NULL THEN 'removed'
            WHEN o.status = 'approved' THEN 'in_force'
            WHEN o.status = 'superseded' THEN 'replaced'
            ELSE 'removed' END AS status,
       o.created_by,
       o.created_at,
       o.decided_by,
       o.decided_at
  FROM old o
  JOIN teams_of x ON x.old_id = o.id;

DO $$
DECLARE
    v_old integer;
    v_dont_care integer;
    v_expected integer;
    v_new integer;
BEGIN
    SELECT count(*) INTO v_old FROM public.coach_practice_preferences;
    SELECT count(*) INTO v_dont_care FROM public.coach_practice_preferences WHERE level = 'dont_care';
    -- One copy per team the coach coaches today, one for a coach with none.
    SELECT COALESCE(sum(GREATEST(n, 1)), 0) INTO v_expected FROM (
        SELECT o.id, (SELECT count(DISTINCT a.team_id) FROM public.team_coach_assignments a
                       WHERE a.organization_id = o.organization_id AND a.coach_id = o.coach_id
                         AND a.effective_from <= current_date
                         AND (a.effective_to IS NULL OR a.effective_to >= current_date)) AS n
          FROM public.coach_practice_preferences o WHERE o.level <> 'dont_care'
    ) c;
    SELECT count(*) INTO v_new FROM _cpp_moved;
    IF v_new <> v_expected THEN
        RAISE EXCEPTION 'the backfill computed % rule(s), expected % from % old row(s) (% dont_care)', v_new, v_expected, v_old, v_dont_care;
    END IF;
    RAISE NOTICE 'practice preferences: % old row(s) -> % rule(s) (% dont_care row(s) carry no rule and are not copied; % rule(s) kept as history with no team)',
        v_old, v_new, v_dont_care, (SELECT count(*) FROM _cpp_moved WHERE team_id IS NULL);
END;
$$;

DELETE FROM public.coach_practice_preferences;
ALTER TABLE public.coach_practice_preferences DROP COLUMN dimension, DROP COLUMN value;

INSERT INTO public.coach_practice_preferences
    (id, organization_id, coach_id, team_id, weekdays, start_minutes, venue_ids,
     keep_weekday, keep_start, keep_venue, level, requested_level, must_decision, status,
     created_by, created_at, decided_by, decided_at, source)
SELECT id, organization_id, coach_id, team_id, weekdays, start_minutes, venue_ids,
       keep_weekday, keep_start, keep_venue, level, requested_level, must_decision, status,
       created_by, created_at, decided_by, decided_at, 'admin'
  FROM _cpp_moved;

ALTER TABLE public.coach_practice_preferences
    ALTER COLUMN requested_level SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'in_force',
    ADD CONSTRAINT coach_practice_preferences_level_known
        CHECK (level IN ('prefer', 'must')),
    ADD CONSTRAINT coach_practice_preferences_requested_level_known
        CHECK (requested_level IN ('prefer', 'must')),
    ADD CONSTRAINT coach_practice_preferences_must_decision_known
        CHECK (must_decision IS NULL OR must_decision IN ('pending', 'accepted', 'kept_prefer')),
    -- A must was asked for exactly when it has a decision; a rule is a must exactly when an admin accepted it.
    ADD CONSTRAINT coach_practice_preferences_must_asked_decided
        CHECK ((requested_level = 'must') = (must_decision IS NOT NULL)),
    ADD CONSTRAINT coach_practice_preferences_must_only_when_accepted
        CHECK ((level = 'must') = COALESCE(must_decision = 'accepted', false)),
    ADD CONSTRAINT coach_practice_preferences_status_known
        CHECK (status IN ('in_force', 'removed', 'replaced')),
    ADD CONSTRAINT coach_practice_preferences_team_when_in_force
        CHECK (status <> 'in_force' OR team_id IS NOT NULL),
    ADD CONSTRAINT coach_practice_preferences_weekdays_valid
        CHECK (public.practice_preference_set_ok(weekdays)
               AND (weekdays IS NULL OR weekdays <@ ARRAY['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']::text[])),
    ADD CONSTRAINT coach_practice_preferences_start_minutes_valid
        CHECK (public.practice_preference_set_ok(start_minutes) AND public.practice_preference_minutes_ok(start_minutes)),
    ADD CONSTRAINT coach_practice_preferences_venue_ids_valid
        CHECK (public.practice_preference_set_ok(venue_ids)),
    ADD CONSTRAINT coach_practice_preferences_keep_or_values
        CHECK (NOT (keep_weekday AND weekdays IS NOT NULL)
               AND NOT (keep_start AND start_minutes IS NOT NULL)
               AND NOT (keep_venue AND venue_ids IS NOT NULL)),
    ADD CONSTRAINT coach_practice_preferences_has_condition
        CHECK (weekdays IS NOT NULL OR start_minutes IS NOT NULL OR venue_ids IS NOT NULL
               OR keep_weekday OR keep_start OR keep_venue),
    ADD CONSTRAINT coach_practice_preferences_priority_known
        CHECK (coach_priority IS NULL OR coach_priority IN ('high', 'medium', 'low')),
    ADD CONSTRAINT coach_practice_preferences_source_known
        CHECK (source IN ('import', 'admin')),
    ADD CONSTRAINT coach_practice_preferences_import_job_is_import
        CHECK (import_job_id IS NULL OR source = 'import'),
    ADD CONSTRAINT coach_practice_preferences_window_ordered
        CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from);

CREATE INDEX coach_practice_preferences_org_team
    ON public.coach_practice_preferences (organization_id, team_id) WHERE status = 'in_force';
CREATE INDEX coach_practice_preferences_import_job
    ON public.coach_practice_preferences (import_job_id) WHERE import_job_id IS NOT NULL;

COMMENT ON TABLE public.coach_practice_preferences IS
  'Practice preference RULES, one row per rule per team: weekdays / start_minutes / venue_ids (any of, each optional) or keep-current per condition; level prefer | must in force, requested_level what was asked, must_decision pending | accepted | kept_prefer (only an admin makes a rule a must); optional coach_priority (visibility only) and date window; source import | admin. Written only by the admin_*_practice_preference RPCs, admin_decide_must_preference, admin_accept_all_musts and finalize_practice_preference_import_job. No free text. 20261112010000.';
COMMENT ON COLUMN public.coach_practice_preferences.coach_id IS
  'A coaches.id, deliberately without a foreign key (the team_coach_assignments stance): deleting a coach erases their personal data and leaves this history holding an opaque id. A rule applies to a team only while this coach is one of its current coaches.';
COMMENT ON COLUMN public.coach_practice_preferences.effective_from IS
  'First day the rule applies, or NULL for no start. (Before 20261112010000 the day a decision took effect.)';
COMMENT ON COLUMN public.coach_practice_preferences.effective_to IS
  'Last day the rule applies, or NULL for no end. (Before 20261112010000 the day a decision was superseded.)';
COMMENT ON COLUMN public.coach_practice_preferences.keep_weekday IS
  'Keep the current weekday: met by any weekday the team''s live practices hold; with none it does nothing and the run says so (PRACTICE_COACH_PREFERENCE_NO_REFERENCE). Exclusive with weekdays. Likewise keep_start and keep_venue.';
COMMENT ON COLUMN public.coach_practice_preferences.must_decision IS
  'NULL when only prefer was asked. pending: a requested must, in force as prefer until an admin decides; accepted: level is must; kept_prefer: an admin kept it as prefer.';

-- ---------------------------------------------------------------------------
-- 3. Tenancy: the team and the venues belong to the row's organization, the coach to the team's season.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.coach_practice_preferences_enforce_tenancy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
    v_team_org uuid;
    v_team_season uuid;
    v_coach_season uuid;
    v_bad integer;
BEGIN
    IF NEW.team_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.team_id IS DISTINCT FROM OLD.team_id
                                    OR NEW.coach_id IS DISTINCT FROM OLD.coach_id
                                    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
        SELECT t.organization_id, d.season_settings_id INTO v_team_org, v_team_season
          FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
         WHERE t.id = NEW.team_id;
        IF v_team_org IS DISTINCT FROM NEW.organization_id THEN
            RAISE EXCEPTION 'practice preference: team % does not belong to organization %', NEW.team_id, NEW.organization_id
                USING ERRCODE = '23514';
        END IF;
        SELECT c.season_settings_id INTO v_coach_season
          FROM public.coaches c WHERE c.id = NEW.coach_id AND c.organization_id = NEW.organization_id;
        IF v_coach_season IS NULL THEN
            RAISE EXCEPTION 'practice preference: coach % is not a coach of organization %', NEW.coach_id, NEW.organization_id
                USING ERRCODE = '23514';
        END IF;
        IF v_coach_season IS DISTINCT FROM v_team_season THEN
            RAISE EXCEPTION 'practice preference: coach % and team % belong to different seasons', NEW.coach_id, NEW.team_id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    IF NEW.venue_ids IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.venue_ids IS DISTINCT FROM OLD.venue_ids
                                      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id) THEN
        SELECT count(*) INTO v_bad
          FROM unnest(NEW.venue_ids) v
         WHERE NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v AND l.organization_id = NEW.organization_id);
        IF v_bad > 0 THEN
            RAISE EXCEPTION 'practice preference: % venue(s) are not locations of organization %', v_bad, NEW.organization_id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.coach_practice_preferences_enforce_tenancy() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.coach_practice_preferences_enforce_tenancy() IS
  'Trigger function on coach_practice_preferences: the team and the venues belong to the row''s organization and the coach to the team''s season (23514). 20261112010000.';

CREATE TRIGGER coach_practice_preferences_enforce_tenancy
    BEFORE INSERT OR UPDATE ON public.coach_practice_preferences
    FOR EACH ROW EXECUTE FUNCTION public.coach_practice_preferences_enforce_tenancy();

-- The moved rows were written before the trigger existed: they pass it or the migration stops.
DO $$
DECLARE
    v_bad integer;
BEGIN
    SELECT count(*) INTO v_bad FROM public.coach_practice_preferences p
     WHERE (p.team_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
                  JOIN public.coaches c ON c.id = p.coach_id AND c.organization_id = p.organization_id
                                       AND c.season_settings_id = d.season_settings_id
                 WHERE t.id = p.team_id AND t.organization_id = p.organization_id))
        OR (p.venue_ids IS NOT NULL AND EXISTS (
                SELECT 1 FROM unnest(p.venue_ids) v
                 WHERE NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = v AND l.organization_id = p.organization_id)));
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'practice preferences: % moved rule(s) name a coach, team or venue outside their organization or season; resolve them before this migration', v_bad;
    END IF;
END;
$$;


-- ---------------------------------------------------------------------------
-- 4. The admin RPCs.
-- ---------------------------------------------------------------------------
--
-- Every one is a definer, admin-only (42501 for a signed-in non-member and for another organization's
-- admin alike: an unknown id refuses the same way, so the RPC cannot probe which ids exist), refuses a
-- completed season (22023, DETAIL season_completed) and writes one audit row with the rule before and
-- after. The level semantics, in one place: `must` is granted by an admin and nobody else; a requested
-- must waits as prefer (`pending`) until `admin_decide_must_preference`; an admin who edits a rule to
-- `must` grants it (and the request follows), and one who edits a requested must to `prefer` keeps it
-- as prefer (`kept_prefer`).

CREATE FUNCTION public.admin_add_practice_preference(
    p_coach_id uuid,
    p_team_id uuid,
    p_level text DEFAULT 'prefer',
    p_weekdays text[] DEFAULT NULL,
    p_start_minutes integer[] DEFAULT NULL,
    p_venue_ids uuid[] DEFAULT NULL,
    p_keep_weekday boolean DEFAULT false,
    p_keep_start boolean DEFAULT false,
    p_keep_venue boolean DEFAULT false,
    p_coach_priority text DEFAULT NULL,
    p_effective_from date DEFAULT NULL,
    p_effective_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_team public.teams%ROWTYPE;
    v_season_status text;
    v_row public.coach_practice_preferences%ROWTYPE;
BEGIN
    IF p_coach_id IS NULL OR p_team_id IS NULL THEN
        RAISE EXCEPTION 'p_coach_id and p_team_id are required' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_team FROM public.teams WHERE id = p_team_id;
    IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_org_admin(v_team.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin adds a practice preference' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(p_level, 'prefer') NOT IN ('prefer', 'must') THEN
        RAISE EXCEPTION 'p_level must be prefer or must, not %', p_level USING ERRCODE = '22023';
    END IF;
    SELECT s.status INTO v_season_status
      FROM public.divisions d JOIN public.season_settings s ON s.id = d.season_settings_id
     WHERE d.id = v_team.division_id;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'The season of team % is completed and takes no practice preference', p_team_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.team_coach_assignments a
                    WHERE a.team_id = p_team_id AND a.coach_id = p_coach_id
                      AND a.organization_id = v_team.organization_id
                      AND a.effective_from <= current_date
                      AND (a.effective_to IS NULL OR a.effective_to >= current_date)) THEN
        RAISE EXCEPTION 'coach % does not coach team % today, so cannot hold a rule for it', p_coach_id, p_team_id
            USING ERRCODE = '22023', DETAIL = 'coach_not_on_team';
    END IF;

    INSERT INTO public.coach_practice_preferences
        (organization_id, coach_id, team_id, weekdays, start_minutes, venue_ids,
         keep_weekday, keep_start, keep_venue, coach_priority, effective_from, effective_to,
         level, requested_level, must_decision, status, source, created_by, decided_by, decided_at)
    VALUES
        (v_team.organization_id, p_coach_id, p_team_id, p_weekdays, p_start_minutes, p_venue_ids,
         COALESCE(p_keep_weekday, false), COALESCE(p_keep_start, false), COALESCE(p_keep_venue, false),
         p_coach_priority, p_effective_from, p_effective_to,
         COALESCE(p_level, 'prefer'), COALESCE(p_level, 'prefer'),
         CASE WHEN COALESCE(p_level, 'prefer') = 'must' THEN 'accepted' END,
         'in_force', 'admin', auth.uid(),
         CASE WHEN COALESCE(p_level, 'prefer') = 'must' THEN auth.uid() END,
         CASE WHEN COALESCE(p_level, 'prefer') = 'must' THEN now() END)
    RETURNING * INTO v_row;

    PERFORM public.record_audit_event(
        v_row.organization_id, 'practice_preference.added', 'coach_practice_preference', v_row.id,
        jsonb_build_object('after', to_jsonb(v_row))
    );
    RETURN to_jsonb(v_row);
END;
$function$;

CREATE FUNCTION public.admin_edit_practice_preference(
    p_preference_id uuid,
    p_level text DEFAULT 'prefer',
    p_weekdays text[] DEFAULT NULL,
    p_start_minutes integer[] DEFAULT NULL,
    p_venue_ids uuid[] DEFAULT NULL,
    p_keep_weekday boolean DEFAULT false,
    p_keep_start boolean DEFAULT false,
    p_keep_venue boolean DEFAULT false,
    p_coach_priority text DEFAULT NULL,
    p_effective_from date DEFAULT NULL,
    p_effective_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_before public.coach_practice_preferences%ROWTYPE;
    v_after public.coach_practice_preferences%ROWTYPE;
    v_season_status text;
    v_level text := COALESCE(p_level, 'prefer');
BEGIN
    IF p_preference_id IS NULL THEN
        RAISE EXCEPTION 'p_preference_id is required' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_before FROM public.coach_practice_preferences WHERE id = p_preference_id FOR UPDATE;
    IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_org_admin(v_before.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin edits a practice preference' USING ERRCODE = '42501';
    END IF;
    IF v_level NOT IN ('prefer', 'must') THEN
        RAISE EXCEPTION 'p_level must be prefer or must, not %', p_level USING ERRCODE = '22023';
    END IF;
    IF v_before.status <> 'in_force' THEN
        RAISE EXCEPTION 'practice preference % is %, not in force, so it cannot be edited', p_preference_id, v_before.status
            USING ERRCODE = '22023', DETAIL = 'not_in_force';
    END IF;
    SELECT s.status INTO v_season_status
      FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
      JOIN public.season_settings s ON s.id = d.season_settings_id
     WHERE t.id = v_before.team_id;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'The season of practice preference % is completed and takes no change', p_preference_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    UPDATE public.coach_practice_preferences
       SET weekdays = p_weekdays,
           start_minutes = p_start_minutes,
           venue_ids = p_venue_ids,
           keep_weekday = COALESCE(p_keep_weekday, false),
           keep_start = COALESCE(p_keep_start, false),
           keep_venue = COALESCE(p_keep_venue, false),
           coach_priority = p_coach_priority,
           effective_from = p_effective_from,
           effective_to = p_effective_to,
           level = v_level,
           -- An admin who makes a rule a must has asked for it; one who makes a requested must a
           -- prefer has kept it as prefer; a rule nobody asked a must of stays plain.
           requested_level = CASE WHEN v_level = 'must' THEN 'must' ELSE requested_level END,
           must_decision = CASE WHEN v_level = 'must' THEN 'accepted'
                                WHEN requested_level = 'must' THEN 'kept_prefer'
                                ELSE NULL END,
           decided_by = CASE WHEN v_level = 'must' OR requested_level = 'must' THEN auth.uid() ELSE decided_by END,
           decided_at = CASE WHEN v_level = 'must' OR requested_level = 'must' THEN now() ELSE decided_at END,
           updated_by = auth.uid(),
           updated_at = now()
     WHERE id = p_preference_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        v_after.organization_id, 'practice_preference.edited', 'coach_practice_preference', v_after.id,
        jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after))
    );
    RETURN to_jsonb(v_after);
END;
$function$;

CREATE FUNCTION public.admin_remove_practice_preference(p_preference_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_before public.coach_practice_preferences%ROWTYPE;
    v_after public.coach_practice_preferences%ROWTYPE;
    v_season_status text;
BEGIN
    IF p_preference_id IS NULL THEN
        RAISE EXCEPTION 'p_preference_id is required' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_before FROM public.coach_practice_preferences WHERE id = p_preference_id FOR UPDATE;
    IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_org_admin(v_before.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin removes a practice preference' USING ERRCODE = '42501';
    END IF;
    IF v_before.status <> 'in_force' THEN
        RAISE EXCEPTION 'practice preference % is %, not in force, so it cannot be removed', p_preference_id, v_before.status
            USING ERRCODE = '22023', DETAIL = 'not_in_force';
    END IF;
    SELECT s.status INTO v_season_status
      FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
      JOIN public.season_settings s ON s.id = d.season_settings_id
     WHERE t.id = v_before.team_id;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'The season of practice preference % is completed and takes no change', p_preference_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    UPDATE public.coach_practice_preferences
       SET status = 'removed', updated_by = auth.uid(), updated_at = now()
     WHERE id = p_preference_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        v_after.organization_id, 'practice_preference.removed', 'coach_practice_preference', v_after.id,
        jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after))
    );
    RETURN to_jsonb(v_after);
END;
$function$;

CREATE FUNCTION public.admin_decide_must_preference(p_preference_id uuid, p_decision text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_before public.coach_practice_preferences%ROWTYPE;
    v_after public.coach_practice_preferences%ROWTYPE;
    v_season_status text;
BEGIN
    IF p_preference_id IS NULL OR p_decision IS NULL THEN
        RAISE EXCEPTION 'p_preference_id and p_decision are required' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_before FROM public.coach_practice_preferences WHERE id = p_preference_id FOR UPDATE;
    IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_org_admin(v_before.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin decides a requested must' USING ERRCODE = '42501';
    END IF;
    IF p_decision NOT IN ('accept', 'keep_prefer') THEN
        RAISE EXCEPTION 'p_decision must be accept or keep_prefer, not %', p_decision USING ERRCODE = '22023';
    END IF;
    IF v_before.status <> 'in_force' OR v_before.must_decision IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION 'practice preference % is not a pending must (status %, decision %)',
            p_preference_id, v_before.status, v_before.must_decision
            USING ERRCODE = '22023', DETAIL = 'not_pending';
    END IF;
    SELECT s.status INTO v_season_status
      FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
      JOIN public.season_settings s ON s.id = d.season_settings_id
     WHERE t.id = v_before.team_id;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'The season of practice preference % is completed and takes no change', p_preference_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    UPDATE public.coach_practice_preferences
       SET level = CASE WHEN p_decision = 'accept' THEN 'must' ELSE 'prefer' END,
           must_decision = CASE WHEN p_decision = 'accept' THEN 'accepted' ELSE 'kept_prefer' END,
           decided_by = auth.uid(), decided_at = now(),
           updated_by = auth.uid(), updated_at = now()
     WHERE id = p_preference_id
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        v_after.organization_id, 'practice_preference.must_decided', 'coach_practice_preference', v_after.id,
        jsonb_build_object('decision', p_decision, 'before', to_jsonb(v_before), 'after', to_jsonb(v_after))
    );
    RETURN to_jsonb(v_after);
END;
$function$;

CREATE FUNCTION public.admin_accept_all_musts(p_import_job_id uuid, p_expected_count integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_season_status text;
    v_ids uuid[];
BEGIN
    IF p_import_job_id IS NULL OR p_expected_count IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id and p_expected_count are required' USING ERRCODE = '23502';
    END IF;
    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id;
    IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: only an organization admin accepts requested musts' USING ERRCODE = '42501';
    END IF;
    IF p_expected_count < 0 THEN
        RAISE EXCEPTION 'p_expected_count must not be negative' USING ERRCODE = '22023';
    END IF;
    SELECT s.status INTO v_season_status
      FROM public.season_settings s
     WHERE s.organization_id = v_job.organization_id
       AND (CASE WHEN v_job.season_settings_id IS NULL THEN s.status = 'active' ELSE s.id = v_job.season_settings_id END);
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'The season of import job % is completed and takes no change', p_import_job_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    -- The pending musts of this file, locked, so the count compared is the count accepted.
    SELECT COALESCE(array_agg(p.id ORDER BY p.id), ARRAY[]::uuid[]) INTO v_ids
      FROM (SELECT id FROM public.coach_practice_preferences
             WHERE organization_id = v_job.organization_id
               AND import_job_id = p_import_job_id
               AND status = 'in_force' AND must_decision = 'pending'
             ORDER BY id FOR UPDATE) p;
    IF cardinality(v_ids) <> p_expected_count THEN
        RAISE EXCEPTION 'import job % has % pending must(s), not the % the confirmation showed; nothing was accepted',
            p_import_job_id, cardinality(v_ids), p_expected_count
            USING ERRCODE = '22023', DETAIL = 'expected_count_mismatch';
    END IF;

    UPDATE public.coach_practice_preferences
       SET level = 'must', must_decision = 'accepted',
           decided_by = auth.uid(), decided_at = now(), updated_by = auth.uid(), updated_at = now()
     WHERE id = ANY (v_ids);

    PERFORM public.record_audit_event(
        v_job.organization_id, 'practice_preference.musts_accepted', 'import_job', p_import_job_id,
        jsonb_build_object('accepted_count', cardinality(v_ids), 'expected_count', p_expected_count,
                           'preference_ids', to_jsonb(v_ids))
    );
    RETURN jsonb_build_object('accepted', cardinality(v_ids), 'import_job_id', p_import_job_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_remove_practice_preference(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_decide_must_preference(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_accept_all_musts(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_practice_preference(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decide_must_preference(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_accept_all_musts(uuid, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) IS
  'Admin-only: add one practice preference rule for a team (the coach must coach it today): weekdays / start_minutes / venue_ids (any of) or keep-current per condition, level prefer | must (an admin grants must), optional coach_priority and date window. Audited as practice_preference.added. 20261112010000.';
COMMENT ON FUNCTION public.admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date) IS
  'Admin-only: replace an in-force rule''s conditions, level, priority and window (the coach and team stay). Audited as practice_preference.edited with before and after. 20261112010000.';
COMMENT ON FUNCTION public.admin_remove_practice_preference(uuid) IS
  'Admin-only: remove an in-force rule (status removed; the row stays as history). Audited as practice_preference.removed. 20261112010000.';
COMMENT ON FUNCTION public.admin_decide_must_preference(uuid, text) IS
  'Admin-only: accept a pending requested must (level must) or keep it as prefer. Audited as practice_preference.must_decided. 20261112010000.';
COMMENT ON FUNCTION public.admin_accept_all_musts(uuid, integer) IS
  'Admin-only: accept every pending requested must of one import file, refusing (22023 expected_count_mismatch) when their count is not p_expected_count, the number the confirmation showed. Audited as practice_preference.musts_accepted. 20261112010000.';

-- ---------------------------------------------------------------------------
-- 5. The import type `practice_preferences`.
-- ---------------------------------------------------------------------------
--
-- A preference file is staged like a coach file: `create_import_job` opens a `registration` job for the
-- type, `import-validation` stages its rows in `staging_import_rows`, and the finalizer below applies
-- them. The four functions here are replaced from their live bodies (the md5 guards above) with the one
-- change each: they know the new type. Nothing else in them moves.

ALTER TABLE public.staging_import_rows DROP CONSTRAINT staging_import_rows_import_type_check;
ALTER TABLE public.staging_import_rows ADD CONSTRAINT staging_import_rows_import_type_check
    CHECK (import_type IN ('coaches', 'fields', 'field_availability', 'practice_preferences'));

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
    IF v_import_type NOT IN ('players', 'coaches', 'fields', 'field_availability', 'practice_preferences') THEN
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
      -- 20261111010000: the active season or a draft takes a registration or coach import (a
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

CREATE OR REPLACE FUNCTION public.mark_import_job_ready_to_apply(p_import_job_id uuid, p_import_type text, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences') THEN RAISE EXCEPTION 'Deferred apply is only available for coach, field, field_availability, and practice_preferences imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','ready_to_apply','import_type',v_import_type,'staged_rows',v_staged_rows,'validation_error_rows',jsonb_array_length(COALESCE(p_validation_errors,'[]'::jsonb)),'ready_at',timezone('utc',now()));
  UPDATE public.import_jobs SET status='ready_to_apply', processed_rows=v_staged_rows, progress_percent=100, completed_at=NULL, error_summary=jsonb_build_object('rowErrors',COALESCE(p_validation_errors,'[]'::jsonb)), warning_summary=jsonb_set(COALESCE(warning_summary,'{}'::jsonb),'{deferred_apply}',v_result,true) WHERE id=p_import_job_id;
  PERFORM public.record_audit_event(v_job.organization_id,'import.validated','import_job',p_import_job_id,v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_ready_import_job(p_import_job_id uuid, p_import_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE v_job public.import_jobs%ROWTYPE; v_import_type text:=lower(NULLIF(btrim(COALESCE(p_import_type,'')),'')); v_result jsonb; v_staged_rows integer;
BEGIN
  IF v_import_type NOT IN ('coaches','fields','field_availability','practice_preferences') THEN RAISE EXCEPTION 'Deferred apply cancellation is only available for coach, field, field_availability, and practice_preferences imports' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_job FROM public.import_jobs WHERE id=p_import_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE='P0002'; END IF;
  IF NOT public.is_org_admin(v_job.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF v_import_type IN ('coaches','practice_preferences') AND v_job.job_type<>'registration' THEN RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='fields' AND v_job.job_type<>'fields' THEN RAISE EXCEPTION 'Import job % is %, not fields', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  IF v_import_type='field_availability' AND v_job.job_type<>'field_availability' THEN RAISE EXCEPTION 'Import job % is %, not field_availability', p_import_job_id, v_job.job_type USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_staged_rows FROM public.staging_import_rows WHERE import_job_id=p_import_job_id AND organization_id=v_job.organization_id AND import_type=v_import_type;
  v_result:=jsonb_build_object('status','canceled','import_type',v_import_type,'staged_rows',v_staged_rows,'canceled_at',timezone('utc',now()));
  UPDATE public.import_jobs SET status='failed',completed_at=timezone('utc',now()),error_summary=jsonb_set(COALESCE(error_summary,'{}'::jsonb),'{deferred_apply}',v_result,true),warning_summary=jsonb_set(COALESCE(warning_summary,'{}'::jsonb),'{deferred_apply}',v_result,true) WHERE id=p_import_job_id;
  PERFORM public.record_audit_event(v_job.organization_id,'import.canceled','import_job',p_import_job_id,v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.import_allowed_keys(p_import_type text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
    SELECT CASE p_import_type
        WHEN 'players' THEN ARRAY[
            'first_name', 'last_name', 'preferred_name', 'nickname', 'external_registration_id',
            'gotsport_id', 'registration_id', 'player_id', 'natural_age',
            'age group', 'age_group', 'age', 'gender', 'grade', 'division_id', 'division_name',
            'division', 'group', 'program', 'skill_tier', 'skill_level', 'years_played',
            'years played',
            'how many years has your player played in an organized soccer program?', 'waitlist',
            'waitlisted', 'play_up', 'play up',
            'are you coaching so this player can play up a division?', 'willing_to_coach',
            'coach_volunteer', 'can you coach for this player''s team?', 'buddy_request',
            'buddy_id', 'buddy_external_registration_id', 'buddy_registration_id',
            'friend_request', 'mutual_buddy_code', 'buddy_code', 'friend_code', 'team name',
            'team age', 'team gender'
        ]::text[]
        WHEN 'coaches' THEN ARRAY[
            'full_name', 'email', 'status', 'coach_status', 'can_coach_multiple_teams',
            'multiple_teams', 'multi_team', 'certifications', 'certification',
            'child_registration_id', 'first_name', 'last_name'
        ]::text[]
        WHEN 'practice_preferences' THEN ARRAY[
            'email', 'team_name', 'team name', 'team', 'request_level', 'weekdays', 'days', 'day',
            'start_times', 'start_time', 'start', 'venues', 'location', 'effective_from',
            'valid_from', 'effective_to', 'valid_until', 'coach_priority'
        ]::text[]
        ELSE ARRAY[]::text[]
    END;
$function$;

-- A staged preference row holds a coach's email, so it is kept as long as a staged coach row is: the
-- retention job that deletes a finished job's staged coach rows 30 days after they were staged
-- (20261022010000) takes the preference rows too. cron.schedule with an existing name replaces that
-- job's command; the old condition `import_type = 'coaches'` stays in it, one arm of two.
SELECT cron.schedule(
    'cleanup-staging-import-rows',
    '0 3 * * *',
    $$ DELETE FROM public.staging_import_rows s USING public.import_jobs j WHERE j.id = s.import_job_id AND (s.import_type = 'coaches' OR s.import_type = 'practice_preferences') AND j.status IN ('completed', 'completed_with_warnings', 'failed') AND s.created_at < now() - interval '30 days' $$
);

-- One row of a preference file is one rule. Columns (after the import's header normalization; the keys are
-- on the allowlist in the browser, in import-validation and in `import_allowed_keys` above):
--   email                 the coach's email, the key the coach import uses. Required.
--   team_name | team name | team
--                         the team, by name within the job's season. Blank: one rule for each team the
--                         coach coaches today.
--   request_level         prefer (default) or must. A must is in force as prefer until an admin accepts it.
--   weekdays | days | day         Tue, Tuesday ...; several separated by , ; / | & "and" "or".
--   start_times | start_time | start    5:00 PM, 17:00, 5pm; several separated the same way.
--   venues | location     location names, several separated by ; or | (a name with a comma is one name).
--   effective_from | valid_from, effective_to | valid_until     YYYY-MM-DD or M/D/YYYY.
--   coach_priority        high, medium or low.
-- A row must name at least one day, start time or venue. A row with a problem is not applied: its reason is
-- written to the staged row (never the coach's email) and counted in the result; an unknown coach or team
-- is listed and NEVER created. Rows are applied independently.
--
-- Replacement. The teams the file names are the teams of its applied rows. The in-force rules with source
-- `import` on those teams, whatever file they came from, become `replaced`; the file's rules are
-- inserted; rules an admin added in the app (source `admin`) and imported rules on other teams are left
-- alone. A replaced rule that had been accepted as a must is replaced by a pending one: the admin accepts
-- again (Accept all covers a file already reviewed).
--
-- The season is the job's own (the active season for a job made before jobs carried one). A completed
-- season takes no import; a draft season does, as E3b (20261111010000) made it for players and coaches.

CREATE FUNCTION public.finalize_practice_preference_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_row public.staging_import_rows%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_season_settings_id uuid;
    v_season_status text;
    v_email text;
    v_team_text text;
    v_level_text text;
    v_requested text;
    v_days_text text;
    v_times_text text;
    v_venues_text text;
    v_from_text text;
    v_to_text text;
    v_priority_text text;
    v_coach_id uuid;
    v_weekdays text[];
    v_starts integer[];
    v_venues uuid[];
    v_from date;
    v_to date;
    v_priority text;
    v_token text;
    v_code text;
    v_parts text[];
    v_hour integer;
    v_minute integer;
    v_minutes integer;
    v_venue_id uuid;
    v_error text;
    v_kind text;
    v_matches uuid[];
    v_team_ids uuid[];
    v_team_id uuid;
    v_signature text;
    v_seen text[] := ARRAY[]::text[];
    v_rules jsonb := '[]'::jsonb;
    v_rule jsonb;
    v_new_id uuid;
    v_applied_row boolean;
    v_inserted_count integer := 0;
    v_pending_count integer := 0;
    v_invalid_count integer := 0;
    v_duplicate_count integer := 0;
    v_unknown_coach_count integer := 0;
    v_unknown_team_count integer := 0;
    v_no_team_count integer := 0;
    v_not_on_team_count integer := 0;
    v_unknown_coaches jsonb := '[]'::jsonb;
    v_unknown_teams jsonb := '[]'::jsonb;
    v_inserted_ids uuid[] := ARRAY[]::uuid[];
    v_replaced_ids uuid[];
    v_teams_named uuid[];
    v_status_result text;
    v_result jsonb;
    v_stored jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_job FROM public.import_jobs WHERE id = p_import_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;
    IF auth.uid() IS NULL OR NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;
    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;
    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id USING ERRCODE = '22023';
    END IF;

    -- The season the rules are for: the job's own, or for a job made before jobs carried one the
    -- organization's active season. A completed season takes no import; an active or draft one does.
    SELECT s.id, s.status INTO v_season_settings_id, v_season_status
      FROM public.season_settings s
     WHERE s.organization_id = v_job.organization_id
       AND (CASE WHEN v_job.season_settings_id IS NULL THEN s.status = 'active' ELSE s.id = v_job.season_settings_id END);
    IF v_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'Organization % has no season to import into', v_job.organization_id
            USING ERRCODE = '22023', DETAIL = 'season_missing';
    END IF;
    IF v_season_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and takes no import', v_season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    FOR v_row IN
        SELECT *
          FROM public.staging_import_rows
         WHERE import_job_id = p_import_job_id
           AND organization_id = v_job.organization_id
           AND import_type = 'practice_preferences'
           AND applied_at IS NULL
           AND normalized_payload IS NOT NULL
           AND COALESCE(jsonb_array_length(validation_errors), 0) = 0
         ORDER BY source_row_number NULLS LAST, id
    LOOP
        v_error := NULL;
        v_kind := 'invalid';
        v_coach_id := NULL;
        v_team_ids := NULL;
        v_weekdays := NULL;
        v_starts := NULL;
        v_venues := NULL;
        v_applied_row := false;

        v_email := lower(public.import_payload_text(v_row.normalized_payload, 'email'));
        v_team_text := public.import_payload_text(v_row.normalized_payload, 'team_name', 'team name', 'team');
        v_level_text := lower(public.import_payload_text(v_row.normalized_payload, 'request_level'));
        v_days_text := public.import_payload_text(v_row.normalized_payload, 'weekdays', 'days', 'day');
        v_times_text := public.import_payload_text(v_row.normalized_payload, 'start_times', 'start_time', 'start');
        v_venues_text := public.import_payload_text(v_row.normalized_payload, 'venues', 'location');
        v_from_text := public.import_payload_text(v_row.normalized_payload, 'effective_from', 'valid_from');
        v_to_text := public.import_payload_text(v_row.normalized_payload, 'effective_to', 'valid_until');
        v_priority_text := lower(public.import_payload_text(v_row.normalized_payload, 'coach_priority'));

        -- The request level: prefer when blank.
        v_requested := CASE
            WHEN v_level_text IS NULL THEN 'prefer'
            WHEN v_level_text ~ '(must|required|mandatory)' THEN 'must'
            WHEN v_level_text ~ '(prefer|nice|soft)' THEN 'prefer'
            ELSE NULL END;
        IF v_requested IS NULL THEN
            v_error := 'Unknown request level: use prefer or must';
        END IF;

        IF v_error IS NULL THEN
            v_priority := CASE
                WHEN v_priority_text IS NULL THEN NULL
                WHEN v_priority_text = 'high' THEN 'high'
                WHEN v_priority_text IN ('medium', 'med') THEN 'medium'
                WHEN v_priority_text = 'low' THEN 'low'
                ELSE 'bad' END;
            IF v_priority = 'bad' THEN
                v_error := 'Unknown priority: use high, medium or low';
            END IF;
        END IF;

        IF v_error IS NULL AND v_days_text IS NOT NULL THEN
            v_weekdays := ARRAY[]::text[];
            FOR v_token IN
                SELECT btrim(t) FROM regexp_split_to_table(lower(v_days_text), '\s*(?:;|,|\||/|&|\sor\s|\sand\s)\s*') t
            LOOP
                IF v_token = '' THEN CONTINUE; END IF;
                v_code := upper(public.import_text_to_day_of_week(v_token)::text);
                IF v_code IS NULL THEN
                    v_error := 'Unknown day in the days column';
                    EXIT;
                END IF;
                IF NOT v_code = ANY (v_weekdays) THEN v_weekdays := v_weekdays || v_code; END IF;
            END LOOP;
            IF cardinality(v_weekdays) = 0 THEN v_weekdays := NULL; END IF;
        END IF;

        IF v_error IS NULL AND v_times_text IS NOT NULL THEN
            v_starts := ARRAY[]::integer[];
            FOR v_token IN
                SELECT btrim(t) FROM regexp_split_to_table(lower(v_times_text), '\s*(?:;|,|\||/|&|\sor\s|\sand\s)\s*') t
            LOOP
                IF v_token = '' THEN CONTINUE; END IF;
                -- 5:00 PM, 5pm, 5:30 p.m., 17:00, 17: with am / pm the hour is 1 to 12, without it 0 to 23.
                v_parts := regexp_match(regexp_replace(v_token, '\.', '', 'g'), '^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$');
                v_minutes := NULL;
                IF v_parts IS NOT NULL THEN
                    v_hour := v_parts[1]::integer;
                    v_minute := COALESCE(v_parts[2], '0')::integer;
                    IF v_minute <= 59 AND (CASE WHEN v_parts[3] IS NULL THEN v_hour <= 23 ELSE v_hour BETWEEN 1 AND 12 END) THEN
                        v_minutes := (CASE WHEN v_parts[3] = 'am' THEN v_hour % 12
                                           WHEN v_parts[3] = 'pm' THEN v_hour % 12 + 12
                                           ELSE v_hour END) * 60 + v_minute;
                    END IF;
                END IF;
                IF v_minutes IS NULL THEN
                    v_error := 'Unreadable start time in the start times column';
                    EXIT;
                END IF;
                IF NOT v_minutes = ANY (v_starts) THEN v_starts := v_starts || v_minutes; END IF;
            END LOOP;
            IF cardinality(v_starts) = 0 THEN v_starts := NULL; END IF;
        END IF;

        IF v_error IS NULL AND v_venues_text IS NOT NULL THEN
            -- A venue name may hold a comma or an ampersand, so the whole cell is tried as one name first.
            SELECT l.id INTO v_venue_id FROM public.locations l
             WHERE l.organization_id = v_job.organization_id AND lower(btrim(l.name)) = lower(v_venues_text);
            IF v_venue_id IS NOT NULL THEN
                v_venues := ARRAY[v_venue_id];
            ELSE
                v_venues := ARRAY[]::uuid[];
                FOR v_token IN SELECT btrim(t) FROM regexp_split_to_table(v_venues_text, '\s*[;|]\s*') t LOOP
                    IF v_token = '' THEN CONTINUE; END IF;
                    v_venue_id := NULL;
                    SELECT l.id INTO v_venue_id FROM public.locations l
                     WHERE l.organization_id = v_job.organization_id AND lower(btrim(l.name)) = lower(v_token);
                    IF v_venue_id IS NULL THEN
                        v_error := 'Unknown venue: no location of this organization has that name';
                        EXIT;
                    END IF;
                    IF NOT v_venue_id = ANY (v_venues) THEN v_venues := v_venues || v_venue_id; END IF;
                END LOOP;
                IF cardinality(v_venues) = 0 THEN v_venues := NULL; END IF;
            END IF;
        END IF;

        IF v_error IS NULL THEN
            v_from := public.import_text_to_date(v_from_text);
            v_to := public.import_text_to_date(v_to_text);
            IF (v_from_text IS NOT NULL AND v_from IS NULL) OR (v_to_text IS NOT NULL AND v_to IS NULL) THEN
                v_error := 'Unreadable date in the effective from / until columns';
            ELSIF v_from IS NOT NULL AND v_to IS NOT NULL AND v_to < v_from THEN
                v_error := 'The effective until date is before the effective from date';
            END IF;
        END IF;

        -- A set has one canonical order, so the same rule written two ways is one rule: weekdays in week
        -- order, start times ascending, venues by id.
        IF v_error IS NULL THEN
            v_weekdays := ARRAY(SELECT d FROM unnest(v_weekdays) d
                                 ORDER BY array_position(ARRAY['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], d));
            v_starts := ARRAY(SELECT m FROM unnest(v_starts) m ORDER BY m);
            v_venues := ARRAY(SELECT v FROM unnest(v_venues) v ORDER BY v);
            IF cardinality(v_weekdays) = 0 THEN v_weekdays := NULL; END IF;
            IF cardinality(v_starts) = 0 THEN v_starts := NULL; END IF;
            IF cardinality(v_venues) = 0 THEN v_venues := NULL; END IF;
        END IF;

        IF v_error IS NULL AND v_weekdays IS NULL AND v_starts IS NULL AND v_venues IS NULL THEN
            v_error := 'The row names no day, start time or venue';
        END IF;

        -- The coach, by email within the job's season; never created.
        IF v_error IS NULL THEN
            IF v_email IS NULL THEN
                v_error := 'The row has no coach email';
            ELSE
                SELECT c.id INTO v_coach_id FROM public.coaches c
                 WHERE c.organization_id = v_job.organization_id
                   AND c.season_settings_id = v_season_settings_id
                   AND c.email = v_email;
                IF v_coach_id IS NULL THEN
                    v_error := 'No coach with this email in the season';
                    v_kind := 'unknown_coach';
                END IF;
            END IF;
        END IF;

        -- The team(s): by name within the season, else each team the coach coaches today.
        IF v_error IS NULL THEN
            IF v_team_text IS NOT NULL THEN
                SELECT array_agg(t.id ORDER BY t.id) INTO v_matches
                  FROM public.teams t JOIN public.divisions d ON d.id = t.division_id
                 WHERE t.organization_id = v_job.organization_id
                   AND d.season_settings_id = v_season_settings_id
                   AND lower(btrim(t.name)) = lower(v_team_text);
                IF v_matches IS NULL THEN
                    v_error := 'No team with this name in the season';
                    v_kind := 'unknown_team';
                ELSIF cardinality(v_matches) > 1 THEN
                    v_error := 'More than one team in the season has this name';
                ELSIF NOT EXISTS (
                        SELECT 1 FROM public.team_coach_assignments a
                         WHERE a.organization_id = v_job.organization_id AND a.team_id = v_matches[1]
                           AND a.coach_id = v_coach_id AND a.effective_from <= current_date
                           AND (a.effective_to IS NULL OR a.effective_to >= current_date)) THEN
                    v_error := 'The coach does not coach this team';
                    v_kind := 'not_on_team';
                ELSE
                    v_team_ids := v_matches;
                END IF;
            ELSE
                SELECT array_agg(DISTINCT a.team_id ORDER BY a.team_id) INTO v_team_ids
                  FROM public.team_coach_assignments a
                  JOIN public.teams t ON t.id = a.team_id
                  JOIN public.divisions d ON d.id = t.division_id
                 WHERE a.organization_id = v_job.organization_id
                   AND a.coach_id = v_coach_id
                   AND d.season_settings_id = v_season_settings_id
                   AND a.effective_from <= current_date
                   AND (a.effective_to IS NULL OR a.effective_to >= current_date);
                IF v_team_ids IS NULL THEN
                    v_error := 'The row names no team and the coach coaches none in the season';
                    v_kind := 'no_team';
                END IF;
            END IF;
        END IF;

        IF v_error IS NOT NULL THEN
            UPDATE public.staging_import_rows
               SET validation_errors = jsonb_build_array(jsonb_build_object(
                       'message', v_error, 'source_row_number', v_row.source_row_number))
             WHERE id = v_row.id;
            IF v_kind = 'unknown_coach' THEN
                v_unknown_coach_count := v_unknown_coach_count + 1;
                IF jsonb_array_length(v_unknown_coaches) < 200 THEN
                    v_unknown_coaches := v_unknown_coaches || jsonb_build_array(jsonb_build_object(
                        'row', v_row.source_row_number, 'email', left(v_email, 200)));
                END IF;
            ELSIF v_kind = 'unknown_team' THEN
                v_unknown_team_count := v_unknown_team_count + 1;
                IF jsonb_array_length(v_unknown_teams) < 200 THEN
                    v_unknown_teams := v_unknown_teams || jsonb_build_array(jsonb_build_object(
                        'row', v_row.source_row_number, 'team', left(v_team_text, 200)));
                END IF;
            ELSIF v_kind = 'no_team' THEN
                v_no_team_count := v_no_team_count + 1;
            ELSIF v_kind = 'not_on_team' THEN
                v_not_on_team_count := v_not_on_team_count + 1;
            ELSE
                v_invalid_count := v_invalid_count + 1;
            END IF;
            CONTINUE;
        END IF;

        -- One rule for each team; an identical rule already in this file counts once.
        FOREACH v_team_id IN ARRAY v_team_ids LOOP
            v_signature := concat_ws('|', v_team_id, v_coach_id, v_requested,
                COALESCE(array_to_string(v_weekdays, ','), ''), COALESCE(array_to_string(v_starts, ','), ''),
                COALESCE(array_to_string(v_venues, ','), ''), COALESCE(v_from::text, ''), COALESCE(v_to::text, ''),
                COALESCE(v_priority, ''));
            IF v_signature = ANY (v_seen) THEN
                v_duplicate_count := v_duplicate_count + 1;
            ELSE
                v_seen := v_seen || v_signature;
                v_rules := v_rules || jsonb_build_array(jsonb_build_object(
                    'team_id', v_team_id, 'coach_id', v_coach_id, 'requested', v_requested,
                    'weekdays', to_jsonb(v_weekdays), 'start_minutes', to_jsonb(v_starts),
                    'venue_ids', to_jsonb(v_venues), 'from', v_from, 'to', v_to, 'priority', v_priority));
            END IF;
            v_applied_row := true;
        END LOOP;

        IF v_applied_row THEN
            UPDATE public.staging_import_rows SET applied_at = v_now, applied_by = auth.uid() WHERE id = v_row.id;
        END IF;
    END LOOP;

    -- The imported rules of the teams the file names are replaced; admin rules are not.
    SELECT COALESCE(array_agg(DISTINCT (r ->> 'team_id')::uuid), ARRAY[]::uuid[]) INTO v_teams_named
      FROM jsonb_array_elements(v_rules) r;
    WITH replaced AS (
        UPDATE public.coach_practice_preferences
           SET status = 'replaced', updated_by = auth.uid(), updated_at = v_now
         WHERE organization_id = v_job.organization_id
           AND source = 'import'
           AND status = 'in_force'
           AND team_id = ANY (v_teams_named)
        RETURNING id
    )
    SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO v_replaced_ids FROM replaced;

    FOR v_rule IN SELECT value FROM jsonb_array_elements(v_rules) LOOP
        INSERT INTO public.coach_practice_preferences
            (organization_id, coach_id, team_id, weekdays, start_minutes, venue_ids, coach_priority,
             effective_from, effective_to, level, requested_level, must_decision, status, source,
             import_job_id, created_by, created_at)
        VALUES
            (v_job.organization_id, (v_rule ->> 'coach_id')::uuid, (v_rule ->> 'team_id')::uuid,
             CASE WHEN jsonb_typeof(v_rule -> 'weekdays') = 'array'
                  THEN ARRAY(SELECT jsonb_array_elements_text(v_rule -> 'weekdays')) END,
             CASE WHEN jsonb_typeof(v_rule -> 'start_minutes') = 'array'
                  THEN ARRAY(SELECT (jsonb_array_elements_text(v_rule -> 'start_minutes'))::integer) END,
             CASE WHEN jsonb_typeof(v_rule -> 'venue_ids') = 'array'
                  THEN ARRAY(SELECT (jsonb_array_elements_text(v_rule -> 'venue_ids'))::uuid) END,
             v_rule ->> 'priority',
             (v_rule ->> 'from')::date, (v_rule ->> 'to')::date,
             'prefer', v_rule ->> 'requested',
             CASE WHEN v_rule ->> 'requested' = 'must' THEN 'pending' END,
             'in_force', 'import', p_import_job_id, auth.uid(), v_now)
        RETURNING id INTO v_new_id;
        v_inserted_ids := v_inserted_ids || v_new_id;
        v_inserted_count := v_inserted_count + 1;
        IF v_rule ->> 'requested' = 'must' THEN v_pending_count := v_pending_count + 1; END IF;
    END LOOP;

    v_status_result := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR v_invalid_count > 0 OR v_unknown_coach_count > 0 OR v_unknown_team_count > 0
          OR v_no_team_count > 0 OR v_not_on_team_count > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    v_result := jsonb_build_object(
        'status', v_status_result,
        'staged_rows', (SELECT count(*) FROM public.staging_import_rows
                         WHERE import_job_id = p_import_job_id AND import_type = 'practice_preferences'),
        'season_settings_id', v_season_settings_id,
        'inserted_rules', v_inserted_count,
        'replaced_rules', cardinality(v_replaced_ids),
        'teams_named', cardinality(v_teams_named),
        'pending_musts', v_pending_count,
        'duplicate_rule_rows', v_duplicate_count,
        'invalid_rows', v_invalid_count,
        'unknown_coach_rows', v_unknown_coach_count,
        'unknown_team_rows', v_unknown_team_count,
        'no_team_rows', v_no_team_count,
        'coach_not_on_team_rows', v_not_on_team_count,
        'validation_error_rows', jsonb_array_length(v_validation_errors),
        'unknown_coaches', v_unknown_coaches,
        'unknown_teams', v_unknown_teams
    );
    -- What is stored on the job and in the audit log carries counts and row numbers, never a coach's email.
    v_stored := (v_result - 'unknown_coaches') || jsonb_build_object(
        'unknown_coach_rows_listed', (SELECT COALESCE(jsonb_agg(u -> 'row'), '[]'::jsonb) FROM jsonb_array_elements(v_unknown_coaches) u));

    UPDATE public.import_jobs
       SET status = v_status_result,
           processed_rows = (SELECT count(*) FROM public.staging_import_rows
                              WHERE import_job_id = p_import_job_id AND import_type = 'practice_preferences'
                                AND applied_at IS NOT NULL),
           progress_percent = 100,
           completed_at = v_now,
           error_summary = jsonb_build_object('rowErrors', v_validation_errors),
           warning_summary = jsonb_set(COALESCE(warning_summary, '{}'::jsonb), '{practice_preference_finalize}', v_stored, true)
     WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(v_job.organization_id, 'import.completed', 'import_job', p_import_job_id, v_stored);
    PERFORM public.record_audit_event(
        v_job.organization_id, 'practice_preference.imported', 'import_job', p_import_job_id,
        jsonb_build_object('inserted_ids', to_jsonb(v_inserted_ids), 'replaced_ids', to_jsonb(v_replaced_ids),
                           'teams_named', to_jsonb(v_teams_named), 'pending_musts', v_pending_count)
    );

    RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_practice_preference_import_job(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_practice_preference_import_job(uuid, jsonb) TO authenticated;
COMMENT ON FUNCTION public.finalize_practice_preference_import_job(uuid, jsonb) IS
  'Admin-only: apply a staged practice preference file (import type practice_preferences): one rule per row and team, the coach by email and the team by name within the job''s season, a blank team = each team the coach coaches, an unknown coach or team listed and never created, a re-import replaces the imported rules of the teams the file names and leaves admin rules alone, a requested must pending until an admin accepts it. A completed season takes no import. 20261112010000.';

-- ---------------------------------------------------------------------------
-- 6. admin_delete_team counts the rules its cascade takes.
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
-- 7. The two old RPCs read the dimension and value columns this migration dropped.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.admin_decide_coach_practice_preference(uuid, text, text, jsonb);
DROP FUNCTION public.admin_set_coach_practice_preference(uuid, text, text, jsonb);

-- ---------------------------------------------------------------------------
-- 8. A completed season's rules are read-only, like its schedules (20261111010000).
-- ---------------------------------------------------------------------------
--
-- The five RPCs and the finalizer already refuse a completed season; this puts the same refusal on the
-- table, so a write that is not one of them (a definer function added later, a direct write) meets it
-- too. The trigger function is E3b's: it finds a row's season through its `team_id` (a rule is for one
-- team), and a rule with no team (history kept for a coach who coached none) belongs to no season and
-- passes. A job with no signed-in user (the retention job, the backfill above) and the cascade of a
-- deleted team, season or organization pass, as for every other table it guards.

CREATE TRIGGER coach_practice_preferences_readonly_when_completed
    BEFORE INSERT OR UPDATE OR DELETE ON public.coach_practice_preferences
    FOR EACH ROW EXECUTE FUNCTION public.season_schedule_readonly_when_completed();

COMMENT ON FUNCTION public.season_schedule_readonly_when_completed() IS
    'Trigger function on teams, team_players, team_coach_assignments, practice_assignments, practice_exceptions, game_assignments, games (scores), schedule_tbd and coach_practice_preferences: a signed-in caller cannot insert, update or delete a row of a completed season (22023, season_completed). Callers with no signed-in user and cascades from a deleted season, team or organization pass. 20261111010000, 20261112010000.';

-- ---------------------------------------------------------------------------
-- 9. The end state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_n integer;
    v_fn text;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'coach_practice_preferences'
                  AND column_name IN ('dimension', 'value')) THEN
        RAISE EXCEPTION 'coach_practice_preferences still has dimension or value';
    END IF;
    -- Every row is a rule: in force only with a team, a condition, and the level its decision allows.
    SELECT count(*) INTO v_n FROM public.coach_practice_preferences
     WHERE (status = 'in_force' AND team_id IS NULL)
        OR (weekdays IS NULL AND start_minutes IS NULL AND venue_ids IS NULL
            AND NOT keep_weekday AND NOT keep_start AND NOT keep_venue)
        OR (level = 'must' AND must_decision IS DISTINCT FROM 'accepted');
    IF v_n <> 0 THEN
        RAISE EXCEPTION '% practice preference row(s) break the rule shape', v_n;
    END IF;
    FOREACH v_fn IN ARRAY ARRAY[
        'admin_add_practice_preference(uuid, uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)',
        'admin_edit_practice_preference(uuid, text, text[], integer[], uuid[], boolean, boolean, boolean, text, date, date)',
        'admin_remove_practice_preference(uuid)',
        'admin_decide_must_preference(uuid, text)',
        'admin_accept_all_musts(uuid, integer)',
        'finalize_practice_preference_import_job(uuid, jsonb)'
    ] LOOP
        IF to_regprocedure('public.' || v_fn) IS NULL THEN
            RAISE EXCEPTION '% is missing', v_fn;
        END IF;
        IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn))
           OR NOT has_function_privilege('authenticated', to_regprocedure('public.' || v_fn), 'EXECUTE')
           OR has_function_privilege('anon', to_regprocedure('public.' || v_fn), 'EXECUTE') THEN
            RAISE EXCEPTION '% is not a definer for authenticated and not anon', v_fn;
        END IF;
    END LOOP;
    IF to_regprocedure('public.admin_decide_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.admin_set_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL
       OR to_regprocedure('public.request_coach_practice_preference(uuid, text, text, jsonb)') IS NOT NULL THEN
        RAISE EXCEPTION 'an old practice preference RPC is still there';
    END IF;
    IF has_table_privilege('authenticated', 'public.coach_practice_preferences', 'INSERT')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.coach_practice_preferences', 'DELETE') THEN
        RAISE EXCEPTION 'a client can write coach_practice_preferences';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.coach_practice_preferences'::regclass AND relrowsecurity) THEN
        RAISE EXCEPTION 'coach_practice_preferences has no row level security';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.coach_practice_preferences'::regclass
                    AND tgname = 'coach_practice_preferences_enforce_tenancy' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'coach_practice_preferences has no tenancy trigger';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.coach_practice_preferences'::regclass
                    AND tgname = 'coach_practice_preferences_readonly_when_completed' AND NOT tgisinternal
                    AND tgenabled = 'O') THEN
        RAISE EXCEPTION 'coach_practice_preferences has no completed-season read-only trigger';
    END IF;
    IF cardinality(public.import_allowed_keys('practice_preferences')) <> 18
       OR NOT 'email' = ANY (public.import_allowed_keys('practice_preferences')) THEN
        RAISE EXCEPTION 'import_allowed_keys(practice_preferences) is not the 18 keys the finalizer reads';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-staging-import-rows'
                    AND command LIKE '%practice_preferences%' AND command LIKE '%import_type = ''coaches''%'
                    AND command LIKE '%30 days%') THEN
        RAISE EXCEPTION 'the staged-row retention job does not take practice_preferences rows';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.admin_delete_team(uuid)')
       AND p.prosrc LIKE '%coach_practice_preferences_deleted%' AND p.prosecdef;
    IF v_n <> 1 THEN RAISE EXCEPTION 'admin_delete_team does not count the rules its cascade takes'; END IF;
    FOREACH v_fn IN ARRAY ARRAY['create_import_job(uuid, text, text, uuid)',
                               'mark_import_job_ready_to_apply(uuid, text, jsonb)',
                               'cancel_ready_import_job(uuid, text)'] LOOP
        IF (SELECT p.prosrc NOT LIKE '%practice_preferences%' FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn)) THEN
            RAISE EXCEPTION '% does not know the practice_preferences import type', v_fn;
        END IF;
    END LOOP;
    RAISE NOTICE 'practice preference rules: the table, its tenancy trigger, the five admin RPCs, the import type and its finalizer are in place; % rule(s)',
        (SELECT count(*) FROM public.coach_practice_preferences);
END;
$$;

COMMIT;
