/**
 * The database harness's claim census, held on every PR rather than every sweep.
 *
 * `scripts/dbharness/run.sh` prints `  | (checked) <claim>` beneath a stage to
 * tell a reader that the claim was actually verified, and
 * `scripts/dbharness/prove.sh` carries a `CLAIM_PROVER` registry mapping each
 * claim to the plant that proves the check can go red. Printing a claim and
 * registering its plant are two separate acts, so they drift: eight claims
 * reached `main` printing `(checked)` with no plant behind any of them, which
 * is the hollow-guarantee shape the whole phase exists to remove, sitting in
 * the machinery the phase uses to prove things.
 *
 * `prove.sh` already diffed the two — at the END of a 5.4-hour sweep, off the
 * baseline transcript. That is the right authority and the wrong schedule; a
 * guard whose only runtime is a sweep nobody runs is a guard nobody runs. The
 * same diff taken statically needs no cluster and runs in 80ms, so it runs
 * here.
 *
 * **The negative controls are the point.** A census that passes proves nothing
 * on its own, so the cases after the first COPY the harness into a sandbox,
 * assert the copy is green, break it in each of the ways that matter, and
 * require the census to say so. An assertion nobody has made fail is an
 * assertion nobody has checked. The census has two halves -- a python walk
 * over `run.sh`'s source and a bash loop over the registry's prover labels --
 * and there is a control for each, because a control that only ever reaches
 * one half leaves the other exactly as unchecked as no control at all.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The shape run.sh prints a claim in. Deliberately the echo statement and not
// the bare token: the file's comment layer quotes `  | (checked) ...` when it
// explains the mechanism, and mutating a comment would leave the census green
// and the negative control proving nothing.
const CLAIM_ECHO = /^\s*echo " {2}\| \(checked\) .*"$/;

/** Run the census against a tree laid out like the repo; never throws. */
function census(root) {
  try {
    const stdout = execFileSync('bash', [path.join(root, 'scripts/dbharness/prove.sh')], {
      env: { ...process.env, PROVE_CLAIM_CENSUS_ONLY: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (err) {
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const sandboxes = [];

/**
 * A copy of the two harness scripts in a tree shaped like the repo. `prove.sh`
 * refuses to start unless its plant directories exist, so they are created
 * empty — census-only mode reads nothing out of them.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbharness-census-'));
  sandboxes.push(dir);
  for (const sub of ['scripts/dbharness', 'supabase/migrations', 'docs/sql']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const file of ['prove.sh', 'run.sh']) {
    fs.copyFileSync(
      path.join(repoRoot, 'scripts/dbharness', file),
      path.join(dir, 'scripts/dbharness', file)
    );
  }
  // The control for every mutation below: an unbroken copy must pass, or a
  // red sandbox would make each negative control pass for the wrong reason.
  expect(census(dir)).toMatchObject({ status: 0 });
  return dir;
}

function runSh(dir) {
  return path.join(dir, 'scripts/dbharness/run.sh');
}

function proveSh(dir) {
  return path.join(dir, 'scripts/dbharness/prove.sh');
}

afterEach(() => {
  let dir;
  while ((dir = sandboxes.pop())) fs.rmSync(dir, { recursive: true, force: true });
});

describe('dbharness claim census', () => {
  it('every (checked) claim run.sh prints has a plant declared in prove.sh', () => {
    const { status, output } = census(repoRoot);
    expect(output).toMatch(/claim census \(static\):/);
    expect(status).toBe(0);

    // Meta-assertion: the census reports how many claims it examined, and a
    // run that examined none would print a clean census having looked at
    // nothing. The floor is well under the current count so it records
    // "the universe is not empty", not "the count is frozen".
    const examined = Number(/claim census \(static\): (\d+) /.exec(output)?.[1]);
    expect(examined).toBeGreaterThan(20);
  });

  it('fails when run.sh prints a claim no plant is declared for', () => {
    const dir = sandbox();
    const src = fs.readFileSync(runSh(dir), 'utf8');
    const line = src.split('\n').find((l) => CLAIM_ECHO.test(l));
    expect(line, 'the sandbox copy must carry at least one claim to break').toBeTruthy();
    fs.writeFileSync(runSh(dir), src.replace(line, `${line.slice(0, -1)} (reworded)"`));

    const { status, output } = census(dir);
    expect(output).toContain('CENSUS FAIL: run.sh prints a health claim no plant is declared for');
    expect(output).toContain('CENSUS FAIL: a plant is declared for a claim run.sh does not print');
    expect(status).not.toBe(0);
  });

  it('fails when a new line joins the claim channel under an undeclared prefix', () => {
    const dir = sandbox();
    const src = fs.readFileSync(runSh(dir), 'utf8');
    fs.writeFileSync(runSh(dir), `${src}\necho "  | (verified) a prefix nothing declares"\n`);

    const { status, output } = census(dir);
    expect(output).toContain('prints on the claim channel under a prefix nothing declares');
    expect(status).not.toBe(0);
  });

  it('fails when a claim is retired from the census without being registered', () => {
    // The escape hatch the prefix-only reading left open: reword a `(checked)`
    // line to `(unplantable)`, drop its plant row, and a census that admitted
    // the prefix on its word alone would print a smaller number and exit 0.
    const dir = sandbox();
    const src = fs.readFileSync(runSh(dir), 'utf8');
    const line = src.split('\n').find((l) => CLAIM_ECHO.test(l));
    expect(line, 'the sandbox copy must carry at least one claim to retire').toBeTruthy();
    const retired = line.replace('(checked) ', '(unplantable) ');
    fs.writeFileSync(runSh(dir), src.replace(line, retired));

    const claim = /^\s*echo " {2}\| (.*)"$/.exec(retired)[1];
    const prove = fs.readFileSync(proveSh(dir), 'utf8');
    const row = prove
      .split('\n')
      .find((l) => l.startsWith(`  ["${claim.replace('(unplantable) ', '(checked) ')}"]=`));
    expect(row, 'the retired claim must have had a registry row to delete').toBeTruthy();
    fs.writeFileSync(proveSh(dir), prove.replace(`${row}\n`, ''));

    const { status, output } = census(dir);
    expect(output).toContain('retires a claim from the census that nothing registers');
    expect(status).not.toBe(0);
  });

  it('fails when the registry names a prover no plant declares', () => {
    // The bash half of the census, which no other case here reaches: the
    // python walk never looks at a plant label.
    const dir = sandbox();
    const prove = fs.readFileSync(proveSh(dir), 'utf8');
    const prover = /^ {2}\["\(checked\) [^"]*"\]="([^"|]+)"$/m.exec(prove)?.[1];
    expect(prover, 'the registry must declare at least one single-prover claim').toBeTruthy();
    const call = `plant "${prover}"`;
    expect(prove).toContain(call);
    fs.writeFileSync(proveSh(dir), prove.replace(call, `plant "${prover} (renamed)"`));

    const { status, output } = census(dir);
    expect(output).toContain('names a prover no plant call declares');
    expect(status).not.toBe(0);
  });
});
