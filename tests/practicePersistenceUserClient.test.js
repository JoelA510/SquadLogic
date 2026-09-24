import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #64 witness, pinned at the SOURCE because no harness loads the Edge Function:
// vitest never imports it (Deno URL imports), the E2E suite replaces it with
// `page.route`, and no Deno test covers it. `persist_practice_schedule` now
// DELETES a season's superseded practices and exempts `service_role` from its
// admin check, so the save must reach it through a client that acts as the
// caller. If it goes back to `serviceClient`, the database's admin check, the
// RLS write policy and the audit rows all silently leave the live path.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN = path.join(REPO_ROOT, 'supabase/functions/practice-persistence/index.ts');
const AUTH = path.join(REPO_ROOT, 'supabase/functions/_shared/auth.ts');

/** Strip comments so a commented-out call cannot satisfy or defeat a match. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The client each `persistPracticeSnapshot(...)` call site passes, and the
 * name of the variable bound to `createUserClient(req, ...)`.
 */
function persistCallSites(code) {
  const clients = [...code.matchAll(/await\s+persistPracticeSnapshot\(\s*(\w+)\s*,/g)].map(
    (m) => m[1]
  );
  const userClients = [...code.matchAll(/const\s+(\w+)\s*=\s*createUserClient\(\s*req\s*,/g)].map(
    (m) => m[1]
  );
  return { clients, userClients };
}

describe('practice-persistence reaches the RPC as the caller (#64)', () => {
  const code = codeOf(readFileSync(FN, 'utf8'));

  it('the only RPC call is inside persistPracticeSnapshot, on the client it is handed', () => {
    const rpcCalls = [...code.matchAll(/(\w+)\.rpc\(\s*'persist_practice_schedule'/g)];
    expect(rpcCalls.map((m) => m[1])).toEqual(['supabaseClient']);
    expect(code).toMatch(
      /async function persistPracticeSnapshot\(\s*supabaseClient: SupabaseClient/
    );
  });

  it('the handler hands it the user client, never the service-role one', () => {
    const { clients, userClients } = persistCallSites(code);
    // Meta-assertion: a call site the regex no longer finds must fail, not pass.
    expect(clients).toHaveLength(1);
    expect(userClients).toHaveLength(1);
    expect(clients[0]).toBe(userClients[0]);
    expect(clients[0]).not.toBe('serviceClient');
    // ...and built from the anon key: the service-role key under the user
    // client's name would bypass exactly what the rename was for.
    expect(code).toMatch(/createUserClient\(\s*req\s*,\s*supabaseUrl\s*,\s*anonKey\s*\)/);
    expect(code).toMatch(/const\s+anonKey\s*=\s*Deno\.env\.get\('SUPABASE_ANON_KEY'\)/);
  });

  it("the user client is the anon key plus the caller's Authorization header", () => {
    const auth = codeOf(readFileSync(AUTH, 'utf8'));
    const body = auth.slice(auth.indexOf('export function createUserClient'));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/_createClient\(\s*supabaseUrl\s*,\s*anonKey/);
    expect(body).toMatch(/Authorization:\s*request\.headers\.get\('Authorization'\)/);
    expect(code).toMatch(/Deno\.env\.get\('SUPABASE_ANON_KEY'\)/);
  });

  it('positive control: the matcher sees a call site that regressed to serviceClient', () => {
    const regressed =
      'const userClient = createUserClient(req, supabaseUrl, anonKey);\n' +
      'const result = await persistPracticeSnapshot(serviceClient, snap, meta, now);\n';
    const { clients, userClients } = persistCallSites(regressed);
    expect(clients).toEqual(['serviceClient']);
    expect(clients[0]).not.toBe(userClients[0]);
  });
});
