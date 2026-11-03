-- Revert for 20261118010000_drop_players_placement_eligible.sql
--
-- Re-adds `players.placement_eligible` as 20260530000000 defined it (`boolean NOT NULL DEFAULT true`; a constant
-- default, so the table is not rewritten) and restores `demo_fence_player_write()` to the body 20261030010000
-- created (checked by md5 at the end, carriage returns removed): the demo's list of editable columns names it
-- again. Nothing else was changed by the migration, so nothing else is restored.
--
-- **What it cannot restore: data.** Whatever the column held before the forward migration is gone with it, and
-- every player row comes back with the default, `true`. Production held no players when the column was dropped
-- (read 2026-11-03), nothing read or wrote the column, and the forward migration refused to run if a player held
-- `false`. The NOTICE counts the rows that come back `true`.
--
-- **Revert the frontend with it** if you want `canEditPlayerField` to say the column is editable in a demo again
-- (`frontend/src/lib/demo.js`); nothing in the app asks about this column, so the order does not matter.
--
-- Verified: the harness applies this on a database built up to the migration, with players planted, and reads the
-- catalogue afterwards (the column's type, nullability and default, the rows, the body's md5).

BEGIN;

DO $revert$
BEGIN
    RAISE NOTICE 'this revert re-adds players.placement_eligible at its default: % player row(s) come back true; whatever the column held before the forward migration is not restored (production held no players when it was dropped), and nothing reads it',
        (SELECT count(*) FROM public.players);
END;
$revert$;

ALTER TABLE public.players
    ADD COLUMN IF NOT EXISTS placement_eligible boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.demo_fence_player_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- What a demo's players may still change: where they play and how they are rated.
    -- Everything else (names, gender, grade, notes, buddy request, registration id, natural
    -- age, attributes) is read-only, so no visitor can type a child's details into a demo.
    c_allowed constant text[] := ARRAY[
        'team_id', 'division_id', 'status', 'rating', 'years_played', 'jersey_number',
        'willing_to_coach', 'placement_eligible', 'updated_at'
    ];
    v_org uuid := CASE WHEN TG_OP = 'INSERT' THEN NEW.organization_id ELSE OLD.organization_id END;
    v_new uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
BEGIN
    -- A row moved between organizations is judged by both.
    IF NOT EXISTS (SELECT 1 FROM public.organizations o
                    WHERE o.id IN (v_org, v_new) AND o.demo_expires_at IS NOT NULL) THEN
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - c_allowed) IS NOT DISTINCT FROM (to_jsonb(OLD) - c_allowed) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The demo league''s people are read-only (players % refused)', lower(TG_OP)
        USING ERRCODE = '42501', DETAIL = 'demo_read_only';
END;
$$;

DO $revert$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.demo_fence_player_write()');
    IF v_md5 IS DISTINCT FROM 'fb4c627e18ebaf5309750e6a177eac6c' THEN
        RAISE EXCEPTION 'public.demo_fence_player_write was not restored to its 20261030010000 body (md5 %)', v_md5;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.demo_fence_player_write()')
                      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']) THEN
        RAISE EXCEPTION 'the restored fence is not a SECURITY DEFINER function with a pinned search path';
    END IF;
    IF has_function_privilege('anon', 'public.demo_fence_player_write()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.demo_fence_player_write()', 'EXECUTE') THEN
        RAISE EXCEPTION 'the restored fence is executable by a client role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.players'::regclass AND t.tgname = 'demo_fence_players' AND NOT t.tgisinternal
                      AND t.tgfoid = to_regprocedure('public.demo_fence_player_write()') AND t.tgenabled = 'O') THEN
        RAISE EXCEPTION 'the demo_fence_players trigger is not an enabled trigger of public.players calling the fence';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = 'public.players'::regclass AND a.attname = 'placement_eligible' AND NOT a.attisdropped
                      AND format_type(a.atttypid, a.atttypmod) = 'boolean' AND a.attnotnull
                      AND (SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d
                            WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum) = 'true') THEN
        RAISE EXCEPTION 'players.placement_eligible is not back as boolean NOT NULL DEFAULT true';
    END IF;
    RAISE NOTICE 'revert verified: players.placement_eligible is back (boolean NOT NULL DEFAULT true) and the demo fence is the 20261030010000 body';
END;
$revert$;

COMMIT;
