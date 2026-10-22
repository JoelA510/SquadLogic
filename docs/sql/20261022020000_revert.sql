-- Revert for 20261022020000_remove_registration_and_compliance.sql
--
-- Restores, empty, every object the migration dropped, as it stood after
-- 20261022010000: the three `players` flags (boolean NOT NULL DEFAULT false,
-- with their comments), the `registration_forms` and `registrations` tables
-- with their keys, foreign keys, index, `set_timestamp` triggers, row security,
-- eight policies and grants, `view_compliance_stats` (security_invoker) and its
-- grants, and the seven functions with their SET clauses, comments and grants
-- (`submit_registration` executable by anon again); then the three kept
-- functions' previous bodies: `sanitize_player_patch` and `apply_player_patch`
-- from 20260611000100 (the latter pinned to UTC, as 20261021040000 left it)
-- and `finalize_import_job` from 20261022010000.
--
-- The DDL is pg_dump's (16.15) of a harness build at 20261022010000, so each
-- function body is that migration's text byte for byte; only the OWNER lines
-- are left out (the objects are created by the role that runs this).
--
-- **What it cannot restore:** the rows and flags the migration dropped. The
-- tables come back empty and every player's three flags come back false. The
-- forward migration's NOTICE counted what it dropped (production: 0 forms,
-- 0 registrations, 0 players, read 2026-10-22).
--
-- Verified: the harness compares a fingerprint of every restored object
-- (signature, posture, grants and body md5 of the ten functions; columns,
-- grants, policies and triggers of the two tables; the view's definition and
-- grants; the three columns) with the one read off a build at 20261022010000.

BEGIN;

-- The dropped functions' bodies are not validated here (pg_dump's own
-- setting): the tables they name are created above them, but the plpgsql
-- validator would also resolve every %ROWTYPE at CREATE time.
SET LOCAL check_function_bodies = false;

-- 1. The three player columns, as 20260611000000 defined them, with their comments.

ALTER TABLE public.players
    ADD COLUMN paid boolean DEFAULT false NOT NULL,
    ADD COLUMN waiver_received boolean DEFAULT false NOT NULL,
    ADD COLUMN medical_form_received boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.players.paid IS 'Registration fee received (boolean compliance signal from GotSport Payment Status; no amounts are stored).';

COMMENT ON COLUMN public.players.waiver_received IS 'Liability waiver received (boolean toggle; no documents are stored).';

COMMENT ON COLUMN public.players.medical_form_received IS 'Medical/consent form received (boolean toggle; no documents are stored).';


-- 2. The two tables, their keys, index, triggers, row security, policies and grants.

CREATE TABLE public.registration_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    season_id uuid,
    fields jsonb DEFAULT '[]'::jsonb,
    waiver_text text,
    status text DEFAULT 'draft'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    division_id uuid,
    CONSTRAINT registration_forms_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'closed'::text])))
);

CREATE TABLE public.registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    form_id uuid NOT NULL,
    player_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    responses jsonb DEFAULT '{}'::jsonb,
    waiver_signed boolean DEFAULT false,
    waiver_signed_at timestamp with time zone,
    medical_cleared boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.registration_forms
    ADD CONSTRAINT registration_forms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_form_id_player_id_key UNIQUE (form_id, player_id);

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_pkey PRIMARY KEY (id);

CREATE INDEX registrations_profile_form_created_idx ON public.registrations USING btree (profile_id, form_id, created_at DESC);

