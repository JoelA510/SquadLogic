-- Smoke checks for 20260920000000_publication_baselines.sql
--
-- Assertions RAISE; the NOTICEs are evidence of how much each one examined.
-- See 20260906000000_smoke.sql for why a smoke made of bare SELECTs is not a
-- smoke.
--
-- **Most of this file is behavioural.** `scripts/dbharness/prelude.sql` stubs
-- `auth.uid()` from `request.jwt.claim.sub`, so this seeds an organisation and
-- an admin, assumes their identity, and calls the real RPC -- the route
-- `20260910000000_smoke.sql` established. A structural check could not tell a
-- writer that validates from one that does not, and the validation is most of
-- what this migration is.
--
-- **Every refusal below is paired with the acceptance that proves the guard
-- discriminates.** A validator that returned a problem for everything would
-- satisfy fourteen refusal assertions and be useless; section 4 therefore
-- asserts the good document returns NULL *first*, and counts the refusals it
-- got so a validator that stopped refusing is as loud as one that refuses
-- everything.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The table exists, RLS is on, and nothing can write through it
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_rls boolean;
    v_write text[];
    v_select text[];
    v_missing text[];
BEGIN
    IF to_regclass('public.publication_baselines') IS NULL THEN
        RAISE EXCEPTION 'public.publication_baselines does not exist; GAP-29 has no store';
    END IF;

    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'publication_baselines';
    IF NOT v_rls THEN
        RAISE EXCEPTION 'publication_baselines does not have ROW LEVEL SECURITY enabled';
    END IF;

    -- **Write policies are enumerated from pg_policy, not from the migration
    -- text.** The claim "writes go only through the RPC" is false the instant
    -- any later migration adds an INSERT/UPDATE/DELETE/ALL policy here, and a
    -- grep of this file's own source could never see that.
    SELECT array_agg(polname ORDER BY polname) INTO v_write
      FROM pg_policy
     WHERE polrelid = 'public.publication_baselines'::regclass
       AND polcmd <> 'r';
    IF v_write IS NOT NULL THEN
        RAISE EXCEPTION
            'publication_baselines carries write policies %; the table must be writable only through admin_publish_schedule_baseline()', v_write;
    END IF;

    SELECT array_agg(polname ORDER BY polname) INTO v_select
      FROM pg_policy
     WHERE polrelid = 'public.publication_baselines'::regclass
       AND polcmd = 'r';
    -- The positive control for the line above: a relid that resolved to the
    -- wrong table, or a polcmd spelling that matched nothing, would report "no
    -- write policies" having read no policies at all.
    IF v_select IS NULL OR array_length(v_select, 1) <> 1 THEN
        RAISE EXCEPTION
            'expected exactly one SELECT policy on publication_baselines, found %', v_select;
    END IF;

    -- And it is scoped by organisation rather than open.
    IF NOT EXISTS (
        SELECT 1 FROM pg_policy
         WHERE polrelid = 'public.publication_baselines'::regclass
           AND polcmd = 'r'
           AND pg_get_expr(polqual, polrelid) ILIKE '%is_org_member%'
           AND pg_get_expr(polqual, polrelid) ILIKE '%organization_id%'
    ) THEN
        RAISE EXCEPTION
            'the SELECT policy on publication_baselines is not scoped by is_org_member(organization_id): %',
            (SELECT pg_get_expr(polqual, polrelid) FROM pg_policy
              WHERE polrelid = 'public.publication_baselines'::regclass AND polcmd = 'r');
    END IF;

    -- The columns the reader and the writer both depend on.
    SELECT array_agg(c) INTO v_missing
      FROM unnest(ARRAY[
          'organization_id', 'baseline_version', 'document_version', 'snapshot_id',
          'label', 'channel', 'published_at', 'published_by', 'notes',
          'export_columns', 'export_rows', 'row_count', 'digest'
      ]) AS c
     WHERE NOT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'publication_baselines'
            AND column_name = c
     );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'publication_baselines is missing column(s) %', v_missing;
    END IF;

    -- `published_at` is TEXT on purpose (GAP-30). A later migration
    -- "tidying" it to timestamptz would attach this server's offset to a
    -- stamp that carries none, which is the whole defect the column comment
    -- describes.
    IF (SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'publication_baselines'
           AND column_name = 'published_at') <> 'text' THEN
        RAISE EXCEPTION
            'publication_baselines.published_at is not text; a naive wall stamp in a timestamptz acquires this server timezone (GAP-30)';
    END IF;

    RAISE NOTICE 'publication_baselines: RLS on, 1 SELECT policy scoped by is_org_member, 0 write policies, 13 named columns present';
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. The two functions are hardened, and anon cannot execute either
-- ---------------------------------------------------------------------------
--
-- **Resolved by name from pg_proc, never by a signature literal.**
-- `20260913000000`'s smoke recorded why: a stale signature string raises
-- `undefined_function` out of `regprocedure` *before* the privilege check
-- runs, so the section silently stops testing what it names the moment the
-- function's arity changes.
DO $$
DECLARE
    v_name text;
    v_oid oid;
    v_n int;
    v_def text;
    v_secdef boolean;
    v_config text[];
    v_checked int := 0;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'admin_publish_schedule_baseline', 'publication_baseline_document_problem'
    ] LOOP
        SELECT count(*), max(p.oid) INTO v_n, v_oid
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = v_name;

        -- The meta-assertion: `has_function_privilege(role, NULL, ...)` is
        -- NULL and `IF NULL THEN` does not fire, so a missing function would
        -- make both privilege checks below pass in silence. A second overload
        -- would mean only one of the two was examined.
        IF v_n <> 1 THEN
            RAISE EXCEPTION 'expected exactly one public.%, found %', v_name, v_n;
        END IF;

        IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION
                'anon can EXECUTE %; a definer function that writes organisation state must not be reachable anonymously (LESSONS_LEARNED #5)', v_name;
        END IF;
        IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'PUBLIC can EXECUTE %', v_name;
        END IF;
        IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION
                'authenticated cannot EXECUTE %; the Exports panel would fail for every admin', v_name;
        END IF;
        v_checked := v_checked + 1;
    END LOOP;

    -- A loop that ran zero times would have asserted nothing at all.
    IF v_checked <> 2 THEN
        RAISE EXCEPTION 'the grant loop examined % function(s), expected 2', v_checked;
    END IF;

    SELECT p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
      INTO v_secdef, v_config, v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'admin_publish_schedule_baseline';

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'admin_publish_schedule_baseline must be SECURITY DEFINER';
    END IF;
    IF v_config IS NULL OR NOT (v_config && ARRAY['search_path=public']) THEN
        RAISE EXCEPTION
            'admin_publish_schedule_baseline must SET search_path = public (LESSONS_LEARNED #1)';
    END IF;
    IF v_def NOT LIKE '%is_org_admin%' THEN
        RAISE EXCEPTION 'admin_publish_schedule_baseline does not gate on is_org_admin()';
    END IF;
    IF v_def NOT LIKE '%record_audit_event%' THEN
        RAISE EXCEPTION
            'admin_publish_schedule_baseline does not audit (CLAUDE.md: audit immutability)';
    END IF;
    IF v_def NOT LIKE '%publication_baseline_document_problem%' THEN
        RAISE EXCEPTION
            'admin_publish_schedule_baseline does not re-validate the document server-side; it would be trusting the client Zod pass';
    END IF;

    RAISE NOTICE 'both functions: exactly one overload each, no anon and no PUBLIC EXECUTE, authenticated granted; the writer is SECURITY DEFINER, search_path-pinned, admin-gated, auditing and re-validating';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The audit action is registered
