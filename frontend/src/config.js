/**
 * Frontend configuration.
 * Centralizes environment variable access for both Vite (browser) and Node (test) environments.
 */

function getEnvVar(key) {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env[key]) {
        return import.meta.env[key];
    }
    if (typeof process !== 'undefined' && process.env && process.env[key]) {
        return process.env[key];
    }
    return undefined;
}

export const SUPABASE_URL = getEnvVar('VITE_SUPABASE_URL') || getEnvVar('SUPABASE_URL');
export const SUPABASE_ANON_KEY = getEnvVar('VITE_SUPABASE_ANON_KEY') || getEnvVar('SUPABASE_ANON_KEY');

export const API_BASE_URL = getEnvVar('VITE_SUPABASE_PERSISTENCE_URL') || 'http://localhost:54321/functions/v1';

export const PRACTICE_PERSISTENCE_URL = `${API_BASE_URL}/practice-persistence`;
export const GAME_PERSISTENCE_URL = `${API_BASE_URL}/game-persistence`;

export const IS_MOCK_MODE = !SUPABASE_URL || !SUPABASE_ANON_KEY;
