-- 8.6 3b PR 12d: RSVP follows the applied practice calendar
-- (docs/PHASE_8_6_PR12_READERS_PLAN.md §4 R6, §6 W14-W15, §10 Q3/Q4/Q7/Q9).
--
-- `upsert_team_event_rsvp` judged a practice date by the series alone: in the
-- row's range and on its weekday (20260504070000:141-154). With saved
-- practice exceptions applied by every reader (12a-12c), that accepted an
-- RSVP for an original date a `relocated` exception moved away, refused the
-- moved practice's new date, and accepted a date whose time is TBD.
--
-- This replaces the function with the same signature, `SECURITY DEFINER`,
-- `SET search_path = public`, return type and body, bar the practice branch.
-- CREATE OR REPLACE keeps the grants and the comment. The game branch, the
-- caller checks, the upsert and the audit row are byte-for-byte as they were.
--
-- **The practice rule** (Q4: an RSVP is keyed on (assignment id, new date)).
-- The assignment must be the team's, in the caller's organisation, as before.
-- Then, over the LIVE exceptions on that assignment (`withdrawn_at IS NULL`,
-- the predicate of the table's EXCLUDE constraint and of the 12a helper's own
-- filter, `packages/core/src/utils/practiceExceptions.js:258-262`):
--
--   * no live window covers the date: the series rule, UNCHANGED (in the
--     row's range, on its weekday); a mismatch stays 42501 as before;
--   * any live window whose lower bound does not read (`-infinity`, or
--     unbounded): every date of the row is refused 22023. This mirrors the
--     helper's `readClaim` (`practiceExceptions.js:154-156`) and rule 6
--     (`:311-321`): an unreadable lower bound makes the whole row undated;
--   * two or more live windows cover the date: refused 22023 -- the helper's
--     CONFLICT (`:375-385`). The EXCLUDE constraint forbids it; this does not
--     trust that;
--   * exactly one live window covers the date:
--       - `time_tbd`: refused 22023 (a date with no confirmed time);
--       - `relocated` with an open upper bound (unbounded, or `infinity`):
--         refused 22023. The helper reads such a window with
--         `practiceRangeLowerBound` and suppresses every date from its lower
--         bound on, relocated or not (`:160-166`, `:323-331`, `:368`) -- Q7,
--         the conservative answer;
--       - `relocated`, bounded: accepted only on the relocated slot's weekday
--         inside the window AND the row's own range (Q9 clip, the helper's
--         `from`/`until`, `:193-201`), and only while the row itself expands
--         (its own slot exists and its range is bounded -- the helper refuses
--         a row with no slot or an unreadable range before it reads any
--         exception, `:292-303`). The exception must name the caller's
--         organisation and the team. Anything else in the window, the
--         original date included, is refused 22023.
--
-- **Window bounds.** A `daterange` is canonicalised to `[lower, upper)`, so
-- `date <@ window` is exactly the helper's inclusive `first..last` from
-- `practiceRangeBounds` (`packages/core/src/utils/practiceOccurrences.js:101-113`:
-- `[` covers its bound, `)` stops the day before). `infinity` as an upper
-- bound is the helper's `upperUnbounded` (`:137-138`).
--
-- **Stored RSVPs are untouched (Q4).** No DELETE and no UPDATE of any stored
-- `event_rsvps` row: an RSVP stored for a date that later became TIME TBD or
-- moved stays, and is simply not shown (plan D6). The one write is the
-- existing upsert of the (player, reference, date) the caller sent, which a
-- refused date never reaches.
--
-- **Declared, not enforced.** The series arm keeps the old rule, so a date
-- outside every window on a row the helper refuses (no slot on the joined
-- row but a `day_of_week` on the assignment, or an unbounded range) is still
-- accepted, as today; only exception-covered dates follow the helper. The
-- writer still admits mid-range `relocated` and non-daylight `time_tbd`
-- windows (plan D1); this RPC now reads them correctly.
--
-- Revert: docs/sql/20261005000000_revert.sql. Smoke:
-- docs/sql/20261005000000_smoke.sql. pgTAP:
-- supabase/tests/rsvp_applied_practice_calendar.sql.

BEGIN;

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
