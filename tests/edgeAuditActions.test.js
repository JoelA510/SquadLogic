/**
 * Every audit action an Edge Function writes is registered in `audit_actions`.
 *
 * `audit_log.action` is a foreign key to `audit_actions` (20260613000006), so
 * an action string nobody registered fails its insert with 23503. Edge audit
 * writes are fire-and-forget or never-rejecting (`recordAudit` /
 * `recordAuditNow`, `supabase/functions/_shared/auth.ts`): the failure is a
 * console line, the request succeeds, and the row is simply absent.
 *
 * That is not hypothetical. `scheduler.auto_refused` (five auto-scheduler
 * refusal paths) shipped in 8.6 3b PR 11d-0 and was never registered, in the
 * repository or in production. It went unnoticed because every Edge audit
 * write was ALSO failing for a second reason -- the helpers were handed the
 * service-role client, under which `auth.uid()` is NULL -- so fixing that one
 * would have left these five still failing, on the FK instead.
 *
 * The subject set is every `recordAudit(` / `recordAuditNow(` call in the Edge
 * sources, found by scanning the files on disk -- not a list of call sites a
 * new one could be left off. The registered set is read from the migrations,
 * which are what production applies, never from the call sites.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const FUNCTIONS = path.join(ROOT, 'supabase/functions');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
/** The helpers' own file: its one internal call forwards `params` and is skipped. */
const HELPERS = path.join(FUNCTIONS, '_shared/auth.ts');

/**
 * Stated floors, not counts read off the scan: a scan that silently shrinks (a
 * moved directory, a renamed helper) must fail rather than vouch for less.
 */
const MIN_CALL_SITES = 13;
const MIN_REGISTERED = 70;
/** Every function that audits today; each must still yield a call site. */
const AUDITING_FUNCTIONS = [
  'auto-scheduler',
  'fairness-scoring',
  'game-persistence',
  'import-validation',
  'team-persistence',
];

function walk(dir, acc = []) {
  // A missing root yields nothing, so the floors below are what fail.
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Deno tests are not Edge code; they are scanned by nothing here.
      if (full === path.join(FUNCTIONS, '_shared/tests')) continue;
      walk(full, acc);
    } else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/**
 * Index of the end of the text that starts at `from`: the first unmatched
 * closer, or (unless `throughCommas`) the first top-level `,`.
 */
function endOfExpression(src, from, throughCommas = false) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const close = src.indexOf(c, i + 1);
      if (close < 0) throw new Error(`unterminated string at ${i}`);
      i = close;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0 && !throughCommas) return i;
  }
  throw new Error(`unterminated expression at ${from}`);
}

const LITERAL = /^\s*(['"])([^'"]+)\1\s*$/;

/**
 * The action strings an `action:` expression can evaluate to. A single literal,
 * or a conditional whose every branch is a literal; anything else cannot be
 * checked statically and is refused, never skipped.
 */
function actionsOf(expression) {
  const single = LITERAL.exec(expression);
  if (single) return [single[2]];
  const question = expression.indexOf('?');
  if (question >= 0) {
    const branches = expression.slice(question + 1).split(':');
    const literals = branches.map((b) => LITERAL.exec(b));
    if (branches.length === 2 && literals.every(Boolean)) return literals.map((m) => m[2]);
  }
  throw new Error(
    `action is not a string literal or a conditional of literals: ${expression.trim()}`
  );
}

/**
 * `src` with every comment blanked to spaces (newlines kept, so line numbers
 * hold). A doc comment that mentions `recordAudit(...)` is not a call site.
 * Strings are skipped whole, so a `//` inside a URL is not a comment.
 */
function blankComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
      const stop = end <= 1 ? src.length : end;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out;
}

/**
 * The actions named by the TOP-LEVEL `action:` key of the call's second
 * argument, which must be an object literal; `null` when there is none (an
 * `action` shorthand, a variable, a spread). A key nested in `metadata` is not
 * the action, so only depth 0 inside the object is read.
 */
function actionOfParams(args) {
  const second = args.slice(endOfExpression(args, 0) + 1).trimStart();
  if (!second.startsWith('{')) return null;
  const body = second.slice(1, endOfExpression(second, 1, true));
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"' || c === '`') {
      i = body.indexOf(c, i + 1);
      if (i < 0) throw new Error('unterminated string in audit params');
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (
      depth === 0 &&
      /^action\s*:/.test(body.slice(i)) &&
      /(^|[,{\s])$/.test(body.slice(0, i))
    ) {
      const start = body.indexOf(':', i) + 1;
      // The last key has no trailing comma: the object's own closer ends it.
      return actionsOf(body.slice(start, endOfExpression(`${body}}`, start)));
    }
  }
  return null;
}

/** Every audit call in `src`: its line, its argument text and the actions it writes. */
function auditCallsIn(raw) {
  const src = blankComments(raw);
  const calls = [];
  const call = /\brecordAudit(?:Now)?\s*\(/g;
  let m;
  while ((m = call.exec(src))) {
    // A declaration (`function recordAudit(`) is not a call.
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length;
    const close = endOfExpression(src, open, true);
    const args = src.slice(open, close);
    const line = src.slice(0, m.index).split('\n').length;
    calls.push({ line, args, actions: actionOfParams(args) });
  }
  return calls;
}

/** Every action a migration registers with `INSERT INTO audit_actions (action) VALUES ...`. */
function registeredActionsIn(sql) {
  const found = [];
  const insert =
    /insert\s+into\s+(?:public\.)?audit_actions\s*\(\s*action\s*\)\s*values\s*([\s\S]*?);/gi;
  let m;
  while ((m = insert.exec(sql))) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) found.push(lit[1]);
  }
  return found;
}

