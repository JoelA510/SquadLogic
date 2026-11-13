-- Settings scope (F11-4a): one setting at organization, program and division level, the most specific winning.
--
-- Plan of record: docs/changes/2026-11-13-settings-scope.md (approved 2026-11-13 by the coordinator under the owner's
-- delegation, decisions S1 to S8 as recommended), tasks A1 and A2. AGENTS.md rule 14 applies (persistence and the domain
-- model). Nothing in the solver changes; no column of an existing table changes.
--
-- ## What this adds
--
--   * `scoped_setting_keys`: the closed registry of settings that cascade (key, value type, allowed values, default,
--     label). Reference data, like `audit_actions`: members read it, rows come only from migrations. One row today,
--     `standings_count_outside_results` (a boolean, default false). PR 12 adds its own row.
--   * `scoped_settings`: one row per level and key. A row is the organization's (no program, no division), a program's
--     or a division's. NO ROW MEANS "INHERIT"; an explicit false (or [] for a set) is a row and beats an inherited value.
--     A JSON null is refused by a CHECK, so there is one way to say "inherit". Members read; there is NO write policy and
--     no write grant: `admin_set_scoped_setting` (and the rollover) are the only writers, so every change is audited by
--     construction (the reason this is a table and not a column on `divisions` or a key of `feature_flags`, both of which
--     an admin can write directly: plan, findings 2 and 5). A deleted organization, program or division takes its rows
--     with it (decision S8).
--   * `scoped_setting_value(division, key)`: THE resolver, internal (no client role executes it): the division's own
--     value, else its program's (never the default program's), else its organization's, else the registry default. An
--     unknown key is refused (22023, unknown_setting). Its core twin is `resolveScopedSetting` in
--     packages/core/src/scopedSettings.js, held to it by tests/scopedSettingsParity.test.js over the case table of
--     supabase/tests/scoped_settings.sql.
--   * `admin_set_scoped_setting(key, scope, scope_id, value)`: the one setter, for all three levels. A SQL NULL value
--     unsets (inherit). An ORGANIZATION change does not rewrite a completed season's history: each division of a
--     completed season that inherits the organization's value today is first held at that value by a division row
--     marked `frozen_from_organization` (counted in the audit row as `frozen_completed_divisions`); the rollover does
--     not copy such a row. A row's organization must be its program's or division's (a trigger, 23514). Admin of the
--     scope row's own organization; the organization's season lock; the value checked against the registry (a text set
--     stored in code point order, COLLATE "C"); a program or division of a completed season refused; the default
--     program refused. One
--     `settings.updated` audit row per change (resource_type `scoped_setting`, metadata {setting, field, key, scope,
--     scope_id, scope_name, season_settings_id, old, new}, null meaning "inherited"), so get_settings_audit_log shows it
--     unchanged.
--   * `admin_set_division_practice_settings(division, practices_per_week, practice_minutes)`: a sibling (decision S6), the
--     follow-up PR 11 recorded. It changes only those two columns (null keeps; 0 minutes is "any slot length"), so the
--     practice import no longer has to send a division's roster rules back. Same checks and audit row shape as
--     admin_upsert_division_settings, with only the practice keys in `previous` and `current`.
--
-- ## What this replaces, and what moves
--
--   * `standings_counts_outside(uuid)` (from 20261122010000): same signature, rights, grants and member check; it now asks
--     the resolver instead of `org_flag`. `view_league_standings` is not touched.
--   * `admin_create_season_from(uuid, text, integer, date, date)` (from 20261111010000): copied whole; it also copies each
--     program's and each division's scoped settings to their copies, refuses a partial copy, and counts them
--     (`scoped_settings_copied`, appended to its audit metadata and its result).
--   * The organization's standings value moves out of `organizations.feature_flags` (decision S2): for each organization
--     whose flags hold the key AS A BOOLEAN, one organization row with that value. An organization without the key (or
--     with a non-boolean value, which org_flag read as absent) gets no row and resolves to the registry default, false:
--     exactly what org_flag(org, key, false) answered. No audit row (a move of storage, not a change of value).
--     `feature_flags` itself is not edited; the key is retired (nothing reads it).
--
-- Both replaced bodies are checked first against the md5 of the text this was written against (carriage returns
-- removed): read off a build of the repository at 0687cae. Production's bodies were NOT read when this was written (the
-- read failed); a body this migration has not seen refuses to be replaced.
--
-- Reversible: docs/sql/20261124010000_revert.sql (the organization values go back into feature_flags; program and
-- division values are dropped and counted). Smoke: docs/sql/20261124010000_smoke.sql. pgTAP:
-- supabase/tests/scoped_settings.sql (CI's).

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The bodies this migration replaces are the ones it was written against.
-- ---------------------------------------------------------------------------

DO $guard$
DECLARE
    v_spec record;
    v_md5 text;
BEGIN
    FOR v_spec IN
        SELECT * FROM (VALUES
            ('public.standings_counts_outside(uuid)', '599e5e168256adcd6ff7e67ef4de6594'),
            ('public.admin_create_season_from(uuid, text, integer, date, date)', '446991cc4145987cad805bd47cc865b4')
        ) AS s(signature, expected_md5)
    LOOP
        SELECT md5(replace(p.prosrc, E'\r', '')) INTO v_md5
          FROM pg_proc p WHERE p.oid = to_regprocedure(v_spec.signature);
        IF v_md5 IS DISTINCT FROM v_spec.expected_md5 THEN
            RAISE EXCEPTION '% has a body this migration has not seen (md5 %): not replacing it',
                v_spec.signature, v_md5 USING ERRCODE = '55000';
        END IF;
    END LOOP;
END;
$guard$;

-- ---------------------------------------------------------------------------
-- 1. The registry and the settings table.
-- ---------------------------------------------------------------------------

CREATE TABLE public.scoped_setting_keys (
    key            text PRIMARY KEY,
    value_type     text NOT NULL,
    allowed_values jsonb,
    default_value  jsonb NOT NULL,
    label          text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scoped_setting_keys_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
    CONSTRAINT scoped_setting_keys_value_type CHECK (value_type IN ('boolean', 'text_set')),
    -- A boolean has no list; a text set lists its allowed strings.
    CONSTRAINT scoped_setting_keys_allowed CHECK (
        (value_type = 'boolean' AND allowed_values IS NULL AND jsonb_typeof(default_value) = 'boolean')
        OR (value_type = 'text_set' AND jsonb_typeof(allowed_values) = 'array' AND jsonb_array_length(allowed_values) > 0
            AND jsonb_typeof(default_value) = 'array')
    ),
    CONSTRAINT scoped_setting_keys_label_shape CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 80)
);

