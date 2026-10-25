---
name: squadlogic-feature-guardians
description: Use when adding, renaming, retiring or gating an organization feature flag (frontend/src/constants/featureFlags.js, FeatureGuard, the feature settings page). Covers the flag registry, its Zod schema, defaults, the catalog, the audited update RPC and the tests to change.
---

<!-- Claude Code's copy of .agents/skills/squadlogic-feature-guardians/SKILL.md, kept by hand: this is one of the repository's own skills. Edit the .agents/ file and carry the same change into this one. -->

# SquadLogic Feature Guardians

How to add, gate, and retire an organization-level feature flag safely.

## Where things are

- Registry: `frontend/src/constants/featureFlags.js` — `FEATURE_FLAGS` (key constants),
  `ALL_FLAGS` (derived from `FEATURE_FLAGS`), `FEATURE_DEFAULTS` (applied when the stored JSONB
  has no key), `FEATURE_CATALOG` (what the settings page shows), and `FeatureFlagSchema` (Zod).
- Storage: `organizations.feature_flags` (JSONB), read through `OrganizationContext.jsx`, which
  parses it with `FeatureFlagSchema`.
- Writes: `OrganizationContext`'s `updateFeatureFlags`, which validates with the schema and calls
  the `update_org_feature_flags` RPC (admin-only; writes a `feature_flags.updated` row to
  `audit_log`). Never write `feature_flags` with a direct table update.
- Gate: `<FeatureGuard flag={…} fallback={…}>` in `frontend/src/components/ui/FeatureGuard.jsx`.
- Tests: `tests/FeatureGuard.test.jsx`, `tests/FeatureFlagSettings.test.jsx`.

## Adding a flag

1. Add the key to `FEATURE_FLAGS`; `ALL_FLAGS` picks it up. The schema keeps a known key only
   when its value is a boolean and drops unknown keys, so a boolean flag needs no schema change.
   A string-valued setting (like `gender_model`) needs its own branch in `FeatureFlagSchema`.
2. Give it a default in `FEATURE_DEFAULTS` if it should not start off.
3. Add it to `FEATURE_CATALOG` if an admin should be able to toggle it.
4. Wrap the UI in `<FeatureGuard flag={FEATURE_FLAGS.MY_FLAG} fallback={…}>`.
5. Test both states through the real component path (the schema parse, then the guard), not a
   hand-built context the app can't produce (AGENTS.md §3).
6. A setting the domain logic reads (a flag `generateTeams` or `serpentineAssign` is handed, as
   the pages pass `useFeatures().features`) keeps its key in `packages/core` too, beside the
   rule that reads it (`BUDDY_RULES` in `buddyLinking.js`, `SPREAD_COACHING_LEADS_FLAG` in
   `coachingLeads.js`), with a test holding the two equal and a page test from a stored value
   for each state. Settings the domain reads today: `buddy_rule`, `teaming_spread_coaching_leads`,
   `years_played` and `player_rating` (the balance signal).

## Practices

- **No magic strings:** `FEATURE_FLAGS.MY_FLAG`, never the literal `'my_flag'`.
- **Fallbacks:** give `<FeatureGuard>` a meaningful `fallback` where hiding the feature would
  leave a gap in the page.
- **Gating is not authorization:** a flag hides UI; permissions and RLS decide who may act.
- **Retiring:** when a feature becomes standard, remove the `FeatureGuard` wrapper but keep the
  key in `FEATURE_FLAGS` until no stored organization still carries it, so the schema doesn't
  start dropping it as unknown.
- **Rollout:** toggle the flag through the settings page (mock mode, or a preview) and check
  both states before merging; that path goes through the audited RPC.