-- ---------------------------------------------------------------------------
--
-- `audit_log.action` is an FK to `audit_actions` since 20260613000006. An
-- unregistered action does not fail the migration; it fails the first
-- publication, at runtime, after the RPC has already done its work
-- (LESSONS_LEARNED #5).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.audit_actions WHERE action = 'publication.baseline_recorded'
    ) THEN
        RAISE EXCEPTION
            'publication.baseline_recorded is not registered in audit_actions; every publication would fail on the audit FK';
    END IF;
    -- Positive control: the lookup can see a row that is certainly there, so a
    -- table rename cannot make the check above pass by reading nothing.
    IF NOT EXISTS (SELECT 1 FROM public.audit_actions WHERE action = 'settings.updated') THEN
        RAISE EXCEPTION 'the audit_actions lookup cannot see settings.updated either; it is matching nothing';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. The validator, driven with one good document and fourteen corruptions
-- ---------------------------------------------------------------------------
--
-- This is `PublicationSnapshotDocumentSchema`'s SQL half, and it is the only
-- part of the writer a caller without an admin session can reach. Each case
-- names the corruption and the substring the refusal must contain, so a
-- validator that refused everything with one generic message would fail the
-- `expected` match rather than pass fourteen assertions.
DO $$
DECLARE
    v_good jsonb;
    v_case record;
    v_problem text;
    v_refused int := 0;
