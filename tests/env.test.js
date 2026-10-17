// @vitest-environment node
/**
 * The frontend's environment (plan item M2.2, audit findings 2.2 and 8.4).
 *
 * `frontend/src/envRules.js` holds the rules; `frontend/src/env.js` is the
 * only module that reads `import.meta.env`, each variable by name, and runs
 * them in the browser; `vite.config.js` runs the same rules when a production
 * build starts, so a build the app would refuse fails before it is written.
 * Before M2.2 `config.js` read `import.meta.env[key]` dynamically (Vite then
 * inlines every `VITE_` variable), validated nothing, and a production build
 * without Supabase variables succeeded and showed a Configuration Error at run
 * time, before Sentry started.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ENV_NAMES,
  LOCAL_FUNCTIONS_URL,
  formatEnvProblems,
  validateClientEnv,
} from '../frontend/src/envRules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'frontend/src');
// Bundled into the frontend too (`@squadlogic/core`), so held to the same rule.
const CORE = path.join(ROOT, 'packages/core/src');
const ENV_MODULE = path.join(SRC, 'env.js');

const URL_OK = 'https://project-ref.supabase.co';
const DSN_OK = 'https://0123abcd@o12345.ingest.us.sentry.io/67890';

/** A JWT-shaped key with this payload (unsigned; only the shape matters here). */
function jwtWith(/** @type {object} */ payload) {
  const part = (/** @type {object} */ value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}
const ANON_JWT = jwtWith({ iss: 'supabase', ref: 'project-ref', role: 'anon' });
const SERVICE_ROLE_JWT = jwtWith({ iss: 'supabase', ref: 'project-ref', role: 'service_role' });

const PROD_OK = { VITE_SUPABASE_URL: URL_OK, VITE_SUPABASE_ANON_KEY: 'sb_publishable_abc123' };

/** The names of the variables a result's problems blame. */
const blamed = (/** @type {{ problems: { name: string }[] }} */ result) =>
  result.problems.map((problem) => problem.name);

describe('envRules: required in a production build', () => {
  it('both Supabase variables missing: one problem for each, by name', () => {
    const result = validateClientEnv({}, { production: true });
    expect(result.problems.map((p) => [p.name, p.kind])).toEqual([
      ['VITE_SUPABASE_URL', 'missing'],
      ['VITE_SUPABASE_ANON_KEY', 'missing'],
    ]);
  });

  it.each([
    ['VITE_SUPABASE_URL', { VITE_SUPABASE_ANON_KEY: 'sb_publishable_abc123' }],
    ['VITE_SUPABASE_ANON_KEY', { VITE_SUPABASE_URL: URL_OK }],
  ])('only %s missing: that one is named', (name, raw) => {
    expect(blamed(validateClientEnv(raw, { production: true }))).toEqual([name]);
  });

  it('an empty or blank value counts as missing (Vite inlines `VAR=` as "")', () => {
    const result = validateClientEnv(
      { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '   ' },
      { production: true }
    );
    expect(result.problems.map((p) => p.kind)).toEqual(['missing', 'missing']);
  });

  it('both present: no problems, the real client', () => {
    const result = validateClientEnv(PROD_OK, { production: true });
    expect(result.problems).toEqual([]);
    expect(result.env).toMatchObject({ supabaseUrl: URL_OK, isMockMode: false });
  });

  it('the opt-in VITE_USE_MOCK_SUPABASE=true builds the mock without them', () => {
    const result = validateClientEnv({ VITE_USE_MOCK_SUPABASE: 'true' }, { production: true });
    expect(result.problems).toEqual([]);
    expect(result.env).toMatchObject({ useMockSupabase: true, isMockMode: true });
  });

  it('VITE_USE_MOCK_SUPABASE=false is not the opt-in', () => {
    const result = validateClientEnv({ VITE_USE_MOCK_SUPABASE: 'false' }, { production: true });
    expect(blamed(result)).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']);
  });

  it('the dev server without them falls back to the mock, with no problems', () => {
    const result = validateClientEnv({}, { production: false });
    expect(result.problems).toEqual([]);
    expect(result.env.isMockMode).toBe(true);
  });
});

describe('envRules: malformed values are refused, in any build', () => {
  it.each([
    ['VITE_SUPABASE_URL', 'your_supabase_project_url'],
    ['VITE_SUPABASE_URL', 'ftp://project-ref.supabase.co'],
    ['VITE_SUPABASE_ANON_KEY', 'sb_secret_abc123'],
    ['VITE_SUPABASE_ANON_KEY', SERVICE_ROLE_JWT],
    ['VITE_USE_MOCK_SUPABASE', '1'],
    ['VITE_USE_MOCK_SUPABASE', 'yes'],
    ['VITE_SUPABASE_PERSISTENCE_URL', 'localhost:54321/functions/v1'],
    ['VITE_SENTRY_DSN', 'not-a-dsn'],
    ['VITE_SENTRY_DSN', 'https://o12345.ingest.us.sentry.io/67890'],
    ['VITE_SENTRY_DSN', 'https://0123abcd@o12345.ingest.us.sentry.io/'],
  ])('%s = %s', (name, value) => {
    for (const production of [true, false]) {
      const result = validateClientEnv({ ...PROD_OK, [name]: value }, { production });
      expect(result.problems.map((p) => [p.name, p.kind])).toEqual([[name, 'invalid']]);
    }
  });

  it('every problem is reported, not only the first', () => {
    const result = validateClientEnv(
      { VITE_SUPABASE_URL: 'nope', VITE_SENTRY_DSN: 'nope', VITE_USE_MOCK_SUPABASE: 'nope' },
      { production: true }
    );
    expect(blamed(result).sort()).toEqual(
      [
        'VITE_SENTRY_DSN',
        'VITE_SUPABASE_ANON_KEY',
        'VITE_SUPABASE_URL',
        'VITE_USE_MOCK_SUPABASE',
      ].sort()
    );
  });

  it('the message names the variable and never prints its value', () => {
    const secret = 'sb_secret_do-not-print-me';
    const { problems } = validateClientEnv(
      { ...PROD_OK, VITE_SUPABASE_ANON_KEY: secret },
      { production: true }
    );
    const message = formatEnvProblems(problems);
    expect(message).toContain('VITE_SUPABASE_ANON_KEY');
    expect(message).not.toContain(secret);
  });
});

describe('envRules: accepted values', () => {
  it('an anon JWT and a publishable key are both accepted as the anon key', () => {
    for (const key of [ANON_JWT, 'sb_publishable_abc123']) {
      const result = validateClientEnv(
        { ...PROD_OK, VITE_SUPABASE_ANON_KEY: key },
        { production: true }
      );
      expect(result.problems).toEqual([]);
      expect(result.env.supabaseAnonKey).toBe(key);
    }
  });

  it('Sentry: unset is off; a well-formed DSN is kept', () => {
    expect(validateClientEnv(PROD_OK, { production: true }).env.sentryDsn).toBeUndefined();
    expect(
      validateClientEnv({ ...PROD_OK, VITE_SENTRY_DSN: '' }, { production: true }).env.sentryDsn
    ).toBeUndefined();
    const result = validateClientEnv({ ...PROD_OK, VITE_SENTRY_DSN: DSN_OK }, { production: true });
    expect(result.problems).toEqual([]);
    expect(result.env.sentryDsn).toBe(DSN_OK);
  });

  it('the persistence base: explicit, else the project in a production build, else the local stack', () => {
    const explicit = validateClientEnv(
      { ...PROD_OK, VITE_SUPABASE_PERSISTENCE_URL: 'https://edge.example.org/functions/v1/' },
      { production: true }
    );
    expect(explicit.env.apiBaseUrl).toBe('https://edge.example.org/functions/v1');
    const derived = validateClientEnv(
      { ...PROD_OK, VITE_SUPABASE_URL: `${URL_OK}/` },
      { production: true }
    );
    expect(derived.env.apiBaseUrl).toBe(`${URL_OK}/functions/v1`);
    expect(validateClientEnv({}, { production: false }).env.apiBaseUrl).toBe(LOCAL_FUNCTIONS_URL);
  });

  it('a mock session or the dev server never derives the real project for persistence', () => {
    // Mock mode with a real URL present (.env.local.example sets the opt-in):
    // persistence must not post mock data to the real project's Functions.
    for (const production of [true, false]) {
      const mock = validateClientEnv(
        { ...PROD_OK, VITE_USE_MOCK_SUPABASE: 'true' },
        { production }
      );
      expect(mock.env.isMockMode).toBe(true);
      expect(mock.env.apiBaseUrl).toBe(LOCAL_FUNCTIONS_URL);
    }
    const dev = validateClientEnv(PROD_OK, { production: false });
    expect(dev.env.isMockMode).toBe(false);
    expect(dev.env.apiBaseUrl).toBe(LOCAL_FUNCTIONS_URL);
  });
});

/**
 * Loads env.js as a build with these values would evaluate it. Every
 * variable the rules read is stubbed ('' unless named), so the shell running
 * the tests cannot leak a real value into a case.
 * @param {{ prod: boolean, vars?: Record<string, string> }} options
 */
async function loadEnvModule({ prod, vars = {} }) {
  vi.resetModules();
  vi.stubEnv('PROD', prod);
  vi.stubEnv('DEV', !prod);
  for (const name of CLIENT_ENV_NAMES) vi.stubEnv(name, vars[name] ?? '');
  return import('../frontend/src/env.js');
}

describe('env.js: what the app sees', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a production bundle with a malformed value stops, naming the variable', async () => {
    await expect(
      loadEnvModule({ prod: true, vars: { ...PROD_OK, VITE_SENTRY_DSN: 'not-a-dsn' } })
    ).rejects.toThrow(/VITE_SENTRY_DSN must be a Sentry DSN/);
  });

  it('the dev server ignores a malformed value, as if unset, and warns naming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The old .env.example's placeholder: before M2.2 this ran the mock.
      const env = await loadEnvModule({
        prod: false,
        vars: { VITE_SUPABASE_URL: 'your_supabase_project_url', VITE_SENTRY_DSN: 'not-a-dsn' },
      });
      expect(env.IS_MOCK_MODE).toBe(true);
      expect(env.SUPABASE_URL).toBeUndefined();
      expect(env.SENTRY_DSN).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/VITE_SUPABASE_URL must be an http\(s\) URL/);
      expect(String(warn.mock.calls[0][0])).toMatch(/VITE_SENTRY_DSN must be a Sentry DSN/);
    } finally {
      warn.mockRestore();
    }
  });

  it('Sentry is off when the DSN is unset, and on with a well-formed one', async () => {
    expect((await loadEnvModule({ prod: true, vars: PROD_OK })).SENTRY_DSN).toBeUndefined();
    const on = await loadEnvModule({ prod: true, vars: { ...PROD_OK, VITE_SENTRY_DSN: DSN_OK } });
    expect(on.SENTRY_DSN).toBe(DSN_OK);
  });

  it('a production bundle without Supabase variables still refuses (M1.7, second line)', async () => {
    await expect(loadEnvModule({ prod: true })).rejects.toThrow(
      /production build has no Supabase configuration/
    );
  });

  it('config.js re-exports the validated values', async () => {
    await loadEnvModule({ prod: true, vars: PROD_OK });
    const config = await import('../frontend/src/config.js');
    expect(config).toMatchObject({
      SUPABASE_URL: URL_OK,
      IS_MOCK_MODE: false,
      API_BASE_URL: `${URL_OK}/functions/v1`,
      PRACTICE_PERSISTENCE_URL: `${URL_OK}/functions/v1/practice-persistence`,
      GAME_PERSISTENCE_URL: `${URL_OK}/functions/v1/game-persistence`,
    });
  });
});

