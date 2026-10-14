[← Back to Documentation Index](../README.md)
---

# Governance Framework

The non-negotiable engineering mandates for SquadLogic. Every PR is evaluated
against these; CI enforces several of them mechanically. Phase-specific
governance specs from the build-out have been retired — what follows is the
durable framework they converged on.

## 1. Persistence & security guardrails

1. **RPC Enforcement** — all domain state changes go through dedicated
   `SECURITY DEFINER` RPCs. Direct `supabase.from(...).update()/insert()/delete()`
   of sensitive domain tables from the client is a critical failure.
2. **Definer hygiene** — every definer function sets `SET search_path = public`
   and revokes anon `EXECUTE`. Reporting views use `security_invoker = on`.
   Enforced by `npm run check:advisors`.
3. **Schema Rigidity** — client-side updates are validated against Zod schemas
   before transmission; the database re-validates via constraints/triggers.
   CHECK constraints (statuses, audit actions) are extended in the same PR
   that introduces new values.
4. **Audit Immutability** — every administrative or state-altering action is
   recorded in `audit_log` with full metadata (actor, target, patch/previous
   state). Impersonated actions record both identities. The log is
   append-only.
5. **RLS everywhere** — all tables carry row-level security keyed on
   organization membership. No `USING (true)` policies.
6. **Session integrity** — privileged UI verifies the user's role through
   `usePermission`/`OrganizationContext` before mounting; the RPC re-verifies
   server-side (`is_org_admin` / `is_org_member`). UI gating is never the only
   gate.

## 2. Privacy & scope

7. **Data minimization** — store only the PII needed for scheduling and
   communication. No document uploads (waivers/IDs are boolean toggles), no
   payment collection, no PII in the repository (including test fixtures).
8. **Secret discipline** — the service-role key never appears in `VITE_`-prefixed
   variables; env files are gitignored with `.example` templates. Enforced by
   `check:advisors` secret-shape scanning.

## 3. Quality gates (Definition of Done)

Every PR must pass, in CI and locally:

| Gate | Command |
| --- | --- |
| Types | `npm run typecheck` |
| Lint | `npm run lint` (0 errors) |
| Unit/integration | `npm run test` |
| Build | `npm run frontend:build` |
| Bundle budget | `npm run check:bundle` (budgets in `config/bundle-budget.json`; raises need documented rationale) |
| Migration advisors | `npm run check:advisors` |
| E2E | `npx bddgen && npm run test:e2e -- --workers=1` |

Plus: new exports registered in their package index; migrations shipped with
revert + smoke scripts under `docs/sql/`; tests replaced for every deleted
tested component (coverage thresholds: 90/81/92/91, hooks 62/52/64/66, enforced by CI's
`npm run test:coverage`).

## 4. Accessibility

WCAG 2.2 AA is a core requirement: keyboard access and visible focus for all
interactive elements, semantic landmarks, sufficient contrast in both themes,
and non-drag alternatives for every drag-and-drop interaction. See
[`docs/ui/agent-ui-ux-guidelines.md`](../ui/agent-ui-ux-guidelines.md).

## 5. Telemetry standards

Import sessions emit telemetry (matching confidence, user-correction rate,
latency, ambiguity flags) so ingestion intelligence is measurable. Telemetry
event names are stable interfaces — preserve them across refactors.

## 6. Review protocol

Reviewers (human or agent) evaluate each change for: RPC bypasses, RLS/advisor
regressions, audit-log gaps, schema-validation gaps, accessibility drift, and
unverified claims in generated output (see
[`docs/LESSONS_LEARNED.md`](../LESSONS_LEARNED.md) §24).