BEGIN
    v_good := jsonb_build_object(
        'version', 1,
        'snapshotId', 'smoke-baseline-1',
        'label', 'Smoke master schedule',
        'channel', 'smoke',
        'publishedAt', '2026-09-20T09:00:00',
        'publishedBy', 'smoke-actor',
        'notes', NULL,
        'columns', jsonb_build_array('Start', 'Field'),
        'rows', jsonb_build_array(
            jsonb_build_object('Start', '2026-09-26T09:00:00', 'Field', 'pitch-1'),
            jsonb_build_object('Start', '2026-09-26T10:30:00', 'Field', 'pitch-2')
        ),
        'digest', '0123456789abcdef'
    );

    -- **The acceptance first.** Everything below is a refusal, and refusals
    -- from a validator that says no to everything prove nothing.
    v_problem := public.publication_baseline_document_problem(v_good);
    IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION
            'the validator refused a sound document: %. Every refusal assertion below would then be passing for the wrong reason.',
            v_problem;
    END IF;

    FOR v_case IN
        SELECT * FROM (VALUES
            ('not an object',        to_jsonb('nope'::text),                      'must be a JSON object'),
            ('an extra key',         v_good || jsonb_build_object('extra', 1),    'strict'),
            ('a missing key',        v_good - 'channel',                          'strict'),
            ('a future version',     jsonb_set(v_good, '{version}', to_jsonb(2)), 'version 1'),
            ('an empty label',       jsonb_set(v_good, '{label}', to_jsonb(' '::text)), 'label must be a non-empty string'),
            ('a numeric snapshotId', jsonb_set(v_good, '{snapshotId}', to_jsonb(7)),    'snapshotId must be a non-empty string'),
            ('a short digest',       jsonb_set(v_good, '{digest}', to_jsonb('abc'::text)), 'lowercase hex'),
            ('an uppercase digest',  jsonb_set(v_good, '{digest}', to_jsonb('0123456789ABCDEF'::text)), 'lowercase hex'),
            ('a zoned publishedAt',  jsonb_set(v_good, '{publishedAt}', to_jsonb('2026-09-20T09:00:00Z'::text)), 'naive'),
            ('an empty notes',       jsonb_set(v_good, '{notes}', to_jsonb(''::text)), 'notes must be null'),
            ('no rows',              jsonb_set(v_good, '{rows}', '[]'::jsonb),    'non-empty array'),
            ('a row missing a declared column',
                                     jsonb_set(v_good, '{rows}', jsonb_build_array(
                                         jsonb_build_object('Start', '2026-09-26T09:00:00'))), 'declares columns'),
            ('a row with a numeric cell',
                                     jsonb_set(v_good, '{rows}', jsonb_build_array(
                                         jsonb_build_object('Start', '2026-09-26T09:00:00', 'Field', 3))), 'non-string cell'),
            ('a duplicate column',   jsonb_set(v_good, '{columns}', jsonb_build_array('Start', 'Start')), 'duplicate')
        ) AS t(what, document, expected)
    LOOP
        v_problem := public.publication_baseline_document_problem(v_case.document);
        IF v_problem IS NULL THEN
            RAISE EXCEPTION 'the validator accepted a document with %', v_case.what;
        END IF;
        IF position(v_case.expected IN v_problem) = 0 THEN
            RAISE EXCEPTION
                'the validator refused "%" but not for the stated reason: expected a message containing %L, got %L',
                v_case.what, v_case.expected, v_problem;
        END IF;
        v_refused := v_refused + 1;
    END LOOP;

    -- A `FOR ... IN SELECT` over an empty VALUES list runs zero times and
    -- asserts nothing; this is the count that makes that visible.
    IF v_refused <> 14 THEN
        RAISE EXCEPTION 'the validator was driven with % corruption(s), expected 14', v_refused;
    END IF;

    RAISE NOTICE 'document validator: 1 sound document accepted, % corruptions refused, each with its stated reason', v_refused;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The RPC, end to end, as a real admin -- and refused for everybody else
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_org uuid;
    v_other uuid;
    v_admin uuid := gen_random_uuid();
    v_member uuid := gen_random_uuid();
    v_doc jsonb;
    v_res jsonb;
    v_row public.publication_baselines%ROWTYPE;
    v_audits int;
    v_phases text[];
    v_refused boolean;
