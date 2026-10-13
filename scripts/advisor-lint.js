#!/usr/bin/env node
/**
 * Wave 6a Task 2: static "advisor lint" CI gate.
 *
 * Catches regressions of Wave 2's security fixes by grepping
 * supabase/migrations/**.sql for known anti-patterns:
 *
 *   1. SECURITY DEFINER without SET search_path
 *   2. CREATE [OR REPLACE] VIEW without security_invoker = on
 *      (when the migration body suggests RLS-sensitive data)
 *   3. CREATE TABLE ... that doesn't ENABLE ROW LEVEL SECURITY in the same migration
 *   4. Policies USING (true) or WITH CHECK (true)
 *   5. .env.*.example files referencing VITE_*SECRET*, VITE_*PRIVATE*,
 *      VITE_*TOKEN*, VITE_*KEY* (excluding VITE_SUPABASE_ANON_KEY which is public)
 *
 * Exits non-zero on any violation. Treats a "trusted-by-comment" annotation
 * (`-- advisor-lint-allow: <reason>` on the line above) as an explicit waiver.
 *
 * Usage: `npm run check:advisors`
 *
 * NOT a substitute for Supabase's live `get_advisors` MCP — that runs against
 * the deployed DB. This script is the static layer that catches violations
 * before they reach prod.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const ENV_GLOBS = [
  '.env.example',
  '.env.test.example',
  '.env.local.example',
  '.env.production.example',
];

function listSqlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listSqlFiles(full));
    else if (entry.endsWith('.sql')) out.push(full);
  }
  return out;
}

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n');
}

function isWaivedByPrevLine(lines, idx) {
  if (idx === 0) return false;
  const prev = lines[idx - 1].trim();
  return /^--\s*advisor-lint-allow:/.test(prev);
}

function lintMigration(file, allMigrationsText) {
  const violations = [];
  const lines = readLines(file);
  const text = lines.join('\n');
  const path = relative(REPO_ROOT, file);

  // Rule 1: SECURITY DEFINER must be paired with SET search_path EITHER in the
  //   same function body OR fixed by a later ALTER FUNCTION ... SET search_path
  //   elsewhere in the migrations directory. Heuristic: locate the nearest
  //   `FUNCTION public.<name>` token after the SECURITY DEFINER keyword (within
  //   the same CREATE block, looking BACKWARDS) and check whether ANY migration
  //   contains `ALTER FUNCTION ... <name> ... SET search_path`.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines.
    if (/^\s*--/.test(line)) continue;
    if (/SECURITY\s+DEFINER/i.test(line) && !isWaivedByPrevLine(lines, i)) {
      const window = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 40)).join('\n');
      const inBody = /SET\s+search_path/i.test(window);
      if (inBody) continue;
      // Find the function name from the most recent CREATE FUNCTION block in
      // the file (look ALL THE WAY BACK — function bodies can be 100+ lines).
      let fnMatch = null;
      for (let j = i; j >= 0; j--) {
        const m = lines[j].match(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)/i);
        if (m) {
          fnMatch = m;
          break;
        }
      }
      if (fnMatch) {
        const fnName = fnMatch[1];
        const fixerRe = new RegExp(
          `ALTER\\s+FUNCTION\\s+(?:public\\.)?${fnName}\\b[^;]*SET\\s+search_path`,
          'i'
        );
        if (fixerRe.test(allMigrationsText)) continue; // corrected by a later migration
      }
      violations.push(`${path}:${i + 1} — SECURITY DEFINER without SET search_path`);
    }
  }

  // Rule 2: CREATE VIEW without security_invoker — only flag if the file
  // mentions auth.uid or organization_id (i.e. RLS-sensitive context). Also
  // skip if a later migration has ALTER VIEW ... SET (security_invoker = on)
  // for the same view name.
  const isRlsSensitive = /auth\.uid\(\)|organization_id|profile_id/i.test(text);
  if (isRlsSensitive) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?(\w+)/i);
      if (m && !isWaivedByPrevLine(lines, i)) {
        const viewName = m[1];
        const window = lines.slice(i, Math.min(lines.length, i + 30)).join('\n');
        const fileWide = /security_invoker\s*=\s*(on|true)/i.test(text);
        const fixerRe = new RegExp(
          `ALTER\\s+VIEW\\s+(?:public\\.)?${viewName}\\b[^;]*security_invoker\\s*=\\s*(?:on|true)`,
          'i'
        );
        const fixedLater = fixerRe.test(allMigrationsText);
        if (!/security_invoker\s*=\s*(on|true)/i.test(window) && !fileWide && !fixedLater) {
          violations.push(
            `${path}:${i + 1} — CREATE VIEW ${viewName} in RLS-sensitive migration without security_invoker = on`
          );
        }
      }
    }
  }

  // Rule 3: CREATE TABLE without ENABLE ROW LEVEL SECURITY (in same migration
  // OR any later migration).
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines.
    if (/^\s*--/.test(line)) continue;
    const m = line.match(/^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?(\w+)/i);
    if (m && !isWaivedByPrevLine(lines, i)) {
      const tableName = m[1];
      // Skip system / migration-meta tables.
      if (/^(pg_|sql_|schema_migrations|supabase_)/i.test(tableName)) continue;
      const enablePattern = new RegExp(
        `ALTER\\s+TABLE\\s+(?:public\\.)?${tableName}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
        'i'
      );
      if (!enablePattern.test(allMigrationsText)) {
        violations.push(
          `${path}:${i + 1} — CREATE TABLE ${tableName} without ENABLE ROW LEVEL SECURITY in any migration`
        );
      }
    }
  }

  // Rule 4: Policies USING (true) or WITH CHECK (true) — likely over-permissive.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--/.test(line)) continue;
    if (
      (/USING\s*\(\s*true\s*\)/i.test(line) || /WITH\s+CHECK\s*\(\s*true\s*\)/i.test(line)) &&
      !isWaivedByPrevLine(lines, i)
    ) {
      violations.push(`${path}:${i + 1} — over-permissive policy: USING/WITH CHECK (true)`);
    }
  }

  return violations;
}

function lintEnvExamples() {
  const violations = [];
  for (const name of ENV_GLOBS) {
    const path = join(REPO_ROOT, name);
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^\s*(VITE_[A-Z0-9_]+)\s*=/);
      if (!m) continue;
      const key = m[1];
      // Allow-list of known-public Vite env keys that intentionally have secret-shaped names.
      // The test credentials left the VITE_ prefix in M2.2 (TEST_*, read at the Node layer).
      if (
        key === 'VITE_SUPABASE_ANON_KEY' ||
        key === 'VITE_SUPABASE_URL' ||
        key === 'VITE_SENTRY_DSN' ||
        key === 'VITE_APP_VERSION'
      )
        continue;
      if (/SECRET|PRIVATE|TOKEN|KEY|PASSWORD/.test(key)) {
        violations.push(`${name}:${i + 1} — suspicious VITE_* secret-shaped key: ${key}`);
      }
    }
  }
  return violations;
}

function main() {
  const files = listSqlFiles(MIGRATIONS_DIR);
  const allMigrationsText = files.map((f) => readFileSync(f, 'utf8')).join('\n----\n');
  const violations = [];

  for (const f of files) {
    violations.push(...lintMigration(f, allMigrationsText));
  }
  violations.push(...lintEnvExamples());

  if (violations.length > 0) {
    console.error('[advisor-lint] FAIL — security advisor patterns detected:');
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      '\nEach violation maps to a Wave 2 / Wave 7 fix. To explicitly waive, add a SQL comment ' +
        '`-- advisor-lint-allow: <reason>` on the line ABOVE the offending statement.'
    );
    process.exit(1);
  }

  console.log(
    `[advisor-lint] PASS — scanned ${files.length} migration files + env examples; no advisor violations.`
  );
}

main();
