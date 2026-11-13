/**
 * The columns of every `public` table, read from the migrations in order, and of every view, read from the
 * catalogue snapshot the database harness writes from a real build (`supabase/catalog-snapshot.json`).
 *
 * For tests that hold a client read to the database's real shape: the mock client answers a read of a column that
 * does not exist (it filters and sorts whatever keys a row has), and PostgREST refuses it. The table parser reads
 * `CREATE TABLE`, `ALTER TABLE ... ADD/DROP/RENAME COLUMN`, `ALTER TABLE ... RENAME TO` and `DROP TABLE` (a list of tables too); it is
 * held to the snapshot's view of the world by its own test (a table every reader knows has the columns it has).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'supabase/migrations');
const NOT_A_COLUMN = /^(constraint|primary|unique|foreign|check|exclude|like)$/i;
const ident = (text) =>
  text
    .replace(/^public\./i, '')
    .replace(/"/g, '')
    .toLowerCase();

/** Split the body of a CREATE TABLE at its top-level commas. */
function topLevelParts(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** @returns {Map<string, Set<string>>} table name -> its columns, as the migrations leave them */
export function tableColumnsFromMigrations() {
  /** @type {Map<string, Set<string>>} */
  const tables = new Map();
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    // Comments out, so a commented statement is not read as one.
    const sql = readFileSync(path.join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    const statements =
      /\b(create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+([^;]*);|drop\s+table\s+(?:if\s+exists\s+)?([\w."\s,]+?)\s*(?:cascade|restrict|;))/gi;
    let match;
    while ((match = statements.exec(sql))) {
      if (match[2]) {
        // CREATE TABLE: the body up to its matching parenthesis.
        let depth = 1;
        let end = statements.lastIndex;
        while (end < sql.length && depth > 0) {
          if (sql[end] === '(') depth += 1;
          if (sql[end] === ')') depth -= 1;
          end += 1;
        }
        const name = ident(match[2]);
        if (tables.has(name)) continue; // IF NOT EXISTS over a table that exists
        const columns = new Set();
        for (const part of topLevelParts(sql.slice(statements.lastIndex, end - 1))) {
          const first = part.split(/\s+/)[0].replace(/"/g, '');
          if (!NOT_A_COLUMN.test(first)) columns.add(first.toLowerCase());
        }
        tables.set(name, columns);
        statements.lastIndex = end;
      } else if (match[3]) {
        const name = ident(match[3]);
        const columns = tables.get(name);
        const clause = match[4];
        const renamed = /^rename\s+to\s+([\w"]+)/i.exec(clause);
        if (renamed && columns) {
          tables.delete(name);
          tables.set(ident(renamed[1]), columns);
          continue;
        }
        if (!columns) continue;
        for (const add of clause.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)/gi))
          columns.add(ident(add[1]));
        for (const drop of clause.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([\w"]+)/gi))
          columns.delete(ident(drop[1]));
        const col = /rename\s+column\s+([\w"]+)\s+to\s+([\w"]+)/i.exec(clause);
        if (col) {
          columns.delete(ident(col[1]));
          columns.add(ident(col[2]));
        }
      } else if (match[5]) {
        // One statement can drop a list of tables (`DROP TABLE IF EXISTS a, b CASCADE`).
        for (const name of match[5].split(',')) tables.delete(ident(name.trim()));
      }
    }
  }
  return tables;
}

/** @returns {Map<string, string[]>} view name -> its columns in order, from the catalogue snapshot */
export function viewColumnsFromSnapshot() {
  const snapshot = JSON.parse(
    readFileSync(path.join(ROOT, 'supabase/catalog-snapshot.json'), 'utf8')
  );
  return new Map(
    snapshot.views.map((line) => {
      const [name, , , shape] = String(line).split('|');
      return [name, shape.split(', ').map((column) => column.split(' ')[0])];
    })
  );
}

/** Every relation a client can read, by name, with its columns. */
export function relationColumns() {
  const all = new Map([...tableColumnsFromMigrations()].map(([name, set]) => [name, [...set]]));
  for (const [name, columns] of viewColumnsFromSnapshot()) all.set(name, columns);
  return all;
}
