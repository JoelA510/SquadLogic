# UI / UX Pass Checklist – SquadLogic (Web)

## 0. Purpose and Scope

When you are asked to "do a full UI/UX pass", follow this checklist.

Goals:

- Make the product usable, consistent, and modern for **league/club admins and schedulers**.
- Meet or exceed **WCAG 2.2 AA** accessibility.
- Ensure responsive behavior across **Desktop (primary)**, Tablet, and Mobile.
- Enforce a single design language through shared CSS variables, components, and patterns.
- Support **data-heavy scheduling workflows** (teams, fields, practices, games) without sacrificing clarity.

Applies to:

- All UI code (`src/App.jsx`, `src/components/**`, `src/index.css`, `src/App.css`, and any other frontend entry points).
- Primary workflows:
  - Importing and validating GotSport CSV or roster data.
  - **Team Generation** (allocations, overrides, diagnostics).
  - **Practice Scheduling** (field/time grids, constraints, metrics).
  - **Game Scheduling** (rounds, match charts, conflict resolution).
  - Admin shell (navigation, status dashboards, exports).

---

## 1. Heuristic and Standards Layer

Use these as the lens for all checks.

### 1.1 Usability Heuristics

1) **Visibility of system status**
- Show progress for long operations (loading spinners, skeletons, progress bars).
- Display success/failure clearly (toasts, inline alerts, status banners).
- For batch operations (e.g., "Generate schedule", "Apply allocator"), show:
  - In-progress state.
  - Final result (including counts affected).

2) **Match with real-world language**
- Use domain terms users already know (e.g., "Roster", "Schedule", "Division", "Field", "Match").
- Avoid internal jargon (e.g., "RPC", "Snapshot ID") unless clearly explained.
- Use labels that match how schedulers talk about work (e.g., "Unassigned Teams", "Conflicts", "Locked Games").

3) **User control and freedom**
- Provide cancel/undo where feasible for destructive or bulk actions.
- Allow users to navigate back easily (browser back, breadcrumb, clear "Back" / "Cancel" actions).
- Avoid irreversible actions without confirmation (especially on generated schedules).

4) **Consistency and standards**
- Same pattern, label, and icon mean the same thing everywhere.
- Use standard web patterns:
  - Links for navigation (`<a>` / `Link`).
  - Buttons for actions.
- Use consistent terms across screens ("Team", "Game", "Practice" – not mixed synonyms).

5) **Error prevention**
- Use safe defaults (e.g., preselect season, field groups).
- Confirm destructive actions (e.g., "Are you sure you want to clear this schedule?").
- Validate inputs early (e.g., date ranges, time overlaps, field capacities).

6) **Recognition vs recall**
- Prefer visible options over requiring memorization:
  - Make filters, field lists, and division selectors visible where practical.
- Use overviews (e.g., field lists, team counts) so users do not have to remember details.

7) **Flexibility and efficiency**
- Provide shortcuts or batch actions for expert users:
  - "Select all teams in division", "Apply same time slot to all".
- Allow multi-select where it is safe and useful (teams, matches, fields).

8) **Aesthetic and minimalist design**
- Remove redundant text and decoration.
- Keep screens focused on primary tasks:
  - Team assignment.
  - Practice layout.
  - Game layout.
- Avoid overloading the main canvas with rarely used options; move them to sidebars or dialogs.

9) **Error diagnosis and recovery**
- Errors clearly state:
  - What went wrong (e.g., "This field is already in use at 5:00 PM").
  - What to do (e.g., "Choose a different time or field").
- For validation errors across large forms or grids, provide a summary and highlight the affected rows/cells.

10) **Help and documentation**
- Inline help where needed (tooltips, helper text).
- For complex concepts (constraints, scheduling rules), link to deeper docs or show expandable explanations.

### 1.2 WCAG 2.2 AA Key Points

- **Contrast**:
  - Text and essential UI elements meet 4.5:1 contrast ratio (3:1 for large text).
- **Focus visible**:
  - All interactive elements have a visible focus state (outline/ring) with sufficient contrast.
- **Target size**:
  - Clickable targets are at least 24x24px (prefer 32–40px for desktop scheduling grids).
