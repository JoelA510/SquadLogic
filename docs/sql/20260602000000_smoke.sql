-- Smoke checks for 20260602000000_field_availability_finalize_applied_payload_fix.sql

-- 1. Function still exists, is SECURITY DEFINER, and pins search_path.
select 'finalize_field_availability_import_job defined' as check,
       p.prosecdef as security_definer,
       array_to_string(p.proconfig, ',') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'finalize_field_availability_import_job';

-- 2. The fix is present: the body no longer inserts an explicit NULL into
--    applied_payload (the buggy rows ended ',NULL,v_now,auth.uid())'; fixed
--    rows end ',''{}''::jsonb,v_now,auth.uid())'). Expect ok = true.
select 'applied_payload null literal removed' as check,
       (position($needle$,NULL,v_now,auth.uid())$needle$ in p.prosrc) = 0) as ok
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'finalize_field_availability_import_job';

-- 3. The constraint the fix satisfies (rather than relaxes) is intact:
--    import_application_records.applied_payload stays NOT NULL DEFAULT '{}'.
select 'applied_payload not null default' as check, a.attnotnull as not_null,
       pg_get_expr(d.adbin, d.adrelid) as default_expr
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and c.relname = 'import_application_records' and a.attname = 'applied_payload';

-- ---------------------------------------------------------------------------
-- The same three checks, as ASSERTIONS
-- ---------------------------------------------------------------------------
--
-- **Everything above is a bare SELECT, so this file exits 0 whatever the
-- database holds.** It printed three reassuring rows against a body that had
-- also, all along, been resolving the field with no NOT FOUND guard -- the
-- defect fixed by 20260908000000. A smoke that cannot go red is not a check,
-- and leaving one beside a real one invites the next reader to trust it.
--
-- The SELECTs are kept: they are the evidence half, and a reader running this
-- by hand wants to see the values. What follows is the gate half. The same
-- applied_payload invariant is also asserted in
-- `docs/sql/20260908000000_smoke.sql`, which the local harness DOES run --
-- this file is not in `run.sh`'s NEW_MIGRATIONS, so on its own it would still
-- be a check nothing executes.
DO $$
DECLARE r record;
BEGIN
  SELECT p.prosecdef,
         COALESCE(array_to_string(p.proconfig, ','), '') AS cfg,
         p.prosrc AS src
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finalize_field_availability_import_job';
  IF NOT FOUND THEN RAISE EXCEPTION 'finalize_field_availability_import_job missing'; END IF;
  IF NOT r.prosecdef THEN RAISE EXCEPTION 'finalize_field_availability_import_job is not SECURITY DEFINER'; END IF;
  IF r.cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'finalize_field_availability_import_job does not pin search_path'; END IF;
  IF position($needle$,NULL,v_now,auth.uid())$needle$ in r.src) <> 0 THEN
    RAISE EXCEPTION 'the applied_payload NULL literal is back; finalizing a job with child rows will abort on the NOT NULL'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname='import_application_records'
       AND a.attname='applied_payload' AND a.attnotnull)
  THEN
    RAISE EXCEPTION 'import_application_records.applied_payload is no longer NOT NULL; this fix satisfied that constraint rather than relaxing it';
  END IF;
  RAISE NOTICE 'applied_payload: no NULL literal in the body, and the column is still NOT NULL';
END $$;
