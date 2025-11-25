function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function deriveFromSupabaseEnv(env = process.env) {
  const baseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized ? `${normalized}/functions/v1` : undefined;
}

if (!process.env.VITE_SUPABASE_PERSISTENCE_URL) {
  const derivedEndpoint = deriveFromSupabaseEnv();

  if (derivedEndpoint) {
    process.env.VITE_SUPABASE_PERSISTENCE_URL = derivedEndpoint;
    console.log(
      `[configurePersistenceEndpoint] Derived VITE_SUPABASE_PERSISTENCE_URL=${derivedEndpoint}`,
    );
  }
}
