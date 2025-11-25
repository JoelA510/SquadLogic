function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  return url.replace(/\/+$/, '');
}

export function deriveFromSupabaseEnv(env = process.env) {
  const baseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}/functions/v1` : undefined;
}

export function configurePersistenceEndpoint(env = process.env) {
  if (env.VITE_SUPABASE_PERSISTENCE_URL) return env.VITE_SUPABASE_PERSISTENCE_URL;

  const derivedEndpoint = deriveFromSupabaseEnv(env);

  if (derivedEndpoint) {
    process.env.VITE_SUPABASE_PERSISTENCE_URL = derivedEndpoint;
    console.log(
      `[configurePersistenceEndpoint] Derived VITE_SUPABASE_PERSISTENCE_URL=${derivedEndpoint}`,
    );
  }
}
