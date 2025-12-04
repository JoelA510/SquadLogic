# SquadLogic Project-Wide Code Review

**Review Date**: December 4, 2025  
**Reviewer Role**: Principal Engineer / Security-Privacy Reviewer / Testability Lead  
**Branch**: main  

---

## 1. Architecture & Repo Overview

### Stack Summary
- **Frontend**: Vite + React 18 SPA deployed as static bundle
- **Backend**: Supabase (Postgres + Edge Functions in Deno)
- **Business Logic**: Node.js 20+ ES modules (`src/`), no runtime server
- **Database**: 19 tables with RLS, 3 persistence RPCs, comprehensive trigger functions
- **Testing**: Node.js native test runner (`node --test`), 20 test files

### Core Components
| Component | Files | Responsibility |
|-----------|-------|----------------|
| **Scheduling Engine** | `gameScheduling.js`, `practiceScheduling.js` | Round-robin generation, slot allocation with conflict detection |
| **Metrics & Evaluation** | `gameMetrics.js`, `practiceMetrics.js`, `evaluationPipeline.js` | Readiness signals, fairness alerts, conflict analysis |
| **Persistence Layer** | `*PersistenceHandler.js`, `persistenceHandler.js` | Snapshot normalization, RPC calls, transactional upserts |
| **Edge Functions** | `supabase/functions/*/index.ts` | HTTP handlers for team/practice/game persistence |
| **Frontend Dashboard** | `frontend/src/App.jsx`, `components/*Panel.jsx` | Admin UI with readiness panels, persistence controls |

### Architectural Strengths
- **Separation of concerns**: Business logic isolated in `src/`, frontend in `frontend/src/`
- **Typed validation**: Strong input validation in scheduling and persistence modules
- **RLS by default**: All 19 tables have RLS enabled with admin/coach policies
- **Transactional RPCs**: `persist_*` functions ensure atomic batch writes
- **Good test coverage**: 20 test files covering core algorithms

### Architectural Concerns
- **God module risk**: `App.jsx` at 547 lines handles too many responsibilities
- **Missing TypeScript**: Pure JS throughout increases runtime error risk
- **Edge function atomicity gap**: `transactionalClient` shim does NOT provide true atomicity
- **No input schema validation**: API boundaries lack Zod/JSON Schema enforcement
- **Mixed styling**: CSS vars + Tailwind classes in persistence panels

---

## 2. Top Risks (P0/P1 Only)

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| **SEC-01** | P0 | Edge function `transaction` shim lacks atomicity | `supabase/functions/team-persistence/index.ts:80-90` |
| **SEC-02** | P1 | No request body validation at Edge Function boundary | `supabase/functions/*/index.ts` |
| **DB-01** | P1 | RPC `persist_team_schedule` swallows errors via EXCEPTION return | `migrations/20251206000000_team_persistence_rpc.sql:96-100` |
| **DB-02** | P1 | Missing `source` column in team_players upsert | `migrations/20251206000000_team_persistence_rpc.sql:75-83` |
| **CODE-01** | P1 | Inconsistent RPC error handling between modules | `src/persistenceHandler.js` vs `src/teamPersistenceHandler.js` |
| **PERF-01** | P1 | Unbounded array scans in scheduling algorithms | `src/gameScheduling.js:437-544` |

---

## 3. Detailed Issues by Area

### 3.1 Database & Migrations (`supabase/migrations/`)

#### `[P0][security][db/migrations]` `20251206000000_team_persistence_rpc.sql:80-90`
**Short title**: Transaction shim provides false atomicity guarantee  
**Impact**: Partial writes possible if any step fails mid-transaction.  
**Recommendation**:  
1. Use Supabase's native RPC approach (single function, single transaction).
2. Remove the shim entirely and call the RPC directly.
3. Document this limitation prominently if keeping the shim.

#### `[P1][db/migrations][code]` `20251206000000_team_persistence_rpc.sql:96-100`
**Short title**: RPC catches exceptions and returns error JSON instead of propagating  
**Impact**: Caller receives `status: 'error'` but transaction is already rolled back; no retry distinction.  
**Recommendation**:  
```sql
-- Remove the EXCEPTION block and let errors propagate naturally
-- OR add explicit ROLLBACK and re-raise:
EXCEPTION WHEN OTHERS THEN
    RAISE;
END;
```

#### `[P1][db/migrations]` `20251206000000_team_persistence_rpc.sql:75-83`
**Short title**: `team_players` upsert ignores `source` and `role` columns  
**Impact**: All inserted rows default to `role='player'`, `source='auto'`.  
**Recommendation**:  
```sql
INSERT INTO team_players (team_id, player_id, role, source)
SELECT
    (tp->>'team_id')::uuid,
    (tp->>'player_id')::uuid,
    COALESCE(tp->>'role', 'player'),
    COALESCE(tp->>'source', 'auto')::source_enum
FROM jsonb_array_elements(team_players) tp
ON CONFLICT (team_id, player_id) DO UPDATE SET
    role = EXCLUDED.role,
    source = EXCLUDED.source;
```

