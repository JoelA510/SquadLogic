function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  return url.replace(/\/+$/, '');
}

export function deriveFromSupabaseEnv(env = process.env) {
  const baseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}/functions/v1` : undefined;
}

/**
 * Sets `VITE_SUPABASE_PERSISTENCE_URL` in `env` from the Supabase URL when it
 * is not set already. The build wrapper passes `process.env`, which its Vite
 * child inherits; nothing is written to disk (Vite reads `.env` files only
 * from the repository root, its `envDir`).
 */
export function configurePersistenceEndpoint(env = process.env) {
  if (env.VITE_SUPABASE_PERSISTENCE_URL) return env.VITE_SUPABASE_PERSISTENCE_URL;

  const derivedEndpoint = deriveFromSupabaseEnv(env);

  if (derivedEndpoint) {
    env.VITE_SUPABASE_PERSISTENCE_URL = derivedEndpoint;

    console.log(
      `[configurePersistenceEndpoint] Derived VITE_SUPABASE_PERSISTENCE_URL=${derivedEndpoint}`
    );
    return derivedEndpoint;
  }

  return undefined;
}