COMMENT ON TABLE public.scoped_setting_keys IS
    'The settings that cascade from organization to program to division (the most specific wins; no row inherits). Reference data: rows come only from migrations; members read it. The core mirror is SCOPED_SETTING_KEYS in packages/core/src/scopedSettings.js (tests/scopedSettingsParity.test.js holds them equal). 20261124010000.';

ALTER TABLE public.scoped_setting_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Scoped setting keys: signed-in users select"
    ON public.scoped_setting_keys
    FOR SELECT TO authenticated
    -- advisor-lint-allow: scoped_setting_keys is tenant-agnostic reference data (no organization column; SELECT-only policy)
    USING (true);
REVOKE ALL ON public.scoped_setting_keys FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.scoped_setting_keys TO authenticated, service_role;

INSERT INTO public.scoped_setting_keys (key, value_type, allowed_values, default_value, label) VALUES
    ('standings_count_outside_results', 'boolean', NULL, 'false', 'Count results against outside clubs');

CREATE TABLE public.scoped_settings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
    program_id      uuid REFERENCES public.programs (id) ON DELETE CASCADE,
    division_id     uuid REFERENCES public.divisions (id) ON DELETE CASCADE,
    key             text NOT NULL REFERENCES public.scoped_setting_keys (key),
    value           jsonb NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,
    -- True on a row the setter wrote to hold a COMPLETED season's division at the value it inherited when the
    -- organization's value changed (its history is not rewritten). The rollover does not copy such a row: the next
    -- season inherits.
    frozen_from_organization boolean NOT NULL DEFAULT false,
    -- One level per row: the organization's (neither), a program's or a division's.
    CONSTRAINT scoped_settings_one_level CHECK (num_nonnulls(program_id, division_id) <= 1),
    -- "Inherit" is the absence of a row, never a JSON null.
    CONSTRAINT scoped_settings_value_not_null CHECK (jsonb_typeof(value) <> 'null'),
    -- Only a division's row is ever frozen.
    CONSTRAINT scoped_settings_frozen_division CHECK (NOT frozen_from_organization OR division_id IS NOT NULL)
);

CREATE UNIQUE INDEX scoped_settings_organization_key
    ON public.scoped_settings (organization_id, key) WHERE program_id IS NULL AND division_id IS NULL;
CREATE UNIQUE INDEX scoped_settings_program_key
    ON public.scoped_settings (program_id, key) WHERE program_id IS NOT NULL;
CREATE UNIQUE INDEX scoped_settings_division_key
    ON public.scoped_settings (division_id, key) WHERE division_id IS NOT NULL;
CREATE INDEX idx_scoped_settings_key ON public.scoped_settings (key);

-- A row belongs to the organization of the program or division it names: refused (23514) whoever writes it, the
-- definer writers included (the schedule_tbd_enforce_tenancy pattern, 20261108020000).
CREATE FUNCTION public.scoped_settings_enforce_tenancy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.program_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.programs p WHERE p.id = NEW.program_id AND p.organization_id = NEW.organization_id) THEN
        RAISE EXCEPTION 'scoped_settings: program % is not a program of organization %', NEW.program_id, NEW.organization_id
            USING ERRCODE = '23514';
    END IF;
    IF NEW.division_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.divisions d WHERE d.id = NEW.division_id AND d.organization_id = NEW.organization_id) THEN
        RAISE EXCEPTION 'scoped_settings: division % is not a division of organization %', NEW.division_id, NEW.organization_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.scoped_settings_enforce_tenancy() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER scoped_settings_enforce_tenancy
    BEFORE INSERT OR UPDATE ON public.scoped_settings
    FOR EACH ROW EXECUTE FUNCTION public.scoped_settings_enforce_tenancy();