#### `[P2][db/migrations]` `20251202000000_initial_schema.sql`
**Short title**: `created_by` column type inconsistency  
**Impact**: Some tables use `uuid references auth.users(id)`, others use `text`.  
**Files affected**: `scheduler_runs.created_by` (line 373), persist functions use `text` cast.  
**Recommendation**: Standardize on `uuid` with FK constraint or `text` with no FK.

---

### 3.2 Edge Functions (`supabase/functions/`)

#### `[P1][security][api/contracts]` `team-persistence/index.ts`
**Short title**: No request body schema validation  
**Impact**: Malformed payloads could cause runtime errors or unexpected behavior.  
**Recommendation**:  
```typescript
import { z } from 'zod';

const PersistencePayloadSchema = z.object({
  snapshot: z.object({
    payload: z.object({
      teamRows: z.array(z.object({ id: z.string(), /* ... */ })),
      teamPlayerRows: z.array(z.object({ team_id: z.string(), player_id: z.string() })),
    }),
  }),
  overrides: z.array(z.unknown()).optional(),
});

// In handler:
const parsed = PersistencePayloadSchema.safeParse(await request.json());
if (!parsed.success) {
  return jsonResponse({ status: 'error', message: 'Invalid payload', issues: parsed.error.issues }, 400);
}
```

#### `[P2][security]` `team-persistence/index.ts:50-55`
**Short title**: Hardcoded environment variable access without validation  
**Impact**: Missing env vars cause cryptic 500 errors.  
**Recommendation**: Add startup validation and clear error messages.

---

### 3.3 Core Source Modules (`src/`)

#### `[P1][performance][code]` `gameScheduling.js:437-544` (`selectSlotForMatchup`)
**Short title**: Linear scans through all slots for each matchup  
**Impact**: O(slots * matchups) complexity; slow for large divisions.  
**Recommendation**:  
1. Pre-index slots by `weekIndex` and `division`.
2. Use a Map for O(1) slot lookup.
```javascript
// Before scheduling loop
const slotsByWeekDivision = new Map();
for (const slot of slots) {
  const key = `${slot.weekIndex}-${slot.division}`;
  if (!slotsByWeekDivision.has(key)) slotsByWeekDivision.set(key, []);
  slotsByWeekDivision.get(key).push(slot);
}
```

#### `[P2][code]` `persistenceHandler.js:52-60`
**Short title**: `validateSnapshot` checks for `assignmentRows` but team handler uses `teamRows`  
**Impact**: Generic validation fails for team snapshots.  
**Recommendation**: Make validation schema configurable or remove from generic handler.

#### `[P2][code]` `practiceSlotExpansion.js`
**Short title**: No test coverage for edge cases in date range intersection  
**Impact**: Boundary conditions (phase start = slot end, etc.) may produce unexpected results.  
**Recommendation**: Add test cases for:
- Phase exactly matching slot validity
- Single-day phases
- Phases with no matching weekdays

---

### 3.4 Frontend (`frontend/src/`)

#### `[P2][code][ux/api-shape]` `App.jsx`
**Short title**: 547-line god component with mixed concerns  
**Impact**: Hard to test, maintain, and reason about.  
**Recommendation**:  
1. Extract data loading into custom hooks (`useTeamSummary`, `usePracticeReadiness`).
2. Split into route-based components.
3. Create a `DashboardLayout` wrapper.

#### `[P2][code]` `components/PersistencePanel.jsx`
**Short title**: Tailwind classes mixed with CSS vars, no design system  
**Impact**: Inconsistent styling, harder to theme.  
**Recommendation**: Use `PERSISTENCE_THEMES` pattern consistently across all panels.

#### `[P3][code]` `App.jsx:527`
**Short title**: List key uses array index  
**Impact**: Potential React reconciliation issues if actions reorder.  
**Recommendation**: Use stable identifiers.

---

### 3.5 Testing (`tests/`)

#### `[P2][tests]` Missing test files
**Short title**: Critical modules lack dedicated test files  
**Impact**: Regression risk in core functionality.  
**Missing tests**:
- `src/teamPersistenceHandler.js` (handler logic)
- `src/practicePersistenceHandler.js`
- `src/gamePersistenceHandler.js`
- `src/outputGeneration.js` (only 3373 bytes of tests)

#### `[P2][tests]` `evaluationPipeline.test.js`
**Short title**: No tests for `filterRedundantCapacityWarnings` edge cases  
**Impact**: Complex filtering logic not fully validated.  
**Recommendation**: Add tests for empty arrays, null inputs, partial matches.

