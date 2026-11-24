-- Completion C9. Retire the unused legacy games table. The saved schedule and scores keep their existing storage.
BEGIN;

DO $guard$
BEGIN
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid =
        to_regprocedure('public.admin_delete_team(uuid)')) IS DISTINCT FROM 'e7c4db10499eebbac2e222d7184aeaa7' THEN
        RAISE EXCEPTION 'Unexpected function body for public.admin_delete_team(uuid). Check the migration baseline.';
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid =
        to_regprocedure('public.field_bookings(uuid,uuid,date,text)')) IS DISTINCT FROM '2be0ec3131416d283ec4f721c9787ec1' THEN
        RAISE EXCEPTION 'Unexpected function body for public.field_bookings(uuid,uuid,date,text). Check the migration baseline.';
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid =
        to_regprocedure('public.rollback_field_import_job(uuid)')) IS DISTINCT FROM '7b327f4c7da61edd79ce8f3c12c5fe92' THEN
        RAISE EXCEPTION 'Unexpected function body for public.rollback_field_import_job(uuid). Check the migration baseline.';
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p WHERE p.oid =
        to_regprocedure('public.copy_legacy_game_scores()')) IS DISTINCT FROM '6d5529d9bd050a9c299d504de1689c12' THEN
        RAISE EXCEPTION 'Unexpected function body for public.copy_legacy_game_scores(). Check the migration baseline.';
    END IF;
END
$guard$;

-- Hold the same lock as DROP TABLE so no legacy row can appear after the count.
LOCK TABLE public.games IN ACCESS EXCLUSIVE MODE;
DO $empty$
DECLARE
    v_rows bigint;
BEGIN
    SELECT count(*) INTO v_rows FROM public.games;
    IF v_rows <> 0 THEN
        RAISE EXCEPTION 'Cannot retire the legacy games table: % row(s) remain', v_rows
            USING ERRCODE = '22023', DETAIL = 'legacy_games_not_empty';
    END IF;
