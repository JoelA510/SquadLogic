-- Revert for 20261006000000_org_heat_settings.sql
--
-- **This revert DESTROYS every organisation's heat settings** (threshold
-- category and guidance links). An admin chose each; the audit log is the only
-- other record. So the figures are printed BEFORE the drop, and the transcript
-- of a revert says what it cost. `scripts/dbharness/run.sh` plants 3
-- organisations' settings, 2 of them with links (3 links in total), and checks
-- this warning prints exactly those figures.
--
-- Removes the RPC and the table. The settings.heat_updated audit action and the
-- audit rows written under it stay: audit history is not this revert's to
-- erase. After the revert the forecast screen reads every organisation as
-- Category 1 with no links -- the frontend treats a missing table as an error,
-- so revert the frontend first.

BEGIN;

DO $warn$
DECLARE
    v_orgs integer;
    v_with_links integer;
    v_links integer;
BEGIN
    SELECT count(*),
           count(*) FILTER (WHERE jsonb_array_length(guidance_links) > 0),
           coalesce(sum(jsonb_array_length(guidance_links)), 0)
      INTO v_orgs, v_with_links, v_links
      FROM public.organization_heat_settings;
    RAISE WARNING 'this revert DESTROYS the heat settings of % organisation(s), % of them with guidance links (% link(s) in total)',
        v_orgs, v_with_links, v_links;
END;
$warn$;

DROP FUNCTION IF EXISTS public.admin_set_org_heat_settings(uuid, integer, jsonb);
DROP TABLE IF EXISTS public.organization_heat_settings;

DO $verify$
BEGIN
    IF to_regclass('public.organization_heat_settings') IS NOT NULL THEN
        RAISE EXCEPTION 'organization_heat_settings survived its own revert';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND p.proname = 'admin_set_org_heat_settings') THEN
        RAISE EXCEPTION 'admin_set_org_heat_settings survived its own revert';
    END IF;
    RAISE NOTICE 'revert verified: organization_heat_settings and admin_set_org_heat_settings are gone; the settings.heat_updated audit action stays registered.';
END;
$verify$;

COMMIT;
