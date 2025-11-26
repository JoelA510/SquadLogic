import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  return url.replace(/\/+$/, '');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultEnvFilePath = path.join(repoRoot, 'frontend', '.env.local');

function upsertEnvValue(envFilePath, key, value) {
  if (!fs.existsSync(envFilePath)) {
    fs.writeFileSync(envFilePath, `${key}=${value}\n`);
    return;
  }

  let contents = fs.readFileSync(envFilePath, 'utf8');
  const keyPattern = new RegExp(`^${key}=.*`, 'm');
  const newLine = `${key}=${value}`;

  if (keyPattern.test(contents)) {
    contents = contents.replace(keyPattern, () => newLine);
  } else {
    if (contents.length > 0 && !contents.endsWith('\n')) {
      contents += '\n';
    }
    contents += `${newLine}\n`;
  }

  fs.writeFileSync(envFilePath, contents);
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