---

### 3.6 Security Review Summary

| Check | Status | Notes |
|-------|--------|-------|
| RLS enabled | ✅ | All 19 tables |
| Admin policies | ✅ | Consistent `(auth.jwt() ->> 'role') = 'admin'` pattern |
| SECURITY INVOKER | ✅ | RPCs use caller permissions |
| Input validation | ⚠️ | Strong in JS, missing at Edge boundary |
| SQL injection | ✅ | All queries use parameterized JSONB extraction |
| Auth header parsing | ✅ | Proper Bearer token extraction |
| Secrets in code | ✅ | None found (env vars used) |
| Service role key | ⚠️ | Used in Edge functions (correct, but ensure least privilege) |

---

## 4. Refactor & Improvement Plan

### 4.1 Add API Boundary Validation (High Priority, Medium Difficulty)
**Scope**: All Edge Functions  
**Rationale**: Missing validation = undefined behavior on malformed input.  
**Risk**: Low (additive change, no breaking impact)  
**Difficulty**: M  
**Order**: First  
**Owner**: Mid-level dev can implement; senior review for schema design.

### 4.2 Fix RPC Atomicity & Error Handling (High Priority, Low Difficulty)
**Scope**: `persist_team_schedule` RPC  
**Rationale**: Current exception handling masks errors.  
**Risk**: Low (behavior change, but safer)  
**Difficulty**: S  
**Order**: Second  
**Owner**: Any dev with SQL experience.

### 4.3 Optimize Scheduling Algorithm Hot Paths (Medium Priority, High Difficulty)
**Scope**: `gameScheduling.js`, `practiceScheduling.js`  
**Rationale**: O(n²) complexity will hurt with larger leagues.  
**Risk**: Medium (algorithmic change requires careful testing)  
**Difficulty**: L  
**Order**: Third (after test coverage improves)  
**Owner**: Senior dev required.

### 4.4 Extract Frontend Components (Low Priority, Medium Difficulty)
**Scope**: `App.jsx`, component organization  
**Rationale**: Maintainability and testability.  
**Risk**: Low (purely structural)  
**Difficulty**: M  
**Order**: Later  
**Owner**: Mid-level frontend dev.

### 4.5 Add TypeScript (Low Priority, High Difficulty)
**Scope**: Entire `src/` and `frontend/src/`  
**Rationale**: Catch type errors at compile time.  
**Risk**: High (large migration effort)  
**Difficulty**: L  
**Order**: Future consideration  
**Owner**: Senior dev + team buy-in.

---

## 5. Quick Wins (High ROI, Low Risk)

| # | Change | Location | Effort |
|---|--------|----------|--------|
| 1 | Add `z.safeParse` to Edge Function request handlers | `supabase/functions/*/index.ts` | 1 day |
| 2 | Remove EXCEPTION block from `persist_team_schedule` | `20251206000000_team_persistence_rpc.sql` | 30 min |
| 3 | Add `role` and `source` to team_players upsert | Same as above | 30 min |
| 4 | Extract `useTeamSummary` hook from `App.jsx` | `frontend/src/hooks/` | 2 hours |
| 5 | Add test for `filterRedundantCapacityWarnings` edge cases | `tests/evaluationPipeline.test.js` | 1 hour |
| 6 | Run `node --test` in CI with coverage reporting | `.github/workflows/` or similar | 2 hours |
| 7 | Document the "no true atomicity" limitation in Edge functions | `docs/architecture.md` | 30 min |

---

## 6. Gaps & Questions

### Assumptions Made
1. **No CI/CD config visible**: Assumed tests are run manually. Verify pipeline setup.
2. **No `.env.example`**: Could not validate all required environment variables.
3. **Supabase project config not visible**: RLS policies assumed to match migration file.
4. **No linting config**: `scripts/lint-node-check.js` exists but unclear scope.

### Questions for Maintainers
1. What is the expected maximum league size (teams, divisions, slots)? Needed for performance planning.
2. Is the Edge Function transaction shim intentionally non-atomic, or is true atomicity desired?
3. Are there plans to migrate to TypeScript? If so, what's the timeline?
4. Which environment is this deployed to (Vercel, Netlify, self-hosted)? Impacts CI recommendations.
5. Is there a staging environment for testing migrations before production?

---

## Appendix: Issue Summary by Severity

| Severity | Count | Categories |
|----------|-------|------------|
| P0 | 1 | security, db/migrations |
| P1 | 5 | security, db/migrations, code, performance |
| P2 | 8 | db/migrations, code, tests, ux/api-shape |
| P3 | 1 | code |

**Total Issues**: 15  
**Actionable in <1 day**: 7 (Quick Wins)  
**Requires Design Discussion**: 3 (Atomicity, Optimization, TypeScript)