CREATE TRIGGER scoped_settings_set_timestamp
    BEFORE UPDATE ON public.scoped_settings
    FOR EACH ROW EXECUTE FUNCTION public.trigger_set_timestamp();

COMMENT ON TABLE public.scoped_settings IS
    'A setting of scoped_setting_keys at one level: the organization''s (program_id and division_id null), a program''s or a division''s. No row means inherit; the most specific row wins (scoped_setting_value). Written only by admin_set_scoped_setting (audited) and admin_create_season_from (the copy); members read. 20261124010000.';

ALTER TABLE public.scoped_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Scoped settings: org members select"
    ON public.scoped_settings
    FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id));
-- Default privileges hand new tables to authenticated and service_role with every privilege, so the revoke names them
-- too (the 20261006000000 reasoning, as programs does).
REVOKE ALL ON public.scoped_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.scoped_settings TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The organization's standings value moves here (decision S2), exactly.
-- ---------------------------------------------------------------------------
-- Only a JSON boolean was ever read as a value (org_flag); anything else, or no key, was the default (false), and an
-- organization with no row resolves to the registry default, false. No audit row: the value does not change.

INSERT INTO public.scoped_settings (organization_id, key, value)
SELECT o.id, 'standings_count_outside_results', o.feature_flags -> 'standings_count_outside_results'
  FROM public.organizations o
 WHERE jsonb_typeof(o.feature_flags -> 'standings_count_outside_results') = 'boolean';