ALTER TABLE ONLY public.registration_forms
    ADD CONSTRAINT registration_forms_division_id_fkey FOREIGN KEY (division_id) REFERENCES public.divisions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.registration_forms
    ADD CONSTRAINT registration_forms_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.registration_forms
    ADD CONSTRAINT registration_forms_season_id_fkey FOREIGN KEY (season_id) REFERENCES public.season_settings(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.registration_forms(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

CREATE TRIGGER registration_forms_set_timestamp BEFORE UPDATE ON public.registration_forms FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();

CREATE TRIGGER registrations_set_timestamp BEFORE UPDATE ON public.registrations FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();

ALTER TABLE public.registration_forms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY registration_forms_admin_delete ON public.registration_forms FOR DELETE TO authenticated USING ((public.is_org_member(organization_id) AND (EXISTS ( SELECT 1
   FROM public.organization_members om
  WHERE ((om.profile_id = ( SELECT auth.uid() AS uid)) AND (om.organization_id = registration_forms.organization_id) AND (om.role = ANY (ARRAY['admin'::text, 'staff'::text])))))));

CREATE POLICY registration_forms_admin_insert ON public.registration_forms FOR INSERT TO authenticated WITH CHECK ((public.is_org_member(organization_id) AND (EXISTS ( SELECT 1
   FROM public.organization_members om
  WHERE ((om.profile_id = ( SELECT auth.uid() AS uid)) AND (om.organization_id = registration_forms.organization_id) AND (om.role = ANY (ARRAY['admin'::text, 'staff'::text])))))));

CREATE POLICY registration_forms_admin_update ON public.registration_forms FOR UPDATE TO authenticated USING ((public.is_org_member(organization_id) AND (EXISTS ( SELECT 1
   FROM public.organization_members om
  WHERE ((om.profile_id = ( SELECT auth.uid() AS uid)) AND (om.organization_id = registration_forms.organization_id) AND (om.role = ANY (ARRAY['admin'::text, 'staff'::text]))))))) WITH CHECK ((public.is_org_member(organization_id) AND (EXISTS ( SELECT 1
   FROM public.organization_members om
  WHERE ((om.profile_id = ( SELECT auth.uid() AS uid)) AND (om.organization_id = registration_forms.organization_id) AND (om.role = ANY (ARRAY['admin'::text, 'staff'::text])))))));

CREATE POLICY registration_forms_member_access ON public.registration_forms FOR SELECT TO authenticated USING ((public.is_org_member(organization_id) OR (status = 'open'::text)));

CREATE POLICY registrations_admin_delete ON public.registrations FOR DELETE TO authenticated USING (public.is_org_admin(organization_id));

CREATE POLICY registrations_admin_insert ON public.registrations FOR INSERT TO authenticated WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY registrations_admin_update ON public.registrations FOR UPDATE TO authenticated USING (public.is_org_admin(organization_id)) WITH CHECK (public.is_org_admin(organization_id));

CREATE POLICY registrations_select_own_or_admin ON public.registrations FOR SELECT TO authenticated USING ((((profile_id = ( SELECT auth.uid() AS uid)) AND public.is_org_member(organization_id)) OR public.is_org_admin(organization_id)));

GRANT ALL ON TABLE public.registration_forms TO anon;
GRANT ALL ON TABLE public.registration_forms TO authenticated;
GRANT ALL ON TABLE public.registration_forms TO service_role;

GRANT ALL ON TABLE public.registrations TO anon;
GRANT ALL ON TABLE public.registrations TO authenticated;
GRANT ALL ON TABLE public.registrations TO service_role;


-- 3. The view and its grants.

CREATE VIEW public.view_compliance_stats WITH (security_invoker='true') AS
 SELECT rf.id AS form_id,
    rf.organization_id,
    rf.title AS form_title,
    count(r.id) AS total_registrations,
    count(r.id) FILTER (WHERE (r.waiver_signed = true)) AS waivers_signed,
    count(r.id) FILTER (WHERE (r.medical_cleared = true)) AS medical_cleared
   FROM (public.registration_forms rf
     LEFT JOIN public.registrations r ON ((r.form_id = rf.id)))
  GROUP BY rf.id, rf.organization_id, rf.title;

GRANT ALL ON TABLE public.view_compliance_stats TO anon;
GRANT ALL ON TABLE public.view_compliance_stats TO authenticated;
GRANT ALL ON TABLE public.view_compliance_stats TO service_role;


-- 4. The seven dropped functions, with their comments and grants.

CREATE FUNCTION public.submit_registration(p_organization_id uuid, p_form_id uuid, p_profile_id uuid, p_responses jsonb, p_player_id uuid DEFAULT NULL::uuid, p_first_name text DEFAULT NULL::text, p_last_name text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
    v_caller          uuid := auth.uid();
    v_player_id       uuid := p_player_id;
    v_registration_id uuid;
    v_division_id     uuid;
    -- DS-5: the most registrations one caller may submit to one form in the
    -- window. Ten covers a family registering several children in one sitting;
    -- tests/submitRegistrationThrottle.test.js ties the mock client to this number.
    v_limit           constant integer := 10;
    v_window          constant interval := interval '60 seconds';
    v_recent          integer;
BEGIN
    -- Caller may only submit on their own behalf.
    IF v_caller IS NULL OR p_profile_id <> v_caller THEN
        RAISE EXCEPTION 'Access denied: profile mismatch.'
          USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_member(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: User is not a member of organization %', p_organization_id
          USING ERRCODE = '42501';
    END IF;

    -- Form must belong to the org and be open. Decide existence via FOUND, not
    -- the nullable division_id (org-level forms legitimately have NULL division).
    SELECT rf.division_id INTO v_division_id
    FROM public.registration_forms rf
    WHERE rf.id = p_form_id
      AND rf.organization_id = p_organization_id
      AND rf.status = 'open';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid or closed registration form for organization %', p_organization_id
          USING ERRCODE = '22023';
    END IF;

    -- DS-5 throttle. Counted from the registrations the caller already holds
    -- for this form (every successful call inserts exactly one), so there is no
    -- log table to grow or prune. A refused call inserts nothing, so it does not
    -- extend its own window. The advisory lock serialises one caller's calls to
    -- one form, so two concurrent calls cannot both read nine and both insert.
    -- PT429 is PostgREST's own convention: the HTTP response is 429.
    -- The window is absolute timestamptz arithmetic (now() - v_window), and the
    -- INSERT below sets created_at to now() itself. The column default is
    -- timezone('utc', now()), a zone-less timestamp that the SESSION time zone
    -- reinterprets, and a PostgREST caller sets that zone (Prefer: timezone=...):
    -- with +14 the default dates a row 14 hours in the past, outside every window.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_caller::text || ':' || p_form_id::text, 0));

    SELECT count(*) INTO v_recent
    FROM public.registrations r
    WHERE r.profile_id = v_caller
      AND r.form_id = p_form_id
      AND r.created_at > now() - v_window;

    IF v_recent >= v_limit THEN
        RAISE EXCEPTION 'Too many registrations submitted for this form. Wait a minute and try again.'
          USING ERRCODE = 'PT429',
                HINT = format('At most %s registrations per form per %s.', v_limit, v_window);
    END IF;

    IF v_player_id IS NULL THEN
        IF p_first_name IS NULL OR btrim(p_first_name) = ''
           OR p_last_name IS NULL OR btrim(p_last_name) = '' THEN
            RAISE EXCEPTION 'New player registration requires first and last name.'
              USING ERRCODE = '22023';
        END IF;

        -- Creating a new player requires a division; only division-bound forms can.
        IF v_division_id IS NULL THEN
            RAISE EXCEPTION 'Cannot register a new player: form % is not bound to a division. Ask an admin to set the form''s division.', p_form_id
              USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.players (organization_id, first_name, last_name, division_id)
        VALUES (p_organization_id, btrim(p_first_name), btrim(p_last_name), v_division_id)
        RETURNING id INTO v_player_id;
    ELSE
        -- Existing player must belong to the org and already be linked to the caller.
        IF NOT EXISTS (
            SELECT 1 FROM public.players p
            WHERE p.id = v_player_id AND p.organization_id = p_organization_id
        ) THEN
            RAISE EXCEPTION 'Invalid player for organization %', p_organization_id
              USING ERRCODE = '42501';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.profile_players pp
            WHERE pp.profile_id = v_caller
              AND pp.player_id = v_player_id
              AND pp.organization_id = p_organization_id
        ) THEN
            RAISE EXCEPTION 'Access denied: player is not linked to caller profile.'
              USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.profile_players (organization_id, profile_id, player_id)
    VALUES (p_organization_id, p_profile_id, v_player_id)
    ON CONFLICT (profile_id, player_id) DO NOTHING;

    INSERT INTO public.registrations (
        organization_id, form_id, player_id, profile_id, responses, waiver_signed, waiver_signed_at,
        created_at
    )
    VALUES (
        p_organization_id, p_form_id, v_player_id, p_profile_id, p_responses, true, now(),
        now()
    )
    RETURNING id INTO v_registration_id;

    -- Best-effort audit (do not fail the registration if the helper is absent).
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'record_audit_event') THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'registration.submitted',
            'registration',
            v_registration_id,
            jsonb_build_object('form_id', p_form_id, 'player_id', v_player_id)
        );
    END IF;

    RETURN v_registration_id;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'This player is already registered for this form.'
          USING ERRCODE = '23505';
END;
$$;

COMMENT ON FUNCTION public.submit_registration(p_organization_id uuid, p_form_id uuid, p_profile_id uuid, p_responses jsonb, p_player_id uuid, p_first_name text, p_last_name text) IS 'Atomic player+registration creation. Org + division are derived from the form (not trusted from client). Caller must be an org member; admins may submit for others. Writes an audit log entry on success.';

GRANT ALL ON FUNCTION public.submit_registration(p_organization_id uuid, p_form_id uuid, p_profile_id uuid, p_responses jsonb, p_player_id uuid, p_first_name text, p_last_name text) TO anon;
GRANT ALL ON FUNCTION public.submit_registration(p_organization_id uuid, p_form_id uuid, p_profile_id uuid, p_responses jsonb, p_player_id uuid, p_first_name text, p_last_name text) TO authenticated;
GRANT ALL ON FUNCTION public.submit_registration(p_organization_id uuid, p_form_id uuid, p_profile_id uuid, p_responses jsonb, p_player_id uuid, p_first_name text, p_last_name text) TO service_role;

