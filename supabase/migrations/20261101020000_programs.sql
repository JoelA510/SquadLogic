-- Programs: optional named groups of divisions within a season (plan
-- docs/changes/2026-10-22-phase-e-seasons.md, E2; decisions 5.1-5.3 of
-- docs/changes/2026-10-20-core-roadmap.md; the AGENTS.md rule 14 plan for this
-- persistence change, approved by the owner).
--
-- **What a program is.** A named group of divisions in one season (Junior:
-- U7B, U7G, U8B, U8G). It gates nothing and has no registration window; it
-- groups. **Programs are optional** (owner, 2026-10-26): a league that runs on
-- divisions alone is never asked to make one. Every season has one *default*
-- program, shown as "No program", which holds every division that is in no
-- program of its own; no flow, import or RPC needs another.
--
-- **The change.**
--   1. Four audit actions registered: `program.upserted`, `program.deleted`,
--      `program.merged`, `division.program_changed`.
--   2. `programs` (id, organization_id, season_settings_id, name, is_default,
--      copied_from_program_id, timestamps): the season reference is composite
--      with the organization (`season_settings_id_organization_id_key` on
--      `season_settings` is its target), so a program cannot name another
--      organization's season; names unique per season ignoring case and padding;
--      one default per season; `UNIQUE (id, season_settings_id)` for the
--      divisions' reference. Row level security on, a member SELECT policy and
--      no write policy: the four RPCs are the only writers. No grant to anon.
--   3. Every season gets its default program: a trigger on `season_settings`
--      makes it for each new season (so no season writer, present or future, can
--      leave a season without one), and this migration makes one for each
--      existing season.
--   4. `divisions.program_id uuid NOT NULL`, with the composite reference
--      `(program_id, season_settings_id) -> programs (id, season_settings_id)`,
--      so a division cannot sit in another season's program. The existing
--      divisions go to their season's default program (their `updated_at` is
--      not touched). A trigger fills `program_id` with the season's default
--      when an insert names none, so every division writer (the import
--      finalizer, `upsert_division_for_import`, `admin_upsert_division_settings`,
--      the demo seed, a direct admin insert) puts a new division in the
--      default and none has to know programs exist. Where the plan said a
--      writer that forgot would fail on NOT NULL, this fails closed in a
--      different place: a season with no default program (which nothing can
--      make) leaves the column NULL and the insert fails on NOT NULL.
--      A BEFORE UPDATE trigger (`divisions_program_guard`, SECURITY INVOKER) refuses a
--      change of `program_id` made as `authenticated` or `anon`: the divisions
--      UPDATE policy and grant would otherwise let an admin move a division past
--      the writers' completed-season refusal, lock and audit row. The writers
--      (and the definer demo seed) run as their owner and pass; any other column
--      of a division is updated as before.
--   5. The four writers, SECURITY DEFINER, `is_org_admin` of the organization
--      the *rows* belong to, refusing a completed season, serialized per
--      organization on the advisory lock Phase E3's rollover and activation will
--      take (`season:<organization>`), each with one audit row:
--      `admin_upsert_program(season, id, name)` (create, or rename; the default
--      cannot be renamed), `admin_set_division_program(division, program)`
--      (assign or move; NULL moves it to the default),
--      `admin_delete_program(program)` (its divisions move to the default, then
--      it goes) and `admin_merge_programs(source, target)` (same season; the
--      target keeps its name; the source is not the target or the default).
--      The default can be neither renamed, deleted nor merged away.
--   6. `demo_seed.division_programs` and `start_demo_session()` replaced from
--      its latest body (20261030010000, md5 checked): a demo league has its
--      real programs (Minis U4, Micro U5-U6, Junior U7-U8, Select U14-U19;
--      U9, U10 and U12 in the default), from the fixture's `Payment Plan`
--      column (tests/demoSeed.test.js holds the two equal).
--   7. An end-state check.
--
-- No DDL touches the auth or storage schemas. Every drop names its object,
-- with no CASCADE. `divisions.updated_at` is not bumped by the backfill.
--
-- Reversible: docs/sql/20261101020000_revert.sql restores the demo start, drops
-- the writers, the triggers, the column and the table (a NOTICE counts the
-- programs and the divisions in a program of their own that it loses).
-- Smoke: docs/sql/20261101020000_smoke.sql. pgTAP: supabase/tests/programs.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. What changes, counted.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_seasons bigint;
    v_divisions bigint;
BEGIN
    SELECT count(*) INTO v_seasons FROM public.season_settings;
    SELECT count(*) INTO v_divisions FROM public.divisions;
    RAISE NOTICE '% season(s) each get a default program ("No program"), and all % division(s) go into their season''s default', v_seasons, v_divisions;
END;
$$;

INSERT INTO public.audit_actions (action) VALUES
    ('program.upserted'),
    ('program.deleted'),
    ('program.merged'),
    ('division.program_changed')
ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The table.
-- ---------------------------------------------------------------------------

