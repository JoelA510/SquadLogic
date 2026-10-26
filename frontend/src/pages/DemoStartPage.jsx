import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { DEMO_ENABLED } from '../env.js';
import { DemoStartError, demoStartFailure, startDemoSession } from '../lib/demo.js';
import { logger } from '../lib/logger.js';
import Turnstile, { useCaptcha } from '../components/auth/Turnstile.jsx';
import LoadingScreen from '../components/LoadingScreen.jsx';
import logo from '../assets/SL-Logo.png';

/** How long the demo may take to appear in the visitor's organizations before it is called failed. */
const OPEN_TIMEOUT_MS = 15_000;

/**
 * `/demo/start` (plan docs/changes/2026-10-22-demo-mode.md, D4): the demo's entry, rendered for a
 * signed-out visitor and for an anonymous one alike, outside the redirect that sends a user with no
 * organization to `/organizations/new`.
 *
 * Once the Turnstile widget yields a token (or at once, with no site key), it signs the visitor in
 * anonymously, asks the server for their demo league and opens it. On any failure it signs the
 * anonymous session out again and stays here, with the reason announced.
 */
export default function DemoStartPage() {
  const navigate = useNavigate();
  const { session, loading: authLoading, signOut } = useAuth();
  const { organizations = [], loading: orgLoading, refetchOrgs } = useOrganization();
  const captcha = useCaptcha();
  const { enabled: captchaEnabled, token, ready, reset: resetCaptcha } = captcha;

  const [phase, setPhase] = useState(
    /** @type {'idle' | 'starting' | 'opening' | 'failed'} */ ('idle')
  );
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [startedOrgId, setStartedOrgId] = useState(/** @type {string | null} */ (null));
  const running = useRef(false);

  const isSignedInAccount = Boolean(session) && session.user?.is_anonymous !== true;

  const fail = useCallback(
    async (/** @type {unknown} */ cause) => {
      const failure = cause instanceof DemoStartError ? cause : demoStartFailure(cause);
      logger.warn('[Demo] start failed', { kind: failure.kind, cause });
      try {
        await supabase.auth.signOut();
      } catch (signOutError) {
        // Best effort: the visitor is told the demo did not start whether or not the anonymous
        // session could be closed; the server purges an idle anonymous user within the hour.
        logger.warn('[Demo] could not sign the anonymous session out', signOutError);
      }
      setError(failure.message);
      setPhase('failed');
      resetCaptcha();
      running.current = false;
    },
    [resetCaptcha]
  );

  const begin = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError(null);
    setPhase('starting');
    try {
      if (!session) {
        const { error: signInError } = await supabase.auth.signInAnonymously(
          captchaEnabled ? { options: { captchaToken: token ?? undefined } } : undefined
        );
        if (signInError) throw signInError;
        // The token is single-use; a retry gets a fresh one.
        resetCaptcha();
      }
      const started = await startDemoSession();
      setStartedOrgId(started.organizationId);
      setPhase('opening');
      refetchOrgs?.();
    } catch (cause) {
      await fail(cause);
    }
  }, [session, captchaEnabled, token, resetCaptcha, refetchOrgs, fail]);

  // Start by itself once there is nothing left to wait for: auth settled, not a real account, the
  // token (if CAPTCHA is on) in hand.
  useEffect(() => {
    if (!DEMO_ENABLED || authLoading || isSignedInAccount) return;
    if (phase !== 'idle' || !ready) return;
    begin();
  }, [authLoading, isSignedInAccount, phase, ready, begin]);

  // Open the demo once the organization list has it.
  useEffect(() => {
    if (phase !== 'opening' || !startedOrgId || orgLoading) return undefined;
    if (organizations.some((member) => member.organization_id === startedOrgId)) {
      navigate('/', { replace: true });
      return undefined;
    }
    return undefined;
  }, [phase, startedOrgId, orgLoading, organizations, navigate]);

  // ...or call it failed if it never appears.
  useEffect(() => {
    if (phase !== 'opening') return undefined;
    const timer = setTimeout(() => {
      fail(new DemoStartError('unavailable', 'The demo started but could not be opened.'));
    }, OPEN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, fail]);

  if (authLoading) return <LoadingScreen message="Preparing the demo..." />;

  let body;
  if (!DEMO_ENABLED) {
    body = (
      <>
        <h1>The demo is not available here</h1>
        <p>This SquadLogic deployment does not offer the demo.</p>
        <div className="demo-page-actions">
          <Link className="btn btn-primary" to="/">
            Back to sign in
          </Link>
        </div>
      </>
    );
  } else if (isSignedInAccount) {
    body = (
      <>
        <h1>You are signed in</h1>
        <p>The demo is a separate, private league. Sign out of your account to try it.</p>
        <div className="demo-page-actions">
          <button type="button" className="btn btn-primary" onClick={() => signOut()}>
            Sign out and try the demo
          </button>
          <Link className="btn btn-default" to="/">
            Back to my account
          </Link>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h1>{phase === 'failed' ? 'The demo did not start' : 'Starting your demo'}</h1>
        {phase === 'failed' ? (
          <div role="alert" className="demo-error">
            {error}
          </div>
        ) : (
          <p role="status" aria-live="polite">
            {phase === 'idle' && captchaEnabled
              ? 'Complete the check below to open a private copy of a ready-made league.'
              : 'Setting up a private copy of a ready-made league. This takes a few seconds.'}
          </p>
        )}
        {(phase === 'idle' || phase === 'failed') && (
          <Turnstile
            resetKey={captcha.resetKey}
            onToken={captcha.onToken}
            onFailure={captcha.onFailure}
          />
        )}
        {phase === 'failed' && (
          <div className="demo-page-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!ready}
              onClick={() => {
                setPhase('idle');
                setError(null);
              }}
            >
              Try again
            </button>
            <Link className="btn btn-default" to="/">
              Back to sign in
            </Link>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="demo-page">
      <div className="section-panel glass-panel-premium demo-page-card">
        <img src={logo} alt="SquadLogic" width="96" height="96" />
        {body}
      </div>
    </div>
  );
}
