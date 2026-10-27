-- pgTAP: organization invite revocation is org-scoped and auditable.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(9);

INSERT INTO public.organization_invites (
    id,
    code,
    organization_id,
    role,
    created_by,
    expires_at
)
VALUES
    (
        'aaaaaaaa-1111-1111-1111-111111111111',
        'A-OPEN1',
        'a1111111-1111-1111-1111-111111111111',
        'staff',
        '11111111-1111-1111-1111-111111111111',
        now() + interval '7 days'
    ),
    (
        'aaaaaaaa-2222-2222-2222-222222222222',
        'A-STAFF',
        'a1111111-1111-1111-1111-111111111111',
        'staff',
        '11111111-1111-1111-1111-111111111111',
        now() + interval '7 days'
    ),
    (
        'aaaaaaaa-3333-3333-3333-333333333333',
        'A-XORG1',
        'a1111111-1111-1111-1111-111111111111',
        'staff',
        '11111111-1111-1111-1111-111111111111',
        now() + interval '7 days'
    ),
    (
        'aaaaaaaa-4444-4444-4444-444444444444',
        'A-USED1',
        'a1111111-1111-1111-1111-111111111111',
        'staff',
        '11111111-1111-1111-1111-111111111111',
        now() + interval '7 days'
    );

UPDATE public.organization_invites
   SET used_at = now(),
       used_by = '33333333-3333-3333-3333-333333333333'
 WHERE id = 'aaaaaaaa-4444-4444-4444-444444444444';

SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT is(
    public.revoke_org_invite(
        'a1111111-1111-1111-1111-111111111111',
        'aaaaaaaa-1111-1111-1111-111111111111'
    ),
    'aaaaaaaa-1111-1111-1111-111111111111'::uuid,
    'Org A admin can revoke an unused invite through the RPC'
);

SELECT is(
    (
        SELECT count(*)
          FROM public.organization_invites
         WHERE id = 'aaaaaaaa-1111-1111-1111-111111111111'
    )::integer,
    0,
    'revoked invite row is deleted'
);

SELECT is(
    (
        SELECT count(*)
          FROM public.audit_log
         WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
           AND action = 'settings.updated'
           AND resource_type = 'organization_invite'
           AND resource_id = 'aaaaaaaa-1111-1111-1111-111111111111'
           AND metadata->>'operation' = 'revoke'
    )::integer,
    1,
    'revoking an invite writes one settings audit row'
);

SELECT is(
    (
        SELECT count(*)
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = 'organization_invites'
           AND policyname = 'Invites: admins delete unused'
    )::integer,
    0,
    'direct admin delete policy is removed'
);

SELECT throws_ok(
    $$
        SELECT public.revoke_org_invite(
            'a1111111-1111-1111-1111-111111111111',
            'aaaaaaaa-4444-4444-4444-444444444444'
        )
    $$,
    '22023',
    NULL,
    'used invites cannot be revoked'
);

SELECT is(
    (
        SELECT count(*)
          FROM public.organization_invites
         WHERE id = 'aaaaaaaa-4444-4444-4444-444444444444'
           AND used_at IS NOT NULL
    )::integer,
    1,
    'used invite remains after rejected revoke'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';

SELECT throws_ok(
    $$
        SELECT public.revoke_org_invite(
            'a1111111-1111-1111-1111-111111111111',
            'aaaaaaaa-2222-2222-2222-222222222222'
        )
    $$,
    '42501',
    NULL,
    'a signed-in non-member cannot revoke invites'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';

SELECT throws_ok(
    $$
        SELECT public.revoke_org_invite(
            'b2222222-2222-2222-2222-222222222222',
            'aaaaaaaa-3333-3333-3333-333333333333'
        )
    $$,
    '42501',
    NULL,
    'Org B admin cannot revoke an Org A invite by passing Org B'
);

SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';

SELECT throws_ok(
    $$
        SELECT public.revoke_org_invite(
            'a1111111-1111-1111-1111-111111111111',
            'aaaaaaaa-9999-9999-9999-999999999999'
        )
    $$,
    '22023',
    NULL,
    'missing invite ids are rejected'
);

SELECT * FROM finish();
ROLLBACK;
