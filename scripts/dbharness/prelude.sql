-- Prelude for the local migration harness.
--
-- 90 of the migration set's files reference Supabase-managed roles or the
-- `auth` schema, neither of which exists in a bare PostgreSQL cluster. This
-- creates the smallest stand-in that lets the real migrations run unmodified.
--
-- **What this is not.** It is not Supabase. `auth.uid()` returns a settable
-- session value rather than a real JWT claim, and the roles carry no Supabase
-- grants beyond what the migrations themselves issue. The harness therefore
-- proves that the SQL APPLIES and that the smokes' structural checks hold --
-- not that RLS behaves correctly under a real authenticated session, which is
-- what the pgTAP suite is for.

-- Roles are CLUSTER-wide, not per-database, so this must be idempotent: the
-- harness rebuilds the database several times against one cluster.
DO $prelude$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'supabase_auth_admin'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    EXECUTE 'ALTER ROLE service_role BYPASSRLS';
  END IF;
END
$prelude$;

GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- Supabase's auth.users, reduced to the columns migrations reference.
-- `encrypted_password` is present because 20240405180000_password_hardening.sql
-- installs a trigger on auth.users that reads it. Without the column the
-- trigger raises and any smoke inserting a user fails for a reason that has
-- nothing to do with what it is testing.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  encrypted_password text NOT NULL DEFAULT '$2a$10$smokeharnessplaceholderhashvalue000000000000000000000',
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Supabase's auth.users carries email_confirmed_at; link_my_coach_record
-- (20261020040000) reads it. Added rather than declared above so a harness
-- database built before this line existed gains it too.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;

-- `auth.uid()` reads a session GUC so a harness script can act as a user:
--   SET LOCAL request.jwt.claim.sub = '<uuid>';
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'authenticated');
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- Supabase's storage schema, reduced to what migrations write. Only
-- `storage.buckets` is referenced (a bucket row is inserted); nothing in the
-- set reads object contents.
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz DEFAULT now()
);

-- Supabase creates this publication for Realtime; several migrations add
-- tables to it. An empty publication is enough for them to succeed.
-- Supabase's storage helper, used by the bucket-scoping policies.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_to_array(name, '/');
$$;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)];
$$;

-- Supabase keeps extensions out of `public` in a dedicated schema.
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;

DO $pub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$pub$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
