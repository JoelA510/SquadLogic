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
 *   - the dry-run would push seed data;
 *   - a version listed in supabase/unapplied-migration-edits.json is applied
 *     but production's ledger (supabase_migrations.schema_migrations, the SQL
 *     the CLI recorded running) lacks the entry's marker: production ran a
 *     different version of the file than the repository holds. Checked before
 *     and after the push; the ledger is read through the Management API's
 *     read-only query endpoint, or from --ledger <file> (tests).
 *
 * `--verify` mode runs after the push: nothing may be pending or remote-only.
 *
 * Usage:
 *   node scripts/ci/migrationGuard.mjs --list list.json --dry-run dry.json [--max 5]
 *     [--unapplied-edits <file>]   (default supabase/unapplied-migration-edits.json)
 *   node scripts/ci/migrationGuard.mjs --verify --list list.json
 *   (either mode also takes --ledger <file>: `[{ version, statements }]`)
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readAllowedEdits } from './migrationVersions.mjs';

export const DEFAULT_MAX_PENDING = 5;

const VERSION = /^[0-9]+$/;
const DRY_RUN_FILE = /^([0-9]+)_.*\.sql$/;

export class GuardError extends Error {}

/**
 * The slice of `fetch` the ledger read uses (tests pass a stand-in).
 * @typedef {(url: string, init: { method: string, headers: Record<string, string>, body: string }) =>
 *   Promise<{ ok: boolean, status?: number, json: () => Promise<unknown> }>} FetchLike
 */

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
 *
 * The ledger, ordering and count checks run on `migration list` FIRST, before
 * the dry-run is even parsed: the CLI's own dry-run exits non-zero on an
 * out-of-order file (suggesting `--include-all`, the unsafe path), so the
 * guard's actionable message must not depend on the dry-run having succeeded.
 * `dryRunExit` is the dry-run's exit status; non-zero is a failure even when
 * its output looks well formed.
 * @param {{ listText: string, dryRunText: string, dryRunExit?: number | string, maxPending?: number, allowedEdits?: { version: string, marker: string }[], ledger?: Map<string, string> }} args
 * @returns {{ pending: string[], highestApplied: string }}
 */
export function evaluate({
  listText,
  dryRunText,
  dryRunExit = 0,
  maxPending = DEFAULT_MAX_PENDING,
  allowedEdits = [],
  ledger = new Map(),
}) {
  const list = parseMigrationList(listText);
  checkLedger(list);
  checkListedEdits(list.applied, allowedEdits, ledger);

  const fromList = [...list.pending].sort(cmp);
  const highestApplied = [...list.applied].sort(cmp).at(-1);
  const outOfOrder = fromList.filter((v) => cmp(v, highestApplied) <= 0);
  if (outOfOrder.length > 0) {
    throw new GuardError(
      `out-of-order migration(s) ${outOfOrder.join(', ')} are <= the highest applied ` +
        `version ${highestApplied}. Production would run them after later migrations. ` +
        'Rename each to a version above the latest applied one in a new PR (or, if it is ' +
        'already applied in substance, record it with ' +
        '"supabase migration repair --status applied <version>") and re-run.'
    );
  }
  if (fromList.length > maxPending) {
    throw new GuardError(
      `${fromList.length} migrations pending (${fromList.join(', ')}), more than the ` +
        `limit of ${maxPending}. That many at once usually means the ledger has drifted. ` +
        'Check "supabase migration list" against production; if the set is genuinely ' +
        'intended, raise the MAX_PENDING_MIGRATIONS repository variable for one run.'
    );
  }

  const dry = parseDryRun(dryRunText);
  if (!/^[0-9]+$/.test(String(dryRunExit).trim())) {
    throw new GuardError(`db push --dry-run exit status "${dryRunExit}" is not a number`);
  }
  if (Number(dryRunExit) !== 0) {
    throw new GuardError(`db push --dry-run exited ${dryRunExit} without reporting an error`);
  }
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
  return { pending: fromDry, highestApplied };
}

/**
 * The listed versions already applied: the ones `checkListedEdits` needs the
 * ledger for.
 */
export function listedApplied(applied, allowedEdits) {
  return allowedEdits.map((e) => e.version).filter((v) => applied.includes(v));
}

/**
 * Every listed version that is applied ran the edited file: its marker is in
 * the statements production's ledger recorded for it. A listed version still
 * pending is fine, since the push about to run applies the edited file.
 * @param {string[]} applied
 * @param {{ version: string, marker: string }[]} allowedEdits
 * @param {Map<string, string>} ledger version -> the recorded statements as text
 */
