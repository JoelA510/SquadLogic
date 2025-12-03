# SQUADLOGIC PR GENERATION PROMPT

GOAL
- Take SquadLogic roadmap context (from `roadmap.md`) and git diff as input.
- Produce a complete PR description in Markdown that strictly follows the PR description template below.
- Satisfy the following requirements:
  - Group changes by roadmap item (e.g. `P1-TEAM-GEN`).
  - Provide a TL;DR per roadmap item.
  - Explain What / Why / How / Where / When (roadmap).
  - Provide touch points with file names and line ranges.
  - Capture tests, risk, rollback, and cross-cutting changes.

GENERAL RULES

1) Use the template exactly
- Use the PR DESCRIPTION TEMPLATE below verbatim.
- Do NOT add, rename, reorder, or remove sections or headings.
- Do NOT add any explanations, commentary, or prose outside the template.
- Replace bracketed placeholder text (e.g. `[High-level summary of the PR]`) with concrete content or leave a visible TODO if information is missing.

2) Grouping and roadmap mapping
- Every meaningful change must be mapped to either:
  - A specific roadmap item (section 2.x), or
  - Cross-cutting changes (section 3).
- Use the roadmap IDs and titles exactly as given in the input (which comes from `roadmap.md`).
- In "When (roadmap)", refer to the roadmap phase/milestone from the input (e.g. `Phase 2 -> Team Management`), not invented calendar dates.

3) Touch points and line ranges (critical)
- You will receive a git diff (preferably generated with `git diff --unified=0`) that includes hunk headers like `@@ -40,7 +40,9 @@`.
- For each roadmap item, in "C. Touch points & citations":
  - Use only file paths that appear in the diff.
  - Derive line ranges from the diff hunks where reasonably clear.
  - Format entries as:
    - `path/to/File.ext`: L[start]–[end] -> [short hunk description]
- If you cannot confidently determine an accurate line range:
  - Use `L?–? (TBD)` instead of guessing.
  - Still provide the file path and a short description.
- Never invent file paths or line numbers that do not appear in the diff.

4) TL;DR vs details
- TL;DR entries (in section 0 and section 2.x-A) must be short (1–2 sentences) and high-level.
- Do not simply repeat TL;DR text inside the 5W+H bullets.
- The 5W+H bullets should be concise and non-redundant with each other.

5) Tests, risk, rollback
- Be explicit in "Tests & verification" and "Risk & rollback".
- If the input does not mention tests, infer reasonable tests from the changes and clearly mark them as suggested (e.g. "Suggested: add test X") or state "None (not provided in input)".
- Risk level should be a realistic judgment (Low / Medium / High) based on scope and affected areas.

6) If input is incomplete or ambiguous
- Do NOT fabricate detailed, misleading specifics.
- It is acceptable to write `TODO: clarify` or `None provided` where the input clearly lacks information.
- Still structure the PR description fully and fill as much as you can confidently infer from the diff and roadmap.

INPUT FORMAT

You will be given input in the following blocks:

[PR METADATA]
Title: <PR title>
Branch: <source branch>
Target: <target branch>

[ROADMAP ITEMS (from roadmap.md)]
- ID: <ID-1, e.g. P1-TEAM-GEN>
  Title: <Title-1>
  Phase: <Phase or milestone>
  Notes: <Optional extra context>
...

[PR DESCRIPTION TEMPLATE]
<paste of the template from "PR DESCRIPTION TEMPLATE" below, unchanged>

[GIT DIFF]
<paste raw git diff here, ideally from `git diff --unified=0`>

YOUR TASK

- Read the roadmap items and git diff.
- Identify which changes map to which roadmap items.
- Fill out the PR DESCRIPTION TEMPLATE completely, following all rules above.
- If a section does not apply, keep the heading and explain briefly why (e.g. "No cross-cutting changes in this PR.").

OUTPUT REQUIREMENTS

- Output ONLY the completed PR description in Markdown.
- Do NOT wrap the output in backticks.
- Do NOT restate the instructions, inputs, or template description.
- Do NOT invent file names or line numbers not present in the diff.

----------------------------------------------------------------
PR DESCRIPTION TEMPLATE (USE THIS EXACT STRUCTURE)
----------------------------------------------------------------

