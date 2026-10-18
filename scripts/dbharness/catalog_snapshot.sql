-- The catalogue the drift check compares: every `public` function signature,
-- every `public` trigger and a digest of every `public` RLS policy, as one JSON
-- document. READ-ONLY: one SELECT against the system catalogues, nothing else.
--
-- Two readers, one query, so the two cannot drift apart:
--   * scripts/dbharness/run.sh runs it on the fresh build and compares the
--     result with the committed supabase/catalog-snapshot.json;
--   * an operator runs it against production after each deploy-migrations
--     (docs/operations/ci-cd.md, "Catalogue drift check"), through
--     `python3 scripts/dbharness/catalog_snapshot.py compare-sql`, which wraps
--     this query with the committed snapshot as literals.
--
-- What is deliberately left out (docs/operations/schema-drift-2026-10.md):
--   * functions that belong to an extension (pg_depend deptype 'e'): a bare
--     PostgreSQL cluster puts pgcrypto in `public`, Supabase puts it in
--     `extensions`, and neither is the schema this repository writes;
--   * function bodies: production's early bodies were applied with LF line
--     endings and the repository's files carry CRLF, so every such body would
--     differ by md5 while behaving identically. A signature, a trigger and a
--     policy's expression are what the drift of 2026-10 was made of;
--   * internal (constraint) triggers, and anything outside `public`.
--
-- Policy digests coalesce a missing USING or WITH CHECK to '' before hashing:
-- the investigation's `md5(qual || '#' || with_check)` was NULL for every
-- policy lacking one of them, and NULL compares equal to nothing.
--
-- No trailing semicolon: compare-sql embeds this text as a subquery.
SELECT jsonb_build_object(
    'functions', COALESCE((
        SELECT jsonb_agg(sig ORDER BY sig COLLATE "C")
          FROM (
            SELECT format('%s(%s) returns %s',
                          p.proname,
                          pg_get_function_identity_arguments(p.oid),
                          COALESCE(pg_get_function_result(p.oid), '(procedure)')) AS sig
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND NOT EXISTS (
                   SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                      AND d.objid = p.oid
                      AND d.deptype = 'e')
          ) f), '[]'::jsonb),
    'triggers', COALESCE((
        SELECT jsonb_agg(def ORDER BY def COLLATE "C")
          FROM (
            SELECT pg_get_triggerdef(t.oid)
                   || CASE WHEN t.tgenabled <> 'O' THEN ' [tgenabled=' || t.tgenabled::text || ']' ELSE '' END AS def
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND NOT t.tgisinternal
          ) tr), '[]'::jsonb),
    'policies', COALESCE((
        SELECT jsonb_agg(pol ORDER BY pol COLLATE "C")
          FROM (
            SELECT format('%s|%s|%s|%s|%s|%s',
                          pp.tablename,
                          pp.policyname,
                          pp.cmd,
                          pp.permissive,
                          (SELECT string_agg(r, ',' ORDER BY r COLLATE "C") FROM unnest(pp.roles) r),
                          md5(COALESCE(pp.qual, '') || '#' || COALESCE(pp.with_check, ''))) AS pol
              FROM pg_policies pp
             WHERE pp.schemaname = 'public'
          ) po), '[]'::jsonb)
)::text AS catalog
