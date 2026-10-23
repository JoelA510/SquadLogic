-- Revert for 20261022030000_remove_rsvp_and_team_chat.sql
--
-- Restores, empty, every object the migration dropped, as it stood after
-- 20261022010000: the `event_rsvps` and `team_messages` tables with their
-- keys, CHECKs, index, foreign keys, `set_timestamp` trigger, row security,
-- read policies and grants; `upsert_team_event_rsvp` (SECURITY DEFINER,
-- search_path=public, pinned to UTC as 20261021040000 left it) and
-- `create_team_message`, each with its comment and grants; then the two
-- replaced functions' previous bodies and comments: `admin_delete_team` from
-- 20261021030000 and `reconcile_prod_rls_drift` from 20261021020000.
--
-- The DDL is pg_dump's (16.15) of a harness build at 20261022010000, so each
-- function body is that migration's text byte for byte; only the OWNER lines
-- are left out (the objects are created by the role that runs this).
--
-- **What it cannot restore:** the RSVPs and team messages the migration
-- dropped. The tables come back empty. The forward migration's NOTICE counted
-- what it dropped (production: 0 RSVPs, 0 messages, read 2026-10-22).
--
-- **The realtime publication.** `team_messages` rejoins `supabase_realtime`
-- where that publication exists, as 20251217000000 joined it. On Supabase it
-- always exists, so this restores what the migration removed; on a bare
-- Postgres built from the migrations (the harness) the publication was created
-- after 20251217000000 ran, so the table was never a member there and this
-- revert adds it. The harness fingerprint below leaves publication membership
-- out for that reason.
--
-- Verified: the harness compares a fingerprint of every restored object
-- (signature, posture, grants, comment and body md5 of the four functions;
-- columns, constraints, index, trigger, grants and policies of the two tables)
-- with the one read off a build at 20261022010000.

BEGIN;

-- The dropped functions' bodies are not validated here (pg_dump's own
-- setting): the tables they name are created above them, but the plpgsql
-- validator would also resolve every %ROWTYPE at CREATE time.
SET LOCAL check_function_bodies = false;

-- 1. The two tables, their keys, index, foreign keys, trigger, row security,
--    policies and grants.


CREATE TABLE public.event_rsvps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    team_id uuid NOT NULL,
    player_id uuid NOT NULL,
    reference_id uuid NOT NULL,
    event_type text NOT NULL,
    occurrence_date date NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_rsvps_event_type_check CHECK ((event_type = ANY (ARRAY['game'::text, 'practice'::text]))),
    CONSTRAINT event_rsvps_status_check CHECK ((status = ANY (ARRAY['attending'::text, 'declined'::text, 'maybe'::text])))
);

CREATE TABLE public.team_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    team_id uuid NOT NULL,
    author_id uuid,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_player_id_reference_id_occurrence_date_key UNIQUE (player_id, reference_id, occurrence_date);

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_pkey PRIMARY KEY (id);

CREATE INDEX idx_event_rsvps_org_team ON public.event_rsvps USING btree (organization_id, team_id);

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.event_rsvps
    ADD CONSTRAINT event_rsvps_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.team_messages
    ADD CONSTRAINT team_messages_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;

CREATE TRIGGER event_rsvps_set_timestamp BEFORE UPDATE ON public.event_rsvps FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();

ALTER TABLE public.event_rsvps ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.team_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Event RSVPs: members access" ON public.event_rsvps FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE POLICY "Team Messages: members access" ON public.team_messages FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

GRANT ALL ON TABLE public.event_rsvps TO anon;
GRANT ALL ON TABLE public.event_rsvps TO authenticated;
GRANT ALL ON TABLE public.event_rsvps TO service_role;

GRANT ALL ON TABLE public.team_messages TO anon;
GRANT ALL ON TABLE public.team_messages TO authenticated;
GRANT ALL ON TABLE public.team_messages TO service_role;

