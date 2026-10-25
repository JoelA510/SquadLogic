-- Revert for 20261028010000_coach_view.sql
--
-- Restores every object the migration dropped or replaced, as it stood after
-- 20261026010000: `update_game_score` with the coach arm and no score entry
-- setting (a current coach of either team scores that game; an admin any);
-- `request_practice_lighting_override`, so a coach of a team on the slot
-- requests lighting again; `withdraw_practice_lighting_override` with the
-- requester arm; the comment on `practice_lighting_overrides`; each with its
-- comment, grants and posture. Then the three division reads
-- (`get_my_division_teams`, `admin_get_division_teams` and the internal
-- `division_teams_of`) are dropped.
--
-- The DDL is pg_dump's (16) of a harness build at 20261026010000, so each
-- function body is that build's text byte for byte; only the OWNER lines are
-- left out (the objects are created by the role that runs this). Each
-- function's grants are revoked from every client role before the dump's are
-- restated, so the default privileges cannot widen it.
--
-- **Revert the frontend with it.** The app deployed with 20261028010000
-- calls `get_my_division_teams` and `admin_get_division_teams` on the coach
-- home; with them gone the home says the division's teams could not be read.
-- It deletes no row: scores, lighting rows and the `score_entry` and
-- `standings` keys an organization stored stay (with this revert, nothing
-- reads either key).
--
-- Verified: the harness compares a fingerprint of every restored object
-- (signature, posture, grants, comment and body md5 of the six functions,
-- and the table comment) with the one read off a build at 20261026010000.

BEGIN;

DO $$
DECLARE
    v_on bigint;
BEGIN
    SELECT count(*) INTO v_on FROM public.organizations
     WHERE feature_flags ? 'score_entry' OR feature_flags ? 'standings';
    RAISE NOTICE 'coaches score their own teams'' games and request lighting again; % organization(s) store a score_entry or standings setting, which nothing reads after this revert',
        v_on;
END;
$$;

-- 1. The division reads go.

DROP FUNCTION public.get_my_division_teams(uuid);
DROP FUNCTION public.admin_get_division_teams(uuid, uuid);
DROP FUNCTION public.division_teams_of(uuid, uuid);

-- 2. update_game_score, as at 20261026010000.

