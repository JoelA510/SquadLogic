/**
 * `scripts/dbharness/anchor_liveness.py` is the function arm of prove.sh's
 * superseded-statement pre-flight. Its first version matched only
 * `CREATE OR REPLACE FUNCTION`, by name, and knew nothing of DROP -- so five
 * plants aimed at `field_bookings(uuid, uuid, date)`, which 20260911000000
 * drops and replaces with a plain `CREATE FUNCTION` of a new signature, passed
 * it. These cases pin each way a later migration can make an anchor dead, and
 * the overload case that must NOT be called dead.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const JUDGE = path.resolve(__dirname, '../scripts/dbharness/anchor_liveness.py');
const ANCHOR = '    RETURN p_after + 1;';
const BODY = (sig) => `CREATE OR REPLACE FUNCTION public.producer(${sig})
RETURNS date
LANGUAGE plpgsql
AS $$
BEGIN
${ANCHOR}
END;
$$;
`;

let dir;
function tree(files) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-'));
  const mig = path.join(dir, 'supabase', 'migrations');
  fs.mkdirSync(mig, { recursive: true });
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(mig, name), sql);
  return path.join(mig, Object.keys(files)[0]);
}
const judge = (target, anchor = ANCHOR) =>
  execFileSync('python3', [JUDGE, target, anchor], { encoding: 'utf8' }).trim();

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('anchor_liveness.judge', () => {
  it('calls an anchor LIVE when no later migration touches its function', () => {
    const t = tree({ '001_a.sql': BODY('p_org uuid, p_after date DEFAULT NULL') });
    expect(judge(t)).toBe('LIVE public.producer(uuid, date)');
  });

  it('calls it SUPERSEDED when a later migration DROPs that exact signature', () => {
    const t = tree({
      '001_a.sql': BODY('p_org uuid, p_after date'),
      '002_b.sql': 'DROP FUNCTION IF EXISTS public.producer(uuid, date);\n',
    });
    expect(judge(t)).toBe('SUPERSEDED public.producer(uuid, date) by 002_b.sql (DROP FUNCTION)');
  });

  it('sees a plain CREATE FUNCTION of the same signature, not only OR REPLACE', () => {
    const t = tree({
      '001_a.sql': BODY('p_org uuid, p_after date'),
      '002_b.sql': BODY('org_id uuid, after_day date').replace(' OR REPLACE', ''),
    });
    expect(judge(t)).toMatch(/^SUPERSEDED public\.producer\(uuid, date\) by 002_b\.sql/);
  });

  it('does not call a different overload a supersession', () => {
    const t = tree({
      '001_a.sql': BODY('p_org uuid, p_after date'),
      '002_b.sql': BODY("p_org uuid, p_after date, p_scope text DEFAULT 'field'"),
    });
    expect(judge(t)).toBe('LIVE public.producer(uuid, date)');
  });

  it('ignores a DROP that only appears in a comment', () => {
    const t = tree({
      '001_a.sql': BODY('p_org uuid, p_after date'),
      '002_b.sql': '-- DROP FUNCTION public.producer(uuid, date);\nSELECT 1;\n',
    });
    expect(judge(t)).toBe('LIVE public.producer(uuid, date)');
  });

  it('reports NA for an anchor outside every function body', () => {
    const t = tree({ '001_a.sql': "COMMENT ON TABLE public.t IS 'x';\n" + BODY('p uuid') });
    expect(judge(t, "COMMENT ON TABLE public.t IS 'x';")).toMatch(/^NA /);
  });
});
