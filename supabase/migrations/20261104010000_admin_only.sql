-- Admin only on the server: only league admins sign in, a coach is imported data, and the
-- coach import names each coach's children (plan docs/changes/2026-10-27-admin-only.md, PR 2;
-- owner decisions 2026-10-27; AGENTS.md rule 14: roles, persistence and the domain model).
--
-- **Why.** SquadLogic is for league admins (`admin`, `staff` and `tenant_admin`: staff are admins
-- since 20261020030000). No coach signs in any more. The app stopped calling every coach-facing
-- object in the PR that merged before this one; this migration removes them and narrows the
-- policies that still admitted a coach. Production held (read-only, 2026-10-27, catalogue and
-- counts): 1 organization with 1 member, an `admin`; no `coach`, `staff` or `tenant_admin` member;
-- no invite; 130 coaches in that one organization, every email lower-case and trimmed with no
-- case-insensitive duplicate, `coaches.user_id` set on exactly one (the admin's own account);
-- no `coach_team_requests`, team, calendar token, preference request or permit.
--
-- **The change.**
--   1. Guards. Every function this migration replaces must have the body the repository builds
--      (`md5(replace(prosrc, E'\r', ''))`: production has stored a body with CRLF line ends
--      before), the `coach` role must be held by no member and no invite, and no coach email may
--      be anything but lower-case and trimmed. Any of them stops the migration with nothing
--      changed.
--   2. `facility_permit_json(uuid, date)` is created without the `p_coach_only` parameter (a
--      parameter nobody passes `true` to would be parsed and unread). The four permit writers
--      (20261102010000, bodies unchanged but for that call) and `get_facility_permits` (admin
--      only: 42501 for anyone else) are replaced to use it, then the three-argument function is
--      dropped.
--   3. Read policies narrowed to admins by ALTER POLICY (the storage policy by ALTER POLICY
--      only): `coaches`, `team_coach_assignments`, `team_calendar_tokens`,
--      `coach_practice_preferences`, `practice_lighting_overrides`, `facility_permits`,
--      `facility_permit_scopes` and the `facility-permits` objects. Those with "coach" in the
--      name are renamed (the storage policy keeps its name).
--   4. `get_team_roster`, `get_team_staff` and `rotate_calendar_token` lose their current-coach
--      arm. `create_org_invite` and `admin_change_member_role` admit `admin` and `staff` only
--      (22023); the last-admin guard of the latter could no longer fire and goes.
--   5. Dropped, exact signatures, no CASCADE, dependents first: `link_my_coach_record()`
--      (the `coach.linked` audit action stays registered for its one old row),
--      `get_my_division_teams(uuid)`, `admin_get_division_teams(uuid, uuid)`,
--      `division_teams_of(uuid, uuid)`, `get_my_coached_team_ids(uuid)`,
--      `admin_get_coached_team_ids(uuid, uuid)`, `request_coach_practice_preference(uuid, text,
--      text, jsonb)` (admins keep `admin_set_` and `admin_decide_coach_practice_preference`),
--      `caller_coaches_practice_slot(uuid)`, `coach_reads_facility_permit_file(uuid, text)`,
--      `coach_reads_facility_permit(uuid)`, `coach_covers_permit_scope(uuid, uuid, uuid)`,
--      `coach_field_ids_of(uuid, uuid)`, `coached_team_ids_of(uuid, uuid)`,
--      `is_current_team_coach(uuid)`.
--   6. `organization_members_role_check` (admin, staff, tenant_admin) and
--      `organization_invites_role_check` (admin, staff) lose `coach`. `is_org_member(uuid)` is
--      unchanged: with no `coach` role a member is an admin-equivalent, so every member-wide
--      read (teams, games, slots, the `exports` and `raw-imports` objects) is an admin read by
--      construction; supabase/tests/admin_only.sql pins the role list.
--   7. A coach is one row per organization and email: `coaches_email_key` (UNIQUE (email)) is
--      replaced by `CHECK (email = lower(btrim(email)))` and `UNIQUE (organization_id, email)`.
--      A coach who serves two clubs is two rows, one per organization. The email stays as the
--      import's key and the admins' contact; it is no sign-in.
--   8. The coach import (S7). `import_allowed_keys('coaches')` gains `child_registration_id`
--      (the browser and Edge allowlists change with it; tests/importAllowlistParity.test.js
--      holds all three equal). `finalize_coach_import_job` looks a coach up within the job's
--      organization (the cross-organization refusal goes), and when the file has the column
--      replaces the coach's `coach_team_requests` with one row per registration id that matches
--      a player of the same organization, in the order the file lists them; an id that matches
--      no player is listed in the result (`unmatched_child_ids`, at most 200, and their count)
--      and is never fatal. `rollback_coach_import_job` puts back the links an update replaced.
--   9. `reconcile_prod_rls_drift()` is replaced: its spec names `coaches_select_admin`, an
--      expression without `user_id`, so the probe `CREATE POLICY` still works once the column
--      goes (20261104020000).
--  10. An end-state check.
--
-- No DDL touches the auth or storage schemas beyond ALTER POLICY on `storage.objects`
-- (20261030010000 ran the same statement in production). `coaches.user_id` and `profile_id` are
-- dropped apart, by 20261104020000, so a refusal there leaves this one applied.
--
-- Reversible in structure only: docs/sql/20261104010000_revert.sql restores every dropped or
-- replaced object (the coach arms, the roles, the global email key, the three-argument
-- `facility_permit_json`); it cannot restore the links an import wrote. Smoke:
-- docs/sql/20261104010000_smoke.sql. pgTAP: supabase/tests/admin_only.sql,
-- supabase/tests/import_allowlist.sql and supabase/tests/coach_import_apply_rollback.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The guards.
-- ---------------------------------------------------------------------------

DO $guard$
DECLARE
    v_spec record;
    v_md5 text;
    v_members bigint;
    v_invites bigint;
    v_bad_emails bigint;
    v_coaches bigint;
    v_linked bigint;
BEGIN
    -- Carriage returns stripped: production has stored a body with CRLF line ends before
    -- (upsert_division_for_import, which stopped the first deploy of 20261101010000), and the guard
    -- is about the text, not the line ends.
    FOR v_spec IN
        SELECT * FROM (VALUES
            ('public.create_org_invite(uuid, text, interval)',                                      'a14670ad16ade158735d6edfe3c78bee'),
            ('public.admin_change_member_role(uuid, uuid, text)',                                   'eedbb3c290f906827133142cf7c02463'),
            ('public.get_team_roster(uuid)',                                                        'b2e8c083fc296bdadd7ea1f28822a65f'),
            ('public.get_team_staff(uuid)',                                                         'd4ef33a7819515caa050a771195b7fb0'),
            ('public.rotate_calendar_token(uuid)',                                                  '0412b65885efc6d4e66659f4396f6bb4'),
            ('public.facility_permit_json(uuid, date, boolean)',                                    'e6bc94704099df5cb0d0b699170adf2a'),
            ('public.admin_create_facility_permit(uuid, text, text, date, date, text, uuid[], uuid[])', '5e8b351d26442ddb428c6a1522dbfff0'),
            ('public.admin_update_facility_permit(uuid, uuid, text, text, date, date, text, uuid[], uuid[])', '6bf9ee2bcc31c6989828bc5402cdec00'),
            ('public.admin_set_facility_permit_file(uuid, uuid, text, text)',                       '4d6704fed7c9d9f0feff172284269b05'),
            ('public.admin_delete_facility_permit(uuid, uuid)',                                     'b7eacc504ee58a576f89edd5353a9177'),
            ('public.get_facility_permits(uuid)',                                                   'ea605b9d6a9992bf30e40e0dd8a66999'),
            ('public.import_allowed_keys(text)',                                                    '3e6c0afb588d43e824c5075488667e66'),
            ('public.finalize_coach_import_job(uuid, jsonb)',                                       'c0df3825f490d5644c9fe1179cc42e7f'),
            ('public.rollback_coach_import_job(uuid)',                                              'e6aff1f5fad278537d1dd989c5d57719'),
            ('public.reconcile_prod_rls_drift()',                                                   'bbdc088ff95790c31379270083b219a2')
        ) AS s(signature, expected_md5)
    LOOP
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure(v_spec.signature);
        IF v_md5 IS DISTINCT FROM v_spec.expected_md5 THEN
            RAISE EXCEPTION '% has a body this migration has not seen (md5 %): not replacing it',
                v_spec.signature, v_md5 USING ERRCODE = '55000';
        END IF;
    END LOOP;

    -- A member's access is a decision for an admin, not for a migration. Every invite counts, used
    -- or not: the new CHECK is judged on every row.
    SELECT count(*) INTO v_members FROM public.organization_members WHERE role = 'coach';
    SELECT count(*) INTO v_invites FROM public.organization_invites WHERE role = 'coach';
    IF v_members > 0 OR v_invites > 0 THEN
        RAISE EXCEPTION 'refusing to remove the coach role: % member(s) and % invite(s) still hold it',
            v_members, v_invites USING ERRCODE = '55000';
    END IF;

    SELECT count(*) INTO v_bad_emails FROM public.coaches WHERE email <> lower(btrim(email));
    IF v_bad_emails > 0 THEN
        RAISE EXCEPTION 'refusing to require lower-case, trimmed coach emails: % coach(es) hold another form',
            v_bad_emails USING ERRCODE = '55000';
    END IF;

    SELECT count(*), count(*) FILTER (WHERE user_id IS NOT NULL) INTO v_coaches, v_linked FROM public.coaches;
    RAISE NOTICE 'no coach signs in: % coach record(s), % of them linked to a sign-in account (the link is dropped by 20261104020000)',
        v_coaches, v_linked;
END;
$guard$;

-- ---------------------------------------------------------------------------
-- 2. The permit view without the coach parameter, and its callers.
-- ---------------------------------------------------------------------------

-- Internal. A permit as the RPCs return it; an admin's read shows every scope.
CREATE FUNCTION public.facility_permit_json(p_permit_id uuid, p_today date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'id', p.id,
        'organization_id', p.organization_id,
        'issuer', p.issuer,
        'permit_number', p.permit_number,
        'valid_from', p.valid_from,
        'valid_to', p.valid_to,
        'notes', p.notes,
        'status', public.facility_permit_status(p.valid_from, p.valid_to, p_today),
        'days_left', p.valid_to - p_today,
        'file', CASE WHEN p.file_path IS NULL THEN NULL
                     ELSE jsonb_build_object('path', p.file_path, 'name', p.file_name,
                                             'mime', p.file_mime, 'size', p.file_size) END,
        'scopes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', s.id,
                       'kind', CASE WHEN s.field_id IS NOT NULL THEN 'field' ELSE 'location' END,
                       'field_id', s.field_id,
                       'location_id', COALESCE(s.location_id, f.location_id),
                       'field_name', f.name,
                       'location_name', COALESCE(l.name, fl.name),
                       -- Retired: the field's or its venue's end date has passed (by containment).
                       'retired', NOT (public.field_is_live_on(f.effective_to, p_today)
                                       AND public.field_is_live_on(COALESCE(l.effective_to, fl.effective_to), p_today))
                   ) ORDER BY COALESCE(l.name, fl.name), f.name NULLS FIRST, s.id)
              FROM public.facility_permit_scopes s
              LEFT JOIN public.fields f ON f.id = s.field_id
              LEFT JOIN public.locations l ON l.id = s.location_id
              LEFT JOIN public.locations fl ON fl.id = f.location_id
             WHERE s.permit_id = p.id
        ), '[]'::jsonb),
        'created_at', p.created_at,
        'updated_at', p.updated_at
    )
    FROM public.facility_permits p
    WHERE p.id = p_permit_id;
