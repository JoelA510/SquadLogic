-- Smoke checks for 20261117010000_players_custom_attributes_gin_index.sql
--
-- Run on the database built to head, inside one transaction that is ROLLED BACK.
--
--   1. The index exists on `public.players` and is the one production holds: `gin`, the default operator
--      class `jsonb_ops`, one key column `custom_attributes` of type jsonb, valid and ready, not unique,
--      not partial, not an expression, no storage parameters.
--   2. It is an index the planner uses for the operators it serves: with sequential scans switched off, a
--      `@>` query and a `?` query on `players.custom_attributes` plan through it, so it is not an index that
--      exists and can never be chosen.
--   3. It is the only GIN index on `players`, and `teams` is not touched by this migration (its sibling,
--      `teams_custom_attributes_gin_idx`, is production drift reported in
--      docs/changes/2026-11-02-data-followups.md and not codified here).
--
-- The migration's refusal of a same-named index of another shape, and its leaving an existing index alone,
-- are applied by scripts/dbharness/run.sh (it re-applies the migration), because a smoke runs after the
-- migration and cannot run it again. There is no data and no PII.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    v_oid     oid := to_regclass('public.players_custom_attributes_gin_idx');
    v_row     record;
    v_plan    text;
    v_line    text;
    v_query   text;
BEGIN
    -- ---- 1. the shape ------------------------------------------------------------------
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'public.players_custom_attributes_gin_idx does not exist';
    END IF;
    SELECT i.indrelid::regclass::text AS tbl, am.amname, opc.opcname, a.attname,
           format_type(a.atttypid, a.atttypmod) AS coltype, i.indnatts, i.indnkeyatts,
           i.indisvalid, i.indisready, i.indisunique, i.indpred IS NOT NULL AS partial,
           i.indexprs IS NOT NULL AS expr, c.reloptions
      INTO v_row
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indexrelid = v_oid;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'players_custom_attributes_gin_idx is not a plain index on a column';
    END IF;
    IF v_row.tbl <> 'players' THEN
        RAISE EXCEPTION 'the index is on % (expected players)', v_row.tbl;
    END IF;
    IF v_row.amname <> 'gin' THEN
        RAISE EXCEPTION 'the index is a % index (expected gin)', v_row.amname;
    END IF;
    IF v_row.opcname <> 'jsonb_ops' THEN
        RAISE EXCEPTION 'the operator class is % (expected jsonb_ops)', v_row.opcname;
    END IF;
    IF v_row.attname <> 'custom_attributes' OR v_row.coltype <> 'jsonb'
       OR v_row.indnatts <> 1 OR v_row.indnkeyatts <> 1 THEN
        RAISE EXCEPTION 'the index is on % (%), % column(s); expected custom_attributes (jsonb) alone',
            v_row.attname, v_row.coltype, v_row.indnatts;
    END IF;
    IF NOT (v_row.indisvalid AND v_row.indisready) THEN
        RAISE EXCEPTION 'the index is not valid and ready';
    END IF;
    IF v_row.indisunique OR v_row.partial OR v_row.expr OR v_row.reloptions IS NOT NULL THEN
        RAISE EXCEPTION 'the index is unique, partial, an expression or has storage parameters (production has none)';
    END IF;
    RAISE NOTICE 'players_custom_attributes_gin_idx is the valid gin / jsonb_ops index on players (custom_attributes) that production holds';

    -- ---- 2. the planner can use it for the operators it serves ----------------------------------
    SET LOCAL enable_seqscan = off;
    FOREACH v_query IN ARRAY ARRAY[
        'SELECT 1 FROM public.players WHERE custom_attributes @> ''{"a": 1}''::jsonb',
        'SELECT 1 FROM public.players WHERE custom_attributes ? ''a'''
    ] LOOP
        v_plan := '';
        FOR v_line IN EXECUTE 'EXPLAIN ' || v_query LOOP
            v_plan := v_plan || v_line || E'\n';
        END LOOP;
        IF position('players_custom_attributes_gin_idx' IN v_plan) = 0 THEN
            RAISE EXCEPTION 'the planner does not use players_custom_attributes_gin_idx for: %
%', v_query, v_plan;
        END IF;
    END LOOP;
    RAISE NOTICE 'a @> query and a ? query on players.custom_attributes both plan through the index';

    -- ---- 3. the only GIN index on players; teams left to the owner's decision -------------------
    IF (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_am am ON am.oid = c.relam
         WHERE i.indrelid = 'public.players'::regclass AND am.amname = 'gin') <> 1 THEN
        RAISE EXCEPTION 'players has a number of GIN indexes other than one';
    END IF;
    RAISE NOTICE 'players has exactly one GIN index';
END;
$$;

ROLLBACK;
