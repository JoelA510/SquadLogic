-- pgTAP: redeeming an invite code writes its audit row (migration
-- 20261029020000).
--
-- `redeem_org_invite` audits the join as `members.invited_joined`, and
-- `audit_log.action` is a foreign key to `audit_actions` (20260613000006).
-- The action was never registered, so the audit insert failed with 23503 and
-- rolled back the whole redemption: nobody could join an organization with an
-- invite code. Bob, an admin of Org B and no member of Org A, redeems an
-- invite Alice (admin of Org A) minted, as the `authenticated` role the app
-- calls it with.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(7);

SELECT ok(
    EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'members.invited_joined'),
    'members.invited_joined is a registered audit action'
);

-- Alice mints a coach invite for Org A. The code is kept in a table the test
-- role may write, because the `authenticated` role cannot create one.
CREATE TEMP TABLE minted (code text);
GRANT ALL ON minted TO authenticated;
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
INSERT INTO minted
    SELECT code FROM public.create_org_invite('a1111111-1111-1111-1111-111111111111', 'coach');

-- Bob redeems it.
SET LOCAL "request.jwt.claims" TO '{"sub":"22222222-2222-2222-2222-222222222222"}';
SELECT is(
    (SELECT public.redeem_org_invite(code) FROM minted),
    'a1111111-1111-1111-1111-111111111111'::uuid,
    'the invite redeems and returns the invited organization'
);
RESET role;

SELECT is(
    (SELECT role FROM public.organization_members
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND profile_id = '22222222-2222-2222-2222-222222222222'),
    'coach',
    'the redeemer joined Org A with the invited role'
);

SELECT is(
    (SELECT used_by FROM public.organization_invites WHERE code = (SELECT code FROM minted)),
    '22222222-2222-2222-2222-222222222222'::uuid,
    'the invite is consumed by the redeemer'
);

SELECT is(
    (SELECT count(*) FROM public.audit_log
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action = 'members.invited_joined'),
    1::bigint,
    'the redemption left exactly one members.invited_joined audit row'
);

SELECT is(
    (SELECT user_id FROM public.audit_log
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action = 'members.invited_joined'),
    '22222222-2222-2222-2222-222222222222'::uuid,
    'the audit row is attributed to the redeemer'
);

SELECT is(
    (SELECT metadata->>'role' FROM public.audit_log
      WHERE organization_id = 'a1111111-1111-1111-1111-111111111111'
        AND action = 'members.invited_joined'),
    'coach',
    'the audit row records the invited role'
);

SELECT * FROM finish();
ROLLBACK;