$$;

REVOKE ALL ON FUNCTION public.facility_permit_json(uuid, date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.facility_permit_json(uuid, date) IS
    'Internal: a permit as the RPCs return it: its fields, status and days_left on p_today, the file (path, name, mime, size) or null, and all its scopes with names and a retired flag. 20261102010000; coach parameter out 20261104010000.';

CREATE OR REPLACE FUNCTION public.admin_create_facility_permit(
    p_organization_id uuid,
    p_issuer text,
    p_permit_number text,
    p_valid_from date,
    p_valid_to date,
    p_notes text,
    p_location_ids uuid[],
    p_field_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_issuer text := btrim(COALESCE(p_issuer, ''));
    v_number text := NULLIF(btrim(COALESCE(p_permit_number, '')), '');
    v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
    v_locations uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_location_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_fields uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_field_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_permit public.facility_permits%ROWTYPE;
    v_view jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_valid_from IS NULL OR p_valid_to IS NULL THEN
        RAISE EXCEPTION 'a permit needs the dates it is valid from and to' USING ERRCODE = '23502';
    END IF;

    PERFORM public.facility_permit_check(v_issuer, v_number, v_notes, p_valid_from, p_valid_to,
                                         v_locations, v_fields, p_organization_id);

    INSERT INTO public.facility_permits (organization_id, issuer, permit_number, valid_from, valid_to, notes, created_by)
    VALUES (p_organization_id, v_issuer, v_number, p_valid_from, p_valid_to, v_notes, auth.uid())
    RETURNING * INTO v_permit;

    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, location_id)
    SELECT v_permit.id, p_organization_id, x FROM unnest(v_locations) x;
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id)
    SELECT v_permit.id, p_organization_id, x FROM unnest(v_fields) x;

    v_view := public.facility_permit_json(v_permit.id, public.org_local_today(p_organization_id));

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', v_permit.id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'created', 'current', v_view)
    );

    RETURN v_view;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_facility_permit(
    p_organization_id uuid,
    p_permit_id uuid,
    p_issuer text,
    p_permit_number text,
    p_valid_from date,
    p_valid_to date,
    p_notes text,
    p_location_ids uuid[],
    p_field_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_issuer text := btrim(COALESCE(p_issuer, ''));
    v_number text := NULLIF(btrim(COALESCE(p_permit_number, '')), '');
    v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
    v_locations uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_location_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_fields uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_field_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL);
    v_today date;
    v_permit public.facility_permits%ROWTYPE;
    v_previous jsonb;
    v_view jsonb;
