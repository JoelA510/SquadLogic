# SQUADLOGIC PR DESCRIPTION TEMPLATE
<!-- (USE THIS EXACT STRUCTURE) -->

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

**A. TL;DR (1–3 sentences)**  
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
