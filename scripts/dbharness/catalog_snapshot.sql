-- The catalogue the drift check compares: every `public` function signature,
-- every `public` trigger, a digest of every `public` RLS policy and the shape of
-- every `public` view, as one JSON document. READ-ONLY: one SELECT against the system catalogues, nothing else.
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
--   * function bodies: production's early bodies were applied from other
--     texts than the repository's (LF where some files carry CRLF, and at least
--     one without the file's comments), so a body hash would report drift that
--     changes no behaviour. A signature, a trigger and a policy's expression are
--     what the drift of 2026-10 was made of; body drift is recorded as a gap in
--     the remediation plan;
--   * internal (constraint) triggers, and anything outside `public`;
--   * a view's text and grants. A view is its name, kind, sorted options
--     (`security_invoker` among them; a boolean spelled on/yes/1 or off/no/0
--     reads as true or false, since the catalogue keeps the spelling a
--     migration used: production's import_efficiency_metrics has `=on`) and
--     typed columns in order: a view's text is re-deparsed by each
--     PostgreSQL version, so its hash would report drift between the
--     harness's server and production's that changes no behaviour, and grants follow each database's default privileges, which
--     the function and policy entries leave out too. Production lacked
--     `view_org_metrics` and `view_league_standings` for months with nothing
--     noticing (schema-drift-2026-10.md, section 7): presence and columns are
--     what that drift was made of.
--
-- Names print relative to the session's search_path (pg_get_triggerdef, the
-- argument types): both the harness and Supabase have `public` on it, and
-- compare-sql's query reports a session that does not as drift of its own.
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
          ) po), '[]'::jsonb),
    'views', COALESCE((
        SELECT jsonb_agg(v ORDER BY v COLLATE "C")
          FROM (
            SELECT format('%s|%s|%s|%s',
                          c.relname,
                          c.relkind,
                          COALESCE((SELECT string_agg(o, ',' ORDER BY o COLLATE "C")
                                      FROM (SELECT regexp_replace(regexp_replace(lower(r), '=(on|yes|1)$', '=true'),
                                                                  '=(off|no|0)$', '=false') AS o
                                              FROM unnest(c.reloptions) r) ro), ''),
                          (SELECT string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
                             FROM pg_attribute a
                            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)) AS v
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public'
               AND c.relkind IN ('v', 'm')
               AND NOT EXISTS (
                   SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_class'::regclass
                      AND d.objid = c.oid
                      AND d.deptype = 'e')
          ) vw), '[]'::jsonb)
)::text AS catalog
