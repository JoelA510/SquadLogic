# Agent brief: building a PR of the remediation plan

Every agent that builds a pull request for [`remediation-plan.md`](./remediation-plan.md) reads
this after `AGENTS.md`. It records how the 2026-10 remediation has been run. The order of the
remaining work is in [`resume-queue.md`](./resume-queue.md).

## Sources of truth

- `AGENTS.md`, the plan, and the plan's "Discovered during execution" section. Read your items in
  full (fix approach, files, depends on, acceptance, test gate) before editing.
- `prompts/` holds the process delivered from
  [agent-ready-template](https://github.com/JoelA510/agent-ready-template): its skills, skeletons
  under `prompts/skeletons/`, and standards under `prompts/standards/`.
- Owner decisions are recorded in the plan: D1-D8 at their defaults, plus the 2026-10-13/14
  decisions in its status lines and Discovered entries.

## Production access (owner, 2026-10-13)

- The owner is the only user.
- You may touch production where your item needs it, including test accounts or test data:
  - Supabase project `mmwupqsjkikqzvmdvuzm`;
  - Vercel project `squadlogic`.
- Prefer local or CI-local setups where they give the same proof. Say in your report exactly what
  you did to production.
- Never commit secrets or real personal data.
- Migrations reach production only through CI (`deploy-migrations` on merge to `main`). Never
  apply one through the Supabase MCP or by hand.

## Check in often

Sessions have lost work to usage limits.

- Commit and push your branch after each meaningful step: a test that fails for the right reason,
  an item implemented, a review round fixed. Never hold more than about 30 minutes of unpushed
  work.
- Keep a short progress log that someone could resume from with the branch alone: done, how it
  was verified, next, open questions, anything done to production.

Free-tier budgets bound this (`docs/operations/ci-cd.md`, "Free-tier budgets"):

- A push to a branch without a PR runs no CI.
- `claude/**` branches don't deploy to Vercel.
- Every push to an open PR costs a full CI run (about 20 minutes), so open the PR only when the
  local gates pass, and push to it as little as possible.

## Process

- **Branch:** `claude/<session>-<your id>` from `origin/main`. Commits follow Conventional
  Commits, with your session's attribution lines.
- **PR body:**
  - per item: what changed, and how it was verified, labelled statically reviewed, executed or
    fully validated;
  - each check shown able to fail;
  - a Definition of Done table;
  - a deploy note: migrations, Edge Functions, frontend;
  - anything flagged instead of done.
- **The plan document:** edit only your items' status lines, plus new Discovered entries. Other
  PRs edit other lines in parallel.
- **Before merging:** `main` is strict. A PR merges only with the required checks (`AGENTS.md`
  §11) green on a head that contains current `main`.
  - Before your final push, merge `origin/main` in with a merge commit. No rebase or force-push
    once the PR is open.
  - Subscribe to your PR's activity. Don't subscribe to throwaway PRs.
- **Owner decisions:** don't guess. Implement what's unambiguous, write the question with your
  recommendation, and leave that part open in the plan.
- **Other work:** don't touch other open PRs or branches. At most two agent PRs are in flight at
  once.
- **Throwaway branches:** a branch used to prove a check can fail stays local where possible. The
  session's git proxy refuses branch deletes, so list any you push under "Cleanup for the owner"
  in your PR body.

## Environment notes (Claude Code on the web)

- **Node 24** (`.nvmrc`). Run `npm ci` in a fresh worktree.
- **Install settings:** `.npmrc` enforces `min-release-age=3`, `allow-git=none` and
  `allow-remote=none`. Prettier is pinned at 3.7.4. Flag any new dependency in the PR body.
- **Docker** is not available in the sandbox, so there is no local `supabase start`. CI runners
  have it: pgTAP and the real-backend E2E run there.
- **Deno** is not installed. Rely on CI's Deno job, or install CI's version through npm into a
  scratch directory.
- **Playwright:** use the sandbox's Chromium (`/opt/pw-browsers/chromium`) through a scratch config
  or `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Its pinned headless shell is not installed.
- **A production build** needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Stand-in values
  are enough locally.
- **Workflows:** every action is pinned by SHA (`tests/workflowPins.test.js`), and zizmor must
  stay clean.
