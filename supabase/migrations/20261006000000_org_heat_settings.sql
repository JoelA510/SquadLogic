-- Field heat-stress (WBGT) forecast: the organisation's heat settings -- the
-- table, its one writer, and its audit action.
--
-- Design: docs/architecture/heat-forecast.md.
--
-- **What this adds.** One row per organisation holding:
--   * threshold_category -- the U.S. Soccer Recognize to Recover region
--     category (1, 2 or 3) the forecast bands against. No row means
--     Category 1, and the screen's provenance says "default (not
--     configured)" rather than "configured";
--   * guidance_links -- the organisation's governing-body links
--     (e.g. its league's health and safety page), shown in the forecast's
--     sources panel. Up to 10 {label, url} objects, https only.
--
-- **Why a table, not organizations.settings / feature_flags.** organizations
-- carries an admin FOR ALL policy ("Organizations: admins manage",
-- 20260726000100), so a column there could be written directly, bypassing the
-- RPC, its validation and its audit row. This table has a SELECT policy and no
-- write policy: admin_set_org_heat_settings is its only client writer.
--
-- **Data minimisation.** No PII: a small integer and public URLs.

BEGIN;

INSERT INTO public.audit_actions (action) VALUES ('settings.heat_updated')
    ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. The table, its CHECKs and its read policy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organization_heat_settings (
    organization_id    uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
    threshold_category smallint NOT NULL DEFAULT 1,
    guidance_links     jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at         timestamptz NOT NULL DEFAULT timezone('utc', now()),
    updated_by         uuid,
    CONSTRAINT organization_heat_settings_category_range
        CHECK (threshold_category BETWEEN 1 AND 3),
    CONSTRAINT organization_heat_settings_links_shape
        CHECK (jsonb_typeof(guidance_links) = 'array' AND jsonb_array_length(guidance_links) <= 10)
);

COMMENT ON TABLE public.organization_heat_settings IS
  'Per-organisation heat forecast settings: the U.S. Soccer Recognize to Recover threshold category and governing-body guidance links. No row means Category 1, no links. Written only by admin_set_org_heat_settings.';
COMMENT ON COLUMN public.organization_heat_settings.threshold_category IS
  'U.S. Soccer Recognize to Recover region category, 1-3 (Category 1 bands: Green <=76.1, Yellow <=81.0, Orange <=84.1, Red <=86.2, Black >86.2 F WBGT).';
COMMENT ON COLUMN public.organization_heat_settings.guidance_links IS
  'Up to 10 {label, url} objects (label 1-80 chars, https url up to 500 chars), validated by admin_set_org_heat_settings.';
COMMENT ON COLUMN public.organization_heat_settings.updated_by IS
  'auth.uid() of the admin who last wrote the row. No FK, as locations.coordinates_set_by.';

ALTER TABLE public.organization_heat_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Organization heat settings: members select" ON public.organization_heat_settings;
CREATE POLICY "Organization heat settings: members select"
    ON public.organization_heat_settings
    FOR SELECT TO authenticated
    USING (public.is_org_member(organization_id));

-- Default privileges hand new tables to authenticated and service_role with
-- every privilege, so the revoke names them too (the 20260923000000 reasoning).
REVOKE ALL ON public.organization_heat_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.organization_heat_settings TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The writer
-- ---------------------------------------------------------------------------
--
-- Follows admin_set_location_coordinates (20260930000000): SECURITY DEFINER,
-- search_path pinned, org-admin check, REVOKE PUBLIC/anon, GRANT
-- authenticated. Re-validates everything the client's Zod schema
-- (OrgHeatSettingsSchema, packages/core/src/heat/schemas.js) checks, and
-- stores the trimmed label and url, so what is read back is what was judged.
CREATE OR REPLACE FUNCTION public.admin_set_org_heat_settings(
    p_organization_id uuid,
    p_threshold_category integer,
    p_guidance_links jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_before public.organization_heat_settings%ROWTYPE;
    v_after public.organization_heat_settings%ROWTYPE;
    v_links jsonb := '[]'::jsonb;
    v_item jsonb;
    v_label text;
    v_url text;
    v_index integer := 0;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required'
            USING ERRCODE = '23502';
    END IF;

    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;

    IF p_threshold_category IS NULL OR p_threshold_category NOT BETWEEN 1 AND 3 THEN
        RAISE EXCEPTION 'threshold category must be 1, 2 or 3, got %', coalesce(p_threshold_category::text, 'NULL')
            USING ERRCODE = '22023';
    END IF;

    IF p_guidance_links IS NULL OR jsonb_typeof(p_guidance_links) <> 'array' THEN
        RAISE EXCEPTION 'guidance links must be a JSON array (an empty array clears them)'
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_guidance_links) > 10 THEN
        RAISE EXCEPTION 'at most 10 guidance links, got %', jsonb_array_length(p_guidance_links)
            USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_guidance_links) LOOP
        IF jsonb_typeof(v_item) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 2
           OR NOT (v_item ? 'label' AND v_item ? 'url')
           OR jsonb_typeof(v_item -> 'label') <> 'string'
           OR jsonb_typeof(v_item -> 'url') <> 'string' THEN
            RAISE EXCEPTION 'guidance link % must be an object with exactly a string label and a string url', v_index
                USING ERRCODE = '22023';
        END IF;
        -- Trim every leading/trailing whitespace character, not only spaces
        -- (btrim's default), as the client's String.prototype.trim() does: a
        -- tab-only label must be refused here, or it is stored and then fails
        -- the client's own schema on every read.
        v_label := regexp_replace(v_item ->> 'label', '^[[:space:]]+|[[:space:]]+$', '', 'g');
        v_url := regexp_replace(v_item ->> 'url', '^[[:space:]]+|[[:space:]]+$', '', 'g');
        IF char_length(v_label) NOT BETWEEN 1 AND 80 THEN
            RAISE EXCEPTION 'guidance link % label must be 1-80 characters', v_index
                USING ERRCODE = '22023';
        END IF;
        IF char_length(v_url) > 500 OR v_url !~ '^https://[^[:space:]/?#]+\.[^[:space:]/?#]+([/?#][^[:space:]]*)?$' THEN
            RAISE EXCEPTION 'guidance link % url must be an https URL of at most 500 characters', v_index
                USING ERRCODE = '22023';
        END IF;
        v_links := v_links || jsonb_build_array(jsonb_build_object('label', v_label, 'url', v_url));
        v_index := v_index + 1;
    END LOOP;

    SELECT * INTO v_before
      FROM public.organization_heat_settings
     WHERE organization_id = p_organization_id
     FOR UPDATE;

    INSERT INTO public.organization_heat_settings AS s
        (organization_id, threshold_category, guidance_links, updated_at, updated_by)
    VALUES
        (p_organization_id, p_threshold_category, v_links, timezone('utc', now()), auth.uid())
    ON CONFLICT (organization_id) DO UPDATE
       SET threshold_category = EXCLUDED.threshold_category,
           guidance_links = EXCLUDED.guidance_links,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by
    RETURNING * INTO v_after;

    PERFORM public.record_audit_event(
        p_organization_id,
        'settings.heat_updated',
        'organization',
        p_organization_id,
        jsonb_build_object(
            'operation', CASE WHEN v_before.organization_id IS NULL THEN 'created' ELSE 'updated' END,
            'before', CASE WHEN v_before.organization_id IS NULL THEN NULL ELSE jsonb_build_object(
                'threshold_category', v_before.threshold_category,
                'guidance_links', v_before.guidance_links) END,
            'after', jsonb_build_object(
                'threshold_category', v_after.threshold_category,
                'guidance_links', v_after.guidance_links)
        )
    );

    RETURN jsonb_build_object(
        'organization_id', v_after.organization_id,
        'threshold_category', v_after.threshold_category,
        'guidance_links', v_after.guidance_links,
        'updated_at', v_after.updated_at,
        'updated_by', v_after.updated_by
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_org_heat_settings(uuid, integer, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_org_heat_settings(uuid, integer, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_org_heat_settings(uuid, integer, jsonb) TO authenticated;

COMMENT ON FUNCTION public.admin_set_org_heat_settings(uuid, integer, jsonb) IS
  'Admin-only write of the organisation''s heat forecast settings: threshold category 1-3 and up to 10 https guidance links (22023 on any invalid value), upserted and audited as settings.heat_updated with before/after.';

COMMIT;
