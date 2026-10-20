-- An idempotency key for `persist_evaluation_run` (owner request 2026-10-20; plan
-- docs/changes/2026-10-20-evaluation-run-idempotency.md).
--
-- **Why.** auto-scheduler and fairness-scoring write one evaluation run per
-- request through this RPC. A transport failure or a gateway 502/503/504 after
-- PostgREST received the call leaves the Edge Function unable to tell whether
-- the run committed, so it could not retry without risking a second run (and a
-- second copy of every finding and metric) for the same request. Since #621 the
-- Edge Functions fail the request instead; this lets them retry it safely.
--
-- **The change.**
--   * `evaluation_runs.idempotency_key uuid NULL`, unique per organization where
--     set (`evaluation_runs_org_idempotency_key_idx`, partial). The table has no
--     other unique key but its primary key (read 2026-10-20).
--   * The function is replaced wholesale from its latest revision
--     (20260407000000; production's body is that text minus its comment lines,
--     read back 2026-10-20, with search_path=public set by 20260421001209). It
--     reads `p_run_data->>'idempotency_key'` and inserts the run with
--     ON CONFLICT DO NOTHING. A replay (the key's run already committed) returns
--     that run's id and writes no findings or metrics, so the first call's are
--     the only ones. A concurrent replay waits for the first call's transaction
--     on the unique index, then takes the same path. With no key the behaviour
--     is exactly today's. The membership check still runs first, so a replay
--     by someone outside the organization is refused before any lookup.
--   * Signature, RETURNS, SECURITY DEFINER, search_path, grants and comment are
--     unchanged (CREATE OR REPLACE keeps the grants and comment).
--
-- **Not covered.** A replay with the same key and a different payload returns
-- the first run's id and ignores the new payload: the key names one request,
-- and the Edge helper (_shared/evaluation-run.ts) sends the same payload on its
-- one retry. The table is pruned by `prune_old_evaluation_runs`; a replay after
-- the first run was pruned writes a new run, which is the right outcome.
--
-- Reversible: see docs/sql/20261020010000_revert.sql.
-- Smoke checks: see docs/sql/20261020010000_smoke.sql.

BEGIN;

ALTER TABLE public.evaluation_runs
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

COMMENT ON COLUMN public.evaluation_runs.idempotency_key IS
  'One per Edge request; a retried persist_evaluation_run with the same key returns the first run.';

CREATE UNIQUE INDEX IF NOT EXISTS evaluation_runs_org_idempotency_key_idx
  ON public.evaluation_runs (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.persist_evaluation_run(
  p_run_data JSONB,
  p_findings JSONB DEFAULT '[]'::jsonb,
  p_metrics  JSONB DEFAULT '[]'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run_id        UUID;
  v_org_id        UUID;
  v_key           UUID;
  v_finding       JSONB;
  v_metric        JSONB;
BEGIN
  v_org_id := (p_run_data->>'organization_id')::UUID;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'p_run_data must contain organization_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = v_org_id
      AND profile_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized: User is not a member of organization %', v_org_id;
  END IF;

  -- Read after the membership check, so a caller outside the organization learns nothing.
  v_key := (p_run_data->>'idempotency_key')::UUID;

  INSERT INTO public.evaluation_runs (
    organization_id,
    scheduler_run_id,
    scheduler_run_type,
    season_settings_id,
    status,
    findings_severity,
    metrics_summary,
    input_snapshot,
    execution_time_ms,
    created_by,
    started_at,
    completed_at,
    created_at,
    updated_at,
    idempotency_key
  ) VALUES (
    v_org_id,
    (p_run_data->>'scheduler_run_id')::UUID,
    p_run_data->>'scheduler_run_type',
    (p_run_data->>'season_settings_id')::UUID,
    COALESCE(p_run_data->>'status', 'completed'),
    COALESCE(p_run_data->>'findings_severity', 'none'),
    COALESCE(p_run_data->'metrics_summary', '{}'::jsonb),
    COALESCE(p_run_data->'input_snapshot', '{}'::jsonb),
    (p_run_data->>'execution_time_ms')::INTEGER,
    COALESCE((p_run_data->>'created_by')::UUID, auth.uid()),
    (p_run_data->>'started_at')::TIMESTAMPTZ,
    (p_run_data->>'completed_at')::TIMESTAMPTZ,
    NOW(),
    NOW(),
    v_key
  )
  ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_run_id;

  -- Only a non-null key can conflict. The run it names committed with its own findings and
  -- metrics, so a replay returns that run and writes nothing more.
  IF v_run_id IS NULL THEN
    SELECT id INTO v_run_id
      FROM public.evaluation_runs
     WHERE organization_id = v_org_id
       AND idempotency_key = v_key;
    IF v_run_id IS NULL THEN
      RAISE EXCEPTION 'evaluation run for idempotency key % conflicted but cannot be read', v_key;
    END IF;
    RETURN v_run_id;
  END IF;

  IF p_findings IS NOT NULL AND jsonb_array_length(p_findings) > 0 THEN
    FOR v_finding IN SELECT * FROM jsonb_array_elements(p_findings)
    LOOP
      INSERT INTO public.evaluation_findings (
        organization_id,
        evaluation_run_id,
        severity,
        finding_code,
        description,
        affected_entities
      ) VALUES (
        v_org_id,
        v_run_id,
        COALESCE(v_finding->>'severity', 'warning'),
        COALESCE(v_finding->>'finding_code', 'UNKNOWN'),
        COALESCE(v_finding->>'description', ''),
        COALESCE(v_finding->'affected_entities', '[]'::jsonb)
      );
    END LOOP;
  END IF;

  IF p_metrics IS NOT NULL AND jsonb_array_length(p_metrics) > 0 THEN
    FOR v_metric IN SELECT * FROM jsonb_array_elements(p_metrics)
    LOOP
      INSERT INTO public.evaluation_metrics (
        organization_id,
        evaluation_run_id,
        metric_key,
        metric_value,
        thresholds
      ) VALUES (
        v_org_id,
        v_run_id,
        v_metric->>'metric_key',
        (v_metric->>'metric_value')::NUMERIC,
        COALESCE(v_metric->'thresholds', '{}'::jsonb)
      );
    END LOOP;
  END IF;

  RETURN v_run_id;
END;
$function$;

COMMIT;
