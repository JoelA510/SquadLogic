# E2E Test Plan: Timezone & Multi-Org Verification

## 1. Timezone & School Hours (R3)

### Scenario A: Local Time Display
*   **Setup**:
    *   Set Season A Timezone to `America/New_York`.
    *   Set Season B Timezone to `America/Los_Angeles`.
*   **Action**: Create a practice slot for 5:00 PM in both seasons.
*   **Verification**:
    *   View Season A schedule. Slot should appear as 5:00 PM EST.
    *   View Season B schedule. Slot should appear as 5:00 PM PST.
    *   (Advanced) Change user machine timezone. The web app should ideally convert to *League Time* or clearly indicate the offset. NOTE: Current implementation renders in browser local time or league time depending on frontend logic. Confirmed behavior: Frontend currently accepts input and saves. Display logic in `PracticeReadinessPanel` or `Calendar` needs to use `season_settings.timezone` for strict correctness.

### Scenario B: School Hours Enforcement
*   **Setup**: Set `school_day_end` to `16:00` (4 PM).
*   **Action**:
    *   Create `Slot 1`: Monday 15:00 (3 PM).
    *   Create `Slot 2`: Monday 17:00 (5 PM).
    *   Run Scheduler.
*   **Verification**:
    *   `Slot 1` is **IGNORED** (assigned count 0).
    *   `Slot 2` is **USED**.

## 2. Multi-Organization Data Isolation (R4)

### Scenario C: Cross-Org Data Leakage
*   **Setup**:
    *   DB contains `Org A` (id=1) and `Org B` (id=2).
    *   User `Coach A` belongs to `Org A`.
*   **Action**: `Coach A` attempts to view Teams list.
*   **Verification**:
    *   Query returns only teams associated with `Org A`.
    *   Direct API call to fetch `Org B` team returns 403 Forbidden or empty set (RLS).

## 3. Operations & Migration

### Scenario D: Daylight Savings
*   **Action**: Simulate date change across DST boundary (e.g., Nov 3rd).
*   **Verification**:
    *   Practice slots remain at the same *local* hour (e.g., 5 PM) even if UTC offset shifts.
    *   (Requires backend logic to generate recurrence rules based on local time, not fixed UTC).

## Automated Test Matrix
| Feature | Type | Status | File |
| :--- | :--- | :--- | :--- |
| School Hour Filtering | Unit | ✅ Passed | `tests/practiceSchedulingTimezone.test.js` |
| Timezone Display | Visual | ⚠️ Pending | Frontend UI inspection required |
| Multi-Org RLS | Integration | ⏳ Pending | `organizations` table populated & RLS enabled |