## 0. Overview (TL;DR, 2–4 bullets)

- [High-level summary of the PR]
- [Key impact/user-facing change]
- [Risk or notable constraint, if any]
- [Optional extra highlight]

---

## 1. Roadmap alignment

<!-- Repeat the block below for each roadmap item touched by this PR -->

### 1.x Roadmap item: [ROADMAP-ID] - [Roadmap title]

- **Phase/milestone:** [e.g. Phase 2 -> Team Management]
- **Scope in this PR:** [1–2 sentences about what this PR does for this item]
- **Status impact:** [e.g. Not started -> In progress, or In progress -> Complete]
- **Linked tickets:** [e.g. JIRA-123, GH-issue-456]

---

## 2. Changes by roadmap item

<!-- Repeat the entire 2.x block for each roadmap item listed in section 1 -->

### 2.x [ROADMAP-ID] - [Roadmap title]

**A. TL;DR (1–2 sentences)**  
- [Plain-English summary of the changes for this roadmap item]

**B. 5W + H**

- **What changed:**  
  [Concrete behavior/functionality that changed. Focus on outcomes, not file names.]

- **Why it changed:**  
  [Problem, requirement, bug, or technical debt this addresses. Include links to tickets if useful.]

- **How it changed:**  
  [High-level implementation approach. Mention patterns, new APIs, notable refactors, but avoid wall-of-text.]

- **Where it changed:**  
  [Key modules/components/files/functions. Do not list every file, only the important ones.]

- **When (roadmap):**  
  [Roadmap phase/milestone this contributes to, and whether this is partial or complete for that item.]

**C. Touch points & citations**

<!-- Map each meaningful change hunk to files and line ranges.
     Prefer git diff with --unified=0 so line ranges are clear. -->

- `path/to/FileA.ext`: L[start]–[end] -> [Short description of what changed there]
- `path/to/FileB.ext`: L[start]–[end] -> [Short description]
- `path/to/FileC.ext`: L?–? (TBD) -> [If line range not clearly derivable; fix manually later]

**D. Tests & verification**

- **Automated tests:**  
  - [Added/Updated/None]  
  - [List key test files or test case names, if applicable]

- **Manual verification:**  
  - [Environment: e.g. local, staging]  
  - [Scenarios / steps run and observed results]

- **Known gaps / follow-ups:**  
  - [Any scenarios not covered, remaining work, or follow-up tickets]

**E. Risk & rollback**

- **Risk level:** [Low / Medium / High]
- **Potential impact if broken:**  
  - [Impact 1]
  - [Impact 2]

- **Rollback plan:**  
  - [How to revert (e.g. revert PR #NNN) or disable via feature flag]
  - [Any data migrations or config changes that need reversal]

---

## 3. Cross-cutting changes (if any)

<!-- Use this section for changes not specific to a single roadmap item:
     e.g. linting, renames, mechanical refactors, tooling updates. -->

- **Type:** [e.g. "Mechanical refactor", "Lint cleanup", "Tooling update"]
- **Scope:** [Which areas of the codebase are affected]
- **Rationale:** [Why this is in this PR instead of a separate one]
- **Touch points (optional):**
  - `path/to/FileX.ext`: L[start]–[end] -> [Short description]
  - `path/to/FileY.ext`: L[start]–[end] -> [Short description]

---

## 4. Implementation notes for reviewers (optional)

<!-- Use this section to direct reviewers to tricky or high-signal areas. -->

- [Call out non-obvious decisions, tradeoffs, or patterns]
- [Mention any areas where you specifically want feedback]
- [Note any temporary workarounds or TODOs that are intentional]

---

## 5. Checklist

- [ ] All changes are mapped to a roadmap item (from `roadmap.md`) or explicitly marked as cross-cutting
- [ ] Touch points and line ranges added for each meaningful change hunk
- [ ] TL;DR provided for each roadmap item
- [ ] What / Why / How / Where / When (roadmap) documented
- [ ] Automated tests added/updated where appropriate
- [ ] Manual verification performed (or rationale if not)
- [ ] Breaking changes, if any, are documented and communicated
- [ ] Rollback plan is defined and feasible
- [ ] Linked tickets (if any) are referenced and updated as needed
