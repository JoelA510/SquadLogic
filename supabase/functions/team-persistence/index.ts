import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import { createTeamPersistenceHttpHandler } from '../../../src/teamPersistenceEdgeHandler.js';
import { DEFAULT_ALLOWED_ROLES, parseAllowedRolesEnv } from '../../../src/teamPersistenceEdgeConfig.js';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedRolesEnv = Deno.env.get('TEAM_PERSISTENCE_ALLOWED_ROLES');

const allowedRoles = parseAllowedRolesEnv(allowedRolesEnv, { fallbackRoles: DEFAULT_ALLOWED_ROLES });

function respondWithConfigError(message) {
  return new Response(JSON.stringify({ status: 'error', message }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for team persistence function.');
  serve(() => respondWithConfigError('Supabase service configuration is missing.'));
} else {
  const supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function getUserFromAuthHeader(request) {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice('bearer '.length)
      : null;

    if (!token) {
      return null;
    }

    const { data, error } = await supabaseClient.auth.getUser(token);
    if (error) {
      console.error('Failed to fetch user for team persistence:', error.message || error);
      return null;
    }

    return data?.user ?? null;
  }

  const handler = createTeamPersistenceHttpHandler({
    supabaseClient,
    allowedRoles,
    getUser: getUserFromAuthHeader,
  });

  serve(handler);
}
