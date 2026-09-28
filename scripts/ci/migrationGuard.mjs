#!/usr/bin/env node
/**
 * Safety guard for the `deploy-migrations` CI job.
 *
 * Runs between `supabase db push --dry-run` and the real `supabase db push`.
 * It reads the CLI's own JSON output (`--output-format json`, CLI 2.118.0) and
 * FAILS -- never skips -- when anything about the pending set is surprising:
 *
 *   - either input is not the JSON shape the pinned CLI prints (an error
 *     object, text output, an empty file): unparseable is a failure, not a pass;
 *   - the remote ledger is empty, or holds versions with no local file (the
 *     2026-09 apply-time ledger shape -- see
 *     docs/operations/migration-ledger-normalisation.md);
 *   - the dry-run's pending set differs from `migration list`'s local-only set;
 *   - (a) a pending version is <= the highest version already applied;
 *   - (b) more than `maxPending` migrations are pending;
 *   - the dry-run would push seed data.
 *
 * `--verify` mode runs after the push: nothing may be pending or remote-only.
 *
 * Usage:
 *   node scripts/ci/migrationGuard.mjs --list list.json --dry-run dry.json [--max 5]
 *   node scripts/ci/migrationGuard.mjs --verify --list list.json
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_PENDING = 5;

const VERSION = /^[0-9]+$/;
const DRY_RUN_FILE = /^([0-9]+)_.*\.sql$/;

export class GuardError extends Error {}

/** The CLI prints `{"_tag":"Error",...}` on failure; surface its message. */
function parseJson(text, what) {
  let value;
  try {
    value = JSON.parse(String(text ?? '').trim());
  } catch {
    throw new GuardError(`${what}: output is not JSON -- was --output-format json passed?`);
  }
  if (value && typeof value === 'object' && value._tag === 'Error') {
    const message = value.error?.message ?? 'unknown error';
    throw new GuardError(`${what}: the CLI reported an error: ${message}`);
  }
  return value;
}

/**
 * Parse `supabase migration list --output-format json`.
 * @returns {{ applied: string[], pending: string[], remoteOnly: string[] }}
 */
export function parseMigrationList(text) {
  const value = parseJson(text, 'migration list');
  if (!value || !Array.isArray(value.migrations)) {
    throw new GuardError('migration list: no "migrations" array in the output');
  }
  if (value.migrations.length === 0) {
    throw new GuardError('migration list: zero rows -- neither local files nor a remote ledger');
  }
  const applied = [];
  const pending = [];
  const remoteOnly = [];
  for (const row of value.migrations) {
    const local = typeof row?.local === 'string' ? row.local.trim() : null;
    const remote = typeof row?.remote === 'string' ? row.remote.trim() : null;
    if (local === null || remote === null) {
      throw new GuardError(
        `migration list: row without string local/remote: ${JSON.stringify(row)}`
      );
    }
    for (const v of [local, remote]) {
      if (v !== '' && !VERSION.test(v)) {
        throw new GuardError(`migration list: "${v}" is not a migration version`);
      }
    }
    if (local === '' && remote === '') {
      throw new GuardError(`migration list: row with neither local nor remote version`);
    }
    if (remote !== '' && local !== '' && remote !== local) {
      throw new GuardError(`migration list: row pairs local ${local} with remote ${remote}`);
    }
    if (remote === '') pending.push(local);
    else if (local === '') remoteOnly.push(remote);
    else applied.push(remote);
  }
  return { applied, pending, remoteOnly };
}

/**
 * Parse `supabase db push --dry-run --output-format json`.
 * @returns {{ pending: string[], seeds: string[] }}
 */
export function parseDryRun(text) {
  const value = parseJson(text, 'db push --dry-run');
  if (!value || value.dryRun !== true) {
    throw new GuardError('db push --dry-run: output does not say dryRun: true');
  }
  if (typeof value.upToDate !== 'boolean' || !Array.isArray(value.migrations)) {
    throw new GuardError('db push --dry-run: missing "upToDate" / "migrations" in the output');
  }
  const pending = value.migrations.map((file) => {
    const m = typeof file === 'string' ? DRY_RUN_FILE.exec(file) : null;
    if (!m) throw new GuardError(`db push --dry-run: "${file}" is not a migration file name`);
    return m[1];
  });
  if (value.upToDate !== (pending.length === 0)) {
    throw new GuardError(
      `db push --dry-run: upToDate=${value.upToDate} contradicts ${pending.length} pending`
    );
  }
  const seeds = Array.isArray(value.seeds) ? value.seeds.map(String) : [];
  return { pending, seeds };
}

