## Assumptions

* Target repo: `SquadLogic` (React + Vite web admin, standard CSS). 
* You want “best of both worlds”:

  * Keep Gemini’s structure and web focus.
  * Add the scheduling- and data-heavy, flow-specific guidance we discussed earlier.
* No real audit has yet been run for this repo; existing audit docs are templates or from another project.

Below are proposed final versions for each relevant file, ready to drop into `docs/ui/` (or equivalent). Adjust paths if you keep them at repo root.

---

## 1. `ui-ux-pass.md` (Full checklist, repo-specific)

Current file is a good generic web checklist but not yet tuned to scheduling/admin flows or WCAG 2.2. 
Here is a merged, repo-specific version:

```markdown
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
```

---

## 2. `ui-ux-pass-summary.md` (Quick P0/P1)

Gemini’s summary is already good; we just keep it and use it verbatim as your P0/P1 quick reference. 

```markdown
# UI / UX Pass Summary (Web – P0/P1 Focus)

Use this when you need a quick version of the full checklist.

## P0 – Must Fix

- **Accessibility blockers**
  - Text contrast < 4.5:1 (normal) or < 3:1 (large).
  - Interactive elements not keyboard accessible.
  - Missing or invisible focus indicators.
  - Critical actions with click area < 24x24 px and no spacing.
  - Drag-and-drop without an alternative.
  - Forms where labels are missing or only placeholders.

- **Broken flows**
  - Users cannot complete a core task due to UI issues.
  - Navigation dead ends or loops.
  - Modals that trap focus or cannot be closed.

- **Unreadable or confusing content**
  - Body text < 14–16 px without strong reason.
  - Key content clipped, overlapping, or hidden.

## P1 – Strongly Recommended

- **Layout & spacing**
  - Apply 4/8 px spacing scale.
  - Ensure margins and grouping are consistent.

- **Typography & hierarchy**
  - Use defined type styles (display, heading, body, label).
  - Ensure each screen has a clear primary action at a glance.

- **Components & states**
  - Buttons, inputs, lists, modals have consistent radii, padding, and states.
  - Loading, success, and error feedback present for all async actions.

- **Navigation**
  - Active section clearly highlighted.
  - Back navigation works predictably.

- **Forms**
  - Group related fields; use inline, specific error messages.
  - Avoid redundant data entry; use sensible defaults.

- **Tables & dense data**
  - Use semantic tables.
  - Sticky headers or other patterns to preserve context.
  - Clear sort/filter behavior.

## Process

1) Run through 3–5 core flows.
2) Fix all P0 issues.
3) Fix as many P1 issues as possible.
4) Log P2 items (visual polish) as follow-up tasks.
```

---

## 3. `ui-ux-polish.md` (New: SquadLogic-specific)

Current file is AIAdvocate-specific (React Native, Paper, safe areas). 
Below is a web-admin / scheduling-specific version, merging that structure with your earlier requirements.