export function checkListedEdits(applied, allowedEdits, ledger) {
  for (const edit of allowedEdits) {
    if (!applied.includes(edit.version)) continue;
    const ran = ledger.get(edit.version);
    if (ran === undefined) {
      throw new GuardError(
        `${edit.version} is listed in supabase/unapplied-migration-edits.json and applied, ` +
          "but production's ledger statements for it were not read; cannot prove which " +
          'version of the file ran'
      );
    }
    if (!ran.includes(edit.marker)) {
      throw new GuardError(
        `${edit.version} is listed in supabase/unapplied-migration-edits.json, but production ` +
          'ran it without the edit (its ledger statements lack the marker). The CLI never ' +
          're-runs an applied migration: revert the edit in the file and add a new migration.'
      );
    }
  }
}

/** The post-push check: nothing pending, nothing remote-only, listed edits ran. */
export function verifyApplied(listText, { allowedEdits = [], ledger = new Map() } = {}) {
  const list = parseMigrationList(listText);
  checkLedger(list);
  if (list.pending.length > 0) {
    throw new GuardError(`still pending after the push: ${list.pending.join(', ')}`);
  }
  checkListedEdits(list.applied, allowedEdits, ledger);
  return { applied: list.applied.length };
}

/**
 * Parse ledger rows `[{ version, statements }]`, the query endpoint's shape,
 * into version -> statements text. `statements` is a text[] as a JSON array,
 * or its text form.
 */
export function parseLedgerRows(rows) {
  if (!Array.isArray(rows)) {
    throw new GuardError('ledger query: the response is not an array of rows');
  }
  const ledger = new Map();
  for (const row of rows) {
    const version = typeof row?.version === 'string' ? row.version : null;
    if (!version || !VERSION.test(version)) {
      throw new GuardError(`ledger query: row without a version: ${JSON.stringify(row)}`);
    }
    const statements = row.statements;
    if (statements === null || statements === undefined) {
      throw new GuardError(`ledger query: ${version} has no recorded statements`);
    }
    ledger.set(version, Array.isArray(statements) ? statements.join('\n') : String(statements));
  }
  return ledger;
}

/**
 * Read the ledger statements of `versions` from production, through the
 * Management API's read-only SQL endpoint. Versions are digits only (checked
 * here), so they are safe to quote into the query.
 * @param {string[]} versions
 * @param {Record<string, string | undefined>} env
 * @param {FetchLike} [fetchImpl]
 */
export async function fetchLedger(versions, env, fetchImpl = fetch) {
  const ref = env.SUPABASE_PROJECT_ID;
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!ref || !token) {
    throw new GuardError(
      'SUPABASE_PROJECT_ID and SUPABASE_ACCESS_TOKEN are needed to read the ledger of ' +
        versions.join(', ')
    );
  }
  if (!versions.every((v) => VERSION.test(v))) {
    throw new GuardError(`ledger query: not a migration version: ${versions.join(', ')}`);
  }
  const query =
    'select version, statements from supabase_migrations.schema_migrations ' +
    `where version in (${versions.map((v) => `'${v}'`).join(', ')})`;
  const res = await fetchImpl(
    `https://api.supabase.com/v1/projects/${ref}/database/query/read-only`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }
  );
  if (!res.ok) {
    throw new GuardError(`ledger query: the Management API answered ${res.status}`);
  }
  return parseLedgerRows(await res.json());
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** @param {FetchLike} [fetchImpl] */
export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const summary = (line) => {
    console.log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  try {
    const listPath = arg(argv, '--list');
    if (!listPath) throw new GuardError('--list <file> is required');
    const listText = readFileSync(listPath, 'utf8');
    const allowedEdits = readAllowedEdits(arg(argv, '--unapplied-edits'));
    const needed = listedApplied(parseMigrationList(listText).applied, allowedEdits);
    const ledgerPath = arg(argv, '--ledger');
    let ledger = new Map();
    if (ledgerPath) ledger = parseLedgerRows(JSON.parse(readFileSync(ledgerPath, 'utf8')));
    else if (needed.length > 0) ledger = await fetchLedger(needed, env, fetchImpl);
    if (argv.includes('--verify')) {
      const { applied } = verifyApplied(listText, { allowedEdits, ledger });
      summary(`Migrations verified: ${applied} applied, none pending.`);
      return 0;
    }
    const dryPath = arg(argv, '--dry-run');
    if (!dryPath) throw new GuardError('--dry-run <file> is required');
    const maxPending = parseMax(arg(argv, '--max') ?? env.MAX_PENDING_MIGRATIONS);
    const { pending, highestApplied } = evaluate({
      listText,
      dryRunText: readFileSync(dryPath, 'utf8'),
      dryRunExit: arg(argv, '--dry-run-exit') ?? 0,
      maxPending,
      allowedEdits,
      ledger,
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
  main().then((code) => process.exit(code));
}
