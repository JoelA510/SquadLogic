-- Revert for 20261018040000_reconcile_trigger_drift.sql
--
-- **Restores production as it was before the migration, not a fresh build.**
-- Every object below is production's own definition, read back read-only on
-- 2026-10-18 (Supabase MCP `execute_sql`: `pg_get_triggerdef`,
-- `pg_get_functiondef`, `proacl`, `md5(prosrc)`), and the block at the end
-- fails the revert unless each restored body's md5 and each ACL equal what
-- production had. So on production the revert puts back exactly what the
-- migration removed, and on a fresh build it produces production's catalogue:
--
--   * `trigger_manage_field_subunits` and `handle_field_subunits()`;
--   * the 15 `set_org_id_*` triggers, `set_scheduler_runs_created_by`, the nine
--     `propagate_org_id_from_*()` functions and `set_created_by_to_auth_uid()`;
--   * `persist_evaluation_run(jsonb, jsonb[], jsonb[])`;
--   * `admin_create_field` and `admin_update_field` as 20260504060000 wrote
--     them (production's bodies are identical to that file's), comments too.
--
-- **Not restored:** `set_updated_at()` and the two `ensure_*()` functions.
-- Production never had them; only a fresh build did, with nothing calling them.
-- The catalogue snapshot (supabase/catalog-snapshot.json) describes the
-- migration's state, so a database this revert ran on differs from it by
-- exactly the objects listed above.
--
-- **What reverting costs.** It puts back the two defects the migration
-- removed, and its NOTICEs say so:
--   * saving a field with halves off deletes its sub-surfaces, every practice
--     slot on them and every assignment on those slots, with no audit row;
--   * `persist_evaluation_run` is ambiguous to PostgREST again (two overloads
--     with the same argument names, PGRST203), and the restored overload checks
--     no organization membership: any authenticated caller can write an
--     evaluation run into any organization through it.
--
-- The sub-surfaces the new RPCs created stay, as does everything else written
-- since: nothing here deletes a row.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The two field RPCs, production's (20260504060000's) bodies
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_field(
    p_organization_id uuid,
    p_location_id uuid,
    p_name text,
    p_surface_type text DEFAULT NULL,
    p_size text DEFAULT NULL,
    p_supports_halves boolean DEFAULT false,
    p_priority_rating integer DEFAULT 1,
    p_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_location_org uuid;
    v_field public.fields%ROWTYPE;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'p_location_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT organization_id
      INTO v_location_org
      FROM public.locations
     WHERE id = p_location_id;

    IF v_location_org IS NULL OR v_location_org <> p_organization_id THEN
        RAISE EXCEPTION 'Access denied: location is outside organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'field name is required'
            USING ERRCODE = '22023';
    END IF;

    IF COALESCE(p_priority_rating, 1) < 1 THEN
        RAISE EXCEPTION 'priority_rating must be at least 1'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.fields (
        organization_id,
        location_id,
        name,
        surface_type,
        size,
        supports_halves,
        priority_rating,
        active
    )
    VALUES (
        p_organization_id,
        p_location_id,
        v_name,
        NULLIF(btrim(COALESCE(p_surface_type, '')), ''),
        NULLIF(btrim(COALESCE(p_size, '')), ''),
        COALESCE(p_supports_halves, false),
        COALESCE(p_priority_rating, 1),
        COALESCE(p_active, true)
    )
    RETURNING * INTO v_field;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_field.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'created',
            'current', to_jsonb(v_field)
        )
    );

    RETURN to_jsonb(v_field);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_field(
    p_organization_id uuid,
    p_field_id uuid,
    p_location_id uuid,
    p_name text,
    p_surface_type text DEFAULT NULL,
    p_size text DEFAULT NULL,
    p_supports_halves boolean DEFAULT false,
    p_priority_rating integer DEFAULT 1,
    p_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_location_org uuid;
    v_existing public.fields%ROWTYPE;
    v_field public.fields%ROWTYPE;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_field_id IS NULL THEN
        RAISE EXCEPTION 'p_field_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id
     FOR UPDATE;

    IF v_existing.id IS NULL THEN
        RAISE EXCEPTION 'field % was not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    IF p_location_id IS NULL THEN
        RAISE EXCEPTION 'p_location_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT organization_id
      INTO v_location_org
      FROM public.locations
     WHERE id = p_location_id;

    IF v_location_org IS NULL OR v_location_org <> p_organization_id THEN
        RAISE EXCEPTION 'Access denied: location is outside organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'field name is required'
            USING ERRCODE = '22023';
    END IF;

    IF COALESCE(p_priority_rating, 1) < 1 THEN
        RAISE EXCEPTION 'priority_rating must be at least 1'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.fields
       SET location_id = p_location_id,
           name = v_name,
           surface_type = NULLIF(btrim(COALESCE(p_surface_type, '')), ''),
           size = NULLIF(btrim(COALESCE(p_size, '')), ''),
           supports_halves = COALESCE(p_supports_halves, false),
           priority_rating = COALESCE(p_priority_rating, 1),
           active = COALESCE(p_active, true),
           updated_at = timezone('utc', now())
     WHERE id = p_field_id
       AND organization_id = p_organization_id
    RETURNING * INTO v_field;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_field.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'updated',
            'previous', to_jsonb(v_existing),
            'current', to_jsonb(v_field)
        )
    );

    RETURN to_jsonb(v_field);
