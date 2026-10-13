#!/usr/bin/env node
// Supabase advisors gate (remediation plan M3.3, audit finding 8.6): fails on any WARN or ERROR
// finding of Supabase's own database advisors that docs/security/supabase-advisor-waivers.json
// does not waive with a reason.
//
// The pgTAP job runs `supabase db advisors --local --type all --level warn --fail-on none
// --output-format json` after `supabase start` has applied every migration, saves stdout, and
// passes it here. The CLI's own `--fail-on warn` cannot be used: it has no waivers, and the schema
// carries findings that are accepted by design (every SECURITY DEFINER RPC is executable by
// `authenticated`, because RPCs are how this app writes) or recorded as debt.
//
// The register is held to the bar it enforces:
//   - a waiver names one lint and the objects (`schema.name`, or `project` for a finding that names
//     no database object) it covers, and says why;
//   - `expires` is null (accepted by design) or a date at most MAX_DEBT_DAYS out (debt); an expired
//     waiver covers nothing;
//   - a waived object the advisors no longer report fails (a stale entry would otherwise
//     pre-approve the finding if it ever came back), and so does a waiver for an INFO lint, which
//     this gate never reads.
// And "couldn't check" is never "clean": unreadable output, a CLI error object, or a finding
// without a lint name, level or object exits 2.
//
// Run: node scripts/ci/supabaseAdvisors.mjs --input advisors.json
//      [--waivers docs/security/supabase-advisor-waivers.json] [--today 2026-10-13]
// Exit: 0 clean, 1 an unwaived finding or a register problem, 2 couldn't check.
// Tests: tests/supabaseAdvisors.test.js.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_WAIVERS = 'docs/security/supabase-advisor-waivers.json';
const BLOCKING = new Set(['WARN', 'ERROR']);
const LEVELS = new Set(['INFO', 'WARN', 'ERROR']);
const MAX_DEBT_DAYS = 180;
const MIN_REASON = 40;
/** The object key of a finding that names no schema or object (a project-level setting). */
const PROJECT = 'project';

export class CheckError extends Error {} // couldn't check: exit 2

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
  if (!args.input) throw new CheckError('--input <advisors JSON> is required.');
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

/**
 * Every finding of a `supabase db advisors --output-format json` report, INFO included, each with
 * the `schema.name` key waivers use. Throws CheckError when the report is not one, or is empty:
 * this schema always has INFO findings (unindexed foreign keys among them), so a report with none
 * at all examined nothing.
 * @param {unknown} report
 * @returns {{ lint: string, level: string, object: string, detail: string }[]}
 */
export function readFindings(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new CheckError('The advisors output is not a JSON object.');
  }
  const r = /** @type {Record<string, any>} */ (report);
  if (r._tag === 'Error' || r.error) {
    throw new CheckError(
      `The advisors command reported an error, so nothing was checked: ${JSON.stringify(r.error ?? r)}`
    );
  }
  if (!Array.isArray(r.results)) {
    throw new CheckError(
      'The advisors output has no "results" array; the CLI format may have changed.'
    );
  }
  if (r.results.length === 0) {
    throw new CheckError(
      'The advisors reported nothing, not even INFO. This schema always has INFO findings, so the ' +
        'run examined nothing (was it pointed at an empty database, or run with --level above info?).'
    );
  }
  return r.results.map((finding, i) => {
    const lint = finding?.name;
    const level = finding?.level;
    const schema = finding?.metadata?.schema;
    const name = finding?.metadata?.name;
    if (typeof lint !== 'string' || !lint || !LEVELS.has(level)) {
      throw new CheckError(`results[${i}] has no lint name or a level outside INFO/WARN/ERROR.`);
    }
    const detail = String(finding.detail ?? '');
    // A project-level finding (an Auth setting, say) names no database object at all.
    if (schema === undefined && name === undefined) return { lint, level, object: PROJECT, detail };
    if (typeof schema !== 'string' || typeof name !== 'string' || !schema || !name) {
      throw new CheckError(`results[${i}] (${lint}) names no object (metadata.schema/name).`);
    }
    return { lint, level, object: `${schema}.${name}`, detail };
  });
}

/**
 * The register's waivers, validated. Problems are returned, not thrown: a bad register fails
 * the gate (exit 1) but the findings are still reported.
 * @param {unknown} register
 * @param {Date} today
 */
