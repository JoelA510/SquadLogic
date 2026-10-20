-- Revert for 20261020010000_evaluation_run_idempotency.sql
--
-- Restores `persist_evaluation_run(jsonb, jsonb, jsonb)` as production ran it
-- before the change: the 20260407000000 body with its comment lines removed
-- (production's prosrc, read back 2026-10-20, md5 9184eba3248acce85fa1ccdd64ccddde),
-- SECURITY DEFINER with search_path=public. Then it drops the idempotency index
-- and column. Nothing else changed: the signature, the grants and the comment
-- were never touched.
--
-- What it loses: the keys on runs written since the change. The runs, their
-- findings and their metrics stay. A retried Edge call after the revert can
-- write a second run again, as it could before.
--
-- Verified: the harness compares the restored body's md5 with the one above,
-- checks the posture, and checks the index and column are gone.

BEGIN;

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
    updated_at
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
    NOW()
  ) RETURNING id INTO v_run_id;

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

DROP INDEX IF EXISTS public.evaluation_runs_org_idempotency_key_idx;

ALTER TABLE public.evaluation_runs DROP COLUMN IF EXISTS idempotency_key;

COMMIT;
