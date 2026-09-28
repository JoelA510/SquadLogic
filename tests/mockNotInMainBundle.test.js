/**
 * The mock Supabase client must stay out of the production main entry.
 *
 * `frontend/src/lib/supabaseClient.js` once imported `mockSupabaseClient.js`
 * statically, which put the whole mock (~23 KB gzip) in the main entry of
 * every production build. It now loads it with a dynamic import. These checks
 * fail if any of that regresses:
 *   - a static import of the mock from any frontend module,
 *   - a top-level `await` in supabaseClient.js: the mock chunk imports shared
 *     modules back from the main entry chunk, so awaiting it at top level
 *     deadlocks the built app in mock mode (measured: blank page), and
 *   - main.jsx rendering before the mock client has been assigned.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'frontend/src');
const CLIENT = path.join(SRC, 'lib/supabaseClient.js');
const MAIN = path.join(SRC, 'main.jsx');

/** Every .js/.jsx file under frontend/src, from the filesystem. */
function listSources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

/** Static `import`/`export ... from` specifiers naming the mock module. */
function staticMockImports(source) {
  const re = /^\s*(?:import|export)\b[^;]*?['"]([^'"]*mockSupabaseClient(?:\.js)?)['"]/gm;
  return [...source.matchAll(re)].map((m) => m[1]);
}

/** Parse JavaScript source with the TypeScript compiler (a direct devDependency). */
function parseAst(code) {
  return ts.createSourceFile('source.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

/** Await expressions (and `for await`) reachable without entering a function body. */
function topLevelAwaits(node, found = []) {
  if (ts.isFunctionLike(node)) return found;
  if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
    found.push(node.getStart());
  }
  ts.forEachChild(node, (child) => {
    topLevelAwaits(child, found);
  });
  return found;
}

describe('mock Supabase client stays out of the main bundle', () => {
  it('no frontend module imports mockSupabaseClient.js statically', () => {
    const files = listSources(SRC);
    // Meta-assertions: the walk found the tree, including the switcher itself.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(CLIENT);

    const offenders = files
      .map((file) => [path.relative(ROOT, file), staticMockImports(readFileSync(file, 'utf8'))])
      .filter(([, specs]) => specs.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the static-import detector catches the import it guards against', () => {
    expect(staticMockImports("import { mockSupabase } from './mockSupabaseClient.js';\n")).toEqual([
      './mockSupabaseClient.js',
    ]);
    expect(staticMockImports("export { mockSupabase } from './mockSupabaseClient.js';\n")).toEqual([
      './mockSupabaseClient.js',
    ]);
    expect(staticMockImports("  const m = await import('./mockSupabaseClient.js');\n")).toEqual([]);
  });

  it('supabaseClient.js loads the mock with a dynamic import', () => {
    const source = readFileSync(CLIENT, 'utf8');
    expect(source).toMatch(/\bimport\(\s*['"]\.\/mockSupabaseClient\.js['"]\s*\)/);
  });

  it('supabaseClient.js has no top-level await', () => {
    const ast = parseAst(readFileSync(CLIENT, 'utf8'));
    expect(ast.statements.length).toBeGreaterThan(0);
    expect(topLevelAwaits(ast)).toEqual([]);
  });

  it('the top-level-await detector sees top-level awaits and skips function bodies', () => {
    expect(topLevelAwaits(parseAst('const a = await import("./x.js");'))).toHaveLength(1);
    expect(topLevelAwaits(parseAst('if (a) await b;'))).toHaveLength(1);
    expect(topLevelAwaits(parseAst('async function f() { await b; }'))).toEqual([]);
    expect(topLevelAwaits(parseAst('const f = async () => { await b; };'))).toEqual([]);
  });

  it('main.jsx renders only after supabaseReady settles, and shows an error if it rejects', () => {
    const source = readFileSync(MAIN, 'utf8');
    const ready = source.indexOf('supabaseReady.then(');
    expect(ready).toBeGreaterThan(-1);
    const renders = [...source.matchAll(/\.render\(/g)].map((m) => m.index);
    // Meta-assertion: both the app render and the error render were found.
    expect(renders).toHaveLength(2);
    for (const at of renders) expect(at).toBeGreaterThan(ready);
    // The rejection handler logs through the logger and renders an alert.
    expect(source.indexOf('logger.error(', ready)).toBeGreaterThan(ready);
    expect(source.indexOf('role="alert"', ready)).toBeGreaterThan(ready);
  });

  it('supabaseClient.js assigns the mock to supabase and settles supabaseReady from it', () => {
    const source = readFileSync(CLIENT, 'utf8');
    expect(source).toMatch(/^export let supabase = IS_MOCK_MODE\b/m);
    expect(source).toMatch(/^export const supabaseReady = IS_MOCK_MODE \? loadMockClient\(\)/m);
    expect(source).toMatch(
      /const \{ mockSupabase \} = await import\('\.\/mockSupabaseClient\.js'\);\s*supabase = /
    );
  });
});
