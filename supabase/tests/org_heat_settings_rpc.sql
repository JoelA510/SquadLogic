-- pgTAP: organisation heat settings are written only through
-- admin_set_org_heat_settings (20261006000000), by an admin of that
-- organisation, and read only by its members.
--
-- Every URL here is under example.org; there is no PII.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(11);

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    (
        SELECT (r->>'threshold_category')::int || '|' || (r->'guidance_links')::text
          FROM public.admin_set_org_heat_settings(
                   'a1111111-1111-1111-1111-111111111111', 2,
                   '[{"label": " League safety ", "url": "https://example.org/safety"}]'::jsonb) AS r
    ),
    '2|[{"url": "https://example.org/safety", "label": "League safety"}]',
    'Org A admin sets category 2 and a link, stored trimmed'
);

SELECT is(
    (
        SELECT count(*)::int FROM public.audit_log
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND action = 'settings.heat_updated'
           AND metadata->>'operation' = 'created'
           AND metadata->'before' = 'null'::jsonb
           AND (metadata#>>'{after,threshold_category}')::int = 2
    ),
    1,
    'the write is audited as settings.heat_updated with before and after'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_org_heat_settings('a1111111-1111-1111-1111-111111111111', 4, '[]'::jsonb) $$,
    '22023',
    NULL,
    'category 4 is refused'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_org_heat_settings('a1111111-1111-1111-1111-111111111111', 1,
           '[{"label": "x", "url": "http://example.org"}]'::jsonb) $$,
    '22023',
    NULL,
    'an http link is refused'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_org_heat_settings('a1111111-1111-1111-1111-111111111111', 1, NULL) $$,
    '22023',
    NULL,
    'a NULL link list is refused (an empty array clears)'
);

SELECT throws_ok(
    $$ SELECT public.admin_set_org_heat_settings('b2222222-2222-2222-2222-222222222222', 1, '[]'::jsonb) $$,
    '42501',
    NULL,
    'Org A admin cannot set Org B''s settings'
);

-- No write policy and no write grant: a direct UPDATE is refused outright.
SELECT throws_ok(
    $$ UPDATE public.organization_heat_settings SET threshold_category = 3
        WHERE organization_id = 'a1111111-1111-1111-1111-111111111111' $$,
    '42501',
    NULL,
    'a direct UPDATE by the admin is refused; the RPC is the only writer'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$ SELECT public.admin_set_org_heat_settings('a1111111-1111-1111-1111-111111111111', 3, '[]'::jsonb) $$,
    '42501',
    NULL,
    'Org A coach cannot set heat settings'
);

SELECT is(
    (SELECT threshold_category::int FROM public.organization_heat_settings
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    2,
    'Org A coach reads Org A''s settings'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT is(
    (SELECT count(*)::int FROM public.organization_heat_settings
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'),
    0,
    'Org B admin cannot read Org A''s settings'
);

RESET role;

SELECT is(
    (
        SELECT count(*)::int FROM public.audit_log
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND action = 'settings.heat_updated'
    ),
    1,
    'one accepted write left one audit row; refusals left none'
);

SELECT * FROM finish();
ROLLBACK;