END;
$$;

COMMENT ON FUNCTION public.admin_create_field(uuid, uuid, text, text, text, boolean, integer, boolean) IS
  'Admin-only org-scoped field creation with location scoping checks and settings.updated audit logging.';
COMMENT ON FUNCTION public.admin_update_field(uuid, uuid, uuid, text, text, text, boolean, integer, boolean) IS
  'Admin-only org-scoped field update with location scoping checks and settings.updated audit logging.';

-- ---------------------------------------------------------------------------
-- 2. The sub-surface trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_field_subunits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    if new.supports_halves = true then
        insert into field_subunits (field_id, label)
        values (new.id, 'A'), (new.id, 'B')
        on conflict (field_id, label) do nothing;
    elsif new.supports_halves = false then
        delete from field_subunits where field_id = new.id;
    end if;
    return new;
end;
$function$;

DROP TRIGGER IF EXISTS trigger_manage_field_subunits ON public.fields;
CREATE TRIGGER trigger_manage_field_subunits AFTER INSERT OR UPDATE OF supports_halves ON public.fields
    FOR EACH ROW EXECUTE FUNCTION public.handle_field_subunits();

-- ---------------------------------------------------------------------------
-- 3. The fill-a-null functions and their triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propagate_org_id_from_field()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.field_id is not null then
    select organization_id into new.organization_id
    from fields where id = new.field_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_team()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.team_id is not null then
    select organization_id into new.organization_id
    from teams where id = new.team_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_home_team()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.home_team_id is not null then
    select organization_id into new.organization_id
    from teams where id = new.home_team_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_import_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.import_job_id is not null then
    select organization_id into new.organization_id
    from import_jobs where id = new.import_job_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_player()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.player_id is not null then
    select organization_id into new.organization_id
    from players where id = new.player_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_season_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.season_settings_id is not null then
    select organization_id into new.organization_id
    from season_settings where id = new.season_settings_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_scheduler_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.scheduler_run_id is not null then
    select organization_id into new.organization_id
    from scheduler_runs where id = new.scheduler_run_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_evaluation_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.evaluation_run_id is not null then
    select organization_id into new.organization_id
    from evaluation_runs where id = new.evaluation_run_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.propagate_org_id_from_export_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.organization_id is null and new.export_job_id is not null then
    select organization_id into new.organization_id
    from export_jobs where id = new.export_job_id;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_created_by_to_auth_uid()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$function$;

