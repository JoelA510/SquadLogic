-- TIME TBD in the master export (Phase D, E; plan docs/changes/2026-10-27-phase-d-scheduling.md,
-- section E, task B5's `schedule_tbd` part, owner answer 11 and "Build notes: PR B").
--
-- **Why.** A practice a team is still short of, and a game the scheduler could not place, were in
-- no export: the master CSV and XLSX print only what has a start and an end, so the team's
-- missing practice or game was a silence (GAP-16, GAP-17, GAP-28). They are now recorded in a
-- table of their own and printed as TIME TBD rows with the reason.
--
-- **Why a separate table, not rows in `practice_assignments` / `game_assignments`** (the owner
-- allowed it only if keeping them in the schedule breaks things; PR B showed it does). A TIME TBD
-- row in `practice_assignments` has no slot and no dates, and everything that reads that table
-- treats a row as a held practice: the lock loader (`practice-lock.ts` loads every row as a
-- locked occupant of its team), the writer's prune and lock rules (by team and slot),
-- `teams_without_practice` (a team with a TBD row would count as having a practice) and the
-- metrics (a row is an assigned team). Each would need a "not a real practice" filter, and one
-- reader missed would count a missing practice as a held one, which is the failure this plan
-- exists to prevent. A table read only by the export and written only by the two writers below
-- cannot be mistaken for a placement.
--
-- **The change.**
--   1. `public.schedule_tbd`: organization, season, `kind` practice|game, the division, the
--      team (practice) or home and away team and week (game), `missing_count` (practice, 1 to 7),
--      `reason` (a closed list per kind, a CHECK), `detail`, the run that wrote it. RLS: an
--      organization admin reads (only league admins sign in). **No client writes the table**: no
--      INSERT, UPDATE or DELETE policy or grant; the two writers are definers (the practice writer
--      is an invoker and calls `sync_schedule_tbd_practices`, a definer that refuses any call not made by the practice save or by
--      `refresh_schedule_tbd_practices`, the client-callable refresh, which audits only a change). A BEFORE INSERT OR UPDATE
--      trigger refuses any row whose season, division or team belongs to another organization or
--      season (23514), so the definer writers cannot be made to store one. One row per team for
--      practices, one per (home, away, week) for games.
--   2. `get_schedule_tbd(season)`: the admin read the export panel uses (names included; every join
--      is on the row's own organization).
--   3. `persist_practice_schedule` is replaced (behind its md5): after its writes it rebuilds the
--      season's practice rows FROM THE ROSTER -- every team whose division wants N and which
--      holds r live rows (a range not ended) with N > r gets one row, missing_count N - r. The
--      payload and the solver's output are never the subject set; the run's own reason for the
--      team (`results.unassigned`) only labels the row (else `not-scheduled-yet`). A division at 0
--      a week lists nothing.
--   4. `persist_game_schedule` is replaced (behind its md5, same signature; `now()` for
--      `timezone('utc', now())` in the four places it was written, the function being pinned to UTC,
--      where the two are the same instant -- tests/utcNowIdiom.test.js keeps the idiom out of new migrations): a save whose
--      `results.unscheduled` is an array replaces the season's unscheduled games with it, each
--      entry validated (week, two different teams of the season, a reason on the closed list; one
--      bad entry refuses the save). A save with no such list (manual move, rollback) leaves the
--      list alone (declared: a rollback does not restore the list of the run it undoes).
--   5. `admin_delete_team` is replaced (behind its md5) with one more counter, `schedule_tbd_deleted`
--      on `team.deleted`: the table cascades from teams, and every cascading table has a counter
--      (supabase/tests/admin_delete_team_exceptions.sql walks the catalogue to insist on it).
--   6. An end-state check.
--
-- **The starting bodies are checked.** The migration refuses to replace a function whose text it
-- has not seen (the md5 of `prosrc`, carriage returns stripped, below). The practice writer's is
-- the body 20261105010000 builds; the game writer's is production's (read-only, 2026-10-28).
-- Production holds 0 teams, 0 practice assignments, 0 games.
--
-- No CASCADE, no DDL on auth or storage. Reversible: docs/sql/20261108020000_revert.sql restores
-- the three bodies and drops the read function and the table (it counts the rows it loses). Smoke:
-- docs/sql/20261108020000_smoke.sql. pgTAP: supabase/tests/schedule_tbd.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The starting bodies are checked, and what changes is counted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_expected constant jsonb := '{
        "persist_practice_schedule(jsonb,jsonb,boolean,jsonb,jsonb,jsonb,jsonb,text)": "a63d385e37a7d5e71965ba0fb093b531",
        "persist_game_schedule(jsonb,jsonb)": "1a9ad54a5c4f4f3dc71793b53b2e4f61",
        "admin_delete_team(uuid)": "4e44a5dec60c5eecae4c4e47644cd610"
    }';
    v_sig text;
    v_md5 text;
    v_teams bigint;
    v_rows bigint;
BEGIN
    FOR v_sig IN SELECT jsonb_object_keys(v_expected) LOOP
        -- Carriage returns stripped: production stores some bodies with CRLF line ends.
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_sig);
        IF v_md5 IS DISTINCT FROM v_expected ->> v_sig THEN
            RAISE EXCEPTION 'public.% has a body this migration has not seen (md5 %, expected %): not replacing it',
                v_sig, v_md5, v_expected ->> v_sig;
        END IF;
    END LOOP;
    IF to_regclass('public.schedule_tbd') IS NOT NULL THEN
        RAISE EXCEPTION 'public.schedule_tbd already exists: this migration has been applied, or something else made it';
    END IF;
    SELECT count(*) INTO v_teams FROM public.teams;
    SELECT count(*) INTO v_rows FROM public.practice_assignments;
    RAISE NOTICE 'schedule_tbd starts empty and fills at the next practice or game save; % team(s) and % practice row(s) are not changed',
        v_teams, v_rows;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The table.
-- ---------------------------------------------------------------------------

CREATE TABLE public.schedule_tbd (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    season_settings_id uuid NOT NULL REFERENCES public.season_settings (id) ON DELETE CASCADE,
    kind               text NOT NULL,
    division_id         uuid NOT NULL REFERENCES public.divisions (id) ON DELETE CASCADE,
    team_id            uuid REFERENCES public.teams (id) ON DELETE CASCADE,
    home_team_id       uuid REFERENCES public.teams (id) ON DELETE CASCADE,
    away_team_id       uuid REFERENCES public.teams (id) ON DELETE CASCADE,
    week_index         smallint,
    missing_count      smallint,
    reason             text NOT NULL,
    detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_id             uuid REFERENCES public.scheduler_runs (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT schedule_tbd_kind_check CHECK (kind IN ('practice', 'game')),
    CONSTRAINT schedule_tbd_shape CHECK (
        (kind = 'practice' AND team_id IS NOT NULL AND home_team_id IS NULL AND away_team_id IS NULL
            AND week_index IS NULL AND missing_count BETWEEN 1 AND 7)
        OR (kind = 'game' AND team_id IS NULL AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
            AND home_team_id <> away_team_id AND week_index BETWEEN 1 AND 255 AND missing_count IS NULL)),
    -- The reasons are core's (packages/core/src/scheduleTbd.js); tests/scheduleTbd.test.js pins this text to it.
    CONSTRAINT schedule_tbd_reason_check CHECK (
        (kind = 'practice' AND reason IN ('no-slot-available', 'no-live-date', 'coach-preference', 'practice-length', 'not-enough-days', 'not-scheduled-yet'))
        OR (kind = 'game' AND reason IN ('unknown-team', 'division-mismatch', 'duplicate-matchup', 'coach-coaches-both-teams', 'coach-scheduling-conflict', 'no-slot-available')))
);

-- A team has one practice row (its missing_count says how many); a game is its two sides and the week.
CREATE UNIQUE INDEX schedule_tbd_practice_team_key ON public.schedule_tbd (team_id) WHERE kind = 'practice';
CREATE UNIQUE INDEX schedule_tbd_game_key ON public.schedule_tbd (home_team_id, away_team_id, week_index) WHERE kind = 'game';
CREATE INDEX idx_schedule_tbd_season ON public.schedule_tbd (organization_id, season_settings_id);
CREATE INDEX idx_schedule_tbd_division_id ON public.schedule_tbd (division_id);
CREATE INDEX idx_schedule_tbd_run_id ON public.schedule_tbd (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_schedule_tbd_away_team_id ON public.schedule_tbd (away_team_id) WHERE away_team_id IS NOT NULL;

COMMENT ON TABLE public.schedule_tbd IS
    'Practices a team is still short of (kind practice: one row per team, missing_count of them) and games the scheduler could not place (kind game: home, away, week), each with its reason. Printed by the master export as TIME TBD / LOCATION TBD rows. Rebuilt by persist_practice_schedule from the roster and each division''s practices a week, and by persist_game_schedule from the run''s unscheduled games; never a placement, so no schedule reader counts it as one. 20261108020000.';
COMMENT ON COLUMN public.schedule_tbd.missing_count IS
    'Practice rows: how many of the division''s practices a week the team still lacks (practices_per_week less its live rows). NULL for a game.';
COMMENT ON COLUMN public.schedule_tbd.reason IS
    'Why: the auto-scheduler''s own reason for the missing practice or unplaced game, or not-scheduled-yet for a practice no run has given a reason for.';

ALTER TABLE public.schedule_tbd ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Schedule TBD: admins select"
    ON public.schedule_tbd FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id));

