import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import {
  createClient,
  type SupabaseClient,
  type User,
} from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import { createTeamPersistenceHttpHandler } from '../../../src/teamPersistenceEdgeHandler.js';
import {
  DEFAULT_ALLOWED_ROLES,
  parseAllowedRolesEnv,
} from '../../../src/teamPersistenceEdgeConfig.js';

type HttpHandler = (request: Request) => Response | Promise<Response>;

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function getUserFromRequest(
  request: Request,
  supabaseClient: SupabaseClient,
): Promise<User | null> {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length)
    : null;

  if (!token) {
    return null;
  }

  const { data, error } = await supabaseClient.auth.getUser(token);

  if (error) {
    console.error(
      'Failed to retrieve user from access token',
      error.message ?? error,
    );
    return null;
  }

  return data?.user ?? null;
}

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedRoles = parseAllowedRolesEnv(
  Deno.env.get('TEAM_PERSISTENCE_ALLOWED_ROLES'),
  { fallbackRoles: DEFAULT_ALLOWED_ROLES },
);

let handler: HttpHandler;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for team persistence function.',
  );
  handler = () =>
    jsonResponse(
      {
        status: 'error',
        message: 'Supabase service configuration is missing.',
      },
      500,
    );
} else {
  const supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch },
    auth: { persistSession: false },
  });

  // The team persistence handler requires a `transaction` method on the client.
  // Supabase Edge client instances do not yet expose a transaction API, so this
  // shim provides a compatible interface. It does NOT provide atomicity.
  const transactionalClient = {
    async transaction<T>(
      callback: (tx: { from: typeof supabaseClient.from }) => Promise<T>,
    ): Promise<T> {
      const tx: { from: typeof supabaseClient.from } = {
        from(table) {
          return supabaseClient.from(table);
        },
      };
      return callback(tx);
    },
  };

  handler = createTeamPersistenceHttpHandler({
    supabaseClient: transactionalClient,
    allowedRoles,
    getUser: (request) => getUserFromRequest(request, supabaseClient),
  });
}

serve(handler);
