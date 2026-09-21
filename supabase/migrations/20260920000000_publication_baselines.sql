-- GAP-29 Stage 2: the store for a published schedule baseline.
--
-- > *"Recovery was only possible by re-importing the published schedule and
-- > treating it as ground truth."* -- incident 1
--
-- `packages/core/src/publication/` has been able to freeze a published
-- artifact since Prompt 6.2 and has had nowhere to put it: every snapshot
-- emits `SNAPSHOT_IN_MEMORY_ONLY` and dies with the browser tab. This file is
-- the durable half. It lands with its writer (`OutputGenerationPanel`'s
-- publish path, through `frontend/src/hooks/usePublicationBaselines.js`) and
-- its reader (the same panel's parity section, through `checkParity()`), for
-- the reason `docs/PHASE_8_PROGRESS.md` records twice over: a store nothing
-- reads is a table-shaped hollow guarantee.
--
-- ## The durable version identifier is the point, not a convenience
--
-- `baseline_version` is a per-organisation monotonic integer assigned here and
-- nowhere else. GAP-29's "what remains" names it in as many words -- *"no
-- published-baseline version, so `moved since publication v3` is still not a
-- question the model can answer"*. `snapshot_id` is the caller's own opaque
-- label and is unique per organisation, but it is the caller's; the version is
-- the store's.
--
-- ## Why the document goes in as one jsonb rather than as exploded arguments
--
-- The four facility RPCs and `admin_create_field_blackout` take exploded
-- arguments because a blackout is eight scalars. A publication baseline is a
-- `PublicationSnapshotDocumentSchema` value -- a version-stamped document whose
-- payload is N rows of M columns -- and `packages/core/src/publication/
-- serialise.js` already validates that shape in both directions. Exploding it
-- would mean a second statement of the same schema in the argument list, which
-- is the drift this repository keeps paying for. The document is instead
-- validated **again** here, by `publication_baseline_document_problem()`, so
-- the database is not trusting the client's Zod pass.
--
-- ## Immutability is structural
--
-- A baseline whose rows can be edited after the fact is incident 1 with a
-- primary key. `digest` is checked on every read by `readPublicationSnapshot()`
-- and would catch the edit -- but catching it is worse than refusing it, so
-- `publication_baselines_immutable` refuses UPDATE for **every** role, table
-- owner included, and refuses DELETE too except on the cascade from a deleted
-- organisation; `publication_baselines_no_truncate` closes the one-statement
-- hole a row-level trigger cannot see. Withdrawing a baseline is therefore recording a later one,
-- exactly as the model treats publication. Section 2 states why the DELETE arm
-- has that one exception and what shipping without it would have broken.
--
-- ## Wall-clock text, not timestamptz
--
-- `published_at` is a naive `YYYY-MM-DDTHH:MM:SS` in `text`, matching
-- `PublicationStampSchema` and `field_blackouts`'s minutes-past-midnight
-- reading rather than inventing a third convention. A `timestamptz` column
-- would attach the server's offset to a stamp that carries none, which is the
-- GAP-30 failure in a new column. `recorded_at` IS a `timestamptz`, because it
-- is a real instant this database observed.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The audit action
-- ---------------------------------------------------------------------------
--
-- One-line INSERT, which is the whole point of `20260613000006`'s lookup
-- table. A missing registration makes the RPC fail at runtime on the audit
-- FK, having already written nothing (LESSONS_LEARNED #5).
INSERT INTO public.audit_actions (action)
VALUES ('publication.baseline_recorded')
ON CONFLICT (action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. publication_baselines
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.publication_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- **The durable version.** Assigned by the RPC under an advisory lock, never
  -- by the caller; the RPC has no parameter for it.
  baseline_version integer NOT NULL CHECK (baseline_version >= 1),

  -- `PUBLICATION_SNAPSHOT_DOCUMENT_VERSION`. Stored so a reader can tell a
  -- document it cannot parse from one it can, rather than discovering it in
  -- `PublicationSnapshotDocumentSchema.parse()`'s stack trace.
  document_version integer NOT NULL CHECK (document_version >= 1),

  -- The caller's own label for the artifact. Unique per organisation so
  -- publishing "week-1-final" twice is refused rather than silently doubled.
  snapshot_id text NOT NULL CHECK (length(btrim(snapshot_id)) > 0),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  -- Where it went. The audit trail's *where*.
  channel text NOT NULL CHECK (length(btrim(channel)) > 0),
  -- Naive wall clock, no offset and no Z. See the header.
  published_at text NOT NULL
    CHECK (published_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'),
  -- An actor identifier, not a person's contact details (CLAUDE.md section 2).
  published_by text NOT NULL CHECK (length(btrim(published_by)) > 0),
  notes text CHECK (notes IS NULL OR length(btrim(notes)) > 0),

  -- The document's own two payload fields, under names that are not SQL
  -- keywords in any context. `rows` in particular is reserved in a window
  -- frame clause, and a column you cannot always write unquoted is a column
  -- somebody will eventually quote wrongly.
  export_columns jsonb NOT NULL CHECK (jsonb_typeof(export_columns) = 'array'),
  export_rows jsonb NOT NULL CHECK (jsonb_typeof(export_rows) = 'array'),

  -- `rows.length`, denormalised deliberately: the parity reader lists
  -- baselines before it loads one, and a list that had to pull every row set
  -- out of jsonb to print "679 rows" would read the whole store to render a
  -- dropdown. Checked against the array on write, so the two cannot disagree.
  row_count integer NOT NULL CHECK (row_count >= 1),

  -- `publicationDigest()`: 16 lowercase hex. The stored claim
  -- `readPublicationSnapshot()` recomputes against the rows it read.
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{16}$'),

  recorded_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT publication_baselines_row_count_matches_check
    CHECK (row_count = jsonb_array_length(export_rows)),
  CONSTRAINT publication_baselines_rows_nonempty_check
    CHECK (jsonb_array_length(export_rows) >= 1),
  CONSTRAINT publication_baselines_columns_nonempty_check
    CHECK (jsonb_array_length(export_columns) >= 1),
  CONSTRAINT publication_baselines_version_unique
    UNIQUE (organization_id, baseline_version),
  CONSTRAINT publication_baselines_snapshot_unique
    UNIQUE (organization_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_publication_baselines_org_version
  ON public.publication_baselines (organization_id, baseline_version DESC);

COMMENT ON TABLE public.publication_baselines IS
  'GAP-29: the durable published-schedule baseline. One row per publication, in outputGeneration.js SCHEDULE_EXPORT_COLUMNS vocabulary, written only by admin_publish_schedule_baseline() and never updated or deleted (publication_baselines_immutable). baseline_version is the durable per-organisation version identifier that "has the schedule moved since v3" needs. published_at is a naive wall-clock stamp in text, never an instant.';
COMMENT ON COLUMN public.publication_baselines.baseline_version IS
  'Per-organisation monotonic version, assigned by admin_publish_schedule_baseline() under an advisory lock. Never supplied by a caller.';
COMMENT ON COLUMN public.publication_baselines.published_at IS
  'Naive YYYY-MM-DDTHH:MM:SS wall clock supplied by the publisher. NOT an instant: a timestamptz here would attach this server offset to a stamp carrying none (GAP-30).';

-- ---------------------------------------------------------------------------
-- 2. Immutability, enforced for every role including the owner
-- ---------------------------------------------------------------------------
--
-- **UPDATE is refused unconditionally. DELETE is refused while the owning
-- organisation still exists, and allowed once it does not.** That second
-- clause is not a softening, it is the fix for a defect the first draft of
-- this file shipped: `organization_id` is `ON DELETE CASCADE`, and a trigger
-- that refused every DELETE would have made **deleting an organisation
-- impossible** the moment it had ever published -- a tenant-offboarding
-- failure introduced by an immutability rule. A foreign-key cascade runs as an
-- AFTER DELETE trigger on the parent, so by the time this fires the parent row
-- is already gone and `NOT EXISTS` distinguishes the two cases exactly. Both
-- arms are exercised in `docs/sql/20260920000000_smoke.sql`: a direct DELETE
-- is refused with `0A000`, and deleting the organisation takes its baselines
-- with it.
--
-- Deletion is in any case the detectable half. `baseline_version` is dense and
-- monotonic per organisation, so a removed baseline leaves a hole in the
-- sequence; a silently *edited* one leaves nothing at all, which is why UPDATE
-- has no escape clause.

CREATE OR REPLACE FUNCTION public.refuse_publication_baseline_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
        -- The organisation itself is being removed and this row is going with
        -- it. Nothing is being rewritten; a tenant is leaving.
        RETURN OLD;
    END IF;

    RAISE EXCEPTION
        'publication_baselines is append-only: % on baseline % is refused. A published baseline is what families were actually told; withdraw it by recording a later one.',
        TG_OP, COALESCE(OLD.id::text, '(unknown)')
        USING ERRCODE = '0A000';
END;
$$;

DROP TRIGGER IF EXISTS publication_baselines_immutable ON public.publication_baselines;
CREATE TRIGGER publication_baselines_immutable
  BEFORE UPDATE OR DELETE ON public.publication_baselines
  FOR EACH ROW EXECUTE FUNCTION public.refuse_publication_baseline_mutation();

-- **TRUNCATE does not fire a row-level trigger, and it empties the table.**
-- The guarantee above would therefore have had a hole the width of one
-- statement, reachable by the table owner and by `service_role`. A statement
-- trigger is the only shape that can refuse it, and it has no `OLD` row to
-- reason about, so unlike the DELETE arm there is no cascade exception to
-- make: a `TRUNCATE` is never how an organisation is offboarded.
CREATE OR REPLACE FUNCTION public.refuse_publication_baseline_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    RAISE EXCEPTION
        'publication_baselines is append-only: TRUNCATE is refused. Deleting an organization removes its baselines with it; nothing else may empty this table.'
        USING ERRCODE = '0A000';
END;
$$;

DROP TRIGGER IF EXISTS publication_baselines_no_truncate ON public.publication_baselines;
CREATE TRIGGER publication_baselines_no_truncate
  BEFORE TRUNCATE ON public.publication_baselines
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_publication_baseline_truncate();

COMMENT ON FUNCTION public.refuse_publication_baseline_truncate() IS
  'Trigger body behind publication_baselines_no_truncate. A row-level trigger does not fire on TRUNCATE, so without this the append-only guarantee had a one-statement hole that the table owner and service_role could reach.';

COMMENT ON FUNCTION public.refuse_publication_baseline_mutation() IS
  'Trigger body behind publication_baselines_immutable. Refuses UPDATE for every role, table owner included, so the digest is never the only thing standing between a baseline and an edit. Refuses DELETE too, except when the owning organization has already gone -- that is the ON DELETE CASCADE arm, and without it an organization that had ever published could not be deleted at all.';

-- ---------------------------------------------------------------------------
-- 3. RLS -- enabled in the migration that creates the table
-- ---------------------------------------------------------------------------

ALTER TABLE public.publication_baselines ENABLE ROW LEVEL SECURITY;

-- Members read their own organisation's baselines; **nobody writes through the
-- table**. There is no INSERT, UPDATE or DELETE policy here and that is the
-- enforcement, not an omission: writes go through the SECURITY DEFINER RPC
-- below, which gates on `is_org_admin`. There is deliberately no
-- `USING (true)` anywhere in this file.
DROP POLICY IF EXISTS "Publication baselines: members select" ON public.publication_baselines;
CREATE POLICY "Publication baselines: members select"
  ON public.publication_baselines FOR SELECT
  TO authenticated
  USING (public.is_org_member(organization_id));

GRANT SELECT ON public.publication_baselines TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. The document validator -- separate, and callable, on purpose
-- ---------------------------------------------------------------------------
--
-- This is `PublicationSnapshotDocumentSchema` restated in SQL. Two reasons it
-- is a function of its own rather than inline in the RPC:
--
--   1. **It can be exercised.** The RPC is `is_org_admin`-gated, so no smoke
--      running without a JWT can reach one line of its validation. This
--      function takes a document and returns a problem or NULL, so
--      `docs/sql/20260920000000_smoke.sql` drives twelve corrupt documents and
--      one good one through it and proves each refusal fires **and** that the
--      good one is accepted. A validator that refused everything would pass a
--      refusal-only smoke.
--   2. **The database is not trusting the client's Zod pass.** The frontend
--      validates through `serialisePublicationSnapshot()`; anyone with an
--      authenticated session can call the RPC directly with anything.
--
-- It returns the FIRST problem rather than a list: the caller is a guard, and
-- an error message naming one concrete defect is more use than a set.
CREATE OR REPLACE FUNCTION public.publication_baseline_document_problem(p_document jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    -- Exactly the keys `PublicationSnapshotDocumentSchema` declares, and it is
    -- `.strict()`, so an undeclared key is a problem rather than spare data.
    c_keys constant text[] := ARRAY[
        'version', 'snapshotId', 'label', 'channel', 'publishedAt',
        'publishedBy', 'notes', 'columns', 'rows', 'digest'
    ];
    v_keys text[];
    v_columns text[];
    v_row jsonb;
    v_row_keys text[];
    v_index int := 0;
    v_name text;
BEGIN
    IF p_document IS NULL OR jsonb_typeof(p_document) <> 'object' THEN
        RETURN 'document must be a JSON object';
    END IF;

    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(p_document) AS k;
    IF v_keys IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM unnest(c_keys) AS k) THEN
        RETURN format(
            'document keys are %s; PublicationSnapshotDocumentSchema is strict and declares %s',
            v_keys, (SELECT array_agg(k ORDER BY k) FROM unnest(c_keys) AS k)
        );
    END IF;

    IF p_document->'version' <> to_jsonb(1) THEN
        RETURN format('document version is %s; this store reads version 1', p_document->'version');
    END IF;

    -- The five mandatory non-empty strings, in one pass so a sixth cannot be
    -- added to the schema and forgotten here without the key check above
    -- firing first.
    FOREACH v_name IN ARRAY ARRAY['snapshotId', 'label', 'channel', 'publishedBy', 'digest'] LOOP
        IF jsonb_typeof(p_document->v_name) <> 'string'
           OR length(btrim(p_document->>v_name)) = 0 THEN
            RETURN format('%s must be a non-empty string', v_name);
        END IF;
    END LOOP;

    IF p_document->>'digest' !~ '^[0-9a-f]{16}$' THEN
        RETURN format(
            'digest %L is not 16 lowercase hex characters from publicationDigest()',
            p_document->>'digest'
        );
    END IF;

    IF jsonb_typeof(p_document->'publishedAt') <> 'string'
       OR p_document->>'publishedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$' THEN
        RETURN format(
            'publishedAt %L is not a naive YYYY-MM-DDTHH:MM:SS stamp; a stamp carrying an offset is not this vocabulary (GAP-30)',
            p_document->>'publishedAt'
        );
    END IF;

    -- `notes` is nullable but never optional, and an empty string is neither.
    IF jsonb_typeof(p_document->'notes') NOT IN ('null', 'string')
       OR (jsonb_typeof(p_document->'notes') = 'string'
           AND length(btrim(p_document->>'notes')) = 0) THEN
        RETURN 'notes must be null or a non-empty string';
    END IF;

    IF jsonb_typeof(p_document->'columns') <> 'array'
       OR jsonb_array_length(p_document->'columns') = 0 THEN
        RETURN 'columns must be a non-empty array';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_document->'columns') AS c
         WHERE jsonb_typeof(c) <> 'string' OR length(btrim(c #>> '{}')) = 0
    ) THEN
        RETURN 'every column must be a non-empty string';
    END IF;

    SELECT array_agg(c ORDER BY c) INTO v_columns
      FROM jsonb_array_elements_text(p_document->'columns') AS c;
    IF array_length(v_columns, 1) <> (
        SELECT count(DISTINCT c) FROM jsonb_array_elements_text(p_document->'columns') AS c
    ) THEN
        RETURN 'columns carries a duplicate; a row cannot hold one column twice';
    END IF;

    IF jsonb_typeof(p_document->'rows') <> 'array'
       OR jsonb_array_length(p_document->'rows') = 0 THEN
        RETURN 'rows must be a non-empty array; a snapshot of zero rows is not a publication';
    END IF;

    -- Every row is written in the document's own declared vocabulary: same key
    -- set, every value a string. This is the superRefine on
    -- `PublicationSnapshotInputSchema`, and it is the check that stops a
    -- parity run comparing cells that are not there.
    FOR v_row IN SELECT r FROM jsonb_array_elements(p_document->'rows') AS r LOOP
        IF jsonb_typeof(v_row) <> 'object' THEN
            RETURN format('row %s is not an object', v_index);
        END IF;
        SELECT array_agg(k ORDER BY k) INTO v_row_keys
          FROM jsonb_object_keys(v_row) AS k;
        IF v_row_keys IS DISTINCT FROM v_columns THEN
            RETURN format(
                'row %s carries keys %s; the document declares columns %s',
                v_index, v_row_keys, v_columns
            );
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_each(v_row) AS e WHERE jsonb_typeof(e.value) <> 'string'
        ) THEN
            RETURN format('row %s carries a non-string cell; export cells are text', v_index);
        END IF;
        v_index := v_index + 1;
    END LOOP;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.publication_baseline_document_problem(jsonb) IS
  'PublicationSnapshotDocumentSchema restated in SQL. Returns the first problem with a candidate baseline document, or NULL when it is sound. Separate from admin_publish_schedule_baseline() so a smoke with no JWT can exercise every branch, and because the database must not trust the client Zod pass.';

REVOKE ALL ON FUNCTION public.publication_baseline_document_problem(jsonb) FROM PUBLIC;
-- **Explicit, although PUBLIC already covers it.** `anon` inherits from
-- PUBLIC, so the line above is sufficient today and would stop being so the
-- moment anybody granted PUBLIC back. `20260913000000`'s smoke found an
-- `anon`-callable definer function the first time it was ever run; naming the
-- role is a line of SQL against a defect that has actually happened here.
REVOKE ALL ON FUNCTION public.publication_baseline_document_problem(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.publication_baseline_document_problem(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. admin_publish_schedule_baseline -- the only writer
-- ---------------------------------------------------------------------------
--
-- Audits before AND after, following `admin_create_field_blackout`
-- (`20260906000100`) rather than the four facility RPCs that audit the result
-- only.
--
-- **The before row does not carry the document.** A baseline of the season
-- corpus is 679 rows of 13 columns; writing it into `audit_log.metadata` twice
-- would put a megabyte of duplicated schedule into the audit table per
-- publication. The before row carries what an operator needs to see that a
-- publication was *attempted* -- the snapshot id, the channel, the row count
-- and the digest -- and the after row adds the assigned version and the new
-- id. The rows themselves are in the baseline, which is immutable, so the
-- audit pointing at it is pointing at something that cannot change.
CREATE OR REPLACE FUNCTION public.admin_publish_schedule_baseline(
    p_organization_id uuid,
    p_document jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_problem text;
    v_version integer;
    v_row public.publication_baselines%ROWTYPE;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'p_organization_id is required' USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_org_admin(p_organization_id) THEN
        RAISE EXCEPTION 'Access denied: caller is not an admin of organization %', p_organization_id
            USING ERRCODE = '42501';
    END IF;
    -- **The organisation must exist.** This function is SECURITY DEFINER and
    -- bypasses RLS; the FK would refuse an unknown id anyway, but with
    -- `23503` and a constraint name rather than a sentence, and only after the
    -- before-audit had already been written for a publication that cannot
    -- happen.
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_organization_id) THEN
        RAISE EXCEPTION 'Organization % not found', p_organization_id USING ERRCODE = 'P0002';
    END IF;

    v_problem := public.publication_baseline_document_problem(p_document);
    IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'publication baseline document is not valid: %', v_problem
            USING ERRCODE = '22023';
    END IF;

    -- Version assignment. `MAX + 1` is a read-then-write, so two admins
    -- publishing at the same instant would otherwise both read the same
    -- maximum and one would lose to `publication_baselines_version_unique`.
    -- The lock is per organisation and transaction-scoped: it is released by
    -- COMMIT or ROLLBACK, never held, and it does not serialise other orgs.
    PERFORM pg_advisory_xact_lock(hashtext('publication_baselines:' || p_organization_id::text));

    SELECT COALESCE(MAX(baseline_version), 0) + 1
      INTO v_version
      FROM public.publication_baselines
     WHERE organization_id = p_organization_id;

    PERFORM public.record_audit_event(
        p_organization_id, 'publication.baseline_recorded', 'publication_baseline', NULL,
        jsonb_build_object(
            'operation', 'admin_publish_schedule_baseline', 'phase', 'before',
            'requested', jsonb_build_object(
                'snapshot_id', p_document->>'snapshotId',
                'label', p_document->>'label',
                'channel', p_document->>'channel',
                'published_at', p_document->>'publishedAt',
                'published_by', p_document->>'publishedBy',
                'row_count', jsonb_array_length(p_document->'rows'),
                'digest', p_document->>'digest',
                'baseline_version', v_version
            )
        )
    );

    INSERT INTO public.publication_baselines (
        organization_id, baseline_version, document_version, snapshot_id, label,
        channel, published_at, published_by, notes, export_columns, export_rows,
        row_count, digest, recorded_by
    ) VALUES (
        p_organization_id,
        v_version,
        (p_document->>'version')::integer,
        p_document->>'snapshotId',
        p_document->>'label',
        p_document->>'channel',
        p_document->>'publishedAt',
        p_document->>'publishedBy',
        CASE WHEN jsonb_typeof(p_document->'notes') = 'null' THEN NULL
             ELSE p_document->>'notes' END,
        p_document->'columns',
        p_document->'rows',
        jsonb_array_length(p_document->'rows'),
        p_document->>'digest',
        auth.uid()
    )
    RETURNING * INTO v_row;

    PERFORM public.record_audit_event(
        p_organization_id, 'publication.baseline_recorded', 'publication_baseline', v_row.id,
        jsonb_build_object(
            'operation', 'admin_publish_schedule_baseline', 'phase', 'after',
            'after', jsonb_build_object(
                'id', v_row.id,
                'baseline_version', v_row.baseline_version,
                'document_version', v_row.document_version,
                'snapshot_id', v_row.snapshot_id,
                'label', v_row.label,
                'channel', v_row.channel,
                'published_at', v_row.published_at,
                'published_by', v_row.published_by,
                'row_count', v_row.row_count,
                'digest', v_row.digest,
                'recorded_at', v_row.recorded_at
            )
        )
    );

    -- The row **without** its payload. The caller just sent the rows; handing
    -- them straight back doubles the response for nothing, and the reader
    -- loads a baseline by SELECT when it wants one.
    RETURN jsonb_build_object(
        'id', v_row.id,
        'organization_id', v_row.organization_id,
        'baseline_version', v_row.baseline_version,
        'document_version', v_row.document_version,
        'snapshot_id', v_row.snapshot_id,
        'label', v_row.label,
        'channel', v_row.channel,
        'published_at', v_row.published_at,
        'published_by', v_row.published_by,
        'notes', v_row.notes,
        'row_count', v_row.row_count,
        'digest', v_row.digest,
        'recorded_at', v_row.recorded_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_publish_schedule_baseline(uuid, jsonb) FROM PUBLIC;
-- See the note on the validator above: named explicitly, against a defect this
-- repository has actually shipped.
REVOKE ALL ON FUNCTION public.admin_publish_schedule_baseline(uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_publish_schedule_baseline(uuid, jsonb) TO authenticated;

COMMENT ON FUNCTION public.admin_publish_schedule_baseline(uuid, jsonb) IS
  'Org-admin recording of a published schedule baseline (GAP-29). Takes a PublicationSnapshotDocumentSchema document, re-validates it server-side through publication_baseline_document_problem(), assigns the next per-organisation baseline_version under an advisory lock, and audits before and after. The only writer of publication_baselines; the table has no write policy.';

COMMIT;
