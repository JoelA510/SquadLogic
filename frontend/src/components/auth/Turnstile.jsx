import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { TURNSTILE_SITE_KEY } from '../../env.js';

/**
 * Cloudflare Turnstile, without a dependency (plan docs/changes/2026-10-22-demo-mode.md, D4).
 *
 * CAPTCHA is one Supabase setting for the whole project: once it is on, sign-in, sign-up,
 * password reset and anonymous sign-in all need a token. So every form that makes one of those
 * calls shows this widget and sends its token. With no `VITE_TURNSTILE_SITE_KEY` (a self-hosted
 * project with CAPTCHA off) nothing renders, nothing loads and no token is sent.
 *
 * Cloudflare's script is loaded on demand, once, on the pages that need it (never from
 * `index.html`), by explicit render. `vercel.json` allows the origin in `script-src` and
 * `frame-src`, and `docs/security/csp.md` says why.
 */
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** @type {Promise<any> | null} */
let scriptPromise = null;

/**
 * Resolves with `window.turnstile` once Cloudflare's script has loaded; rejects if it cannot load.
 * A page that already has the global (the script was loaded, or a test stands one in) resolves at
 * once. A failed load is not remembered, so a retry loads it again.
 * @returns {Promise<any>}
 */
export function loadTurnstile() {
  const existing = /** @type {any} */ (window).turnstile;
  if (existing) return Promise.resolve(existing);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = /** @type {any} */ (window).turnstile;
      if (api) resolve(api);
      else reject(new Error('Turnstile loaded without its API'));
    };
    script.onerror = () => reject(new Error('Turnstile could not be loaded'));
    document.head.appendChild(script);
  });
  scriptPromise.catch(() => {
    // Forget the failure so the retry button loads the script again; the rejection itself is
    // reported to the widget that asked, below.
    scriptPromise = null;
  });
  return scriptPromise;
}

/**
 * The state a form needs around the widget: whether CAPTCHA is on, the current token, and a
 * `reset` to call after every use (a token is good for one call). `resetKey` goes to the widget,
 * which fetches a fresh challenge whenever it changes.
 *
 * `ready` is true when the form may submit: CAPTCHA is off, or a token is in hand.
 */
export function useCaptcha() {
  const enabled = Boolean(TURNSTILE_SITE_KEY);
  const [token, setToken] = useState(/** @type {string | null} */ (null));
  const [failed, setFailed] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const onToken = useCallback((/** @type {string | null} */ next) => {
    setToken(next);
    if (next) setFailed(false);
  }, []);
  const onFailure = useCallback(() => {
    setToken(null);
    setFailed(true);
  }, []);
  const reset = useCallback(() => {
    setToken(null);
    setFailed(false);
    setResetKey((n) => n + 1);
  }, []);

  return {
    enabled,
    token: enabled ? token : null,
    failed,
    ready: !enabled || Boolean(token),
    resetKey,
    onToken,
    onFailure,
    reset,
  };
}

/**
 * The widget. Renders nothing without a site key. Calls `onToken(token)` when a challenge is
 * solved and `onToken(null)` when the token expires; calls `onFailure()` when the challenge or its
 * script fails, and then shows a message (announced) with a **Try again** button. A change of
 * `resetKey` (the parent's `reset()`, after each use) asks Cloudflare for a fresh challenge.
 *
 * @param {{
 *   onToken: (token: string | null) => void,
 *   onFailure: () => void,
 *   resetKey?: number,
 * }} props
 */
export default function Turnstile({ onToken, onFailure, resetKey = 0 }) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const widgetIdRef = useRef(/** @type {string | null} */ (null));
  const apiRef = useRef(/** @type {any} */ (null));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const callbacks = useRef({ onToken, onFailure });
  useEffect(() => {
    callbacks.current = { onToken, onFailure };
  });

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return undefined;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        apiRef.current = api;
        widgetIdRef.current = api.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'auto',
          callback: (/** @type {string} */ token) => callbacks.current.onToken(token),
          'expired-callback': () => callbacks.current.onToken(null),
          'error-callback': () => {
            setFailed(true);
            callbacks.current.onFailure();
          },
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        callbacks.current.onFailure();
      });
    return () => {
      cancelled = true;
      if (widgetIdRef.current !== null && apiRef.current) {
        try {
          apiRef.current.remove(widgetIdRef.current);
        } catch {
          // Best-effort cleanup: the widget may already be gone with its container.
        }
      }
      widgetIdRef.current = null;
    };
  }, [attempt]);

  // A new `resetKey` after the first: a fresh challenge, since a token is good for one call.
  const firstKey = useRef(resetKey);
  useEffect(() => {
    if (resetKey === firstKey.current) return;
    firstKey.current = resetKey;
    if (widgetIdRef.current !== null && apiRef.current) {
      apiRef.current.reset(widgetIdRef.current);
    }
  }, [resetKey]);

  if (!TURNSTILE_SITE_KEY) return null;

  return (
    <div className="turnstile" role="group" aria-label="Verification">
      <div ref={containerRef} />
      {failed && (
        <div role="alert" className="turnstile-failed">
          <span>The verification check did not load.</span>{' '}
          <button
            type="button"
            className="btn btn-default sm"
            onClick={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

Turnstile.propTypes = {
  onToken: PropTypes.func.isRequired,
  onFailure: PropTypes.func.isRequired,
  resetKey: PropTypes.number,
};
