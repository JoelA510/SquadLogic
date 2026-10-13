#!/usr/bin/env node
// Dependency audit gate: fails on any high or critical advisory in the installed tree (runtime,
// dev, optional, and peer dependencies) that isn't covered by a current, reasoned waiver.
// The policy: docs/security/dependency-policy.md. Adopted from agent-ready-template 1.0.0's
// scripts/check-audit.mjs (remediation plan M2.1, audit finding 8.1); tests in
// tests/checkAudit.test.js.
//
// The register (docs/security/audit-waivers.json) is held to the same bar as the advisories: a
// waiver covers one advisory in one package, it must expire within MAX_WAIVER_DAYS, an expired
// waiver covers nothing, and a waiver for an advisory/package the audit no longer reports fails
// (a stale entry would otherwise pre-approve the advisory if it ever came back).
//
// And the gate is held to the bar it enforces: if the report can't be read, says it audited no
// dependencies, or what it parsed doesn't reconcile with npm's own totals, it fails — "couldn't
// check" is never "clean".
//
// Run: node scripts/check-audit.mjs                              (npm run check:audit)
//      node scripts/check-audit.mjs --input audit.json --waivers w.json --today 2026-01-01
//      (--input reads a saved `npm audit --json` report instead of running npm; paths resolve
//      against the current directory; the default register resolves against the repo root)
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BLOCKING = new Set(['high', 'critical']);
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const MAX_WAIVER_DAYS = 90;
const DEFAULT_WAIVERS = 'docs/security/audit-waivers.json';

class CheckError extends Error {} // couldn't check: exit 2

function parseArgs(argv) {
  const args = {};
  const known = new Set(['input', 'waivers', 'today']);
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || !known.has(match[1])) throw new CheckError(`Unknown argument: ${argv[i]}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--'))
      throw new CheckError(`--${match[1]} needs a value.`);
    args[match[1]] = value;
  }
  return args;
}

// A real calendar date in YYYY-MM-DD, or undefined. `2026-02-31` is not a date.
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? undefined
    : date;
}

function readJson(path, what) {
  if (!existsSync(path)) throw new CheckError(`${what} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new CheckError(`${what} is not valid JSON (${path}): ${error.message}`);
  }
}

// --- The audit report ---------------------------------------------------------------------------

