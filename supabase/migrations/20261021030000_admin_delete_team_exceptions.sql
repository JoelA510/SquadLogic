-- admin_delete_team takes its practice exceptions, its opponents' game RSVPs
-- and its players' team ids with it, on the record
-- (plan docs/changes/2026-10-20-admin-delete-team.md, option 1, approved
-- 2026-10-21; decision 2: no confirmation step in this change).
--
-- **What was wrong.** `admin_delete_team` (20260613000003) deleted the team and
-- let the foreign keys do the rest. Built from the migrations (2026-10-21,
-- executed), deleting a team whose practice series carries exceptions does NOT
-- raise the 23503 the v3 RESTRICT guard (`practice_exceptions_assignment_fk`)
-- was meant to give: the parallel `practice_exceptions.team_id` cascade removes
-- the rows first. So the exceptions went with no withdrawal, no archive and no
-- audit row. The delete also left:
--   * the opposing team's RSVPs to the games the cascade removed
--     (`event_rsvps.reference_id` has no foreign key);
--   * `players.team_id` on any player assigned through that column alone (it
--     has no foreign key; the sync trigger clears only rostered players);
--   * an audit row naming the team and nothing it took with it.
--
-- **What it does now** (one transaction, the sibling
-- `admin_cancel_practice_assignment`'s contract for each series):
--   1. Locks the team FOR UPDATE, then refuses unknown (P0002) and non-admin
--      (42501) callers as before. A practice save that inserts an exception or
--      a series for the team checks the team foreign key (FOR KEY SHARE), so it
--      waits on this lock and then fails cleanly on the missing team.
--   2. Withdraws the live exceptions on the team's series (and any naming the
--      team), audits each `practice.exception_withdrawn` with reason
--      `team_deleted`, deletes them all, archives them onto their run's
--      `results.archived_exceptions`, deletes each series and audits it
--      `practice.cancelled` with its `before` row.
--   3. Locks the team's games FOR UPDATE and deletes every game RSVP to them in
--      the organisation, whichever team it belongs to. `upsert_team_event_rsvp`
--      now takes FOR KEY SHARE on the game it validates (below), so an RSVP
--      cannot slip in after this step.
--   4. Clears `players.team_id` for every player it names, then deletes the team.
--   5. `team.deleted` records a count for every table the cascade empties, the
--      deleted game ids, the unassigned player ids, and the withdrawn and
--      archived exceptions. supabase/tests/admin_delete_team_exceptions.sql
--      walks the foreign keys from `teams` and fails if a cascading table has
--      no counter.
--
-- `upsert_team_event_rsvp` is the 20261005000000 body with two changes: the
-- game lock above, and `now()` for `timezone('utc', now())` in its two writes
-- (plan docs/changes/2026-10-20-utc-now-idiom.md: a body rewritten for its own
-- reasons drops the idiom).
--
-- Revert: docs/sql/20261021030000_revert.sql. Smoke: docs/sql/20261021030000_smoke.sql.
-- pgTAP: supabase/tests/admin_delete_team_exceptions.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_team public.teams%ROWTYPE;
    v_uid uuid := auth.uid();
    v_pa record;
    v_row jsonb;
    v_withdrawn jsonb;
    v_archived jsonb;
    v_game_ids uuid[];
    v_player_ids uuid[];
    v_game_rsvps integer;
    v_counts jsonb;
