# SQUADLOGIC PR INSTRUCTIONS

This document defines the standard for creating Pull Requests (PRs) in the SquadLogic repository.
It is designed to ensure every PR is readable, reviewable, and clearly mapped to the project roadmap (`roadmap.md`).

---

## 1. The "Why"

We use a structured PR format to:

1. **Connect code to business value**: Every change must link back to a roadmap item (e.g. `P1-TEAM-GEN`) or be explicitly marked as cross-cutting.
2. **Speed up reviews**: Reviewers can see "What/Why/How" at a glance without decoding the diff first.
3. **Create a changelog**: The PR description becomes the documentation for future debugging and release notes.
4. **Enable AI assistance**: The structure is rigid so that LLMs can reliably generate drafts for us.

---

## 2. Files involved

These three files work together:

- `pr_template.md`  - Structure of PRs (what the description should look like).
- `pr_prompt.md`    - Prompt to generate PR descriptions with an LLM.
- `pr_instructions.md` (this file) - How humans and LLMs should use the template in this repo.

Keep them in sync with the SquadLogic roadmap and branching strategy.

---

## 3. How to create a PR for SquadLogic

### 3.1. When writing by hand

Use `pr_template.md` as your starting point:

- Copy the entire template into the PR description.
- Fill in each section:
  - Overview (TL;DR).
  - Roadmap alignment (per roadmap item).
  - Change details with 5W+H (What, Why, How, Where, When).
  - Touch points (file + line ranges).
  - Testing, risk, rollout, rollback.
  - Checklist.

Short PRs are still expected to follow the template; you can mark unused subsections as "N/A" instead of deleting them.

### 3.2. When calling an LLM

Inputs you must prepare:

1. **PR metadata**
   - Title: reflect roadmap item and scope (e.g. `P1-TEAM-GEN: Implement allocator`).
   - Branch: usually the current working branch name (e.g. `feature/team-generation`).
   - Target: `feature/team-generation` (for most roadmap work) or `main` (for stable/hotfix work).

2. **Roadmap items**
   - **CRITICAL**: Copy the exact items from `roadmap.md` in the root of the repo.
   - Provide:
     - `ID` (e.g. `P1-TEAM-GEN`), `Title`, `Phase`, `Notes`.

3. **Template**
   - Paste the current contents of `pr_template.md` exactly.

4. **Git diff**
   - Use:
     - `git diff origin/feature/team-generation...HEAD --unified=0` (if targeting `feature/team-generation`)
     - `git diff origin/main...HEAD --unified=0` (if targeting main)
   - Include all changes you expect in the PR.

### 3.3. Expectations of the LLM output

- It must:
  - Preserve all headings and structure from `pr_template.md`.
  - Only use file paths and line numbers present in the diff.
  - Group changes by roadmap item first, not by file.
  - Provide at least one TL;DR bullet per roadmap item.
  - Fill in What/Why/How/Where/When for each item.
  - Provide touch points (file + line ranges) for each meaningful change hunk.

- It must NOT:
  - Invent files, functions, or line ranges that do not appear in the diff.
  - Collapse multiple roadmap items into one block unless they are explicitly cross-cutting.
  - Add generic text that does not map to the actual changes.

---

## 4. Generating accurate line ranges

Accurate touch points depend on how diffs are generated.

### 4.1. Required diff format

- Use unified diff with zero context where possible:

  ```bash
  git fetch origin
  git diff origin/feature/team-generation...HEAD --unified=0
  ```

- Benefits:
  - Hunk headers (`@@ -old,+new @@`) provide clear line starts.
  - No extra context lines that confuse line calculations.

### 4.2. Line range handling rules

- For each hunk:
  - Use the `+` side of the hunk header for new/changed lines.
  - Derive a start and end line consistent with the header.
- If deriving line ranges is not straightforward:
  - Use `L?–? (TBD)` and clean up manually before merging (do not leave TBD in merged PRs).

---

## 5. Roadmap alignment rules

SquadLogic uses roadmap items in `roadmap.md` to organize work.

### 5.1. Mapping changes to roadmap items

- Every meaningful change must be tagged as:
  - **Linked to a specific roadmap item** (e.g. `P1-TEAM-GEN`).
  - OR explicitly **cross-cutting** (e.g. repository-wide linting, project layout refactors).

- If a file change supports multiple items:
  - Pick the primary item that would "own" the change.
  - Mention secondary impacts in the notes for that item.

### 5.2. When something is cross-cutting

A change is cross-cutting when:

- It is mechanical (lint, formatting, import sorting).
- It affects foundational infrastructure (CI, tooling, logging).
- It spans many roadmap items without clearly belonging to one.

For cross-cutting changes:

- Use the "Cross-cutting changes" section in the template.
- Still provide:
  - What/Why/How/Where.
  - Touch points and line ranges.
  - Testing and risk details.

---

## 6. PR size and composition

### 6.1. Preferred PR size

- **Goal**: "Reviewable".
- **Note**: PRs in this repo may be large due to the nature of the project. Focus on logical cohesion.

- **Preferred**:
  - Tightly aligned to 1 roadmap item.
  - Minimizes reviewer load and risk.

- **Avoid**:
  - Mixed "feature + large refactor + lint cleanup" in one PR.

- **Branch roles (SquadLogic)**:
  - `feature/team-generation` is an example of a primary integration branch for roadmap-aligned work.
  - `main` is the stable, deployable branch.
  - `refactor` is reserved for larger or experimental refactors; only target it when explicitly requested.

---

## 7. Expectations for authors and reviewers

### 7.1. Authors

Authors should:

- Use `pr_template.md` for every PR.
- Ensure:
  - Roadmap IDs are correct and present.
  - Line ranges match the current diff.
  - Tests are run and documented.
  - Risks and rollback plans are realistic.
- Keep the PR focused:
  - If you drift into unrelated refactors or cleanups, split into a new PR.

### 7.2. Reviewers

Reviewers should:

- Use the PR description as the entry point:
  - Start from Overview and Roadmap alignment.
  - Use touch points to jump into the code.
- Push back on:
  - PRs that do not follow the template.
  - Missing or obviously wrong line ranges.
  - PRs that merge multiple unrelated concerns.
- Request:
  - Additional tests when risk is non-trivial.
  - Clarification when "Why" or "Risk" are underspecified.

---

## 8. Maintenance of these PR assets

Files involved:

- `pr_template.md`  -> Structure of PRs.
- `pr_prompt.md`    -> Instructions for LLM usage.
- `pr_instructions.md` (this file) -> Process and collaboration rules.

Change management:

- Treat these files as part of the repo's "tooling infrastructure".
- All edits should be made via PR.
- When the roadmap or branching strategy changes (for example, after a major feature is merged into `main`), update:
  - Branch references (diff commands, examples).
  - Any roadmap-specific wording.
- Keep the three files consistent:
  - Template and prompt must match.
  - Instructions must describe how they are actually used in SquadLogic.
