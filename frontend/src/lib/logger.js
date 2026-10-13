/**
 * Production-safe logger utility (Phase 4, enhanced Phase 9).
 *
 * - logger.log / logger.warn — dev-only, silenced in production builds.
 * - logger.error — always active; forwards to Sentry when configured.
 * - logger.captureException — explicit Sentry error capture with optional context.
 * - logger.setUser — attach the user, organization and role IDs to future
 *   Sentry events (never a name or an email).
 *
 * Sentry integration uses the @sentry/react SDK (installed as a dependency).
 * When VITE_SENTRY_DSN is absent, the SDK is imported but init() was never
 * called (see main.jsx), so all capture calls are harmless no-ops.
 *
 * Usage:
 *   import { logger } from '../lib/logger.js';
 *   logger.log('debug info', data);
 *   logger.captureException(error, { extra: { teamId } });
 */

import * as Sentry from '@sentry/react';

// ---------------------------------------------------------------------------
// Logger API
// ---------------------------------------------------------------------------

export const logger = {
  log: (...args) => {
    if (!import.meta.env.PROD) console.log(...args);
  },

  // `info` is an alias for `log` — matches the standard console API so call
  // sites like `logger.info('event', payload)` don't silently crash.
  info: (...args) => {
    if (!import.meta.env.PROD) console.info(...args);
  },

  warn: (...args) => {
    if (!import.meta.env.PROD) console.warn(...args);
  },

  error: (...args) => {
    console.error(...args);
    // Forward genuine errors to Sentry
    const err = args.find((a) => a instanceof Error);
    if (err) {
      Sentry.captureException(err);
    } else {
      Sentry.captureMessage(args.map(String).join(' '), 'error');
    }
  },

  /**
   * Explicitly capture an exception with optional context.
   * @param {Error} error
   * @param {{ extra?: Record<string, any>, tags?: Record<string, string> }} [ctx]
   */
  captureException: (error, ctx) => {
    console.error(error);
    if (ctx) {
      Sentry.withScope((scope) => {
        if (ctx.extra) {
          for (const [k, v] of Object.entries(ctx.extra)) {
            scope.setExtra(k, v);
          }
        }
        if (ctx.tags) {
          for (const [k, v] of Object.entries(ctx.tags)) {
            scope.setTag(k, v);
          }
        }
        Sentry.captureException(error);
      });
    } else {
      Sentry.captureException(error);
    }
  },

  /**
   * Associate a user identity with future Sentry events. AuthContext calls it
   * on sign-in, OrganizationContext when the active organization is chosen or
   * switched, and AuthContext with null on sign-out.
   *
   * IDs only: whatever the caller passes, only `id`, `organization_id` and
   * `role` reach Sentry (see `sentryUserOf`), so a profile or session object
   * handed over whole cannot leak a name or an email. `organization_id` is
   * also set as a tag, so events can be searched and grouped by it.
   *
   * Safe without a DSN: `Sentry.setUser` and `Sentry.setTag` only write the
   * current scope, and with `Sentry.init` never called nothing is sent.
   * @param {{ id: string, organization_id?: string | null, role?: string | null } | null} user
   */
  setUser: (user) => {
    const sentryUser = sentryUserOf(user);
    Sentry.setUser(sentryUser);
    Sentry.setTag('organization_id', sentryUser?.organization_id);
  },
};

/**
 * The fields of a user that may reach Sentry: the user ID, the active
 * organization ID and the role, each kept only when it is a non-empty string.
 * Everything else (email, name, phone, profile) is dropped. Returns null for
 * no user or a user without an ID, which clears Sentry's user.
 * @param {unknown} user
 * @returns {{ id: string, organization_id?: string, role?: string } | null}
 */
export function sentryUserOf(user) {
  if (!user || typeof user !== 'object') return null;
  const {
    id,
    organization_id: organizationId,
    role,
  } = /** @type {Record<string, unknown>} */ (user);
  if (typeof id !== 'string' || id === '') return null;
  /** @type {{ id: string, organization_id?: string, role?: string }} */
  const out = { id };
  if (typeof organizationId === 'string' && organizationId !== '') {
    out.organization_id = organizationId;
  }
  if (typeof role === 'string' && role !== '') out.role = role;
  return out;
}
