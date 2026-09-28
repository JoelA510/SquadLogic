#!/usr/bin/env node
/**
 * Wave 6a Task 1: bundle-size CI gate.
 *
 * Walks `dist/assets/`, gzips each file in memory, compares against
 * `config/bundle-budget.json`. Exits non-zero on any rule violation.
 *
 * The first-paint set is read from `dist/index.html` (the entry module
 * script, every modulepreload and every stylesheet it loads), not from the
 * rule labels: a renamed or re-split chunk still shows up there, so it cannot
 * silently fall out of the first-paint total. Rules flagged `firstPaint: true`
 * match only files in that set, and every file in that set must be matched by
 * one of them. A rule that matches zero files fails the gate.
 *
 * Usage:
 *   node scripts/check-bundle-size.js                  # run with default paths
 *   node scripts/check-bundle-size.js --dist=./other   # custom dist
 *   node scripts/check-bundle-size.js --budget=./b.json
 *
 * Output: machine-parseable summary (one rule per line) + per-violation detail.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

function parseArgs(argv) {
  const out = { dist: 'dist', budget: 'config/bundle-budget.json' };
  for (const arg of argv.slice(2)) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k && v) out[k] = v;
  }
  return out;
}

function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, base, acc);
    else acc.push({ path: relative(base, full).replace(/\\/g, '/'), full, size: stat.size });
  }
  return acc;
}

function fmt(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
}

/**
 * Extract the assets `index.html` makes the browser fetch before first paint.
 * Paths are returned as `assets/<file>` (leading `/` stripped) so they compare
 * directly with rule regexes and with the walked dist file list.
 *
 * @param {string} html
 * @returns {{ entries: string[], assets: string[] }}
 */
