-- Drop the dead column `players.placement_eligible` (owner decision 2026-11-03: "As recommended for the
-- teams.custom_attributes and players.placement_eligible"; plan docs/changes/2026-11-03-drop-placement-eligible.md).
--
-- **Why.** The column was added by 20260530000000 as `boolean NOT NULL DEFAULT true` and nothing has ever read
-- or written it: no RPC, policy, view, trigger, Edge function, core module or page names it, every `INSERT` and
-- `UPDATE` of `players` in a function body lists its columns and leaves it out, and `sanitize_player_patch` does
-- not accept it, so every row holds the default. A column that reads as "may this player be placed" and decides
-- nothing is how an eligibility rule gets typed in and silently ignored (eligibility is derived, from the
-- natural age, by `applyPlayUpEligibility`). Lesson 87 found it; the owner chose to drop it.
--
-- **What production holds** (read-only `SELECT`s, 2026-11-03): the column is `boolean NOT NULL DEFAULT true`,
-- `public.players` has 0 rows, `pg_depend` has one row on the column (its own default), and exactly one function
-- body in the database names it: `public.demo_fence_player_write()`, md5 fb4c627e18ebaf5309750e6a177eac6c.
-- That is the same body a build of the migrations has.
--
-- **The change.**
--   * `demo_fence_player_write()` (20261030010000) lists the columns a demo visitor may still change, and the
--     list names this one. It is replaced wholesale, on its deployed body (md5 guarded, lesson 70), with the one
--     name removed: a name left in the list would keep a column that no longer exists "editable", and would
--     make a later column of the same name editable in a demo without anyone deciding so. `CREATE OR REPLACE`
--     keeps the owner and grants and resets the `SET` clauses, so the pinned search path is stated again.
--   * `players.placement_eligible` is dropped, with no CASCADE.
--
-- **What it refuses, and rolls back whole** (a deploy that fails here changes nothing):
--   * a fence body that is not the deployed one;
--   * a player that holds `false`, the one value nobody gets by default (the count is read under the lock the
--     drop needs and is checked again here, not trusted: 20261001000000 does the same for the coach columns);
--   * a dependent other than the column's own default. A plain DROP COLUMN already refuses a view or a policy,
--     but it removes an index or a constraint on the column without a word, so those are refused too;
--   * at the end, any function in any non-system schema that still names the column (PL/pgSQL is not checked
--     when a column goes: such a function would fail on its first call), or a fence that lost its trigger, its
--     pinned definer posture or any of the other names on its list.
--
-- **Locking.** With the table empty this is a catalogue change. The ACCESS EXCLUSIVE request queues behind any
-- transaction that has touched `players` (a demo start, an import), which is milliseconds to seconds; no
-- migration here sets a lock_timeout, and a deploy that waits can be run again.
--
-- Reversible, with the data caveat that production holds none: docs/sql/20261118010000_revert.sql re-adds the
-- column at its default and restores the deployed fence body. Smoke: docs/sql/20261118010000_smoke.sql.
-- pgTAP: supabase/tests/demo_sessions.sql. The catalogue snapshot does not change (no signature, trigger,
-- policy or view changes).

BEGIN;

-- Held from the checks to the drop, so a value written in between cannot be destroyed after the guard counted
-- none. ACCESS EXCLUSIVE is the mode the drop takes, so there is no lock upgrade to deadlock on.
LOCK TABLE public.players IN ACCESS EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Refusals, before anything is changed.
-- ---------------------------------------------------------------------------

DO $guard$
DECLARE
    v_md5   text;
    v_false integer := 0;
    v_deps  text;
BEGIN
    -- The starting body: the one 20261030010000 created, as deployed. Carriage returns are stripped, as the
    -- neighbouring migrations do: a body stored with CRLF line ends is the same text.
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.demo_fence_player_write()');
    IF v_md5 IS DISTINCT FROM 'fb4c627e18ebaf5309750e6a177eac6c' THEN
        RAISE EXCEPTION 'public.demo_fence_player_write is not the body this migration replaces (md5 %, expected fb4c627e18ebaf5309750e6a177eac6c)', v_md5;
    END IF;

    -- The value. NOT NULL DEFAULT true: `false` is the one value somebody must have chosen.
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = 'public.players'::regclass AND a.attname = 'placement_eligible' AND NOT a.attisdropped) THEN
        EXECUTE 'SELECT count(*) FROM public.players WHERE NOT placement_eligible' INTO v_false;
        IF v_false > 0 THEN
            RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = format('refusing to drop players.placement_eligible: %s player(s) hold false', v_false),
                HINT = 'Nothing reads the column. Set it to true on those players (or decide what it should mean) first.';
        END IF;
    END IF;

    -- Dependents other than the column's own default (a NOT NULL recorded as a constraint, on versions that do,
    -- goes with the column and is not a dependent).
    SELECT string_agg(pg_describe_object(d.classid, d.objid, d.objsubid), '; '
                      ORDER BY pg_describe_object(d.classid, d.objid, d.objsubid))
      INTO v_deps
      FROM pg_depend d
     WHERE d.refclassid = 'pg_class'::regclass
       AND d.refobjid = 'public.players'::regclass
       AND d.refobjsubid = (SELECT a.attnum FROM pg_attribute a
                             WHERE a.attrelid = 'public.players'::regclass AND a.attname = 'placement_eligible' AND NOT a.attisdropped)
       AND d.classid <> 'pg_attrdef'::regclass
       AND NOT (d.classid = 'pg_constraint'::regclass
                AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.oid = d.objid AND c.contype = 'n'));
    IF v_deps IS NOT NULL THEN
        RAISE EXCEPTION 'players.placement_eligible has dependents besides its default, so it is not dropped: %', v_deps
            USING ERRCODE = '2BP01';
    END IF;