export function readWaivers(register, today) {
  const problems = [];
  /** @type {Map<string, { index: number, expired: boolean }>} key `lint object` */
  const covers = new Map();
  const list = /** @type {any} */ (register)?.waivers;
  if (!Array.isArray(list))
    throw new CheckError('The waiver register is not { "waivers": [...] }.');
  const latest = new Date(today.getTime() + MAX_DEBT_DAYS * 86_400_000);
  list.forEach((w, index) => {
    const where = `waivers[${index}]`;
    if (w === null || typeof w !== 'object' || Array.isArray(w)) {
      problems.push(`${where}: must be an object.`);
      return;
    }
    if (typeof w.lint !== 'string' || !/^[a-z0-9_]+$/.test(w.lint)) {
      problems.push(
        `${where}: "lint" must be the advisor's lint name (for example auth_rls_initplan).`
      );
    }
    if (typeof w.reason !== 'string' || w.reason.trim().length < MIN_REASON) {
      problems.push(
        `${where}: "reason" must say why this is acceptable here (at least ${MIN_REASON} characters).`
      );
    }
    let expired = false;
    if (!('expires' in w)) {
      problems.push(
        `${where}: "expires" is required: null (accepted by design) or a YYYY-MM-DD date (debt).`
      );
    } else if (w.expires !== null) {
      const date = parseDate(w.expires);
      if (!date) problems.push(`${where}: "expires" must be null or a real YYYY-MM-DD date.`);
      else if (date > latest) {
        problems.push(`${where}: "expires" ${w.expires} is more than ${MAX_DEBT_DAYS} days out.`);
      } else if (date < today) {
        expired = true;
        problems.push(
          `${where} (${w.lint}) expired on ${w.expires}: fix the findings or renew it with a new reason.`
        );
      }
    }
    if (!Array.isArray(w.objects) || w.objects.length === 0) {
      problems.push(`${where}: "objects" must list the schema.name objects it covers.`);
      return;
    }
    for (const object of w.objects) {
      if (typeof object !== 'string' || !(object === PROJECT || /^[\w$]+\.[\w$]+$/.test(object))) {
        problems.push(
          `${where}: object ${JSON.stringify(object)} is not schema.name (or ${PROJECT}).`
        );
        continue;
      }
      const key = `${w.lint} ${object}`;
      if (covers.has(key)) {
        problems.push(
          `${where}: ${w.lint} on ${object} is already waived by waivers[${covers.get(key)?.index}].`
        );
        continue;
      }
      covers.set(key, { index, expired });
    }
  });
  return { covers, problems };
}

/**
 * The verdict over the WARN and ERROR findings (INFO is never read): what blocks, and the
 * register's problems, stale and expired entries included.
 * @param {ReturnType<typeof readFindings>} all
 * @param {ReturnType<typeof readWaivers>} waivers
 */
export function evaluate(all, { covers, problems }) {
  const findings = all.filter((f) => BLOCKING.has(f.level));
  const unwaived = [];
  const used = new Set();
  for (const f of findings) {
    const key = `${f.lint} ${f.object}`;
    const waiver = covers.get(key);
    if (waiver) used.add(key);
    if (!waiver || waiver.expired) unwaived.push(f);
  }
  /** @type {Map<number, string[]>} waiver index -> objects it waives that nothing reported */
  const staleByWaiver = new Map();
  for (const [key, { index }] of covers) {
    if (used.has(key)) continue;
    staleByWaiver.set(index, [...(staleByWaiver.get(index) ?? []), key.split(' ')[1]]);
  }
  const stale = [...staleByWaiver].map(([index, objects]) => {
    const lint = [...covers].find(([, w]) => w.index === index)?.[0].split(' ')[0];
    return `waivers[${index}] (${lint}): the advisors no longer report ${objects.join(', ')}; remove them from the register.`;
  });
  return { blocking: findings.length, unwaived, problems: [...problems, ...stale] };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = args.today
    ? parseDate(args.today)
    : new Date(new Date().toISOString().slice(0, 10));
  if (!today) throw new CheckError(`--today must be YYYY-MM-DD, got ${args.today}.`);
  const findings = readFindings(readJson(resolve(args.input), 'Advisors output'));
  const waiversPath = args.waivers ? resolve(args.waivers) : resolve(ROOT, DEFAULT_WAIVERS);
  const waivers = readWaivers(readJson(waiversPath, 'Waiver register'), today);
  const { blocking, unwaived, problems } = evaluate(findings, waivers);

  console.log(
    `Supabase advisors: ${findings.length} finding(s), ${blocking} at WARN or ERROR: ` +
      `${blocking - unwaived.length} waived, ${unwaived.length} not. ` +
      `${waivers.covers.size} waived object(s) in the register.`
  );
  for (const f of unwaived)
    console.log(`::error::${f.level} ${f.lint} on ${f.object}: ${f.detail}`);
  for (const p of problems) console.log(`::error::${p}`);
  if (unwaived.length || problems.length) {
    console.log(
      'Fix the finding in a migration (with docs/sql revert and smoke scripts), or waive it with a ' +
        `reason in ${DEFAULT_WAIVERS}. See docs/operations/ci-cd.md ("Supabase advisors").`
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.log(`::error::Supabase advisors gate could not check: ${error.message}`);
    process.exitCode = 2;
  }
}
