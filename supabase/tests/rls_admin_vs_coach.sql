-- RLS invariant: `audit_log` is readable by org admins but NOT by a signed-in
-- user who is not a member (Charlie, who was a coach member of Org A until
-- 20261104010000 removed the coach role). The audit trail often contains security-sensitive
-- metadata (who invited whom, settings changes, export events) and must
-- stay gated to org admins.
--
-- Exercises: `audit_log` SELECT policy — is_org_member AND role = 'admin'
-- sub-check on organization_members.

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(2);

SET LOCAL role = 'authenticated';

-- Alice is admin of Org A → should see at least one audit_log row.
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT ok(
    (SELECT COUNT(*) FROM public.audit_log) > 0,
    'Alice (admin of Org A) can read audit_log'
);

-- Charlie is signed in and a member of no organization → zero audit_log rows.
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT is(
    (SELECT COUNT(*) FROM public.audit_log)::int,
    0,
    'Charlie (coach of Org A) cannot read audit_log'
);

SELECT * FROM finish();
ROLLBACK;
