# Reference verification

**References verified as of 2026-10-12.**

Staleness rule: a reference is STALE if its last commit is more than 9 months old, **or** it
targets a framework one major behind current at time of execution. Stale references may still
supply architectural ideas (boundaries, naming, test strategy) but never dependency versions,
config files, or API usage verbatim.

SquadLogic is a Vite 7 + React 19 single-page app in an npm-workspaces monorepo
(`frontend/`, `packages/core/`), with a Supabase backend (PostgreSQL, RLS, SECURITY DEFINER
RPCs, Deno Edge Functions). No listed reference is a Vite + Supabase SPA, so none is a full
yardstick (see "Yardsticks when no reference fits"). Four were verified because one part of
each bears on this repository: package boundaries, typed env validation, CI tooling, and
monorepo configuration. They supply ideas only; nothing is copied from them.

| Reference | Last commit | Framework majors | Issue activity | Status | How it will be used |
| --- | --- | --- | --- | --- | --- |
| t3-oss/create-t3-app | 2025-12-13 | next@15, zod@3, @t3-oss/env-nextjs@0.12 (CLI 7.40.0) | not available (git only) | stale (10 months since last commit; Next 15 and zod 3 are one major behind) | Idea only: one validated env module read by name (audit §2, §8). No versions or API usage. |
| vercel/next-forge | 2026-05-28 | next@16, react@19, turbo@2 | not available (git only) | current | Idea only: one schema location, apps consume packages, no cross-app imports (audit §1). Its Next.js app layout does not apply. |
| ixartz/Next-js-Boilerplate | 2026-10-08 | next@16, react@19, typescript@7, vitest@4, @playwright/test@1, knip@6 | not available (git only) | current | Idea only: CI and tooling completeness (unused-code check, dependency audit gate, hooks) for audit §6-§8. |
| vercel/turborepo (`examples/with-vite`, `examples/with-npm`) | 2026-10-11 | vite@8, typescript@7, turbo@2 | not available (git only) | current | Idea only: minimal workspace configuration (audit §1). Note: it pins Vite 8; SquadLogic is on Vite 7, one major behind, which is recorded, not a migration proposal. |

Sources: the GitHub API refused every reference repository from this session ("GitHub access to
this repository is not enabled for this session"), so every column came from git alone:
`git clone --depth 1 --filter=blob:none --no-checkout <url>`, then `git log -1 --format=%cI` and
`git show HEAD:<manifest>` (`cli/package.json` and `cli/src/installers/dependencyVersionMap.ts`
for create-t3-app; `package.json` and `apps/app/package.json` for next-forge; `package.json`
for Next-js-Boilerplate; `examples/with-vite/apps/web/package.json` for turborepo). Issue
activity is not available through git. All values executed (read from the clones), not fully
validated against the web pages.

## Yardsticks when no reference fits

- Supabase documentation (Row Level Security, Database Advisors, CLI `db push` / `test db`,
  the Data API grant change of 2026-10-30) as current on 2026-10-12 — no listed reference is a
  Supabase app.
- Vite 7 documentation (env variables and `import.meta.env`, build) and React 19 documentation —
  the version this repository runs; no listed reference is a Vite SPA.
- WCAG 2.2 AA (the bar this repository's CLAUDE.md sets).
- This repository's own stated rules: `CLAUDE.md`, `docs/LESSONS_LEARNED.md`,
  `docs/governance/governance-framework.md`, `docs/security/*`, `docs/operations/*`, and the
  previous audit `docs/audits/2026-07-production-readiness/`.
- The template standards delivered in `prompts/standards/` (core, node, supabase, vite-spa),
  scored by the conformance scorecard.

## Skipped

- epicweb-dev/epic-stack — a Remix/React Router full-stack app with its own server and
  database; SquadLogic has no app server of its own.
- obytes/react-native-template-obytes, infinitered/ignite — no mobile surface.
- fastapi/full-stack-fastapi-template, vintasoftware/nextjs-fastapi-template — no Python API.
- ardalis/CleanArchitecture, jasontaylordev/CleanArchitecture — no .NET.
- awesome-nestjs boilerplate index — no NestJS.
- gothinkster/realworld — idiom comparison only, and no idiom here needed one.

## Provisional patterns

- Typed env module validated at build time — borrowed as an idea from create-t3-app (STALE);
  the shape will follow this repository's own Zod usage (`packages/core/src/schemas/`), not T3
  Env's API. Revisit if a current Vite-specific reference is adopted.
