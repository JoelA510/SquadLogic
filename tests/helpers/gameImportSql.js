/**
 * The SQL of the games import AS IT STANDS: the text of `20261121010000_game_import.sql` with the body of every
 * function a later migration replaced swapped for its latest definition.
 *
 * Why: the tests that hold core, the mock and the Edge mirror to "the SQL" read that migration's text. A migration
 * cannot patch a function, so `20261122010000_game_scores.sql` (F11-2) replaced `apply_game_import_job`,
 * `rollback_game_import_job`, `cancel_ready_import_job` and the guard whole, and a test still reading the old file
 * would hold everything to a body the database no longer runs (the F11 plan's finding 2: a census by file finds stale
 * bodies; read the latest definition). The statement keeps the header it had in the old file (`CREATE FUNCTION` or
 * `CREATE OR REPLACE FUNCTION`), so a test that finds a function by that text still does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'supabase/migrations');
const BASE = '20261121010000_game_import.sql';
const START = /^CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\(/;
const END = /^\$(?:function)?\$;$/;

/** Every `CREATE [OR REPLACE] FUNCTION public.<name>(` statement of a file, as `{ name, start, end }` line spans. */
function functionSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = START.exec(lines[i]);
    if (!match) continue;
    let j = i;
    while (j < lines.length && !END.test(lines[j])) j += 1;
    if (j === lines.length) throw new Error(`no end of function ${match[1]} found`);
    spans.push({ name: match[1], start: i, end: j });
    i = j;
  }
  return spans;
}

/** @returns {{ sql: string, replaced: Record<string, string> }} the text, and which file each swapped body is from */
export function gameImportSqlAsItStands() {
  const baseLines = readFileSync(path.join(DIR, BASE), 'utf8').split('\n');
  const later = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql') && name > BASE)
    .sort();
  /** @type {Map<string, { file: string, lines: string[] }>} */
  const latest = new Map();
  for (const file of later) {
    const lines = readFileSync(path.join(DIR, file), 'utf8').split('\n');
    for (const span of functionSpans(lines)) {
      latest.set(span.name, { file, lines: lines.slice(span.start, span.end + 1) });
    }
  }
  /** @type {Record<string, string>} */
  const replaced = {};
  const out = [];
  let cursor = 0;
  for (const span of functionSpans(baseLines)) {
    const newer = latest.get(span.name);
    if (!newer) continue;
    out.push(...baseLines.slice(cursor, span.start));
    // The header as the old file wrote it, then the newer statement's own lines after its first.
    out.push(baseLines[span.start], ...newer.lines.slice(1));
    cursor = span.end + 1;
    replaced[span.name] = newer.file;
  }
  out.push(...baseLines.slice(cursor));
  return { sql: out.join('\n'), replaced };
}

export const GAME_IMPORT_SQL = gameImportSqlAsItStands().sql;
