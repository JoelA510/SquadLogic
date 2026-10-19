import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Load the Node-side environment `playwright.config.ts` and the step
 * definitions read (`TEST_*`, tests/e2e/steps/auth_setup.ts).
 *
 * `.env.test` is the documented home of the `TEST_*` credentials
 * (`.env.test.example`, docs/operations/ENVIRONMENT.md), and the config used to
 * load only `.env`, so a populated `.env.test` was never read locally (audit
 * finding DD-9; CI is unaffected, it injects `TEST_*` as job environment).
 *
 * dotenv never overwrites a variable that is already set, so the first source
 * to name a variable wins: the shell, then `.env.test`, then `.env`. A missing
 * file is not an error (the mock run needs neither). Only the Node process sees
 * these; Vite's own `.env*` loading for the dev server is unchanged.
 *
 * @param {string} [cwd] - the directory holding the env files (the repo root)
 * @param {NodeJS.ProcessEnv} [target] - the environment to fill (`process.env`)
 */
export function loadTestEnv(cwd = process.cwd(), target = process.env) {
  for (const file of ['.env.test', '.env']) {
    dotenv.config({ path: path.join(cwd, file), processEnv: target, quiet: true });
  }
}