-- No INSERT, UPDATE or DELETE policy and no such grant: a client never writes the table. The practice
-- list is written by `sync_schedule_tbd_practices` and the game list by `persist_game_schedule`, both
-- definers that check the caller is an admin of the organization. (The first draft let admins insert
-- through RLS, which let one name another organization's team in a row of their own organization.)
REVOKE ALL ON public.schedule_tbd FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.schedule_tbd TO authenticated;
GRANT ALL ON public.schedule_tbd TO service_role;

-- A row belongs to one organization and one season, and so do the division and the teams it names:
-- refused (23514) whoever writes it, the definer writers included.
CREATE FUNCTION public.schedule_tbd_enforce_tenancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.season_settings ss
                    WHERE ss.id = NEW.season_settings_id AND ss.organization_id = NEW.organization_id) THEN
        RAISE EXCEPTION 'schedule_tbd: season % is not a season of organization %', NEW.season_settings_id, NEW.organization_id
            USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.divisions d
                    WHERE d.id = NEW.division_id AND d.organization_id = NEW.organization_id
                      AND d.season_settings_id = NEW.season_settings_id) THEN
        RAISE EXCEPTION 'schedule_tbd: division % is not a division of season % of organization %', NEW.division_id, NEW.season_settings_id, NEW.organization_id
            USING ERRCODE = '23514';
    END IF;
    IF NEW.kind = 'practice' THEN
        -- The team is one of the row's division.
        IF NOT EXISTS (SELECT 1 FROM public.teams t
                        WHERE t.id = NEW.team_id AND t.organization_id = NEW.organization_id
                          AND t.division_id = NEW.division_id) THEN
            RAISE EXCEPTION 'schedule_tbd: team % is not a team of division % of organization %', NEW.team_id, NEW.division_id, NEW.organization_id
                USING ERRCODE = '23514';
        END IF;
    ELSE
        -- The home team is one of the row's division; the away team is any team of the season (a
        -- 'division-mismatch' game names one from another division).
        IF NOT EXISTS (SELECT 1 FROM public.teams t
                        WHERE t.id = NEW.home_team_id AND t.organization_id = NEW.organization_id
                          AND t.division_id = NEW.division_id) THEN
            RAISE EXCEPTION 'schedule_tbd: home team % is not a team of division % of organization %', NEW.home_team_id, NEW.division_id, NEW.organization_id
                USING ERRCODE = '23514';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.teams t
                         JOIN public.divisions d ON d.id = t.division_id
                        WHERE t.id = NEW.away_team_id AND t.organization_id = NEW.organization_id
                          AND d.organization_id = NEW.organization_id
                          AND d.season_settings_id = NEW.season_settings_id) THEN
            RAISE EXCEPTION 'schedule_tbd: away team % is not a team of season % of organization %', NEW.away_team_id, NEW.season_settings_id, NEW.organization_id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.schedule_tbd_enforce_tenancy() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER schedule_tbd_enforce_tenancy
    BEFORE INSERT OR UPDATE ON public.schedule_tbd
    FOR EACH ROW EXECUTE FUNCTION public.schedule_tbd_enforce_tenancy();

-- The practice list's internal writer: a definer, because no client can write the table and the practice
-- writer is an invoker (it runs as the calling admin, so it needs EXECUTE; a role grant cannot tell it
-- from a client). It rebuilds the season's practice rows from the roster and takes the run's reason
-- labels (kept to a closed list), so a direct client call could replace the saved labels without an
-- audit row. It therefore refuses any call whose stack does not show `persist_practice_schedule` or
-- `refresh_schedule_tbd_practices` above it (PG_CONTEXT: a client cannot put a frame there), and a
-- row it rewrites keeps its saved reason and run when the caller gives no label list (a refresh). The
-- client-callable way to refresh the list is `refresh_schedule_tbd_practices`, below.
CREATE FUNCTION public.sync_schedule_tbd_practices(p_organization_id uuid, p_season_settings_id uuid, p_run_id uuid, p_unassigned jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_org_id uuid := p_organization_id;
    v_season_id uuid := p_season_settings_id;
    v_persisted_run_id uuid;
    v_tbd_reasons jsonb;
    v_prev jsonb;
    v_keep boolean;
    v_ctx text;
    v_rows integer;
BEGIN
    GET DIAGNOSTICS v_ctx = PG_CONTEXT;
    IF v_ctx !~ 'PL/pgSQL function (persist_practice_schedule|refresh_schedule_tbd_practices)\(' THEN
        RAISE EXCEPTION 'sync_schedule_tbd_practices is called by the practice save and by refresh_schedule_tbd_practices only'
            USING ERRCODE = '42501';
    END IF;
    IF p_organization_id IS NULL OR p_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'organization and season are required'
            USING ERRCODE = '23502';
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.season_settings ss
                    WHERE ss.id = p_season_settings_id AND ss.organization_id = p_organization_id) THEN
        RAISE EXCEPTION 'season % is not a season of organization %', p_season_settings_id, p_organization_id
            USING ERRCODE = '42501';
    END IF;
    -- The run labels the rows; it is kept only if it is this organization's.
    SELECT sr.id INTO v_persisted_run_id
      FROM public.scheduler_runs sr
     WHERE sr.id = p_run_id AND sr.organization_id = p_organization_id;
    v_tbd_reasons := CASE WHEN jsonb_typeof(p_unassigned) = 'array' THEN p_unassigned ELSE '[]'::jsonb END;
    -- A call with no label list at all (refresh_schedule_tbd_practices) keeps what each team's row said before:
    -- its reason and its run. A call with a list (the practice save) is a run's own word and replaces them.
    v_keep := p_unassigned IS NULL;
    SELECT COALESCE(jsonb_object_agg(s.team_id::text, jsonb_build_object('reason', s.reason, 'run_id', s.run_id)), '{}'::jsonb)
      INTO v_prev
      FROM public.schedule_tbd s
     WHERE s.organization_id = v_org_id
       AND s.season_settings_id = v_season_id
       AND s.kind = 'practice';
    DELETE FROM public.schedule_tbd s
     WHERE s.organization_id = v_org_id
       AND s.season_settings_id = v_season_id
       AND s.kind = 'practice';
    INSERT INTO public.schedule_tbd (
        organization_id, season_settings_id, kind, division_id, team_id,
        missing_count, reason, detail, run_id
    )
    SELECT v_org_id, v_season_id, 'practice', d.id, t.id,
           (d.practices_per_week - held.n)::smallint,
           COALESCE(why.reason, CASE WHEN v_keep THEN v_prev -> t.id::text ->> 'reason' END, 'not-scheduled-yet'),
           jsonb_build_object('target', d.practices_per_week, 'held', held.n),
           CASE WHEN v_keep AND why.reason IS NULL AND v_prev ? t.id::text
                THEN NULLIF(v_prev -> t.id::text ->> 'run_id', '')::uuid
                ELSE v_persisted_run_id END
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
      CROSS JOIN LATERAL (
            SELECT count(*)::integer AS n
              FROM public.practice_assignments pa
             WHERE pa.team_id = t.id
               AND pa.organization_id = v_org_id
               AND (pa.effective_date_range IS NULL
                    OR (NOT isempty(pa.effective_date_range)
                        AND (upper_inf(pa.effective_date_range)
                             OR upper(pa.effective_date_range) > CURRENT_DATE)))
           ) held
      LEFT JOIN LATERAL (
            SELECT e.value->>'reason' AS reason
              FROM jsonb_array_elements(v_tbd_reasons) e
             WHERE jsonb_typeof(e.value) = 'object'
               AND lower(e.value->>'teamId') = lower(t.id::text)
               AND e.value->>'reason' IN ('no-slot-available', 'no-live-date', 'coach-preference',
                                          'practice-length', 'not-enough-days')
             ORDER BY e.value->>'reason'
             LIMIT 1
           ) why ON true
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id
       AND d.practices_per_week > held.n;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb) FROM anon;
-- EXECUTE for authenticated stays: persist_practice_schedule is an invoker and calls this as the admin.
-- The stack check above is what keeps a direct client call out.
GRANT EXECUTE ON FUNCTION public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb) TO service_role;

COMMENT ON FUNCTION public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb) IS
    'Internal: rebuilds a season''s practice rows in schedule_tbd from the roster. Refuses any call not made by persist_practice_schedule or refresh_schedule_tbd_practices. 20261108020000.';