-- ---------------------------------------------------------------------------
-- 3. The resolver.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.scoped_setting_value(p_division_id uuid, p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_default jsonb;
    v_value jsonb;
BEGIN
    SELECT k.default_value INTO v_default FROM public.scoped_setting_keys k WHERE k.key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown setting %', p_key USING ERRCODE = '22023', DETAIL = 'unknown_setting';
    END IF;

    -- The division's own value.
    SELECT s.value INTO v_value
      FROM public.scoped_settings s
     WHERE s.division_id = p_division_id AND s.key = p_key;
    IF FOUND THEN
        RETURN v_value;
    END IF;

    -- Its program's (the default program, "No program", holds none and is never a level).
    SELECT s.value INTO v_value
      FROM public.divisions d
      JOIN public.programs p ON p.id = d.program_id AND NOT p.is_default
      JOIN public.scoped_settings s ON s.program_id = p.id AND s.key = p_key
     WHERE d.id = p_division_id;
    IF FOUND THEN
        RETURN v_value;
    END IF;

    -- Its organization's.
    SELECT s.value INTO v_value
      FROM public.divisions d
      JOIN public.scoped_settings s ON s.organization_id = d.organization_id
                                   AND s.program_id IS NULL AND s.division_id IS NULL AND s.key = p_key
     WHERE d.id = p_division_id;
    IF FOUND THEN
        RETURN v_value;
    END IF;

    RETURN v_default;
END;
$$;

REVOKE ALL ON FUNCTION public.scoped_setting_value(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoped_setting_value(uuid, text) TO service_role;
COMMENT ON FUNCTION public.scoped_setting_value(uuid, text) IS
    'Internal: a division''s value of a scoped setting: its own row, else its (non-default) program''s, else its organization''s, else scoped_setting_keys.default_value. 22023 unknown_setting for a key not registered. No client role executes it; callers that answer a client (standings_counts_outside) check membership first. Core twin: resolveScopedSetting (packages/core/src/scopedSettings.js). 20261124010000.';

-- ---------------------------------------------------------------------------
-- 4. The one setter.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.admin_set_scoped_setting(
    p_key text,
    p_scope text,
    p_scope_id uuid,
    p_value jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_org uuid;
    v_season uuid;
    v_status text;
    v_name text;
    v_is_default boolean := false;
    v_key public.scoped_setting_keys%ROWTYPE;
    v_value jsonb;
    v_row_id uuid;
    v_old jsonb;
    v_old_effective jsonb;
    v_frozen integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_scope IS NULL OR p_scope NOT IN ('organization', 'program', 'division') THEN
        RAISE EXCEPTION 'a setting is set for an organization, a program or a division, not %', COALESCE(p_scope, 'nothing')
            USING ERRCODE = '22023', DETAIL = 'scope_invalid';
    END IF;
    IF p_scope_id IS NULL THEN
        RAISE EXCEPTION 'p_scope_id is required' USING ERRCODE = '23502';
    END IF;

    -- The organization comes from the scope's own row, never from the caller: a missing row and another organization's
    -- get the same refusal.
    IF p_scope = 'organization' THEN
        SELECT o.id, o.name INTO v_org, v_name FROM public.organizations o WHERE o.id = p_scope_id;
    ELSIF p_scope = 'program' THEN
        SELECT p.organization_id, p.season_settings_id, p.name, p.is_default
          INTO v_org, v_season, v_name, v_is_default
          FROM public.programs p WHERE p.id = p_scope_id;
    ELSE
        SELECT d.organization_id, d.season_settings_id, d.name
          INTO v_org, v_season, v_name
          FROM public.divisions d WHERE d.id = p_scope_id;
    END IF;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the %''s organization', p_scope
            USING ERRCODE = '42501';
    END IF;

    -- The organization's season lock, the one the program writers and the rollover take, so a rollover's copy and a
    -- change cannot interleave. Then the scope row is read again under it.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    IF p_scope = 'program' THEN
        SELECT p.season_settings_id, p.name, p.is_default INTO v_season, v_name, v_is_default
          FROM public.programs p WHERE p.id = p_scope_id AND p.organization_id = v_org FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'the program no longer exists' USING ERRCODE = '42501';
        END IF;
    ELSIF p_scope = 'division' THEN
        SELECT d.season_settings_id, d.name INTO v_season, v_name
          FROM public.divisions d WHERE d.id = p_scope_id AND d.organization_id = v_org FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'the division no longer exists' USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT * INTO v_key FROM public.scoped_setting_keys k WHERE k.key = p_key;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown setting %', COALESCE(p_key, 'NULL') USING ERRCODE = '22023', DETAIL = 'unknown_setting';
    END IF;

    -- The value, checked against its registered type. A text set is stored sorted and without repeats, so one set has
    -- one spelling and "unchanged" is an equality.
    IF p_value IS NOT NULL THEN
        IF v_key.value_type = 'boolean' THEN
            IF jsonb_typeof(p_value) <> 'boolean' THEN
                RAISE EXCEPTION 'the setting % takes true or false', p_key USING ERRCODE = '22023', DETAIL = 'setting_value_invalid';
            END IF;
            v_value := p_value;
        ELSE
            IF jsonb_typeof(p_value) <> 'array'
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) e WHERE jsonb_typeof(e) <> 'string')
               OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_value) e
                           WHERE NOT (v_key.allowed_values ? e))
               OR (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(p_value) e) <> jsonb_array_length(p_value) THEN
                RAISE EXCEPTION 'the setting % takes a list of distinct values from %', p_key, v_key.allowed_values::text
                    USING ERRCODE = '22023', DETAIL = 'setting_value_invalid';
            END IF;
            v_value := COALESCE((SELECT jsonb_agg(e ORDER BY e COLLATE "C") FROM jsonb_array_elements_text(p_value) e), '[]'::jsonb);
        END IF;
    END IF;

    IF v_is_default THEN
        RAISE EXCEPTION 'the default program ("No program") holds no settings: its divisions follow the organization'
            USING ERRCODE = '22023', DETAIL = 'default_program';
    END IF;
    IF v_season IS NOT NULL THEN
        SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_season;
        IF v_status = 'completed' THEN
            RAISE EXCEPTION 'Season % is completed and its settings cannot be changed', v_season
                USING ERRCODE = '22023', DETAIL = 'season_completed';
        END IF;
    END IF;

    -- One plain lookup per level, each the shape of its partial unique index.
    IF p_scope = 'organization' THEN
        SELECT s.id, s.value INTO v_row_id, v_old
          FROM public.scoped_settings s
         WHERE s.organization_id = v_org AND s.key = p_key AND s.program_id IS NULL AND s.division_id IS NULL
           FOR UPDATE;
    ELSIF p_scope = 'program' THEN
        SELECT s.id, s.value INTO v_row_id, v_old
          FROM public.scoped_settings s
         WHERE s.program_id = p_scope_id AND s.key = p_key
           FOR UPDATE;
    ELSE
        SELECT s.id, s.value INTO v_row_id, v_old
          FROM public.scoped_settings s
         WHERE s.division_id = p_scope_id AND s.key = p_key
           FOR UPDATE;
    END IF;

    IF v_old IS NOT DISTINCT FROM v_value THEN
        RETURN jsonb_build_object('changed', false, 'scope', p_scope, 'scope_id', p_scope_id, 'key', p_key,
                                  'previous', v_old, 'current', v_value);
    END IF;

    -- An organization's change does not rewrite a COMPLETED season's history: each of its divisions that inherits the
    -- organization's value today (no row of its own, and no program value: in no program or the default one) is held at
    -- the value it had, by a division row marked frozen_from_organization, before the change is made.
    IF p_scope = 'organization' THEN
        v_old_effective := COALESCE(v_old, v_key.default_value);
        IF v_old_effective IS DISTINCT FROM COALESCE(v_value, v_key.default_value) THEN
            INSERT INTO public.scoped_settings (organization_id, division_id, key, value, updated_by, frozen_from_organization)
            SELECT v_org, d.id, p_key, v_old_effective, auth.uid(), true
              FROM public.divisions d
              JOIN public.season_settings ss ON ss.id = d.season_settings_id AND ss.status = 'completed'
              LEFT JOIN public.programs p ON p.id = d.program_id
             WHERE d.organization_id = v_org
               AND NOT EXISTS (SELECT 1 FROM public.scoped_settings s WHERE s.division_id = d.id AND s.key = p_key)
               AND (p.id IS NULL OR p.is_default
                    OR NOT EXISTS (SELECT 1 FROM public.scoped_settings s WHERE s.program_id = p.id AND s.key = p_key));
            GET DIAGNOSTICS v_frozen = ROW_COUNT;
        END IF;
    END IF;

    IF v_value IS NULL THEN
        DELETE FROM public.scoped_settings WHERE id = v_row_id;
    ELSIF v_row_id IS NULL THEN
        INSERT INTO public.scoped_settings (organization_id, program_id, division_id, key, value, updated_by)
        VALUES (v_org,
                CASE WHEN p_scope = 'program' THEN p_scope_id END,
                CASE WHEN p_scope = 'division' THEN p_scope_id END,
                p_key, v_value, auth.uid());
    ELSE
        UPDATE public.scoped_settings SET value = v_value, updated_by = auth.uid() WHERE id = v_row_id;
    END IF;

    PERFORM public.record_audit_event(
        v_org,
        'settings.updated',
        'scoped_setting',
        p_scope_id,
        jsonb_build_object(
            'setting', 'scoped_setting',
            'field', p_key,
            'key', p_key,
            'scope', p_scope,
            'scope_id', p_scope_id,
            'scope_name', v_name,
            'season_settings_id', v_season,
            'old', v_old,
            'new', v_value,
            'frozen_completed_divisions', v_frozen
        )
    );

    RETURN jsonb_build_object('changed', true, 'scope', p_scope, 'scope_id', p_scope_id, 'key', p_key,
                              'previous', v_old, 'current', v_value, 'frozen_completed_divisions', v_frozen);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_scoped_setting(text, text, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_scoped_setting(text, text, uuid, jsonb) TO authenticated;
COMMENT ON FUNCTION public.admin_set_scoped_setting(text, text, uuid, jsonb) IS
    'Admin-only: set (or, with a NULL value, unset: inherit) a scoped setting for an organization, a program or a division. The organization is read from the scope''s own row; takes the organization''s season lock; checks the value against scoped_setting_keys; refuses the default program (default_program) and a completed season (season_completed). Audited as settings.updated, resource_type scoped_setting, with the value before and after (null = inherited). 20261124010000.';

-- ---------------------------------------------------------------------------
-- 5. A division's practice settings alone (decision S6; PR 11's follow-up).
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.admin_set_division_practice_settings(
    p_division_id uuid,
    p_practices_per_week integer DEFAULT NULL,
    p_practice_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET timezone = 'UTC'
AS $$
DECLARE
    v_division public.divisions%ROWTYPE;
    v_result public.divisions%ROWTYPE;
    v_status text;
    v_ppw integer;
    v_min integer;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_division_id IS NULL THEN
        RAISE EXCEPTION 'p_division_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT * INTO v_division FROM public.divisions d WHERE d.id = p_division_id;
    IF NOT FOUND OR NOT public.is_org_admin(v_division.organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the division''s organization' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_division.organization_id::text, 0));
    SELECT * INTO v_division FROM public.divisions d WHERE d.id = p_division_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the division no longer exists' USING ERRCODE = '42501';
    END IF;

    SELECT s.status INTO v_status FROM public.season_settings s WHERE s.id = v_division.season_settings_id;
    IF v_status = 'completed' THEN
        RAISE EXCEPTION 'Season % is completed and its division rules cannot be changed', v_division.season_settings_id
            USING ERRCODE = '22023', DETAIL = 'season_completed';
    END IF;

    -- As admin_upsert_division_settings (20261105010000): NULL keeps the stored value; 0 minutes is any slot length.
    v_ppw := COALESCE(p_practices_per_week, v_division.practices_per_week);
    v_min := CASE
        WHEN p_practice_minutes IS NULL THEN v_division.practice_minutes
        WHEN p_practice_minutes = 0 THEN NULL
        ELSE p_practice_minutes
    END;
    IF v_ppw NOT BETWEEN 0 AND 7 THEN
        RAISE EXCEPTION 'practices per week must be from 0 to 7, not %', v_ppw USING ERRCODE = '23514';
    END IF;
    IF v_min IS NOT NULL AND v_min NOT BETWEEN 15 AND 240 THEN
        RAISE EXCEPTION 'a practice length must be from 15 to 240 minutes (or 0 for any slot length), not %', v_min
            USING ERRCODE = '23514';
    END IF;

    IF v_division.practices_per_week IS NOT DISTINCT FROM v_ppw AND v_division.practice_minutes IS NOT DISTINCT FROM v_min THEN
        RETURN to_jsonb(v_division) || jsonb_build_object('changed', false);
    END IF;

    UPDATE public.divisions
       SET practices_per_week = v_ppw,
           practice_minutes = v_min,
           updated_at = now()
     WHERE id = p_division_id
     RETURNING * INTO v_result;

    PERFORM public.record_audit_event(
        v_division.organization_id,
        'settings.updated',
        'division',
        p_division_id,
        jsonb_build_object(
            'setting', 'division_team_generation_rules',
            'division_id', p_division_id,
            'season_settings_id', v_division.season_settings_id,
            'name', v_division.name,
            'previous', jsonb_build_object('practices_per_week', v_division.practices_per_week,
                                           'practice_minutes', v_division.practice_minutes),
            'current', jsonb_build_object('practices_per_week', v_result.practices_per_week,
                                          'practice_minutes', v_result.practice_minutes)
        )
    );

    RETURN to_jsonb(v_result) || jsonb_build_object('changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_division_practice_settings(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_division_practice_settings(uuid, integer, integer) TO authenticated;
COMMENT ON FUNCTION public.admin_set_division_practice_settings(uuid, integer, integer) IS
    'Admin-only: a division''s practices a week (0 to 7) and practice length (15 to 240 minutes, 0 = any slot length) and nothing else; NULL keeps a stored value. A completed season is refused. Takes the organization''s season lock. Audited as settings.updated (setting division_team_generation_rules) with only the two practice values before and after. 20261124010000.';

-- ---------------------------------------------------------------------------
-- 6. The standings seam reads the cascade. Copied from 20261122010000; changed: scoped_setting_value, not org_flag.
-- ---------------------------------------------------------------------------
-- Still SECURITY DEFINER, for the reason it was: the view is security_invoker, so this runs as the signed-in reader, and
-- the resolver is closed to every client role. It answers only for a member of the division's organization; anyone
-- else gets false, so it is not a way to read another organization's setting. Only a JSON true counts, as org_flag
-- read only a boolean.

CREATE OR REPLACE FUNCTION public.standings_counts_outside(p_division_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE((SELECT public.scoped_setting_value(d.id, 'standings_count_outside_results') = 'true'::jsonb
                       FROM public.divisions d
                      WHERE d.id = p_division_id
                        AND public.is_org_member(d.organization_id)), false)
$$;

COMMENT ON FUNCTION public.standings_counts_outside(uuid) IS
    'Whether a division''s standings count its teams'' results against outside clubs (teams.is_external): the scoped setting standings_count_outside_results through scoped_setting_value (the division''s own value, else its program''s, else the organization''s, else false). It runs with its owner''s rights because view_league_standings calls it as its reader and the resolver is closed to client roles; it answers false for a division of an organization the caller is not a member of. 20261122010000; the cascade since 20261124010000.';

-- ---------------------------------------------------------------------------
-- 7. The rollover copies program and division values. Copied whole from 20261111010000; changed: the block marked
--    20261124010000 and the count appended to the audit metadata and the result.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_season_from(
    p_source_season_id uuid,
    p_name text,
    p_season_year integer,
    p_season_start date DEFAULT NULL,
    p_season_end date DEFAULT NULL
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
    v_source public.season_settings%ROWTYPE;
    v_new_id uuid;
    v_shift integer;
    v_season_cols text;
    v_division_cols text;
    v_division_exprs text;
    v_programs integer := 0;
    v_divisions integer := 0;
    -- 20261124010000: the program and division values of the settings cascade copied.
    v_settings integer := 0;
    v_settings_divisions integer := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'authenticated user is required' USING ERRCODE = '42501';
    END IF;
    IF p_source_season_id IS NULL THEN
        RAISE EXCEPTION 'p_source_season_id is required' USING ERRCODE = '23502';
    END IF;

    SELECT s.organization_id INTO v_org FROM public.season_settings s WHERE s.id = p_source_season_id;
    IF v_org IS NULL OR NOT public.is_org_admin(v_org) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of the season''s organization'
            USING ERRCODE = '42501';
    END IF;

    -- The organization's season lock, then every season of it, so two admins at once are
    -- serialised and the source cannot change under the copy.
    PERFORM pg_advisory_xact_lock(hashtextextended('season:' || v_org::text, 0));
    PERFORM 1 FROM public.season_settings s WHERE s.organization_id = v_org ORDER BY s.id FOR UPDATE;

    SELECT * INTO v_source FROM public.season_settings s WHERE s.id = p_source_season_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'season % no longer exists', p_source_season_id USING ERRCODE = '42501';
    END IF;

    IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
        RAISE EXCEPTION 'a season name must be 1 to 80 characters' USING ERRCODE = '22023';
    END IF;
    IF p_season_year IS NULL OR p_season_year NOT BETWEEN 2000 AND 2100 THEN
        RAISE EXCEPTION 'the season year (the year the season starts) must be between 2000 and 2100'
            USING ERRCODE = '22023', DETAIL = 'season_year_invalid';
    END IF;
    IF p_season_start IS NOT NULL AND p_season_end IS NOT NULL AND p_season_end < p_season_start THEN
        RAISE EXCEPTION 'the season cannot end before it starts' USING ERRCODE = '22023', DETAIL = 'season_dates_invalid';
    END IF;

    -- Decision 4: a division's birth-date window moves with the season year (one year for
    -- the next season). A source with no year moves it one year.
    v_shift := COALESCE(p_season_year - v_source.season_year, 1);

    -- The season: the catalogue's columns copied, the rest the new season's own. A draft.
    SELECT string_agg(quote_ident(c), ', ') INTO v_season_cols
      FROM unnest(public.rollover_season_columns()) AS c;
    BEGIN
        EXECUTE format(
            'INSERT INTO public.season_settings (organization_id, name, status, season_year, season_start, season_end, %s) '
            'SELECT s.organization_id, $2, ''draft'', $3, $4, $5, %s FROM public.season_settings s WHERE s.id = $1 '
            'RETURNING id',
            v_season_cols,
            (SELECT string_agg('s.' || quote_ident(c), ', ') FROM unnest(public.rollover_season_columns()) AS c))
        INTO v_new_id
        USING p_source_season_id, v_name, p_season_year, p_season_start, p_season_end;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'a season named "%" already exists', v_name USING ERRCODE = '23505';
    END;

    -- Programs: the source's own (non-default) programs, linked by copied_from_program_id; the
    -- new season's trigger-made default is the source default's copy.
    INSERT INTO public.programs (organization_id, season_settings_id, name, copied_from_program_id)
    SELECT p.organization_id, v_new_id, p.name, p.id
      FROM public.programs p
     WHERE p.season_settings_id = p_source_season_id AND NOT p.is_default;
    GET DIAGNOSTICS v_programs = ROW_COUNT;
    UPDATE public.programs np
       SET copied_from_program_id = sp.id
      FROM public.programs sp
     WHERE np.season_settings_id = v_new_id AND np.is_default
       AND sp.season_settings_id = p_source_season_id AND sp.is_default;

    -- Divisions: every catalogue column, a window shifted, each in the copy of its program.
    SELECT string_agg(quote_ident(c), ', ') INTO v_division_cols
      FROM unnest(public.rollover_division_columns()) AS c;
    SELECT string_agg(
               CASE WHEN c IN ('birthdate_start', 'birthdate_end')
                    THEN format('(d.%I + make_interval(years => $3))::date', c)
                    ELSE format('d.%I', c) END, ', ')
      INTO v_division_exprs
      FROM unnest(public.rollover_division_columns()) AS c;
    EXECUTE format(
        'INSERT INTO public.divisions (season_settings_id, program_id, %s) '
        'SELECT $2, np.id, %s FROM public.divisions d '
        'JOIN public.programs sp ON sp.id = d.program_id '
        'JOIN public.programs np ON np.season_settings_id = $2 AND np.copied_from_program_id = sp.id '
        'WHERE d.season_settings_id = $1',
        v_division_cols, v_division_exprs)
    USING p_source_season_id, v_new_id, v_shift;
    GET DIAGNOSTICS v_divisions = ROW_COUNT;

    -- A division the join dropped would be silently lost: the copy must be whole.
    IF v_divisions <> (SELECT count(*) FROM public.divisions d WHERE d.season_settings_id = p_source_season_id) THEN
        RAISE EXCEPTION 'season % was not copied whole: % of its divisions found a program', p_source_season_id, v_divisions
            USING ERRCODE = 'XX000';
    END IF;

    -- 20261124010000: each program's and each division's own scoped settings go with their copies (the organization's
    -- are not per season). A program's copy is found by copied_from_program_id; a division's by its name, which is
    -- unique in a season and copied exactly above. The default program holds none (admin_set_scoped_setting refuses
    -- it), so its copy gets none. A division row frozen_from_organization (a completed season held at what it inherited)
    -- is not copied: the next season inherits.
    INSERT INTO public.scoped_settings (organization_id, program_id, key, value, updated_by)
    SELECT s.organization_id, np.id, s.key, s.value, auth.uid()
      FROM public.scoped_settings s
      JOIN public.programs sp ON sp.id = s.program_id AND sp.season_settings_id = p_source_season_id
      JOIN public.programs np ON np.season_settings_id = v_new_id AND np.copied_from_program_id = sp.id;
    GET DIAGNOSTICS v_settings = ROW_COUNT;
    INSERT INTO public.scoped_settings (organization_id, division_id, key, value, updated_by)
    SELECT s.organization_id, nd.id, s.key, s.value, auth.uid()
      FROM public.scoped_settings s
      JOIN public.divisions sd ON sd.id = s.division_id AND sd.season_settings_id = p_source_season_id
      JOIN public.divisions nd ON nd.season_settings_id = v_new_id AND nd.name = sd.name
     WHERE NOT s.frozen_from_organization;
    GET DIAGNOSTICS v_settings_divisions = ROW_COUNT;
    v_settings := v_settings + v_settings_divisions;
    -- A value the joins dropped would be silently lost: the copy must be whole.
    IF v_settings <> (SELECT count(*) FROM public.scoped_settings s
                        LEFT JOIN public.programs sp ON sp.id = s.program_id
                        LEFT JOIN public.divisions sd ON sd.id = s.division_id
                       WHERE (sp.season_settings_id = p_source_season_id OR sd.season_settings_id = p_source_season_id)
                         AND NOT s.frozen_from_organization) THEN
        RAISE EXCEPTION 'season % was not copied whole: % of its scoped settings found their copy', p_source_season_id, v_settings
            USING ERRCODE = 'XX000';
    END IF;

    PERFORM public.record_audit_event(
        v_org,
        'season.created_from',
        'season_settings',
        v_new_id,
        jsonb_build_object(
            'source_season_id', p_source_season_id,
            'name', v_name,
            'season_year', p_season_year,
            'divisions_copied', v_divisions,
            'programs_copied', v_programs,
            'window_shift_years', v_shift,
            'scoped_settings_copied', v_settings
        )
    );

    RETURN jsonb_build_object(
        'id', v_new_id,
        'organization_id', v_org,
        'name', v_name,
        'status', 'draft',
        'season_year', p_season_year,
        'source_season_id', p_source_season_id,
        'divisions_copied', v_divisions,
        'programs_copied', v_programs,
        'scoped_settings_copied', v_settings
    );
END;
$$;

COMMENT ON FUNCTION public.admin_create_season_from(uuid, text, integer, date, date) IS
    'Admin-only: a new draft season from any season of the organization: its divisions (every column of rollover_division_columns(), birth-date windows shifted by the difference in season years) and programs, each program''s and division''s scoped settings (20261124010000), and no player, coach or team; season settings from rollover_season_columns(). Takes the organization''s season lock. Audited as season.created_from. 20261111010000.';

-- ---------------------------------------------------------------------------
-- 8. The end state, or the migration does not commit.
-- ---------------------------------------------------------------------------

DO $check$
DECLARE
    v_tbl text;
    v_src text;
BEGIN
    FOREACH v_tbl IN ARRAY ARRAY['public.scoped_settings', 'public.scoped_setting_keys'] LOOP
        IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = v_tbl::regclass) THEN
            RAISE EXCEPTION '% has no row level security', v_tbl;
        END IF;
        IF (SELECT string_agg(p.polcmd::text, ',') FROM pg_policy p WHERE p.polrelid = v_tbl::regclass) IS DISTINCT FROM 'r' THEN
            RAISE EXCEPTION '% must have exactly one policy, for SELECT', v_tbl;
        END IF;
        IF has_table_privilege('anon', v_tbl, 'SELECT')
           OR has_table_privilege('authenticated', v_tbl, 'INSERT')
           OR has_table_privilege('authenticated', v_tbl, 'UPDATE')
           OR has_table_privilege('authenticated', v_tbl, 'DELETE')
           OR NOT has_table_privilege('authenticated', v_tbl, 'SELECT') THEN
            RAISE EXCEPTION '%: a signed-in user reads and nothing else; anon nothing', v_tbl;
        END IF;
    END LOOP;

    -- The resolver is internal; the two setters are the admin RPCs and nothing else.
    IF has_function_privilege('authenticated', 'public.scoped_setting_value(uuid,text)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.scoped_setting_value(uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'scoped_setting_value is open to a client role';
    END IF;
    IF has_function_privilege('anon', 'public.admin_set_scoped_setting(text,text,uuid,jsonb)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.admin_set_division_practice_settings(uuid,integer,integer)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.admin_set_scoped_setting(text,text,uuid,jsonb)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.admin_set_division_practice_settings(uuid,integer,integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'the setters must be executable by authenticated and not by anon';
    END IF;

    -- Volatility, as 20261122010000 asserted for the seam: the resolver and the seam are STABLE (the standings view calls
    -- them per row); the two setters and the tenancy trigger write, so they are VOLATILE.
    IF (SELECT string_agg(p.oid::regprocedure::text || '=' || p.provolatile::text, ',' ORDER BY p.oid::regprocedure::text) FROM pg_proc p
         WHERE p.oid IN (to_regprocedure('public.standings_counts_outside(uuid)'), to_regprocedure('public.scoped_setting_value(uuid,text)'),
                         to_regprocedure('public.admin_set_scoped_setting(text,text,uuid,jsonb)'),
                         to_regprocedure('public.admin_set_division_practice_settings(uuid,integer,integer)'),
                         to_regprocedure('public.scoped_settings_enforce_tenancy()')))
       IS DISTINCT FROM 'admin_set_division_practice_settings(uuid,integer,integer)=v,admin_set_scoped_setting(text,text,uuid,jsonb)=v,scoped_setting_value(uuid,text)=s,scoped_settings_enforce_tenancy()=v,standings_counts_outside(uuid)=s' THEN
        RAISE EXCEPTION 'a function of this migration does not have the volatility it needs';
    END IF;

    -- The seam: the member-checked definer, reading the resolver and no longer org_flag.
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.standings_counts_outside(uuid)');
    IF NOT (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=public']
              FROM pg_proc p WHERE p.oid = to_regprocedure('public.standings_counts_outside(uuid)'))
       OR v_src !~ 'is_org_member' OR v_src !~ 'scoped_setting_value' OR v_src ~ 'org_flag'
       OR NOT has_function_privilege('authenticated', 'public.standings_counts_outside(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.standings_counts_outside(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'standings_counts_outside is not the member-checked definer over the resolver';
    END IF;

    -- The rollover copies the values.
    IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_create_season_from(uuid,text,integer,date,date)'))
       !~ 'INSERT INTO public.scoped_settings' THEN
        RAISE EXCEPTION 'admin_create_season_from does not copy the scoped settings';
    END IF;

    -- The move was exact: one organization row for each organization whose flags hold the key as a boolean, with that
    -- value; none for any other.
    IF EXISTS (
        SELECT 1 FROM public.organizations o
          LEFT JOIN public.scoped_settings s ON s.organization_id = o.id AND s.program_id IS NULL AND s.division_id IS NULL
                                            AND s.key = 'standings_count_outside_results'
         WHERE (s.value IS DISTINCT FROM CASE WHEN jsonb_typeof(o.feature_flags -> 'standings_count_outside_results') = 'boolean'
                                              THEN o.feature_flags -> 'standings_count_outside_results' END)
    ) THEN
        RAISE EXCEPTION 'the organization standings values were not carried over exactly';
    END IF;
END;
$check$;

COMMIT;
