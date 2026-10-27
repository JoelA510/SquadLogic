-- Field and venue permits: the record, the document, and what a coach may read (Phase C1; plan
-- docs/changes/2026-10-22-phase-c-permits.md, with the owner's rules of 2026-10-26 and the coach
-- narrowing admin-focus R6 decided). AGENTS.md rule 14: persistence, authorization and a new
-- Storage bucket, approved by the owner.
--
-- **What a permit is.** A permit is a record (who issued it, its number, the dates it is valid,
-- notes) with at most one file (a PDF, JPEG or PNG of up to 10 MiB), covering one or more venues
-- (`locations`) and/or fields. It is kept so a coach asked "show me your permit" can produce it.
-- **A permit never blocks anything** (owner, 2026-10-26): no import, scheduling run, publish or
-- export looks at this table. The only code that reads it besides its own RPCs is
-- `admin_delete_field`, which lists the permits it unlinks.
--
-- **The change.**
--   1. `facility_permits` and `facility_permit_scopes`: row level security on, SELECT policies
--      only (an admin or staff member of the organization; a coach, narrowed below), no write
--      policy and no write grant: the five RPCs are the only writers. Nothing for anon.
--   2. The coach read (owner decision 1, narrowed by admin-focus R6): a coach reads a permit only
--      for a field where a team they currently coach has a game (`games` on a `game_slots` field)
--      or a practice (`practice_assignments` on a `practice_slots` field), or for the venue of
--      such a field. A coach of a team scheduled elsewhere reads nothing, and a permit that also
--      covers other fields shows that coach only the scopes that concern them. A coach-role
--      member with no current team is no coach to the server, as everywhere since A3.
--   3. Five definer RPCs (`is_org_admin`, serialized on the permit row, one audit row each as
--      `settings.updated` / `facility_permit` / `setting: 'facility.permit'`):
--      `admin_create_facility_permit`, `admin_update_facility_permit` (replaces the scope set),
--      `admin_set_facility_permit_file` (the object must exist in the bucket under the permit's
--      own folder, with an allowed type and size; returns the previous path),
--      `admin_delete_facility_permit` (returns the file path), and
--      `get_facility_permits` (an admin: every permit; a coach: the narrowed set, 42501 for
--      anyone else): each permit with its scopes' names, a `retired` flag per scope, and a
--      `status` and `days_left` judged on the organization's own calendar day.
--   4. The private Storage bucket `facility-permits` (10 MiB; PDF, JPEG, PNG) and three
--      `storage.objects` policies, the `exports` migration's pattern (20261017000000): an object
--      is `<organization>/<permit>/<uuid>.<ext>`; an admin of the folder's organization uploads
--      (when the permit exists in that organization, and the organization is not a demo: the
--      purge could not clean the file, as 20261030010000 reasoned for the other buckets) and
--      removes; an admin reads any object, and a coach only the live file of a permit they may
--      read (never a replaced or orphaned one). There is no UPDATE policy: upload with
--      `upsert: false`.
--   5. `admin_delete_field` rebuilt from its latest body (20260909000000, md5 checked) with one
--      addition: a permit scoped to the field is listed among what the delete affects
--      (`kind: 'permit'`, `disposition: 'unlinked'`). The scope row goes with the field; the
--      permit, a document that outlives the ground, stays. Like a booking, a permit makes the
--      delete ask for confirmation first.
--   6. An end-state check.
--
-- No DDL touches the auth schema. The storage schema is touched exactly as the `exports`
-- migration does: a bucket row and policies on `storage.objects`. Every drop names its object,
-- with no CASCADE (ON DELETE CASCADE on the tables' own references is the schema's idiom).
--
-- Reversible: docs/sql/20261102010000_revert.sql (a NOTICE counts the permits and files it loses;
-- the bucket is dropped only when empty, since storage.protect_delete() refuses SQL deletes of
-- objects). Smoke: docs/sql/20261102010000_smoke.sql. pgTAP: supabase/tests/facility_permits.sql
-- and supabase/tests/storage_facility_permits_bucket.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What changes, counted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_fields bigint;
    v_locations bigint;
BEGIN
    SELECT count(*) INTO v_fields FROM public.fields;
    SELECT count(*) INTO v_locations FROM public.locations;
    RAISE NOTICE 'no permit exists yet: the % field(s) and % venue(s) have none, and admin_delete_field is rebuilt to list the ones that come', v_fields, v_locations;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The tables.
-- ---------------------------------------------------------------------------