DROP TRIGGER IF EXISTS set_org_id_field_subunits ON public.field_subunits;
CREATE TRIGGER set_org_id_field_subunits BEFORE INSERT ON public.field_subunits
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_field();
DROP TRIGGER IF EXISTS set_org_id_practice_slots ON public.practice_slots;
CREATE TRIGGER set_org_id_practice_slots BEFORE INSERT ON public.practice_slots
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_field();
DROP TRIGGER IF EXISTS set_org_id_game_slots ON public.game_slots;
CREATE TRIGGER set_org_id_game_slots BEFORE INSERT ON public.game_slots
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_field();
DROP TRIGGER IF EXISTS set_org_id_team_players ON public.team_players;
CREATE TRIGGER set_org_id_team_players BEFORE INSERT ON public.team_players
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_team();
DROP TRIGGER IF EXISTS set_org_id_practice_assignments ON public.practice_assignments;
CREATE TRIGGER set_org_id_practice_assignments BEFORE INSERT ON public.practice_assignments
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_team();
DROP TRIGGER IF EXISTS set_org_id_games ON public.games;
CREATE TRIGGER set_org_id_games BEFORE INSERT ON public.games
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_home_team();
DROP TRIGGER IF EXISTS set_org_id_staging_players ON public.staging_players;
CREATE TRIGGER set_org_id_staging_players BEFORE INSERT ON public.staging_players
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_import_job();
DROP TRIGGER IF EXISTS set_org_id_player_buddies ON public.player_buddies;
CREATE TRIGGER set_org_id_player_buddies BEFORE INSERT ON public.player_buddies
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_player();
DROP TRIGGER IF EXISTS set_org_id_scheduler_runs ON public.scheduler_runs;
CREATE TRIGGER set_org_id_scheduler_runs BEFORE INSERT ON public.scheduler_runs
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_season_settings();
DROP TRIGGER IF EXISTS set_org_id_export_jobs ON public.export_jobs;
CREATE TRIGGER set_org_id_export_jobs BEFORE INSERT ON public.export_jobs
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_season_settings();
DROP TRIGGER IF EXISTS set_org_id_evaluation_runs ON public.evaluation_runs;
CREATE TRIGGER set_org_id_evaluation_runs BEFORE INSERT ON public.evaluation_runs
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_scheduler_run();
DROP TRIGGER IF EXISTS set_org_id_evaluation_findings ON public.evaluation_findings;
CREATE TRIGGER set_org_id_evaluation_findings BEFORE INSERT ON public.evaluation_findings
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_evaluation_run();
DROP TRIGGER IF EXISTS set_org_id_evaluation_metrics ON public.evaluation_metrics;
CREATE TRIGGER set_org_id_evaluation_metrics BEFORE INSERT ON public.evaluation_metrics
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_evaluation_run();
DROP TRIGGER IF EXISTS set_org_id_evaluation_run_events ON public.evaluation_run_events;
CREATE TRIGGER set_org_id_evaluation_run_events BEFORE INSERT ON public.evaluation_run_events
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_evaluation_run();
DROP TRIGGER IF EXISTS set_org_id_email_log ON public.email_log;
CREATE TRIGGER set_org_id_email_log BEFORE INSERT ON public.email_log
    FOR EACH ROW EXECUTE FUNCTION public.propagate_org_id_from_export_job();
DROP TRIGGER IF EXISTS set_scheduler_runs_created_by ON public.scheduler_runs;
CREATE TRIGGER set_scheduler_runs_created_by BEFORE INSERT ON public.scheduler_runs
    FOR EACH ROW EXECUTE FUNCTION public.set_created_by_to_auth_uid();

-- ---------------------------------------------------------------------------
-- 4. The second persist_evaluation_run overload
-- ---------------------------------------------------------------------------
-- Production's body has one trailing space (after the `SELECT` on its own
-- line). A committed file keeps no trailing whitespace (`git diff --check`), so
-- the body is written with the marker `<trailing space>` there and created
-- through EXECUTE with the marker replaced; the md5 check below proves the
-- result is byte for byte production's.
DO $overload$
DECLARE
    v_body text := $body$
DECLARE
  v_run_id UUID;
  v_finding JSONB;
  v_metric JSONB;
BEGIN
  -- 1. Insert Run
  INSERT INTO evaluation_runs (
    organization_id,
    scheduler_run_id,
    scheduler_run_type,
    season_settings_id,
    status,
    findings_severity,
    metrics_summary,
    input_snapshot,
    created_by,
    started_at,
    completed_at
  )
  SELECT<trailing space>
    (p_run_data->>'organization_id')::UUID,
    (p_run_data->>'scheduler_run_id')::UUID,
    p_run_data->>'scheduler_run_type',
    (p_run_data->>'season_settings_id')::UUID,
    p_run_data->>'status',
    p_run_data->>'findings_severity',
    p_run_data->'metrics_summary',
    p_run_data->'input_snapshot',
    (p_run_data->>'created_by')::UUID,
    (p_run_data->>'started_at')::TIMESTAMPTZ,
    (p_run_data->>'completed_at')::TIMESTAMPTZ
  RETURNING id INTO v_run_id;

  -- 2. Insert Findings
  IF p_findings IS NOT NULL AND array_length(p_findings, 1) > 0 THEN
    FOREACH v_finding IN ARRAY p_findings LOOP
      INSERT INTO evaluation_findings (
        organization_id,
        evaluation_run_id,
        severity,
        finding_code,
        description,
        affected_entities
      ) VALUES (
        (p_run_data->>'organization_id')::UUID,
        v_run_id,
        v_finding->>'severity',
        v_finding->>'finding_code',
        v_finding->>'description',
        v_finding->'affected_entities'
      );
    END LOOP;
  END IF;

  -- 3. Insert Metrics
  IF p_metrics IS NOT NULL AND array_length(p_metrics, 1) > 0 THEN
    FOREACH v_metric IN ARRAY p_metrics LOOP
      INSERT INTO evaluation_metrics (
        organization_id,
        evaluation_run_id,
        metric_key,
        metric_value,
        thresholds
      ) VALUES (
        (p_run_data->>'organization_id')::UUID,
        v_run_id,
        v_metric->>'metric_key',
        (v_metric->>'metric_value')::NUMERIC,
        v_metric->'thresholds'
      );
    END LOOP;
  END IF;

  RETURN v_run_id;
