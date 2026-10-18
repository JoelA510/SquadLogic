import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/PLAN_AUDIT_IN_TRANSACTION.md section 3.2, pinned at the SOURCE as
// practicePersistenceUserClient.test.js pins #64: vitest cannot import an Edge
// Function (Deno URL imports) and the E2E suite replaces it with `page.route`.
//
// `persist_team_schedule` and `persist_game_schedule` now write their own audit
// row in the save's transaction and refuse a caller with no user. So each
// handler must call its RPC with the caller's client (on the service-role
// client every save is refused 42501), must not write the audit row a second
// time after the save, and must answer a rolled-back save (SLA01) with the
// AUDIT_WRITE_FAILED 500, logged. The game handler must also check the caller
// is an organization admin, as the team handler does (plan Q6).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Strip comments so a commented-out call cannot satisfy or defeat a match. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The client each `persist<X>Snapshot(...)` call passes, and the user-client bindings. */
function persistCallSites(code, persistFn) {
  const clients = [
    ...code.matchAll(new RegExp(`await\\s+${persistFn}\\(\\s*(\\w+)\\s*,`, 'g')),
  ].map((m) => m[1]);
  const userClients = [...code.matchAll(/const\s+(\w+)\s*=\s*createUserClient\(\s*req\s*,/g)].map(
    (m) => m[1]
  );
  return { clients, userClients };
}

const HANDLERS = [
  {
    name: 'team-persistence',
    rpc: 'persist_team_schedule',
    persistFn: 'persistTeamSnapshot',
    save: 'Team save',
  },
  {
    name: 'game-persistence',
    rpc: 'persist_game_schedule',
    persistFn: 'persistGameSnapshot',
    save: 'Game save',
  },
];

for (const handler of HANDLERS) {
  describe(`${handler.name} saves as the caller, audited in the RPC`, () => {
    const code = codeOf(
      readFileSync(path.join(REPO_ROOT, `supabase/functions/${handler.name}/index.ts`), 'utf8')
    );

    it('the only RPC call is inside the persist helper, on the client it is handed', () => {
      const rpcCalls = [...code.matchAll(new RegExp(`(\\w+)\\.rpc\\(\\s*'${handler.rpc}'`, 'g'))];
      expect(rpcCalls.map((m) => m[1])).toEqual(['supabaseClient']);
      expect(code).toMatch(
        new RegExp(`async function ${handler.persistFn}\\(\\s*supabaseClient: SupabaseClient`)
      );
    });

    it('the handler hands it the user client built from the anon key, never the service role', () => {
      const { clients, userClients } = persistCallSites(code, handler.persistFn);
      // Meta-assertion: a call site the regex no longer finds must fail, not pass.
      expect(clients).toHaveLength(1);
      expect(userClients).toHaveLength(1);
      expect(clients[0]).toBe(userClients[0]);
      expect(clients[0]).not.toBe('serviceClient');
      expect(code).toMatch(/createUserClient\(\s*req\s*,\s*supabaseUrl\s*,\s*anonKey\s*\)/);
      expect(code).toMatch(/const\s+anonKey\s*=\s*Deno\.env\.get\('SUPABASE_ANON_KEY'\)/);
    });

    it('writes no audit row of its own: the RPC writes it in the save', () => {
      expect(code).not.toMatch(/\brecordAudit(Now)?\(/);
      expect(code).not.toMatch(/'(team|game)\.saved'/);
    });

    it('answers a save rolled back for its audit row with the logged AUDIT_WRITE_FAILED 500', () => {
      const branch = code.match(
        /if\s*\(\s*isAuditWriteFailure\(\s*error\s*\)\s*\)\s*\{\s*return\s+await\s+auditWriteFailedResponse\(\s*logCtx\s*,\s*'([^']+)'\s*,\s*error\s*\)/
      );
      expect(branch?.[1]).toBe(handler.save);
      // ...inside the catch around the save, before the generic failure path.
      const catchAt = code.lastIndexOf('} catch (error) {');
      expect(catchAt).toBeGreaterThan(code.indexOf(`await ${handler.persistFn}(`));
      expect(code.indexOf('isAuditWriteFailure(error)')).toBeGreaterThan(catchAt);
      expect(code.indexOf('isAuditWriteFailure(error)')).toBeLessThan(
        code.indexOf("persistence failed', error)", catchAt)
      );
    });

    it('checks the caller is an organization admin before saving', () => {
      const adminAt = code.search(/await\s+verifyOrgAdmin\(\s*serviceClient\s*,\s*user\.id\s*,/);
      expect(adminAt).toBeGreaterThan(-1);
      expect(adminAt).toBeLessThan(code.indexOf(`await ${handler.persistFn}(`));
    });
  });
}

describe('positive controls: the matchers see the regressions they guard against', () => {
  it('a call site back on serviceClient', () => {
    const regressed =
      'const userClient = createUserClient(req, supabaseUrl, anonKey);\n' +
      'const result = await persistGameSnapshot(serviceClient, snap, meta, now);\n';
    const { clients, userClients } = persistCallSites(regressed, 'persistGameSnapshot');
    expect(clients).toEqual(['serviceClient']);
    expect(clients[0]).not.toBe(userClients[0]);
  });

  it('a handler without the admin check', () => {
    const regressed = 'const result = await persistGameSnapshot(userClient, snap, meta, now);\n';
    expect(regressed.search(/await\s+verifyOrgAdmin\(\s*serviceClient\s*,\s*user\.id\s*,/)).toBe(
      -1
    );
  });
});
