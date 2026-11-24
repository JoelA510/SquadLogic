# Agent platforms: choosing them, and researching one that isn't listed

Every coding agent reads the shared rules in `AGENTS.md`, but each reaches it differently and
stops reading at a different size. A project records the agents it uses, and its instruction files
are wired and sized for exactly those: no CLAUDE.md for a team that never runs Claude Code, and no
24,000-byte ceiling for a team that never runs Antigravity. The new-project and existing-project
prompts ask for the selection; this page is what they point at.

## The selection

The project owns one file, `.agents/platforms.json`:

```json
{
  "platforms": ["claude-code", "codex"],
  "custom": []
}
```

- `platforms` lists ids from the table below.
- `custom` holds a platform the table doesn't have, researched as described below. Each entry has
  `name`; `files` (the instruction files it reads, by name, such as `AGENTS.md`); `agentsMd` (how
  AGENTS.md reaches it: natively, through an import, through a setting, or not at all);
  `hardBytes` (the documented size past which a file isn't read in full, or `null` when the
  documentation gives none); and `sources`, at least one `{"url": "...", "checked": "YYYY-MM-DD"}`
  per page the facts came from. Optional: `guidanceLines` (a documented length to stay under),
  `hardEffect` (what happens past the limit: truncated, skipped), `hardScope` (`"combined"` when
  the limit is on every AGENTS.md from the root down together, as Codex's is; `"file"`, the
  default, when it's per file), `wiring` (what the project adds so
  AGENTS.md reaches it), `skills` and `hooks` (where it reads project skills and hook
  configuration), and `notes` (what the sources leave open). Any other field is an error.

Where it comes from: a fresh fork of the template records it with
`npm run init -- --name ... --slug ... --platforms claude-code,codex`; the new-project and
existing-project prompts write it from the owner's answer. `process:apply` never writes, updates, or
removes it; it says so when the target has none. It reads it: the skills go only to the skill
home(s) the selected platforms read (`skills` in the table's source), and a home dropped from the
selection keeps what was delivered there, reported, never removed.

`check:instructions` (`node <template checkout>/scripts/check-instructions.mjs --root <repo>`) reads
it:

- **Size, a finding:** each shared instruction file is held to the smallest hard limit among the
  selected platforms that read it. A file none of them limits has no budget. Where a selected
  platform's limit is combined (Codex), a nested AGENTS.md is also held to that limit less the
  AGENTS.md files above it, and the finding names them.
- **Guidance, a note:** a documented length to stay under, such as Claude Code's 200 lines
  (counting what the file imports, which loads too), is reported, never failed.
- **The file itself, a finding:** an unknown id, an unknown field, an empty selection, or a custom
  entry without its files, its limit, or dated sources. JSON that doesn't parse stops the check
  (exit 2): no budget can be known.
- **No file at all:** the check keeps its earlier behavior, AGENTS.md and GEMINI.md under 24,000
  bytes (the strictest limit of any platform here), and prints a note recommending a selection.

## The platforms the template knows

The facts, with every source and the date it was read, live in the template's
`scripts/agent-platforms.mjs`; a test holds this table to it.

<!-- platform-table:start -->

| Id | Platform | How AGENTS.md reaches it | Wiring the project adds | Hard limit | Guidance | Read |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-code` | Claude Code | import | a CLAUDE.md whose first line is `@AGENTS.md` | 4194304 bytes per file (skipped past it) | 200 lines, imports included | 2026-10-14 |
| `codex` | Codex | native | none | 32768 bytes, all AGENTS.md files from the root down combined (truncated past it) | none | 2026-10-14 |
| `cursor` | Cursor | native | none | none documented | 500 lines (said of rules) | 2026-10-14 |
| `copilot` | GitHub Copilot | native | none | none documented | 1000 lines | 2026-10-14 |
| `gemini-cli` | Gemini CLI | setting | `.gemini/settings.json` naming AGENTS.md in `context.fileName` | none documented | none | 2026-10-14 |
| `antigravity` | Antigravity | native | none | 24000 bytes per file (truncated past it) | none | 2026-10-14 |

<!-- platform-table:end -->

## Wiring and sizing AGENTS.md for a selection

1. **Wire only what the selection needs.** Claude Code: a CLAUDE.md whose first line imports
   AGENTS.md (skeleton: CLAUDE.skeleton.md), because Claude Code skips AGENTS.md whenever a
   CLAUDE.md exists. Gemini CLI: `.gemini/settings.json` of
   `{"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}}`. The others read AGENTS.md as it is. A
   wiring file for an agent nobody uses is one more file to keep true.
2. **Size AGENTS.md to the strictest hard limit** among the selected platforms. With Codex, that's
   the combined size of every AGENTS.md from the root to where the agent works, so a nested file's
   budget is what the root one leaves.
3. **Keep to the guidance where there is one.** For Claude Code, about 200 lines counting what
   CLAUDE.md imports: the rules in AGENTS.md, and reference detail (long command explanations,
   architecture, rationale) in `docs/`, with a one-line pointer from AGENTS.md.
4. **Say it in the file.** AGENTS.md's opening lines name the selected platforms, how each reads
   it, and its budget (the AGENTS skeleton has the placeholders), so the next editor knows the
   limit before they reach it.

## Researching a platform that isn't listed

When the owner names an agent the table doesn't have, research it; never fill a field from memory
or by analogy with a similar tool.

1. **Read the vendor's official documentation**: its docs site, its own repository's docs, or its
   changelog. A blog post, a forum answer, or another tool's docs count only when the official docs
   are silent, and then the entry's `notes` says which fact came from where.
2. **Establish each of these**, writing down the URL of the page that states it:
   - which instruction files it reads, in what order, and which takes precedence when two apply
     (nested files, a user-level file, an override file);
   - whether it reads AGENTS.md, and how: natively, only through an import from its own file, or
     only when a setting names it (and which setting, in which file);
   - any limit on an instruction file's size or length (bytes, characters, tokens, lines), whether
     it's per file or combined, and what happens past it: truncated, skipped, or summarized;
   - whether it reads project skills (and from which directory) and runs project hooks (and from
     which configuration file).
3. **Record it** as a `custom` entry in `.agents/platforms.json`, with each source's URL and the
   date you read it in `checked`. Quote the documentation's wording in `notes` where a number or a
   behavior is easy to misread.
4. **Leave what you couldn't establish as unknown.** A limit the docs don't give is
   `"hardBytes": null`, with a note naming the pages you consulted; never a number that "seems
   about right". An unknown that matters (no limit found for an agent that's known to truncate)
   is an open item in the run's output, not a guess.
5. **Offer it upstream.** A researched entry helps every project that uses the agent: propose it to
   the template's registry (`scripts/agent-platforms.mjs`), as an issue or a pull request where the
   template is maintained, with the sources.

Facts move. When a check or a run turns up a platform behaving differently from its entry, read
the source again and update the entry and its `checked` date in the same change.