CREATE OR REPLACE FUNCTION public.update_game_score(p_organization_id uuid, p_game_id uuid, p_score_home smallint, p_score_away smallint, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
    v_game record;
    v_effective_role text := COALESCE(auth.role(), current_role, '');
    v_member_role text;
    v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_changed boolean;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_game_id IS NULL THEN
        RAISE EXCEPTION 'p_game_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_score_home IS NOT NULL AND p_score_home < 0 THEN
        RAISE EXCEPTION 'p_score_home must be non-negative'
            USING ERRCODE = '23514';
    END IF;

    IF p_score_away IS NOT NULL AND p_score_away < 0 THEN
        RAISE EXCEPTION 'p_score_away must be non-negative'
            USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(v_metadata) <> 'object' THEN
        RAISE EXCEPTION 'p_metadata must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF v_effective_role <> 'service_role' THEN
        IF auth.uid() IS NULL THEN
            RAISE EXCEPTION 'authenticated user is required'
                USING ERRCODE = '42501';
        END IF;

        SELECT om.role
          INTO v_member_role
          FROM public.organization_members om
         WHERE om.organization_id = p_organization_id
           AND om.profile_id = auth.uid();

        IF v_member_role IS NULL THEN
            RAISE EXCEPTION 'Access denied: caller cannot update scores for organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT g.id,
           g.organization_id,
           g.home_team_id,
           g.away_team_id,
           g.score_home,
           g.score_away,
           ht.organization_id AS home_team_org_id,
           at.organization_id AS away_team_org_id
      INTO v_game
      FROM public.games g
      JOIN public.teams ht
        ON ht.id = g.home_team_id
      JOIN public.teams at
        ON at.id = g.away_team_id
     WHERE g.id = p_game_id
       AND g.organization_id = p_organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Game not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_game.home_team_org_id <> p_organization_id
       OR v_game.away_team_org_id <> p_organization_id THEN
        RAISE EXCEPTION 'Game teams must belong to the requested organization'
            USING ERRCODE = '42501';
    END IF;

    -- 20261021020000: an admin or staff member scores any game; anyone else
    -- only a game of a team they currently coach (Phase A3, item 2).
    IF v_effective_role <> 'service_role'
       AND NOT public.is_org_admin(p_organization_id)
       AND NOT public.is_current_team_coach(v_game.home_team_id)
       AND NOT public.is_current_team_coach(v_game.away_team_id) THEN
        RAISE EXCEPTION 'Access denied: only a current coach of either team can score this game'
            USING ERRCODE = '42501';
    END IF;

    v_changed :=
        v_game.score_home IS DISTINCT FROM p_score_home
        OR v_game.score_away IS DISTINCT FROM p_score_away;

    IF v_changed THEN
        UPDATE public.games
           SET score_home = p_score_home,
               score_away = p_score_away,
               updated_at = timezone('utc', now())
         WHERE id = p_game_id
           AND organization_id = p_organization_id;

        PERFORM public.record_audit_event(
            p_organization_id,
            'competition.score_updated',
            'game',
            p_game_id,
            jsonb_build_object(
                'game_id', p_game_id,
                'home_team_id', v_game.home_team_id,
                'away_team_id', v_game.away_team_id,
                'previous_score_home', v_game.score_home,
                'previous_score_away', v_game.score_away,
                'score_home', p_score_home,
                'score_away', p_score_away
            ) || v_metadata
        );
    END IF;

    RETURN jsonb_build_object(
        'game_id', p_game_id,
        'organization_id', p_organization_id,
        'score_home', p_score_home,
        'score_away', p_score_away,
        'previous_score_home', v_game.score_home,
        'previous_score_away', v_game.score_away,
        'changed', v_changed
    );
END;
$$;

COMMENT ON FUNCTION public.update_game_score(p_organization_id uuid, p_game_id uuid, p_score_home smallint, p_score_away smallint, p_metadata jsonb) IS 'Org-scoped game score mutation: admins/staff for any game, a current coach of either team for that game; atomic audit logging. 20261021020000.';

REVOKE ALL ON FUNCTION public.update_game_score(p_organization_id uuid, p_game_id uuid, p_score_home smallint, p_score_away smallint, p_metadata jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.update_game_score(p_organization_id uuid, p_game_id uuid, p_score_home smallint, p_score_away smallint, p_metadata jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.update_game_score(p_organization_id uuid, p_game_id uuid, p_score_home smallint, p_score_away smallint, p_metadata jsonb) TO service_role;

-- 3. The coach lighting request, and withdraw with the requester arm.

CREATE FUNCTION public.request_practice_lighting_override(p_practice_slot_id uuid, p_from date, p_until date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_org uuid;
    v_by_coach boolean;
    v_id uuid;
BEGIN
    IF p_practice_slot_id IS NULL OR p_from IS NULL OR p_until IS NULL THEN
        RAISE EXCEPTION 'p_practice_slot_id, p_from and p_until are required'
            USING ERRCODE = '23502';
    END IF;

    SELECT ps.organization_id INTO v_org FROM public.practice_slots ps WHERE ps.id = p_practice_slot_id;

    -- An unknown slot and a slot the caller does not coach refuse alike, so
    -- the RPC cannot be used to probe which slot ids exist.
    v_by_coach := public.caller_coaches_practice_slot(p_practice_slot_id);
    IF v_uid IS NULL OR v_org IS NULL
       OR NOT ((v_by_coach AND public.is_org_member(v_org)) OR public.is_org_admin(v_org)) THEN
        RAISE EXCEPTION 'Access denied: only a coach of a team on the slot or an admin of its organization requests a lighting override'
            USING ERRCODE = '42501';
    END IF;

    IF p_until < p_from THEN
        RAISE EXCEPTION 'a lighting override''s p_until (%) precedes its p_from (%)', p_until, p_from
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.practice_lighting_overrides
        (organization_id, practice_slot_id, "window", status, requested_by)
    VALUES (v_org, p_practice_slot_id, daterange(p_from, p_until, '[]'), 'requested', v_uid)
    RETURNING id INTO v_id;

    PERFORM public.record_audit_event(
        v_org,
        'practice_lighting_override.requested',
        'practice_lighting_override',
        v_id,
        jsonb_build_object(
            'practice_slot_id', p_practice_slot_id, 'from', p_from, 'until', p_until,
            'kind', 'portable-lighting', 'status', 'requested', 'by_coach', v_by_coach
        )
    );

    RETURN jsonb_build_object(
        'id', v_id, 'organization_id', v_org, 'practice_slot_id', p_practice_slot_id,
        'from', p_from, 'until', p_until, 'kind', 'portable-lighting', 'status', 'requested'
    );
END;
$$;

COMMENT ON FUNCTION public.request_practice_lighting_override(p_practice_slot_id uuid, p_from date, p_until date) IS 'A coach of a team on the slot, or an org admin, requests a portable-lighting window (inclusive dates). Never in force until decided. Audited as practice_lighting_override.requested.';

REVOKE ALL ON FUNCTION public.request_practice_lighting_override(p_practice_slot_id uuid, p_from date, p_until date) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.request_practice_lighting_override(p_practice_slot_id uuid, p_from date, p_until date) TO authenticated;
GRANT ALL ON FUNCTION public.request_practice_lighting_override(p_practice_slot_id uuid, p_from date, p_until date) TO service_role;

CREATE OR REPLACE FUNCTION public.withdraw_practice_lighting_override(p_override_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.practice_lighting_overrides%ROWTYPE;
BEGIN
    IF p_override_id IS NULL THEN
        RAISE EXCEPTION 'p_override_id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_row
      FROM public.practice_lighting_overrides
     WHERE id = p_override_id
       FOR UPDATE;

    -- The requester only while they still coach the slot: a lapsed coach
    -- cannot read the row (the policy), so cannot end it either.
    IF NOT FOUND OR v_uid IS NULL
       OR NOT ((v_uid = v_row.requested_by
                AND public.caller_coaches_practice_slot(v_row.practice_slot_id)
                AND public.is_org_member(v_row.organization_id))
               OR public.is_org_admin(v_row.organization_id)) THEN
        RAISE EXCEPTION 'Access denied: only the requester or an organization admin withdraws a lighting override'
            USING ERRCODE = '42501';
    END IF;
    IF v_row.status NOT IN ('requested', 'approved') THEN
        RAISE EXCEPTION 'lighting override % is already %; only a requested or approved row is withdrawn',
            p_override_id, v_row.status
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.practice_lighting_overrides
       SET status = 'withdrawn', withdrawn_by = v_uid, withdrawn_at = clock_timestamp()
     WHERE id = p_override_id;

    PERFORM public.record_audit_event(
        v_row.organization_id,
        'practice_lighting_override.withdrawn',
        'practice_lighting_override',
        p_override_id,
        jsonb_build_object(
            'practice_slot_id', v_row.practice_slot_id,
            'from', lower(v_row."window"), 'until', upper(v_row."window") - 1,
            'kind', v_row.kind, 'before_status', v_row.status, 'status', 'withdrawn',
            'requested_by', v_row.requested_by, 'by_requester', v_uid = v_row.requested_by
        )
    );

    RETURN jsonb_build_object(
        'id', p_override_id, 'status', 'withdrawn', 'before_status', v_row.status,
        'practice_slot_id', v_row.practice_slot_id
    );
END;
$$;

COMMENT ON FUNCTION public.withdraw_practice_lighting_override(p_override_id uuid) IS 'The requester while they still coach the slot, or an org admin: withdraw a requested or approved lighting override. Audited as practice_lighting_override.withdrawn.';

REVOKE ALL ON FUNCTION public.withdraw_practice_lighting_override(p_override_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON FUNCTION public.withdraw_practice_lighting_override(p_override_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.withdraw_practice_lighting_override(p_override_id uuid) TO service_role;

COMMENT ON TABLE public.practice_lighting_overrides IS 'Portable-lighting windows on a practice slot (8.9 D14): an approved row exempts the slot''s dates in its window from the sunset judgement. Coaches request; only org admins decide. Written only by request_practice_lighting_override, admin_decide_practice_lighting_override, withdraw_practice_lighting_override and admin_set_practice_lighting_override. No free text.';

COMMIT;