END;
$body$;
BEGIN
    EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.persist_evaluation_run('
        'p_run_data jsonb, p_findings jsonb[], p_metrics jsonb[] DEFAULT %L::jsonb[]) '
        'RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO %L AS %L',
        '{}', 'public', replace(v_body, '<trailing space>', ' '));
END
$overload$;

-- ---------------------------------------------------------------------------
-- 5. Production's privileges, exactly (20260614000000's default privileges
--    would otherwise give every new function to authenticated)
-- ---------------------------------------------------------------------------
DO $acl$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.handle_field_subunits()',
        'public.propagate_org_id_from_field()',
        'public.propagate_org_id_from_team()',
        'public.propagate_org_id_from_home_team()',
        'public.propagate_org_id_from_import_job()',
        'public.propagate_org_id_from_player()',
        'public.propagate_org_id_from_season_settings()',
        'public.propagate_org_id_from_scheduler_run()',
        'public.propagate_org_id_from_evaluation_run()',
        'public.propagate_org_id_from_export_job()'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END
$acl$;
GRANT EXECUTE ON FUNCTION public.set_created_by_to_auth_uid() TO PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.persist_evaluation_run(jsonb, jsonb[], jsonb[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_evaluation_run(jsonb, jsonb[], jsonb[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Verified against production's read-back, or the revert fails
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
    r record;
    v_got text;
    v_bad text[] := '{}';
    v_n int := 0;
BEGIN
    -- Each restored function: body md5 and ACL, as production had them.
    FOR r IN
        SELECT * FROM (VALUES
            ('handle_field_subunits()', '41a0b2e45ee9c17e693dbbd552bc8c05', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_evaluation_run()', 'e6ab8b4193b5e3c7a0b76480d4020ec3', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_export_job()', 'e53dbd094cd9eb29a161e4f4def32ac7', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_field()', '05a6c11c9b2af6d5beafaa4a7d69e138', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_home_team()', '83d1b0459e4dd97af6e6c1f811ee0af9', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_import_job()', 'e0889be23bf4f9598ebb595404b0c31c', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_player()', 'feb9c311ce61c4b59fca8cd510a66643', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_scheduler_run()', 'c1fec1c8809da941331e0cecaef07b35', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_season_settings()', 'd6cd3cdad7fa19ae86eb03bbdda10384', '{postgres=X/postgres,service_role=X/postgres}'),
            ('propagate_org_id_from_team()', 'f284beacaaa20092946d79fe2fa40b7f', '{postgres=X/postgres,service_role=X/postgres}'),
            ('set_created_by_to_auth_uid()', '4896f19df63081d04f16eeb4e44c3af0', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
            ('persist_evaluation_run(jsonb,jsonb[],jsonb[])', 'db9d7dc037082514aa4865bee26f51f6', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
            ('admin_create_field(uuid,uuid,text,text,text,boolean,integer,boolean)', 'b228a429a16a9b6bf03e2a1ef27bb57a', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
            ('admin_update_field(uuid,uuid,uuid,text,text,text,boolean,integer,boolean)', '3bf1ad2d605c36a14f8be88ba9d5900d', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
        ) AS t(sig, srcmd5, acl)
    LOOP
        v_n := v_n + 1;
        -- The ACL is compared as a set: the order of its entries depends on the
        -- order of the grants that built it, and carries no meaning.
        SELECT md5(p.prosrc) || ' ' || COALESCE(
                   (SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a),
                   '<default>')
          INTO v_got
          FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.' || r.sig);
        IF v_got IS DISTINCT FROM r.srcmd5 || ' '
               || (SELECT string_agg(a, ',' ORDER BY a) FROM unnest(r.acl::text[]) a) THEN
            v_bad := v_bad || format('%s: got %s, production had %s %s', r.sig, COALESCE(v_got, 'MISSING'), r.srcmd5, r.acl);
        END IF;
    END LOOP;

    -- Each restored trigger, as pg_get_triggerdef printed it in production.
    FOR r IN
        SELECT * FROM (VALUES
            ('CREATE TRIGGER set_org_id_email_log BEFORE INSERT ON public.email_log FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_export_job()'),
            ('CREATE TRIGGER set_org_id_evaluation_findings BEFORE INSERT ON public.evaluation_findings FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_evaluation_run()'),
            ('CREATE TRIGGER set_org_id_evaluation_metrics BEFORE INSERT ON public.evaluation_metrics FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_evaluation_run()'),
            ('CREATE TRIGGER set_org_id_evaluation_run_events BEFORE INSERT ON public.evaluation_run_events FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_evaluation_run()'),
            ('CREATE TRIGGER set_org_id_evaluation_runs BEFORE INSERT ON public.evaluation_runs FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_scheduler_run()'),
            ('CREATE TRIGGER set_org_id_export_jobs BEFORE INSERT ON public.export_jobs FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_season_settings()'),
            ('CREATE TRIGGER set_org_id_field_subunits BEFORE INSERT ON public.field_subunits FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_field()'),
            ('CREATE TRIGGER trigger_manage_field_subunits AFTER INSERT OR UPDATE OF supports_halves ON public.fields FOR EACH ROW EXECUTE FUNCTION handle_field_subunits()'),
            ('CREATE TRIGGER set_org_id_game_slots BEFORE INSERT ON public.game_slots FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_field()'),
            ('CREATE TRIGGER set_org_id_games BEFORE INSERT ON public.games FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_home_team()'),
            ('CREATE TRIGGER set_org_id_player_buddies BEFORE INSERT ON public.player_buddies FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_player()'),
            ('CREATE TRIGGER set_org_id_practice_assignments BEFORE INSERT ON public.practice_assignments FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_team()'),
            ('CREATE TRIGGER set_org_id_practice_slots BEFORE INSERT ON public.practice_slots FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_field()'),
            ('CREATE TRIGGER set_org_id_scheduler_runs BEFORE INSERT ON public.scheduler_runs FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_season_settings()'),
            ('CREATE TRIGGER set_scheduler_runs_created_by BEFORE INSERT ON public.scheduler_runs FOR EACH ROW EXECUTE FUNCTION set_created_by_to_auth_uid()'),
            ('CREATE TRIGGER set_org_id_staging_players BEFORE INSERT ON public.staging_players FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_import_job()'),
            ('CREATE TRIGGER set_org_id_team_players BEFORE INSERT ON public.team_players FOR EACH ROW EXECUTE FUNCTION propagate_org_id_from_team()')
        ) AS t(def)
    LOOP
        v_n := v_n + 1;
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'O'
               AND pg_get_triggerdef(t.oid) = r.def
        ) THEN
            v_bad := v_bad || format('trigger missing or different: %s', r.def);
        END IF;
    END LOOP;

    IF v_n <> 31 THEN
        RAISE EXCEPTION 'revert verification examined % objects, expected 31 (14 functions, 17 triggers)', v_n;
    END IF;
    IF cardinality(v_bad) > 0 THEN
        RAISE EXCEPTION 'revert does not reproduce production: %', array_to_string(v_bad, '; ');
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'persist_evaluation_run') <> 2 THEN
        RAISE EXCEPTION 'expected production''s two persist_evaluation_run overloads after the revert';
    END IF;

    RAISE NOTICE 'revert verified: 14 functions (body md5 and ACL) and 17 triggers equal production''s 2026-10-18 read-back';
    RAISE WARNING 'RESTORED trigger_manage_field_subunits: saving a field with halves off deletes its sub-surfaces, their practice slots and those slots'' assignments again, with no audit row';
    RAISE WARNING 'RESTORED persist_evaluation_run(jsonb, jsonb[], jsonb[]): the RPC is ambiguous to PostgREST again (PGRST203), and this overload checks no organization membership';
END
$verify$;

COMMIT;