END
$empty$;

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_team public.teams%ROWTYPE;
    v_uid uuid := auth.uid();
    v_pa record;
    v_row jsonb;
    v_withdrawn jsonb;
    v_archived jsonb;
    v_player_ids uuid[];
    v_counts jsonb;
    v_published_games integer;
    v_scores_deleted integer;
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

    -- 20261119010000: a team with a Published game is deleted only after changes to its games are allowed. Said
    -- before anything is deleted, with the count (the guard trigger's refusal of the cascade is the backstop).
    -- 20261120010000: counted by the one predicate (`game_held_ids`), over the team's games on either side.
    -- 20261122010000 (F11 decision D5): a game held ONLY by its score does not refuse the delete; it goes with the team
    -- and its score with it, counted below. So the count is of the held games whose hold is Published.
    SELECT count(*) INTO v_published_games
      FROM public.game_held_ids(ARRAY(SELECT ga.id
                                        FROM public.game_assignments ga
                                       WHERE ga.home_team_id = p_team_id OR ga.away_team_id = p_team_id)) AS h(id)
     WHERE public.game_hold_code(h.id) IS DISTINCT FROM 'game_scored';
    IF v_published_games > 0 THEN
        RAISE EXCEPTION 'team % has % Published game(s) and cannot be deleted: allow changes to them first', p_team_id, v_published_games
            USING ERRCODE = '22023', DETAIL = 'game_published';
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

    -- 4. Players assigned through players.team_id (no foreign key), then the team.
    SELECT COALESCE(array_agg(p.id ORDER BY p.id), ARRAY[]::uuid[])
      INTO v_player_ids
      FROM public.players p
     WHERE p.team_id = p_team_id;

    -- 5. What the cascade takes, counted before it runs.
    v_counts := v_counts || jsonb_build_object(
        'game_assignments_deleted',
            (SELECT count(*) FROM public.game_assignments
              WHERE home_team_id = p_team_id OR away_team_id = p_team_id),
        'team_players_deleted',
            (SELECT count(*) FROM public.team_players WHERE team_id = p_team_id),
        'team_coach_assignments_deleted',
            (SELECT count(*) FROM public.team_coach_assignments WHERE team_id = p_team_id),
        'team_calendar_tokens_deleted',
            (SELECT count(*) FROM public.team_calendar_tokens WHERE team_id = p_team_id),
        -- 20261108020000: the TIME TBD rows the cascade takes (as practice team, or as either side of a game).
        'schedule_tbd_deleted',
            (SELECT count(*) FROM public.schedule_tbd
              WHERE team_id = p_team_id OR home_team_id = p_team_id OR away_team_id = p_team_id),
        -- 20261112010000: the practice preference rules the cascade takes.
        'coach_practice_preferences_deleted',
            (SELECT count(*) FROM public.coach_practice_preferences WHERE team_id = p_team_id)
    );

    UPDATE public.players SET team_id = NULL WHERE id = ANY (v_player_ids);
    -- 20261122010000: the scores of the team's games go first (the foreign key from a score to its game is NO ACTION and
    -- would refuse the cascade, and the guard holds a scored game), and are counted in the audit row.
    DELETE FROM public.game_scores gs
     WHERE gs.game_id IN (SELECT ga.id FROM public.game_assignments ga
                           WHERE ga.home_team_id = p_team_id OR ga.away_team_id = p_team_id);
    GET DIAGNOSTICS v_scores_deleted = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('game_scores_deleted', v_scores_deleted);
    DELETE FROM public.teams WHERE id = p_team_id;

    PERFORM public.record_audit_event(
        v_team.organization_id,
        'team.deleted',
        'teams',
        p_team_id,
        jsonb_build_object('name', v_team.name, 'division_id', v_team.division_id)
            || v_counts
            || jsonb_build_object(
                   'player_ids_unassigned', to_jsonb(v_player_ids),
                   'withdrawn_exception_ids',
                       (SELECT COALESCE(jsonb_agg(e.value->'id'), '[]'::jsonb)
                          FROM jsonb_array_elements(v_withdrawn) e),
                   'archived_exceptions', v_archived)
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.field_bookings(p_organization_id uuid, p_scope_id uuid, p_after date DEFAULT NULL::date, p_scope text DEFAULT 'field'::text)
 RETURNS TABLE(kind text, booking_id uuid, on_date date, week_index integer, undated boolean, unbounded boolean, cascades boolean, field_id uuid)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
    -- **An unknown scope is refused, never answered with an empty set.** This
    -- is the whole reason the function is no longer LANGUAGE sql.
    IF p_scope IS NULL OR p_scope NOT IN ('field', 'location', 'subunit') THEN
        RAISE EXCEPTION 'unknown booking scope %; expected field, location or subunit', p_scope
            USING ERRCODE = '22023';
    END IF;
    IF p_organization_id IS NULL OR p_scope_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_scope_id are both required'
            USING ERRCODE = '22023';
    END IF;

    -- Dates: a game slot's is `slot_date` falling back to `start` (the import
    -- writes slot_date and never start, 20260503070000:738); an assignment's is
    -- its own `start`; a practice slot's is `valid_until`; a practice
    -- assignment's is the last day of its `effective_date_range`; a profile's is `available_until`.
    --
    -- `undated` means COULD NOT BE JUDGED. `unbounded` means runs forever and
    -- is therefore CERTAINLY affected -- a different answer, not a missing one.
    RETURN QUERY
    SELECT 'game_slot'::text, gs.id,
           COALESCE(gs.slot_date, gs.start::date),
           gs.week_index::integer,
           COALESCE(gs.slot_date, gs.start::date) IS NULL,
           false,
           true,
           gs.field_id
    FROM public.game_slots gs
    WHERE gs.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, gs.field_id, NULL)
      AND (p_after IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) IS NULL
           OR COALESCE(gs.slot_date, gs.start::date) > p_after)
    UNION ALL
    -- **An assignment's fate depends on the ROW, not on its table.**
    -- `game_assignments.field_id` is SET NULL, but `game_slot_id` and `slot_id`
    -- are ON DELETE CASCADE to `game_slots` (20260503030000:39-56), so for a
    -- real persisted schedule the slot cascade destroys the assignment before
    -- the SET NULL can fire.
    SELECT 'game_assignment'::text, ga.id,
           ga.start::date,
           ga.week_index::integer,
           ga.start IS NULL,
           false,
           EXISTS (SELECT 1 FROM public.game_slots s
                    WHERE s.id IN (ga.game_slot_id, ga.slot_id)
                      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, NULL)),
           ga.field_id
    FROM public.game_assignments ga
    WHERE ga.organization_id = p_organization_id
      AND (public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, ga.field_id, NULL)
           OR EXISTS (SELECT 1 FROM public.game_slots s
                       WHERE s.id IN (ga.game_slot_id, ga.slot_id)
                         AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, NULL)))
      AND (p_after IS NULL OR ga.start IS NULL OR ga.start::date > p_after)
    UNION ALL
    -- **The one arm that a sub-surface scope can reach directly.**
    -- `practice_slots.field_subunit_id` is the only column in the schema that
    -- names a sub-surface, so it is the only arm passing a non-NULL fifth
    -- argument. At field and location scope it is judged by its `field_id`
    -- exactly as before -- a slot scoped to a HALF pitch still carries the
    -- parent's field_id, which is NOT NULL.
    SELECT 'practice_slot'::text, ps.id,
           ps.valid_until,
           NULL::integer,
           false,
           ps.valid_until IS NULL,
           true,
           ps.field_id
    FROM public.practice_slots ps
    WHERE ps.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, ps.field_id, ps.field_subunit_id)
      AND (p_after IS NULL OR ps.valid_until IS NULL OR ps.valid_until > p_after)
    UNION ALL
    -- The same, for practices. `practice_assignments.slot_id` and
    -- `.practice_slot_id` are both ON DELETE CASCADE to `practice_slots`
    -- (20260331000000:526-527).
    --
    -- **The boundary is INCLUSIVE.** `p_after` is the last day the ground is
    -- usable -- the reading `field_is_live_on(effective_to, d)` and
    -- `facility/lifecycle.js isLiveOn()` already give. A daterange is
    -- canonicalised to `[)`, so `upper()` is the day AFTER the last covered
    -- one; the last covered day is `upper() - 1`, computed once in the lateral
    -- and used by both the projection and the filter.
    SELECT 'practice_assignment'::text, pa.id,
           b.last_day,
           NULL::integer,
           false,
           pa.effective_date_range IS NULL OR upper_inf(pa.effective_date_range),
           EXISTS (SELECT 1 FROM public.practice_slots s
                    WHERE s.id IN (pa.practice_slot_id, pa.slot_id)
                      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, s.field_subunit_id)),
           pa.field_id
    FROM public.practice_assignments pa
    CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN pa.effective_date_range IS NULL
                   OR upper_inf(pa.effective_date_range)
                 THEN NULL::date
                 ELSE upper(pa.effective_date_range) - 1
               END
    ) AS b(last_day)
    WHERE pa.organization_id = p_organization_id
      AND (public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, pa.field_id, NULL)
           OR EXISTS (SELECT 1 FROM public.practice_slots s
                       WHERE s.id IN (pa.practice_slot_id, pa.slot_id)
                         AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, s.field_id, s.field_subunit_id)))
      AND (p_after IS NULL
           OR pa.effective_date_range IS NULL
           OR upper_inf(pa.effective_date_range)
           OR b.last_day > p_after)
    UNION ALL
    -- The sixth kind, added by 20260909000000 (LIVE-3). Dated by
    -- `available_until`, which is NOT NULL, so this arm can be neither undated
    -- nor unbounded, and the comparison is written out rather than routed
    -- through a nullable reading.
    SELECT 'availability_profile'::text, fap.id,
           fap.available_until,
           NULL::integer,
           false,
           false,
           true,
           fap.field_id
    FROM public.field_availability_profiles fap
    WHERE fap.organization_id = p_organization_id
      AND public.estate_scope_covers(p_organization_id, p_scope, p_scope_id, fap.field_id, NULL)
      AND (p_after IS NULL OR fap.available_until > p_after);