-- 2. The realtime publication, as 20251217000000 joined it: only where the
--    publication exists (Supabase creates it; a bare Postgres may not have it).

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (
           SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'team_messages'
       ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.team_messages;
    END IF;
END;
$$;

-- 3. The two dropped functions, with their comments and grants.


CREATE FUNCTION public.upsert_team_event_rsvp(p_team_id uuid, p_player_id uuid, p_reference_id uuid, p_event_type text, p_occurrence_date date, p_status text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
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

    -- 20261021030000: the team before the game. The insert below checks
    -- event_rsvps.team_id, which takes FOR KEY SHARE on the team; taken here
    -- first, an RSVP locks in the order admin_delete_team does (team, then its
    -- games), so the two cannot deadlock over the team's own games.
    SELECT organization_id
      INTO v_org_id
      FROM public.teams
     WHERE id = p_team_id
       FOR KEY SHARE;

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

COMMENT ON FUNCTION public.upsert_team_event_rsvp(p_team_id uuid, p_player_id uuid, p_reference_id uuid, p_event_type text, p_occurrence_date date, p_status text) IS 'Org-scoped team portal RSVP mutation. Allows admins or linked parents to RSVP rostered players for validated team games/practices and writes metadata-only audit rows.';

REVOKE ALL ON FUNCTION public.upsert_team_event_rsvp(p_team_id uuid, p_player_id uuid, p_reference_id uuid, p_event_type text, p_occurrence_date date, p_status text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.upsert_team_event_rsvp(p_team_id uuid, p_player_id uuid, p_reference_id uuid, p_event_type text, p_occurrence_date date, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.upsert_team_event_rsvp(p_team_id uuid, p_player_id uuid, p_reference_id uuid, p_event_type text, p_occurrence_date date, p_status text) TO service_role;

CREATE FUNCTION public.create_team_message(p_team_id uuid, p_content text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_user_id uuid := auth.uid();
    v_org_id uuid;
    v_head_coach_id uuid;
    v_assistant_coach_ids uuid[];
    v_content text := btrim(coalesce(p_content, ''));
    v_message public.team_messages%ROWTYPE;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required'
            USING ERRCODE = '42501';
    END IF;

    SELECT organization_id, coach_id, coalesce(assistant_coach_ids, '{}'::uuid[])
      INTO v_org_id, v_head_coach_id, v_assistant_coach_ids
      FROM public.teams
     WHERE id = p_team_id;

    IF v_org_id IS NULL OR NOT public.is_org_member(v_org_id) THEN
        RAISE EXCEPTION 'Team is outside the caller organization'
            USING ERRCODE = '42501';
    END IF;

    IF v_content = '' THEN
        RAISE EXCEPTION 'Message content is required'
            USING ERRCODE = '22023';
    END IF;

    IF length(v_content) > 4000 THEN
        RAISE EXCEPTION 'Message content exceeds 4000 characters'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_org_admin(v_org_id)
       AND NOT EXISTS (
           SELECT 1
             FROM public.coaches c
            WHERE c.organization_id = v_org_id
              AND (c.user_id = v_user_id OR c.profile_id = v_user_id)
              AND (c.id = v_head_coach_id OR c.id = ANY(v_assistant_coach_ids))
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.profile_players pp
             JOIN public.team_players tp
               ON tp.player_id = pp.player_id
              AND tp.team_id = p_team_id
              AND tp.organization_id = v_org_id
            WHERE pp.profile_id = v_user_id
              AND pp.organization_id = v_org_id
       ) THEN
        RAISE EXCEPTION 'Caller cannot post messages for this team'
            USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.team_messages (
        organization_id,
        team_id,
        author_id,
        content
    )
    VALUES (
        v_org_id,
        p_team_id,
        v_user_id,
        v_content
    )
    RETURNING *
      INTO v_message;

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
        'team.message_created',
        'team_message',
        v_message.id,
        jsonb_build_object(
            'team_id', p_team_id,
            'content_length', length(v_content)
        )
    );

    RETURN jsonb_build_object('message', to_jsonb(v_message));
END;
$$;

COMMENT ON FUNCTION public.create_team_message(p_team_id uuid, p_content text) IS 'Org-scoped team portal message mutation. Allows admins, assigned coaches, assistant coaches, or roster parents to post sanitized team messages and writes metadata-only audit rows.';

REVOKE ALL ON FUNCTION public.create_team_message(p_team_id uuid, p_content text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_team_message(p_team_id uuid, p_content text) TO authenticated;
GRANT ALL ON FUNCTION public.create_team_message(p_team_id uuid, p_content text) TO service_role;

-- 4. The two replaced functions' previous bodies and comments (CREATE OR
--    REPLACE keeps their grants, which the migration did not change).


CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
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
        -- Production's own text, which names no organisation to a caller
        -- outside it.
        RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
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

COMMENT ON FUNCTION public.admin_delete_team(p_team_id uuid) IS 'Audited team deletion for org admins: withdraws, audits and archives the team''s practice exceptions and cancels its series as admin_cancel_practice_assignment does, removes every game RSVP to its games, clears players.team_id, and records what the cascade took. 20261021030000.';

CREATE OR REPLACE FUNCTION public.reconcile_prod_rls_drift() RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_spec record;
    v_pol record;
    v_ddl text;
    v_have record;
    v_probe record;
    v_created text[] := ARRAY[]::text[];
    v_verified text[] := ARRAY[]::text[];
    v_dropped text[] := ARRAY[]::text[];
    -- Stated, not read back from the catalogue this function rewrites.
    c_broad_tables text[] := ARRAY['coaches','teams','locations','fields','divisions','game_assignments',
                                   'import_jobs','imports','team_messages','organization_schemas',
                                   'schedule_evaluations'];
    c_member_write_tables text[] := ARRAY['practice_slots','field_subunits','scheduler_runs'];
BEGIN
    -- 1. Every repo policy on the affected tables, created if missing.
    --    Columns: table, policy, command, roles, USING, WITH CHECK -- each
    --    clause copied verbatim from the source line cited.
    FOR v_spec IN
        SELECT * FROM (VALUES
            -- CHANGED (20261021020000): coaches are read by admins and staff,
            -- and a coach reads their own row; the member-wide policy is gone
            -- and must not come back from here.
            ('coaches', 'coaches_select_admin_or_self', 'SELECT', 'authenticated',
             'public.is_org_admin(organization_id) OR (public.is_org_member(organization_id) AND user_id = (SELECT auth.uid()))', NULL),
            -- 20260331000000_definitive_schema.sql:1036
            ('teams', 'Teams: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1061
            ('game_assignments', 'Game Assignments: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1132
            ('imports', 'Imports: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260331000000_definitive_schema.sql:1137
            ('import_jobs', 'Import Jobs: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- CHANGED (20261018030000): "Users can view their organization's
            -- import jobs" (20260404120000_phase_4_observability.sql:42) is no
            -- longer a repo policy; it repeated the member SELECT above.
            -- 20260331000000_definitive_schema.sql:1167
            ('schedule_evaluations', 'Schedule Evaluations: members access', 'SELECT', 'authenticated',
             'is_org_member(organization_id)', NULL),
            -- 20260504070000_team_portal_communication_rpcs.sql:53
            ('team_messages', 'Team Messages: members access', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260502001000_division_roster_constraints.sql:103
            ('divisions', 'Divisions: org members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260502001000_division_roster_constraints.sql:107
            ('divisions', 'Divisions: org admins insert', 'INSERT', 'authenticated',
             NULL, 'public.is_org_admin(organization_id)'),
            -- 20260502001000_division_roster_constraints.sql:111
            ('divisions', 'Divisions: org admins update', 'UPDATE', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)'),
            -- 20260502001000_division_roster_constraints.sql:116
            ('divisions', 'Divisions: org admins delete', 'DELETE', 'authenticated',
             'public.is_org_admin(organization_id)', NULL),
            -- 20260504050000_admin_upsert_organization_schema_rpc.sql:13
            ('organization_schemas', 'Schema Access: Org Members Select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:19
            ('locations', 'Locations: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:24
            ('fields', 'Fields: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:29
            ('field_subunits', 'Field Subunits: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- 20260504060000_admin_facility_mutation_rpcs.sql:34
            ('practice_slots', 'Practice Slots: members select', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- NEW in 20260928000000 (the repo had no member SELECT on
            -- scheduler_runs): the sibling split of
            -- 20260602010000_consolidated_rls_security_hardening.sql:48-57,
            -- same names and clauses. The admin write keeps the SECURITY
            -- INVOKER persist_practice_schedule working for admins.
            ('scheduler_runs', 'scheduler_runs_select_member', 'SELECT', 'authenticated',
             'public.is_org_member(organization_id)', NULL),
            -- CHANGED (20261018030000): scheduler_runs_write_admin (FOR ALL)
            -- is split by command, with the same expression.
            ('scheduler_runs', 'scheduler_runs_insert_admin', 'INSERT', 'authenticated',
             NULL, 'public.is_org_admin(organization_id)'),
            ('scheduler_runs', 'scheduler_runs_update_admin', 'UPDATE', 'authenticated',
             'public.is_org_admin(organization_id)', 'public.is_org_admin(organization_id)'),
            ('scheduler_runs', 'scheduler_runs_delete_admin', 'DELETE', 'authenticated',
             'public.is_org_admin(organization_id)', NULL)
        ) AS s(tbl, pol, cmd, roles, using_expr, check_expr)
    LOOP
        v_ddl := format('ON public.%I FOR %s TO %s', v_spec.tbl, v_spec.cmd, v_spec.roles)
              -- `||`, not format(): format('%s', NULL) is '' and would emit `USING ()`.
              || COALESCE(' USING (' || v_spec.using_expr || ')', '')
              || COALESCE(' WITH CHECK (' || v_spec.check_expr || ')', '');

        SELECT permissive, cmd, roles, qual, with_check INTO v_have
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_spec.tbl AND policyname = v_spec.pol;

        IF NOT FOUND THEN
            EXECUTE format('CREATE POLICY %I ', v_spec.pol) || v_ddl;
            v_created := v_created || (v_spec.tbl || ': ' || v_spec.pol);
            CONTINUE;
        END IF;

        -- Same name already there: it must mean the same thing. Build the
        -- spec under a probe name, let Postgres deparse both, compare, drop.
        EXECUTE format('CREATE POLICY %I ', '__reconcile_prod_rls_drift_probe') || v_ddl;
        SELECT permissive, cmd, roles, qual, with_check INTO v_probe
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = v_spec.tbl
           AND policyname = '__reconcile_prod_rls_drift_probe';
        EXECUTE format('DROP POLICY %I ON public.%I', '__reconcile_prod_rls_drift_probe', v_spec.tbl);
        IF v_have IS DISTINCT FROM v_probe THEN
            RAISE EXCEPTION
                'reconcile_prod_rls_drift: public.% already has "%" but it differs from the repo definition (have: %, repo: %); refusing to call it reconciled',
                v_spec.tbl, v_spec.pol, v_have, v_probe;
        END IF;
        v_verified := v_verified || (v_spec.tbl || ': ' || v_spec.pol);
    END LOOP;

    -- 2. The dashboard-only broad member-write policy, wherever it exists.
    --    Found on a table the drift report did not name, it may be that
    --    table's only read path and nothing above replaces it -- so refuse
    --    rather than silently cut members off there.
    FOR v_pol IN
        SELECT schemaname, tablename
          FROM pg_policies
         WHERE policyname = 'Enforce Org Membership: ALL'
           AND NOT (schemaname = 'public' AND tablename = ANY (c_broad_tables))
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: "Enforce Org Membership: ALL" is on %.%, which the drift report did not name and this migration restores no read policy for; refusing to drop it blind',
            v_pol.schemaname, v_pol.tablename;
    END LOOP;
    FOR v_pol IN
        SELECT schemaname, tablename, policyname
          FROM pg_policies
         WHERE policyname = 'Enforce Org Membership: ALL'
         ORDER BY schemaname, tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I', v_pol.policyname, v_pol.schemaname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3. The repo's own member-write hole, under its older name (header).
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = ANY (c_member_write_tables)
           AND policyname = 'org_member_access'
         ORDER BY tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3b. CHANGED (20261018030000): the repo policies this spec replaced, where
    --     they are still present -- scheduler_runs_write_admin (now split by
    --     command, created above if missing) and the legacy import_jobs
    --     SELECT (it repeats "Import Jobs: members access", ensured above).
    --     Left beside their replacements they are the advisors' findings
    --     again, under a "reconciled" notice.
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND ((tablename = 'scheduler_runs' AND policyname = 'scheduler_runs_write_admin')
             OR (tablename = 'import_jobs' AND policyname = 'Users can view their organization''s import jobs'))
         ORDER BY tablename
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 3c. CHANGED (20261021020000): the member-wide coaches read the spec
    --     above replaced. Re-added by drift, it would be ORed with the
    --     narrowed policy and every member would read every coach row again.
    FOR v_pol IN
        SELECT tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'coaches'
           AND policyname = 'Coaches: members access'
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', v_pol.policyname, v_pol.tablename);
        v_dropped := v_dropped || (v_pol.tablename || ': ' || v_pol.policyname);
    END LOOP;

    -- 4. Enforced, not declared: the end state is checked before commit,
    --    across EVERY table in `public` rather than a list. A write policy
    --    with any clause lacking an admin gate aborts here unless the
    --    allowlist names it -- so a member-write policy nobody reported fails
    --    loudly instead of surviving under a "reconciled" notice. Text-level;
    --    see 20260928000000_reconcile_prod_rls_drift.sql's header for what
    --    its smoke adds.
    FOR v_pol IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.cmd <> 'SELECT'
           AND ((p.qual IS NOT NULL AND p.qual !~ '(is_org_admin\(|''admin''::text)')
             OR (p.with_check IS NOT NULL AND p.with_check !~ '(is_org_admin\(|''admin''::text)'))
           AND NOT EXISTS (SELECT 1 FROM public.rls_member_write_allowlist() a
                            WHERE a.tablename = p.tablename AND a.policyname = p.policyname)
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: public.% still has write policy "%" that is not admin-gated; refusing to call it reconciled',
            v_pol.tablename, v_pol.policyname;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Enforce Org Membership: ALL') THEN
        RAISE EXCEPTION 'reconcile_prod_rls_drift: "Enforce Org Membership: ALL" survived its own drop';
    END IF;
    -- CHANGED (20261021020000): coaches has one read, the narrowed one.
    FOR v_pol IN
        SELECT policyname
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'coaches'
           AND permissive = 'PERMISSIVE' AND cmd IN ('SELECT', 'ALL')
           AND policyname <> 'coaches_select_admin_or_self'
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: public.coaches still has read policy "%" beside coaches_select_admin_or_self; refusing to call it reconciled',
            v_pol.policyname;
    END LOOP;

    RETURN jsonb_build_object(
        'created', to_jsonb(v_created),
        'verified', to_jsonb(v_verified),
        'dropped', to_jsonb(v_dropped)
    );
END;
$$;

COMMENT ON FUNCTION public.reconcile_prod_rls_drift() IS 'Idempotent: creates the repo''s member/admin policies on the tables of migration 20260928000000 where missing (aborting on a same-named mismatch), drops "Enforce Org Membership: ALL" and "org_member_access" on practice_slots/field_subunits/scheduler_runs, then refuses any non-allowlisted non-admin write policy in public. Spec as of 20261018030000 (scheduler_runs admin write split by command; the legacy import_jobs SELECT gone; both dropped where still present). Owner-only.';

COMMIT;