CREATE FUNCTION public.admin_create_registration_form(p_organization_id uuid, p_title text, p_description text DEFAULT NULL::text, p_season_id uuid DEFAULT NULL::uuid, p_fields jsonb DEFAULT '[]'::jsonb, p_status text DEFAULT 'open'::text, p_waiver_text text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_title text := btrim(COALESCE(p_title, ''));
    v_description text := NULLIF(btrim(COALESCE(p_description, '')), '');
    v_waiver_text text := NULLIF(btrim(COALESCE(p_waiver_text, '')), '');
    v_fields jsonb := COALESCE(p_fields, '[]'::jsonb);
    v_status text := lower(btrim(COALESCE(p_status, 'open')));
    v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_season_org_id uuid;
    v_form public.registration_forms%ROWTYPE;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF v_title = '' THEN
        RAISE EXCEPTION 'p_title is required'
            USING ERRCODE = '23502';
    END IF;

    IF jsonb_typeof(v_fields) <> 'array' THEN
        RAISE EXCEPTION 'p_fields must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(v_metadata) <> 'object' THEN
        RAISE EXCEPTION 'p_metadata must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF v_status = 'active' THEN
        v_status := 'open';
    END IF;

    IF v_status NOT IN ('draft', 'open', 'closed') THEN
        RAISE EXCEPTION 'invalid registration form status: %', v_status
            USING ERRCODE = '23514';
    END IF;

    IF p_season_id IS NOT NULL THEN
        SELECT ss.organization_id
          INTO v_season_org_id
          FROM public.season_settings ss
         WHERE ss.id = p_season_id;

        IF v_season_org_id IS NULL OR v_season_org_id <> p_organization_id THEN
            RAISE EXCEPTION 'Season settings do not belong to organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.registration_forms (
        organization_id,
        title,
        description,
        season_id,
        fields,
        status,
        waiver_text
    )
    VALUES (
        p_organization_id,
        v_title,
        v_description,
        p_season_id,
        v_fields,
        v_status,
        v_waiver_text
    )
    RETURNING * INTO v_form;

    PERFORM public.record_audit_event(
        p_organization_id,
        'registration.form_created',
        'registration_form',
        v_form.id,
        jsonb_build_object(
            'form_id', v_form.id,
            'title', v_form.title,
            'season_id', v_form.season_id,
            'field_count', jsonb_array_length(v_form.fields),
            'status', v_form.status
        ) || v_metadata
    );

    RETURN to_jsonb(v_form);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_registration_form(p_organization_id uuid, p_title text, p_description text, p_season_id uuid, p_fields jsonb, p_status text, p_waiver_text text, p_metadata jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_create_registration_form(p_organization_id uuid, p_title text, p_description text, p_season_id uuid, p_fields jsonb, p_status text, p_waiver_text text, p_metadata jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_create_registration_form(p_organization_id uuid, p_title text, p_description text, p_season_id uuid, p_fields jsonb, p_status text, p_waiver_text text, p_metadata jsonb) TO service_role;

CREATE FUNCTION public.admin_update_registration_form(p_form_id uuid, p_patch jsonb) RETURNS public.registration_forms
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
    v_form public.registration_forms%ROWTYPE;
    v_key  text;
    v_season_org_id uuid;
BEGIN
    SELECT * INTO v_form FROM public.registration_forms WHERE id = p_form_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'registration form % not found', p_form_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_form.organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_form.organization_id
            USING ERRCODE = '42501';
    END IF;
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch must be a JSON object' USING ERRCODE = '22023';
    END IF;

    FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
        IF v_key NOT IN ('title', 'description', 'status', 'waiver_text', 'fields', 'season_id') THEN
            RAISE EXCEPTION 'field % is not editable on registration_forms', v_key
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    IF p_patch ? 'title' AND (p_patch->>'title' IS NULL OR trim(p_patch->>'title') = '') THEN
        RAISE EXCEPTION 'title cannot be empty' USING ERRCODE = '22023';
    END IF;
    IF p_patch ? 'status' AND (p_patch->>'status') NOT IN ('draft', 'open', 'closed') THEN
        RAISE EXCEPTION 'invalid status: %', p_patch->>'status' USING ERRCODE = '22023';
    END IF;
    IF p_patch ? 'fields' AND jsonb_typeof(p_patch->'fields') <> 'array' THEN
        RAISE EXCEPTION 'fields must be a JSON array' USING ERRCODE = '22023';
    END IF;
    IF p_patch ? 'season_id' AND p_patch->>'season_id' IS NOT NULL THEN
        SELECT ss.organization_id INTO v_season_org_id
        FROM public.season_settings ss
        WHERE ss.id = (p_patch->>'season_id')::uuid;
        IF v_season_org_id IS NULL OR v_season_org_id <> v_form.organization_id THEN
            RAISE EXCEPTION 'Season settings do not belong to organization %', v_form.organization_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    UPDATE public.registration_forms
    SET
        title        = CASE WHEN p_patch ? 'title'       THEN trim(p_patch->>'title')         ELSE title       END,
        description  = CASE WHEN p_patch ? 'description' THEN p_patch->>'description'          ELSE description END,
        status       = CASE WHEN p_patch ? 'status'      THEN p_patch->>'status'               ELSE status      END,
        waiver_text  = CASE WHEN p_patch ? 'waiver_text' THEN p_patch->>'waiver_text'           ELSE waiver_text END,
        fields       = CASE WHEN p_patch ? 'fields'      THEN p_patch->'fields'                 ELSE fields      END,
        season_id    = CASE WHEN p_patch ? 'season_id'   THEN (p_patch->>'season_id')::uuid     ELSE season_id   END,
        updated_at   = timezone('utc', now())
    WHERE id = p_form_id;

    PERFORM public.record_audit_event(
        v_form.organization_id,
        'registration.form_updated',
        'registration_forms',
        p_form_id,
        jsonb_build_object('patch_keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(p_patch) AS k))
    );

    SELECT * INTO v_form FROM public.registration_forms WHERE id = p_form_id;
    RETURN v_form;
END;
$$;

COMMENT ON FUNCTION public.admin_update_registration_form(p_form_id uuid, p_patch jsonb) IS 'Audited registration form patch (title/description/status/waiver_text/fields) for org admins.';

REVOKE ALL ON FUNCTION public.admin_update_registration_form(p_form_id uuid, p_patch jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_registration_form(p_form_id uuid, p_patch jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_registration_form(p_form_id uuid, p_patch jsonb) TO service_role;

CREATE FUNCTION public.admin_delete_registration_form(p_form_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_form      public.registration_forms%ROWTYPE;
    v_reg_count integer;
BEGIN
    SELECT * INTO v_form FROM public.registration_forms WHERE id = p_form_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'registration form % not found', p_form_id USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.is_org_admin(v_form.organization_id) THEN
        RAISE EXCEPTION 'Access denied: admin required for organization %', v_form.organization_id
            USING ERRCODE = '42501';
    END IF;

    SELECT count(*) INTO v_reg_count
    FROM public.registrations WHERE form_id = p_form_id;

    DELETE FROM public.registration_forms WHERE id = p_form_id;

    PERFORM public.record_audit_event(
        v_form.organization_id,
        'registration.form_deleted',
        'registration_forms',
        p_form_id,
        jsonb_build_object('title', v_form.title, 'registrations_deleted', v_reg_count)
    );

    RETURN v_reg_count + 1;
END;
$$;

COMMENT ON FUNCTION public.admin_delete_registration_form(p_form_id uuid) IS 'Audited registration form deletion (cascades to registrations) for org admins.';

REVOKE ALL ON FUNCTION public.admin_delete_registration_form(p_form_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_delete_registration_form(p_form_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.admin_delete_registration_form(p_form_id uuid) TO service_role;

CREATE FUNCTION public.admin_update_registration_medical_status(p_organization_id uuid, p_registration_id uuid, p_medical_cleared boolean, p_metadata jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
DECLARE
    v_registration record;
    v_effective_role text := COALESCE(auth.role(), current_role, '');
    v_metadata jsonb := COALESCE(p_metadata, '{}'::jsonb);
    v_changed boolean;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_registration_id IS NULL THEN
        RAISE EXCEPTION 'p_registration_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF p_medical_cleared IS NULL THEN
        RAISE EXCEPTION 'p_medical_cleared is required'
            USING ERRCODE = '23502';
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

        IF NOT public.is_org_admin(p_organization_id) THEN
            RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
                USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT r.id,
           r.organization_id,
           r.form_id,
           r.player_id,
           r.profile_id,
           r.medical_cleared
      INTO v_registration
      FROM public.registrations r
      JOIN public.registration_forms rf
        ON rf.id = r.form_id
       AND rf.organization_id = r.organization_id
     WHERE r.id = p_registration_id
       AND r.organization_id = p_organization_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration not found in organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    v_changed := v_registration.medical_cleared IS DISTINCT FROM p_medical_cleared;

    IF v_changed THEN
        UPDATE public.registrations
           SET medical_cleared = p_medical_cleared,
               updated_at = timezone('utc', now())
         WHERE id = p_registration_id
           AND organization_id = p_organization_id;

        PERFORM public.record_audit_event(
            p_organization_id,
            'compliance.medical_update',
            'registration',
            p_registration_id,
            jsonb_build_object(
                'registration_id', p_registration_id,
                'form_id', v_registration.form_id,
                'player_id', v_registration.player_id,
                'profile_id', v_registration.profile_id,
                'previous_status', v_registration.medical_cleared,
                'medical_cleared', p_medical_cleared
            ) || v_metadata
        );
    END IF;

    RETURN jsonb_build_object(
        'registration_id', p_registration_id,
        'organization_id', p_organization_id,
        'medical_cleared', p_medical_cleared,
        'previous_status', v_registration.medical_cleared,
        'changed', v_changed
    );
END;
$$;

COMMENT ON FUNCTION public.admin_update_registration_medical_status(p_organization_id uuid, p_registration_id uuid, p_medical_cleared boolean, p_metadata jsonb) IS 'Admin-only medical clearance mutation for registrations with org scoping and audit logging.';

REVOKE ALL ON FUNCTION public.admin_update_registration_medical_status(p_organization_id uuid, p_registration_id uuid, p_medical_cleared boolean, p_metadata jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_update_registration_medical_status(p_organization_id uuid, p_registration_id uuid, p_medical_cleared boolean, p_metadata jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.admin_update_registration_medical_status(p_organization_id uuid, p_registration_id uuid, p_medical_cleared boolean, p_metadata jsonb) TO service_role;

CREATE FUNCTION public.get_team_portal_medical_status(p_team_id uuid) RETURNS TABLE(player_id uuid, medical_cleared boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_org_id uuid;
    v_season_id uuid;
    v_uid uuid;
    v_effective_role text;
    v_can_view_full_roster boolean;
BEGIN
    IF p_team_id IS NULL THEN
        RAISE EXCEPTION 'team id is required'
            USING ERRCODE = '23502';
    END IF;

    SELECT t.organization_id, d.season_settings_id
      INTO v_org_id, v_season_id
      FROM public.teams t
      JOIN public.divisions d
        ON d.id = t.division_id
       AND d.organization_id = t.organization_id
     WHERE t.id = p_team_id;

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'team % does not exist', p_team_id
            USING ERRCODE = '23503';
    END IF;

    v_uid := auth.uid();
    v_effective_role := COALESCE(auth.role(), current_role, '');

    IF v_effective_role <> 'service_role' THEN
        IF v_uid IS NULL THEN
            RAISE EXCEPTION 'authenticated user is required'
                USING ERRCODE = '42501';
        END IF;

        IF NOT public.is_org_member(v_org_id) THEN
            RAISE EXCEPTION 'caller is not a member of team organization'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    v_can_view_full_roster :=
        v_effective_role = 'service_role'
        OR public.is_org_admin(v_org_id)
        OR EXISTS (
            SELECT 1
              FROM public.teams t
              JOIN public.coaches c
                ON c.organization_id = t.organization_id
               AND (
                    c.id = t.coach_id
                    OR c.id = ANY(COALESCE(t.assistant_coach_ids, '{}'::uuid[]))
               )
             WHERE t.id = p_team_id
               AND t.organization_id = v_org_id
               AND (
                    c.user_id = v_uid
                    OR c.profile_id = v_uid
               )
        );

    RETURN QUERY
    WITH roster AS (
        SELECT tp.player_id
          FROM public.team_players tp
         WHERE tp.team_id = p_team_id
           AND tp.organization_id = v_org_id
    ),
    current_season_registrations AS (
        SELECT DISTINCT ON (r.player_id)
               r.player_id,
               r.medical_cleared
          FROM public.registrations r
          JOIN public.registration_forms rf
            ON rf.id = r.form_id
           AND rf.organization_id = r.organization_id
         WHERE r.organization_id = v_org_id
           AND rf.season_id = v_season_id
           AND r.player_id IN (SELECT roster.player_id FROM roster)
         ORDER BY r.player_id, r.updated_at DESC, r.created_at DESC, r.id DESC
    )
    SELECT roster.player_id,
           COALESCE(csr.medical_cleared, false) AS medical_cleared
      FROM roster
      LEFT JOIN current_season_registrations csr
        ON csr.player_id = roster.player_id
     WHERE v_can_view_full_roster
        OR EXISTS (
            SELECT 1
              FROM public.profile_players pp
             WHERE pp.organization_id = v_org_id
               AND pp.profile_id = v_uid
               AND pp.player_id = roster.player_id
        );
END;
$$;

COMMENT ON FUNCTION public.get_team_portal_medical_status(p_team_id uuid) IS 'Returns team-portal medical clearance rows scoped to the team season and caller authorization.';

REVOKE ALL ON FUNCTION public.get_team_portal_medical_status(p_team_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_team_portal_medical_status(p_team_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_team_portal_medical_status(p_team_id uuid) TO service_role;

CREATE FUNCTION public.coach_update_player_compliance(p_player_id uuid, p_patch jsonb) RETURNS public.players
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_player public.players%ROWTYPE;
    v_sanitized jsonb;
    v_key text;
    v_is_team_coach boolean;
BEGIN
    SELECT * INTO v_player FROM public.players WHERE id = p_player_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'player % not found', p_player_id USING ERRCODE = 'P0002';
    END IF;

    v_sanitized := public.sanitize_player_patch(p_patch);
    FOR v_key IN SELECT jsonb_object_keys(v_sanitized) LOOP
        IF v_key NOT IN ('paid', 'waiver_received', 'medical_form_received') THEN
            RAISE EXCEPTION 'field % is not coach-editable', v_key USING ERRCODE = '42501';
        END IF;
    END LOOP;

    IF NOT public.is_org_admin(v_player.organization_id) THEN
        -- The caller must coach the player's team.
        SELECT EXISTS (
            SELECT 1
            FROM public.teams t
            JOIN public.coaches c ON c.id = t.coach_id
            WHERE t.organization_id = v_player.organization_id
              AND (t.id = v_player.team_id OR EXISTS (
                  SELECT 1 FROM public.team_players tp
                  WHERE tp.team_id = t.id AND tp.player_id = v_player.id
              ))
              AND (c.user_id = auth.uid() OR c.profile_id = auth.uid())
        ) INTO v_is_team_coach;

        IF NOT v_is_team_coach THEN
            RAISE EXCEPTION 'Access denied: caller does not coach this player''s team'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    PERFORM public.apply_player_patch(p_player_id, v_sanitized);

    PERFORM public.record_audit_event(
        v_player.organization_id,
        'player.compliance_updated',
        'players',
        p_player_id,
        jsonb_build_object('patch', v_sanitized)
    );

    SELECT * INTO v_player FROM public.players WHERE id = p_player_id;
    RETURN v_player;
END;
$$;

COMMENT ON FUNCTION public.coach_update_player_compliance(p_player_id uuid, p_patch jsonb) IS 'Audited compliance-boolean patch (paid/waiver/medical) for coaches of the player''s team.';

REVOKE ALL ON FUNCTION public.coach_update_player_compliance(p_player_id uuid, p_patch jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.coach_update_player_compliance(p_player_id uuid, p_patch jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.coach_update_player_compliance(p_player_id uuid, p_patch jsonb) TO service_role;


-- 5. The three kept functions' previous bodies (CREATE OR REPLACE keeps their grants).

CREATE OR REPLACE FUNCTION public.sanitize_player_patch(p_patch jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $_$
DECLARE
    v_out jsonb := '{}'::jsonb;
    v_key text;
    v_val jsonb;
    v_text text;
    v_num numeric;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch must be a JSON object' USING ERRCODE = '22023';
    END IF;

    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_patch) LOOP
        CASE v_key
            WHEN 'first_name', 'last_name', 'preferred_name', 'gender', 'grade', 'notes',
                 'buddy_request' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                IF v_key IN ('first_name', 'last_name') AND v_text IS NULL THEN
                    RAISE EXCEPTION '% cannot be empty', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_text));
            WHEN 'status' THEN
                v_text := lower(trim(v_val #>> '{}'));
                IF v_text NOT IN ('active', 'inactive', 'pending', 'waitlist') THEN
                    RAISE EXCEPTION 'invalid status %', v_text USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('status', to_jsonb(v_text));
            WHEN 'rating' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 1 OR v_num > 5 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'rating must be an integer 1-5' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('rating', to_jsonb(v_num));
            WHEN 'years_played' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 0 OR v_num > 30 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'years_played must be an integer 0-30' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('years_played', to_jsonb(v_num));
            WHEN 'jersey_number' THEN
                v_num := CASE WHEN jsonb_typeof(v_val) = 'null' THEN NULL ELSE (v_val #>> '{}')::numeric END;
                IF v_num IS NOT NULL AND (v_num < 0 OR v_num > 999 OR v_num <> round(v_num)) THEN
                    RAISE EXCEPTION 'jersey_number must be an integer 0-999' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('jersey_number', to_jsonb(v_num));
            WHEN 'paid', 'waiver_received', 'medical_form_received', 'willing_to_coach' THEN
                IF jsonb_typeof(v_val) <> 'boolean' THEN
                    RAISE EXCEPTION '% must be boolean', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, v_val);
            WHEN 'division_id', 'team_id' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                IF v_text IS NOT NULL AND v_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    RAISE EXCEPTION '% must be a uuid', v_key USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object(v_key, to_jsonb(v_text));
            WHEN 'date_of_birth' THEN
                v_text := NULLIF(trim(v_val #>> '{}'), '');
                v_out := v_out || jsonb_build_object('date_of_birth', to_jsonb(v_text));
            WHEN 'guardian_contacts' THEN
                -- Array of {name?, email?, phone?, alternate_email?} objects
                -- (the Player record guardians editor).
                IF jsonb_typeof(v_val) <> 'array' THEN
                    RAISE EXCEPTION 'guardian_contacts must be an array' USING ERRCODE = '22023';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM jsonb_array_elements(v_val) g
                    WHERE jsonb_typeof(g.value) <> 'object'
                       OR EXISTS (
                           SELECT 1 FROM jsonb_object_keys(g.value) k
                           -- 'primary'/'relationship' appear in legacy seed/import
                           -- data and must round-trip through record-page edits.
                           WHERE k NOT IN ('name', 'email', 'phone', 'alternate_email',
                                           'primary', 'relationship')
                       )
                ) THEN
                    RAISE EXCEPTION 'guardian_contacts entries allow only name/email/phone/alternate_email/primary/relationship'
                        USING ERRCODE = '22023';
                END IF;
                IF jsonb_array_length(v_val) > 6 THEN
                    RAISE EXCEPTION 'guardian_contacts limited to 6 entries' USING ERRCODE = '22023';
                END IF;
                v_out := v_out || jsonb_build_object('guardian_contacts', v_val);
            ELSE
                RAISE EXCEPTION 'field % is not editable', v_key USING ERRCODE = '22023';
        END CASE;
    END LOOP;

    IF v_out = '{}'::jsonb THEN
        RAISE EXCEPTION 'patch contains no editable fields' USING ERRCODE = '22023';
    END IF;

    RETURN v_out;
END;
$_$;

CREATE OR REPLACE FUNCTION public.apply_player_patch(p_player_id uuid, p_sanitized jsonb) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $$
BEGIN
    UPDATE public.players p
    SET
        first_name      = COALESCE(CASE WHEN p_sanitized ? 'first_name' THEN p_sanitized->>'first_name' END, p.first_name),
        last_name       = COALESCE(CASE WHEN p_sanitized ? 'last_name' THEN p_sanitized->>'last_name' END, p.last_name),
        preferred_name  = CASE WHEN p_sanitized ? 'preferred_name' THEN p_sanitized->>'preferred_name' ELSE p.preferred_name END,
        gender          = CASE WHEN p_sanitized ? 'gender' THEN p_sanitized->>'gender' ELSE p.gender END,
        grade           = CASE WHEN p_sanitized ? 'grade' THEN p_sanitized->>'grade' ELSE p.grade END,
        notes           = CASE WHEN p_sanitized ? 'notes' THEN p_sanitized->>'notes' ELSE p.notes END,
        buddy_request   = CASE WHEN p_sanitized ? 'buddy_request' THEN p_sanitized->>'buddy_request' ELSE p.buddy_request END,
        status          = CASE WHEN p_sanitized ? 'status' THEN p_sanitized->>'status' ELSE p.status END,
        rating          = CASE WHEN p_sanitized ? 'rating' THEN (p_sanitized->>'rating')::smallint ELSE p.rating END,
        years_played    = CASE WHEN p_sanitized ? 'years_played' THEN (p_sanitized->>'years_played')::smallint ELSE p.years_played END,
        jersey_number   = CASE WHEN p_sanitized ? 'jersey_number' THEN (p_sanitized->>'jersey_number')::smallint ELSE p.jersey_number END,
        paid            = COALESCE(CASE WHEN p_sanitized ? 'paid' THEN (p_sanitized->>'paid')::boolean END, p.paid),
        waiver_received = COALESCE(CASE WHEN p_sanitized ? 'waiver_received' THEN (p_sanitized->>'waiver_received')::boolean END, p.waiver_received),
        medical_form_received = COALESCE(CASE WHEN p_sanitized ? 'medical_form_received' THEN (p_sanitized->>'medical_form_received')::boolean END, p.medical_form_received),
        willing_to_coach = COALESCE(CASE WHEN p_sanitized ? 'willing_to_coach' THEN (p_sanitized->>'willing_to_coach')::boolean END, p.willing_to_coach),
        division_id     = CASE WHEN p_sanitized ? 'division_id' THEN (p_sanitized->>'division_id')::uuid ELSE p.division_id END,
        team_id         = CASE WHEN p_sanitized ? 'team_id' THEN (p_sanitized->>'team_id')::uuid ELSE p.team_id END,
        date_of_birth   = CASE WHEN p_sanitized ? 'date_of_birth' THEN (p_sanitized->>'date_of_birth')::date ELSE p.date_of_birth END,
        guardian_contacts = CASE WHEN p_sanitized ? 'guardian_contacts' THEN p_sanitized->'guardian_contacts' ELSE p.guardian_contacts END,
        updated_at      = timezone('utc', now())
    WHERE p.id = p_player_id;

    -- team_players is the relational source of truth for rosters (portals,
    -- summaries, scheduler filters read it). Keep it in sync whenever the
    -- denormalized players.team_id is patched, so Team Builder moves are
    -- visible everywhere.
    IF p_sanitized ? 'team_id' THEN
        DELETE FROM public.team_players tp WHERE tp.player_id = p_player_id;
        IF p_sanitized->>'team_id' IS NOT NULL THEN
            INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
            SELECT (p_sanitized->>'team_id')::uuid, p.id, p.organization_id, 'player', 'manual'
            FROM public.players p
            WHERE p.id = p_player_id
            ON CONFLICT (team_id, player_id) DO NOTHING;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_import_job(p_import_job_id uuid, p_validation_errors jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    SET "TimeZone" TO 'UTC'
    AS $_$
DECLARE
    v_job public.import_jobs%ROWTYPE;
    v_now timestamptz := now();
    v_validation_errors jsonb := COALESCE(p_validation_errors, '[]'::jsonb);
    v_error_count integer := 0;
    v_total_promoted_count integer := 0;
    v_status text;
    v_result jsonb;
    v_gender_model text;
    v_season_settings_id uuid;
    v_waitlist_enabled boolean := true;
    v_created_divisions integer := 0;
    v_declared jsonb;
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

    -- The organization's declared player fields, read once for every row.
    v_declared := public.import_declared_fields(v_job.organization_id, 'player');

    v_error_count := jsonb_array_length(v_validation_errors);
    v_status := CASE WHEN v_error_count > 0 THEN 'completed_with_warnings' ELSE 'completed' END;

    -- Org division format: 'split' (default) -> gendered U8B/U8G; 'coed' -> U8.
    SELECT COALESCE(o.feature_flags->>'gender_model', 'split'),
           COALESCE((o.feature_flags->>'waitlist')::boolean, true)
    INTO v_gender_model, v_waitlist_enabled
    FROM public.organizations o
    WHERE o.id = v_job.organization_id;
    IF v_gender_model NOT IN ('split', 'coed') THEN
        v_gender_model := 'split';
    END IF;

    -- Season that auto-created divisions attach to (divisions are per-season).
    SELECT s.id
    INTO v_season_settings_id
    FROM public.season_settings s
    WHERE s.organization_id = v_job.organization_id
    ORDER BY (s.status = 'active') DESC, s.season_start DESC NULLS LAST, s.created_at DESC
    LIMIT 1;

    -- Auto-create derived divisions that don't exist yet for that season.
    IF v_season_settings_id IS NOT NULL THEN
        WITH staged AS (
            SELECT
                public.import_payload_text(
                    sp.normalized_payload, 'age group', 'age_group', 'age'
                ) AS age_text,
                lower(left(COALESCE(
                    public.import_payload_text(sp.normalized_payload, 'gender'), ''
                ), 1)) AS g
            FROM public.staging_players sp
            WHERE sp.import_job_id = p_import_job_id
              AND sp.organization_id = v_job.organization_id
              AND sp.promoted_at IS NULL
              AND sp.normalized_payload IS NOT NULL
              AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
        ),
        derived AS (
            SELECT DISTINCT
                'U' || (age_text::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN g IN ('m', 'b') THEN 'B'
                        WHEN g IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END AS name,
                CASE
                    WHEN v_gender_model = 'coed' THEN 'coed'
                    WHEN g IN ('m', 'b') THEN 'boys'
                    WHEN g IN ('f', 'g') THEN 'girls'
                    ELSE 'coed'
                END AS gender_policy
            FROM staged
            WHERE age_text ~ '^[0-9]+$'
        ),
        created AS (
            INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy)
            SELECT v_job.organization_id, v_season_settings_id, d.name, d.gender_policy::gender_policy_enum
            FROM derived d
            WHERE NOT EXISTS (
                SELECT 1 FROM public.divisions x
                WHERE x.organization_id = v_job.organization_id
                  AND x.season_settings_id = v_season_settings_id
                  AND lower(x.name) = lower(d.name)
            )
            ON CONFLICT (season_settings_id, name) DO NOTHING
            RETURNING id
        )
        SELECT count(*) INTO v_created_divisions FROM created;
    END IF;

    WITH pending AS MATERIALIZED (
        SELECT
            sp.id AS staging_id,
            sp.source_row_number,
            sp.organization_id,
            sp.normalized_payload,
            public.import_payload_text(
                sp.normalized_payload,
                'external_registration_id', 'gotsport_id', 'registration_id', 'player_id'
            ) AS external_registration_id,
            public.import_payload_text(sp.normalized_payload, 'division_id') AS division_id_text,
            public.import_payload_text(
                sp.normalized_payload,
                'division_name', 'division', 'group', 'program'
            ) AS explicit_division_name,
            -- Gendered division derived from age group + gender, honoring the
            -- org gender_model. A player of age N plays in division U(N+1).
            CASE
                WHEN public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age') ~ '^[0-9]+$'
                THEN 'U' || ((public.import_payload_text(sp.normalized_payload, 'age group', 'age_group', 'age'))::int + 1)
                    || CASE
                        WHEN v_gender_model = 'coed' THEN ''
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('m', 'b') THEN 'B'
                        WHEN lower(left(COALESCE(public.import_payload_text(sp.normalized_payload, 'gender'), ''), 1)) IN ('f', 'g') THEN 'G'
                        ELSE ''
                    END
            END AS derived_division_name,
            public.import_payload_text(sp.normalized_payload, 'first_name') AS first_name,
            public.import_payload_text(sp.normalized_payload, 'last_name') AS last_name,
            public.import_payload_text(sp.normalized_payload, 'preferred_name', 'nickname') AS preferred_name,
            public.import_text_to_date(
                public.import_payload_text(sp.normalized_payload, 'date_of_birth', 'dob')
            ) AS date_of_birth,
            public.import_payload_text(sp.normalized_payload, 'grade') AS grade,
            public.import_payload_text(sp.normalized_payload, 'gender') AS gender,
            public.import_payload_text(sp.normalized_payload, 'birth_year') AS birth_year_text,
            lower(public.import_payload_text(sp.normalized_payload, 'skill_tier', 'skill_level')) AS skill_tier_text,
            public.import_payload_text(
                sp.normalized_payload,
                'years_played', 'years played',
                'how many years has your player played in an organized soccer program?'
            ) AS years_played_text,
            lower(COALESCE(public.import_payload_text(
                sp.normalized_payload, 'waitlist', 'waitlisted'
            ), '')) AS waitlist_text,
            public.import_payload_text(
                sp.normalized_payload,
                'play_up', 'play up',
                'are you coaching so this player can play up a division?'
            ) AS play_up_text,
            public.import_payload_text(sp.normalized_payload, 'buddy_request') AS buddy_request,
            -- Nullable: NULL means the coaching-interest column is genuinely
            -- absent from this row's payload (re-import should preserve the
            -- existing player's willing_to_coach), distinct from a present-
            -- but-negative answer, which lower()s to a non-matching string.
            lower(public.import_payload_text(
                sp.normalized_payload,
                'willing_to_coach', 'coach_volunteer',
                'can you coach for this player''s team?'
            )) AS coaching_answer,
            public.import_payload_text(sp.normalized_payload, 'team name') AS team_name,
            public.import_payload_text(sp.normalized_payload, 'team age') AS team_age,
            public.import_payload_text(sp.normalized_payload, 'team gender') AS team_gender,
            -- The allowlist (R0): only the fields the organization declared
            -- for players, keyed by their declared names. Every other column
            -- of the export is dropped here, whatever reached staging.
            public.import_declared_attributes(v_declared, sp.normalized_payload)
                AS custom_attributes
        FROM public.staging_players sp
        WHERE sp.import_job_id = p_import_job_id
          AND sp.organization_id = v_job.organization_id
          AND sp.promoted_at IS NULL
          AND sp.normalized_payload IS NOT NULL
          AND COALESCE(jsonb_array_length(sp.validation_errors), 0) = 0
    ),
    valid_candidates AS MATERIALIZED (
        SELECT
            p.*,
            COALESCE(p.explicit_division_name, p.derived_division_name) AS division_name,
            d.id AS division_id,
            CASE
                WHEN p.birth_year_text ~ '^\d{4}$' THEN p.birth_year_text::integer
                WHEN p.date_of_birth IS NOT NULL THEN EXTRACT(YEAR FROM p.date_of_birth)::integer
                ELSE NULL
            END AS birth_year,
            CASE
                WHEN p.skill_tier_text IN ('novice', 'developing', 'advanced') THEN p.skill_tier_text
                ELSE NULL
            END AS skill_tier,
            CASE
                WHEN p.years_played_text ~ '^[0-9]{1,2}$'
                     AND p.years_played_text::int BETWEEN 0 AND 30
                THEN p.years_played_text::smallint
            END AS years_played,
            CASE
                WHEN v_waitlist_enabled
                     AND p.waitlist_text IN ('true', 't', 'yes', 'y', '1') THEN 'waitlist'
                ELSE 'active'
            END AS import_status,
            -- NULL when the coaching-interest column is absent (preserve
            -- existing value on re-import); a boolean otherwise.
            CASE
                WHEN p.coaching_answer IS NULL THEN NULL
                ELSE p.coaching_answer IN ('true', 't', 'yes', 'y', '1', 'maybe', 'coach',
                    'head coach', 'assistant coach', 'volunteer', 'willing')
            END AS willing_to_coach,
            (p.custom_attributes
                || jsonb_strip_nulls(jsonb_build_object(
                    'team_name', p.team_name,
                    'team_age', p.team_age,
                    'team_gender', p.team_gender
                ))
                || CASE
                    WHEN p.play_up_text IS NOT NULL
                    THEN jsonb_build_object('play_up', p.play_up_text)
                    ELSE '{}'::jsonb
                END
                || CASE
                    WHEN p.coaching_answer IS NOT NULL AND p.coaching_answer <> ''
                    THEN jsonb_build_object('coaching_answer', p.coaching_answer)
                    ELSE '{}'::jsonb
                END
            ) AS final_custom_attributes
        FROM pending p
        LEFT JOIN LATERAL (
            SELECT divisions.id
            FROM public.divisions
            WHERE divisions.organization_id = p.organization_id
              AND (
                  divisions.id = CASE
                      WHEN p.division_id_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN p.division_id_text::uuid
                      ELSE NULL
                  END
                  -- Name matches are season-scoped (divisions are unique per
                  -- season); without this, a new season's import attaches
                  -- players to a prior season's same-named division.
                  OR (
                      (v_season_settings_id IS NULL
                       OR divisions.season_settings_id = v_season_settings_id)
                      AND (
                          lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))
                          OR lower(divisions.name) = lower(COALESCE(p.derived_division_name, ''))
                      )
                  )
              )
            ORDER BY
                -- Prefer explicit id, then explicit name, then derived name.
                (divisions.id::text = p.division_id_text) DESC,
                (lower(divisions.name) = lower(COALESCE(p.explicit_division_name, ''))) DESC,
                divisions.created_at DESC, divisions.id
            LIMIT 1
        ) d ON true
        WHERE p.first_name IS NOT NULL
          AND p.last_name IS NOT NULL
          AND p.date_of_birth IS NOT NULL
    ),
    deduped_external AS MATERIALIZED (
        SELECT DISTINCT ON (organization_id, external_registration_id) *
        FROM valid_candidates
        WHERE external_registration_id IS NOT NULL
        ORDER BY organization_id, external_registration_id, source_row_number NULLS LAST, staging_id
    ),
    existing_matches AS MATERIALIZED (
        SELECT de.staging_id, matched_players.id AS player_id
        FROM deduped_external de
        JOIN LATERAL (
            SELECT players.id
            FROM public.players
            WHERE players.organization_id = de.organization_id
              AND players.external_registration_id = de.external_registration_id
            ORDER BY players.created_at, players.id
            LIMIT 1
        ) matched_players ON true
    ),
    updated_existing AS (
        UPDATE public.players p
        SET
            division_id = COALESCE(de.division_id, p.division_id),
            first_name = de.first_name,
            last_name = de.last_name,
            preferred_name = COALESCE(de.preferred_name, p.preferred_name),
            date_of_birth = de.date_of_birth,
            grade = COALESCE(de.grade, p.grade),
            gender = COALESCE(de.gender, p.gender),
            birth_year = COALESCE(de.birth_year, p.birth_year),
            skill_tier = COALESCE(de.skill_tier, p.skill_tier),
            years_played = COALESCE(de.years_played, p.years_played),
            status = CASE
                WHEN de.import_status = 'waitlist' THEN 'waitlist'
                WHEN p.status = 'waitlist' AND de.import_status = 'active' THEN 'active'
                ELSE p.status
            END,
            willing_to_coach = COALESCE(de.willing_to_coach, p.willing_to_coach),
            coach_volunteer = COALESCE(de.willing_to_coach, p.coach_volunteer),
            buddy_request = COALESCE(de.buddy_request, p.buddy_request),
            -- An existing player's undeclared keys go too; the import's own
            -- keys (play-up, coaching answer, team placement) stay.
            custom_attributes = public.import_kept_player_attributes(v_declared, p.custom_attributes)
                || de.final_custom_attributes,
            last_imported_at = v_now,
            import_source = 'gotsport',
            registration_history = COALESCE(p.registration_history, '[]'::jsonb)
                || jsonb_build_array(jsonb_build_object(
                    'import_job_id', p_import_job_id,
                    'imported_at', v_now,
                    'source', 'gotsport',
                    'operation', 'updated'
                ))
        FROM deduped_external de
        JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE p.id = em.player_id
        RETURNING p.id
    ),
    insert_source AS MATERIALIZED (
        SELECT de.*
        FROM deduped_external de
        LEFT JOIN existing_matches em ON em.staging_id = de.staging_id
        WHERE em.player_id IS NULL

        UNION ALL

        SELECT vc.*
        FROM valid_candidates vc
        WHERE vc.external_registration_id IS NULL
    ),
    inserted_new AS (
        INSERT INTO public.players (
            organization_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            date_of_birth,
            grade,
            gender,
            birth_year,
            skill_tier,
            years_played,
            paid,
            status,
            coach_volunteer,
            willing_to_coach,
            buddy_request,
            guardian_contacts,
            registration_history,
            contact_info,
            last_imported_at,
            import_source,
            custom_attributes
        )
        SELECT
            organization_id,
            division_id,
            first_name,
            last_name,
            preferred_name,
            external_registration_id,
            date_of_birth,
            grade,
            gender,
            birth_year,
            skill_tier,
            years_played,
            false,
            import_status,
            COALESCE(willing_to_coach, false),
            COALESCE(willing_to_coach, false),
            buddy_request,
            '[]'::jsonb,
            jsonb_build_array(jsonb_build_object(
                'import_job_id', p_import_job_id,
                'imported_at', v_now,
                'source', 'gotsport',
                'operation', 'inserted'
            )),
            '{}'::jsonb,
            v_now,
            'gotsport',
            final_custom_attributes
        FROM insert_source
        RETURNING id
    ),
    promoted AS (
        UPDATE public.staging_players sp
        SET
            promoted_at = v_now,
            promoted_by = auth.uid()
        WHERE sp.id IN (SELECT staging_id FROM valid_candidates)
        RETURNING sp.id
    )
    SELECT jsonb_build_object(
        'staged_rows', (SELECT count(*) FROM pending),
        'valid_staged_rows', (SELECT count(*) FROM valid_candidates),
        'promoted_rows', (SELECT count(*) FROM promoted),
        'updated_players', (SELECT count(*) FROM updated_existing),
        'inserted_players', (SELECT count(*) FROM inserted_new),
        'duplicate_external_rows',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NOT NULL)
            - (SELECT count(*) FROM deduped_external),
        'without_external_id',
            (SELECT count(*) FROM valid_candidates WHERE external_registration_id IS NULL),
        'unmatched_division_rows',
            (SELECT count(*) FROM valid_candidates WHERE division_name IS NOT NULL AND division_id IS NULL),
        'waitlisted_rows',
            (SELECT count(*) FROM valid_candidates WHERE import_status = 'waitlist'),
        'created_divisions', v_created_divisions,
        'validation_error_rows', v_error_count,
        'status', v_status
    )
    INTO v_result;

    SELECT count(*)
    INTO v_total_promoted_count
    FROM public.staging_players
    WHERE import_job_id = p_import_job_id
      AND promoted_at IS NOT NULL;

    v_result := v_result || jsonb_build_object('total_promoted_rows', v_total_promoted_count);

    UPDATE public.import_jobs
    SET
        status = v_status,
        processed_rows = v_total_promoted_count,
        progress_percent = 100,
        completed_at = v_now,
        error_summary = jsonb_build_object('rowErrors', v_validation_errors),
        warning_summary = jsonb_set(
            COALESCE(warning_summary, '{}'::jsonb),
            '{finalize}',
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
$_$;

COMMIT;
