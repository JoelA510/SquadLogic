-- Smoke test for 20260611000400_players_team_id_sync.sql
-- Run in a transaction against a seeded database; rolls back at the end.
--
-- **ON_ERROR_STOP, or the RAISEs below cannot fail.** psql exits 0 after a
-- statement error unless it is set, so a DO block that raises prints red and
-- returns green -- a file that looks like a gate and reports success. This one
-- is not in `run.sh`'s NEW_MIGRATIONS, so its only caller is a person running
-- psql by hand, which is exactly the caller that would have been fooled. Same
-- defect and same fix as `docs/sql/20260602000000_smoke.sql`, found by
-- grepping every smoke for RAISE without the flag rather than by memory.
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
    v_org uuid;
    v_division uuid;
    v_team uuid;
    v_team2 uuid;
    v_player uuid;
    v_check uuid;
BEGIN
    SELECT id INTO v_org FROM public.organizations LIMIT 1;
    SELECT id INTO v_division FROM public.divisions WHERE organization_id = v_org LIMIT 1;

    INSERT INTO public.teams (organization_id, division_id, name)
    VALUES (v_org, v_division, 'Smoke Sync A') RETURNING id INTO v_team;
    INSERT INTO public.teams (organization_id, division_id, name)
    VALUES (v_org, v_division, 'Smoke Sync B') RETURNING id INTO v_team2;
    INSERT INTO public.players (organization_id, division_id, first_name, last_name)
    VALUES (v_org, v_division, 'Smoke', 'Sync') RETURNING id INTO v_player;

    -- INSERT into team_players must set players.team_id.
    INSERT INTO public.team_players (team_id, player_id, organization_id)
    VALUES (v_team, v_player, v_org);
    SELECT team_id INTO v_check FROM public.players WHERE id = v_player;
    IF v_check IS DISTINCT FROM v_team THEN
        RAISE EXCEPTION 'insert sync failed: expected %, got %', v_team, v_check;
    END IF;

    -- UPDATE moving the roster row must follow.
    UPDATE public.team_players SET team_id = v_team2
    WHERE team_id = v_team AND player_id = v_player;
    SELECT team_id INTO v_check FROM public.players WHERE id = v_player;
    IF v_check IS DISTINCT FROM v_team2 THEN
        RAISE EXCEPTION 'update sync failed: expected %, got %', v_team2, v_check;
    END IF;

    -- DELETE must clear the pointer.
    DELETE FROM public.team_players WHERE team_id = v_team2 AND player_id = v_player;
    SELECT team_id INTO v_check FROM public.players WHERE id = v_player;
    IF v_check IS NOT NULL THEN
        RAISE EXCEPTION 'delete sync failed: expected NULL, got %', v_check;
    END IF;

    RAISE NOTICE 'players_team_id_sync smoke: OK';
END $$;

ROLLBACK;