describe('the build: vite.config.js runs the rules when a production build starts', () => {
  // An env directory with no .env files in it.
  const EMPTY_ENV_DIR = mkdtempSync(path.join(tmpdir(), 'squadlogic-env-'));
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Resolves the real vite.config.js as `vite build` does (or `vite`, with
   * 'serve'), with these variables as the only ones the rules read in the
   * process and an env directory with no .env files, so a developer's own
   * .env cannot decide a case. `vite build` runs with NODE_ENV=production
   * (Vite sets it when unset); Vitest sets it to 'test', so it is stubbed.
   * @param {'build' | 'serve'} command
   * @param {Record<string, string>} vars
   */
  async function resolveFor(command, vars) {
    vi.stubEnv('NODE_ENV', 'production');
    for (const name of CLIENT_ENV_NAMES) vi.stubEnv(name, vars[name]);
    return resolveConfig(
      { configFile: path.join(ROOT, 'vite.config.js'), envDir: EMPTY_ENV_DIR, logLevel: 'silent' },
      command,
      'production'
    );
  }

  it('a production build without the Supabase variables fails, naming both', async () => {
    const failure = await resolveFor('build', {}).then(
      () => null,
      (error) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/VITE_SUPABASE_URL is required in a production build/);
    expect(failure.message).toMatch(/VITE_SUPABASE_ANON_KEY is required in a production build/);
  });

  it('a production build with a malformed DSN fails, naming it', async () => {
    await expect(resolveFor('build', { ...PROD_OK, VITE_SENTRY_DSN: 'nope' })).rejects.toThrow(
      /VITE_SENTRY_DSN must be a Sentry DSN/
    );
  });

  it('builds with the variables, or with the opt-in; the dev server is not checked', async () => {
    // Meta: the variables reach the resolved env, so the passing case really
    // validated them rather than passing over an empty env.
    const resolved = await resolveFor('build', PROD_OK);
    expect(resolved.env.VITE_SUPABASE_URL).toBe(URL_OK);
    expect(resolved.isProduction).toBe(true);
    await expect(resolveFor('build', { VITE_USE_MOCK_SUPABASE: 'true' })).resolves.toBeTruthy();
    await expect(resolveFor('serve', {})).resolves.toBeTruthy();
  });
});

