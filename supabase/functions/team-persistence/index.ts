import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
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

const PersistencePayloadSchema = z.object({
  snapshot: z.object({
    payload: z.object({
      teamRows: z.array(z.object({ id: z.string() }).passthrough()),
      teamPlayerRows: z.array(z.object({ team_id: z.string(), player_id: z.string() }).passthrough()),
    }),
  }),
  overrides: z.array(z.unknown()).optional(),
});

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



  const innerHandler = createTeamPersistenceHttpHandler({
    supabaseClient,
    allowedRoles,
    getUser: (request) => getUserFromRequest(request, supabaseClient),
  });

  handler = async (req: Request) => {
    if (req.method === 'POST') {
      try {
        const clone = req.clone();
        const body = await clone.json();
        const parsed = PersistencePayloadSchema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse({ status: 'error', message: 'Invalid payload', issues: parsed.error.issues }, 400);
        }
      } catch {
        return jsonResponse({ status: 'error', message: 'Invalid JSON' }, 400);
      }
    }
    return innerHandler(req);
  };
}

serve(handler);
