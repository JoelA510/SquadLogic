-- Revert for 20261103020000_drop_unused_views.sql
--
-- Recreates `coach_team_map` and `view_facility_usage` from their last definitions
-- (20260331000000_definitive_schema.sql; `coach_team_map` with `security_invoker` as
-- 20260421002500 left it), with the grant a fresh build has. This returns a database to what every
-- fresh build had before the drop. **Production never had either view**: reverting there CREATES two
-- views it has never carried, which the catalogue check then lists as `only_in_database`; revert
-- only to restore a fresh build's shape. Nothing reads them.

BEGIN;

DO $revert$
BEGIN
    RAISE NOTICE 'this revert creates % view(s) (a view already present is replaced by its last definition)',
        (SELECT count(*) FROM (VALUES ('public.coach_team_map'), ('public.view_facility_usage')) v(n)
          WHERE to_regclass(v.n) IS NULL);
END;
$revert$;

CREATE OR REPLACE VIEW public.coach_team_map
WITH (security_invoker = true)
AS
SELECT
    c.user_id AS coach_user_id,
    t.id AS team_id
FROM public.coaches c
JOIN public.teams t ON t.coach_id = c.id
WHERE c.user_id IS NOT NULL
UNION
SELECT
    c.user_id AS coach_user_id,
    t.id AS team_id
FROM public.coaches c
JOIN public.teams t ON c.id = ANY(t.assistant_coach_ids)
WHERE c.user_id IS NOT NULL;

CREATE OR REPLACE VIEW public.view_facility_usage
WITH (security_invoker = true)
AS
SELECT
    f.id AS field_id,
    f.organization_id,
    f.name AS field_name,
    COUNT(DISTINCT pa.id) AS practice_count,
    COUNT(DISTINCT g.id) AS game_count,
    COUNT(DISTINCT pa.id) + COUNT(DISTINCT g.id) AS total_events
FROM public.fields f
LEFT JOIN public.practice_slots ps ON ps.field_id = f.id
LEFT JOIN public.practice_assignments pa ON pa.practice_slot_id = ps.id
LEFT JOIN public.game_slots gs ON gs.field_id = f.id
LEFT JOIN public.games g ON g.game_slot_id = gs.id
GROUP BY f.id, f.organization_id, f.name;

GRANT SELECT ON public.coach_team_map, public.view_facility_usage TO authenticated;

DO $revert$
BEGIN
    IF to_regclass('public.coach_team_map') IS NULL OR to_regclass('public.view_facility_usage') IS NULL THEN
        RAISE EXCEPTION 'a view was not recreated';
    END IF;
    IF (SELECT count(*) FROM pg_class c
         WHERE c.oid IN ('public.coach_team_map'::regclass, 'public.view_facility_usage'::regclass)
           AND c.relkind = 'v'
           AND EXISTS (SELECT 1 FROM unnest(c.reloptions) o WHERE o IN ('security_invoker=true', 'security_invoker=on'))) <> 2 THEN
        RAISE EXCEPTION 'a recreated view is not security_invoker';
    END IF;
    RAISE NOTICE 'revert verified: coach_team_map and view_facility_usage are back, both security_invoker';
END;
$revert$;

COMMIT;
