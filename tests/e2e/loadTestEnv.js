import { readFileSync } from 'node:fs';
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
 * From `.env.test` only the `TEST_*` names are taken. The webServer inherits
 * this process's environment, and Vite lets a `VITE_*` value in it override its
 * own `.env` files, so a stray `VITE_USE_MOCK_SUPABASE` or `VITE_SUPABASE_*` in
 * `.env.test` would silently repoint the dev server. `.env` is loaded whole, as
 * it always was.
 *
 * @param {string} [cwd] - the directory holding the env files (the repo root)
 * @param {NodeJS.ProcessEnv} [target] - the environment to fill (`process.env`)
 */
export function loadTestEnv(cwd = process.cwd(), target = process.env) {
  let testFile = '';
  try {
    testFile = readFileSync(path.join(cwd, '.env.test'), 'utf8');
  } catch (err) {
    // Expected: most runs have no .env.test. Anything else (EACCES, EISDIR) is real.
    if (err?.code !== 'ENOENT') throw err;
  }
  for (const [name, value] of Object.entries(dotenv.parse(testFile))) {
    if (name.startsWith('TEST_') && target[name] === undefined) target[name] = value;
  }
  dotenv.config({ path: path.join(cwd, '.env'), processEnv: target, quiet: true });
}
