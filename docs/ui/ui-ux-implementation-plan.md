## Current State

* The GotSportTeamerScheduler repo **now contains**:
  * `docs/ui/ui-ux-pass.md`
  * `docs/ui/ui-ux-pass-summary.md`
  * `docs/ui/ui-ux-polish.md`
  * `docs/ui/agent-ui-ux-guidelines.md`
  * `docs/ui/ui-ux-audit-plan.md`
  * `docs/ui/ui-ux-audit-issues.md` (template)
  * `docs/ui/ui-ux-audit-findings.md` (template)
  * `docs/ui/ui-ux-audit-verification.md` (template)
* `agent-ui-ux-guidelines.md` is wired into Antigravity as workspace instructions.

Below are concrete prompts you can paste into Gemini/Antigravity, split by phase.

---

## 1) One-time priming: load and restate the rules

Run this once per new Gemini session on this repo:

```text
We have added UI/UX documentation for this repo.

Step 1:
- Open and read:
  - docs/ui/agent-ui-ux-guidelines.md
  - docs/ui/ui-ux-pass.md
  - docs/ui/ui-ux-pass-summary.md
  - docs/ui/ui-ux-polish.md
  - docs/ui/ui-ux-audit-plan.md
  - docs/ui/ui-ux-audit-issues.md

Step 2:
- Summarize in bullet points:
  - What counts as P0 vs P1 vs P2 for this app.
  - The core flows you will focus on (Team Generation, Practice Scheduling, Game Scheduling, admin shell).
  - The order you will follow when asked to "run a UI/UX pass" (P0 first, then P1, P2 only when requested).

Do not change any code yet. Just confirm your understanding and restate the process you will follow in this repository.
```

Goal: ensure Gemini is explicitly aware of the docs and how to use them for this repo.

---

## 1.5) Visual Audit Setup (Recommended)

If you can run the application locally, a visual audit is far superior to a code-only audit for catching layout and responsive issues.

```text
I have the application running locally at [http://localhost:5173] (or your port).

Task:
- Use the `browser_subagent` to visually inspect the UI surfaces defined in `docs/ui/ui-ux-audit-plan.md`.

Steps:
1. Navigate to the key pages (Dashboard, Team Gen, Scheduler).
2. Take screenshots or record sessions.
3. Inspect elements for:
   - Spacing and alignment (P1).
   - Contrast and focus states (P0).
   - Responsive behavior (resize window).
4. Cross-reference findings with the code to pinpoint the source.
```

---

## 2) (Re)build or refresh the audit plan

Since `ui-ux-audit-plan.md` exists, use this to verify it matches the actual codebase.

```text
Use these as the canonical UI standards for this repo:
- docs/ui/ui-ux-pass.md
- docs/ui/ui-ux-pass-summary.md

Task:
- Verify and refine the UI/UX audit plan for GotSportTeamerScheduler.

Steps:

1) Scan the front-end:
   - src/App.jsx
   - src/components/**
   - src/index.css
   - src/App.css
   - Any other UI entrypoints in this repo.

2) Update docs/ui/ui-ux-audit-plan.md if needed:
   - Ensure all "Core Workflows" listed actually exist in the codebase.
   - Update file paths if they are inexact (e.g., wildcards).
   - Confirm the "Risk Assessment" is accurate based on code complexity.

Do NOT modify any UI code yet. Only update docs/ui/ui-ux-audit-plan.md.
```

---

## 3) First audit pass: populate `ui-ux-audit-issues.md`

Once the plan is verified:

```text
Use these docs as the canonical UI/UX rules:
- docs/ui/ui-ux-pass.md
- docs/ui/ui-ux-pass-summary.md
- docs/ui/ui-ux-polish.md (for P2 only)

Use:
- docs/ui/ui-ux-audit-plan.md as the list of surfaces to audit.

Task:
- Populate docs/ui/ui-ux-audit-issues.md with concrete issues.

Steps:

1) For this pass, focus on:
   - Global & shared surfaces.
   - Team Generation flow.
   (We will handle Practice and Game Scheduling in later passes.)

2) For each surface in that scope:
   - **Visual Check** (if app is running): Use `browser_subagent` to spot layout/contrast/responsive bugs.
   - **Code Check**: Open the referenced files and check against ui-ux-pass.md:
     - P0: accessibility, broken flows, unreadable content.
     - P1: layout/spacing, hierarchy, component consistency, navigation.
     - P2: visual polish (spacing, density, icon usage, etc.).

3) In docs/ui/ui-ux-audit-issues.md, for each surface, record:
   - Surface name and file paths.
   - Issues as a checklist:
     - rule_id (if applicable).
     - Priority: P0 / P1 / P2.
     - One-line description.
     - One-line suggested fix.

Do NOT change any UI code in this step. Only update docs/ui/ui-ux-audit-issues.md.
```

Repeat the same prompt later for Practice and Game Scheduling by changing the scope in step 1.

---

## 4) Implementation pass: fix P0/P1 for a specific flow

After you review the issues list, start actual changes in bounded chunks.

Example for Team Generation:

```text
Canonical rules:
- docs/ui/ui-ux-pass.md
- docs/ui/ui-ux-pass-summary.md

Audit sources:
- docs/ui/ui-ux-audit-plan.md
- docs/ui/ui-ux-audit-issues.md

Scope for this implementation pass:
- Fix all P0 issues and as many P1 issues as reasonable in the Team Generation flow.

Steps:

1) Identify all Team Generation components and files from docs/ui/ui-ux-audit-plan.md.
2) For each P0 and P1 issue for that flow in docs/ui/ui-ux-audit-issues.md:
   - Open the relevant file(s).
   - Apply code changes to fix the issue while:
     - Preserving existing behavior.
     - Respecting the design system and CSS variables.
     - Not introducing new P0 issues.

3) Keep patches cohesive:
   - Group related changes by component or small set of components.
   - Avoid mixing unrelated flows in one patch.

4) After changes:
   - Update docs/ui/ui-ux-audit-issues.md:
     - Mark P0/P1 issues as resolved.
     - Add short notes where partial or follow-up work is needed.

Use Antigravity’s patch/edit flow and show the full diff for each changed file.
```

