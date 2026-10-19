-- Behavioral verification for 20261019010000_submit_registration_throttle.sql
-- (DS-5): one caller may register ten times to one form in a minute; the
-- eleventh is refused PT429, per caller and per form, as a signed-in member
-- (the role PostgREST gives the public registration route's callers).

BEGIN;

\set squadlogic_fixture_include 1
\ir _fixtures.sql

SELECT plan(6);

INSERT INTO public.registration_forms (id, organization_id, title, status, division_id) VALUES
    ('e0000019-0000-0000-0000-0000000000a1', 'a1111111-1111-1111-1111-111111111111',
     'Throttle form one', 'open', 'a1111111-1111-1111-1111-11111111abcd'),
    ('e0000019-0000-0000-0000-0000000000a2', 'a1111111-1111-1111-1111-111111111111',
     'Throttle form two', 'open', 'a1111111-1111-1111-1111-11111111abcd');

-- 1. Charlie (a coach: any org member may register) submits ten times.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT lives_ok(
    $$ DO $do$
       BEGIN
         FOR i IN 1..10 LOOP
           PERFORM public.submit_registration(
             'a1111111-1111-1111-1111-111111111111'::uuid,
             'e0000019-0000-0000-0000-0000000000a1'::uuid,
             '33333333-3333-3333-3333-333333333333'::uuid,
             '{}'::jsonb, NULL, 'Child' || i, 'Throttle');
         END LOOP;
       END
       $do$ $$,
    'ten registrations to one form in a minute succeed'
);

-- 2. The eleventh is refused PT429.
SELECT throws_ok(
    $$ SELECT public.submit_registration(
         'a1111111-1111-1111-1111-111111111111'::uuid,
         'e0000019-0000-0000-0000-0000000000a1'::uuid,
         '33333333-3333-3333-3333-333333333333'::uuid,
         '{}'::jsonb, NULL, 'Child11', 'Throttle') $$,
    'PT429',
    'Too many registrations submitted for this form. Wait a minute and try again.',
    'the eleventh registration to the form is refused PT429'
);

-- 3. The same caller on the second form is not throttled.
SELECT lives_ok(
    $$ SELECT public.submit_registration(
         'a1111111-1111-1111-1111-111111111111'::uuid,
         'e0000019-0000-0000-0000-0000000000a2'::uuid,
         '33333333-3333-3333-3333-333333333333'::uuid,
         '{}'::jsonb, NULL, 'Other', 'Form') $$,
    'the same member on a second form is not throttled'
);
RESET role;

-- 4. The refusal wrote nothing: ten registrations on form one, one on form two.
SELECT is(
    (SELECT count(*) FROM public.registrations
      WHERE profile_id = '33333333-3333-3333-3333-333333333333'),
    11::bigint,
    'the refused call wrote no registration (10 on form one, 1 on form two)'
);

-- 5. A second member (Alice) on the throttled form is not throttled.
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"11111111-1111-1111-1111-111111111111"}';
SELECT lives_ok(
    $$ SELECT public.submit_registration(
         'a1111111-1111-1111-1111-111111111111'::uuid,
         'e0000019-0000-0000-0000-0000000000a1'::uuid,
         '11111111-1111-1111-1111-111111111111'::uuid,
         '{}'::jsonb, NULL, 'Alice', 'Child') $$,
    'a second member on the throttled form is not throttled'
);
RESET role;

-- 6. Registrations older than the window no longer count.
UPDATE public.registrations
   SET created_at = timezone('utc', now()) - interval '61 seconds'
 WHERE profile_id = '33333333-3333-3333-3333-333333333333';
SET LOCAL role = 'authenticated';
SET LOCAL "request.jwt.claims" TO '{"sub":"33333333-3333-3333-3333-333333333333"}';
SELECT lives_ok(
    $$ SELECT public.submit_registration(
         'a1111111-1111-1111-1111-111111111111'::uuid,
         'e0000019-0000-0000-0000-0000000000a1'::uuid,
         '33333333-3333-3333-3333-333333333333'::uuid,
         '{}'::jsonb, NULL, 'After', 'Window') $$,
    'registrations older than 60 seconds no longer count toward the throttle'
);
RESET role;

SELECT * FROM finish();
ROLLBACK;
