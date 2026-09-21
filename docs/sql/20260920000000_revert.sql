-- Revert for 20260920000000_publication_baselines.sql
--
-- **Every behaviour this undoes, named**, because a revert whose costs are not
-- written down is a revert nobody can weigh.
--
--   1. **Publishing a baseline stops working, loudly.**
--      `admin_publish_schedule_baseline()` is dropped.
--      `frontend/src/hooks/usePublicationBaselines.js` calls it by name, so
--      after this revert the Exports panel's "Record published baseline"
--      action raises `42883 undefined_function` on every press unless the
--      frontend is reverted with it. That is deliberate and it is the same
--      reading `20260913000000`'s revert takes: a silent no-op is how an
--      unpersisted publication went unnoticed for two whole phases, and
--      re-creating a silent no-op is worse than a visible error.
--   2. **Parity against a stored baseline stops working, also loudly.** The
--      reader SELECTs `publication_baselines`, which is dropped below, so the
--      panel's parity section reports a read error rather than an empty list.
--      An empty list would say "you have never published", which is a
--      different and false statement.
--   3. **THE STORED BASELINES ARE DESTROYED.** This is the one cost that is
--      not recoverable, and it is why the count is printed before the DROP.
--      `publication_baselines` is append-only by trigger and holds the only
--      durable copy of what was published -- incident 1 is precisely the
--      situation where that copy is the last thing standing. If any row
--      exists, take a dump of the table before running this file. There is no
--      "keep the data, drop the writer" variant, because the table is the
--      feature: a store nothing can write and nothing reads is the hollow
--      shape this work exists to end.
--   4. **The audit rows are NOT deleted and the audit action is NOT
--      unregistered.** `audit_log` rows citing
--      `publication.baseline_recorded` stay exactly where they are: an audit
--      trail a revert can edit is not an audit trail (CLAUDE.md, audit
--      immutability). The `audit_actions` row therefore has to stay too --
--      it is the FK target for every one of those rows, and deleting it would
--      either fail on the constraint or, worse, cascade history away.
--
-- Order matters below: the trigger function cannot be dropped while the
-- trigger references it, and the trigger goes with the table.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 0. Say what is about to be destroyed, before destroying it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_rows bigint := 0;
    v_orgs bigint := 0;
BEGIN
    IF to_regclass('public.publication_baselines') IS NULL THEN
        RAISE NOTICE 'publication_baselines does not exist; nothing to destroy.';
        RETURN;
    END IF;

    SELECT count(*), count(DISTINCT organization_id)
      INTO v_rows, v_orgs
      FROM public.publication_baselines;

    IF v_rows = 0 THEN
        RAISE NOTICE 'publication_baselines holds 0 baselines; this revert destroys no operator data.';
    ELSE
        RAISE WARNING
            'this revert DESTROYS % published baseline(s) across % organisation(s). They are the only durable copy of what was published. Dump the table first if that matters.',
            v_rows, v_orgs;
    END IF;
END;
$$;

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The writer and the validator.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_publish_schedule_baseline(uuid, jsonb);
DROP FUNCTION IF EXISTS public.publication_baseline_document_problem(jsonb);

-- ---------------------------------------------------------------------------
-- 2. The table, its policy, its index and its trigger.
-- ---------------------------------------------------------------------------
--
-- The policy and the index go with the table; naming the policy anyway costs
-- nothing and keeps this file readable as a list of what existed.
DROP POLICY IF EXISTS "Publication baselines: members select" ON public.publication_baselines;
DROP TABLE IF EXISTS public.publication_baselines;

-- Only now, with no triggers referring to them.
DROP FUNCTION IF EXISTS public.refuse_publication_baseline_mutation();
DROP FUNCTION IF EXISTS public.refuse_publication_baseline_truncate();

COMMIT;

-- ---------------------------------------------------------------------------
-- 3. Prove the revert actually reverted.
-- ---------------------------------------------------------------------------
--
-- A revert that silently matched nothing is the failure `docs/sql/reverts/
-- 20260504060000` was fixed for: a `DROP FUNCTION IF EXISTS` with a stale
-- signature reports success over a function still standing. These assertions
-- look the objects up by name rather than by signature, so a future arity
-- change cannot make them pass by looking at nothing.
DO $$
DECLARE
    v_left text[];
BEGIN
    SELECT array_agg(p.proname ORDER BY p.proname)
      INTO v_left
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
           'admin_publish_schedule_baseline',
           'publication_baseline_document_problem',
           'refuse_publication_baseline_mutation',
           'refuse_publication_baseline_truncate'
       );

    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION 'revert left % behind', v_left;
    END IF;

    IF to_regclass('public.publication_baselines') IS NOT NULL THEN
        RAISE EXCEPTION 'revert left public.publication_baselines behind';
    END IF;

    -- The positive control for the two checks above: they resolve names the
    -- way the harness does, so prove the mechanism can still SEE a function
    -- and a table that really are there. Without this, a typo in either
    -- lookup would report a clean revert over an untouched database.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'is_org_admin'
    ) THEN
        RAISE EXCEPTION 'the function lookup found neither the dropped functions nor is_org_admin; it is matching nothing';
    END IF;
    IF to_regclass('public.audit_log') IS NULL THEN
        RAISE EXCEPTION 'the table lookup cannot see public.audit_log either; it is matching nothing';
    END IF;

    RAISE NOTICE 'revert verified: table, writer, validator and both trigger functions all gone; audit history and the registered action left intact.';
END;
$$;