/** Read the MAX_PENDING_MIGRATIONS override; unset/empty means the default. */
export function parseMax(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_PENDING;
  const s = String(raw).trim();
  if (!/^[0-9]+$/.test(s) || Number(s) < 1) {
    throw new GuardError(`MAX_PENDING_MIGRATIONS must be a positive integer, got "${s}"`);
  }
  return Number(s);
}

const cmp = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

function checkLedger(list) {
  if (list.applied.length === 0) {
    throw new GuardError(
      'the remote ledger has no applied migrations -- a push would replay every file. ' +
        'Stop: see docs/operations/migration-ledger-normalisation.md'
    );
  }
  if (list.remoteOnly.length > 0) {
    throw new GuardError(
      `the remote ledger has ${list.remoteOnly.length} version(s) with no local file ` +
        `(${list.remoteOnly.slice(0, 5).join(', ')}${list.remoteOnly.length > 5 ? ', ...' : ''}). ` +
        'Do NOT run "migration repair --status reverted": see ' +
        'docs/operations/migration-ledger-normalisation.md'
    );
  }
}

/**
 * The pre-push decision.
 * @returns {{ pending: string[], highestApplied: string }}
 */
export function evaluate({ listText, dryRunText, maxPending = DEFAULT_MAX_PENDING }) {
  const list = parseMigrationList(listText);
  const dry = parseDryRun(dryRunText);
  checkLedger(list);

  const fromList = [...list.pending].sort(cmp);
  const fromDry = [...dry.pending].sort(cmp);
  if (fromList.join(',') !== fromDry.join(',')) {
    throw new GuardError(
      `migration list says pending [${fromList.join(', ')}] but the dry-run would push ` +
        `[${fromDry.join(', ')}] -- the two CLI views disagree; investigate before pushing`
    );
  }
  if (dry.seeds.length > 0) {
    throw new GuardError(`the dry-run would push seed data (${dry.seeds.join(', ')}); refusing`);
  }

  const highestApplied = [...list.applied].sort(cmp).at(-1);
  const outOfOrder = fromDry.filter((v) => cmp(v, highestApplied) <= 0);
  if (outOfOrder.length > 0) {
    throw new GuardError(
      `out-of-order migration(s) ${outOfOrder.join(', ')} are <= the highest applied ` +
        `version ${highestApplied}. Production would run them after later migrations. ` +
        'Rename each to a version above the latest applied one in a new PR (or, if it is ' +
        'already applied in substance, record it with ' +
        '"supabase migration repair --status applied <version>") and re-run.'
    );
  }
  if (fromDry.length > maxPending) {
    throw new GuardError(
      `${fromDry.length} migrations pending (${fromDry.join(', ')}), more than the ` +
        `limit of ${maxPending}. That many at once usually means the ledger has drifted. ` +
        'Check "supabase migration list" against production; if the set is genuinely ' +
        'intended, raise the MAX_PENDING_MIGRATIONS repository variable for one run.'
    );
  }
  return { pending: fromDry, highestApplied };
}

/** The post-push check: nothing pending, nothing remote-only, something applied. */
export function verifyApplied(listText) {
  const list = parseMigrationList(listText);
  checkLedger(list);
  if (list.pending.length > 0) {
    throw new GuardError(`still pending after the push: ${list.pending.join(', ')}`);
  }
  return { applied: list.applied.length };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const summary = (line) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  try {
    const listPath = arg(argv, '--list');
    if (!listPath) throw new GuardError('--list <file> is required');
    const listText = readFileSync(listPath, 'utf8');
    if (argv.includes('--verify')) {
      const { applied } = verifyApplied(listText);
      summary(`Migrations verified: ${applied} applied, none pending.`);
      return 0;
    }
    const dryPath = arg(argv, '--dry-run');
    if (!dryPath) throw new GuardError('--dry-run <file> is required');
    const maxPending = parseMax(arg(argv, '--max') ?? env.MAX_PENDING_MIGRATIONS);
    const { pending, highestApplied } = evaluate({
      listText,
      dryRunText: readFileSync(dryPath, 'utf8'),
      maxPending,
    });
    summary(
      pending.length === 0
        ? `Migration guard: production is up to date (highest applied ${highestApplied}).`
        : `Migration guard: ${pending.length} pending (${pending.join(', ')}), all above ` +
            `${highestApplied}; limit ${maxPending}.`
    );
    return 0;
  } catch (err) {
    const message = err instanceof GuardError ? err.message : `guard crashed: ${err?.message}`;
    console.error(`::error title=Migration guard::${message}`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `**Migration guard FAILED:** ${message}\n`);
    }
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