function collectEdgeCalls() {
  const sites = [];
  const bypasses = [];
  let forwarded = 0;
  for (const file of walk(FUNCTIONS)) {
    const rel = path.relative(ROOT, file);
    const raw = readFileSync(file, 'utf8');
    // Any other route to the RPC, or a renamed helper, would write actions this
    // scan cannot see. The helpers' own file holds the one legitimate RPC call.
    const code = blankComments(raw);
    const rpcs = code.match(/['"]record_audit_event['"]/g)?.length ?? 0;
    if (rpcs !== (file === HELPERS ? 1 : 0))
      bypasses.push(`${rel}: ${rpcs} record_audit_event call(s)`);
    if (/\brecordAudit(?:Now)?\s+as\b/.test(code))
      bypasses.push(`${rel}: imports an audit helper under another name`);
    for (const c of auditCallsIn(raw)) {
      if (file === HELPERS && /^\s*userClient\s*,\s*params\s*$/.test(c.args)) {
        forwarded++;
        continue;
      }
      sites.push({ ...c, file: rel });
    }
  }
  return { sites, forwarded, bypasses };
}

function collectRegistered() {
  const registered = new Set();
  const files = existsSync(MIGRATIONS)
    ? readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
    : [];
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS, f), 'utf8');
    // This test only models additions. A removal would make a registered
    // action unregistered again, so it is refused until the test handles it.
    if (/delete\s+from\s+(?:public\.)?audit_actions\b/i.test(sql)) {
      throw new Error(
        `${f} deletes from audit_actions; teach edgeAuditActions.test.js about removals`
      );
    }
    for (const a of registeredActionsIn(sql)) registered.add(a);
  }
  return registered;
}

describe('Edge audit actions are registered in audit_actions', () => {
  const { sites, forwarded, bypasses } = collectEdgeCalls();
  const registered = collectRegistered();

  it('finds every auditing function and at least the stated number of call sites', () => {
    expect(forwarded).toBe(1);
    expect(sites.length).toBeGreaterThanOrEqual(MIN_CALL_SITES);
    for (const fn of AUDITING_FUNCTIONS) {
      expect(
        sites.some((s) => s.file === `supabase/functions/${fn}/index.ts`),
        fn
      ).toBe(true);
    }
  });

  it('Edge code writes audit rows only through the helpers, under their own names', () => {
    expect(bypasses).toEqual([]);
  });

  it('every call site names its action', () => {
    const unnamed = sites.filter((s) => s.actions === null).map((s) => `${s.file}:${s.line}`);
    expect(unnamed).toEqual([]);
  });

  it('reads a registered set of at least the stated size from the migrations', () => {
    expect(registered.size).toBeGreaterThanOrEqual(MIN_REGISTERED);
  });

  it('registers every action an Edge Function writes', () => {
    const missing = sites.flatMap((s) =>
      (s.actions ?? []).filter((a) => !registered.has(a)).map((a) => `${a} (${s.file}:${s.line})`)
    );
    expect(missing).toEqual([]);
  });
});

describe('the scanners refuse what they cannot read', () => {
  it('refuses an action held in a variable', () => {
    expect(() => auditCallsIn('recordAudit(c, { organizationId, action: someAction });')).toThrow(
      /not a string literal/
    );
  });

  it('refuses a conditional with a non-literal branch', () => {
    expect(() => actionsOf("ok ? 'a.b' : other")).toThrow(/not a string literal/);
  });

  it('reads both branches of a conditional and skips declarations', () => {
    const calls = auditCallsIn(
      'export async function recordAuditNow(\n  c: UserClient,\n) {}\n' +
        "await recordAuditNow(c, { action: n > 0 ? 'import.failed' : 'import.started', metadata: { a: [1, 2] } });"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].actions).toEqual(['import.failed', 'import.started']);
    expect(calls[0].line).toBe(4);
  });

  it('ignores a call that appears only in a comment', () => {
    expect(
      auditCallsIn(
        "// recordAudit(c, { action: x })\n/* await recordAuditNow(c) */\nconst u = 'https://x';"
      )
    ).toEqual([]);
  });

  it('reads the top-level action, not a key nested in metadata', () => {
    const [c] = auditCallsIn(
      "recordAuditNow(c, { metadata: { action: 'game.saved' }, action: 'game.unregistered' });"
    );
    expect(c.actions).toEqual(['game.unregistered']);
  });

  it('reports a call whose only action key is nested, or whose params are not a literal', () => {
    expect(auditCallsIn("recordAudit(c, { metadata: { action: 'game.saved' } });")[0].actions).toBe(
      null
    );
    expect(auditCallsIn('recordAudit(c, params);')[0].actions).toBe(null);
  });

  it('reads multi-row registrations and ignores INSERT ... SELECT', () => {
    expect(
      registeredActionsIn(
        "INSERT INTO public.audit_actions (action) VALUES\n  ('a.one'),\n  ('a.two')\nON CONFLICT (action) DO NOTHING;\n" +
          'INSERT INTO public.audit_actions (action)\nSELECT DISTINCT action FROM public.audit_log;'
      )
    ).toEqual(['a.one', 'a.two']);
  });
});
