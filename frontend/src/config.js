/**
 * Frontend configuration.
 */

export const API_BASE_URL = import.meta.env.VITE_SUPABASE_PERSISTENCE_URL
    ? import.meta.env.VITE_SUPABASE_PERSISTENCE_URL
    : 'http://localhost:54321/functions/v1';

export const PRACTICE_PERSISTENCE_URL = `${API_BASE_URL}/practice-persistence`;
export const GAME_PERSISTENCE_URL = `${API_BASE_URL}/game-persistence`;