BEGIN
    SELECT * INTO v_team FROM public.teams WHERE id = p_team_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'team % not found', p_team_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_team.organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_team.organization_id
            USING ERRCODE = '42501';
    END IF;

    -- 2. The practice series, as admin_cancel_practice_assignment does each.
    --    An exception is the team's if it is on one of the team's series or
    --    names the team: the team_id cascade would remove either.
    WITH w AS (
        UPDATE public.practice_exceptions pe
           SET withdrawn_at = now(),
               withdrawn_by = v_uid
         WHERE (pe.team_id = p_team_id
                OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                         WHERE pa.team_id = p_team_id))
           AND pe.withdrawn_at IS NULL
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(w.*) ORDER BY w.id), '[]'::jsonb)
      INTO v_withdrawn
      FROM w;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_withdrawn) LOOP
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.exception_withdrawn',
            'practice_exception',
            (v_row->>'id')::uuid,
            jsonb_build_object('reason', 'team_deleted', 'team_id', p_team_id,
                               'assignment_id', v_row->'assignment_id', 'row', v_row)
        );
    END LOOP;

    WITH gone AS (
        DELETE FROM public.practice_exceptions pe
         WHERE pe.team_id = p_team_id
            OR pe.assignment_id IN (SELECT pa.id FROM public.practice_assignments pa
                                     WHERE pa.team_id = p_team_id)
        RETURNING pe.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(gone.*) ORDER BY gone.id), '[]'::jsonb)
      INTO v_archived
      FROM gone;
    UPDATE public.scheduler_runs sr
       SET results = COALESCE(sr.results, '{}'::jsonb) || jsonb_build_object(
               'archived_exceptions',
               COALESCE(sr.results->'archived_exceptions', '[]'::jsonb)
               || (SELECT jsonb_agg(e.value) FROM jsonb_array_elements(v_archived) e
                    WHERE (e.value->>'run_id')::uuid = sr.id))
     WHERE sr.id IN (SELECT (e.value->>'run_id')::uuid FROM jsonb_array_elements(v_archived) e
                      WHERE e.value->>'run_id' IS NOT NULL);

    v_counts := jsonb_build_object(
        'practice_exceptions_deleted', jsonb_array_length(v_archived),
        'practice_assignments_deleted',
            (SELECT count(*) FROM public.practice_assignments WHERE team_id = p_team_id)
    );
    FOR v_pa IN
        SELECT pa.id, to_jsonb(pa.*) AS before
          FROM public.practice_assignments pa
         WHERE pa.team_id = p_team_id
         ORDER BY pa.id
    LOOP
        DELETE FROM public.practice_assignments WHERE id = v_pa.id;
        PERFORM public.record_audit_event(
            v_team.organization_id,
            'practice.cancelled',
            'practice_assignments',
            v_pa.id,
            jsonb_build_object(
                'reason', 'team_deleted',
                'team_id', p_team_id,
                'assignment_id', v_pa.id,
                'before', v_pa.before,
                'withdrawn_exception_ids',
                    (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                       FROM jsonb_array_elements(v_withdrawn) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id),
                'archived_exceptions',
                    (SELECT COALESCE(jsonb_agg(e.value), '[]'::jsonb)
                       FROM jsonb_array_elements(v_archived) e
                      WHERE (e.value->>'assignment_id')::uuid = v_pa.id)
            )
        );
    END LOOP;

    -- 3. The team's games, held until commit, and every game RSVP to them.
    SELECT COALESCE(array_agg(g.id ORDER BY g.id), ARRAY[]::uuid[])
      INTO v_game_ids
      FROM (SELECT id FROM public.games
             WHERE home_team_id = p_team_id OR away_team_id = p_team_id
             ORDER BY id
               FOR UPDATE) g;
    DELETE FROM public.event_rsvps
     WHERE event_type = 'game'
       AND organization_id = v_team.organization_id
       AND reference_id = ANY (v_game_ids);
    GET DIAGNOSTICS v_game_rsvps = ROW_COUNT;

    -- 4. Players assigned through players.team_id (no foreign key), then the team.
    SELECT COALESCE(array_agg(p.id ORDER BY p.id), ARRAY[]::uuid[])
      INTO v_player_ids
      FROM public.players p
     WHERE p.team_id = p_team_id;

    -- 5. What the cascade takes, counted before it runs.
    v_counts := v_counts || jsonb_build_object(
        'games_deleted', cardinality(v_game_ids),
        'game_assignments_deleted',
            (SELECT count(*) FROM public.game_assignments
              WHERE home_team_id = p_team_id OR away_team_id = p_team_id),
        'team_players_deleted',
            (SELECT count(*) FROM public.team_players WHERE team_id = p_team_id),
        'event_rsvps_deleted',
            v_game_rsvps + (SELECT count(*) FROM public.event_rsvps WHERE team_id = p_team_id),
        'team_messages_deleted',
            (SELECT count(*) FROM public.team_messages WHERE team_id = p_team_id),
        'team_coach_assignments_deleted',
            (SELECT count(*) FROM public.team_coach_assignments WHERE team_id = p_team_id),
        'team_calendar_tokens_deleted',
            (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id = p_team_id)
    );

    UPDATE public.players SET team_id = NULL WHERE id = ANY (v_player_ids);
    DELETE FROM public.teams WHERE id = p_team_id;

    PERFORM public.record_audit_event(
        v_team.organization_id,
        'team.deleted',
        'teams',
        p_team_id,
        jsonb_build_object('name', v_team.name, 'division_id', v_team.division_id)
            || v_counts
            || jsonb_build_object(
                   'game_ids', to_jsonb(v_game_ids),
                   'player_ids_unassigned', to_jsonb(v_player_ids),
                   'withdrawn_exception_ids',
                       (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                          FROM jsonb_array_elements(v_withdrawn) e),
                   'archived_exceptions', v_archived)
    );
END;
$$;

COMMENT ON FUNCTION public.admin_delete_team(uuid) IS
  'Audited team deletion for org admins: withdraws, audits and archives the team''s practice exceptions and cancels its series as admin_cancel_practice_assignment does, removes every game RSVP to its games, clears players.team_id, and records what the cascade took. 20261021030000.';

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
        -- 20261021030000: hold the game while this RSVP is written. A team
        -- delete locks its games FOR UPDATE before it removes their RSVPs, so
        -- an RSVP either commits first (and the delete removes it) or waits
        -- here and then finds the game gone (and is refused below). Without
        -- this, an RSVP checked against the game just before the delete could
        -- commit after it, keeping a reference to a game that no longer exists
        -- (reference_id has no foreign key). KEY SHARE, so score entry is not
        -- blocked by it.
        PERFORM 1 FROM public.games g WHERE g.id = p_reference_id FOR KEY SHARE;

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
        now()
    )
    ON CONFLICT (player_id, reference_id, occurrence_date)
    DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        team_id = EXCLUDED.team_id,
        event_type = EXCLUDED.event_type,
        status = EXCLUDED.status,
        updated_at = now()
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