Use the same pattern for Practice Scheduling and Game Scheduling.

---

## 5) Visual polish pass: P2-only for a given surface

Once P0/P1 are mostly handled:

```text
We have addressed P0 and most P1 issues for the Team Generation flow.

Canonical rules:
- docs/ui/ui-ux-pass.md   (still applies)
- docs/ui/ui-ux-polish.md (visual polish, P2)

Audit sources:
- docs/ui/ui-ux-audit-plan.md
- docs/ui/ui-ux-audit-issues.md

Task:
- Apply P2-level visual polish to the Team Generation flow only.

Constraints:
- Do NOT:
  - Lower contrast below WCAG thresholds.
  - Shrink click targets below the minimums in ui-ux-pass.md.
  - Remove or weaken focus indicators.
- Do NOT degrade performance or introduce new accessibility issues.

Steps:

1) Open the Team Generation components and related CSS.
2) Read the relevant sections of ui-ux-polish.md about:
   - Theming and color roles.
   - Typography hierarchy.
   - Layout / spacing / density.
   - Cards, tables, and scheduling grids.
3) Propose and then apply cohesive polish changes, such as:
   - Cleaning up spacing and alignment.
   - Standardizing card/panel headers and footers.
   - Improving table row hover/selected states.
   - Making status states (unscheduled/scheduled/conflict/locked) clearer via tokens.

4) Update docs/ui/ui-ux-audit-issues.md:
   - Mark relevant P2 issues as resolved.
   - Note any polish items intentionally left as-is (with rationale).
```

Change flow name as needed for Practice or Game Scheduling.

---

## 6) Verification pass: confirm fixes, catch regressions

After a couple of implementation/polish rounds:

```text
We have implemented multiple UI/UX changes based on the audit docs.

Rules and sources:
- docs/ui/ui-ux-pass.md
- docs/ui/ui-ux-pass-summary.md
- docs/ui/ui-ux-polish.md
- docs/ui/ui-ux-audit-plan.md
- docs/ui/ui-ux-audit-issues.md

Task:
- Produce a verification report in docs/ui/ui-ux-audit-verification.md.

Steps:

1) For each surface in ui-ux-audit-plan.md:
   - **Visual Check**: Use `browser_subagent` to verify fixes in the running app.
   - Re-check all P0 issues from ui-ux-audit-issues.md:
     - Confirm they are fixed, or
     - Explain why they are still open.
   - Spot-check P1 fixes and make sure they did not introduce new regressions.
   - Note whether P2 polish has been applied.

2) Create or overwrite docs/ui/ui-ux-audit-verification.md with:
   - A summary table of P0/P1 status.
   - One section per surface:
     - Compliance status (P0, P1).
     - Key verification findings.
     - Any remaining issues.

3) If you discover new P0-level problems:
   - Add them to docs/ui/ui-ux-audit-issues.md.
   - Propose a follow-up implementation plan.

Do not make code changes until after you have written the verification report. We will run a separate implementation pass for any new issues.
```

---

## 7) Lightweight “on demand” prompts

Once the system is in place, you do not always need the full flow. A few short prompts you can reuse:

### Quick pass on a single component

```text
Run a focused UI/UX pass on src/components/TeamPersistencePanel.jsx.

Use:
- docs/ui/ui-ux-pass.md for P0/P1 rules.
- docs/ui/ui-ux-polish.md for P2 (polish) only after P0/P1.

Steps:
- Identify P0, P1, and P2 issues for this component and log them into docs/ui/ui-ux-audit-issues.md under the "Team Persistence Panel" section.
- Then implement changes in this component to fix all P0 issues and obvious P1 issues within scope.
- Keep changes cohesive and explain how they map to the checklist.
```

### Quick visual polish request

```text
Apply P2 visual polish to the main dashboard shell (src/App.jsx and any shared components it uses), using docs/ui/ui-ux-polish.md.

Constraints:
- Do not introduce new P0/P1 issues.
- Do not change behavior, only appearance and clarity.

Focus:
- Spacing and grouping of panels.
- Typography hierarchy for headings and body.
- Header/toolbar layout and clarity.
```

---

## Sanity Check

1. **Verify**

   * These prompts:

     * Explicitly load and use your docs (pass, summary, polish, audit plan, issues, verification).
     * Enforce the P0 -> P1 -> P2 sequence.
     * Keep changes scoped to flows or components, matching how the app is structured.
     * **Include visual verification** via the browser tool, which is critical for UI work.
   * They mirror what you are doing for the other two projects, just tailored to GotSportTeamerScheduler’s flows and file layout.

2. **Edge case**

   * Failure mode: Gemini tries to “optimize” by rewriting large parts of the app in one shot.
   * Mitigation: prompts repeatedly force “cohesive, scoped” patches and separate audit/plan from implementation, plus you’re reviewing docs (issues/verification) between passes.

3. **Efficiency**

   * One-time priming and audit plan are O(n) in number of surfaces.
   * After that, each pass is O(k) in the number of surfaces you include in the scope, with P2 polish mostly O(c) in shared components/tokens rather than individual screens.
