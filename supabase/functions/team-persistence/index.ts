import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createTeamPersistenceHttpHandler } from '../../../src/teamPersistenceEdgeHandler.js';
import {
  DEFAULT_ALLOWED_ROLES,
  parseAllowedRolesEnv,
} from '../../../src/teamPersistenceEdgeConfig.js';

function jsonResponse(payload: unknown, status: number = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createSupabaseServiceRoleClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch },
    auth: { persistSession: false },
  });
}

function shimSupabaseTransaction(client) {
  return {
    ...client,
    transaction: async (callback) => callback(client),
  };
}

async function getUserFromRequest(request: Request, supabaseClient: SupabaseClient): Promise<User | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const accessToken = authHeader.slice('bearer '.length);
  const { data, error } = await supabaseClient.auth.getUser(accessToken);

  if (error) {
    console.error('Failed to retrieve user from access token', error);
    return null;
  }

  return data?.user ?? null;
}
let handler;

try {
  const supabaseClient = shimSupabaseTransaction(createSupabaseServiceRoleClient());
  const allowedRoles = parseAllowedRolesEnv(
    Deno.env.get('TEAM_PERSISTENCE_ALLOWED_ROLES'),
    { fallbackRoles: DEFAULT_ALLOWED_ROLES },
  );

  handler = createTeamPersistenceHttpHandler({
    supabaseClient,
    allowedRoles,
    getUser: (request) => getUserFromRequest(request, supabaseClient),
  });
} catch (error) {
  console.error('Failed to initialize team-persistence function', error);
}

serve((request) => {
  if (!handler) {
    return jsonResponse(
      { status: 'error', message: 'Team persistence function is not configured.' },
      500,
    );
  }

  return handler(request);
});