END;
$guard$;

-- ---------------------------------------------------------------------------
-- 2. The fence, from the deployed body (20261030010000), without the name.
-- ---------------------------------------------------------------------------

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
        'willing_to_coach', 'updated_at'
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

-- ---------------------------------------------------------------------------
-- 3. The drop. No CASCADE: anything that depends on the column makes this fail and the migration roll back.
-- ---------------------------------------------------------------------------

ALTER TABLE public.players DROP COLUMN IF EXISTS placement_eligible;

-- ---------------------------------------------------------------------------
-- 4. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_names text;
    v_def   text;
    v_name  text;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = 'public.players'::regclass AND a.attname = 'placement_eligible' AND NOT a.attisdropped) THEN
        RAISE EXCEPTION 'players.placement_eligible is still there';
    END IF;

    -- No function names it, in any schema this database keeps its own code in. A body that does would fail on
    -- its first call, not now.
    SELECT string_agg(n.nspname || '.' || p.oid::regprocedure::text, ', ' ORDER BY n.nspname, p.oid::regprocedure::text)
      INTO v_names
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosrc ~* '\mplacement_eligible\M';
    IF v_names IS NOT NULL THEN
        RAISE EXCEPTION 'a function still names the dropped column players.placement_eligible: %', v_names;
    END IF;

    -- The fence: still a pinned definer closed to the client roles, still attached to players and enabled,
    -- and its list still holds every other name it held.
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure('public.demo_fence_player_write()')
                      AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']) THEN
        RAISE EXCEPTION 'public.demo_fence_player_write is not a SECURITY DEFINER function with a pinned search path';
    END IF;
    IF has_function_privilege('anon', 'public.demo_fence_player_write()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.demo_fence_player_write()', 'EXECUTE') THEN
        RAISE EXCEPTION 'public.demo_fence_player_write is executable by a client role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.players'::regclass AND t.tgname = 'demo_fence_players' AND NOT t.tgisinternal
                      AND t.tgfoid = to_regprocedure('public.demo_fence_player_write()') AND t.tgenabled = 'O') THEN
        RAISE EXCEPTION 'the demo_fence_players trigger is not an enabled trigger of public.players calling the fence';
    END IF;
    SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = to_regprocedure('public.demo_fence_player_write()');
    FOREACH v_name IN ARRAY ARRAY['team_id', 'division_id', 'status', 'rating', 'years_played', 'jersey_number',
                                  'willing_to_coach', 'updated_at'] LOOP
        IF position('''' || v_name || '''' IN v_def) = 0 THEN
            RAISE EXCEPTION 'the fence no longer lists %', v_name;
        END IF;
    END LOOP;
END;
$check$;

COMMIT;
