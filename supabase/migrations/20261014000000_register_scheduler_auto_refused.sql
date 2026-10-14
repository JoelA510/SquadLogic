-- Register `scheduler.auto_refused`, the audit action the auto-scheduler writes
-- on each of its five refusal paths (slots not placeable on the season clock,
-- the lock mismatch, the coach-preference, daylight and lighting-override
-- refusals; `supabase/functions/auto-scheduler/index.ts`).
--
-- `audit_log.action` is a foreign key to `audit_actions`
-- (20260613000006_audit_actions_lookup.sql). The action shipped in 8.6 3b
-- PR 11d-0 and was never registered, here or in production (checked read-only
-- on 2026-10-14), so every such row would fail with 23503. It went unseen
-- because every Edge audit write was also failing for an earlier reason: the
-- helpers called `record_audit_event` with the service-role client, under
-- which `auth.uid()` is NULL and `audit_log.user_id NOT NULL` refused the row.
-- The same pull request moves those writes to the caller's client; without
-- this row the refusals would still be lost, on the foreign key instead.
--
-- `tests/edgeAuditActions.test.js` now fails when any action an Edge Function
-- writes is not registered by a migration.
--
-- Reversible: see docs/sql/20261014000000_revert.sql.
-- Smoke checks: see docs/sql/20261014000000_smoke.sql.

BEGIN;

INSERT INTO public.audit_actions (action) VALUES ('scheduler.auto_refused')
    ON CONFLICT (action) DO NOTHING;

COMMIT;