function loadReport(args) {
  if (args.input) return readJson(resolve(args.input), '--input report');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // `--include` overrides any `omit` from NODE_ENV=production, npm_config_omit, or .npmrc, which
  // would otherwise silently drop whole dependency classes from the report.
  const result = spawnSync(
    npm,
    ['audit', '--json', '--include=dev', '--include=optional', '--include=peer'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  // npm audit exits non-zero whenever it finds anything, so the exit code alone says nothing;
  // the JSON on stdout is the result. No JSON means the audit didn't run.
  try {
    return JSON.parse(result.stdout);
  } catch {
    const why = result.error
      ? `${result.error.code ?? ''} ${result.error.message}`.trim()
      : `exit ${result.status}`;
    throw new CheckError(
      `npm audit produced no report (${why}). The audit didn't run, so nothing was checked.` +
        (result.stderr ? `\n${result.stderr.trim()}` : '')
    );
  }
}

// Collapse npm's per-package entries into advisory/package pairs, and reconcile the result with
// npm's own accounting: every high/critical package entry must trace (through string `via`
// references) to an advisory we parsed, and the per-severity package counts must match
// `metadata.vulnerabilities`. If npm's report shape ever changes, this fails instead of reading
// every advisory as absent.
function advisories(report) {
  const vulns = report?.vulnerabilities;
  if (vulns === null || typeof vulns !== 'object' || Array.isArray(vulns)) {
    throw new CheckError(
      'Audit report has no "vulnerabilities" object — not an `npm audit --json` report.'
    );
  }
  const byId = new Map(); // GHSA -> { id, severity, title, packages: Set }
  const direct = new Set(); // packages carrying at least one parsed advisory
  for (const [pkg, vuln] of Object.entries(vulns)) {
    for (const via of vuln?.via ?? []) {
      if (typeof via !== 'object' || via === null) continue; // a string `via` points at another package
      const id = /GHSA-[\w-]+/.exec(via.url ?? '')?.[0] ?? `npm-${via.source}`;
      const entry = byId.get(id) ?? {
        id,
        severity: via.severity,
        title: via.title,
        packages: new Set(),
      };
      entry.packages.add(pkg);
      byId.set(id, entry);
      direct.add(pkg);
    }
  }

  const tracesToAdvisory = (pkg, seen = new Set()) => {
    if (direct.has(pkg)) return true;
    if (seen.has(pkg)) return false;
    seen.add(pkg);
    return (vulns[pkg]?.via ?? []).some((v) => typeof v === 'string' && tracesToAdvisory(v, seen));
  };
  const unaccounted = Object.entries(vulns)
    .filter(([pkg, v]) => BLOCKING.has(v?.severity) && !tracesToAdvisory(pkg))
    .map(([pkg, v]) => `${pkg} (${v.severity})`);
  if (unaccounted.length) {
    throw new CheckError(
      `Couldn't trace these high/critical entries to an advisory: ${unaccounted.join(', ')}. ` +
        `The npm audit report format may have changed; the gate can't vouch for this tree.`
    );
  }
  // A report that audited nothing is not a clean report (SquadLogic CLAUDE.md: a check that
  // matches zero records is a loud failure). npm counts the dependencies it audited in
  // `metadata.dependencies.total`, and its per-severity totals in `metadata.vulnerabilities`;
  // both are required, so a format change that drops them cannot read as "clean".
  const audited = report.metadata?.dependencies?.total;
  if (!Number.isInteger(audited) || audited <= 0) {
    throw new CheckError(
      `The audit report says it examined ${JSON.stringify(audited ?? null)} dependencies ` +
        '(metadata.dependencies.total). An audit of nothing is not a pass.'
    );
  }
  const totals = report.metadata?.vulnerabilities;
  if (totals === null || typeof totals !== 'object') {
    throw new CheckError(
      'The audit report has no metadata.vulnerabilities totals to reconcile against.'
    );
  }
  const counted = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const v of Object.values(vulns)) if (v?.severity in counted) counted[v.severity]++;
  const mismatch = SEVERITIES.filter((s) => (totals[s] ?? 0) !== counted[s]);
  if (mismatch.length) {
    throw new CheckError(
      `Parsed package counts don't match npm's totals for ${mismatch.join(', ')} ` +
        `(${mismatch.map((s) => `${counted[s]} vs ${totals[s]}`).join(', ')}). Not trusting a partial read.`
    );
  }
  return [...byId.values()];
}

// --- The waiver register ------------------------------------------------------------------------

function loadWaivers(args, today) {
  const path = args.waivers ? resolve(args.waivers) : resolve(ROOT, DEFAULT_WAIVERS);
  const register = readJson(path, 'Waiver register');
  if (!Array.isArray(register?.waivers))
    throw new CheckError(`${path}: expected { "waivers": [...] }.`);
  const problems = [];
  const seen = new Set();
  const latest = new Date(today.getTime() + MAX_WAIVER_DAYS * 86_400_000);
  register.waivers.forEach((w, i) => {
    const where = `waivers[${i}]`;
    if (w === null || typeof w !== 'object' || Array.isArray(w))
      return problems.push(`${where}: must be an object.`);
    const str = (key) => (typeof w[key] === 'string' ? w[key].trim() : '');
    // The id the report gives the advisory (see byId above): its GHSA id, or npm-<number> for one
    // with no GHSA link, so every reported advisory can be waived.
    if (!/^(GHSA-[\w-]+|npm-\d+)$/.test(str('advisory'))) {
      problems.push(
        `${where}: "advisory" must be the id the audit reports: a GHSA id, or npm-<number> for an advisory without one.`
      );
    }
    if (!str('package'))
      problems.push(
        `${where}: "package" is required — a waiver covers one advisory in one package.`
      );
    if (str('reason').length < 40) {
      problems.push(
        `${where}: "reason" must be a string saying why this is acceptable here (at least 40 characters).`
      );
    }
    if (!str('owner'))
      problems.push(`${where}: "owner" is required — who revisits this when it expires.`);
    const expires = parseDate(w.expires);
    if (!expires) problems.push(`${where}: "expires" must be a real date, YYYY-MM-DD.`);
    else if (expires > latest) {
      problems.push(
        `${where}: "expires" ${w.expires} is more than ${MAX_WAIVER_DAYS} days out; renew it later instead.`
      );
    }
    const key = `${str('advisory')}|${str('package')}`;
    if (seen.has(key))
      problems.push(`${where}: duplicate waiver for ${str('advisory')} in ${str('package')}.`);
    seen.add(key);
  });
  if (problems.length)
    throw new CheckError(`Invalid waiver register ${path}:\n  ${problems.join('\n  ')}`);
  // Matching uses the trimmed values validation checked, so a stray space in the register can't
  // make a valid waiver silently cover nothing.
  return register.waivers.map((w) => ({
    ...w,
    advisory: w.advisory.trim(),
    package: w.package.trim(),
  }));
}

// --- Run ----------------------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const todayString = args.today ?? new Date().toISOString().slice(0, 10);
  const today = parseDate(todayString);
  if (!today)
    throw new CheckError(`--today must be a real date, YYYY-MM-DD; got "${todayString}".`);

  const found = advisories(loadReport(args));
  const waivers = loadWaivers(args, today);
  const current = (w) => w.expires >= todayString;
  const waiverFor = (id, pkg) =>
    waivers.find((w) => w.advisory === id && w.package === pkg && current(w));

  const blocking = found.filter((a) => BLOCKING.has(a.severity));
  const uncovered = blocking.flatMap((a) =>
    [...a.packages].filter((pkg) => !waiverFor(a.id, pkg)).map((pkg) => ({ ...a, pkg }))
  );
  const expired = waivers.filter((w) => !current(w));
  const stale = waivers.filter(
    (w) => !found.some((a) => a.id === w.advisory && a.packages.has(w.package))
  );

  const line = (a, pkg) => `${a.severity.padEnd(8)} ${a.id}  ${pkg} — ${a.title}`;
  const summary = [
    `npm audit: ${found.length} advisor${found.length === 1 ? 'y' : 'ies'}, ${blocking.length} high or critical.`,
  ];
  for (const a of found.filter((x) => !BLOCKING.has(x.severity))) {
    summary.push(`  · ${line(a, [...a.packages].join(', '))} (reported; below the blocking bar)`);
  }
  for (const a of blocking) {
    for (const pkg of a.packages) {
      const w = waiverFor(a.id, pkg);
      if (w) summary.push(`  ~ ${line(a, pkg)} (waived until ${w.expires}, owner ${w.owner})`);
    }
  }
  console.log(summary.join('\n'));

  const errors = [
    ...uncovered.map(
      (a) =>
        `Unwaived: ${line(a, a.pkg)}\n    Fix it (npm audit fix, or bump the direct dependency), or waive it in ${DEFAULT_WAIVERS}.`
    ),
    ...expired.map(
      (w) =>
        `Expired waiver: ${w.advisory} (${w.package}) expired ${w.expires}. Fix the advisory or renew the waiver with a fresh reason.`
    ),
    ...stale.map(
      (w) =>
        `Stale waiver: ${w.advisory} is no longer reported in ${w.package}. Delete it so it can't pre-approve the advisory if it returns.`
    ),
  ];
  // On GitHub Actions, put the full picture (moderates included) on the run's summary page.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '### Dependency audit',
      '',
      '```',
      ...summary,
      ...errors.map((e) => `✗ ${e}`),
      '```',
      '',
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
  }
  if (errors.length) {
    for (const e of errors) console.error(`\n✗ ${e}`);
    return 1;
  }
  console.log('✓ No unwaived high or critical advisories; every waiver is current.');
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  if (error instanceof CheckError) {
    console.error(`✗ ${error.message}`);
    process.exit(2);
  }
  throw error;
}
