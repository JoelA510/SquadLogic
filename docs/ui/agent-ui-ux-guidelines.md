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
