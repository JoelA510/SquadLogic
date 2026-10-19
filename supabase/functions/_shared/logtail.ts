/**
 * BetterStack (Logtail) logger for Supabase Edge Functions — Phase 9
 *
 * Streams structured JSON logs to BetterStack's Logtail ingestion endpoint.
 * Gated behind the BETTERSTACK_SOURCE_TOKEN env var; when absent, logs are
 * console-only (no-op for the HTTP transport).
 *
 * Usage in Edge Functions:
 *   import { edgeLogger } from '../_shared/logtail.ts';
 *   edgeLogger.info('Scheduler started', { teamCount: 12 });
 *   edgeLogger.error('RPC failed', { error: err.message });
 *   await edgeLogger.flush();  // call before returning the Response
 */

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  dt: string;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  function_name: string;
}

const LOGTAIL_URL = 'https://in.logs.betterstack.com';

/** How long `flush` waits for BetterStack before dropping the batch. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * An environment variable, or '' where the process may not read the
 * environment. The Edge runtime always may; a `deno test` run without
 * `--allow-env` may not, and since `_shared/auth.ts` reports audit failures
 * through this module, every test that imports `auth.ts` loads it. Without the
 * permission there is no token, so nothing is sent to BetterStack -- the safe
 * reading. Only the permission refusal is caught; anything else is rethrown.
 */
function envOrEmpty(name: string): string {
  try {
    return Deno.env.get(name) ?? '';
  } catch (error) {
    const refused = [Deno.errors.NotCapable, Deno.errors.PermissionDenied].some(
      (kind) => typeof kind === 'function' && error instanceof kind
    );
    if (refused) return '';
    throw error;
  }
}

const SOURCE_TOKEN = envOrEmpty('BETTERSTACK_SOURCE_TOKEN');
const FUNCTION_NAME = envOrEmpty('FUNCTION_NAME') || 'unknown';

/** Buffered log entries waiting to be flushed. */
const buffer: LogEntry[] = [];

function log(
  level: LogLevel,
  message: string,
  context: Record<string, unknown> = {},
  functionName: string = FUNCTION_NAME
) {
  const entry: LogEntry = {
    dt: new Date().toISOString(),
    level,
    message,
    context,
    function_name: functionName,
  };

  // Always emit to console (visible in Supabase Dashboard logs)
  const consoleFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${level.toUpperCase()}] ${message}`, context);

  // Buffer for batch flush to BetterStack
  if (SOURCE_TOKEN) {
    buffer.push(entry);
  }
}

/**
 * Flush all buffered log entries to BetterStack.
 * Call this before returning the HTTP response from the Edge Function.
 * Returns silently on failure — logging should never break the function.
 * Waits at most `timeoutMs` (default 2 s) for BetterStack.
 */
async function flush(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  if (!SOURCE_TOKEN || buffer.length === 0) return;

  const entries = buffer.splice(0, buffer.length);

  try {
    await fetch(LOGTAIL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SOURCE_TOKEN}`,
      },
      body: JSON.stringify(entries),
      // Callers await this before returning a response, so a slow BetterStack
      // must not hold the caller's answer: past the bound the batch is dropped.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Swallow — logging must never crash the function (a timeout lands here too)
    console.warn('[logtail] Failed to flush logs to BetterStack');
  }
}

export const edgeLogger = {
  info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
  flush,
};

// ---------------------------------------------------------------------------
// Top-level failure logging (M1.5)
//
// Supabase does not set FUNCTION_NAME, so every entry above used to read
// `function_name: "unknown"`, and a failure carried neither the organization
// it happened in nor anything to tell two concurrent failures apart. Each
// function now wraps its handler in `withFailureLogging`, which gives the
// request an ID and logs any error that escapes the handler -- then rethrows
// it, so the response `serve` builds for an uncaught error is unchanged. A
// handler that catches its own failure and answers 500 calls `logFailure`
// with the same context, so both paths carry the same three fields.
// ---------------------------------------------------------------------------

/** What a failure entry says about the request, beyond the error itself. */
export interface FailureContext {
  /** The function's directory name under `supabase/functions/`. */
  readonly functionName: string;
  /** Generated per request; not read from the request, so a caller cannot set it. */
  readonly requestId: string;
  /** Set by the handler as soon as it knows which organization the request is for. */
  organizationId?: string;
}

/** A request handler that is handed its failure context. */
export type FailureLoggedHandler = (
  req: Request,
  ctx: FailureContext
) => Response | Promise<Response>;

/**
 * Strip the values an error message can quote. Postgres quotes the offending
 * value (`invalid input syntax for type date: "<value>"`), RAISE EXCEPTION
 * messages can interpolate one, and either can be a person's name or email
 * from an imported row. Quoted spans and anything email-shaped are replaced;
 * the message's shape, which is what a diagnosis needs, is kept.
 */
export function redactMessage(text: string): string {
  return text
    .replace(/"[^"]*"/g, '"[redacted]"')
    .replace(/'[^']*'/g, "'[redacted]'")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
}

/**
 * The parts of an error that are safe to log: its name, its message and stack
 * with quoted values redacted (`redactMessage`), and a Postgres/PostgREST
 * `code` when there is one. Never `details`, `hint`, the request body or the
 * error object as a whole: those can carry the row values (names, emails) a
 * write was given.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: redactMessage(error.message),
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof error.stack === 'string' ? { stack: redactMessage(error.stack) } : {}),
    };
  }
  if (error && typeof error === 'object') {
    const { message, code } = error as { message?: unknown; code?: unknown };
    return {
      name: 'NonError',
      ...(typeof message === 'string' ? { message: redactMessage(message) } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { name: 'NonError', message: redactMessage(String(error)) };
}

/**
 * Log an event inside a request with the same three fields a failure carries:
 * function name, request ID and organization ID (null when not yet known).
 * `details` are the event's own fields, kept as they were before the request
 * context existed. Buffers only; the caller flushes, as it does for `edgeLogger`.
 * Use it for a refusal the handler answers itself. Never put a raw error in
 * `details`: route an error through `logFailure`, which redacts it.
 */
export function logRequest(
  ctx: FailureContext,
  level: LogLevel,
  message: string,
  details: Record<string, unknown> = {}
): void {
  log(
    level,
    message,
    {
      ...details,
      function_name: ctx.functionName,
      request_id: ctx.requestId,
      organization_id: ctx.organizationId ?? null,
    },
    ctx.functionName
  );
}

/**
 * Log a function's failure with its function name, request ID and the
 * organization ID (null when it was not yet known), then flush. Logging never
 * throws: `flush` swallows its own transport failure.
 */
export async function logFailure(
  ctx: FailureContext,
  message: string,
  error: unknown
): Promise<void> {
  log(
    'error',
    `${ctx.functionName}: ${message}`,
    {
      function_name: ctx.functionName,
      request_id: ctx.requestId,
      organization_id: ctx.organizationId ?? null,
      error: describeError(error),
    },
    ctx.functionName
  );
  await flush();
}

/**
 * Wrap a function's handler so every request gets a failure context and any
 * error that escapes the handler is logged through BetterStack before it is
 * rethrown to `serve`, which answers it exactly as it did before.
 */
export function withFailureLogging(
  functionName: string,
  handler: FailureLoggedHandler
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const ctx: FailureContext = { functionName, requestId: crypto.randomUUID() };
    try {
      return await handler(req, ctx);
    } catch (error) {
      await logFailure(ctx, 'unhandled error', error);
      throw error;
    }
  };
}