- **Semantic HTML**:
  - Use `<button>`, `<a>`, `<input>`, `<label>`, `<header>`, `<main>`, `<nav>`, `<section>`, `<footer>`.
- **Alt text**:
  - All meaningful images/icons have descriptive `alt` or are described by nearby text.
  - Decorative images/icons use `alt=""` or `aria-hidden="true"`.
- **ARIA**:
  - Use ARIA roles/labels only when semantic HTML is insufficient.
  - For dynamic updates (e.g., schedule generation complete), use `aria-live` where appropriate.

---

## 2. Layout, Spacing, and Responsive Behavior

### 2.1 CSS Architecture

- Use CSS variables for theme values (colors, spacing, fonts).
- Avoid inline styles except for truly dynamic values; prefer classes.
- Use Flexbox and Grid for layouts (dashboard shells, tables, scheduling canvases).
- Keep layout concerns in CSS (or utility classes) instead of sprinkling layout styles in many components.

### 2.2 Spacing Scale

- Use a consistent spacing scale (e.g., 4px, 8px, 12px, 16px, 24px, 32px).
- Apply consistently to:
  - Padding inside cards, panels, and table cells.
  - Margins between form fields and sections.
  - Gaps between grid items (cards, summary blocks).
- Group related content closely; separate unrelated groups with larger gaps.

### 2.3 Responsive Design

- **Desktop-first**: Optimize for widescreen admin use first, then ensure functional Tablet and Mobile layouts.
- **Breakpoints** (guideline):
  - Mobile: < 600px.
  - Tablet: 600–1024px.
  - Desktop: > 1024px.
- **Behavior**:
  - On smaller viewports:
    - Complex tables may scroll horizontally with clear indication.
    - Panels may stack vertically instead of side-by-side.
  - Hide only non-critical decorative elements on smaller screens; core controls must remain reachable.

---

## 3. Typography and Hierarchy

### 3.1 Type Scale

- Define a type scale via CSS variables or utility classes:
  - `--font-size-xs`, `--font-size-sm`, `--font-size-md`, `--font-size-lg`, `--font-size-xl`.
- Use standard font weights (400, 500, 600, 700).
- Reserve larger sizes for:
  - Page titles.
  - Major section headers (e.g., "Team Generation", "Practice Scheduler").
- Ensure body text is at least 14–16px and easily readable.

### 3.2 Visual Hierarchy

- Use `<h1>` for the main page title (one per page).
- Use `<h2>`–`<h4>` for section headings (e.g., "Division settings", "Unassigned teams", "Match chart").
- Make headings visually distinct from body text (size, weight, spacing).
- Ensure each page:
  - Has a clear primary action (e.g., "Generate teams", "Save schedule").
  - Uses consistent placement for primary actions (right/top or bottom-right).

---

## 4. Color, Contrast, and Theming

### 4.1 Contrast

- **Text**:
  - Maintain 4.5:1 contrast against background (3:1 for large text).
- **UI Components**:
  - Borders, icons, and indicators at least 3:1 contrast against adjacent colors.
- Avoid relying solely on low-contrast grays for important content.

### 4.2 Semantic Colors

Define color roles and apply consistently:

- **Primary**: Main actions (e.g., "Generate", "Save", "Apply changes").
- **Secondary**: Supporting actions (e.g., "Cancel", "Back").
- **Success**: Positive outcomes (e.g., "Schedule saved").
- **Warning**: Cautionary states (e.g., "Field near capacity").
- **Error**: Critical issues (e.g., "Time conflict", "Failed to save").
- **Neutral**: Text, backgrounds, borders, grid lines.

Do not:

- Introduce ad-hoc hex colors scattered across components.
- Use color alone to indicate status; pair it with icons or labels (e.g., conflict icon plus red color).

---

## 5. Components and States

### 5.1 Interactive Elements

- **Buttons**:
  - Distinct styles for Primary, Secondary, and Destructive actions.
  - States: default, hover, focus, active, disabled, loading.
  - Use icons sparingly and consistently positioned.
- **Inputs**:
  - Clear labels associated via `<label for="...">` or ARIA.
  - Visible focus states that stand out from hover.
  - Error states with descriptive messages and, where possible, icons.