export function parseFirstPaint(html) {
  const entries = [];
  const assets = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    let ref = null;
    if (/^<script/i.test(tag)) {
      if ((attr(tag, 'type') || '').toLowerCase() !== 'module') continue;
      ref = attr(tag, 'src');
      if (ref) entries.push(ref.replace(/^\//, ''));
    } else {
      const rel = (attr(tag, 'rel') || '').toLowerCase();
      if (rel !== 'modulepreload' && rel !== 'stylesheet') continue;
      ref = attr(tag, 'href');
    }
    if (ref) assets.push(ref.replace(/^\//, ''));
  }
  return { entries, assets: [...new Set(assets)] };
}

/**
 * Pure evaluation of a budget against a built file list.
 *
 * @param {object} input
 * @param {{ path: string, size: number, full?: string }[]} input.files - `path` is `assets/<file>`.
 * @param {any} input.budget - parsed `config/bundle-budget.json`.
 * @param {{ entries: string[], assets: string[] }} input.firstPaint - from parseFirstPaint.
 * @param {(file: { path: string, size: number, full?: string }) => number} input.gzipSize
 * @returns {{ passed: string[], warnings: string[], violations: string[], firstPaintTotal: number }}
 */
export function evaluateBudget({ files, budget, firstPaint, gzipSize }) {
  const passed = [];
  const warnings = [];
  const violations = [];
  const rules = (budget && budget.rules) || [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const fpSet = new Set(firstPaint.assets);
  const gzCache = new Map();
  const gz = (f) => {
    if (!gzCache.has(f.path)) gzCache.set(f.path, gzipSize(f));
    return gzCache.get(f.path);
  };

  if (rules.length === 0) violations.push('[CONFIG] budget has no rules');
  if (files.length === 0) violations.push('[NO FILES] dist/assets is empty');
  if (firstPaint.entries.length === 0) {
    violations.push('[FIRST-PAINT] index.html has no <script type="module" src> entry');
  }
  for (const p of firstPaint.assets) {
    if (!byPath.has(p)) violations.push(`[FIRST-PAINT] index.html loads ${p}, not found in dist`);
  }

  const matchedByAny = new Set();
  const matchedByFirstPaintRule = new Set();

  for (const rule of rules) {
    const label = rule.label || rule.match;
    const hasGzip = typeof rule.maxGzipBytes === 'number' && rule.maxGzipBytes > 0;
    const hasRaw = typeof rule.maxRawBytes === 'number' && rule.maxRawBytes > 0;
    if (!rule.match || hasGzip === hasRaw) {
      violations.push(
        `[CONFIG] rule "${label}" needs a match and exactly one of maxGzipBytes / maxRawBytes`
      );
      continue;
    }
    const re = new RegExp(rule.match);
    const regexHits = files.filter((f) => re.test(f.path));
    const matches = rule.firstPaint ? regexHits.filter((f) => fpSet.has(f.path)) : regexHits;

    if (rule.firstPaint) {
      for (const f of regexHits) {
        if (!fpSet.has(f.path)) {
          passed.push(
            `SKIP ${label} (${f.path}): matches the regex but index.html does not load it`
          );
        }
      }
    }
    if (matches.length === 0) {
      violations.push(
        `[NO MATCH] rule "${label}" (${rule.match}) matched no built file` +
          (rule.firstPaint ? ' loaded by index.html' : '') +
          '. A renamed chunk escapes its budget this way; fix the regex or remove the rule.'
      );
      continue;
    }
    for (const f of matches) {
      matchedByAny.add(f.path);
      if (rule.firstPaint) matchedByFirstPaintRule.add(f.path);
      const size = hasGzip ? gz(f) : f.size;
      const cap = hasGzip ? rule.maxGzipBytes : rule.maxRawBytes;
      const kind = hasGzip ? 'GZIP' : 'RAW';
      if (size > cap) {
        violations.push(
          `[${kind}] ${label} (${f.path}): ${fmt(size)} ${kind.toLowerCase()} exceeds budget ${fmt(cap)}`
        );
      } else {
        passed.push(`OK ${label} (${f.path}): ${fmt(size)} ${hasGzip ? 'gz' : 'raw'}`);
      }
    }
  }

  for (const p of firstPaint.assets) {
    if (byPath.has(p) && !matchedByFirstPaintRule.has(p)) {
      violations.push(
        `[UNBUDGETED FIRST-PAINT] ${p} is loaded by index.html but no firstPaint rule matches it`
      );
    }
  }

  for (const f of files) {
    if (!matchedByAny.has(f.path) && !fpSet.has(f.path)) {
      warnings.push(`${f.path} (${fmt(gz(f))} gz)`);
    }
  }

  let firstPaintTotal = 0;
  for (const p of firstPaint.assets) {
    const f = byPath.get(p);
    if (f) firstPaintTotal += gz(f);
  }
  if (typeof budget.totalFirstPaintGzipBytes === 'number') {
    const n = firstPaint.assets.length;
    if (firstPaintTotal > budget.totalFirstPaintGzipBytes) {
      violations.push(
        `[GZIP] total first-paint (${n} files): ${fmt(firstPaintTotal)} gzip exceeds budget ${fmt(budget.totalFirstPaintGzipBytes)}`
      );
    } else {
      passed.push(
        `OK total first-paint (${n} files from index.html): ${fmt(firstPaintTotal)} gz (budget ${fmt(budget.totalFirstPaintGzipBytes)})`
      );
    }
  }

  return { passed, warnings, violations, firstPaintTotal };
}

function main() {
  const args = parseArgs(process.argv);
  const distDir = resolve(REPO_ROOT, args.dist);
  const distRoot = join(distDir, 'assets');
  const budgetPath = resolve(REPO_ROOT, args.budget);

  let budget;
  try {
    budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
  } catch (err) {
    console.error(`[check-bundle-size] FAIL: cannot read budget at ${budgetPath}: ${err.message}`);
    process.exit(2);
  }

  let files;
  let html;
  try {
    files = walk(distRoot).map((f) => ({ ...f, path: `assets/${f.path}` }));
    html = readFileSync(join(distDir, 'index.html'), 'utf8');
  } catch (err) {
    console.error(
      `[check-bundle-size] FAIL: cannot read dist at ${distDir}: ${err.message}\n` +
        `Run \`npm run frontend:build\` first.`
    );
    process.exit(2);
  }

  const { passed, warnings, violations } = evaluateBudget({
    files,
    budget,
    firstPaint: parseFirstPaint(html),
    gzipSize: (f) => gzipSync(readFileSync(f.full)).length,
  });

  for (const line of passed) console.log(line);

  if (warnings.length > 0) {
    console.log(
      `\nWARN ${warnings.length} lazy file(s) match no rule (not loaded by index.html, not budgeted):`
    );
    for (const w of warnings) console.log(`  ${w}`);
  }

  if (violations.length > 0) {
    console.error('\n[check-bundle-size] FAIL — bundle-budget violations:');
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      '\nReview docs/operations/bundle-budget.md before bumping the budget; ' +
        'the default response is to FIX the cause, not loosen the cap.'
    );
    process.exit(1);
  }

  console.log('\n[check-bundle-size] PASS — all chunks within budget.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
