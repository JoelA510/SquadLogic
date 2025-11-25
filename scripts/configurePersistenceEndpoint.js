import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  return url.replace(/\/+$/, '');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnvFilePath = path.join(repoRoot, '.env.local');

function upsertEnvValue(envFilePath, key, value) {
  let contents = '';

  if (fs.existsSync(envFilePath)) {
    contents = fs.readFileSync(envFilePath, 'utf8');
  }

  const lines = contents.split(/\r?\n/).filter((line) => line.length > 0);
  let updated = false;

  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!updated) {
    nextLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envFilePath, `${nextLines.join('\n')}${nextLines.length ? '\n' : ''}`);
}

export function deriveFromSupabaseEnv(env = process.env) {
  const baseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}/functions/v1` : undefined;
}

export function configurePersistenceEndpoint(
  env = process.env,
  { persistEnvFilePath = defaultEnvFilePath, persistDerivedValue = env === process.env } = {},
) {
  if (env.VITE_SUPABASE_PERSISTENCE_URL) return env.VITE_SUPABASE_PERSISTENCE_URL;

  const derivedEndpoint = deriveFromSupabaseEnv(env);

  if (derivedEndpoint) {
    env.VITE_SUPABASE_PERSISTENCE_URL = derivedEndpoint;

    if (persistDerivedValue) {
      upsertEnvValue(persistEnvFilePath, 'VITE_SUPABASE_PERSISTENCE_URL', derivedEndpoint);
    }

    console.log(
      `[configurePersistenceEndpoint] Derived VITE_SUPABASE_PERSISTENCE_URL=${derivedEndpoint}`,
    );
    return derivedEndpoint;
  }

  return undefined;
}
