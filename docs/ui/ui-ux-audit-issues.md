***

# UI/UX Audit Issues – SquadLogic

This document tracks UI/UX issues discovered during audit passes, grouped by surface and priority. Use it with:

- `docs/ui/ui-ux-pass.md` – full checklist.
- `docs/ui/ui-ux-pass-summary.md` – P0/P1 summary.
- `docs/ui/ui-ux-audit-plan.md` – surfaces and ordering.

---

## Summary

| Priority | Count |
| :-------| :-----|
| **P0** | 0     |
| **P1** | 0     |
| **P2** | 0     |

Update this table as issues are logged and resolved.

---

## Status Update

**No active audit session.**

During an audit, update this section with:

- Current surface(s) being audited.
- Date and short notes.

---

## Global & Shared Components

### App Shell & Global Styles

- **Files**: `src/App.jsx`, `src/App.css`, `src/index.css`
- **Issues**:
  - [x] `a11y_focus` (P0): Missing global `:focus-visible` styles. Interactive elements rely on browser defaults which may be invisible on dark backgrounds.
      - *Fix*: Add `:focus-visible` outline styles in `index.css` using a high-contrast color.
  - [x] `css_tokens` (P1): Inconsistent use of CSS variables vs hex codes (e.g., `#0b172a`, `#f8fafc`).
      - *Fix*: Define and use `--color-bg-app`, `--color-text-primary` etc. in `App.css`.
  - [x] `css_spacing` (P1): Hardcoded spacing/radius values (e.g., `0.85rem`, `1.25rem`) instead of a consistent scale.
      - *Fix*: Standardize on 4px grid (0.25rem, 0.5rem, 1rem, etc.).

---

## Core Workflows

### Surface: Team Generation – Main View

- **Files**: `src/App.jsx` (Team Overview section)
- **Issues**:
  - [ ] `layout_density` (P1): "Team formation snapshot" header text is quite wide (`max-width: 460px` might be too narrow for the available space on desktop).
      - *Fix*: Adjust max-width or layout for better desktop utilization.

### Surface: Team Persistence Panel

- **Files**: `src/components/TeamPersistencePanel.jsx`
- **Issues**:
  - [x] `a11y_contrast` (P1): Verify contrast of status pills (e.g., `#6ee7b7` on dark bg) meets 4.5:1.
      - *Fix*: Check ratios and adjust text lightness if needed.
  - [x] `component_consistency` (P1): Button styles (`persistence-button`, `persistence-action`) define their own shadows/transitions instead of sharing a token.
      - *Fix*: Extract shared button classes or mixins if possible, or align values.
  - [x] `visual_polish` (P2): "Simulated Supabase persistence" message is low prominence.
      - *Fix*: Style as a distinct banner or alert if it's an important system state.

### Surface: Practice Scheduler

- **Files**: `src/App.jsx` (Practice Readiness & Insights)
- **Issues**:
  - [x] `layout_density` (P1): Header description text constrained to `460px`, leaving excessive whitespace on desktop.
      - *Fix*: Increase max-width to `640px` or `65ch` for better readability and space utilization.
  - [x] `a11y_structure` (P2): Insight articles (`InsightSection`) lack `aria-labelledby` connecting the article to its heading.
      - *Fix*: Add `id` to `h3` and `aria-labelledby` to `article`.

### Surface: Game Scheduler / Match Chart

- **Files**: `src/App.jsx` (Game Readiness & Insights)
- **Issues**:
  - [x] `layout_density` (P1): Header description text constrained to `520px`.
      - *Fix*: Increase max-width to `65ch` for consistency with Practice Scheduler.
  - [x] `a11y_structure` (P2): Insight articles (`InsightSection`) lacked `aria-labelledby`.
      - *Fix*: Fixed globally in `App.jsx` during Pass 2.

### Surface: Admin Dashboard

***
