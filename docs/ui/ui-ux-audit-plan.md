# UI/UX Audit Plan – SquadLogic

## 1. Rules Summary

### P0 – Must Fix (Blockers)

- **Accessibility**:
  - Contrast < 4.5:1 (normal text) or < 3:1 (large text).
  - Missing or invisible focus indicators.
  - Keyboard traps or unreachable interactive elements.
  - Missing labels or names for controls (forms, buttons, links, drag targets).
- **Broken Flows**:
  - Dead ends (no way to complete or exit).
  - Unclosable modals or dialogs.
  - Users cannot complete core tasks (team generation, practice or game scheduling).
- **Content**:
  - Unreadable, clipped, or overlapping text.
  - Critical information hidden or inaccessible.
- **Forms**:
  - Missing labels (placeholders != labels).
  - Totally unclear validation messages.

### P1 – Strongly Recommended

- **Layout**:
  - Inconsistent spacing; violations of the 4/8 px spacing scale.
  - Misaligned components, especially in tables and grids.
- **Typography**:
  - Undefined or inconsistent type styles.
  - Poor hierarchy (hard to see what is important).
- **Components**:
  - Inconsistent states (hover, focus, disabled).
  - Missing feedback for async actions (loading/success/error).
- **Navigation**:
  - Unclear active state.
  - Confusing navigation between flows (Team Generation, Practice, Games).
- **Lists/Tables/Grids**:
  - No visual indication of sort/filter.
  - Poor responsiveness or data density issues.
  - Scheduling grids that are hard to scan.

---

## 2. UI Surfaces & Risk Assessment

### Shared & Global (High Priority)

These affect the entire application and should be audited first.

| Component       | Path                    | Description                              | Risk   |
|----------------|-------------------------|------------------------------------------|--------|
| **App Shell**  | `src/App.jsx`           | Main layout, navigation, summary panels. | HIGH   |
| **Global CSS** | `src/index.css`, `src/App.css` | Global variables, base typography, layout primitives. | HIGH   |

### Core Workflows

#### Team Generation

| Component                 | Path                                   | Description                                           | Risk   |
|--------------------------|----------------------------------------|-------------------------------------------------------|--------|
| **Team Overview**        | `src/App.jsx` (Team Overview section)  | Read-only summary of allocator results.               | MEDIUM |
| **Team Persistence**     | `src/components/TeamPersistencePanel.jsx` | Interactive panel for saving/reviewing teams.     | HIGH   |

#### Practice Scheduling

| Component                     | Path                               | Description                                           | Risk   |
|------------------------------|------------------------------------|-------------------------------------------------------|--------|
| **Practice Readiness**       | `src/App.jsx` (Practice Readiness section) | Read-only summary of practice assignments.        | MEDIUM |
| **Practice Insights**        | `src/App.jsx` (Practice Insights section) | Lists of unassigned teams and conflicts.          | MEDIUM |

#### Game Scheduling

| Component                  | Path                                  | Description                                           | Risk   |
|---------------------------|---------------------------------------|-------------------------------------------------------|--------|
| **Game Readiness**        | `src/App.jsx` (Game Readiness section) | Read-only summary of game schedule status.           | MEDIUM |
| **Game Insights**         | `src/App.jsx` (Game Insights section)  | Lists of unscheduled matchups and conflicts.         | MEDIUM |

#### Admin Dashboard

| Component                 | Path                                   | Description                                           | Risk   |
|--------------------------|----------------------------------------|-------------------------------------------------------|--------|
| **Summary Grid**         | `src/App.jsx` (Summary Grid section)   | High-level status cards.                              | LOW    |
| **Roadmap**              | `src/App.jsx` (Roadmap section)        | Project progress tracking.                            | LOW    |

---

## 4. Execution Strategy

- **Inputs**:
  - `docs/ui/ui-ux-pass.md`
  - `docs/ui/ui-ux-pass-summary.md`
  - `docs/ui/ui-ux-polish.md`
  - `docs/ui/ui-ux-rules.json` (if present)

- **Tools**:
  - Browser DevTools (layout and accessibility inspection).
  - Lighthouse / axe DevTools for automated checks.
  - Keyboard-only navigation tests.

- **Outputs**:
  - `docs/ui/ui-ux-audit-issues.md` – canonical issue list with P0/P1/P2 per surface.
  - Optionally `docs/ui/ui-ux-audit-findings.md` – narrative summaries per flow.

Each audit pass should:

1. Select a surface or flow from this plan.
2. Log issues by priority and rule ID.
3. Propose or apply remediation in cohesive patches.
