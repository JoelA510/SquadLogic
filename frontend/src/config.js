/**
 * Frontend configuration. The environment itself is read and validated in
 * `env.js`, the only module that reads `import.meta.env` (plan item M2.2);
 * this module re-exports what the app reads and derives the endpoint URLs.
 */
import { API_BASE_URL } from './env.js';

export {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  API_BASE_URL,
  USE_MOCK_SUPABASE,
  IS_MOCK_MODE,
} from './env.js';

export const PRACTICE_PERSISTENCE_URL = `${API_BASE_URL}/practice-persistence`;
export const GAME_PERSISTENCE_URL = `${API_BASE_URL}/game-persistence`;