ALTER TABLE public.season_settings
    ADD CONSTRAINT season_settings_id_organization_id_key UNIQUE (id, organization_id);

CREATE TABLE public.programs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id        uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    season_settings_id     uuid NOT NULL,
    name                   text NOT NULL,
    is_default             boolean NOT NULL DEFAULT false,
    copied_from_program_id uuid REFERENCES public.programs (id) ON DELETE SET NULL,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT programs_season_organization_fkey
        FOREIGN KEY (season_settings_id, organization_id)
        REFERENCES public.season_settings (id, organization_id) ON DELETE CASCADE,
    CONSTRAINT programs_id_season_key UNIQUE (id, season_settings_id),
    CONSTRAINT programs_name_shape CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX programs_season_name_key
    ON public.programs (season_settings_id, lower(btrim(name)));
CREATE UNIQUE INDEX programs_one_default
    ON public.programs (season_settings_id) WHERE is_default;
CREATE INDEX idx_programs_organization_id ON public.programs (organization_id);
CREATE INDEX idx_programs_copied_from ON public.programs (copied_from_program_id)
    WHERE copied_from_program_id IS NOT NULL;

CREATE TRIGGER programs_set_timestamp
    BEFORE UPDATE ON public.programs
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();

COMMENT ON TABLE public.programs IS
    'An optional named group of divisions within a season. Each season has one default program (is_default, shown as "No program") that holds every division in no program of its own. Written only by admin_upsert_program, admin_set_division_program, admin_delete_program and admin_merge_programs (and the triggers below). 20261101020000.';
COMMENT ON COLUMN public.programs.copied_from_program_id IS
    'The program of the previous season this one was copied from when its season was created from another (Phase E3). NULL otherwise.';

ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Programs: org members select"
    ON public.programs
    FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id));

-- Default privileges hand new tables to authenticated and service_role with
-- every privilege, so the revoke names them too (the 20261006000000 reasoning).
REVOKE ALL ON public.programs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.programs TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Every season has its default program.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.season_settings_default_program()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    INSERT INTO public.programs (organization_id, season_settings_id, name, is_default)
    VALUES (NEW.organization_id, NEW.id, 'No program', true);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.season_settings_default_program() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.season_settings_default_program() IS
    'Trigger function: every new season gets its default program ("No program"). 20261101020000.';

CREATE TRIGGER season_settings_default_program
    AFTER INSERT ON public.season_settings
    FOR EACH ROW EXECUTE FUNCTION public.season_settings_default_program();

INSERT INTO public.programs (organization_id, season_settings_id, name, is_default)
SELECT s.organization_id, s.id, 'No program', true FROM public.season_settings s;

-- ---------------------------------------------------------------------------
-- 4. Every division is in exactly one program of its own season.
-- ---------------------------------------------------------------------------

ALTER TABLE public.divisions ADD COLUMN program_id uuid;

-- The backfill is a reference being filled, not an edit: it leaves updated_at alone.
ALTER TABLE public.divisions DISABLE TRIGGER divisions_set_timestamp;
UPDATE public.divisions d
   SET program_id = p.id
  FROM public.programs p
 WHERE p.season_settings_id = d.season_settings_id AND p.is_default;
ALTER TABLE public.divisions ENABLE TRIGGER divisions_set_timestamp;

ALTER TABLE public.divisions ALTER COLUMN program_id SET NOT NULL;
ALTER TABLE public.divisions
    ADD CONSTRAINT divisions_program_season_fkey
    FOREIGN KEY (program_id, season_settings_id)
    REFERENCES public.programs (id, season_settings_id);
CREATE INDEX idx_divisions_program_id ON public.divisions (program_id);

COMMENT ON COLUMN public.divisions.program_id IS
    'The division''s program, always one of its own season''s (composite reference). The season''s default program ("No program") when it is in none of its own. Set by admin_set_division_program; filled with the default on insert. 20261101020000.';

CREATE FUNCTION public.divisions_default_program()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF NEW.program_id IS NULL THEN
        SELECT p.id INTO NEW.program_id
          FROM public.programs p
         WHERE p.season_settings_id = NEW.season_settings_id AND p.is_default;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.divisions_default_program() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.divisions_default_program() IS
    'Trigger function: a division inserted with no program joins its season''s default program. 20261101020000.';

CREATE TRIGGER divisions_default_program
    BEFORE INSERT ON public.divisions
    FOR EACH ROW EXECUTE FUNCTION public.divisions_default_program();

