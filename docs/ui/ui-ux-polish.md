# UI / UX Visual Polish – GotSportTeamerScheduler

This document defines **P2-level visual polish rules** for the GotSportTeamerScheduler web client (React + Vite + CSS). Use it *after* P0/P1 issues from `docs/ui/ui-ux-pass.md` are resolved or explicitly logged.

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
