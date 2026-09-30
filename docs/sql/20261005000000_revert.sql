-- Revert for 20261005000000_rsvp_applied_practice_calendar.sql
--
-- Restores `upsert_team_event_rsvp` exactly as 20260504070000 defined it: the
-- series-only practice rule (in the row's range, on its weekday), which
-- ignores saved practice exceptions. The body below is that migration's,
-- byte for byte; the verify block pins it by md5 of `prosrc`.
--
-- CREATE OR REPLACE keeps the grants and the comment, as the forward
-- migration did. Nothing else changed, so nothing else is restored.
--
-- What it leaves: every `event_rsvps` row stays (the forward migration never
-- deleted or rewrote one, and neither does this). After the revert an RSVP
-- is again accepted for an original date a `relocated` exception moved away,
-- and for a TIME TBD date, and refused for a moved practice's new date. The
-- count of live exceptions that makes true is printed.

BEGIN;

DO $warn$
DECLARE
    v_live integer;
BEGIN
    SELECT count(*) INTO v_live
      FROM public.practice_exceptions
     WHERE withdrawn_at IS NULL;
    RAISE NOTICE 'this revert returns upsert_team_event_rsvp to the series-only practice rule; % live practice exception(s) stop being read by it', v_live;
END;
$warn$;

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

DO $verify$
DECLARE
    c_sig constant text := 'public.upsert_team_event_rsvp(uuid, uuid, uuid, text, date, text)';
    v_md5 text;
BEGIN
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = c_sig::regprocedure;
    -- md5 of the 20260504070000 body, taken from that file's dollar-quoted text.
    IF v_md5 IS DISTINCT FROM '1e07e31e5b2f9391a8a4b7a2d83d3e0e' THEN
        RAISE EXCEPTION 'the revert did not restore the 20260504070000 body byte for byte (md5 %)', v_md5;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_sig::regprocedure)
       OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = c_sig::regprocedure)
          IS DISTINCT FROM ARRAY['search_path=public'] THEN
        RAISE EXCEPTION 'the revert changed the SECURITY mode or search_path of %', c_sig;
    END IF;
    RAISE NOTICE 'revert verified: upsert_team_event_rsvp is the 20260504070000 body (md5 %), SECURITY DEFINER, search_path=public', v_md5;
END;
$verify$;

COMMIT;