CREATE TABLE public.facility_permits (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    issuer          text NOT NULL,
    permit_number   text,
    valid_from      date NOT NULL,
    valid_to        date NOT NULL,
    notes           text,
    file_path       text,
    file_name       text,
    file_mime       text,
    file_size       bigint,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT facility_permits_id_organization_key UNIQUE (id, organization_id),
    CONSTRAINT facility_permits_issuer_shape CHECK (issuer = btrim(issuer) AND char_length(issuer) BETWEEN 1 AND 200),
    -- A number keeps its leading zeros and its punctuation: it is text, never a number.
    CONSTRAINT facility_permits_number_shape CHECK (permit_number IS NULL
        OR (permit_number = btrim(permit_number) AND char_length(permit_number) BETWEEN 1 AND 100)),
    CONSTRAINT facility_permits_notes_shape CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 2000),
    -- valid_to is the last valid day: inclusive.
    CONSTRAINT facility_permits_dates CHECK (valid_to >= valid_from),
    -- The four file columns are all set or all null, and the path is inside the permit's own folder.
    CONSTRAINT facility_permits_file_together CHECK (
        (file_path IS NULL) = (file_name IS NULL)
        AND (file_path IS NULL) = (file_mime IS NULL)
        AND (file_path IS NULL) = (file_size IS NULL)),
    CONSTRAINT facility_permits_file_path_in_folder CHECK (
        file_path IS NULL OR file_path LIKE organization_id::text || '/' || id::text || '/%'),
    CONSTRAINT facility_permits_file_name_shape CHECK (file_name IS NULL
        OR (file_name = btrim(file_name) AND char_length(file_name) BETWEEN 1 AND 255
            AND file_name !~ '[/\\]')),
    CONSTRAINT facility_permits_file_mime_allowed CHECK (file_mime IS NULL
        OR file_mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    CONSTRAINT facility_permits_file_size_limit CHECK (file_size IS NULL OR file_size BETWEEN 1 AND 10485760)
);

CREATE INDEX idx_facility_permits_organization_id ON public.facility_permits (organization_id);
CREATE UNIQUE INDEX facility_permits_file_path_key ON public.facility_permits (file_path) WHERE file_path IS NOT NULL;

CREATE TRIGGER facility_permits_set_timestamp
    BEFORE UPDATE ON public.facility_permits
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();

COMMENT ON TABLE public.facility_permits IS
    'A permit for a venue or field: issuer, number (text), the inclusive dates it is valid, notes, and at most one file in the facility-permits bucket. Written only by admin_create_facility_permit, admin_update_facility_permit, admin_set_facility_permit_file and admin_delete_facility_permit. A permit blocks nothing. 20261102010000.';
COMMENT ON COLUMN public.facility_permits.valid_to IS
    'The last valid day, inclusive. A permit is expiring from 30 days before it (days_left 0 to 30) and expired the day after.';
COMMENT ON COLUMN public.facility_permits.file_path IS
    'The object name in the facility-permits bucket, <organization>/<permit>/<uuid>.<ext>; NULL until a file is attached. file_name, file_mime and file_size are set with it.';

ALTER TABLE public.facility_permits ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.facility_permit_scopes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    permit_id       uuid NOT NULL,
    organization_id uuid NOT NULL,
    location_id     uuid REFERENCES public.locations (id) ON DELETE CASCADE,
    field_id        uuid REFERENCES public.fields (id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT facility_permit_scopes_permit_fkey
        FOREIGN KEY (permit_id, organization_id)
        REFERENCES public.facility_permits (id, organization_id) ON DELETE CASCADE,
    -- A scope names one venue or one field. Sub-surfaces are not a scope: nothing books onto them.
    CONSTRAINT facility_permit_scopes_one_target CHECK (num_nonnulls(location_id, field_id) = 1)
);

CREATE UNIQUE INDEX facility_permit_scopes_permit_location_key
    ON public.facility_permit_scopes (permit_id, location_id) WHERE location_id IS NOT NULL;
CREATE UNIQUE INDEX facility_permit_scopes_permit_field_key
    ON public.facility_permit_scopes (permit_id, field_id) WHERE field_id IS NOT NULL;