-- A new audit action, registered as audit_log.action is a foreign key to audit_actions.
INSERT INTO public.audit_actions (action) VALUES ('schedule_tbd.refreshed')
    ON CONFLICT (action) DO NOTHING;

-- The client-callable refresh: the export (and a run that placed nothing, which never reaches the
-- practice save) brings the practice list up to date with the roster, the division counts and the saved
-- assignments. It takes no labels and no run: every row keeps the reason and the run it had, a new row is
-- `not-scheduled-yet`. It audits (in this transaction) only when the set of rows changed, so an export
-- with nothing new adds no audit row.
CREATE FUNCTION public.refresh_schedule_tbd_practices(p_season_settings_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_org uuid;
    v_before jsonb;
    v_after jsonb;
    v_added integer;
    v_removed integer;
    v_changed integer;
    v_changed_any boolean;
BEGIN
    IF p_season_settings_id IS NULL THEN
        RAISE EXCEPTION 'p_season_settings_id is required'
            USING ERRCODE = '23502';
    END IF;
    SELECT ss.organization_id INTO v_org FROM public.season_settings ss WHERE ss.id = p_season_settings_id;
    -- A season that does not exist and a season of another organization read alike.
    IF v_org IS NULL OR (COALESCE(auth.role(), '') <> 'service_role' AND NOT public.is_org_admin(v_org)) THEN
        RAISE EXCEPTION 'Access denied: the TIME TBD list is refreshed by an administrator of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    -- The same season lock as the practice save, so the two cannot interleave.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('persist_practice_schedule:' || v_org::text || ':' || p_season_settings_id::text, 0)
    );

    SELECT COALESCE(jsonb_agg(jsonb_build_object('team_id', s.team_id, 'missing_count', s.missing_count, 'reason', s.reason)
                              ORDER BY s.team_id), '[]'::jsonb)
      INTO v_before
      FROM public.schedule_tbd s
     WHERE s.organization_id = v_org AND s.season_settings_id = p_season_settings_id AND s.kind = 'practice';

    PERFORM public.sync_schedule_tbd_practices(v_org, p_season_settings_id, NULL, NULL);

    SELECT COALESCE(jsonb_agg(jsonb_build_object('team_id', s.team_id, 'missing_count', s.missing_count, 'reason', s.reason)
                              ORDER BY s.team_id), '[]'::jsonb)
      INTO v_after
      FROM public.schedule_tbd s
     WHERE s.organization_id = v_org AND s.season_settings_id = p_season_settings_id AND s.kind = 'practice';

    v_changed_any := v_before IS DISTINCT FROM v_after;
    IF v_changed_any THEN
        SELECT count(*) FILTER (WHERE b.team_id IS NULL),
               count(*) FILTER (WHERE a.team_id IS NULL),
               count(*) FILTER (WHERE a.team_id IS NOT NULL AND b.team_id IS NOT NULL
                                  AND (a.missing_count IS DISTINCT FROM b.missing_count OR a.reason IS DISTINCT FROM b.reason))
          INTO v_added, v_removed, v_changed
          FROM (SELECT (e->>'team_id')::uuid AS team_id, (e->>'missing_count')::int AS missing_count, e->>'reason' AS reason
                  FROM jsonb_array_elements(v_before) e) b
          FULL JOIN (SELECT (e->>'team_id')::uuid AS team_id, (e->>'missing_count')::int AS missing_count, e->>'reason' AS reason
                       FROM jsonb_array_elements(v_after) e) a
            ON a.team_id = b.team_id;
        -- record_audit_event writes auth.uid(); a service-role caller has none and is not audited here
        -- (the list is derived data and the change is visible in the table).
        IF auth.uid() IS NOT NULL THEN
            PERFORM public.record_audit_event(
                v_org,
                'schedule_tbd.refreshed',
                'season_settings',
                p_season_settings_id,
                jsonb_build_object(
                    'season_settings_id', p_season_settings_id,
                    'before_rows', jsonb_array_length(v_before),
                    'after_rows', jsonb_array_length(v_after),
                    'added', v_added,
                    'removed', v_removed,
                    'changed', v_changed)
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'changed', v_changed_any,
        'practice_rows', jsonb_array_length(v_after),
        'missing_practices', COALESCE((SELECT sum((e->>'missing_count')::int) FROM jsonb_array_elements(v_after) e), 0));
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_schedule_tbd_practices(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_schedule_tbd_practices(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.refresh_schedule_tbd_practices(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_schedule_tbd_practices(uuid) TO service_role;

COMMENT ON FUNCTION public.refresh_schedule_tbd_practices(uuid) IS
    'Brings a season''s practice TIME TBD list up to date with the roster, the division counts and the saved assignments, keeping each row''s reason and run; audits (schedule_tbd.refreshed) only when the rows changed. Admin only (42501 otherwise). 20261108020000.';

-- ---------------------------------------------------------------------------
-- 3. The admin read.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.get_schedule_tbd(p_season_settings_id uuid)
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

REVOKE ALL ON FUNCTION public.get_schedule_tbd(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_schedule_tbd(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_schedule_tbd(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_schedule_tbd(uuid) TO service_role;

COMMENT ON FUNCTION public.get_schedule_tbd(uuid) IS
    'The season''s TIME TBD list (practices a team is short of, games not placed), names included. Admin only (42501 otherwise). 20261108020000.';

-- ---------------------------------------------------------------------------
-- 4. The practice writer rebuilds the practice list from the roster.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.persist_practice_schedule(run_data jsonb, assignments jsonb, allow_empty boolean DEFAULT false, unlock jsonb DEFAULT '[]'::jsonb, closes jsonb DEFAULT '[]'::jsonb, exceptions jsonb DEFAULT '[]'::jsonb, withdraw_exceptions jsonb DEFAULT '[]'::jsonb, base_fingerprint text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
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
    v_effective_role text;
    v_missing_team_count integer;
    v_missing_slot_count integer;
    v_missing_range_count integer;
    v_invalid_source_count integer;
    v_invalid_via_count integer;
    v_missing_team_ref uuid;
    v_cross_team_ref uuid;
    v_missing_slot_ref uuid;
    v_cross_slot_ref uuid;
    v_removed jsonb;
    v_retained jsonb;
    v_row jsonb;
    v_audited boolean := false;
    v_updated integer;
    v_prior_results jsonb;
    v_payload_teams uuid[];
    v_teams_with_prior uuid[];
    v_season_team_count integer;
    v_without_practice jsonb;
    -- v3
    v_arg text;
    v_arg_value jsonb;
    v_unlock_ids uuid[];
    v_close_ids uuid[];
    v_withdraw_ids uuid[];
    v_withdraw_assignment_ids uuid[];
    v_prune_ids uuid[];
    v_replaced_ids uuid[];
    v_bad_id uuid;
    v_bad_why text;
    v_locked_id uuid;
    v_locked_why text;
    v_overlap_id uuid;
    v_fingerprint text;
    v_unlocked jsonb := '[]'::jsonb;
    v_closed jsonb := '[]'::jsonb;
    v_withdrawn jsonb := '[]'::jsonb;
    v_superseded_exceptions jsonb := '[]'::jsonb;
    v_recorded jsonb := '[]'::jsonb;
    v_time_tbd jsonb;
    -- 8.9 PR 6b
    v_bad_ref jsonb;
    -- 20261105010000: the writer gate for new auto rows
    v_new_auto_ids uuid[];
    v_refusal_text text;
    v_refusal_rows integer;
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

    -- v3: the four repair arguments are arrays of objects, like `assignments`.
    unlock := COALESCE(unlock, '[]'::jsonb);
    closes := COALESCE(closes, '[]'::jsonb);
    exceptions := COALESCE(exceptions, '[]'::jsonb);
    withdraw_exceptions := COALESCE(withdraw_exceptions, '[]'::jsonb);
    FOR v_arg, v_arg_value IN
        SELECT a.n, a.v FROM (VALUES ('unlock', unlock), ('closes', closes),
                                     ('exceptions', exceptions),
                                     ('withdraw_exceptions', withdraw_exceptions)) AS a(n, v)
    LOOP
        IF jsonb_typeof(v_arg_value) IS DISTINCT FROM 'array' THEN
            RAISE EXCEPTION '% must be a JSON array of objects', v_arg
                USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_arg_value) e
                    WHERE jsonb_typeof(e.value) IS DISTINCT FROM 'object') THEN
            RAISE EXCEPTION '% must be a JSON array of objects', v_arg
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    v_run_type := COALESCE(NULLIF(run_data->>'run_type', ''), 'practice');
    IF v_run_type <> 'practice' THEN
        RAISE EXCEPTION 'persist_practice_schedule only accepts practice runs'
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

    v_run_id := COALESCE(NULLIF(run_data->>'id', '')::uuid, gen_random_uuid());
    v_org_id := NULLIF(run_data->>'organization_id', '')::uuid;
    v_season_settings_id := NULLIF(run_data->>'season_settings_id', '')::uuid;
    v_season_id := COALESCE(NULLIF(run_data->>'season_id', '')::uuid, v_season_settings_id);
    v_effective_role := COALESCE(auth.role(), current_role, '');

    IF v_org_id IS NOT NULL
       AND v_effective_role <> 'service_role'
       AND NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'caller is not a member of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    IF v_season_settings_id IS NOT NULL
       AND v_season_id IS NOT NULL
       AND v_season_settings_id <> v_season_id THEN
        RAISE EXCEPTION 'season_id must match season_settings_id for practice persistence'
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

    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'caller is not a member of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- v3: the override prompt is admin-only and audited (plan §3). Its own
    -- gate, BEFORE the general admin check below and with its own message,
    -- so it holds even for a caller that check exempts: a service-role caller
    -- has no uid to audit, so it cannot unlock at all -- and with nothing
    -- unlocked it can neither prune, close nor withdraw.
    IF jsonb_array_length(unlock) > 0
       AND (auth.uid() IS NULL OR NOT public.is_org_admin(v_org_id)) THEN
        RAISE EXCEPTION 'unlock requires an org admin with a uid to audit: % assignment(s) named', jsonb_array_length(unlock)
            USING ERRCODE = '42501';
    END IF;

    -- #64: the prune below removes rows, so the caller must be able to remove
    -- them. `practice_assignments_write_admin` already limits every write to
    -- org admins; saying so here turns a silent zero-row DELETE into a refusal.
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(v_org_id) THEN
        RAISE EXCEPTION 'caller is not an admin of organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;

    -- #64: the prune is scoped to one season. Without one there is no scope,
    -- and guessing one is how another season's schedule would be deleted.
    IF v_season_id IS NULL THEN
        RAISE EXCEPTION 'season_settings_id is required: a practice schedule replaces one season''s schedule'
            USING ERRCODE = '23502';
    END IF;

    -- #64: an empty payload would supersede every auto row in the season. That
    -- is a legitimate request only when the caller says so.
    IF jsonb_array_length(assignments) = 0 AND NOT COALESCE(allow_empty, false) THEN
        RAISE EXCEPTION 'refusing an empty practice schedule: it would remove every auto assignment in season %; pass allow_empty => true to mean it', v_season_id
            USING ERRCODE = '22023';
    END IF;

    -- #64: two saves of the same season must not interleave their prune and
    -- upsert, or each keeps rows the other superseded.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('persist_practice_schedule:' || v_org_id::text || ':' || v_season_id::text, 0)
    );

    -- v3: optimistic concurrency. Read under the season lock, so nothing can
    -- change between this comparison and the writes below.
    v_fingerprint := public.practice_schedule_fingerprint(v_season_id);
    IF base_fingerprint IS NOT NULL AND base_fingerprint IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'season % changed since this plan was read (fingerprint % is now %); reload and re-plan', v_season_id, base_fingerprint, v_fingerprint
            USING ERRCODE = '40001';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.scheduler_runs sr
         WHERE sr.id = v_run_id
           AND sr.organization_id <> v_org_id
    ) THEN
        RAISE EXCEPTION 'scheduler run % belongs to another organization', v_run_id
            USING ERRCODE = '42501';
    END IF;

    IF v_effective_role = 'service_role' THEN
        BEGIN
            v_created_by := NULLIF(run_data->>'created_by', '')::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
            v_created_by := NULL;
        END;
    ELSE
        v_created_by := auth.uid();
    END IF;

    v_started_at := COALESCE(NULLIF(run_data->>'started_at', '')::timestamptz, now());
    v_completed_at := COALESCE(NULLIF(run_data->>'completed_at', '')::timestamptz, now());

    -- #64: the upsert below replaces `results`, so a re-save under the same
    -- run id would erase the before-images an earlier save of it recorded --
    -- for a service-role caller, the only record of those rows. Read them first.
    SELECT sr.results
      INTO v_prior_results
      FROM public.scheduler_runs sr
     WHERE sr.id = v_run_id
       AND sr.organization_id = v_org_id;

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
        'practice',
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

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            NULLIF(raw_assignments.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(raw_assignments.practice_slot_id, '')::uuid,
                NULLIF(raw_assignments.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(raw_assignments.effective_date_range, '')::daterange AS effective_date_range,
            CASE
                WHEN lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto'))
            END AS source,
            NULLIF(raw_assignments.assigned_via, '') AS assigned_via
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text,
            assigned_via text
        )
    ),
    validated_assignments AS (
        SELECT
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
            parsed_assignments.assigned_via,
            t.id AS existing_team_id,
            t.organization_id AS team_org_id,
            ps.id AS existing_slot_id,
            ps.organization_id AS slot_org_id
        FROM parsed_assignments
        LEFT JOIN public.teams t
          ON t.id = parsed_assignments.team_id
        LEFT JOIN public.practice_slots ps
          ON ps.id = parsed_assignments.practice_slot_id
    ),
    validation_summary AS (
        SELECT
            count(*) FILTER (WHERE team_id IS NULL) AS missing_team_count,
            count(*) FILTER (WHERE practice_slot_id IS NULL) AS missing_slot_count,
            count(*) FILTER (WHERE effective_date_range IS NULL) AS missing_range_count,
            count(*) FILTER (WHERE source NOT IN ('auto', 'manual')) AS invalid_source_count,
            count(*) FILTER (
                WHERE assigned_via IS NOT NULL
                  AND assigned_via NOT IN ('auto', 'manual', 'repair', 'recommendation', 'override')
            ) AS invalid_via_count,
            (
                array_agg(team_id)
                    FILTER (WHERE team_id IS NOT NULL AND existing_team_id IS NULL)
            )[1] AS missing_team_ref,
            (
                array_agg(team_id)
                    FILTER (
                        WHERE existing_team_id IS NOT NULL
                          AND team_org_id <> v_org_id
                    )
            )[1] AS cross_team_ref,
            (
                array_agg(practice_slot_id)
                    FILTER (
                        WHERE practice_slot_id IS NOT NULL
                          AND existing_slot_id IS NULL
                    )
            )[1] AS missing_slot_ref,
            (
                array_agg(practice_slot_id)
                    FILTER (
                        WHERE existing_slot_id IS NOT NULL
                          AND slot_org_id <> v_org_id
                    )
            )[1] AS cross_slot_ref
        FROM validated_assignments
    )
    SELECT
        missing_team_count,
        missing_slot_count,
        missing_range_count,
        invalid_source_count,
        invalid_via_count,
        missing_team_ref,
        cross_team_ref,
        missing_slot_ref,
        cross_slot_ref
      INTO
        v_missing_team_count,
        v_missing_slot_count,
        v_missing_range_count,
        v_invalid_source_count,
        v_invalid_via_count,
        v_missing_team_ref,
        v_cross_team_ref,
        v_missing_slot_ref,
        v_cross_slot_ref
      FROM validation_summary;

    IF v_missing_team_count > 0 THEN
        RAISE EXCEPTION 'assignment team_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_slot_count > 0 THEN
        RAISE EXCEPTION 'assignment practice_slot_id or slot_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_missing_range_count > 0 THEN
        RAISE EXCEPTION 'assignment effective_date_range is required'
            USING ERRCODE = '23502';
    END IF;

    IF v_invalid_source_count > 0 THEN
        RAISE EXCEPTION 'invalid practice assignment source'
            USING ERRCODE = '22023';
    END IF;

    IF v_invalid_via_count > 0 THEN
        RAISE EXCEPTION 'invalid practice assignment assigned_via'
            USING ERRCODE = '22023';
    END IF;

    IF v_missing_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_id % does not exist', v_missing_team_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_team_ref IS NOT NULL THEN
        RAISE EXCEPTION 'team_id % belongs to another organization', v_cross_team_ref
            USING ERRCODE = '42501';
    END IF;

    IF v_missing_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'practice_slot_id % does not exist', v_missing_slot_ref
            USING ERRCODE = '23503';
    END IF;

    IF v_cross_slot_ref IS NOT NULL THEN
        RAISE EXCEPTION 'practice_slot_id % belongs to another organization', v_cross_slot_ref
            USING ERRCODE = '42501';
    END IF;

    -- -----------------------------------------------------------------------
    -- 8.9 PR 6b: an exception names its row by `assignment_id` (a row that
    -- exists) OR by `new_assignment` (a (team, slot, range) key this save's
    -- `assignments` carries, resolved to its row after the insert below) --
    -- exactly one of the two. A key the payload does not carry would resolve
    -- to nothing, or to a row this save did not place.
    -- -----------------------------------------------------------------------
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(exceptions) e
                WHERE e.value ? 'new_assignment' AND e.value ? 'assignment_id') THEN
        RAISE EXCEPTION 'an exceptions entry names both assignment_id and new_assignment; name its row once'
            USING ERRCODE = '22023';
    END IF;
    SELECT e.value->'new_assignment'
      INTO v_bad_ref
      FROM jsonb_array_elements(exceptions) e
     WHERE e.value ? 'new_assignment'
       AND (jsonb_typeof(e.value->'new_assignment') IS DISTINCT FROM 'object'
            OR NOT EXISTS (
                SELECT 1
                  FROM jsonb_to_recordset(assignments) AS p(
                      team_id text,
                      practice_slot_id text,
                      slot_id text,
                      effective_date_range text
                  )
                 WHERE NULLIF(p.team_id, '')::uuid
                           = NULLIF(e.value#>>'{new_assignment,team_id}', '')::uuid
                   AND COALESCE(NULLIF(p.practice_slot_id, '')::uuid, NULLIF(p.slot_id, '')::uuid)
                           = NULLIF(e.value#>>'{new_assignment,practice_slot_id}', '')::uuid
                   AND NULLIF(p.effective_date_range, '')::daterange
                           = NULLIF(e.value#>>'{new_assignment,effective_date_range}', '')::daterange))
     LIMIT 1;
    IF v_bad_ref IS NOT NULL THEN
        RAISE EXCEPTION 'exceptions names new_assignment %, which is not a (team, slot, range) key this save''s assignments carry', v_bad_ref
            USING ERRCODE = '22023';
    END IF;
    -- The `assignment_id` path's season scope (42501, below), adopted: a
    -- new row named here must belong to a team of THIS season.
    SELECT e.value->'new_assignment'
      INTO v_bad_ref
      FROM jsonb_array_elements(exceptions) e
     WHERE e.value ? 'new_assignment'
       AND NOT EXISTS (
            SELECT 1
              FROM public.teams t
              JOIN public.divisions d ON d.id = t.division_id
             WHERE t.id = NULLIF(e.value#>>'{new_assignment,team_id}', '')::uuid
               AND t.organization_id = v_org_id
               AND d.season_settings_id = v_season_id)
     LIMIT 1;
    IF v_bad_ref IS NOT NULL THEN
        RAISE EXCEPTION 'exceptions names new_assignment %, whose team is not a team of season %', v_bad_ref, v_season_id
            USING ERRCODE = '42501';
    END IF;

    -- -----------------------------------------------------------------------
    -- v3: every assignment id the repair arguments name must be a row of THIS
    -- season. One that exists elsewhere is 42501, whatever the argument: a
    -- save of one season must not unlock, close or annotate another's rows.
    -- (An exception naming a `new_assignment` is judged above instead.)
    -- -----------------------------------------------------------------------
    SELECT x.id, x.arg
      INTO v_bad_id, v_bad_why
      FROM (
            SELECT NULLIF(u.value->>'assignment_id', '')::uuid AS id, 'unlock' AS arg
              FROM jsonb_array_elements(unlock) u
            UNION ALL
            SELECT NULLIF(c.value->>'assignment_id', '')::uuid, 'closes'
              FROM jsonb_array_elements(closes) c
            UNION ALL
            SELECT NULLIF(e.value->>'assignment_id', '')::uuid, 'exceptions'
              FROM jsonb_array_elements(exceptions) e
             WHERE NOT (e.value ? 'new_assignment')
           ) x
     WHERE x.id IS NULL
        OR NOT EXISTS (
            SELECT 1
              FROM public.practice_assignments pa
              JOIN public.teams t ON t.id = pa.team_id
              JOIN public.divisions d ON d.id = t.division_id
             WHERE pa.id = x.id
               AND pa.organization_id = v_org_id
               AND d.season_settings_id = v_season_id)
     LIMIT 1;
    IF v_bad_why IS NOT NULL THEN
        IF v_bad_id IS NULL THEN
            RAISE EXCEPTION '% entry has no assignment_id', v_bad_why
                USING ERRCODE = '23502';
        ELSIF EXISTS (SELECT 1 FROM public.practice_assignments pa WHERE pa.id = v_bad_id) THEN
            RAISE EXCEPTION '% names assignment %, which is not a row of season %', v_bad_why, v_bad_id, v_season_id
                USING ERRCODE = '42501';
        ELSE
            RAISE EXCEPTION '% names assignment %, which does not exist', v_bad_why, v_bad_id
                USING ERRCODE = '23503';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(unlock) u
                WHERE length(btrim(COALESCE(u.value->>'reason', ''))) = 0) THEN
        RAISE EXCEPTION 'every unlock entry needs a reason'
            USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT (u.value->>'assignment_id')::uuid), '{}'::uuid[])
      INTO v_unlock_ids
      FROM jsonb_array_elements(unlock) u;
    SELECT COALESCE(array_agg(DISTINCT (c.value->>'assignment_id')::uuid), '{}'::uuid[])
      INTO v_close_ids
      FROM jsonb_array_elements(closes) c;

    IF jsonb_array_length(closes) <> cardinality(v_close_ids) THEN
        RAISE EXCEPTION 'closes names an assignment more than once'
            USING ERRCODE = '22023';
    END IF;
    -- A close must SHORTEN the row and leave it non-empty: last_day inside it.
    SELECT (c.value->>'assignment_id')::uuid
      INTO v_bad_id
      FROM jsonb_array_elements(closes) c
      JOIN public.practice_assignments pa ON pa.id = (c.value->>'assignment_id')::uuid
     WHERE NULLIF(c.value->>'last_day', '') IS NULL
        OR (c.value->>'last_day')::date < lower(pa.effective_date_range)
        OR NOT (upper_inf(pa.effective_date_range)
                OR (c.value->>'last_day')::date + 1 < upper(pa.effective_date_range))
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'closes: last_day for assignment % must fall inside its range and shorten it', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(withdraw_exceptions) w
                WHERE NULLIF(w.value->>'exception_id', '') IS NULL) THEN
        RAISE EXCEPTION 'withdraw_exceptions entry has no exception_id'
            USING ERRCODE = '23502';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT (w.value->>'exception_id')::uuid), '{}'::uuid[])
      INTO v_withdraw_ids
      FROM jsonb_array_elements(withdraw_exceptions) w;
    SELECT x.id INTO v_bad_id
      FROM unnest(v_withdraw_ids) AS x(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.practice_exceptions pe
                        WHERE pe.id = x.id AND pe.organization_id = v_org_id
                          AND pe.season_settings_id = v_season_id AND pe.withdrawn_at IS NULL)
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'withdraw_exceptions names %, which is not a live exception of season %', v_bad_id, v_season_id
            USING ERRCODE = '42501';
    END IF;
    SELECT COALESCE(array_agg(DISTINCT pe.assignment_id), '{}'::uuid[])
      INTO v_withdraw_assignment_ids
      FROM public.practice_exceptions pe
     WHERE pe.id = ANY (v_withdraw_ids);

    -- #64: which of the season's teams held a practice BEFORE this save, for
    -- `teams_without_practice.had_prior_rows` below.
    SELECT COALESCE(array_agg(DISTINCT pa.team_id), '{}'::uuid[])
      INTO v_teams_with_prior
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- #64's prune set, computed rather than executed: v3 must refuse before
    -- it deletes anything. Scope is the season's teams, and only those.
    --   * a team IN the payload: every prior row whose (team, slot, range) key
    --     the payload does not carry -- unless `closes` names it, which keeps
    --     it by id with a shorter range;
    --   * a team in scope but ABSENT from the payload: its `auto` rows; its
    --     `manual` rows are kept and reported, as in #444.
    WITH payload AS MATERIALIZED (
        SELECT DISTINCT
            NULLIF(p.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(p.practice_slot_id, '')::uuid,
                NULLIF(p.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(p.effective_date_range, '')::daterange AS effective_date_range
        FROM jsonb_to_recordset(assignments) AS p(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text
        )
    ),
    scope AS (
        SELECT
            t.id AS team_id,
            EXISTS (SELECT 1 FROM payload k WHERE k.team_id = t.id) AS in_payload
        FROM public.teams t
        JOIN public.divisions d
          ON d.id = t.division_id
         AND d.organization_id = v_org_id
         AND d.season_settings_id = v_season_id
        WHERE t.organization_id = v_org_id
    ),
    prunable AS (
        SELECT pa.id, s.in_payload
          FROM public.practice_assignments pa
          JOIN scope s ON s.team_id = pa.team_id
         WHERE pa.organization_id = v_org_id
           AND NOT (pa.id = ANY (v_close_ids))
           AND (
               (
                   s.in_payload
                   AND NOT EXISTS (
                       SELECT 1
                         FROM payload k
                        WHERE k.team_id = pa.team_id
                          AND k.practice_slot_id = pa.practice_slot_id
                          AND k.effective_date_range = pa.effective_date_range
                   )
               )
               OR (NOT s.in_payload AND pa.source = 'auto')
           )
    )
    SELECT COALESCE(array_agg(prunable.id), '{}'::uuid[]),
           COALESCE(array_agg(prunable.id) FILTER (WHERE prunable.in_payload), '{}'::uuid[])
      INTO v_prune_ids, v_replaced_ids
      FROM prunable;

    -- -----------------------------------------------------------------------
    -- v3: THE LOCK. Every existing row this call would delete, re-range or
    -- move must be named in `unlock`, by its own id.
    -- -----------------------------------------------------------------------
    SELECT t.id, t.why
      INTO v_locked_id, v_locked_why
      FROM (
            SELECT p.id,
                   CASE WHEN p.id = ANY (v_replaced_ids)
                        THEN 'the payload no longer carries its (team, slot, range) key'
                        ELSE 'it is an auto row of a season team absent from the payload' END AS why
              FROM unnest(v_prune_ids) AS p(id)
            UNION ALL
            SELECT c.id, 'closes re-ranges it' FROM unnest(v_close_ids) AS c(id)
            UNION ALL
            SELECT w.id, 'an exception on it is withdrawn' FROM unnest(v_withdraw_assignment_ids) AS w(id)
           ) t
     WHERE NOT (t.id = ANY (v_unlock_ids))
     ORDER BY t.id
     LIMIT 1;
    IF v_locked_id IS NOT NULL THEN
        RAISE EXCEPTION 'assignment % is locked: % -- list it in unlock, with a reason, to change it', v_locked_id, v_locked_why
            USING ERRCODE = '22023';
    END IF;

    -- An exception on a series this same save prunes would have nothing to
    -- attach to after the prune, and would vanish without a word.
    SELECT (e.value->>'assignment_id')::uuid INTO v_bad_id
      FROM jsonb_array_elements(exceptions) e
     WHERE (e.value->>'assignment_id')::uuid = ANY (v_prune_ids)
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'exceptions names assignment %, which this save removes', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    -- The override prompt was accepted: one audit row per unlocked
    -- assignment, carrying the row as it stood before this save touched it.
    -- The gate above guarantees a uid whenever this list is non-empty.
    SELECT COALESCE(jsonb_agg(to_jsonb(pa.*) ORDER BY pa.id), '[]'::jsonb)
      INTO v_unlocked
      FROM public.practice_assignments pa
     WHERE pa.id = ANY (v_unlock_ids);
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_unlocked) LOOP
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.unlock_accepted',
            'practice_assignment',
            (v_row->>'id')::uuid,
            jsonb_build_object(
                'run_id', v_run_id,
                'season_settings_id', v_season_id,
                'reason', (SELECT u.value->>'reason' FROM jsonb_array_elements(unlock) u
                            WHERE (u.value->>'assignment_id')::uuid = (v_row->>'id')::uuid LIMIT 1),
                'before', v_row
            )
        );
    END LOOP;

    -- Withdrawals (their assignments are unlocked, checked above).
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = now(),
               withdrawn_by = auth.uid()
         WHERE pe.id = ANY (v_withdraw_ids)
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;

    -- Closes: shorten in place; the id survives (plan §3, retirement split).
    WITH pre AS (
        SELECT pa.*, (c.value->>'last_day')::date AS last_day
          FROM jsonb_array_elements(closes) c
          JOIN public.practice_assignments pa ON pa.id = (c.value->>'assignment_id')::uuid
    ),
    upd AS (
        UPDATE public.practice_assignments pa
           SET effective_date_range = daterange(lower(pa.effective_date_range), b.last_day + 1, '[)'),
               updated_at = now()
          FROM pre b
         WHERE pa.id = b.id
        RETURNING pa.id, pa.effective_date_range
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', upd.id,
               'before', to_jsonb(b.*) - 'last_day',
               'effective_date_range', upd.effective_date_range::text)
             ORDER BY upd.id), '[]'::jsonb)
      INTO v_closed
      FROM upd JOIN pre b ON b.id = upd.id;

    -- The unlocked prune. A WITHDRAWN exception no longer overrides anything,
    -- so it is archived onto this run and removed with its series; a LIVE one
    -- is left for the RESTRICT foreign key to refuse (23503): deleting an
    -- overridden series is never silent.
    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.assignment_id = ANY (v_prune_ids)
           AND pe.withdrawn_at IS NOT NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_superseded_exceptions
      FROM gone;

    WITH removed AS (
        DELETE FROM public.practice_assignments pa
         WHERE pa.id = ANY (v_prune_ids)
           AND pa.organization_id = v_org_id
        RETURNING pa.*,
            CASE WHEN pa.id = ANY (v_replaced_ids) THEN 'replaced' ELSE 'team_not_in_schedule' END
                AS superseded_reason
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(removed) ORDER BY removed.team_id, removed.id), '[]'::jsonb)
      INTO v_removed
      FROM removed;

    -- What the prune deliberately kept: rows of in-season teams the payload
    -- does not mention and whose source is not `auto`. Reported, not deleted.
    SELECT COALESCE(array_agg(DISTINCT NULLIF(p.team_id, '')::uuid), '{}'::uuid[])
      INTO v_payload_teams
      FROM jsonb_to_recordset(assignments) AS p(team_id text);

    SELECT COALESCE(
               jsonb_agg(to_jsonb(pa.*) ORDER BY pa.team_id, pa.id),
               '[]'::jsonb
           )
      INTO v_retained
      FROM public.practice_assignments pa
      JOIN public.teams t ON t.id = pa.team_id
      JOIN public.divisions d ON d.id = t.division_id
     WHERE pa.organization_id = v_org_id
       AND d.season_settings_id = v_season_id
       AND pa.team_id <> ALL (v_payload_teams);

    -- v3: a NEW key must not double-book its team. An addition removes
    -- nothing -- the rows the team holds stay protected by the delete,
    -- re-range and move locks above -- so the only harm it can do is a clash:
    -- a row the team still holds whose date range overlaps the new key's AND
    -- whose slot falls on the same weekday at overlapping minutes. A second
    -- weekday, or the same weekday at another time, is allowed (the corpus's
    -- normal two-weekday shape). Checked after closes and the prune, so an
    -- unlocked row that is removed or shortened makes room.
    WITH payload AS (
        SELECT DISTINCT
            NULLIF(p.team_id, '')::uuid AS team_id,
            COALESCE(NULLIF(p.practice_slot_id, '')::uuid, NULLIF(p.slot_id, '')::uuid) AS practice_slot_id,
            NULLIF(p.effective_date_range, '')::daterange AS effective_date_range
        FROM jsonb_to_recordset(assignments) AS p(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text
        )
    )
    SELECT pa.id
      INTO v_overlap_id
      FROM payload k
      JOIN public.practice_slots ks
        ON ks.id = k.practice_slot_id
      JOIN public.practice_assignments pa
        ON pa.team_id = k.team_id
       AND pa.effective_date_range && k.effective_date_range
      JOIN public.practice_slots ps
        ON ps.id = pa.practice_slot_id
     WHERE ps.day_of_week = ks.day_of_week
       AND ps.start_time < ks.end_time
       AND ks.start_time < ps.end_time
       AND NOT EXISTS (
               SELECT 1
                 FROM public.practice_assignments e
                WHERE e.team_id = k.team_id
                  AND e.practice_slot_id = k.practice_slot_id
                  AND e.effective_date_range = k.effective_date_range)
     ORDER BY pa.id
     LIMIT 1;
    IF v_overlap_id IS NOT NULL THEN
        RAISE EXCEPTION 'assignment % is locked: a new row for its team overlaps it in time -- unlock and remove or close it first', v_overlap_id
            USING ERRCODE = '22023';
    END IF;

    WITH parsed_assignments AS (
        SELECT
            NULLIF(raw_assignments.team_id, '')::uuid AS team_id,
            COALESCE(
                NULLIF(raw_assignments.practice_slot_id, '')::uuid,
                NULLIF(raw_assignments.slot_id, '')::uuid
            ) AS practice_slot_id,
            NULLIF(raw_assignments.effective_date_range, '')::daterange AS effective_date_range,
            CASE
                WHEN lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto')) = 'locked'
                    THEN 'manual'
                ELSE lower(COALESCE(NULLIF(raw_assignments.source, ''), 'auto'))
            END AS source,
            NULLIF(raw_assignments.assigned_via, '') AS assigned_via
        FROM jsonb_to_recordset(assignments) AS raw_assignments(
            team_id text,
            practice_slot_id text,
            slot_id text,
            effective_date_range text,
            source text,
            assigned_via text
        )
    ),
    org_scoped_assignments AS (
        SELECT DISTINCT ON (
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range
        )
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source,
            COALESCE(
                parsed_assignments.assigned_via,
                CASE WHEN parsed_assignments.source = 'manual' THEN 'manual' ELSE 'auto' END
            ) AS assigned_via,
            ps.day_of_week::text AS day_of_week,
            ps.start_time::text AS start_time,
            ps.end_time::text AS end_time,
            ps.field_id
        FROM parsed_assignments
        JOIN public.teams t
          ON t.id = parsed_assignments.team_id
         AND t.organization_id = v_org_id
        JOIN public.practice_slots ps
          ON ps.id = parsed_assignments.practice_slot_id
         AND ps.organization_id = v_org_id
        ORDER BY
            parsed_assignments.team_id,
            parsed_assignments.practice_slot_id,
            parsed_assignments.effective_date_range,
            parsed_assignments.source DESC
    ),
    ins AS (
    INSERT INTO public.practice_assignments (
        organization_id,
        run_id,
        team_id,
        slot_id,
        practice_slot_id,
        day_of_week,
        start_time,
        end_time,
        field_id,
        effective_date_range,
        source,
        assigned_via
    )
    SELECT
        v_org_id,
        v_run_id,
        team_id,
        practice_slot_id,
        practice_slot_id,
        day_of_week,
        start_time,
        end_time,
        field_id,
        effective_date_range,
        source::source_enum,
        assigned_via
    FROM org_scoped_assignments
    ON CONFLICT (team_id, practice_slot_id, effective_date_range)
        WHERE practice_slot_id IS NOT NULL
          AND effective_date_range IS NOT NULL
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        run_id = EXCLUDED.run_id,
        slot_id = EXCLUDED.slot_id,
        day_of_week = EXCLUDED.day_of_week,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        field_id = EXCLUDED.field_id,
        source = EXCLUDED.source,
        updated_at = now()
    RETURNING id, source, assigned_via, (xmax = 0) AS inserted
    )
    SELECT COALESCE(
               array_agg(ins.id ORDER BY ins.id)
                   FILTER (WHERE ins.inserted AND ins.source = 'auto' AND ins.assigned_via = 'auto'),
               '{}'::uuid[])
      INTO v_new_auto_ids
      FROM ins;
    -- (assigned_via is provenance: an existing row keeps the one it was
    -- placed with.)

    -- 20261105010000: THE WRITER GATE. A row this save INSERTED as an auto-scheduler
    -- placement must keep the rules the solver keeps and SQL can check -- slot capacity,
    -- the slot's division reservation, the division's practice length, a different
    -- weekday for each of a team's practices, and no more practices at once than the
    -- division's count. Judged on the table as this save leaves it, so a row removed or
    -- shortened by an unlock makes room. Manual, repair, recommendation and override rows,
    -- and a row that already existed, keep today's checks. Coach overlap, preferences and
    -- daylight stay the Edge function's (declared). The whole save rolls back.
    IF cardinality(v_new_auto_ids) > 0 THEN
        SELECT count(DISTINCT r.assignment_id),
               string_agg(
                   format('%s (team %s, slot %s): %s, %s', r.assignment_id, r.team_id,
                          r.practice_slot_id, r.rule, r.detail),
                   '; ' ORDER BY r.assignment_id, r.rule)
          INTO v_refusal_rows, v_refusal_text
          FROM public.practice_new_auto_row_refusals(v_org_id, v_new_auto_ids) r;
        IF v_refusal_rows > 0 THEN
            RAISE EXCEPTION 'refusing % new auto practice row(s) that break a rule the auto-scheduler keeps: %',
                v_refusal_rows, v_refusal_text
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- v3: exceptions are their own rows, keyed to the assignment they
    -- override -- never an assignment row (plan §1).
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(exceptions) e
         WHERE NULLIF(e.value->>'practice_slot_id', '') IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.practice_slots ps
                            WHERE ps.id = (e.value->>'practice_slot_id')::uuid
                              AND ps.organization_id = v_org_id)
    ) THEN
        RAISE EXCEPTION 'an exception names a practice slot outside organization %', v_org_id
            USING ERRCODE = '42501';
    END IF;
    WITH ins AS (
        INSERT INTO public.practice_exceptions (
            organization_id, season_settings_id, team_id, assignment_id, "window",
            kind, practice_slot_id, tbd_reason, cause_kind, cause_id, run_id, created_by
        )
        SELECT v_org_id, v_season_id, pa.team_id, pa.id,
               NULLIF(e.value->>'window', '')::daterange,
               e.value->>'kind',
               NULLIF(e.value->>'practice_slot_id', '')::uuid,
               NULLIF(e.value->>'tbd_reason', ''),
               NULLIF(e.value->>'cause_kind', ''),
               NULLIF(e.value->>'cause_id', '')::uuid,
               v_run_id,
               v_created_by
          FROM jsonb_array_elements(exceptions) e
          JOIN public.practice_assignments pa
            ON pa.id = COALESCE(
                   (e.value->>'assignment_id')::uuid,
                   -- 8.9 PR 6b: a row this save placed, found by the unique
                   -- (team, slot, range) key it was just inserted under.
                   (SELECT r.id
                      FROM public.practice_assignments r
                     WHERE r.organization_id = v_org_id
                       AND r.team_id = (e.value#>>'{new_assignment,team_id}')::uuid
                       AND r.practice_slot_id = (e.value#>>'{new_assignment,practice_slot_id}')::uuid
                       AND r.effective_date_range = (e.value#>>'{new_assignment,effective_date_range}')::daterange))
        RETURNING *
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ins.*) ORDER BY ins.id), '[]'::jsonb)
      INTO v_recorded
      FROM ins;
    -- 8.9 PR 6b: the join above drops an entry that resolves to no row, so
    -- every entry handed in must come out recorded -- never one lost quietly.
    IF jsonb_array_length(v_recorded) <> jsonb_array_length(exceptions) THEN
        RAISE EXCEPTION 'recorded % of % exceptions: an entry resolved to no assignment row', jsonb_array_length(v_recorded), jsonb_array_length(exceptions)
            USING ERRCODE = '23503';
    END IF;
    -- 8.9 plan D13 (c): a daylight TIME TBD window must be a TAIL window --
    -- reaching the end of its series' range, or lying after it. Readers do
    -- not apply exceptions until 3b PR 12, so a mid-range one would still be
    -- shown as a practice. Refused here (the whole save rolls back), not
    -- only noted for the 3b PR 9 adapter.
    SELECT (r.value->>'assignment_id')::uuid
      INTO v_bad_id
      FROM jsonb_array_elements(v_recorded) r
      JOIN public.practice_assignments pa ON pa.id = (r.value->>'assignment_id')::uuid
     WHERE r.value->>'tbd_reason' IN ('past-sunset', 'sunset-unknown')
       AND NOT (upper_inf((r.value->>'window')::daterange)
                OR (NOT upper_inf(pa.effective_date_range)
                    AND upper((r.value->>'window')::daterange) >= upper(pa.effective_date_range)))
     LIMIT 1;
    IF v_bad_id IS NOT NULL THEN
        RAISE EXCEPTION 'a daylight TIME TBD window on assignment % ends before its series does: mid-range windows are refused until readers apply exceptions (3b PR 12)', v_bad_id
            USING ERRCODE = '22023';
    END IF;

    -- #64: every team of the season left with NO practice by this save --
    -- unplaced by the solver, absent from the payload, stripped of its auto
    -- row, or never scheduled at all. Enumerated from the season's ROSTER, not
    -- from the payload or the superseded list: a team either of those lost
    -- track of must still be named here, which is the point of the list.
    SELECT count(*),
           COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'team_id', t.id,
                       'team_name', t.name,
                       'had_prior_rows', t.id = ANY (v_teams_with_prior)
                   )
                   ORDER BY t.name, t.id
               ) FILTER (
                   WHERE NOT EXISTS (
                       SELECT 1 FROM public.practice_assignments pa WHERE pa.team_id = t.id
                   )
                   -- A division that gives no practice (0 a week) leaves its teams with none on
                   -- purpose: that is not a team the save left without one.
                   AND d.practices_per_week > 0
               ),
               '[]'::jsonb
           )
      INTO v_season_team_count, v_without_practice
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- v3: every roster team holding a live TIME TBD window after this save,
    -- enumerated from the season's ROSTER for the same reason as above.
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'team_id', t.id,
                       'team_name', t.name,
                       'exception_id', pe.id,
                       'assignment_id', pe.assignment_id,
                       'window', pe."window"::text,
                       'tbd_reason', pe.tbd_reason
                   )
                   ORDER BY t.name, t.id, lower(pe."window")
               ),
               '[]'::jsonb
           )
      INTO v_time_tbd
      FROM public.teams t
      JOIN public.divisions d ON d.id = t.division_id
      JOIN public.practice_exceptions pe
        ON pe.team_id = t.id
       AND pe.kind = 'time_tbd'
       AND pe.withdrawn_at IS NULL
     WHERE t.organization_id = v_org_id
       AND d.organization_id = v_org_id
       AND d.season_settings_id = v_season_id;

    -- 20261108020000: THE TIME TBD LIST (Phase D, E). Every practice a team is still short of is
    -- recorded in `schedule_tbd`, so the master export can print it as a TIME TBD row and no
    -- missing practice is a silence. The subject set is the season's ROSTER and each division's
    -- practices a week -- never the payload and never the solver's output (a team either of those
    -- lost track of must still be listed, which is the point): for every team of the season whose
    -- division wants N and which holds r live rows (a range that has not ended, from today on),
    -- N > r gives one row with missing_count N - r. A division at 0 a week lists nothing. The
    -- reason is the one this save's run gives the team in `results.unassigned` (the auto-scheduler's
    -- own, one of the closed list), else `not-scheduled-yet`; it labels the row and decides
    -- nothing. The whole list is rebuilt from the table as this save leaves it, under the season
    -- lock, so it cannot go stale across saves. Done by a definer helper: no client can write the
    -- table, and this writer is SECURITY INVOKER.
    PERFORM public.sync_schedule_tbd_practices(
        v_org_id, v_season_id, v_persisted_run_id,
        CASE WHEN jsonb_typeof(run_data->'results'->'unassigned') = 'array'
             THEN run_data->'results'->'unassigned' ELSE '[]'::jsonb END);

    -- The run carries its own before-images, so what it superseded, unlocked,
    -- closed and withdrew can be read back whether or not the audit rows exist.
    UPDATE public.scheduler_runs
       SET results = COALESCE(results, '{}'::jsonb) || jsonb_build_object(
               'superseded_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'superseded_rows') = 'array'
                        THEN v_prior_results->'superseded_rows' ELSE '[]'::jsonb END || v_removed,
               'retained_manual', v_retained,
               'unlocked_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'unlocked_rows') = 'array'
                        THEN v_prior_results->'unlocked_rows' ELSE '[]'::jsonb END || v_unlocked,
               'closed_rows',
                   CASE WHEN jsonb_typeof(v_prior_results->'closed_rows') = 'array'
                        THEN v_prior_results->'closed_rows' ELSE '[]'::jsonb END || v_closed,
               'superseded_exceptions',
                   CASE WHEN jsonb_typeof(v_prior_results->'superseded_exceptions') = 'array'
                        THEN v_prior_results->'superseded_exceptions' ELSE '[]'::jsonb END || v_superseded_exceptions
           )
     WHERE id = v_run_id
       AND organization_id = v_org_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
        RAISE EXCEPTION 'scheduler run % could not record what it superseded', v_run_id
            USING ERRCODE = '42501';
    END IF;

    -- Audit: one row per superseded assignment, with the full row, and one per
    -- run. `record_audit_event` writes `auth.uid()` into the NOT NULL
    -- `audit_log.user_id`, so a caller with no uid -- a service-role caller;
    -- `practice-persistence` calls as the user -- cannot be audited here:
    -- calling it would fail the save with 23502 (the defect 20260726000200
    -- records as KNOWN PRE-EXISTING). That caller is told so in the result
    -- rather than the audit being skipped in silence, and its before-images
    -- are on the run. (v3: such a caller cannot unlock, so it can supersede
    -- nothing; what it can still do unaudited is ADD rows and exceptions.)
    IF auth.uid() IS NOT NULL THEN
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_removed) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.superseded',
                'practice_assignment',
                (v_row->>'id')::uuid,
                jsonb_build_object(
                    'run_id', v_run_id,
                    'season_settings_id', v_season_id,
                    'reason', v_row->>'superseded_reason',
                    'row', v_row - 'superseded_reason'
                )
            );
        END LOOP;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.exception_withdrawn',
                'practice_exception',
                (v_row->>'id')::uuid,
                jsonb_build_object('run_id', v_run_id, 'reason', 'withdrawn_by_save', 'row', v_row)
            );
        END LOOP;
        FOR v_row IN SELECT value FROM jsonb_array_elements(v_recorded) LOOP
            PERFORM public.record_audit_event(
                v_org_id,
                'practice.exception_recorded',
                'practice_exception',
                (v_row->>'id')::uuid,
                jsonb_build_object('run_id', v_run_id, 'row', v_row)
            );
        END LOOP;
        PERFORM public.record_audit_event(
            v_org_id,
            'practice.saved',
            'scheduler_run',
            v_run_id,
            jsonb_build_object(
                'season_settings_id', v_season_id,
                'assignment_count', jsonb_array_length(assignments),
                'superseded_count', jsonb_array_length(v_removed),
                'retained_manual_count', jsonb_array_length(v_retained),
                'allow_empty', COALESCE(allow_empty, false),
                'unlocked_count', jsonb_array_length(v_unlocked),
                'closed_count', jsonb_array_length(v_closed),
                'exceptions_recorded', jsonb_array_length(v_recorded),
                'exceptions_withdrawn', jsonb_array_length(v_withdrawn),
                'base_fingerprint', base_fingerprint
            )
        );
        v_audited := true;
    END IF;

    RETURN jsonb_build_object(
        'run_id', v_run_id,
        'superseded', v_removed,
        'superseded_count', jsonb_array_length(v_removed),
        'retained_manual', v_retained,
        'retained_manual_count', jsonb_array_length(v_retained),
        'teams_without_practice', v_without_practice,
        'season_team_count', v_season_team_count,
        'teams_time_tbd', v_time_tbd,
        'unlocked', v_unlocked,
        'closed', v_closed,
        'exceptions_recorded', v_recorded,
        'exceptions_withdrawn', v_withdrawn,
        'fingerprint', public.practice_schedule_fingerprint(v_season_id),
        'audited', v_audited,
        'audit_gap', CASE WHEN v_audited THEN NULL ELSE
            'no auth.uid(): record_audit_event cannot attribute this save; the superseded rows are recorded on scheduler_runs.results instead'
        END
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. The game writer records the run's unscheduled games.
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

    WITH parsed_assignments AS MATERIALIZED (
        SELECT
            assignment_items.ordinality AS assignment_ordinal,
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
    ),
    deduped_assignment_rows AS (
        SELECT DISTINCT ON (home_team_id, away_team_id, game_slot_id, week_index)
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
            assignment_source
        FROM assignment_rows
        ORDER BY
            home_team_id,
            away_team_id,
            game_slot_id,
            week_index,
            assignment_ordinal DESC
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
        assignment_source
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
        assignment_source
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

REVOKE ALL ON FUNCTION public.persist_game_schedule(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_game_schedule(jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.persist_game_schedule(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.persist_game_schedule(jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. admin_delete_team counts the TIME TBD rows its cascade takes.
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
              WHERE team_id = p_team_id OR home_team_id = p_team_id OR away_team_id = p_team_id)
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
-- 7. The end state.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_n integer;
BEGIN
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.persist_practice_schedule(jsonb, jsonb, boolean, jsonb, jsonb, jsonb, jsonb, text)')
       AND p.prosrc LIKE '%sync_schedule_tbd_practices%'
       AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC'];
    IF v_n <> 1 THEN RAISE EXCEPTION 'persist_practice_schedule does not write the list'; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.sync_schedule_tbd_practices(uuid, uuid, uuid, jsonb)')
       AND p.prosrc LIKE '%public.schedule_tbd%' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'sync_schedule_tbd_practices is not a definer for authenticated and not anon'; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.refresh_schedule_tbd_practices(uuid)')
       AND p.prosecdef AND p.prosrc LIKE '%schedule_tbd.refreshed%'
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'refresh_schedule_tbd_practices is not a definer for authenticated and not anon'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'schedule_tbd.refreshed') THEN
        RAISE EXCEPTION 'the audit action schedule_tbd.refreshed is not registered';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.schedule_tbd'::regclass
                    AND tgname = 'schedule_tbd_enforce_tenancy' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'schedule_tbd has no tenancy trigger';
    END IF;
    IF has_table_privilege('authenticated', 'public.schedule_tbd', 'INSERT')
       OR has_table_privilege('authenticated', 'public.schedule_tbd', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.schedule_tbd', 'DELETE') THEN
        RAISE EXCEPTION 'a client can write schedule_tbd';
    END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.persist_game_schedule(jsonb, jsonb)')
       AND p.prosrc LIKE '%public.schedule_tbd%'
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC'];
    IF v_n <> 1 THEN RAISE EXCEPTION 'persist_game_schedule does not write the list'; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.get_schedule_tbd(uuid)')
       AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 1 THEN RAISE EXCEPTION 'get_schedule_tbd is not a definer for authenticated and not anon'; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.admin_delete_team(uuid)')
       AND p.prosrc LIKE '%schedule_tbd_deleted%'
       AND p.prosecdef;
    IF v_n <> 1 THEN RAISE EXCEPTION 'admin_delete_team does not count the TIME TBD rows its cascade takes'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.schedule_tbd'::regclass AND relrowsecurity) THEN
        RAISE EXCEPTION 'schedule_tbd has no row level security';
    END IF;
    RAISE NOTICE 'schedule_tbd, its tenancy trigger, get_schedule_tbd, the practice sync and both writers are in place';
END;
$$;

COMMIT;
