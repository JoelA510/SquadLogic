-- Revert 20261021030000_admin_delete_team_exceptions.sql.
--
-- Restores admin_delete_team as production ran it before the change
-- (pg_get_functiondef read 2026-10-21, md5 83448d4265528e033924d035a4a40c04;
-- the repo's 20260613000003 text differs in its error message and layout) and
-- upsert_team_event_rsvp as 20261005000000 defined it (md5
-- 867b3603e208b86387cf9122a2572243 on production and on a fresh build).
-- Grants and owners are kept by CREATE OR REPLACE. Rows the new
-- admin_delete_team already deleted, withdrew, archived or audited stay as they
-- are: the revert changes behaviour, not history.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_team public.teams%ROWTYPE; BEGIN
    SELECT * INTO v_team FROM public.teams WHERE id=p_team_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'team % not found', p_team_id USING ERRCODE='P0002'; END IF;
    IF NOT public.is_org_admin(v_team.organization_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
    DELETE FROM public.teams WHERE id=p_team_id;
    PERFORM public.record_audit_event(v_team.organization_id,'team.deleted','teams',p_team_id,jsonb_build_object('name',v_team.name,'division_id',v_team.division_id));
END; $function$
;

COMMENT ON FUNCTION public.admin_delete_team(uuid) IS
  'Audited team deletion (cascades to team_players, games, practices, rsvps, messages) for org admins.';

CREATE OR REPLACE FUNCTION public.upsert_team_event_rsvp(
    p_team_id uuid,
    p_player_id uuid,
    p_reference_id uuid,
    p_event_type text,
    p_occurrence_date date,
    p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_org_id uuid;
    v_reference_allowed boolean := false;
    v_existing public.event_rsvps%ROWTYPE;
    v_rsvp public.event_rsvps%ROWTYPE;
    v_changed boolean := false;
    v_assignment_found boolean := false;
    v_unreadable_windows integer := 0;
    v_covering_windows integer := 0;
    v_cover public.practice_exceptions%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required'
            USING ERRCODE = '42501';
    END IF;

    SELECT organization_id
      INTO v_org_id
      FROM public.teams
     WHERE id = p_team_id;

    IF v_org_id IS NULL OR NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'Team is outside the caller organization'
            USING ERRCODE = '42501';
    END IF;

    IF p_event_type NOT IN ('game', 'practice') THEN
        RAISE EXCEPTION 'event_type must be game or practice'
            USING ERRCODE = '22023';
    END IF;

    IF p_status NOT IN ('attending', 'declined', 'maybe') THEN
        RAISE EXCEPTION 'status must be attending, declined, or maybe'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.players p
          JOIN public.team_players tp
            ON tp.player_id = p.id
           AND tp.team_id = p_team_id
         WHERE p.id = p_player_id
           AND p.organization_id = v_org_id
           AND tp.organization_id = v_org_id
    ) THEN
        RAISE EXCEPTION 'Player is outside the requested team'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin(v_org_id)
       AND NOT EXISTS (
           SELECT 1
             FROM public.profile_players pp
            WHERE pp.profile_id = v_user_id
              AND pp.player_id = p_player_id
              AND pp.organization_id = v_org_id
       ) THEN
        RAISE EXCEPTION 'Caller cannot manage RSVP for this player'
            USING ERRCODE = '42501';
    END IF;

    IF p_event_type = 'game' THEN
        SELECT EXISTS (
            SELECT 1
              FROM public.games g
              LEFT JOIN public.game_slots gs
                ON gs.id = g.game_slot_id
             WHERE g.id = p_reference_id
               AND g.organization_id = v_org_id
               AND (g.home_team_id = p_team_id OR g.away_team_id = p_team_id)
               AND coalesce(gs.slot_date, gs.start::date, g.start_time::date) = p_occurrence_date
        )
          INTO v_reference_allowed;
    ELSE
        -- The series rule, unchanged: in the row's range, on its weekday.
        SELECT EXISTS (
            SELECT 1
              FROM public.practice_assignments pa
              LEFT JOIN public.practice_slots ps
                ON ps.id = coalesce(pa.practice_slot_id, pa.slot_id)
             WHERE pa.id = p_reference_id
               AND pa.organization_id = v_org_id
               AND pa.team_id = p_team_id
               AND p_occurrence_date <@ pa.effective_date_range
               AND trim(lower(to_char(p_occurrence_date, 'dy'))) =
                   coalesce(nullif(lower(pa.day_of_week), ''), ps.day_of_week::text)
        )
          INTO v_reference_allowed;

        -- 8.6 3b PR 12d: the saved practice exceptions on the team's own
        -- assignment. A reference that is not the team's is left to the
        -- 42501 below, exactly as before, and reads no exception.
        SELECT EXISTS (
            SELECT 1
              FROM public.practice_assignments pa
             WHERE pa.id = p_reference_id
               AND pa.organization_id = v_org_id
               AND pa.team_id = p_team_id
        )
          INTO v_assignment_found;

        IF v_assignment_found THEN
            -- Every live exception on the assignment counts, whatever
            -- organisation or team it names: a window is never ignored for a
            -- field this function did not expect (conservative, Q7).
            SELECT count(*) FILTER (
                       WHERE lower_inf(pe."window")
                          OR lower(pe."window") = '-infinity'::date
                   ),
                   count(*) FILTER (WHERE p_occurrence_date <@ pe."window")
              INTO v_unreadable_windows, v_covering_windows
              FROM public.practice_exceptions pe
             WHERE pe.assignment_id = p_reference_id
               AND pe.withdrawn_at IS NULL;

            IF v_unreadable_windows > 0 THEN
                RAISE EXCEPTION 'Practice % has a saved change whose dates cannot be read, so no date of it takes an RSVP', p_reference_id
                    USING ERRCODE = '22023';
            END IF;

            IF v_covering_windows > 1 THEN
                RAISE EXCEPTION 'Practice % on % is covered by % saved changes at once, so it takes no RSVP', p_reference_id, p_occurrence_date, v_covering_windows
                    USING ERRCODE = '22023';
            END IF;

            IF v_covering_windows = 1 THEN
                SELECT pe.*
                  INTO v_cover
                  FROM public.practice_exceptions pe
                 WHERE pe.assignment_id = p_reference_id
                   AND pe.withdrawn_at IS NULL
                   AND p_occurrence_date <@ pe."window";

                IF v_cover.kind = 'time_tbd' THEN
                    RAISE EXCEPTION 'Practice % on % falls inside a TIME TBD change (no confirmed time), so it takes no RSVP yet', p_reference_id, p_occurrence_date
                        USING ERRCODE = '22023';
                END IF;

                IF v_cover.kind IS DISTINCT FROM 'relocated'
                   OR upper_inf(v_cover."window")
                   OR upper(v_cover."window") = 'infinity'::date THEN
                    RAISE EXCEPTION 'Practice % on % is under a saved change with no end date, so it takes no RSVP', p_reference_id, p_occurrence_date
                        USING ERRCODE = '22023';
                END IF;

                -- The moved practice: the relocated slot's weekday, inside the
                -- window and the row's own bounded range (Q9), on a row whose
                -- own slot exists.
                SELECT EXISTS (
                    SELECT 1
                      FROM public.practice_assignments pa
                      JOIN public.practice_slots ps
                        ON ps.id = coalesce(pa.practice_slot_id, pa.slot_id)
                      JOIN public.practice_slots rs
                        ON rs.id = v_cover.practice_slot_id
                     WHERE pa.id = p_reference_id
                       AND pa.organization_id = v_org_id
                       AND pa.team_id = p_team_id
                       AND v_cover.organization_id = v_org_id
                       AND v_cover.team_id = p_team_id
                       AND NOT lower_inf(pa.effective_date_range)
                       AND NOT upper_inf(pa.effective_date_range)
                       AND lower(pa.effective_date_range) <> '-infinity'::date
                       AND upper(pa.effective_date_range) <> 'infinity'::date
                       AND p_occurrence_date <@ pa.effective_date_range
                       AND trim(lower(to_char(p_occurrence_date, 'dy'))) = rs.day_of_week::text
                )
                  INTO v_reference_allowed;

                IF NOT v_reference_allowed THEN
                    RAISE EXCEPTION 'Practice % on % was moved by a saved change; RSVP to the moved practice''s date instead', p_reference_id, p_occurrence_date
                        USING ERRCODE = '22023';
                END IF;
            END IF;
        END IF;
    END IF;

    IF NOT v_reference_allowed THEN
        RAISE EXCEPTION 'Event reference is outside the requested team'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_existing
      FROM public.event_rsvps
     WHERE player_id = p_player_id
       AND reference_id = p_reference_id
       AND occurrence_date = p_occurrence_date;

    INSERT INTO public.event_rsvps (
        organization_id,
        team_id,
        player_id,
        reference_id,
        event_type,
        occurrence_date,
        status,
        updated_at
    )
    VALUES (
        v_org_id,
        p_team_id,
        p_player_id,
        p_reference_id,
        p_event_type,
        p_occurrence_date,
        p_status,
        timezone('utc', now())
    )
    ON CONFLICT (player_id, reference_id, occurrence_date)
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        team_id = EXCLUDED.team_id,
        event_type = EXCLUDED.event_type,
        status = EXCLUDED.status,
        updated_at = timezone('utc', now())
    RETURNING *
      INTO v_rsvp;

    v_changed := v_existing.id IS NULL OR v_existing.status IS DISTINCT FROM v_rsvp.status;

    IF v_changed THEN
        INSERT INTO public.audit_log (
            organization_id,
            user_id,
            action,
            resource_type,
            resource_id,
            metadata
        )
        VALUES (
            v_org_id,
            v_user_id,
            'team.rsvp_updated',
            'event_rsvp',
            v_rsvp.id,
            jsonb_build_object(
                'team_id', p_team_id,
                'player_id', p_player_id,
                'reference_id', p_reference_id,
                'event_type', p_event_type,
                'occurrence_date', p_occurrence_date,
                'previous_status', v_existing.status,
                'status', v_rsvp.status
            )
        );
    END IF;

    RETURN jsonb_build_object(
        'rsvp', to_jsonb(v_rsvp),
        'changed', v_changed
    );
END;
$$;


COMMIT;