/** Every .js/.jsx file under frontend/src, from the filesystem. */
function listSources(/** @type {string} */ dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return /\.(js|jsx)$/.test(name) ? [full] : [];
  });
}

/**
 * Each `import.meta.env` in the code (not comments or strings), with the
 * property read from it, or null when the object is used as a whole.
 * @param {string} code
 */
function envReads(code) {
  const source = ts.createSourceFile(
    's.jsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX
  );
  /** @type {(string | null)[]} */
  const reads = [];
  const visit = (/** @type {ts.Node} */ node) => {
    // Every `import.meta` in the code. `import.meta.url` and the like are not
    // env reads; `import.meta.env.NAME` is a named read; anything else that
    // reaches `env` (`import.meta.env` whole, `import.meta['env']`,
    // `const { env } = import.meta`, `import.meta` passed along) counts as a
    // whole-object read, which Vite fills with every VITE_ variable.
    if (ts.isMetaProperty(node) && node.name.text === 'meta') {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (parent.name.text === 'env') {
          const grand = parent.parent;
          reads.push(
            ts.isPropertyAccessExpression(grand) && grand.expression === parent
              ? grand.name.text
              : null
          );
        }
      } else {
        reads.push(null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

/**
 * How many times the code reaches `process.env` (`process.env.X`,
 * `process['env']`, `process.env` whole), outside comments and strings.
 * @param {string} code
 */
function processEnvReads(code) {
  const source = ts.createSourceFile(
    's.jsx',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX
  );
  let reads = 0;
  const visit = (/** @type {ts.Node} */ node) => {
    const isProcess = (/** @type {ts.Node} */ n) => ts.isIdentifier(n) && n.text === 'process';
    if (ts.isPropertyAccessExpression(node) && isProcess(node.expression)) {
      if (node.name.text === 'env') reads += 1;
    } else if (
      ts.isElementAccessExpression(node) &&
      isProcess(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'env'
    ) {
      reads += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return reads;
}

describe('env.js is the only reader of import.meta.env, by name', () => {
  it('the detector sees named reads, whole-object reads, and skips comments', () => {
    expect(envReads('const a = import.meta.env.VITE_X;')).toEqual(['VITE_X']);
    expect(envReads('const e = import.meta.env; f(import.meta.env[k]);')).toEqual([null, null]);
    expect(envReads("const v = import.meta['env'].VITE_X;")).toEqual([null]);
    expect(envReads('const { env } = import.meta; f(env[k]);')).toEqual([null]);
    expect(envReads('const u = new URL("./a.svg", import.meta.url);')).toEqual([]);
    expect(envReads('// import.meta.env.VITE_X\nconst s = "import.meta.env";')).toEqual([]);
  });

  it('no other frontend or core module reads import.meta.env', () => {
    // A whole-object read anywhere in the bundle makes Vite inline every VITE_
    // variable there: on `main` (config.js's `import.meta.env[key]`) the
    // production bundle carried all of Vercel's VITE_VERCEL_* system variables,
    // the last commit's message and author among them.
    const frontend = listSources(SRC);
    const core = listSources(CORE);
    // Meta: both walks found their trees, and env.js itself is found reading.
    expect(frontend.length).toBeGreaterThan(100);
    expect(core.length).toBeGreaterThan(100);
    const files = [...frontend, ...core];
    expect(envReads(readFileSync(ENV_MODULE, 'utf8')).length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) => file !== ENV_MODULE)
      .filter((file) => envReads(readFileSync(file, 'utf8')).length > 0)
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  }, 25_000); // parses ~900 sources: 1.1 s alone; under coverage (CI, M3.1) 4.1 / 4.5 s alone, 4.3 / 5.4 s in two full runs; ~4x the worst, see docs/testing/test-timeouts.md.

  it('env.js reads every variable the rules validate, each by name, and nothing whole', () => {
    const reads = envReads(readFileSync(ENV_MODULE, 'utf8'));
    expect(reads).not.toContain(null);
    for (const name of CLIENT_ENV_NAMES) expect(reads).toContain(name);
    // Every VITE_ name it reads is validated, or is one of vite.config.js's two defines.
    const unvalidated = reads.filter(
      (name) =>
        name?.startsWith('VITE_') &&
        !CLIENT_ENV_NAMES.includes(/** @type {any} */ (name)) &&
        name !== 'VITE_APP_VERSION' &&
        name !== 'VITE_VERCEL_ENV'
    );
    expect(unvalidated).toEqual([]);
  });

  it('no frontend or core module reads process.env', () => {
    // Rule 3 (AGENTS.md): a frontend module asks env.js, never process.env.
    // `FeatureGuard.jsx` and `featureFlags.js` read `process.env.NODE_ENV`
    // (Vite's compatibility replacement) until plan M6; they now read env.js's
    // IS_DEVELOPMENT_MODE.
    const files = [...listSources(SRC), ...listSources(CORE)];
    expect(files.length).toBeGreaterThan(200);
    const offenders = files
      .filter((file) => processEnvReads(readFileSync(file, 'utf8')) > 0)
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  }, 25_000); // parses the same ~900 sources as the import.meta.env scan above.

  it('the process.env detector sees reads and skips comments and strings', () => {
    expect(processEnvReads("if (process.env.NODE_ENV === 'development') f();")).toBe(1);
    expect(processEnvReads("const { NODE_ENV } = process.env; g(process['env']);")).toBe(2);
    expect(processEnvReads('// process.env.NODE_ENV\nconst s = "process.env";')).toBe(0);
    expect(processEnvReads('const env = { process: 1 }; env.process;')).toBe(0);
  });

  it('.env.example documents every variable the rules read', () => {
    const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const name of CLIENT_ENV_NAMES) expect(example).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
  });
});