CREATE INDEX idx_facility_permit_scopes_organization_id ON public.facility_permit_scopes (organization_id);
CREATE INDEX idx_facility_permit_scopes_location_id ON public.facility_permit_scopes (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX idx_facility_permit_scopes_field_id ON public.facility_permit_scopes (field_id) WHERE field_id IS NOT NULL;

COMMENT ON TABLE public.facility_permit_scopes IS
    'What a permit covers: one row per venue (location_id) or field (field_id). A deleted field or venue takes its scope rows; the permit stays. Written only by the permit RPCs. 20261102010000.';

ALTER TABLE public.facility_permit_scopes ENABLE ROW LEVEL SECURITY;

-- Default privileges hand new tables to authenticated and service_role with every privilege, so
-- the revoke names them too (the 20261006000000 reasoning). Reads only: the RPCs write.
REVOKE ALL ON public.facility_permits FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.facility_permit_scopes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.facility_permits TO authenticated, service_role;
GRANT SELECT ON public.facility_permit_scopes TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The helpers.
-- ---------------------------------------------------------------------------

-- Internal: a permit's status on a day. One reading, in SQL; packages/core/src/facility/permits.js
-- (`permitStatus`) is its twin and tests/facilityPermits.test.js holds the boundaries equal.
-- The lead time is fixed at 30 days (owner decision 4); a league setting is added if asked.
CREATE FUNCTION public.facility_permit_status(p_valid_from date, p_valid_to date, p_today date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
    SELECT CASE
        WHEN p_today < p_valid_from THEN 'not_yet_valid'
        WHEN p_today > p_valid_to THEN 'expired'
        WHEN p_valid_to - p_today <= 30 THEN 'expiring'
        ELSE 'valid'
    END;
$$;

REVOKE ALL ON FUNCTION public.facility_permit_status(date, date, date) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.facility_permit_status(date, date, date) IS
    'Internal: not_yet_valid before valid_from, expired after valid_to (the last valid day), expiring when valid_to is 0 to 30 days away, else valid. 20261102010000.';

-- Internal: today on the organization's own calendar: the active season's timezone, UTC when unset
-- or unreadable (the `team_local_today` contract). One season is active per organization since
-- 20261101010000, so the read is deterministic.
CREATE FUNCTION public.org_local_today(p_organization_id uuid)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tz text;
BEGIN
    SELECT NULLIF(btrim(ss.timezone), '') INTO v_tz
      FROM public.season_settings ss
     WHERE ss.organization_id = p_organization_id AND ss.status = 'active'
     ORDER BY ss.created_at DESC, ss.id
     LIMIT 1;
    IF v_tz IS NOT NULL THEN
        BEGIN
            RETURN (now() AT TIME ZONE v_tz)::date;
        EXCEPTION WHEN invalid_parameter_value THEN
            -- An unreadable stored zone counts as unset: UTC, below.
            NULL;
        END;
    END IF;
    RETURN (now() AT TIME ZONE 'UTC')::date;
END;
$$;

REVOKE ALL ON FUNCTION public.org_local_today(uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.org_local_today(uuid) IS
    'Internal: today on the organization''s calendar (the active season''s timezone; UTC when unset or unreadable). 20261102010000.';

-- Internal: the fields where a team `p_user_id` currently coaches has a game or a practice. The
-- schedule the coach home shows reads the same two tables (fetchTeamEvents): a game through its
-- slot, a practice through its practice slot.
CREATE FUNCTION public.coach_field_ids_of(p_organization_id uuid, p_user_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH mine AS MATERIALIZED (
        SELECT t AS team_id FROM public.coached_team_ids_of(p_organization_id, p_user_id) t
    )
    SELECT gs.field_id
      FROM public.games g
      JOIN public.game_slots gs ON gs.id = g.game_slot_id
     WHERE g.organization_id = p_organization_id
       AND gs.organization_id = p_organization_id
       AND gs.field_id IS NOT NULL
       AND (g.home_team_id IN (SELECT team_id FROM mine) OR g.away_team_id IN (SELECT team_id FROM mine))
    UNION
    SELECT ps.field_id
      FROM public.practice_assignments pa
      JOIN public.practice_slots ps ON ps.id IN (pa.practice_slot_id, pa.slot_id)
     WHERE pa.organization_id = p_organization_id
       AND ps.organization_id = p_organization_id
       AND ps.field_id IS NOT NULL
       AND pa.team_id IN (SELECT team_id FROM mine);
$$;

REVOKE ALL ON FUNCTION public.coach_field_ids_of(uuid, uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.coach_field_ids_of(uuid, uuid) IS
    'Internal: the fields where a team the user currently coaches has a game (games on a game_slots field) or a practice (practice_assignments on a practice_slots field). No client role may execute it. 20261102010000.';

-- The three below are what the policies ask, so `authenticated` executes them (a policy runs with
-- the caller's privileges). Each is the caller's own question about themselves.

-- Does one of the caller's fields (or the venue of one) fall under this scope?
CREATE FUNCTION public.coach_covers_permit_scope(p_organization_id uuid, p_location_id uuid, p_field_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.coach_field_ids_of(p_organization_id, auth.uid()) c(field_id)
         WHERE (p_field_id IS NOT NULL AND c.field_id = p_field_id)
            OR (p_location_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.fields f
                     WHERE f.id = c.field_id AND f.location_id = p_location_id
                       AND f.organization_id = p_organization_id))
    );
$$;

-- May the caller, as a coach, read this permit: some scope of it concerns one of their fields?
CREATE FUNCTION public.coach_reads_facility_permit(p_permit_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.facility_permit_scopes s
         WHERE s.permit_id = p_permit_id
           AND public.coach_covers_permit_scope(s.organization_id, s.location_id, s.field_id)
    );
$$;

-- May the caller, as a coach, read this object: it is the LIVE file of a permit they may read?
CREATE FUNCTION public.coach_reads_facility_permit_file(p_organization_id uuid, p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.facility_permits p
         WHERE p.organization_id = p_organization_id
           AND p.file_path = p_name
           AND public.coach_reads_facility_permit(p.id)
    );
$$;

REVOKE ALL ON FUNCTION public.coach_covers_permit_scope(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coach_reads_facility_permit(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coach_reads_facility_permit_file(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coach_covers_permit_scope(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coach_reads_facility_permit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coach_reads_facility_permit_file(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.coach_covers_permit_scope(uuid, uuid, uuid) IS
    'Policy helper: true when one of the CALLER''s coached-team fields is the scope''s field or lies at the scope''s venue. Asks about the caller only. 20261102010000.';
COMMENT ON FUNCTION public.coach_reads_facility_permit(uuid) IS
    'Policy helper: true when some scope of the permit concerns a field where a team the caller currently coaches has a game or a practice. 20261102010000.';
COMMENT ON FUNCTION public.coach_reads_facility_permit_file(uuid, text) IS
    'Policy helper for the facility-permits bucket: true when the object is the live file_path of a permit the caller may read as a coach, so a replaced or orphaned file is never theirs. 20261102010000.';

-- ---------------------------------------------------------------------------
-- 4. The policies: reads only.
-- ---------------------------------------------------------------------------

CREATE POLICY "Facility permits: admins and scheduled coaches select"
    ON public.facility_permits
    FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id) OR public.coach_reads_facility_permit(id));

CREATE POLICY "Facility permit scopes: admins and scheduled coaches select"
    ON public.facility_permit_scopes
    FOR SELECT TO authenticated
    USING (public.is_org_admin(organization_id)
           OR public.coach_covers_permit_scope(organization_id, location_id, field_id));

-- ---------------------------------------------------------------------------
-- 5. The view of a permit, shared by every RPC that returns one.
-- ---------------------------------------------------------------------------

-- Internal. `p_coach_only` narrows the scopes to those that concern the caller's fields (a coach's
-- read); an admin's read shows them all.
CREATE FUNCTION public.facility_permit_json(p_permit_id uuid, p_today date, p_coach_only boolean)
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
               AND (NOT p_coach_only
                    OR public.coach_covers_permit_scope(s.organization_id, s.location_id, s.field_id))
        ), '[]'::jsonb),
        'created_at', p.created_at,
        'updated_at', p.updated_at
    )
    FROM public.facility_permits p
    WHERE p.id = p_permit_id;
$$;

REVOKE ALL ON FUNCTION public.facility_permit_json(uuid, date, boolean) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.facility_permit_json(uuid, date, boolean) IS
    'Internal: a permit as the RPCs return it: its fields, status and days_left on p_today, the file (path, name, mime, size) or null, and its scopes with names and a retired flag. p_coach_only keeps only the scopes that concern the caller''s fields. 20261102010000.';

-- ---------------------------------------------------------------------------
-- 6. The writers and the read.
-- ---------------------------------------------------------------------------
--
-- Each takes the organization from the caller and judges every id against it: a venue, a field or
-- a permit that is not that organization's is refused with one message whether it exists or not,
-- so an admin learns nothing about another organization's ids. Each write locks the permit row, so
-- two admins cannot interleave a replace of the file.

CREATE FUNCTION public.admin_create_facility_permit(
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

    v_view := public.facility_permit_json(v_permit.id, public.org_local_today(p_organization_id), false);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', v_permit.id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'created', 'current', v_view)
    );

    RETURN v_view;
END;
$$;

-- Internal: the shared validation of a permit's fields and scopes. Raises 22023 (the argument is
-- wrong) with a DETAIL that names the rule.
CREATE FUNCTION public.facility_permit_check(
    p_issuer text, p_number text, p_notes text, p_valid_from date, p_valid_to date,
    p_locations uuid[], p_fields uuid[], p_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF char_length(p_issuer) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'the issuer must be 1 to 200 characters' USING ERRCODE = '22023', DETAIL = 'issuer';
    END IF;
    IF p_number IS NOT NULL AND char_length(p_number) > 100 THEN
        RAISE EXCEPTION 'the permit number must be at most 100 characters' USING ERRCODE = '22023', DETAIL = 'permit_number';
    END IF;
    IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
        RAISE EXCEPTION 'the notes must be at most 2000 characters' USING ERRCODE = '22023', DETAIL = 'notes';
    END IF;
    IF p_valid_to < p_valid_from THEN
        RAISE EXCEPTION 'a permit cannot end (%) before it begins (%)', p_valid_to, p_valid_from
            USING ERRCODE = '22023', DETAIL = 'dates';
    END IF;
    IF COALESCE(cardinality(p_locations), 0) + COALESCE(cardinality(p_fields), 0) = 0 THEN
        RAISE EXCEPTION 'a permit covers at least one venue or field' USING ERRCODE = '22023', DETAIL = 'no_scope';
    END IF;
    IF COALESCE(cardinality(p_locations), 0) + COALESCE(cardinality(p_fields), 0) > 200 THEN
        RAISE EXCEPTION 'a permit covers at most 200 venues and fields' USING ERRCODE = '22023', DETAIL = 'too_many_scopes';
    END IF;
    IF (SELECT count(*) FROM public.locations l
         WHERE l.organization_id = p_organization_id AND l.id = ANY (p_locations))
       <> COALESCE(cardinality(p_locations), 0)
       OR (SELECT count(*) FROM public.fields f
            WHERE f.organization_id = p_organization_id AND f.id = ANY (p_fields))
       <> COALESCE(cardinality(p_fields), 0) THEN
        RAISE EXCEPTION 'a venue or field named is not in this organization' USING ERRCODE = '22023', DETAIL = 'scope_not_in_organization';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.facility_permit_check(text, text, text, date, date, uuid[], uuid[], uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.facility_permit_check(text, text, text, date, date, uuid[], uuid[], uuid) IS
    'Internal: the validation admin_create_facility_permit and admin_update_facility_permit share (22023 with a DETAIL naming the rule). 20261102010000.';

CREATE FUNCTION public.admin_update_facility_permit(
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
    v_previous := public.facility_permit_json(p_permit_id, v_today, false);

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

    v_view := public.facility_permit_json(p_permit_id, v_today, false);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'updated',
                           'previous', v_previous, 'current', v_view)
    );

    RETURN v_view;
END;
$$;

CREATE FUNCTION public.admin_set_facility_permit_file(
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
    v_previous := public.facility_permit_json(p_permit_id, v_today, false);

    UPDATE public.facility_permits
       SET file_path = p_object_path, file_name = v_name, file_mime = v_mime, file_size = v_size
     WHERE id = p_permit_id;

    v_view := public.facility_permit_json(p_permit_id, v_today, false);

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit',
                           'operation', CASE WHEN v_permit.file_path IS NULL THEN 'file_attached' ELSE 'file_replaced' END,
                           'previous_file', v_previous -> 'file', 'current_file', v_view -> 'file')
    );

    RETURN jsonb_build_object('permit', v_view, 'previous_path', v_permit.file_path);
END;
$$;

CREATE FUNCTION public.admin_delete_facility_permit(p_organization_id uuid, p_permit_id uuid)
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

    v_previous := public.facility_permit_json(p_permit_id, public.org_local_today(p_organization_id), false);

    DELETE FROM public.facility_permits WHERE id = p_permit_id;

    PERFORM public.record_audit_event(
        p_organization_id, 'settings.updated', 'facility_permit', p_permit_id,
        jsonb_build_object('setting', 'facility.permit', 'operation', 'deleted', 'previous', v_previous)
    );

    RETURN jsonb_build_object('id', p_permit_id, 'deleted', true, 'file_path', v_permit.file_path);
END;
$$;

CREATE FUNCTION public.get_facility_permits(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_admin boolean;
    v_today date;
    v_permits jsonb;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '23502';
    END IF;
    v_admin := public.is_org_admin(p_organization_id);
    -- Anyone but an admin must be a coach of a team right now: a coach-role member with no
    -- assignment is no coach to the server (20261021010000).
    IF NOT v_admin AND NOT EXISTS (
        SELECT 1 FROM public.coached_team_ids_of(p_organization_id, auth.uid())
    ) THEN
        RAISE EXCEPTION 'Access denied: permits are read by an administrator or a coach of a team' USING ERRCODE = '42501';
    END IF;

    v_today := public.org_local_today(p_organization_id);

    SELECT COALESCE(jsonb_agg(public.facility_permit_json(p.id, v_today, NOT v_admin)
                              ORDER BY p.valid_to, p.issuer, p.id), '[]'::jsonb)
      INTO v_permits
      FROM public.facility_permits p
     WHERE p.organization_id = p_organization_id
       AND (v_admin OR public.coach_reads_facility_permit(p.id));

    RETURN jsonb_build_object('today', v_today, 'lead_days', 30, 'permits', v_permits);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_facility_permit(uuid, text, text, date, date, text, uuid[], uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_facility_permit(uuid, uuid, text, text, date, date, text, uuid[], uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_facility_permit_file(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_facility_permit(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_facility_permits(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_facility_permit(uuid, text, text, date, date, text, uuid[], uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_facility_permit(uuid, uuid, text, text, date, date, text, uuid[], uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_facility_permit_file(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_facility_permit(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_facility_permits(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_create_facility_permit(uuid, text, text, date, date, text, uuid[], uuid[]) IS
    'Admin-only: record a permit (issuer, text number, inclusive dates, notes) covering the named venues and fields, all of this organization''s and at least one (22023 otherwise). Audited as facility.permit/created. A permit blocks nothing. 20261102010000.';
COMMENT ON FUNCTION public.admin_update_facility_permit(uuid, uuid, text, text, date, date, text, uuid[], uuid[]) IS
    'Admin-only: change a permit and replace its scope set; the file is untouched. Audited with the previous and current permit. 20261102010000.';
COMMENT ON FUNCTION public.admin_set_facility_permit_file(uuid, uuid, text, text) IS
    'Admin-only: attach (or replace) the permit''s file. The object must exist in the facility-permits bucket under this permit''s folder with an allowed type and size. Returns {permit, previous_path}; the caller removes the previous object after this commits. Audited as file_attached or file_replaced. 20261102010000.';
COMMENT ON FUNCTION public.admin_delete_facility_permit(uuid, uuid) IS
    'Admin-only: delete a permit and its scopes. Returns {id, deleted, file_path}; the caller removes the object after this commits. The audit row keeps the whole permit. 20261102010000.';
COMMENT ON FUNCTION public.get_facility_permits(uuid) IS
    'An admin or staff member reads every permit of the organization; a coach of a team reads the permits that concern a field where a team they currently coach has a game or a practice (or its venue), with only those scopes; anyone else gets 42501. Returns {today, lead_days, permits}: each permit with scope names, a retired flag per scope, and status and days_left on the organization''s own day. 20261102010000.';

-- ---------------------------------------------------------------------------
-- 7. The bucket and its policies (the `exports` migration's pattern).
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('facility-permits', 'facility-permits', false, 10485760,
            ARRAY['application/pdf', 'image/jpeg', 'image/png'])
    ON CONFLICT (id) DO UPDATE
        SET public = false,
            file_size_limit = 10485760,
            allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png'];

-- An object name that is not <organization uuid>/<permit uuid>/<uuid>.<pdf|jpg|jpeg|png> is
-- refused (a 42501), not an error: every cast sits in the THEN of a CASE whose WHEN tested the
-- shape, and CASE evaluates its branches in order where AND does not promise to.
DROP POLICY IF EXISTS "facility-permits select" ON storage.objects;
CREATE POLICY "facility-permits select"
    ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'facility-permits'
        AND CASE
            WHEN name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
                 OR public.coach_reads_facility_permit_file(((storage.foldername(name))[1])::uuid, name)
            ELSE false
        END
    );

DROP POLICY IF EXISTS "facility-permits org-admin insert" ON storage.objects;
CREATE POLICY "facility-permits org-admin insert"
    ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'facility-permits'
        AND CASE
            WHEN name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
                 AND NOT public.is_demo_org(((storage.foldername(name))[1])::uuid)
                 AND EXISTS (SELECT 1 FROM public.facility_permits p
                              WHERE p.id = ((storage.foldername(name))[2])::uuid
                                AND p.organization_id = ((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

DROP POLICY IF EXISTS "facility-permits org-admin delete" ON storage.objects;
CREATE POLICY "facility-permits org-admin delete"
    ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'facility-permits'
        AND CASE
            WHEN name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png)$'
            THEN public.is_org_admin(((storage.foldername(name))[1])::uuid)
            ELSE false
        END
    );

-- ---------------------------------------------------------------------------
-- 8. admin_delete_field, with the permits it unlinks listed.
-- ---------------------------------------------------------------------------
--
-- 20260909000000's body (the latest: nothing has replaced it since, and `ALTER FUNCTION` has not
-- touched it) with one addition, marked in place: the permits scoped to the field join `affected`
-- as `kind: 'permit'`, `disposition: 'unlinked'`. Every guard, the lock trio, the refusal shape and
-- every audit phase are carried across. The refusal's `reason` is `bookings_exist` while anything
-- but a permit is on the ground, and `permits_linked` when only permits are. A body this migration
-- has not seen stops it.

DO $guard$
DECLARE
    v_md5 text;
BEGIN
    -- Carriage returns stripped: production has stored a body with CRLF line ends before
    -- (upsert_division_for_import, which stopped the first deploy of 20261101010000), and the guard
    -- is about the text, not the line ends.
    SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.admin_delete_field(uuid, uuid, boolean)');
    IF v_md5 IS DISTINCT FROM '51c2d435c860594feba15f00d18c708a' THEN
        RAISE EXCEPTION 'public.admin_delete_field(uuid, uuid, boolean) has a body this migration has not seen (md5 %): not replacing it', v_md5;
    END IF;
END;
$guard$;


CREATE OR REPLACE FUNCTION public.admin_delete_field(
    p_organization_id uuid,
    p_field_id uuid,
    p_confirm boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_existing public.fields%ROWTYPE;
    v_affected jsonb;
    v_affected_count integer;
    v_permits jsonb;
    v_permit_count integer;
    v_scenario_ids uuid[];
    v_deleted_scenarios integer := 0;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_field_id IS NULL THEN
        RAISE EXCEPTION 'p_field_id is required'
            USING ERRCODE = '23502';
    END IF;

    -- **Locked and read BEFORE the delete, not returned by it.** The original
    -- deleted first and inferred not-found from the RETURNING being empty, so
    -- there was no window in which the field existed and the bookings could be
    -- counted.
    SELECT *
      INTO v_existing
      FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id
     FOR UPDATE;

    IF v_existing.id IS NULL THEN
        RAISE EXCEPTION 'field % was not found in organization %', p_field_id, p_organization_id
            USING ERRCODE = 'P0002';
    END IF;

    -- **Locking the field is not enough, because not everything the cascade
    -- reaches has a key to the field.**
    --
    -- `FOR UPDATE` on the `fields` row blocks a concurrent INSERT into any
    -- table with a foreign key TO that row, because such an insert takes a
    -- conflicting KEY SHARE lock on it. That covers the slot tables and the
    -- assignments' own `field_id`. It does NOT cover a `games` row, which
    -- references a game_slot and never the field, nor an assignment carrying
    -- only a slot id -- and both of those are destroyed by the cascade. So the
    -- guard would read one set while the delete removed a larger one: the exact
    -- defect this migration exists to fix, returning as a race.
    --
    -- Locking the field's SLOTS closes it: an insert that hangs a game or an
    -- assignment off one of them takes KEY SHARE on the slot row, which
    -- conflicts with this. Taken after the field, so the two RPCs acquire in
    -- one order and cannot deadlock against each other.
    PERFORM 1 FROM public.game_slots
     WHERE organization_id = p_organization_id AND field_id = p_field_id
     FOR UPDATE;
    PERFORM 1 FROM public.practice_slots
     WHERE organization_id = p_organization_id AND field_id = p_field_id
     FOR UPDATE;

    -- **Every booking the deletion would take -- all FIVE kinds**, and what
    -- it would do to each. The enumeration itself is `public.field_bookings`,
    -- shared with `admin_retire_field`, so "who is affected" has one answer.
    -- `p_after => NULL` means no date applies: a deletion takes everything on
    -- the ground, dated or not.
    --
    -- `disposition` turns the producer's `cascades` into the word the operator
    -- reads. It is decided PER ROW because it differs per row: a slot-linked
    -- assignment is destroyed by the slot cascade while a free-standing one
    -- keeps its row and loses its venue.
    --   'deleted'    -- a CASCADE reaches it; the row goes with the field
    --   'unassigned' -- only field_id is SET NULL; the row survives, venueless
    SELECT
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'kind', b.kind, 'id', b.booking_id, 'on_date', b.on_date,
            'week_index', b.week_index, 'undated', b.undated,
            'unbounded', b.unbounded,
            'disposition', CASE WHEN b.cascades THEN 'deleted' ELSE 'unassigned' END
          )
          ORDER BY b.on_date NULLS FIRST, b.kind, b.booking_id
        ),
        '[]'::jsonb
      ),
      COUNT(*)
    INTO v_affected, v_affected_count
    FROM public.field_bookings(p_organization_id, p_field_id, NULL) b;

    -- **The permits that name this field (20261102010000).** The scope row goes with the field
    -- (ON DELETE CASCADE) and the permit, a document that outlives the ground, stays; so each is
    -- listed here with `disposition: 'unlinked'`, and like a booking it makes the delete ask first.
    -- A permit that covers the field's VENUE is not listed: the venue is not going anywhere.
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'kind', 'permit', 'id', p.id, 'on_date', p.valid_to,
                 'week_index', NULL, 'undated', false, 'unbounded', false,
                 'disposition', 'unlinked',
                 'issuer', p.issuer, 'permit_number', p.permit_number
               )
               ORDER BY p.valid_to, p.id
             ),
             '[]'::jsonb
           ),
           COUNT(*)
      INTO v_permits, v_permit_count
      FROM public.facility_permits p
     WHERE p.organization_id = p_organization_id
       AND EXISTS (SELECT 1 FROM public.facility_permit_scopes s
                    WHERE s.permit_id = p.id AND s.field_id = p_field_id);

    v_affected := v_affected || v_permits;
    v_affected_count := v_affected_count + v_permit_count;

    -- **The refusal lives here, not in the UI.** A confirmation prompt a
    -- caller can skip by calling the RPC directly is not a guard. Same shape as
    -- admin_retire_field: RETURN, do not RAISE, and record the refusal.
    IF v_affected_count > 0 AND NOT COALESCE(p_confirm, false) THEN
        PERFORM public.record_audit_event(
            p_organization_id,
            'settings.updated',
            'field',
            p_field_id,
            jsonb_build_object(
                'setting', 'facility.field',
                'operation', 'admin_delete_field',
                'phase', 'refused',
                'reason', CASE WHEN v_affected_count > v_permit_count THEN 'bookings_exist' ELSE 'permits_linked' END,
                'affected_count', v_affected_count,
                -- A bounded rendering: the full list goes back to the CALLER,
                -- a sample and the per-kind counts go into the trail. A delete
                -- refused on a busy field would otherwise write an arbitrarily
                -- large audit row on every attempt.
                'affected', public.field_bookings_digest(v_affected),
                'previous', to_jsonb(v_existing)
            )
        );
        RETURN jsonb_build_object(
            'deleted', false,
            'reason', CASE WHEN v_affected_count > v_permit_count THEN 'bookings_exist' ELSE 'permits_linked' END,
            'affected_count', v_affected_count,
            'affected', v_affected
        );
    END IF;

    -- Audit BEFORE the delete, so the world the operator decided against is in
    -- the trail next to the decision. This runs in one transaction, so it does
    -- NOT survive a failure of the DELETE below -- the refusal above does,
    -- because that path RETURNs.
    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        p_field_id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'admin_delete_field',
            'phase', 'before',
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'affected', public.field_bookings_digest(v_affected),
            'previous', to_jsonb(v_existing)
        )
    );

    -- **Read BEFORE the delete.** 20260909000000 made the profile FK CASCADE,
    -- so the membership rows that answer "which scenarios did this field's
    -- profiles belong to" are gone by the time the DELETE returns.
    v_scenario_ids := public.field_availability_scenario_ids_on_field(
                        p_organization_id, p_field_id);

    DELETE FROM public.fields
     WHERE id = p_field_id
       AND organization_id = p_organization_id;

    -- ... and pruned after, on the contract
    -- `rollback_field_availability_import_job` already uses
    -- (20260522153000:214-226): narrow, so a scenario created empty by some
    -- other path is untouched. Without this a field delete could leave an
    -- active scenario holding nothing --
    -- `admin_select_field_availability_scenario` checks org, season and group
    -- and nothing about membership.
    v_deleted_scenarios := public.prune_empty_field_availability_scenarios(
                             p_organization_id, v_scenario_ids);

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.updated',
        'field',
        v_existing.id,
        jsonb_build_object(
            'setting', 'facility.field',
            'operation', 'admin_delete_field',
            'phase', 'after',
            'confirmed', COALESCE(p_confirm, false),
            'affected_count', v_affected_count,
            'deleted_availability_scenarios', v_deleted_scenarios,
            'deleted', true,
            'previous', to_jsonb(v_existing)
        )
    );

    RETURN jsonb_build_object(
        'id', v_existing.id,
        'organization_id', v_existing.organization_id,
        'deleted', true,
        'affected_count', v_affected_count,
        'deleted_availability_scenarios', v_deleted_scenarios,
        'affected', v_affected
    );
END;
$$;

COMMENT ON FUNCTION public.admin_delete_field(uuid, uuid, boolean) IS
  'Admin-only org-scoped field deletion. Refuses with everything the delete would take -- game_slots, games, game_assignments, practice_slots, practice_assignments, field_availability_profiles and (as of 20261102010000) the permits scoped to the field -- unless p_confirm is true, mirroring admin_retire_field. Each affected row carries a disposition: deleted (a CASCADE reaches it), unassigned (only its field_id is SET NULL) or, for a permit, unlinked (its scope row goes; the permit stays). Assignments report this per row, because a slot-linked assignment is destroyed while a free-standing one survives. An availability_profile reports deleted, and its formats, scenario memberships, blackout windows and equipment requirements go with it. Returns {deleted:false, reason:''bookings_exist'' (''permits_linked'' when only permits are on the field), affected_count, affected} on refusal rather than raising, and audits refused/before/after.';

-- ---------------------------------------------------------------------------
-- 9. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_n integer;
    v_sig text;
    v_def text;
BEGIN
    -- The tables: row level security on, one read policy each, no write policy, nothing for anon,
    -- read-only for signed-in users.
    FOREACH v_sig IN ARRAY ARRAY['facility_permits', 'facility_permit_scopes'] LOOP
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_sig)::regclass) THEN
            RAISE EXCEPTION '% has row level security off', v_sig;
        END IF;
        SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_sig;
        IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = v_sig
                                    AND cmd = 'SELECT' AND roles = '{authenticated}') THEN
            RAISE EXCEPTION '% must have exactly one SELECT policy, for authenticated (found % policies)', v_sig, v_n;
        END IF;
        IF has_table_privilege('anon', 'public.' || v_sig, 'SELECT')
           OR has_table_privilege('authenticated', 'public.' || v_sig, 'INSERT')
           OR has_table_privilege('authenticated', 'public.' || v_sig, 'UPDATE')
           OR has_table_privilege('authenticated', 'public.' || v_sig, 'DELETE')
           OR NOT has_table_privilege('authenticated', 'public.' || v_sig, 'SELECT') THEN
            RAISE EXCEPTION '% grants are not read-only for authenticated and closed to anon', v_sig;
        END IF;
    END LOOP;

    -- Internal functions: no client role. Policy helpers: authenticated only. Writers and the read:
    -- pinned definers for signed-in users, not anon, not PUBLIC.
    FOREACH v_sig IN ARRAY ARRAY['public.facility_permit_status(date,date,date)', 'public.org_local_today(uuid)',
                                 'public.coach_field_ids_of(uuid,uuid)', 'public.facility_permit_json(uuid,date,boolean)',
                                 'public.facility_permit_check(text,text,text,date,date,uuid[],uuid[],uuid)'] LOOP
        IF has_function_privilege('authenticated', v_sig, 'EXECUTE') OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
            RAISE EXCEPTION '% is callable by a client role', v_sig;
        END IF;
    END LOOP;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.coach_covers_permit_scope(uuid,uuid,uuid)'::regprocedure,
                     'public.coach_reads_facility_permit(uuid)'::regprocedure,
                     'public.coach_reads_facility_permit_file(uuid,text)'::regprocedure,
                     'public.admin_create_facility_permit(uuid,text,text,date,date,text,uuid[],uuid[])'::regprocedure,
                     'public.admin_update_facility_permit(uuid,uuid,text,text,date,date,text,uuid[],uuid[])'::regprocedure,
                     'public.admin_set_facility_permit_file(uuid,uuid,text,text)'::regprocedure,
                     'public.admin_delete_facility_permit(uuid,uuid)'::regprocedure,
                     'public.get_facility_permits(uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::text LIKE '=%');
    IF v_n <> 8 THEN RAISE EXCEPTION 'only % of the 8 permit functions are pinned definers for authenticated only', v_n; END IF;
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.admin_create_facility_permit(uuid,text,text,date,date,text,uuid[],uuid[])'::regprocedure,
                     'public.admin_update_facility_permit(uuid,uuid,text,text,date,date,text,uuid[],uuid[])'::regprocedure,
                     'public.admin_set_facility_permit_file(uuid,uuid,text,text)'::regprocedure,
                     'public.admin_delete_facility_permit(uuid,uuid)'::regprocedure,
                     'public.get_facility_permits(uuid)'::regprocedure)
       AND p.proconfig @> ARRAY['TimeZone=UTC'];
    IF v_n <> 5 THEN RAISE EXCEPTION 'only % of the 5 permit RPCs have TimeZone pinned to UTC', v_n; END IF;

    -- The bucket: private, 10 MiB, PDF/JPEG/PNG, and exactly the three policies (no UPDATE).
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'facility-permits' AND public IS NOT TRUE
                    AND file_size_limit = 10485760
                    AND allowed_mime_types @> ARRAY['application/pdf', 'image/jpeg', 'image/png']
                    AND cardinality(allowed_mime_types) = 3) THEN
        RAISE EXCEPTION 'the facility-permits bucket is not private with a 10 MiB limit and PDF, JPEG and PNG only';
    END IF;
    SELECT string_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ','), ' ' ORDER BY policyname) INTO v_def
      FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND (policyname LIKE 'facility-permits%' OR qual LIKE '%''facility-permits''%' OR with_check LIKE '%''facility-permits''%');
    IF v_def IS DISTINCT FROM 'facility-permits org-admin delete:DELETE:authenticated facility-permits org-admin insert:INSERT:authenticated facility-permits select:SELECT:authenticated' THEN
        RAISE EXCEPTION 'the facility-permits policies are not exactly an admin INSERT and DELETE and a SELECT, for authenticated: %', v_def;
    END IF;

    -- admin_delete_field lists the permits it unlinks, and keeps its pin.
    SELECT p.prosrc INTO v_def FROM pg_proc p WHERE p.oid = 'public.admin_delete_field(uuid,uuid,boolean)'::regprocedure;
    IF v_def !~ 'facility_permit_scopes' OR v_def !~ 'unlinked' OR v_def !~ 'bookings_exist' OR v_def !~ 'FOR UPDATE' THEN
        RAISE EXCEPTION 'admin_delete_field is not the booking guard with permits listed';
    END IF;
    IF NOT (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
              FROM pg_proc p WHERE p.oid = 'public.admin_delete_field(uuid,uuid,boolean)'::regprocedure) THEN
        RAISE EXCEPTION 'admin_delete_field lost its definer pin';
    END IF;
END;
$check$;

COMMIT;