```markdown
# UI / UX Visual Polish – SquadLogic

This document defines **P2-level visual polish rules** for the SquadLogic web client (React + Vite + CSS). Use it *after* P0/P1 issues from `docs/ui/ui-ux-pass.md` are resolved or explicitly logged.

- P0 / P1 rules in `docs/ui/ui-ux-pass.md` are **higher priority** than anything here.
- Never break accessibility, platform conventions, or performance to achieve cosmetic effects.

Primary surfaces:

- `src/App.jsx` – app shell, dashboard, and main navigation.
- `src/components/**` – shared components (panels, tables, dialogs, filters, charts).
- Any shared CSS (e.g., `src/App.css`, `src/index.css`) and design tokens (CSS variables).

---

## 0. Constraints (Do not break these)

Beautification must **never**:

- Reduce text or UI element contrast below WCAG 2.2 AA.
- Shrink click targets below the minimums in the main UI spec.
- Weaken or remove visible focus indicators.
- Ignore `prefers-reduced-motion` for users who opt out of animation.
- Introduce visual clutter that obscures scheduling information (times, fields, teams).
- Bypass existing CSS variables/tokens in favor of ad-hoc inline styles.

Polish changes should be:

- Implemented via design **tokens** (CSS variables) and **shared components** where possible.
- Cohesive per screen or flow (dashboard, team generation, practice scheduler, match chart).
- Consistent with a modern admin-dash aesthetic: calm neutrals, clear accents, minimal noise.

---

## 1. Theming and Brand Feel

### 1.1 Theme structure

Define your design system in CSS (and/or a theme file):

- **Color tokens**:
  - Primary, secondary.
  - Success, warning, error, info.
  - Surface and background neutrals.
  - Border and divider colors.
- **Typography tokens**:
  - Base font family.
  - Sizes and weights for headings, body, labels, meta text.
- **Elevation tokens**:
  - Shadow styles for cards, overlays, and floating elements.

When polishing visuals:

- Prefer updating tokens in `index.css` / `App.css` (or theme file) over per-component overrides.
- Keep a **neutral, professional** palette suitable for backend admin work:
  - Light, low-saturation backgrounds.
  - Darker text for readability.
  - Limited, meaningful accent colors.

### 1.2 Color and semantic roles

Goals:

- Make it obvious what is **scheduled**, **unscheduled**, **conflicting**, or **locked**.
- Avoid “rainbow UI”; rely on semantic color roles and simple, repeatable patterns.

Rules:

- Use one **primary accent** color for key actions (e.g., "Generate", "Save", "Apply").
- Use secondary accent(s) sparingly (e.g., for secondary actions or status highlights).
- Map statuses to clear, consistent colors:
  - Success: schedule saved, no conflicts.
  - Warning: minor issues, soft constraints violated.
  - Error: conflicts, failed operations.
- Use 5–7 neutral steps for backgrounds, surfaces, and text.

Do not:

- Introduce random hex values in components.
- Use color alone as a status indicator; pair with icons or text.

### 1.3 Light and dark themes (if used)

If you support dark mode:

- Ensure high contrast and legibility in both themes.
- Use lighter borders and subtle elevation changes in dark mode instead of heavy shadows.
- Make sure tables and grids remain clear (no low-contrast row striping or grid lines).

---

## 2. Typography and Visual Hierarchy

### 2.1 Type tokens

- Define typographic roles (in CSS classes or utility styles):
  - Page title.
  - Section heading.
  - Card title.
  - Body text.
  - Label/meta text.
- Ensure each role has:
  - Size.
  - Weight.
  - Line height.
  - Margin defaults.

Apply:

- Page titles for top-level views (Team Generation, Practice Scheduler, Game Scheduler).
- Section headings inside each view (filters, summary, grid, conflicts).
- Body text for detail rows and descriptions.
- Smaller label text for meta info (e.g., field codes, division labels).

### 2.2 Usage and tone

- Use stronger weights/sizes sparingly to avoid “shouting” UI.
- Ensure each page has a clear visual spine:
  - Title.
  - Filters/controls.
  - Main canvas (tables/grids).
- For dense data (tables and grids):
  - Slightly tighten line height while preserving readability.
  - Avoid mixing too many font sizes in one row.

---

## 3. Layout, Spacing, and Density

### 3.1 Spacing scale

- Base on a 4/8 px grid:
  - Small insets: 4–8 px.
  - Standard padding: 12–16 px.
  - Section spacing: 16–24 px.
- Apply consistently to:
  - Cards and panels.
  - Table cell padding.
  - Filter bars and control groups.

### 3.2 Density presets

Define two density levels:

- **Comfortable (default)**:
  - Use for dashboards and configuration forms.
  - More spacing between items and clearer grouping.
- **Compact (opt-in)**:
  - Use for data-heavy tables and match charts where visibility of many rows/slots is critical.
  - Slightly reduced vertical spacing, but:
    - Maintain click targets at least 32–40 px tall.
    - Keep font sizes within the main UI spec.

### 3.3 Scheduling surfaces

For scheduling grids, calendars, and match charts:

- Use a grid layout with clear row/column delineation.
- Provide enough horizontal and vertical padding in cells to keep labels readable.
- Use alternating row shading or column highlighting carefully:
  - Improve scanability, do not overpower content.
- Anchor key columns (e.g., field name, time) visually so users can orient quickly.

---

## 4. Components and Surfaces

### 4.1 Cards and panels

- Use consistent radii, padding, and shadows across cards/panels.
- Common pattern for admin panels:
  - Header: title, quick actions, filters toggle.
  - Body: primary content (tables, grids, details).
  - Footer (optional): totals, secondary actions, pagination.

Polish goals:

- Cards should visually separate from the background but not float excessively.
- Headers should align across a row of cards for a clean grid.

### 4.2 Tables and lists

Polish for data tables:

- Alignment:
  - Numbers right-aligned.
  - Text left-aligned.
  - Status icons in a dedicated column where possible.
- Row visuals:
  - Hover state on desktop.
  - Selected row state (for multi-select operations).
- Header row:
  - Slightly stronger background and typography than body rows.
  - Clear sort indicators (chevrons/arrows with selected state).

### 4.3 Scheduling grids and match charts

- Distinguish different states with subtle visual cues:
  - Scheduled: filled cell color and label.
  - Unscheduled: outlined, empty states.
  - Conflicting: error-color border and/or icon.
  - Locked: subtle lock icon and non-editable styling.
- Ensure:
  - Hover and focus states do not obscure cell labels.
  - Drag previews are visually distinct and do not jitter.

---

## 5. Motion and Microinteractions

### 5.1 Durations and easing

Use a small set of motion tokens:

- Micro-feedback (button press, toggle): 100–150 ms.
- Panel/table transitions (filter apply, expand/collapse): 150–220 ms.
- Dialogs and overlays: 200–300 ms.

Use easing functions that:

- Ease out on entry (slightly snappy).
- Ease in on exit.
- Avoid linear transitions for major UI elements.

### 5.2 Where to animate

Good candidates:

- Button press visual feedback.
- Filter panels opening/closing.
- Toast notifications sliding in/out.
- Row or card hover transitions (shadow, background).

Avoid:

- Continuous animations in primary scheduling views.
- Large, attention-grabbing effects that make it harder to read tables or grids.

### 5.3 Reduced motion

When `prefers-reduced-motion` is enabled:

- Disable or greatly reduce non-essential animations.
- Keep core feedback (e.g., toasts, state changes) but without big transitions.

---

## 6. Iconography and Illustration

### 6.1 Icons

- Use one primary icon set (outline or filled) to avoid style clashes.
- Keep icon sizes consistent (e.g., 16/20/24 px).
- Use icons for:
  - Navigation (sections of the app).
  - Actions (edit, delete, lock, unlock).
  - Status (conflict, success, warning).

Ensure:

- Icons have sufficient contrast.
- Tooltip or label is available where meaning is not obvious.

### 6.2 Illustrations and empty states

- Use light-weight illustrations only where they add clarity:
  - Onboarding.
  - Empty states (no teams, no practices generated, no games scheduled).
- Style:
  - Minimal, using the same color palette as the app.
- Do not:
  - Overuse illustrations on dense admin screens.
  - Let illustrations compete with key scheduling information.

---

## 7. Empty, Loading, and Error States (Polish Layer)

### 7.1 Empty states

Pattern:

- Simple icon/illustration.
- Short title (one line).
- One sentence explanation.
- Clear primary action (e.g., "Import registrations", "Generate matches").

Use consistent layout and typography across all empty states.

### 7.2 Loading states

- Use skeletons for:
  - Dashboards.
  - Large tables.
  - Grids.
- Use spinners only for small, localized operations.
- Avoid full-page spinners without any context.

### 7.3 Error states

- For global errors (failed schedule generation):
  - Use a prominent banner or panel with icon + title + message + possible next steps.
- For inline errors:
  - Align them consistently below the affected fields or rows.
  - Use the same color and typography for all error text.

---

## 8. Process: How to Apply Visual Polish

When asked to “beautify” or apply “visual polish”:

1. **Confirm P0/P1**
   - Ensure P0 and P1 issues in the target area are already fixed or clearly logged.

2. **Identify scope**
   - Which screens/flows (e.g., Team Generation, Practice Scheduler, Match Chart).
   - Which shared components and CSS variables are involved.

3. **Refine tokens first**
   - Adjust shared CSS variables and global styles (colors, typography, radii, shadows, motion) where appropriate.

4. **Update components**
   - Apply spacing, alignment, icon, and motion improvements in shared components (`src/components/**`).

5. **Screen-level tweaks**
   - Adjust layout, density, and groupings on specific pages.
   - Ensure scheduling surfaces remain clear and scannable.

6. **Verify**
   - Re-check contrast and accessibility.
   - Test on at least:
     - Desktop (primary target).
     - One smaller viewport for responsive behavior.
   - Confirm that reduced-motion preferences are respected where applicable.

---

## 9. Sanity Check

- If a proposed visual change conflicts with:
  - WCAG 2.2 AA,
  - Core UX heuristics,
  - The main UI checklist in `ui-ux-pass.md`,

  then **do not make** that change.

- All P2 polish should make the interface:
  - More consistent.
  - Easier to scan.
  - More efficient for schedulers.
  - Equally or more accessible than before.
```

---

## 4. `agent-ui-ux-guidelines.md` (Gemini workspace instructions)

Current agent instructions are solid but generic and unaware of flows or polish doc. 
Below is a merged version that keeps the concise style but adds flow awareness and polish behavior.

```markdown
# Agent Workspace Instructions – UI/UX Guidelines (SquadLogic)

## Role and Scope

You are a senior frontend engineer working in the Antigravity AI IDE on the `SquadLogic` repository.

SquadLogic is a React Web application built with:

- **Vite** (build tool).
- **React** (UI library).
- **Standard CSS** (styling via `App.css`, `index.css`, and component-level styles).
- **Supabase** (backend/persistence – current or future integration).

When the user asks you to perform any "UI/UX pass", mentions "UI/UX checklist", or requests "visual polish"/"beautification", you must follow:

- `docs/ui/ui-ux-pass.md` as the canonical P0/P1 UI/UX checklist.
- `docs/ui/ui-ux-pass-summary.md` as the quick reference for P0/P1.
- `docs/ui/ui-ux-polish.md` as the P2 visual polish guide.
- `docs/ui/ui-ux-rules.json` (if present) as the rule ID reference.

Your primary focus is:

- Semantic HTML and landmarks.
- CSS architecture and responsive layout.
- Visual hierarchy and clarity in data-heavy scheduling views.
- Feedback and interaction states.
- Accessibility (WCAG 2.2 AA) and keyboard/screen reader support.

---

## Rules

1. Use the checklist documents

- Before making UI changes, open:
  - `docs/ui/ui-ux-pass.md`
  - `docs/ui/ui-ux-pass-summary.md`
- When working on beautification, also open:
  - `docs/ui/ui-ux-polish.md`
- Treat these as the source of truth for:
  - Layout, spacing, typography.
  - Color/contrast and theming.
  - Components and states.
  - Navigation, tables, grids.
  - Accessibility and motion.

2. Flows and components

When asked to run a UI/UX pass on a view or component:

1. Identify the relevant files (e.g., `src/App.jsx`, `src/components/**`, related CSS).
2. Determine which flow they belong to:
   - Team Generation.
   - Practice Scheduling.
   - Game Scheduling.
   - Admin shell (navigation, dashboards).
3. Compare the implementation against the checklist and, if relevant, the polish guide.
4. List issues grouped by priority (P0, P1, P2), referencing rule IDs from `docs/ui/ui-ux-rules.json` when applicable.
5. Propose or apply code changes that fix **P0 and P1 issues first**.

3. Accessibility and standards

- Ensure all interactive elements are keyboard accessible and have visible focus.
- Maintain sufficient color contrast (WCAG 2.2 AA).
- Use semantic HTML:
  - `<header>`, `<main>`, `<nav>`, `<section>`, `<article>`, `<footer>` where appropriate.
- Provide non-drag alternatives for any drag-and-drop interactions in scheduling grids.

4. Design system alignment

- Reuse existing CSS classes and variables defined in `App.css` and `index.css`.
- Prefer updating shared variables/tokens and shared components over one-off inline styles.
- Maintain consistency with the existing admin-dashboard aesthetic while aligning with the checklist and polish docs.
- Do not introduce new colors, spacings, or radii when equivalent tokens already exist.

5. Change management

- Keep changes cohesive and scoped to the requested surfaces (a particular flow, page, or component set).
- Verify that changes do not break existing functionality.
- When feasible, add/update:
  - Accessibility checks (e.g., run axe/Lighthouse).
  - Component or snapshot tests relevant to the UI changes.
- Explain how each change maps back to checklist or polish rules (e.g., "fixes P0: focus_visible", "improves P2: spacing_density").

---

## Visual Polish / Beautification

When the user requests “beautification”, “visual polish”, or similar:

- First confirm that P0/P1 issues for the target surface are resolved or explicitly logged.
- Then apply P2-level improvements using `docs/ui/ui-ux-polish.md`:

  - Adjust design tokens (colors, spacing, radii, shadows, motion) where appropriate.
  - Improve spacing and alignment in cards, tables, and scheduling grids.
  - Clean up icon usage and empty/loading/error states.

Constraints:

- Do NOT:
  - Lower contrast.
  - Shrink click targets below the checklist minimums.
  - Remove or weaken focus indicators.
- Do NOT compromise:
  - Performance (e.g., huge new bundles just for visuals).
  - Security or privacy.
- Prefer:
  - Shared token and component changes over local hacks.

---

## Invocation Examples

The following user requests should trigger a UI/UX pass based on `docs/ui/ui-ux-pass.md` and, if applicable, `docs/ui/ui-ux-polish.md`:

- "Run a UI/UX pass on the main dashboard."
- "Check the Team Persistence Panel and related scheduling grids for accessibility issues."
- "Review the practice scheduling flow and bring it in line with our UI/UX checklist."
- "Polish the match chart visuals without breaking accessibility."
- "Apply visual polish to the admin shell navigation and summary panels."

For each, explicitly open the relevant files and the UI/UX docs, then perform the pass in this order:

1. Identify and fix P0 issues.
2. Address P1 issues within scope.
3. Apply optional P2 polish if requested.
```

---

## 5. Audit docs

Your existing audit docs are mostly templates and, in the case of `ui-ux-audit-findings.md`, still reference the AIAdvocate project.

### 5.1 `ui-ux-audit-plan.md` (specialize to this app)

```markdown
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
| **Team Generation View** | `src/components/TeamGeneration*.jsx`   | Core team allocation UI and data summaries.           | HIGH   |
| **Team Persistence**     | `src/components/TeamPersistencePanel.jsx` | Saving and reviewing generated teams.             | HIGH   |
| **Diagnostics/Insights** | `src/components/*Diagnostics*.jsx`     | Conflict, count, and quality metrics.                 | MEDIUM |

#### Practice Scheduling

| Component                     | Path                               | Description                                           | Risk   |
|------------------------------|------------------------------------|-------------------------------------------------------|--------|
| **Practice Scheduler View**  | `src/components/PracticeScheduler*.jsx` | Field/time grid for practices.                    | HIGH   |
| **Practice Metrics/Overview**| `src/components/*PracticeMetrics*.jsx`  | Summary of allocations, conflicts, utilization.  | MEDIUM |

#### Game Scheduling

| Component                  | Path                                  | Description                                           | Risk   |
|---------------------------|---------------------------------------|-------------------------------------------------------|--------|
| **Game Scheduler / Chart**| `src/components/GameScheduler*.jsx`   | Match chart, rounds, and field/time slots.           | HIGH   |
| **Game Persistence**      | `src/components/*GamePersistence*.jsx`| Persisting and exporting game schedules.             | MEDIUM |

*(Adjust component paths to match the actual project structure.)*

---

## 3. Recommended Audit Order

1. **Global & Shared**
   - Audit `src/App.jsx`, `src/index.css`, and `src/App.css`.
   - Rationale: fixes here propagate across flows.

2. **Team Generation & Team Persistence**
   - Deep dive into team allocation UIs and persistence panel.
   - Focus on layout, states, and accessibility for controls and tables.

3. **Practice Scheduling**
   - Audit practice scheduler grids and related panels for scanability and keyboard access.

4. **Game Scheduling**
   - Audit match chart and any game schedule views (tables, grids, dialogs).

5. **Polish / Low-Risk Views**
   - Non-critical dashboards, roadmap/summary sections, and secondary screens.

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
```

### 5.2 `ui-ux-audit-issues.md` (canonical issue list template)

Keep the structure but tie it explicitly to this repo and the new plan. 

```markdown
# UI/UX Audit Issues – SquadLogic

This document tracks UI/UX issues discovered during audit passes, grouped by surface and priority. Use it with:

- `docs/ui/ui-ux-pass.md` – full checklist.
- `docs/ui/ui-ux-pass-summary.md` – P0/P1 summary.
- `docs/ui/ui-ux-audit-plan.md` – surfaces and ordering.

---

## Summary

| Priority | Count |
| :-------| :-----|
| **P0**  | 0     |
| **P1**  | 0     |
| **P2**  | 0     |

Update this table as issues are logged and resolved.

---

## Status Update

**No active audit session.**

During an audit, update this section with:

- Current surface(s) being audited.
- Date and short notes.

---

## Global & Shared Components

### Component Name (`path/to/component`)

- **Files**: `path/to/component`
- **Issues**:
  - [ ] `rule_id` (P0/P1/P2): Description of issue.
      - *Fix*: Proposed or applied fix.
      - *Notes*: Any relevant details (e.g., requires design decision).

---

## Core Workflows

Repeat the pattern below for each surface defined in `ui-ux-audit-plan.md`.

### Surface: Team Generation – Main View

- **Files**: `src/components/...`
- **Issues**:
  - [ ] `rule_id` (Priority): Description of issue.
      - *Fix*: Proposed or applied fix.

### Surface: Team Persistence Panel

- **Files**: `src/components/TeamPersistencePanel.jsx`
- **Issues**:
  - [ ] `rule_id` (Priority): Description of issue.
      - *Fix*: Proposed or applied fix.

### Surface: Practice Scheduler

- **Files**: `src/components/...`
- **Issues**:
  - [ ] `rule_id` (Priority): Description of issue.
      - *Fix*: Proposed or applied fix.

### Surface: Game Scheduler / Match Chart

- **Files**: `src/components/...`
- **Issues**:
  - [ ] `rule_id` (Priority): Description of issue.
      - *Fix*: Proposed or applied fix.
```

### 5.3 `ui-ux-audit-findings.md` (narrative, reset from AIAdvocate)

Current file still references `mobile-app/...` from AIAdvocate. 
Reset it as a narrative findings doc:

```markdown
# UI/UX Audit Findings – SquadLogic

This document provides **narrative summaries** of UI/UX audit findings for SquadLogic. It complements:

- `docs/ui/ui-ux-audit-plan.md` – which surfaces to audit and in what order.
- `docs/ui/ui-ux-audit-issues.md` – detailed, per-issue tracking.

Use this file to record high-level conclusions after each audit pass, focusing on patterns and cross-cutting themes rather than individual issues.

---

## 1. Global & Shared Components

### App Shell and Global Styles

- **Summary**:
  - High-level notes about layout, typography, and color usage across the app.
- **Strengths**:
  - Bullets for what is working well.
- **Risks / Themes**:
  - Bullets for recurring problems impacting multiple flows.

---

## 2. Team Generation Flow

### Overall UX

- **Summary**:
  - How easy it is to allocate teams, review results, and resolve conflicts.
- **Key Findings**:
  - P0 themes (if any).
  - P1 themes (layout, clarity, feedback).
  - P2 opportunities (visual polish, density tweaks).

---

## 3. Practice Scheduling Flow

### Overall UX

- **Summary**:
  - How clear the practice scheduler is for admins.
- **Key Findings**:
  - Notable improvements or issues in grids, tables, and filters.

---

## 4. Game Scheduling Flow

### Overall UX

- **Summary**:
  - Experience of creating and adjusting game schedules.
- **Key Findings**:
  - Clarity of match charts, conflict visualization, and controls.

---

## 5. Cross-Cutting Themes and Recommendations

- **Patterns**:
  - Cross-flow issues (e.g., inconsistent button styles, recurring a11y problems).
- **Prioritized Remediation**:
  - Short list of the most impactful follow-up changes across the codebase.
- **Future Opportunities**:
  - Ideas for enhancements beyond the immediate scope of the current audit.
```

### 5.4 `ui-ux-audit-verification.md` (verify fixes)

Current file is a generic template; keep the structure but align with these docs. 

```markdown
# UI/UX Audit Verification Report – SquadLogic

**Date:** YYYY-MM-DD  
**Status:** PENDING

This document verifies fixes applied to address the issues identified in:

- `docs/ui/ui-ux-audit-issues.md`
- `docs/ui/ui-ux-audit-findings.md`

---

## Summary

| Priority | Status   | Notes |
| :-------| :--------| :-----|
| **P0**  | PENDING  |       |
| **P1**  | PENDING  |       |
| **P2**  | OPTIONAL |       |

Update this table as verification proceeds.

---

## Surface Verification

Use one section per surface from `ui-ux-audit-plan.md`.

### 1. Global & Shared Components

#### App Shell (`src/App.jsx`, `src/index.css`, `src/App.css`)

- **Compliance**: PENDING
- **Verification**:
  - [ ] All P0 issues from `ui-ux-audit-issues.md` resolved.
  - [ ] All agreed P1 issues resolved or explicitly deferred.
  - [ ] No new P0 regressions introduced.

**Notes:**
- …

---

### 2. Team Generation Flow

#### Team Generation Screens and Components

- **Compliance**: PENDING
- **Verification**:
  - [ ] P0 issues resolved.
  - [ ] P1 issues addressed where in scope.
  - [ ] Keyboard and screen-reader behavior rechecked.

**Notes:**
- …

---

### 3. Practice Scheduling Flow

*(Repeat the same pattern.)*

---

### 4. Game Scheduling Flow

*(Repeat the same pattern.)*

---

## Overall Verification Notes

- Summarize:
  - Any remaining P0/P1 issues.
  - Known P2 items intentionally left for polish.
  - Lessons learned for future UI/UX work.
```

---

## Sanity Check

1. **Verify**

* The new `ui-ux-pass.md` keeps Gemini’s structure but now:

  * Targets a desktop-first scheduling/admin app.
  * Explicitly covers tables, scheduling grids, and WCAG 2.2. 
* `ui-ux-pass-summary.md` remains a good P0/P1 quick reference, unchanged. 
* `ui-ux-polish.md` has been rewritten from the AIAdvocate version into a web-admin, scheduling-specific polish layer while preserving the clear constraints and process. 
* `agent-ui-ux-guidelines.md` now:

  * References all three docs (pass, summary, polish).
  * Understands your key flows and data-heavy surfaces. 
* Audit docs are now aligned with this repo instead of AIAdvocate and include explicit references to your flows and components.

2. **Edge case**

* Risk: these docs still reference component names/paths that do not exactly match your current code.
* Handling: treat all `*.jsx` paths in the docs as guidance; adjust them to the actual filenames/locations in the repo as you evolve the codebase.

3. **Efficiency**

* Most future UI/UX work will be:

  * O(1) to re-use the docs.
  * O(k) in number of affected screens/components per audit batch.
* By centralizing polish in tokens/components, most P2 improvements become O(c) in number of shared components rather than across every screen.
