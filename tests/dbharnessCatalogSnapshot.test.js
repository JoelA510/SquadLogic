/**
 * `scripts/dbharness/catalog_snapshot.py`, the catalogue drift check
 * (docs/operations/schema-drift-2026-10.md, docs/operations/ci-cd.md
 * "Catalogue drift check"). The harness runs `diff` against the fresh build on
 * pull requests; the operator runs `compare-sql`'s query against production.
 * These cases pin what each refuses, because a comparison that accepts an
 * empty or truncated catalogue reports health having examined nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TOOL = path.resolve(__dirname, '../scripts/dbharness/catalog_snapshot.py');
const SNAPSHOT = path.resolve(__dirname, '../supabase/catalog-snapshot.json');

let dir;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const run = (...args) => spawnSync('python3', [TOOL, ...args], { encoding: 'utf8' });

function catalogue({ functions = 60, triggers = 12, policies = 31 } = {}) {
  const list = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);
  return {
    functions: list('fn', functions),
    triggers: list('CREATE TRIGGER t', triggers),
    policies: list('table|policy', policies),
  };
}

function write(name, doc) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
}

describe('catalog_snapshot.py diff', () => {
  it('passes identical catalogues, whatever their order', () => {
    const doc = catalogue();
    const shuffled = { ...doc, functions: [...doc.functions].reverse() };
    const res = run('diff', write('a.json', doc), write('b.json', shuffled));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('catalogue matches the snapshot: 60 functions, 12 triggers');
  });

  it('names every entry only one side has, by section, and exits 1', () => {
    const doc = catalogue();
    const drifted = {
      ...doc,
      triggers: [...doc.triggers.slice(1), 'CREATE TRIGGER only_in_production'],
    };
    const res = run('diff', write('snap.json', doc), write('db.json', drifted));
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('triggers, only in the snapshot: CREATE TRIGGER t_0');
    expect(res.stdout).toContain(
      'triggers, only in the database: CREATE TRIGGER only_in_production'
    );
    expect(res.stdout).toContain('2 difference(s)');
  });

  it.each([
    ['an empty file', ''],
    ['an empty catalogue', { functions: [], triggers: [], policies: [] }],
    ['a section under its floor', catalogue({ triggers: 3 })],
    ['a missing section', { functions: catalogue().functions, triggers: catalogue().triggers }],
    ['an unexpected section', { ...catalogue(), views: [] }],
    ['a duplicate entry', { ...catalogue(), functions: [...catalogue().functions, 'fn_0'] }],
    ['a non-string entry', { ...catalogue(), policies: [...catalogue().policies, 7] }],
  ])('refuses %s (exit 2) rather than comparing it', (_name, bad) => {
    const res = run('diff', write('snap.json', catalogue()), write('db.json', bad));
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/^REFUSED: /);
  });

  it('refuses an empty catalogue even against an empty snapshot', () => {
    const empty = { functions: [], triggers: [], policies: [] };
    const res = run('diff', write('a.json', empty), write('b.json', empty));
    expect(res.status).toBe(2);
  });
});

describe('the committed snapshot', () => {
  it('is canonical: what `write` produces from its own content', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-')), 'out.json');
    dir = path.dirname(out);
    execFileSync('python3', [TOOL, 'write', SNAPSHOT, out]);
    expect(fs.readFileSync(out, 'utf8')).toBe(fs.readFileSync(SNAPSHOT, 'utf8'));
  });

  it('holds none of the objects 20261018040000 drops (meta: it holds the ones it keeps)', () => {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const all = [...snap.functions, ...snap.triggers].join('\n');
    expect(all).toContain('admin_update_field(');
    expect(all).toContain('CREATE TRIGGER event_rsvps_set_timestamp');
    for (const gone of [
      'set_updated_at(',
      'handle_field_subunits(',
      'propagate_org_id_from_',
      'set_created_by_to_auth_uid(',
      'p_findings jsonb[]',
      'CREATE TRIGGER set_org_id_',
      'trigger_manage_field_subunits',
    ]) {
      expect(all, gone).not.toContain(gone);
    }
  });
});

describe('catalog_snapshot.py compare-sql and name', () => {
  it('embeds the catalogue query and one key per snapshot entry, and nothing it writes', () => {
    const res = run('compare-sql', SNAPSHOT);
    expect(res.status).toBe(0);
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const keys = res.stdout.match(/unnest\('\{([^}]*)\}'::text\[\]\)/)[1].split(',');
    expect(keys).toHaveLength(snap.functions.length + snap.triggers.length + snap.policies.length);
    expect(res.stdout).toContain('pg_get_triggerdef(t.oid)');
    expect(res.stdout).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT)\b/);
    // `name` turns a key from an only_in_snapshot row back into its entry.
    const named = run('name', SNAPSHOT, keys[0]);
    expect(named.status).toBe(0);
    const keyOf = (section, entry) =>
      section[0] + createHash('md5').update(entry, 'utf8').digest('hex').slice(0, 10);
    const entry = ['functions', 'triggers', 'policies']
      .flatMap((section) => snap[section].map((e) => [keyOf(section, e), e]))
      .find(([k]) => k === keys[0])[1];
    expect(named.stdout.trim()).toBe(`${keys[0]} ${entry}`);
    expect(run('name', SNAPSHOT, 'fnot-a-key').status).toBe(1);
  });
});
