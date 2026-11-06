-- Codify the production-only GIN index on players.custom_attributes.
--
-- Production holds `players_custom_attributes_gin_idx`, an index no migration ever created: a
-- read-only comparison of production with a build of the migrations (2026-11-02,
-- docs/changes/2026-11-02-data-followups.md) found it, and its sibling on teams, as the only index
-- drift. A fresh deployment (a new project, a branch database, the CI build) therefore lacked it.
-- This creates it as production has it, and does nothing where it already exists:
--
--   CREATE INDEX players_custom_attributes_gin_idx ON public.players USING gin (custom_attributes)
--
-- (the default operator class `jsonb_ops`, one key column, no predicate, no storage parameters;
-- valid and ready in production).
--
-- **In production this is a no-op.** IF NOT EXISTS skips the existing index with a NOTICE; it is not
-- rebuilt and `players` is not locked. On a populated database that does not have it, the build takes
-- a SHARE lock on `players` (writes wait, reads do not) for as long as it runs, and a migration runs
-- in a transaction so it cannot use CONCURRENTLY: build it first by hand, under this name and
-- definition, with CREATE INDEX CONCURRENTLY, and this then skips it.
--
-- **IF NOT EXISTS compares the name and nothing else**, so an index of this name with another shape (a
-- btree on the column, a jsonb_path_ops GIN, a partial one) would be skipped and the migration would
-- call itself done. The check after the statement reads the catalogue and refuses that (the
-- migration rolls back) rather than leave a name that means something other than production's.
--
-- Nothing in the product reads through this index today (no function, policy or view, and no
-- filter in the app, uses @>, ?, ?|, ?&, @? or @@ on the column) and it costs on every write; it is
-- codified because it is in production, not because a reader needs it. Removing it is a separate,
-- deliberate migration. The revert is a documented no-op for the same reason: it cannot tell whether
-- the index was made here or already existed, so dropping it could damage production.

CREATE INDEX IF NOT EXISTS players_custom_attributes_gin_idx
    ON public.players USING gin (custom_attributes);

DO $$
DECLARE
    v_why text;
BEGIN
    SELECT CASE
             WHEN NOT (i.indisvalid AND i.indisready) THEN 'it is not valid'
             WHEN i.indexprs IS NOT NULL OR i.indpred IS NOT NULL THEN 'it is an expression or a partial index'
             WHEN i.indisunique THEN 'it is unique'
             WHEN am.amname <> 'gin' THEN 'it is a ' || am.amname || ' index'
             WHEN i.indnatts <> 1 OR i.indnkeyatts <> 1 OR a.attname IS DISTINCT FROM 'custom_attributes'
               THEN 'it does not index custom_attributes alone'
             WHEN opc.opcname <> 'jsonb_ops' THEN 'its operator class is ' || opc.opcname
             WHEN c.reloptions IS NOT NULL THEN 'it has storage parameters'
           END
      INTO v_why
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_am am ON am.oid = c.relam
      LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      LEFT JOIN pg_opclass opc ON opc.oid = i.indclass[0]
     WHERE i.indexrelid = to_regclass('public.players_custom_attributes_gin_idx')
       AND i.indrelid = 'public.players'::regclass;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'players_custom_attributes_gin_idx is not an index on public.players, so it is not the GIN index on custom_attributes that production holds';
    END IF;
    IF v_why IS NOT NULL THEN
        RAISE EXCEPTION 'players_custom_attributes_gin_idx is not the GIN index on public.players (custom_attributes) that production holds: %; drop or rename it and apply this migration again', v_why;
    END IF;
END;
$$;