BEGIN
    IF p_organization_id IS NULL OR p_permit_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_permit_id are required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_valid_from IS NULL OR p_valid_to IS NULL THEN
        RAISE EXCEPTION 'a permit needs the dates it is valid from and to' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_permit FROM public.facility_permits
     WHERE id = p_permit_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'permit % was not found in organization %', p_permit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.facility_permit_check(v_issuer, v_number, v_notes, p_valid_from, p_valid_to,
                                         v_locations, v_fields, p_organization_id);

    v_today := public.org_local_today(p_organization_id);
    v_previous := public.facility_permit_json(p_permit_id, v_today);

    UPDATE public.facility_permits
       SET issuer = v_issuer, permit_number = v_number, valid_from = p_valid_from,
           valid_to = p_valid_to, notes = v_notes
     WHERE id = p_permit_id;

    -- The scope set is replaced: what is no longer named goes, what is new is added, what stays is untouched.
    DELETE FROM public.facility_permit_scopes s
     WHERE s.permit_id = p_permit_id
       AND NOT (COALESCE(s.location_id = ANY (v_locations), false)
                OR COALESCE(s.field_id = ANY (v_fields), false));
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, location_id)
    SELECT p_permit_id, p_organization_id, x FROM unnest(v_locations) x
     WHERE NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes s WHERE s.permit_id = p_permit_id AND s.location_id = x);
    INSERT INTO public.facility_permit_scopes (permit_id, organization_id, field_id)
    SELECT p_permit_id, p_organization_id, x FROM unnest(v_fields) x
     WHERE NOT EXISTS (SELECT 1 FROM public.facility_permit_scopes s WHERE s.permit_id = p_permit_id AND s.field_id = x);

    v_view := public.facility_permit_json(p_permit_id, v_today);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'updated',
                           'previous', v_previous, 'current', v_view)
    );

    RETURN v_view;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_facility_permit_file(
    p_organization_id uuid,
    p_permit_id uuid,
    p_object_path text,
    p_file_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    c_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    v_name text := btrim(COALESCE(p_file_name, ''));
    v_permit public.facility_permits%ROWTYPE;
    v_meta jsonb;
    v_mime text;
    v_size bigint;
    v_today date;
    v_previous jsonb;
    v_view jsonb;
BEGIN
    IF p_organization_id IS NULL OR p_permit_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_permit_id are required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_object_path IS NULL OR v_name = '' THEN
        RAISE EXCEPTION 'p_object_path and p_file_name are required' USING ERRCODE = '23502';
    END IF;
    IF char_length(v_name) > 255 OR v_name ~ '[/\\]' THEN
        RAISE EXCEPTION 'the file name must be 1 to 255 characters with no slash' USING ERRCODE = '22023', DETAIL = 'file_name';
    END IF;

    SELECT * INTO v_permit FROM public.facility_permits
     WHERE id = p_permit_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'permit % was not found in organization %', p_permit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    -- The object is <organization>/<permit>/<uuid>.<ext>: this permit's own folder, nothing else.
    -- The two folders are compared exactly (a stored path is checked against the permit's own
    -- lowercase ids by the table's CHECK); the file's name and extension are read without regard to case.
    IF array_length(string_to_array(p_object_path, '/'), 1) IS DISTINCT FROM 3
       OR split_part(p_object_path, '/', 1) <> p_organization_id::text
       OR split_part(p_object_path, '/', 2) <> p_permit_id::text
       OR split_part(p_object_path, '/', 3) !~* ('^' || c_uuid || '\.(pdf|jpg|jpeg|png)$') THEN
        RAISE EXCEPTION 'the object must be <organization>/<permit>/<uuid>.<pdf|jpg|jpeg|png> in this permit''s folder'
            USING ERRCODE = '22023', DETAIL = 'object_path';
    END IF;
    IF v_permit.file_path IS NOT DISTINCT FROM p_object_path THEN
        RAISE EXCEPTION 'that object is already this permit''s file' USING ERRCODE = '22023', DETAIL = 'already_attached';
    END IF;

    -- It must really be there, and be what the bucket's limits admit. The Storage API enforces the
    -- bucket's type and size on upload; this reads what it recorded.
    SELECT o.metadata INTO v_meta FROM storage.objects o
     WHERE o.bucket_id = 'facility-permits' AND o.name = p_object_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no uploaded object %', p_object_path USING ERRCODE = '22023', DETAIL = 'object_missing';
    END IF;
    v_mime := v_meta ->> 'mimetype';
    IF v_mime IS NULL OR v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png') THEN
        RAISE EXCEPTION 'the object is %, not a PDF, JPEG or PNG', COALESCE(v_mime, 'of unknown type')
            USING ERRCODE = '22023', DETAIL = 'file_type';
    END IF;
    IF (v_meta ->> 'size') IS NULL OR (v_meta ->> 'size') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'the object has no readable size' USING ERRCODE = '22023', DETAIL = 'file_size';
    END IF;
    v_size := (v_meta ->> 'size')::bigint;
    IF v_size < 1 OR v_size > 10485760 THEN
        RAISE EXCEPTION 'the object is % bytes; a permit file is 1 byte to 10 MiB', v_size
            USING ERRCODE = '22023', DETAIL = 'file_size';
    END IF;

    v_today := public.org_local_today(p_organization_id);
    v_previous := public.facility_permit_json(p_permit_id, v_today);

    UPDATE public.facility_permits
       SET file_path = p_object_path, file_name = v_name, file_mime = v_mime, file_size = v_size
     WHERE id = p_permit_id;

    v_view := public.facility_permit_json(p_permit_id, v_today);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit',
                           'operation', CASE WHEN v_permit.file_path IS NULL THEN 'file_attached' ELSE 'file_replaced' END,
                           'previous_file', v_previous -> 'file', 'current_file', v_view -> 'file')
    );

    RETURN jsonb_build_object('permit', v_view, 'previous_path', v_permit.file_path);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_facility_permit(p_organization_id uuid, p_permit_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_permit public.facility_permits%ROWTYPE;
    v_previous jsonb;
BEGIN
    IF p_organization_id IS NULL OR p_permit_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id and p_permit_id are required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_permit FROM public.facility_permits
     WHERE id = p_permit_id AND organization_id = p_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'permit % was not found in organization %', p_permit_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    v_previous := public.facility_permit_json(p_permit_id, public.org_local_today(p_organization_id));

    DELETE FROM public.facility_permits WHERE id = p_permit_id;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'deleted', 'previous', v_previous)
    );

    RETURN jsonb_build_object('id', p_permit_id, 'deleted', true, 'file_path', v_permit.file_path);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_facility_permits(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_today date;
    v_permits jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: permits are read by an administrator' USING ERRCODE = '42501';
    END IF;

    v_today := public.org_local_today(p_organization_id);

    SELECT COALESCE(jsonb_agg(public.facility_permit_json(p.id, v_today)
                              ORDER BY p.valid_to, p.issuer, p.id), '[]'::jsonb)
      INTO v_permits
      FROM public.facility_permits p
     WHERE p.organization_id = p_organization_id;

    RETURN jsonb_build_object('today', v_today, 'lead_days', 30, 'permits', v_permits);
END;
$$;

COMMENT ON FUNCTION public.get_facility_permits(uuid) IS
    'An admin or staff member reads every permit of the organization; anyone else gets 42501. Returns {today, lead_days, permits}: each permit with scope names, a retired flag per scope, and status and days_left on the organization''s own day. 20261102010000; coach read out 20261104010000.';

DROP FUNCTION public.facility_permit_json(uuid, date, boolean);

-- ---------------------------------------------------------------------------
-- 3. The read policies: admins only.
-- ---------------------------------------------------------------------------
--
-- Each was an admin arm OR a coach arm. The coach arms named `coaches.user_id`, the helpers dropped
-- below, or a coach's own row; none of them can hold now. Renamed where the name said "coach".

ALTER POLICY coaches_select_admin_or_self ON public.coaches RENAME TO coaches_select_admin;
ALTER POLICY coaches_select_admin ON public.coaches
    USING (public.is_org_admin(organization_id));

ALTER POLICY team_coach_assignments_select_admin_or_self ON public.team_coach_assignments
    RENAME TO team_coach_assignments_select_admin;
ALTER POLICY team_coach_assignments_select_admin ON public.team_coach_assignments
    USING (public.is_org_admin(organization_id));

ALTER POLICY team_calendar_tokens_select ON public.team_calendar_tokens
    USING (public.is_org_admin((SELECT t.organization_id FROM public.teams t WHERE t.id = team_id)));

COMMENT ON TABLE public.team_calendar_tokens IS
    'A team''s calendar feed credential, moved out of teams so only admins and staff read it. Written by the teams insert trigger and rotate_calendar_token only. 20261021020000; guardians out 20261024010000; coaches out 20261104010000.';

ALTER POLICY "Coach practice preferences: admins and the coach read" ON public.coach_practice_preferences
    RENAME TO "Coach practice preferences: admins read";
ALTER POLICY "Coach practice preferences: admins read" ON public.coach_practice_preferences
    USING (public.is_org_admin(organization_id));

ALTER POLICY "Practice lighting overrides: admins and the slot's coaches read" ON public.practice_lighting_overrides
    RENAME TO "Practice lighting overrides: admins read";
ALTER POLICY "Practice lighting overrides: admins read" ON public.practice_lighting_overrides
    USING (public.is_org_admin(organization_id));

ALTER POLICY "Facility permits: admins and scheduled coaches select" ON public.facility_permits
    RENAME TO "Facility permits: admins select";
ALTER POLICY "Facility permits: admins select" ON public.facility_permits
    USING (public.is_org_admin(organization_id));

ALTER POLICY "Facility permit scopes: admins and scheduled coaches select" ON public.facility_permit_scopes
    RENAME TO "Facility permit scopes: admins select";
ALTER POLICY "Facility permit scopes: admins select" ON public.facility_permit_scopes
    USING (public.is_org_admin(organization_id));

-- storage.objects: ALTER POLICY only (the table is not postgres's to own). The object name must still
-- be <organization uuid>/<permit uuid>/<uuid>.<pdf|jpg|jpeg|png>, judged before any cast.
ALTER POLICY "facility-permits select" ON storage.objects
    USING (
        bucket_id = 'facility-permits'
        AND CASE
            WHEN name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

-- ---------------------------------------------------------------------------
-- 4. Reads and writes without the current-coach arm.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_team_roster(p_team_id uuid)
RETURNS TABLE (
    player_id uuid,
    first_name text,
    last_name text,
    preferred_name text,
    jersey_number smallint,
    gender text,
    years_played smallint,
    rating smallint,
    willing_to_coach boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_team_roster requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    SELECT t.organization_id INTO v_org FROM public.teams t WHERE t.id = p_team_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'not permitted to read this team''s roster' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT p.id,
           p.first_name,
           p.last_name,
           p.preferred_name,
           p.jersey_number,
           p.gender,
           p.years_played,
           p.rating,
           p.willing_to_coach
      FROM public.team_players tp
      JOIN public.players p ON p.id = tp.player_id
     WHERE tp.team_id = p_team_id
     ORDER BY p.last_name, p.first_name, p.id;
END;
$$;

COMMENT ON FUNCTION public.get_team_roster(uuid) IS
    'Team roster: admins and staff read names, jersey number, gender, years played, rating and coaching interest; anyone else gets 42501. No contact details. 20261021010000; guardians out 20261024010000; contacts out 20261025010000; coaches out 20261104010000.';

CREATE OR REPLACE FUNCTION public.get_team_staff(p_team_id uuid)
RETURNS TABLE (
    coach_id uuid,
    full_name text,
    role text,
    status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_org uuid;
    v_today date;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'get_team_staff requires a signed-in caller' USING ERRCODE = '42501';
    END IF;
    SELECT t.organization_id INTO v_org FROM public.teams t WHERE t.id = p_team_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'not permitted to read this team''s staff' USING ERRCODE = '42501';
    END IF;
    v_today := public.team_local_today(p_team_id);

    RETURN QUERY
    SELECT c.id,
           c.full_name,
           a.role,
           c.status
      FROM public.team_coach_assignments a
      JOIN public.coaches c ON c.id = a.coach_id
     WHERE a.team_id = p_team_id
       AND a.effective_from <= v_today
       AND (a.effective_to IS NULL OR a.effective_to >= v_today)
     ORDER BY (a.role = 'lead') DESC, c.full_name, c.id;
END;
$$;

COMMENT ON FUNCTION public.get_team_staff(uuid) IS
    'Current coaches of a team: name, role and status, to admins and staff only (anyone else gets 42501). No contact details. 20261021010000; guardians out 20261024010000; contacts out 20261025010000; coaches out 20261104010000.';

CREATE OR REPLACE FUNCTION public.rotate_calendar_token(p_team_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new_token uuid := gen_random_uuid();
    v_org_id uuid;
    v_expires timestamptz := now() + interval '90 days';
BEGIN
    SELECT organization_id INTO v_org_id FROM public.teams WHERE id = p_team_id;

    -- An unknown team and a refused caller answer alike.
    IF v_org_id IS NULL OR NOT public.is_org_admin(v_org_id) THEN
        RETURN json_build_object('status', 'error', 'message', 'Access denied');
    END IF;

    INSERT INTO public.team_calendar_tokens (team_id, token, expires_at, rotated_at)
    VALUES (p_team_id, v_new_token, v_expires, now())
    ON CONFLICT (team_id) DO UPDATE
       SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at, rotated_at = EXCLUDED.rotated_at;

    PERFORM public.record_audit_event(
        v_org_id,
        'calendar.token_rotated',
        'team',
        p_team_id,
        jsonb_build_object('new_expires_at', v_expires::text)
    );

    RETURN json_build_object(
        'status', 'success',
        'calendar_token', v_new_token,
        'expires_at', v_expires::text
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The roles.
-- ---------------------------------------------------------------------------

ALTER TABLE public.organization_members DROP CONSTRAINT organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
    CHECK (role = ANY (ARRAY['admin'::text, 'staff'::text, 'tenant_admin'::text]));

ALTER TABLE public.organization_invites DROP CONSTRAINT organization_invites_role_check;
ALTER TABLE public.organization_invites ADD CONSTRAINT organization_invites_role_check
    CHECK (role = ANY (ARRAY['admin'::text, 'staff'::text]));

CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_org_id     uuid,
  p_role       text,
  p_expires_in interval DEFAULT interval '7 days'
)
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code       text;
  v_expires_at timestamptz;
  v_attempts   int := 0;
BEGIN
  -- Authz: caller must be admin of the target org.
  IF NOT public.is_org_admin(p_org_id) THEN
    RAISE EXCEPTION 'Not authorized to create invites for this organization'
      USING ERRCODE = '42501';  -- insufficient_privilege
  END IF;

  -- Role whitelist (matches the CHECK constraint): only league admins sign in.
  IF p_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role USING ERRCODE = '22023';
  END IF;

  v_expires_at := CASE
    WHEN p_expires_in IS NULL THEN NULL
    ELSE now() + p_expires_in
  END;

  -- Retry up to 5 times on code collision (probability ≈ 0 at current volume).
  LOOP
    v_attempts := v_attempts + 1;
    v_code := public.generate_invite_code();
    BEGIN
      INSERT INTO public.organization_invites (code, organization_id, role, created_by, expires_at)
      VALUES (v_code, p_org_id, p_role, auth.uid(), v_expires_at);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempts >= 5 THEN
        RAISE EXCEPTION 'Could not generate a unique invite code after % attempts', v_attempts;
      END IF;
    END;
  END LOOP;

  RETURN QUERY SELECT v_code, v_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_change_member_role(
    p_organization_id uuid,
    p_profile_id      uuid,
    p_role            text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_id   uuid := auth.uid();
    v_old_role    text;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_profile_id IS NULL THEN
        RAISE EXCEPTION 'p_profile_id is required' USING ERRCODE = '23502';
    END IF;
    IF p_role IS NULL OR p_role NOT IN ('admin', 'staff') THEN
        RAISE EXCEPTION 'invalid role: %', p_role USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT role INTO v_old_role
    FROM public.organization_members
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Member not found in organization' USING ERRCODE = 'P0002';
    END IF;

    -- No last-admin guard: the roles a member can be given are 'admin' and 'staff', and staff are
    -- admins (20261020030000), so a change of role never removes the organization's last admin.
    UPDATE public.organization_members
    SET role = p_role
    WHERE organization_id = p_organization_id AND profile_id = p_profile_id;

    IF v_old_role IS DISTINCT FROM p_role THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'member.role_changed',
            'organization_members',
            p_profile_id,
            jsonb_build_object('previous_role', v_old_role, 'role', p_role)
        );
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. The coach-only functions, dependents first. No CASCADE: anything still using one fails here.
-- ---------------------------------------------------------------------------

DROP FUNCTION public.link_my_coach_record();
DROP FUNCTION public.get_my_division_teams(uuid);
DROP FUNCTION public.admin_get_division_teams(uuid, uuid);
DROP FUNCTION public.division_teams_of(uuid, uuid);
DROP FUNCTION public.get_my_coached_team_ids(uuid);
DROP FUNCTION public.admin_get_coached_team_ids(uuid, uuid);
DROP FUNCTION public.request_coach_practice_preference(uuid, text, text, jsonb);
DROP FUNCTION public.caller_coaches_practice_slot(uuid);
DROP FUNCTION public.coach_reads_facility_permit_file(uuid, text);
DROP FUNCTION public.coach_reads_facility_permit(uuid);
DROP FUNCTION public.coach_covers_permit_scope(uuid, uuid, uuid);
DROP FUNCTION public.coach_field_ids_of(uuid, uuid);
DROP FUNCTION public.coached_team_ids_of(uuid, uuid);
DROP FUNCTION public.is_current_team_coach(uuid);

-- ---------------------------------------------------------------------------
-- 7. A coach is one row per organization and email.
-- ---------------------------------------------------------------------------

ALTER TABLE public.coaches DROP CONSTRAINT coaches_email_key;
ALTER TABLE public.coaches ADD CONSTRAINT coaches_email_normalised
    CHECK (email = lower(btrim(email)));
ALTER TABLE public.coaches ADD CONSTRAINT coaches_organization_id_email_key
    UNIQUE (organization_id, email);

COMMENT ON COLUMN public.coaches.email IS
    'The import''s key and an admin''s contact; no coach signs in. Lower-case and trimmed (coaches_email_normalised), unique within the organization (coaches_organization_id_email_key). 20261104010000.';

-- ---------------------------------------------------------------------------
-- 8. The coach import names each coach's children.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.import_allowed_keys(p_import_type text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE p_import_type
        WHEN 'players' THEN ARRAY[
            'first_name', 'last_name', 'preferred_name', 'nickname', 'external_registration_id',
            'gotsport_id', 'registration_id', 'player_id', 'natural_age',
            'age group', 'age_group', 'age', 'gender', 'grade', 'division_id', 'division_name',
            'division', 'group', 'program', 'skill_tier', 'skill_level', 'years_played',
            'years played',
            'how many years has your player played in an organized soccer program?', 'waitlist',
            'waitlisted', 'play_up', 'play up',
            'are you coaching so this player can play up a division?', 'willing_to_coach',
            'coach_volunteer', 'can you coach for this player''s team?', 'buddy_request',
            'buddy_id', 'buddy_external_registration_id', 'buddy_registration_id',
            'friend_request', 'mutual_buddy_code', 'buddy_code', 'friend_code', 'team name',
            'team age', 'team gender'
        ]::text[]
        WHEN 'coaches' THEN ARRAY[
            'full_name', 'email', 'status', 'coach_status', 'can_coach_multiple_teams',
            'multiple_teams', 'multi_team', 'certifications', 'certification',
            'child_registration_id', 'first_name', 'last_name'
        ]::text[]
        ELSE ARRAY[]::text[]
    END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_coach_import_job(
    p_import_job_id uuid,
    p_validation_errors jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_row public.staging_import_rows%ROWTYPE;
    v_existing public.coaches%ROWTYPE;
    v_after public.coaches%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_email text;
    v_full_name text;
    v_status text;
    v_can_multi_text text;
    v_can_multi boolean;
    v_certifications jsonb;
    v_contact_info jsonb;
    v_custom_attributes jsonb;
    v_declared jsonb;
    v_previous_payload jsonb;
    v_existing_found boolean;
    v_inserted_count integer := 0;
    v_updated_count integer := 0;
    v_invalid_count integer := 0;
    -- S7 (admin-only plan): the coach's children, named by player registration id.
    v_child record;
    v_player_id uuid;
    v_slot integer;
    v_previous_links jsonb;
    v_linked_count integer := 0;
    v_unmatched jsonb := '[]'::jsonb;
    v_unmatched_count integer := 0;
    v_blocked_assignment_count integer := 0;
    v_total_applied_count integer := 0;
    v_status_result text;
    v_result jsonb;
BEGIN
    IF p_import_job_id IS NULL THEN
        RAISE EXCEPTION 'p_import_job_id is required' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_validation_errors) <> 'array' THEN
        RAISE EXCEPTION 'p_validation_errors must be a jsonb array' USING ERRCODE = '22023';
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

    IF v_job.job_type <> 'registration' THEN
        RAISE EXCEPTION 'Import job % is %, not registration', p_import_job_id, v_job.job_type
            USING ERRCODE = '22023';
    END IF;

    IF v_job.status = 'failed' THEN
        RAISE EXCEPTION 'Failed import job % cannot be finalized', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    -- The organization's declared coach fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'coach');

    -- Deliberately row-oriented for the coach slice: each applied row needs an
    -- exact rollback snapshot and independent conflict outcome. The Edge
    -- Function caps imports at 5,000 rows; set-based promotion can replace
    -- this once field-slot promotion shares the same ledger.
    FOR v_row IN
        SELECT *
        FROM public.staging_import_rows
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'coaches'
          AND applied_at IS NULL
          AND normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(validation_errors), 0) = 0
        ORDER BY source_row_number NULLS LAST, id
    LOOP
        v_email := lower(public.import_payload_text(v_row.normalized_payload, 'email'));
        v_full_name := public.import_payload_text(v_row.normalized_payload, 'full_name');
        v_status := lower(COALESCE(
            public.import_payload_text(v_row.normalized_payload, 'status', 'coach_status'),
            'active'
        ));
        v_can_multi_text := public.import_payload_text(
            v_row.normalized_payload,
            'can_coach_multiple_teams',
            'multiple_teams',
            'multi_team'
        );
        v_certifications := public.import_text_to_jsonb_array(
            public.import_payload_text(v_row.normalized_payload, 'certifications', 'certification')
        );
        -- The coach's email is the import's key and an admin's contact; no coach signs in
        -- and no phone is stored (R0).
        v_contact_info := jsonb_strip_nulls(jsonb_build_object('email', v_email));
        -- The allowlist (R0): only the fields the organization declared for
        -- coaches, keyed by their declared names. Every other column of the
        -- export (a child's details, guardians' addresses and phones, the
        -- coach's own birth date) is dropped here, whatever reached staging.
        v_custom_attributes := public.import_declared_attributes(v_declared, v_row.normalized_payload);

        IF v_email IS NULL
           OR v_full_name IS NULL
           OR v_status NOT IN ('active', 'pending-confirmation', 'inactive') THEN
            v_invalid_count := v_invalid_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Coach row is missing full_name/email or has an invalid status',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        -- A coach is one row per organization and email (20261104010000): the same address in
        -- another organization is another coach, never a conflict.
        SELECT *
        INTO v_existing
        FROM public.coaches c
        WHERE c.organization_id = v_job.organization_id
          AND c.email = v_email;
        v_existing_found := FOUND;

        IF v_existing_found
           AND v_status = 'inactive'
           AND EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.organization_id = v_job.organization_id
                  AND (
                    t.coach_id = v_existing.id
                    OR v_existing.id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
                  )
           ) THEN
            v_blocked_assignment_count := v_blocked_assignment_count + 1;
            UPDATE public.staging_import_rows
            SET validation_errors = jsonb_build_array(jsonb_build_object(
                    'message', 'Assigned coaches cannot be marked inactive by import',
                    'source_row_number', v_row.source_row_number
                ))
            WHERE id = v_row.id;
            CONTINUE;
        END IF;

        IF v_existing_found THEN
            v_previous_payload := to_jsonb(v_existing);
            -- The links this row is about to replace, kept for the rollback.
            IF v_row.normalized_payload ? 'child_registration_id' THEN
                SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', r.player_id, 'slot', r.slot)
                                          ORDER BY r.slot), '[]'::jsonb)
                  INTO v_previous_links
                  FROM public.coach_team_requests r
                 WHERE r.organization_id = v_job.organization_id
                   AND r.coach_id = v_existing.id
                   AND r.player_id IS NOT NULL;
                v_previous_payload := v_previous_payload || jsonb_build_object('child_links', v_previous_links);
            END IF;
            v_can_multi := CASE
                WHEN v_can_multi_text IS NULL THEN COALESCE(v_existing.can_coach_multiple_teams, false)
                ELSE public.import_text_to_bool(v_can_multi_text)
            END;

            UPDATE public.coaches
            SET
                full_name = v_full_name,
                email = v_email,
                certifications = COALESCE(NULLIF(v_certifications, '[]'::jsonb), v_existing.certifications),
                can_coach_multiple_teams = v_can_multi,
                status = v_status,
                contact_info = (COALESCE(v_existing.contact_info, '{}'::jsonb) - 'phone') || v_contact_info,
                last_imported_at = v_now,
                import_source = 'coach_csv',
                custom_attributes = public.import_declared_attributes(
                    v_declared, COALESCE(v_existing.custom_attributes, '{}'::jsonb)
                ) || v_custom_attributes,
                updated_at = v_now
            WHERE id = v_existing.id
              AND organization_id = v_job.organization_id
            RETURNING * INTO v_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'coaches',
                'coaches',
                v_after.id,
                'updated',
                v_previous_payload,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            )
            ON CONFLICT (import_job_id, target_table, target_id) DO NOTHING;

            v_updated_count := v_updated_count + 1;
        ELSE
            v_can_multi := COALESCE(public.import_text_to_bool(v_can_multi_text), false);

            INSERT INTO public.coaches (
                organization_id,
                full_name,
                email,
                certifications,
                can_coach_multiple_teams,
                status,
                contact_info,
                last_imported_at,
                import_source,
                custom_attributes
            )
            VALUES (
                v_job.organization_id,
                v_full_name,
                v_email,
                v_certifications,
                v_can_multi,
                v_status,
                v_contact_info,
                v_now,
                'coach_csv',
                v_custom_attributes
            )
            RETURNING * INTO v_after;

            INSERT INTO public.import_application_records (
                organization_id,
                import_job_id,
                import_type,
                target_table,
                target_id,
                operation,
                previous_payload,
                applied_payload,
                applied_at,
                applied_by
            )
            VALUES (
                v_job.organization_id,
                p_import_job_id,
                'coaches',
                'coaches',
                v_after.id,
                'inserted',
                NULL,
                to_jsonb(v_after),
                v_now,
                auth.uid()
            );

            v_inserted_count := v_inserted_count + 1;
        END IF;

        -- S7: the coach's children. A file with the column names them (one or more registration
        -- ids, separated by ; or ,); the coach's links become exactly those that match a player
        -- of THIS organization, one row each, in the order the file lists them. An id that
        -- matches no player here (not imported yet, mistyped, or another organization's) is
        -- reported in the result and writes nothing. A file without the column leaves the
        -- coach's links alone. Nothing but this import writes coach_team_requests.
        IF v_row.normalized_payload ? 'child_registration_id' THEN
            DELETE FROM public.coach_team_requests
             WHERE organization_id = v_job.organization_id
               AND coach_id = v_after.id;
            v_slot := 0;
            FOR v_child IN
                SELECT x.registration_id
                  FROM (
                      SELECT btrim(part) AS registration_id, min(ord) AS first_at
                        FROM regexp_split_to_table(
                                 COALESCE(public.import_payload_text(v_row.normalized_payload, 'child_registration_id'), ''),
                                 '[;,]'
                             ) WITH ORDINALITY AS s(part, ord)
                       WHERE btrim(part) <> ''
                       GROUP BY btrim(part)
                  ) x
                 ORDER BY x.first_at
            LOOP
                SELECT p.id
                  INTO v_player_id
                  FROM public.players p
                 WHERE p.organization_id = v_job.organization_id
                   AND p.external_registration_id = v_child.registration_id
                 ORDER BY p.updated_at DESC, p.id
                 LIMIT 1;
                IF v_player_id IS NULL THEN
                    v_unmatched_count := v_unmatched_count + 1;
                    IF jsonb_array_length(v_unmatched) < 200 THEN
                        v_unmatched := v_unmatched || jsonb_build_array(jsonb_build_object(
                            'coach_id', v_after.id,
                            'registration_id', left(v_child.registration_id, 100)
                        ));
                    END IF;
                ELSE
                    v_slot := v_slot + 1;
                    INSERT INTO public.coach_team_requests (organization_id, coach_id, player_id, slot)
                    VALUES (v_job.organization_id, v_after.id, v_player_id, v_slot);
                    v_linked_count := v_linked_count + 1;
                END IF;
            END LOOP;
        END IF;

        UPDATE public.staging_import_rows
        SET
            applied_at = v_now,
            applied_by = auth.uid()
        WHERE id = v_row.id;
    END LOOP;

    SELECT count(*)
    INTO v_total_applied_count
    FROM public.import_application_records
    WHERE import_job_id = p_import_job_id
      AND import_type = 'coaches';

    v_status_result := CASE
        WHEN jsonb_array_length(v_validation_errors) > 0
          OR v_invalid_count > 0
          OR v_blocked_assignment_count > 0
          OR v_unmatched_count > 0
        THEN 'completed_with_warnings'
        ELSE 'completed'
    END;

    v_result := jsonb_build_object(
        'status', v_status_result,
        'staged_rows', (
            SELECT count(*)
            FROM public.staging_import_rows
            WHERE import_job_id = p_import_job_id
              AND import_type = 'coaches'
        ),
        'inserted_coaches', v_inserted_count,
        'updated_coaches', v_updated_count,
        'invalid_rows', v_invalid_count,
        'blocked_assignment_rows', v_blocked_assignment_count,
        'linked_children', v_linked_count,
        'unmatched_child_id_count', v_unmatched_count,
        'unmatched_child_ids', v_unmatched,
        'validation_error_rows', jsonb_array_length(v_validation_errors),
        'total_applied_rows', v_total_applied_count
    );

    UPDATE public.import_jobs
    SET
        status = v_status_result,
        processed_rows = v_total_applied_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{coach_finalize}',
            v_result,
            true
        )
    WHERE id = p_import_job_id;

    PERFORM public.record_audit_event(
        v_job.organization_id,
        'import.completed',
        'import_job',
        p_import_job_id,
        v_result
    );

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_coach_import_job(p_import_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_record public.import_application_records%ROWTYPE;
    v_previous jsonb;
    v_now timestamptz := timezone('utc', now());
    v_deleted_count integer := 0;
    v_restored_count integer := 0;
    v_blocked_count integer := 0;
    v_pending_record_count integer := 0;
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
      AND import_type = 'coaches'
      AND target_table = 'coaches'
      AND rolled_back_at IS NULL;

    IF v_pending_record_count = 0 THEN
        RAISE EXCEPTION 'Import job % has no coach application records to roll back', p_import_job_id
            USING ERRCODE = '22023';
    END IF;

    FOR v_record IN
        SELECT *
        FROM public.import_application_records
        WHERE import_job_id = p_import_job_id
          AND organization_id = v_job.organization_id
          AND import_type = 'coaches'
          AND target_table = 'coaches'
          AND rolled_back_at IS NULL
        ORDER BY applied_at DESC, id DESC
    LOOP
        IF v_record.operation = 'inserted' THEN
            IF EXISTS (
                SELECT 1
                FROM public.teams t
                WHERE t.organization_id = v_job.organization_id
                  AND (
                    t.coach_id = v_record.target_id
                    OR v_record.target_id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
                  )
            ) THEN
                v_blocked_count := v_blocked_count + 1;
                CONTINUE;
            END IF;

            DELETE FROM public.coaches c
            WHERE c.id = v_record.target_id
              AND c.organization_id = v_job.organization_id;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = jsonb_build_object('deleted', true)
            WHERE id = v_record.id;

            v_deleted_count := v_deleted_count + 1;
        ELSIF v_record.operation = 'updated' THEN
            v_previous := v_record.previous_payload;

            UPDATE public.coaches
            SET
                full_name = v_previous->>'full_name',
                email = v_previous->>'email',
                phone = v_previous->>'phone',
                certifications = COALESCE(v_previous->'certifications', '[]'::jsonb),
                can_coach_multiple_teams = COALESCE(
                    (v_previous->>'can_coach_multiple_teams')::boolean,
                    false
                ),
                status = v_previous->>'status',
                contact_info = COALESCE(v_previous->'contact_info', '{}'::jsonb),
                last_imported_at = NULLIF(v_previous->>'last_imported_at', '')::timestamptz,
                import_source = v_previous->>'import_source',
                custom_attributes = COALESCE(v_previous->'custom_attributes', '{}'::jsonb),
                updated_at = v_now
            WHERE id = v_record.target_id
              AND organization_id = v_job.organization_id;

            -- The links the import replaced (20261104010000): put back those whose player is
            -- still here. An inserted coach's links went with the coach (ON DELETE CASCADE).
            IF v_previous ? 'child_links' THEN
                DELETE FROM public.coach_team_requests r
                 WHERE r.organization_id = v_job.organization_id
                   AND r.coach_id = v_record.target_id;
                INSERT INTO public.coach_team_requests (organization_id, coach_id, player_id, slot)
                SELECT v_job.organization_id, v_record.target_id, (l.value->>'player_id')::uuid, (l.value->>'slot')::integer
                  FROM jsonb_array_elements(v_previous->'child_links') AS l(value)
                 WHERE EXISTS (SELECT 1 FROM public.players p
                                WHERE p.id = (l.value->>'player_id')::uuid
                                  AND p.organization_id = v_job.organization_id);
            END IF;

            UPDATE public.import_application_records
            SET
                rolled_back_at = v_now,
                rolled_back_by = auth.uid(),
                rollback_payload = v_previous
            WHERE id = v_record.id;

            v_restored_count := v_restored_count + 1;
        END IF;
    END LOOP;

    v_result := jsonb_build_object(
        'status', CASE WHEN v_blocked_count > 0 THEN 'completed_with_warnings' ELSE 'rolled_back' END,
        'deleted_coaches', v_deleted_count,
        'restored_coaches', v_restored_count,
        'blocked_assigned_coaches', v_blocked_count
    );

    UPDATE public.import_jobs
    SET
        status = CASE WHEN v_blocked_count > 0 THEN 'completed_with_warnings' ELSE 'needs_fix' END,
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{coach_rollback}',
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

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. reconcile_prod_rls_drift, from 20261022030000 with the coaches policy renamed and narrowed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_prod_rls_drift()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
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
    -- CHANGED (20261022030000): the team chat table is dropped (R2), so it
    -- is no longer a table the broad policy may sit on.
    c_broad_tables text[] := ARRAY['coaches','teams','locations','fields','divisions','game_assignments',
                                   'import_jobs','imports','organization_schemas',
                                   'schedule_evaluations'];
    c_member_write_tables text[] := ARRAY['practice_slots','field_subunits','scheduler_runs'];
BEGIN
    -- 1. Every repo policy on the affected tables, created if missing.
    --    Columns: table, policy, command, roles, USING, WITH CHECK -- each
    --    clause copied verbatim from the source line cited.
    FOR v_spec IN
        SELECT * FROM (VALUES
            -- CHANGED (20261104010000): coaches are read by admins and staff only
            -- (no coach signs in, and the sign-in link column is dropped by 20261104020000);
            -- the member-wide policy is gone and must not come back from here.
            ('coaches', 'coaches_select_admin', 'SELECT', 'authenticated',
             'public.is_org_admin(organization_id)', NULL),
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
            -- REMOVED (20261022030000): the team chat table and its read
            -- policy are dropped (R2); creating it here would fail.
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
    -- CHANGED (20261104010000): coaches has one read, the admin one.
    FOR v_pol IN
        SELECT policyname
          FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'coaches'
           AND permissive = 'PERMISSIVE' AND cmd IN ('SELECT', 'ALL')
           AND policyname <> 'coaches_select_admin'
    LOOP
        RAISE EXCEPTION
            'reconcile_prod_rls_drift: public.coaches still has read policy "%" beside coaches_select_admin; refusing to call it reconciled',
            v_pol.policyname;
    END LOOP;

    RETURN jsonb_build_object(
        'created', to_jsonb(v_created),
        'verified', to_jsonb(v_verified),
        'dropped', to_jsonb(v_dropped)
    );
END;
$fn$;

COMMENT ON FUNCTION public.reconcile_prod_rls_drift() IS
    'Idempotent: creates the repo''s member/admin policies on the tables of migration 20260928000000 where missing (aborting on a same-named mismatch), drops "Enforce Org Membership: ALL" and "org_member_access" on practice_slots/field_subunits/scheduler_runs, then refuses any non-allowlisted non-admin write policy in public. Spec as of 20261104010000: scheduler_runs admin write split by command and the legacy import_jobs SELECT gone (20261018030000), coaches read by admins only as coaches_select_admin (20261104010000), the team chat table dropped (20261022030000). Owner-only.';

-- ---------------------------------------------------------------------------
-- 10. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_bad text;
    v_def text;
    v_n integer;
BEGIN
    -- The roles.
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'organization_members_role_check';
    IF v_def IS DISTINCT FROM $d$CHECK ((role = ANY (ARRAY['admin'::text, 'staff'::text, 'tenant_admin'::text])))$d$ THEN
        RAISE EXCEPTION 'organization_members_role_check is not admin, staff and tenant_admin: %', v_def;
    END IF;
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'organization_invites_role_check';
    IF v_def IS DISTINCT FROM $d$CHECK ((role = ANY (ARRAY['admin'::text, 'staff'::text])))$d$ THEN
        RAISE EXCEPTION 'organization_invites_role_check is not admin and staff: %', v_def;
    END IF;

    -- No function in public names a dropped coach object, or reads coaches.user_id.
    SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.prosrc ~ '(link_my_coach_record|coached_team_ids_of|get_my_coached_team_ids|admin_get_coached_team_ids|is_current_team_coach|division_teams_of|get_my_division_teams|admin_get_division_teams|request_coach_practice_preference|caller_coaches_practice_slot|coach_field_ids_of|coach_covers_permit_scope|coach_reads_facility_permit)'
            OR (p.prosrc ~* 'coaches' AND p.prosrc ~* 'user_id')
            OR p.prosrc ~* 'p_coach_only');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a function still names a dropped coach object: %', v_bad;
    END IF;
    SELECT string_agg(tablename || '.' || policyname, ', ' ORDER BY tablename, policyname) INTO v_bad
      FROM pg_policies
     WHERE (coalesce(qual, '') || coalesce(with_check, ''))
           ~ '(user_id|is_current_team_coach|coached_team_ids_of|caller_coaches_practice_slot|coach_covers_permit_scope|coach_reads_facility_permit)'
       AND (schemaname = 'public' AND tablename IN ('coaches', 'team_coach_assignments', 'team_calendar_tokens',
              'coach_practice_preferences', 'practice_lighting_overrides', 'facility_permits', 'facility_permit_scopes')
            OR schemaname = 'storage' AND tablename = 'objects');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'a policy still names a coach arm: %', v_bad;
    END IF;

    -- Each narrowed policy is exactly the admin expression.
    SELECT count(*) INTO v_n
      FROM pg_policies
     WHERE schemaname = 'public'
       AND ((tablename = 'coaches' AND policyname = 'coaches_select_admin')
         OR (tablename = 'team_coach_assignments' AND policyname = 'team_coach_assignments_select_admin')
         OR (tablename = 'coach_practice_preferences' AND policyname = 'Coach practice preferences: admins read')
         OR (tablename = 'practice_lighting_overrides' AND policyname = 'Practice lighting overrides: admins read')
         OR (tablename = 'facility_permits' AND policyname = 'Facility permits: admins select')
         OR (tablename = 'facility_permit_scopes' AND policyname = 'Facility permit scopes: admins select'))
       AND cmd = 'SELECT' AND qual = 'is_org_admin(organization_id)';
    IF v_n <> 6 THEN
        RAISE EXCEPTION 'only % of the 6 narrowed read policies are exactly is_org_admin(organization_id)', v_n;
    END IF;
    SELECT qual INTO v_def FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'team_calendar_tokens' AND policyname = 'team_calendar_tokens_select';
    IF v_def IS NULL OR v_def !~ 'is_org_admin' OR v_def ~ 'coach' THEN
        RAISE EXCEPTION 'team_calendar_tokens_select is not an admin read: %', v_def;
    END IF;
    SELECT qual INTO v_def FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'facility-permits select';
    IF v_def IS NULL OR v_def !~ 'is_org_admin' OR v_def ~ 'coach' THEN
        RAISE EXCEPTION 'the facility-permits select policy is not an admin read: %', v_def;
    END IF;
    -- coaches has one read policy.
    SELECT string_agg(policyname, ', ') INTO v_bad FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'coaches' AND cmd IN ('SELECT', 'ALL')
       AND policyname <> 'coaches_select_admin';
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'another read policy remains on coaches: %', v_bad;
    END IF;

    -- The dropped functions are gone, and the permit view has one signature, without the parameter.
    SELECT count(*) INTO v_n FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('link_my_coach_record', 'get_my_division_teams', 'admin_get_division_teams', 'division_teams_of',
                       'get_my_coached_team_ids', 'admin_get_coached_team_ids', 'request_coach_practice_preference',
                       'caller_coaches_practice_slot', 'coach_reads_facility_permit_file', 'coach_reads_facility_permit',
                       'coach_covers_permit_scope', 'coach_field_ids_of', 'coached_team_ids_of', 'is_current_team_coach');
    IF v_n <> 0 THEN RAISE EXCEPTION '% dropped coach function(s) remain', v_n; END IF;
    IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'facility_permit_json') <> 1
       OR to_regprocedure('public.facility_permit_json(uuid, date)') IS NULL THEN
        RAISE EXCEPTION 'facility_permit_json is not exactly the two-argument function';
    END IF;
    IF has_function_privilege('authenticated', 'public.facility_permit_json(uuid, date)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.facility_permit_json(uuid, date)', 'EXECUTE') THEN
        RAISE EXCEPTION 'facility_permit_json is callable by a client role';
    END IF;

    -- The coach key.
    SELECT count(*) INTO v_n FROM pg_constraint
     WHERE conrelid = 'public.coaches'::regclass
       AND ((conname = 'coaches_email_key')
         OR (conname = 'coaches_organization_id_email_key' AND contype = 'u')
         OR (conname = 'coaches_email_normalised' AND contype = 'c'));
    IF v_n <> 2 THEN RAISE EXCEPTION 'the coach email keys are not the per-organization pair'; END IF;

    -- The replaced functions keep their pins and grants.
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.get_team_roster(uuid)'::regprocedure, 'public.get_team_staff(uuid)'::regprocedure,
                     'public.rotate_calendar_token(uuid)'::regprocedure, 'public.create_org_invite(uuid, text, interval)'::regprocedure,
                     'public.admin_change_member_role(uuid, uuid, text)'::regprocedure, 'public.get_facility_permits(uuid)'::regprocedure,
                     'public.finalize_coach_import_job(uuid, jsonb)'::regprocedure, 'public.rollback_coach_import_job(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE');
    IF v_n <> 8 THEN RAISE EXCEPTION 'only % of the 8 replaced definers kept their pin and grants', v_n; END IF;
    IF NOT ('child_registration_id' = ANY (public.import_allowed_keys('coaches')))
       OR 'child_registration_id' = ANY (public.import_allowed_keys('players')) THEN
        RAISE EXCEPTION 'child_registration_id is not exactly a coach import key';
    END IF;
END;
$check$;

COMMIT;
