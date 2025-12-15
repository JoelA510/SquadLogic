# Self-Review Checklist

**PR**: [Insert Branch Name]
**Epic**: [Insert Epic Name]

## 1. Correctness & Logic
- [ ] Does the code meet the Acceptance Criteria?
- [ ] Are edge cases handled (null, undefined, loading, error)?
- [ ] Is the data flow unidirectional and clear?

## 2. Security (RLS)
- [ ] **Supabase RLS**: Are RLS policies enabled on new tables?
- [ ] **Isolation**: Can User A access User B's data? (Must be NO).
- [ ] **Input Validation**: Are API inputs validated (Zod/manual)?

## 3. Quality & Tests
- [ ] **Tests**: Are there unit tests for logic?
- [ ] **Linting**: Did `npm run lint` pass?
- [ ] **Formatting**: Is code formatted?

## 4. Performance
- [ ] **N+1 Queries**: Are database queries optimized?
- [ ] **Bundle Size**: Any large dependencies added unnecessarily?

## 5. Rollback
- [ ] Is there a migration down-script or is it safe to revert code?