-- A client cannot change a division's program with a plain UPDATE: the existing "Divisions: org
-- admins update" policy and UPDATE grant would let it past the program writers' completed-season
-- refusal, their organization lock and their audit row. The guard is SECURITY INVOKER on purpose:
-- a client's statement runs as `authenticated` (or `anon`), while the same UPDATE inside one of the
-- definer writers runs as the function's owner, so no flag can be set by a caller to get past it.
-- Every other column of a division is updated exactly as before.
CREATE FUNCTION public.divisions_program_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
SET timezone = 'UTC'
AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'a division''s program is changed with admin_set_division_program, not by updating the division'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.divisions_program_guard() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.divisions_program_guard() IS
    'Trigger function: refuses a change of divisions.program_id made as a client role (authenticated, anon); the program RPCs run as their owner and pass. 20261101020000.';

CREATE TRIGGER divisions_program_guard
    BEFORE UPDATE OF program_id ON public.divisions
    FOR EACH ROW
    WHEN (OLD.program_id IS DISTINCT FROM NEW.program_id)
    EXECUTE FUNCTION public.divisions_program_guard();

-- ---------------------------------------------------------------------------
-- 5. The four writers.
-- ---------------------------------------------------------------------------
--
-- Each takes the organization and the season it checks from the rows it
-- changes (the season's, the program's, the division's), never from the caller
-- alone; one refusal (42501) covers a missing row and another organization's
-- row, so a caller learns nothing about ids it does not own. Each then takes the
-- organization's season lock and re-reads what it changes, so Phase E3's
-- rollover never copies a half-moved set and two admins cannot interleave.

CREATE FUNCTION public.admin_upsert_program(
    p_season_id uuid,
    p_id uuid,
    p_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_name text := btrim(COALESCE(p_name, ''));
    v_org uuid;
    v_status text;
    v_prog public.programs%ROWTYPE;
    v_old_name text;
    v_operation text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_season_id IS NULL THEN
        RAISE EXCEPTION 'p_season_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT s.organization_id INTO v_org FROM public.season_settings s WHERE s.id = p_season_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));

    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = p_season_id;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'season % no longer exists', p_season_id USING ERRCODE = '42501';
    END IF;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its programs cannot be changed', p_season_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'a program name must be 1 to 80 characters' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        v_operation := 'created';
        BEGIN
            INSERT INTO public.programs (organization_id, season_settings_id, name)
            VALUES (v_org, p_season_id, v_name)
            RETURNING * INTO v_prog;
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION 'a program named "%" already exists in this season', v_name
                USING ERRCODE = '23505';
        END;
    ELSE
        -- The program is judged by its own row: one that belongs to another
        -- season (a completed one, or another organization's) is not this
        -- season's, whatever season the caller names.
        SELECT * INTO v_prog FROM public.programs WHERE id = p_id FOR UPDATE;
        IF NOT FOUND OR v_prog.season_settings_id <> p_season_id THEN
            RAISE EXCEPTION 'program % is not a program of season %', p_id, p_season_id
                USING ERRCODE = '23503';
        END IF;
        v_old_name := v_prog.name;
        IF v_name = v_prog.name THEN
            RETURN jsonb_build_object('id', v_prog.id, 'season_settings_id', v_prog.season_settings_id,
                                      'name', v_prog.name, 'is_default', v_prog.is_default, 'changed', false);
        END IF;
        IF v_prog.is_default THEN
            RAISE EXCEPTION 'the default program cannot be renamed' USING ERRCODE = '22023', DETAIL = 'default_program';
        END IF;
        v_operation := 'updated';
        BEGIN
            UPDATE public.programs SET name = v_name WHERE id = p_id RETURNING * INTO v_prog;
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION 'a program named "%" already exists in this season', v_name
                USING ERRCODE = '23505';
        END;
    END IF;

    PERFORM public.record_audit_event(
        v_org,
        'program.upserted',
        'program',
        v_prog.id,
        jsonb_build_object(
            'operation', v_operation,
            'season_settings_id', p_season_id,
            'old_name', v_old_name,
            'new_name', v_prog.name
        )
    );

    RETURN jsonb_build_object('id', v_prog.id, 'season_settings_id', v_prog.season_settings_id,
                              'name', v_prog.name, 'is_default', v_prog.is_default, 'changed', true);
END;
$$;

CREATE FUNCTION public.admin_set_division_program(
    p_division_id uuid,
    p_program_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_div public.divisions%ROWTYPE;
    v_status text;
    v_from public.programs%ROWTYPE;
    v_to public.programs%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_division_id IS NULL THEN
        RAISE EXCEPTION 'p_division_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_div FROM public.divisions WHERE id = p_division_id;
    IF NOT FOUND OR NOT public.is_org_admin(v_div.organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the division''s organization'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_div.organization_id::text, 0));

    SELECT * INTO v_div FROM public.divisions WHERE id = p_division_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'division % no longer exists', p_division_id USING ERRCODE = '42501';
    END IF;
    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_div.season_settings_id;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its divisions cannot be moved', v_div.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    IF p_program_id IS NULL THEN
        SELECT * INTO v_to FROM public.programs
         WHERE season_settings_id = v_div.season_settings_id AND is_default;
    ELSE
        SELECT * INTO v_to FROM public.programs
         WHERE id = p_program_id AND season_settings_id = v_div.season_settings_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'program % is not a program of the division''s season', p_program_id
                USING ERRCODE = '23503';
        END IF;
    END IF;
    IF v_to.id IS NULL THEN
        RAISE EXCEPTION 'season % has no default program', v_div.season_settings_id
            USING ERRCODE = '23503';
    END IF;

    SELECT * INTO v_from FROM public.programs WHERE id = v_div.program_id;
    IF v_from.id = v_to.id THEN
        RETURN jsonb_build_object('division_id', v_div.id, 'program_id', v_to.id, 'changed', false);
    END IF;

    UPDATE public.divisions SET program_id = v_to.id WHERE id = v_div.id;

    PERFORM public.record_audit_event(
        v_div.organization_id,
        'division.program_changed',
        'division',
        v_div.id,
        jsonb_build_object(
            'season_settings_id', v_div.season_settings_id,
            'division_name', v_div.name,
            'from_program_id', v_from.id,
            'from_program_name', v_from.name,
            'to_program_id', v_to.id,
            'to_program_name', v_to.name
        )
    );

    RETURN jsonb_build_object('division_id', v_div.id, 'program_id', v_to.id, 'changed', true);
END;
$$;

CREATE FUNCTION public.admin_delete_program(p_program_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_prog public.programs%ROWTYPE;
    v_status text;
    v_default uuid;
    v_moved uuid[];
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_program_id IS NULL THEN
        RAISE EXCEPTION 'p_program_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_prog FROM public.programs WHERE id = p_program_id;
    IF NOT FOUND OR NOT public.is_org_admin(v_prog.organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the program''s organization'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_prog.organization_id::text, 0));

    SELECT * INTO v_prog FROM public.programs WHERE id = p_program_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'program % no longer exists', p_program_id USING ERRCODE = '42501';
    END IF;
    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_prog.season_settings_id;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its programs cannot be changed', v_prog.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_prog.is_default THEN
        RAISE EXCEPTION 'the default program cannot be deleted' USING ERRCODE = '22023', DETAIL = 'default_program';
    END IF;

    SELECT p.id INTO v_default FROM public.programs p
     WHERE p.season_settings_id = v_prog.season_settings_id AND p.is_default;

    SELECT COALESCE(array_agg(d.id ORDER BY d.name, d.id), ARRAY[]::uuid[]) INTO v_moved
      FROM public.divisions d WHERE d.program_id = p_program_id;

    UPDATE public.divisions SET program_id = v_default WHERE program_id = p_program_id;
    DELETE FROM public.programs WHERE id = p_program_id;

    PERFORM public.record_audit_event(
        v_prog.organization_id,
        'program.deleted',
        'program',
        v_prog.id,
        jsonb_build_object(
            'season_settings_id', v_prog.season_settings_id,
            'name', v_prog.name,
            'moved_division_ids', to_jsonb(v_moved),
            'moved_to_program_id', v_default
        )
    );

    RETURN jsonb_build_object('deleted_program_id', v_prog.id, 'moved_division_ids', to_jsonb(v_moved));
END;
$$;

CREATE FUNCTION public.admin_merge_programs(
    p_source_id uuid,
    p_target_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_source public.programs%ROWTYPE;
    v_target public.programs%ROWTYPE;
    v_status text;
    v_moved uuid[];
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_source_id IS NULL OR p_target_id IS NULL THEN
        RAISE EXCEPTION 'p_source_id and p_target_id are required' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_source FROM public.programs WHERE id = p_source_id;
    IF NOT FOUND OR NOT public.is_org_admin(v_source.organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the program''s organization'
            USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_source.organization_id::text, 0));

    SELECT * INTO v_source FROM public.programs WHERE id = p_source_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'program % no longer exists', p_source_id USING ERRCODE = '42501';
    END IF;
    IF p_source_id = p_target_id THEN
        RAISE EXCEPTION 'a program cannot be merged into itself' USING ERRCODE = '22023';
    END IF;
    -- The target is judged by its own row; another season's (or organization's)
    -- program is refused the same way, so its existence is not disclosed.
    SELECT * INTO v_target FROM public.programs WHERE id = p_target_id FOR UPDATE;
    IF NOT FOUND OR v_target.season_settings_id <> v_source.season_settings_id THEN
        RAISE EXCEPTION 'programs can be merged only within one season' USING ERRCODE = '22023';
    END IF;
    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_source.season_settings_id;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its programs cannot be changed', v_source.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;
    IF v_source.is_default THEN
        RAISE EXCEPTION 'the default program cannot be merged away' USING ERRCODE = '22023', DETAIL = 'default_program';
    END IF;

    SELECT COALESCE(array_agg(d.id ORDER BY d.name, d.id), ARRAY[]::uuid[]) INTO v_moved
      FROM public.divisions d WHERE d.program_id = p_source_id;

    UPDATE public.divisions SET program_id = p_target_id WHERE program_id = p_source_id;
    DELETE FROM public.programs WHERE id = p_source_id;

    PERFORM public.record_audit_event(
        v_source.organization_id,
        'program.merged',
        'program',
        v_target.id,
        jsonb_build_object(
            'season_settings_id', v_source.season_settings_id,
            'source_program_id', v_source.id,
            'source_name', v_source.name,
            'target_program_id', v_target.id,
            'target_name', v_target.name,
            'moved_division_ids', to_jsonb(v_moved)
        )
    );

    RETURN jsonb_build_object('target_program_id', v_target.id, 'moved_division_ids', to_jsonb(v_moved));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_upsert_program(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_division_program(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_program(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_merge_programs(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_program(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_division_program(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_program(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_merge_programs(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_upsert_program(uuid, uuid, text) IS
    'Admin-only: create (id NULL) or rename a program of a season; the name is unique per season (23505); the default program cannot be renamed; a completed season is refused. Audited as program.upserted with the old and new name. 20261101020000.';
COMMENT ON FUNCTION public.admin_set_division_program(uuid, uuid) IS
    'Admin-only: put a division in a program of its own season (23503 otherwise); NULL moves it to the season''s default ("No program"). Audited as division.program_changed. 20261101020000.';
COMMENT ON FUNCTION public.admin_delete_program(uuid) IS
    'Admin-only: delete a program, moving its divisions to the season''s default in the same transaction; the default cannot be deleted. Audited as program.deleted with the moved division ids. 20261101020000.';
COMMENT ON FUNCTION public.admin_merge_programs(uuid, uuid) IS
    'Admin-only: move every division of the source program to the target (same season, which keeps its name) and delete the source; the source is not the target or the default. Audited as program.merged with the moved division ids. 20261101020000.';

-- ---------------------------------------------------------------------------
-- 6. The demo league's programs.
-- ---------------------------------------------------------------------------

-- advisor-lint-allow: demo_seed is not an exposed schema, and row level security is enabled on its tables below (the lint reads only public.<table>)
CREATE TABLE demo_seed.division_programs (
    division_key text PRIMARY KEY REFERENCES demo_seed.divisions (key),
    program_name text NOT NULL
);
ALTER TABLE demo_seed.division_programs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON demo_seed.division_programs FROM PUBLIC, anon, authenticated;

-- From the fixture's `Payment Plan` column (`2026 U07B Junior Registration`: program Junior);
-- tests/demoSeed.test.js derives the same rows from fixtures/demo-2026/players.csv and holds them equal.
INSERT INTO demo_seed.division_programs (division_key, program_name) VALUES
  ('U4', 'Minis'),
  ('U5B', 'Micro'),
  ('U5G', 'Micro'),
  ('U6B', 'Micro'),
  ('U6G', 'Micro'),
  ('U7B', 'Junior'),
  ('U7G', 'Junior'),
  ('U8B', 'Junior'),
  ('U8G', 'Junior'),
  ('U14B', 'Select'),
  ('U14G', 'Select'),
  ('U16B', 'Select'),
  ('U16G', 'Select'),
  ('U19B', 'Select'),
  ('U19G', 'Select');

DO $$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.start_demo_session()');
    IF v_md5 IS DISTINCT FROM '5b8a6002c3150e41f1b47ad1704b9ef9' THEN
        RAISE EXCEPTION 'public.start_demo_session() has a body this migration has not seen (md5 %): not replacing it', v_md5;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_demo_session()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
    c_minutes constant integer := 30;   -- decision 8
    c_cap     constant integer := 10;   -- decision 2
    v_uid     uuid := auth.uid();
    v_org     uuid;
    v_expires timestamptz;
    v_live    integer;
    v_name    text;
    v_tz      text;
    v_weeks   integer;
    v_season  uuid;
    v_start   date;
    v_end     date;
    v_year    integer;
    v_team    record;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT public.caller_is_anonymous() THEN
        RAISE EXCEPTION 'Only a demo visitor can start a demo'
            USING ERRCODE = '42501', DETAIL = 'demo_requires_anonymous';
    END IF;

    -- One caller at a time past this point, so the cap and the one-per-visitor rule are judged
    -- against what the callers before this one committed.
    PERFORM pg_advisory_xact_lock(hashtextextended('squadlogic.start_demo_session', 0));

    SELECT o.id, o.demo_expires_at INTO v_org, v_expires
      FROM public.organizations o WHERE o.demo_owner = v_uid;
    IF FOUND THEN
        IF v_expires > now() THEN
            RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', true);
        END IF;
        -- The visitor's own demo has ended and is waiting for the purge: it goes now.
        DELETE FROM public.organizations WHERE id = v_org;
    END IF;

    SELECT count(*) INTO v_live FROM public.organizations WHERE demo_expires_at > now();
    IF v_live >= c_cap THEN
        RAISE LOG 'start_demo_session refused: % live demos, the cap is %', v_live, c_cap;
        RAISE EXCEPTION 'The demo is busy right now. Try again in a few minutes.'
            USING ERRCODE = 'P0001', DETAIL = 'demo_capacity';
    END IF;

    SELECT l.organization_name, l.timezone, l.season_weeks INTO v_name, v_tz, v_weeks FROM demo_seed.league l;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'The demo league is not available' USING ERRCODE = 'P0001', DETAIL = 'demo_seed_empty';
    END IF;

    -- The season is the coming twelve weeks whenever the demo starts.
    v_start := date_trunc('week', now() AT TIME ZONE v_tz)::date + 7;
    v_end := v_start + v_weeks * 7 - 1;
    v_year := extract(year FROM v_start)::integer;

    -- Not yet marked a demo: the fences would refuse the seed. It is marked below, last.
    INSERT INTO public.organizations (name, slug, contact_info, is_onboarded)
    VALUES (v_name, 'demo-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
            jsonb_build_object('timezone', v_tz), true)
    RETURNING id INTO v_org;

    INSERT INTO public.season_settings (organization_id, name, status, season_year, season_label, timezone,
                                        season_start, season_end)
    VALUES (v_org, v_year || ' Season', 'active', v_year, v_year || ' Season', v_tz, v_start, v_end)
    RETURNING id INTO v_season;

    INSERT INTO public.divisions (organization_id, season_settings_id, name, gender_policy, play_format,
                                  min_age, max_age, max_roster_size, plays_games, season_start, season_end)
    SELECT v_org, v_season, d.name, d.gender_policy, d.play_format, d.min_age, d.max_age,
           d.max_roster_size, d.plays_games, v_start, v_end
      FROM demo_seed.divisions d;

    -- 20261101020000: the league's programs, which span divisions (Minis is U4, Micro U5-U6,
    -- Junior U7-U8, Select U14-U19; U9, U10 and U12 stay in the season's default program). The
    -- season's default program exists already (a trigger on season_settings made it).
    INSERT INTO public.programs (organization_id, season_settings_id, name)
    SELECT v_org, v_season, p.program_name
      FROM (SELECT DISTINCT dp.program_name FROM demo_seed.division_programs dp) p;
    UPDATE public.divisions dv
       SET program_id = pr.id
      FROM demo_seed.division_programs dp
      JOIN public.programs pr ON pr.season_settings_id = v_season AND pr.name = dp.program_name
     WHERE dv.season_settings_id = v_season AND dv.name = dp.division_key;

    INSERT INTO public.teams (organization_id, division_id, name)
    SELECT v_org, dv.id, t.name
      FROM demo_seed.teams t
      JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = t.division_key;

    -- `coaches.email` is unique across organizations: each copy's addresses carry its own tag.
    INSERT INTO public.coaches (organization_id, full_name, email, status)
    SELECT v_org, c.full_name,
           replace(c.email, '@', '+' || substr(replace(v_org::text, '-', ''), 1, 12) || '@'), c.status
      FROM demo_seed.coaches c;

    INSERT INTO public.players (organization_id, division_id, team_id, first_name, last_name,
                                external_registration_id, gender, status, years_played, willing_to_coach,
                                play_up_requested, buddy_request, natural_age)
    SELECT v_org, t.division_id, t.id, p.first_name, p.last_name, p.external_registration_id,
           p.gender, p.status, p.years_played, p.willing_to_coach, p.play_up_requested,
           p.buddy_request, p.natural_age
      FROM demo_seed.players p
      JOIN public.teams t ON t.organization_id = v_org AND t.name = p.team_name;

    INSERT INTO public.team_players (team_id, player_id, organization_id, role, source)
    SELECT pl.team_id, pl.id, v_org, 'player', 'auto'
      FROM public.players pl
     WHERE pl.organization_id = v_org AND pl.team_id IS NOT NULL;

    INSERT INTO public.locations (organization_id, name, lighting_available, latitude, longitude)
    SELECT v_org, l.name, true, l.latitude, l.longitude FROM demo_seed.locations l;

    INSERT INTO public.fields (organization_id, location_id, name, surface_type, supports_halves)
    SELECT v_org, loc.id, f.name, f.surface_type, f.supports_halves
      FROM demo_seed.fields f
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = f.location_name;

    INSERT INTO public.field_subunits (organization_id, field_id, label)
    SELECT v_org, fl.id, s.label
      FROM demo_seed.field_subunits s
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name;

    INSERT INTO public.practice_slots (organization_id, field_id, field_subunit_id, day_of_week, start_time,
                                       end_time, capacity, division_id)
    SELECT v_org, fl.id, su.id, s.day_of_week::public.day_of_week, s.start_time, s.end_time, s.capacity, dv.id
      FROM demo_seed.practice_slots s
      JOIN public.locations loc ON loc.organization_id = v_org AND loc.name = s.location_name
      JOIN public.fields fl ON fl.location_id = loc.id AND fl.name = s.field_name
      LEFT JOIN public.field_subunits su ON su.field_id = fl.id AND su.label = s.subunit_label
      LEFT JOIN public.divisions dv ON dv.organization_id = v_org AND dv.name = s.division_key;

    -- Marked last, then the visitor joins: both pass the fences, which now see a demo.
    v_expires := now() + make_interval(mins => c_minutes);
    UPDATE public.organizations SET demo_expires_at = v_expires, demo_owner = v_uid WHERE id = v_org;
    -- A SELECT, not a VALUES list: the role is the creator's (as in initialize_new_tenant), not a role
    -- test, and tests/staff_is_admin.sql reads any parenthesised list naming 'admin' as a role list.
    INSERT INTO public.organization_members (organization_id, profile_id, role)
    SELECT v_org, v_uid, 'admin';

    -- The one writer of a team's coaches (it keeps teams.coach_id, assistant_coach_ids and the assignment
    -- rows together; the catalogue allows no other). It audits as the caller, who is a member by now: one
    -- team.coach_assignments_changed row per team, as an admin's own assignments would leave.
    FOR v_team IN
        SELECT t.id AS team_id,
               (array_agg(c.id) FILTER (WHERE tc.role = 'lead'))[1] AS lead_id,
               COALESCE(array_agg(c.id ORDER BY c.full_name) FILTER (WHERE tc.role = 'assistant'), ARRAY[]::uuid[]) AS assistant_ids
          FROM demo_seed.team_coaches tc
          JOIN public.teams t ON t.organization_id = v_org AND t.name = tc.team_name
          JOIN public.coaches c ON c.organization_id = v_org AND c.full_name = tc.coach_name
         GROUP BY t.id
    LOOP
        PERFORM public.set_team_coaches(v_team.team_id, v_team.lead_id, v_team.assistant_ids, current_date, 'demo_seed');
    END LOOP;

    -- The team run the Teams, Practices and Games pages read their teams from (`scheduler_runs`, the
    -- latest completed `team` run of the season; `mapSchedulerRunToSummary`). A league formed some other
    -- way than by a team run has none, and those pages treat it as a cold start: the auto-scheduler
    -- stays disabled with "no teams". So the seeded league gets the run its teams would have left,
    -- built from the copied rows: each division's teams (their stored coaches) and each team's roster.
    WITH team_rows AS (
        SELECT dv.name AS division_name, dv.max_roster_size, t.id, t.name, t.division_id, t.coach_id,
               t.assistant_coach_ids,
               (SELECT count(*) FROM public.team_players tp WHERE tp.team_id = t.id) AS n_players
          FROM public.teams t
          JOIN public.divisions dv ON dv.id = t.division_id
         WHERE t.organization_id = v_org
    ), by_division AS (
        SELECT division_name,
               jsonb_agg(jsonb_build_object(
                   'id', id, 'name', name, 'division', division_name, 'divisionId', division_id,
                   'coachId', coach_id,
                   'assistantCoachIds', to_jsonb(COALESCE(assistant_coach_ids, ARRAY[]::uuid[]))
               ) ORDER BY name) AS teams,
               sum(n_players)::integer AS players,
               sum(COALESCE(max_roster_size, 0))::integer AS capacity
          FROM team_rows
         GROUP BY division_name
    )
    INSERT INTO public.scheduler_runs (organization_id, season_id, season_settings_id, run_type, status,
                                       parameters, metrics, results, created_by, started_at, completed_at)
    SELECT v_org, v_season, v_season, 'team', 'completed',
           jsonb_build_object('source', 'demo_seed'), '{}'::jsonb,
           jsonb_build_object(
               'teamsByDivision', (SELECT jsonb_object_agg(division_name, teams) FROM by_division),
               'rosterBalanceByDivision', (SELECT jsonb_object_agg(division_name, jsonb_build_object(
                   'summary', jsonb_build_object(
                       'totalPlayers', players, 'totalCapacity', capacity,
                       'averageFillRate', CASE WHEN capacity > 0 THEN round(players::numeric / capacity, 4) ELSE 0 END)))
                   FROM by_division),
               'team_players', COALESCE((SELECT jsonb_agg(jsonb_build_object('team_id', tp.team_id, 'player_id', tp.player_id))
                                           FROM public.team_players tp WHERE tp.organization_id = v_org), '[]'::jsonb)
           ),
           v_uid, now(), now();

    PERFORM public.record_audit_event(
        v_org, 'demo.started', 'organization', v_org,
        jsonb_build_object('expires_at', v_expires, 'minutes', c_minutes)
    );

    RETURN jsonb_build_object('organization_id', v_org, 'expires_at', v_expires, 'existing', false);
END;
$function$;

COMMENT ON FUNCTION public.start_demo_session() IS
    'An anonymous visitor''s demo: copies demo_seed into a new organization that expires in 30 minutes, with the league''s programs. Returns {organization_id, expires_at, existing}.';

-- ---------------------------------------------------------------------------
-- 7. End state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_n integer;
    v_def text;
    v_sig text;
BEGIN
    -- The table: row level security on, one member read policy, no write
    -- policy, nothing for anon, read-only for signed-in users.
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.programs'::regclass) THEN
        RAISE EXCEPTION 'programs has row level security off';
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'programs';
    IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'programs'
                                AND cmd = 'SELECT' AND policyname = 'Programs: org members select') THEN
        RAISE EXCEPTION 'programs must have exactly its member read policy (found % policies)', v_n;
    END IF;
    IF has_table_privilege('anon', 'public.programs', 'SELECT')
       OR has_table_privilege('authenticated', 'public.programs', 'INSERT')
       OR has_table_privilege('authenticated', 'public.programs', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.programs', 'DELETE')
       OR NOT has_table_privilege('authenticated', 'public.programs', 'SELECT') THEN
        RAISE EXCEPTION 'programs grants are not read-only for authenticated and closed to anon';
    END IF;

    -- Every season has one default program; every division is in a program of its own season.
    IF EXISTS (SELECT 1 FROM public.season_settings s
                WHERE (SELECT count(*) FROM public.programs p
                        WHERE p.season_settings_id = s.id AND p.is_default) <> 1) THEN
        RAISE EXCEPTION 'a season does not have exactly one default program';
    END IF;
    IF EXISTS (SELECT 1 FROM public.divisions WHERE program_id IS NULL) THEN
        RAISE EXCEPTION 'a division has no program';
    END IF;
    SELECT count(*) INTO v_n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'divisions' AND column_name = 'program_id' AND is_nullable = 'NO';
    IF v_n <> 1 THEN RAISE EXCEPTION 'divisions.program_id is nullable'; END IF;
    SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
     WHERE conrelid = 'public.divisions'::regclass AND conname = 'divisions_program_season_fkey';
    IF v_def IS DISTINCT FROM 'FOREIGN KEY (program_id, season_settings_id) REFERENCES programs(id, season_settings_id)' THEN
        RAISE EXCEPTION 'divisions_program_season_fkey is not the composite reference: %', v_def;
    END IF;

    -- The triggers.
    SELECT count(*) INTO v_n FROM pg_trigger
     WHERE NOT tgisinternal AND tgname IN ('season_settings_default_program', 'divisions_default_program', 'divisions_program_guard', 'programs_set_timestamp');
    IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 program triggers, found %', v_n; END IF;
    FOREACH v_sig IN ARRAY ARRAY['public.season_settings_default_program()', 'public.divisions_default_program()', 'public.divisions_program_guard()'] LOOP
        IF has_function_privilege('authenticated', v_sig, 'EXECUTE') OR has_function_privilege('anon', v_sig, 'EXECUTE') THEN
            RAISE EXCEPTION '% is callable by a client role', v_sig;
        END IF;
    END LOOP;

    -- The writers: pinned definers for signed-in users, not anon, not PUBLIC.
    SELECT count(*) INTO v_n FROM pg_proc p
     WHERE p.oid IN ('public.admin_upsert_program(uuid,uuid,text)'::regprocedure,
                     'public.admin_set_division_program(uuid,uuid)'::regprocedure,
                     'public.admin_delete_program(uuid)'::regprocedure,
                     'public.admin_merge_programs(uuid,uuid)'::regprocedure)
       AND p.prosecdef AND p.proconfig @> ARRAY['search_path=public', 'TimeZone=UTC']
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT EXISTS (SELECT 1 FROM unnest(p.proacl) a WHERE a::text LIKE '=%');
    IF v_n <> 4 THEN RAISE EXCEPTION 'only % of the 4 program writers are pinned definers for authenticated only', v_n; END IF;

    SELECT count(*) INTO v_n FROM public.audit_actions
     WHERE action IN ('program.upserted', 'program.deleted', 'program.merged', 'division.program_changed');
    IF v_n <> 4 THEN RAISE EXCEPTION 'the 4 program audit actions are not all registered (found %)', v_n; END IF;

    -- The demo start gives the demo its programs, and keeps what it had.
    SELECT prosrc INTO v_def FROM pg_proc WHERE oid = 'public.start_demo_session()'::regprocedure;
    IF v_def !~ 'demo_seed\.division_programs' OR v_def !~ 'demo_seed_empty' OR v_def !~ 'demo_capacity' THEN
        RAISE EXCEPTION 'start_demo_session is not the demo start with programs';
    END IF;
    IF (SELECT count(*) FROM demo_seed.division_programs) <> 15
       OR (SELECT count(DISTINCT program_name) FROM demo_seed.division_programs) <> 4 THEN
        RAISE EXCEPTION 'the demo seed does not hold 15 divisions in 4 programs';
    END IF;
END;
$check$;

COMMIT;