END;
$function$;

CREATE OR REPLACE FUNCTION public.rollback_field_import_job(p_import_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_record public.import_application_records%ROWTYPE;
    v_previous jsonb;
    v_now timestamptz := now();
    v_pending_record_count integer := 0;
    v_deleted_locations integer := 0;
    v_deleted_fields integer := 0;
    v_deleted_subunits integer := 0;
    v_deleted_practice_slots integer := 0;
    v_deleted_game_slots integer := 0;
    v_restored_records integer := 0;
    v_blocked_records integer := 0;
    v_blocked jsonb := '[]'::jsonb;
    v_affected_count integer;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_job
    FROM public.import_jobs
    WHERE id = p_import_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Import job % not found', p_import_job_id USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.is_org_admin(v_job.organization_id) THEN
        RAISE EXCEPTION 'Access denied: user is not an admin of organization %', v_job.organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*)
    INTO v_pending_record_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND organization_id = v_job.organization_id
      AND import_type = 'fields'
      AND rolled_back_at IS NULL;

    IF v_pending_record_count = 0 THEN
        RAISE EXCEPTION 'Import job % has no field application records to roll back', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    FOR v_record IN
        SELECT *
        FROM public.import_application_records
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'fields'
          AND rolled_back_at IS NULL
        ORDER BY
          CASE target_table
            WHEN 'game_slots' THEN 1
            WHEN 'practice_slots' THEN 2
            WHEN 'field_subunits' THEN 3
            WHEN 'fields' THEN 4
            WHEN 'locations' THEN 5
            ELSE 99
          END,
          applied_at DESC,
          id DESC
    LOOP
        IF v_record.operation = 'inserted' THEN
            IF v_record.target_table = 'game_slots' THEN
                -- **`ga.slot_id` was missing, and its twin one arm down had
                -- it.** `game_assignments` reaches a game slot through TWO
                -- CASCADE columns -- `game_slot_id` and `slot_id`
                -- (20260503030000:39-56) -- and `persist_game_schedule` writes
                -- both, but nothing requires a row to carry both, and this arm
                -- consulted only the first. The `practice_slots` arm below has
                -- always read `slot_id OR practice_slot_id`. Adopting the
                -- sibling's contract rather than inventing a third one is the
                -- rule that produced this migration; the asymmetry was found by
                -- walking the closure from `game_slots`, not by reading the arm.
                IF EXISTS (
                    SELECT 1 FROM public.game_assignments ga
                    WHERE ga.organization_id = v_job.organization_id
                      AND (
                        ga.game_slot_id = v_record.target_id
                        OR ga.slot_id = v_record.target_id
                      )
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'game_slot_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.game_slots gs
                WHERE gs.id = v_record.target_id
                  AND gs.organization_id = v_job.organization_id;
                v_deleted_game_slots := v_deleted_game_slots + 1;
            ELSIF v_record.target_table = 'practice_slots' THEN
                IF EXISTS (
                    SELECT 1 FROM public.practice_assignments pa
                    WHERE pa.organization_id = v_job.organization_id
                      AND (
                        pa.slot_id = v_record.target_id
                        OR pa.practice_slot_id = v_record.target_id
                      )
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'practice_slot_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.practice_slots ps
                WHERE ps.id = v_record.target_id
                  AND ps.organization_id = v_job.organization_id;
                v_deleted_practice_slots := v_deleted_practice_slots + 1;
            ELSIF v_record.target_table = 'field_subunits' THEN
                -- **A COMPLETE cut, not a narrower guard.** The cascade closure
                -- from `field_subunits` is `practice_slots` and, through it
                -- only, `practice_assignments`; there is no
                -- `game_slots.field_subunit_id` and no
                -- `practice_assignments.field_subunit_id`. So nothing
                -- downstream can be destroyed without a practice slot on this
                -- subunit existing, and that is what this refuses on.
                -- `docs/sql/20260909000000_smoke.sql` section 2 re-derives the
                -- closure every run, so the day a second edge appears this
                -- argument fails loudly instead of going quietly stale.
                IF EXISTS (
                    SELECT 1 FROM public.practice_slots ps
                    WHERE ps.organization_id = v_job.organization_id
                      AND ps.field_subunit_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'subunit_in_use');
                    CONTINUE;
                END IF;

                DELETE FROM public.field_subunits fs
                WHERE fs.id = v_record.target_id
                  AND fs.organization_id = v_job.organization_id;
                v_deleted_subunits := v_deleted_subunits + 1;
            ELSIF v_record.target_table = 'fields' THEN
                -- **LIVE-3.** This read `EXISTS practice_slots OR EXISTS
                -- game_slots` and nothing else -- two of the six kinds a field
                -- delete reaches. `public.field_bookings` is the shared
                -- reading, already used by `admin_retire_field` and
                -- `admin_delete_field`; a third hand-written list here is what
                -- guarantees the next correction lands on two of three.
                --
                -- `p_after => NULL` because a rollback removes the ground
                -- outright, exactly as a deletion does: no date applies and
                -- everything on it counts, dated or not.
                --
                -- **Locked before it is counted, in the sibling's form and the
                -- sibling's order.** Without this a booking inserted between
                -- the count and the DELETE below is destroyed by the cascade
                -- having been counted as nothing -- and section 1 of this
                -- migration made that worse, because an availability profile
                -- inserted in the window is now CASCADED rather than unlinked.
                -- `FOR UPDATE` on the field blocks a concurrent INSERT into
                -- anything with a foreign key to it; locking the field's SLOTS
                -- as well covers an assignment carrying only a slot id.
                -- Field first, then its slots, which is the order
                -- `admin_delete_field` takes, so the two cannot deadlock
                -- against each other. The header says why the OTHER arms are
                -- left unlocked and section 1b of the smoke holds them to it.
                PERFORM 1 FROM public.fields f
                 WHERE f.id = v_record.target_id
                   AND f.organization_id = v_job.organization_id
                 FOR UPDATE;
                PERFORM 1 FROM public.game_slots gs
                 WHERE gs.organization_id = v_job.organization_id
                   AND gs.field_id = v_record.target_id
                 FOR UPDATE;
                PERFORM 1 FROM public.practice_slots ps
                 WHERE ps.organization_id = v_job.organization_id
                   AND ps.field_id = v_record.target_id
                 FOR UPDATE;

                SELECT count(*) INTO v_affected_count
                  FROM public.field_bookings(
                         v_job.organization_id, v_record.target_id, NULL);

                IF v_affected_count > 0 THEN
                    v_blocked_records := v_blocked_records + 1;
                    -- **The reason and the count, not just the count.** An
                    -- operator told "3 blocked" cannot act; told which record
                    -- and what holds it, they can. The record keeps
                    -- `rolled_back_at IS NULL`, so clearing the booking and
                    -- re-running rolls it back -- refusal means deferral here
                    -- for the same reason it does in
                    -- finalize_field_availability_import_job.
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'bookings_exist',
                        'affected_count', v_affected_count);
                    CONTINUE;
                END IF;

                -- **No scenario prune here, and that is a consequence
                -- rather than an omission.** `admin_delete_field` needs one
                -- because `p_confirm => true` lets it delete a field that
                -- still carries an availability profile. This arm has no
                -- override: it reaches the DELETE only when the producer
                -- returned NOTHING, and `availability_profile` is one of the
                -- six kinds the producer returns, so a profile on this ground
                -- is unreachable at this line and a prune here would be dead
                -- code presented as a guard. Section 4 of the smoke derives
                -- that distinction from the bodies rather than keeping a list
                -- of which deleter needs one.
                DELETE FROM public.fields f
                WHERE f.id = v_record.target_id
                  AND f.organization_id = v_job.organization_id;
                v_deleted_fields := v_deleted_fields + 1;
            ELSIF v_record.target_table = 'locations' THEN
                -- **A complete cut, like the subunit arm, and for the same
                -- kind of reason.** `locations` is referenced directly by
                -- exactly two tables: `fields` (CASCADE), which this refuses
                -- on, and `field_blackouts` (CASCADE, added by
                -- 20260906000100). Everything else a location delete could
                -- reach is under `fields`, so refusing while any field remains
                -- cuts the whole closure at its only other edge.
                --
                -- `field_blackouts` is EXCLUDED, on 20260907000000's reasoning
                -- for excluding it from the booking family: a closure is not a
                -- booking, and removing a site cannot strand the statement that
                -- the site was already shut. Stated here rather than left
                -- implicit, and re-derived every harness run by
                -- docs/sql/20260909000000_smoke.sql section 2b -- that edge did
                -- not exist when this arm was written and nothing noticed when
                -- 20260906000100 added it.
                IF EXISTS (
                    SELECT 1 FROM public.fields f
                    WHERE f.organization_id = v_job.organization_id
                      AND f.location_id = v_record.target_id
                ) THEN
                    v_blocked_records := v_blocked_records + 1;
                    v_blocked := v_blocked || jsonb_build_object(
                        'kind', v_record.target_table,
                        'id', v_record.target_id,
                        'reason', 'location_has_fields');
                    CONTINUE;
                END IF;

                DELETE FROM public.locations l
                WHERE l.id = v_record.target_id
                  AND l.organization_id = v_job.organization_id;
                v_deleted_locations := v_deleted_locations + 1;
            ELSE
                -- **The arm that used to be missing.** With no ELSE, a record
                -- naming any of the other seven `target_table` values
                -- 20260522120000 admits fell straight through to the ledger
                -- UPDATE below and was stamped `{"deleted": true}` having
                -- deleted nothing -- a lie in the only record of what a
                -- rollback did. DEFENSIVE rather than reachable through the
                -- apply path, which only ever writes the five with
                -- `import_type = 'fields'`: arriving here means the ledger
                -- disagrees with its own import type, and a job whose record
                -- of what it did cannot be trusted must not be half rolled
                -- back on the strength of it. The `ELSE 99` in this
                -- statement's own ORDER BY already conceded the value can
                -- arrive.
                RAISE EXCEPTION
                  'rollback_field_import_job cannot undo an insert into %; the field import applies only locations, fields, field_subunits, practice_slots and game_slots (record %)',
                  v_record.target_table, v_record.id
                  USING ERRCODE = '22023';
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = jsonb_build_object('deleted', true)
            WHERE id = v_record.id;
        ELSIF v_record.operation = 'updated' THEN
            v_previous := v_record.previous_payload;

            IF v_record.target_table = 'locations' THEN
                UPDATE public.locations
                SET
                    name = v_previous->>'name',
                    address = v_previous->>'address',
                    lighting_available = COALESCE((v_previous->>'lighting_available')::boolean, false),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'fields' THEN
                UPDATE public.fields
                SET
                    location_id = (v_previous->>'location_id')::uuid,
                    name = v_previous->>'name',
                    surface_type = v_previous->>'surface_type',
                    size = v_previous->>'size',
                    supports_halves = COALESCE((v_previous->>'supports_halves')::boolean, false),
                    max_age = v_previous->>'max_age',
                    priority_rating = COALESCE((v_previous->>'priority_rating')::integer, 1),
                    active = COALESCE((v_previous->>'active')::boolean, true),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'practice_slots' THEN
                UPDATE public.practice_slots
                SET
                    field_id = (v_previous->>'field_id')::uuid,
                    field_subunit_id = NULLIF(v_previous->>'field_subunit_id', '')::uuid,
                    day_of_week = (v_previous->>'day_of_week')::public.day_of_week,
                    start_time = (v_previous->>'start_time')::time,
                    end_time = (v_previous->>'end_time')::time,
                    capacity = COALESCE((v_previous->>'capacity')::smallint, 1),
                    valid_from = NULLIF(v_previous->>'valid_from', '')::date,
                    valid_until = NULLIF(v_previous->>'valid_until', '')::date,
                    label = v_previous->>'label',
                    -- 20261029010000: the reservation the import replaced
                    -- comes back with the slot. A snapshot taken before the
                    -- column existed says nothing about it, so the slot keeps
                    -- the one it has; a division deleted since restores none.
                    division_id = CASE
                        WHEN NOT (v_previous ? 'division_id') THEN division_id
                        ELSE (SELECT d.id
                                FROM public.divisions d
                               WHERE d.id = NULLIF(v_previous->>'division_id', '')::uuid
                                 AND d.organization_id = v_job.organization_id)
                    END,
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSIF v_record.target_table = 'game_slots' THEN
                UPDATE public.game_slots
                SET
                    field_id = (v_previous->>'field_id')::uuid,
                    division_id = NULLIF(v_previous->>'division_id', '')::uuid,
                    slot_date = NULLIF(v_previous->>'slot_date', '')::date,
                    start_time = NULLIF(v_previous->>'start_time', '')::time,
                    end_time = NULLIF(v_previous->>'end_time', '')::time,
                    week_index = NULLIF(v_previous->>'week_index', '')::smallint,
                    capacity = COALESCE((v_previous->>'capacity')::smallint, 1),
                    updated_at = v_now
                WHERE id = v_record.target_id
                  AND organization_id = v_job.organization_id;
            ELSE
                -- **The same missing arm, one branch down, and worse.** An
                -- unhandled `updated` record was stamped with its previous
                -- payload AND counted in `restored_records` -- a counter
                -- testifying to a restore that never happened, which is the
                -- shape 8.4 PR 2 recorded when `lifecycleNodesJudged` reported
                -- work it had not done. `field_subunits` is genuinely absent
                -- from this list because the apply path never UPDATES one: it
                -- inserts subunits or leaves them, so there is nothing to
                -- restore. That is why the union here is four and the union
                -- above is five.
                RAISE EXCEPTION
                  'rollback_field_import_job cannot restore an update to %; the field import updates only locations, fields, practice_slots and game_slots (record %)',
                  v_record.target_table, v_record.id
                  USING ERRCODE = '22023';
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = v_previous
            WHERE id = v_record.id;

            v_restored_records := v_restored_records + 1;
        END IF;
    END LOOP;

    -- **The trail gets a BOUNDED rendering; the caller gets the whole list.**
    -- One job's ledger can hold a row per CSV line, so a rollback refused on a
    -- busy season would otherwise write an arbitrarily large `blocked` array
    -- into `import_jobs.warning_summary` AND into the audit row, on every
    -- attempt. `public.field_bookings_digest` is the helper 20260907000000
    -- built for exactly this on the refusal path, and its shape is why the
    -- entries above are keyed `kind`/`id` rather than
    -- `target_table`/`target_id`: it counts `by_kind`, so adopting the
    -- sibling's key names makes the per-table refusal counts fall out instead
    -- of needing a third convention.
    v_result := jsonb_build_object(
        'status', CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'rolled_back' END,
        'deleted_locations', v_deleted_locations,
        'deleted_fields', v_deleted_fields,
        'deleted_field_subunits', v_deleted_subunits,
        'deleted_practice_slots', v_deleted_practice_slots,
        'deleted_game_slots', v_deleted_game_slots,
        'restored_records', v_restored_records,
        'blocked_records', v_blocked_records,
        'blocked', public.field_bookings_digest(v_blocked)
    );

    UPDATE public.import_jobs
    SET
        status = CASE WHEN v_blocked_records > 0 THEN 'completed_with_warnings' ELSE 'needs_fix' END,
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{field_rollback}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.rolled_back',
        'import_job',
        p_import_job_id,
        v_result
    );

    -- The caller renders every refusal, so it gets all of them.
    RETURN v_result || jsonb_build_object('blocked', v_blocked);
END;
$function$;

DROP FUNCTION public.copy_legacy_game_scores();
-- RESTRICT makes an unexpected dependent object a migration refusal.
DROP TABLE public.games RESTRICT;
COMMIT;