- **Links**:
  - Visually distinct from regular text (underline and/or color).
  - Provide hover and focus states.

### 5.2 Feedback

- **Loading**:
  - Spinners/skeletons for async operations > ~500 ms.
  - Skeletons for data-heavy tables/panels.
- **Success**:
  - Toast or inline success messages for key actions (generate, save, publish).
- **Error**:
  - Inline error messages near the affected component (field or grid).
  - Aggregated error summary for large forms or schedule operations.

---

## 6. Forms and Data Entry

- **Labels**:
  - Always visible; do not rely solely on placeholders.
- **Validation**:
  - Real-time or on-blur validation where helpful (dates, times, numeric caps).
  - Avoid noisy per-keystroke validation on complex inputs.
- **Error Messages**:
  - Clear and actionable, near the field and/or summarized at the top.
- **Input Types**:
  - Use correct `type` attributes (`email`, `tel`, `number`, `date`, `time`).
- **Autocomplete**:
  - Use `autocomplete` where appropriate (e.g., contact info).
- **Redundant Entry**:
  - Avoid asking the user for data you already know (season, club, division) unless there is a clear reason.

---

## 7. Lists, Tables, and Scheduling Grids

### 7.1 Tables

- Use semantic HTML:
  - `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>`.
- Ensure:
  - Headers are associated with cells (`scope`, `headers` attributes where necessary).
  - Sortable columns show sort indicators and direction.
  - Filters are clearly associated with results.
- Data density:
  - Maintain row height sufficient for 24x24px click targets (prefer ~40–44px).
  - Avoid cramming too many columns; consider column grouping or horizontal scrolling with sticky header.

### 7.2 Scheduling Grids and Match Charts

For time/field grids and match charts:

- Make the grid structure obvious:
  - Clear separation between fields and time slots.
  - Distinct background for scheduled vs empty cells.
- States:
  - Represent "unscheduled", "scheduled", "conflict", and "locked" with both color and iconography.
- Drag-and-drop (if used):
  - Provide visible handles or clear affordances.
  - Highlight drop targets on hover/drag.
  - Ensure there is a non-drag alternative for accessibility (e.g., controls to assign teams via forms or menus).
- Responsiveness:
  - On smaller screens, allow horizontal scroll and/or alternative condensed views (e.g., per-field list).

### 7.3 Lists

- Use `<ul>`/`<ol>` for lists.
- Keep spacing between items consistent.
- For complex row content (e.g., team cards), use a card-like pattern with clear hierarchy.

---

## 8. Accessibility (A11y)

- **Keyboard Navigation**:
  - Ensure logical tab order.
  - No keyboard traps (modals must be escapable).
  - All interactive elements must be focusable and operable via keyboard.
- **Screen Readers**:
  - Use semantic HTML first.
  - Provide `aria-label`/`aria-labelledby` where visual labels differ.
  - Use `aria-live` for important updates (e.g., "Schedule generated with 3 conflicts").
- **Focus Management**:
  - On dialogs/modals:
    - Trap focus while open.
    - Return focus to the triggering control on close.
- **Pointer/Gesture Alternatives**:
  - Provide non-drag alternatives for any drag-and-drop interactions (buttons, menus).

---

## 9. How to Run a UI/UX Pass

1) **Select a flow/page**:
   - Example: "Team Generation", "Practice Scheduler", or "Match Chart".
2) **Check layout & responsive behavior**:
   - Inspect spacing and alignment.
   - Resize browser to tablet/mobile widths and ensure core functionality remains usable.
3) **Check typography & color**:
   - Verify hierarchy is clear.
   - Confirm contrast meets WCAG 2.2 AA.
4) **Check components & states**:
   - Test hover, focus, active, and disabled states for interactive elements.
   - Check feedback for async actions and errors.
5) **Accessibility sweep**:
   - Navigate via keyboard only (Tab, Shift+Tab, Enter, Space, Esc).
   - Run an automated tool (Lighthouse, axe DevTools) and address major findings.
6) **Log issues**:
   - Group by P0 (blocker), P1 (major), P2 (minor/polish).
   - Record in `docs/ui/ui-ux-audit-issues.md` and/or `docs/ui/ui-ux-audit-findings.md` with component and file references.