BEGIN
    -- `raw_user_meta_data.password_length` is required by
    -- `check_password_length_on_auth_users()`; without it the seed is refused
    -- and the whole section fails for a reason that has nothing to do with
    -- baselines. `20260910000000_smoke.sql` seeds the same way.
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (v_admin, 'baseline-admin@example.test',
              jsonb_build_object('password_length', 16))
      ON CONFLICT DO NOTHING;
    INSERT INTO auth.users (id, email, raw_user_meta_data)
      VALUES (v_member, 'baseline-member@example.test',
              jsonb_build_object('password_length', 16))
      ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, email) VALUES (v_admin, 'baseline-admin@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, email) VALUES (v_member, 'baseline-member@example.test')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.organizations (name, slug)
      VALUES ('Smoke Org GAP-29', 'smoke-org-gap29') RETURNING id INTO v_org;
    INSERT INTO public.organizations (name, slug)
      VALUES ('Smoke Org GAP-29 other', 'smoke-org-gap29-other') RETURNING id INTO v_other;
    INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES (v_org, v_admin, 'admin');
    INSERT INTO public.organization_members (organization_id, profile_id, role)
      VALUES (v_org, v_member, 'coach');

    v_doc := jsonb_build_object(
        'version', 1,
        'snapshotId', 'smoke-week-1',
        'label', 'Master schedule, week 1',
        'channel', 'exports-panel',
        'publishedAt', '2026-09-20T09:00:00',
        'publishedBy', v_admin::text,
        'notes', NULL,
        'columns', jsonb_build_array('Start', 'Field'),
        'rows', jsonb_build_array(
            jsonb_build_object('Start', '2026-09-26T09:00:00', 'Field', 'pitch-1')
        ),
        'digest', 'fedcba9876543210'
    );

    -- ---- 5a. anonymous: refused -------------------------------------------
    PERFORM set_config('request.jwt.claim.sub', '', true);
    v_refused := false;
    BEGIN
        PERFORM public.admin_publish_schedule_baseline(v_org, v_doc);
    EXCEPTION WHEN insufficient_privilege THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'an unauthenticated caller published a baseline';
    END IF;

    -- ---- 5b. a member who is not an admin: refused ------------------------
    PERFORM set_config('request.jwt.claim.sub', v_member::text, true);
    v_refused := false;
    BEGIN
        PERFORM public.admin_publish_schedule_baseline(v_org, v_doc);
    EXCEPTION WHEN insufficient_privilege THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'a non-admin member published a baseline';
    END IF;

    -- ---- 5c. an admin of a DIFFERENT organisation: refused ----------------
    --
    -- The definer function bypasses RLS, so this is the cross-tenant write the
    -- body's own `is_org_admin(p_organization_id)` has to stop. Without it an
    -- admin anywhere could plant a baseline in anybody's organisation.
    PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
    v_refused := false;
    BEGIN
        PERFORM public.admin_publish_schedule_baseline(v_other, v_doc);
    EXCEPTION WHEN insufficient_privilege THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'an admin of one organisation published into another';
    END IF;

    -- ---- 5d. the admin of this organisation: accepted ---------------------
    v_res := public.admin_publish_schedule_baseline(v_org, v_doc);
    IF v_res IS NULL OR (v_res->>'id') IS NULL THEN
        RAISE EXCEPTION 'admin_publish_schedule_baseline returned no readable result';
    END IF;
    IF (v_res->>'baseline_version')::int <> 1 THEN
        RAISE EXCEPTION 'the first baseline of an organisation is version %, expected 1',
            v_res->>'baseline_version';
    END IF;

    SELECT * INTO v_row FROM public.publication_baselines WHERE id = (v_res->>'id')::uuid;
    IF v_row.row_count <> 1 OR v_row.digest <> 'fedcba9876543210'
       OR v_row.published_at <> '2026-09-20T09:00:00' THEN
        RAISE EXCEPTION 'the stored baseline does not match the document that was sent: %', to_jsonb(v_row);
    END IF;
    IF v_row.recorded_by <> v_admin THEN
        RAISE EXCEPTION 'recorded_by is % rather than the publishing admin', v_row.recorded_by;
    END IF;
    -- The payload survived the round trip through jsonb intact.
    IF v_row.export_rows->0->>'Field' <> 'pitch-1' THEN
        RAISE EXCEPTION 'the stored rows are not the rows that were sent: %', v_row.export_rows;
    END IF;

    -- ---- 5e. the audit pair -----------------------------------------------
    SELECT count(*), array_agg(metadata->>'phase' ORDER BY metadata->>'phase')
      INTO v_audits, v_phases
      FROM public.audit_log
     WHERE organization_id = v_org
       AND action = 'publication.baseline_recorded';
    IF v_audits <> 2 OR v_phases IS DISTINCT FROM ARRAY['after', 'before'] THEN
        RAISE EXCEPTION
            'expected a before/after audit pair for one publication, found % row(s) with phases %',
            v_audits, v_phases;
    END IF;

    -- ---- 5f. the version increments, and the snapshot id cannot repeat ----
    v_res := public.admin_publish_schedule_baseline(
        v_org, jsonb_set(v_doc, '{snapshotId}', to_jsonb('smoke-week-2'::text)));
    IF (v_res->>'baseline_version')::int <> 2 THEN
        RAISE EXCEPTION 'the second baseline is version %, expected 2', v_res->>'baseline_version';
    END IF;

    v_refused := false;
    BEGIN
        PERFORM public.admin_publish_schedule_baseline(v_org, v_doc);
    EXCEPTION WHEN unique_violation THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'the same snapshotId was recorded twice in one organisation';
    END IF;

    -- ---- 5g. a corrupt document is refused by the RPC, not only by Zod ----
    v_refused := false;
    BEGIN
        PERFORM public.admin_publish_schedule_baseline(
            v_org, jsonb_set(v_doc, '{digest}', to_jsonb('not-hex'::text)));
    EXCEPTION WHEN invalid_parameter_value THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'the RPC accepted a document with an invalid digest';
    END IF;

    RAISE NOTICE 'admin_publish_schedule_baseline: refused for anon, for a non-admin member and for an admin of another organisation; accepted for the org admin; versions 1 then 2; duplicate snapshotId refused; invalid digest refused; 2 audit rows (before, after)';

    -- ---- 5h. immutability: UPDATE always, DELETE unless the org is going ---
    v_refused := false;
    BEGIN
        UPDATE public.publication_baselines
           SET label = 'rewritten'
         WHERE organization_id = v_org;
    EXCEPTION WHEN feature_not_supported THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'a published baseline was edited in place';
    END IF;

    v_refused := false;
    BEGIN
        DELETE FROM public.publication_baselines WHERE organization_id = v_org;
    EXCEPTION WHEN feature_not_supported THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'a published baseline was deleted while its organisation still existed';
    END IF;

    -- **TRUNCATE, which a row-level trigger cannot see.** Found by
    -- `/code-review`: `publication_baselines_immutable` is `FOR EACH ROW`, so
    -- before `publication_baselines_no_truncate` existed one statement from
    -- the table owner emptied the store with the append-only guarantee
    -- standing.
    v_refused := false;
    BEGIN
        TRUNCATE public.publication_baselines;
    EXCEPTION WHEN feature_not_supported THEN
        v_refused := true;
    END;
    IF NOT v_refused THEN
        RAISE EXCEPTION 'TRUNCATE emptied publication_baselines; the append-only guarantee is row-level only';
    END IF;
    -- The positive control for the line above: the rows are still there, so
    -- the refusal is a refusal rather than a TRUNCATE that ran on nothing.
    IF (SELECT count(*) FROM public.publication_baselines WHERE organization_id = v_org) <> 2 THEN
        RAISE EXCEPTION 'expected the 2 baselines to survive the refused TRUNCATE';
    END IF;

    -- The other arm, and the reason it exists: an organisation that has ever
    -- published must still be deletable. Without the cascade clause in
    -- `refuse_publication_baseline_mutation()` this DELETE raises and tenant
    -- offboarding is broken by the immutability rule.
    DELETE FROM public.organizations WHERE id IN (v_org, v_other);
    IF EXISTS (SELECT 1 FROM public.publication_baselines WHERE organization_id = v_org) THEN
        RAISE EXCEPTION 'the baselines outlived their organisation';
    END IF;

    DELETE FROM public.profiles WHERE id IN (v_admin, v_member);
    DELETE FROM auth.users WHERE id IN (v_admin, v_member);

    RAISE NOTICE 'immutability: UPDATE refused, direct DELETE refused, TRUNCATE refused with both rows surviving, organisation DELETE cascaded cleanly (so offboarding still works); smoke estate removed';
END;
$$;
