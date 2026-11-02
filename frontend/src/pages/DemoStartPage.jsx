import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { DEMO_ENABLED } from '../env.js';
import { DemoStartError, demoExpiryMs, demoStartFailure, startDemoSession } from '../lib/demo.js';
import {
  defaultDemoSeason,
  demoSeasonOptions,
  demoToday,
  describeDemoWindow,
} from '../lib/demoSeasons.js';
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
 * The visitor first chooses the season the demo league is dated in, a fall or a spring one (plan
 * docs/changes/2026-11-01-demo-season-selection.md): the same league either way, only the dates differ.
 * The window each covers is shown, and the one the date falls in (or else the next to begin) is
 * preselected. **Start the demo** then waits for the Turnstile token (none, with no site key), signs the
 * visitor in anonymously, asks the server for their demo league in that season and opens it. On any
 * failure it signs the anonymous session out again and stays here, with the reason announced and the
 * choice kept.
 *
 * A visitor who is already in a live demo is not asked again: the entry opens it.
 */
export default function DemoStartPage() {
  const navigate = useNavigate();
  const { session, loading: authLoading, signOut } = useAuth();
  const { organizations = [], loading: orgLoading, refetchOrgs } = useOrganization();
  const captcha = useCaptcha();
  const { enabled: captchaEnabled, token, ready, reset: resetCaptcha } = captcha;

  const [phase, setPhase] = useState(
    /** @type {'choosing' | 'starting' | 'opening' | 'failed'} */ ('choosing')
  );
  // The windows the buttons cover are dated from today in the league's zone, which is the date the
  // server dates the demo from; they are read once, when the page opens.
  const today = useMemo(() => demoToday(), []);
  const options = useMemo(() => demoSeasonOptions(today), [today]);
  const [season, setSeason] = useState(() => defaultDemoSeason(today));
  const legendId = useId();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [startedOrgId, setStartedOrgId] = useState(/** @type {string | null} */ (null));
  // The season the server dated the demo in, once it has: what the page then says is the server's.
  const [startedWindow, setStartedWindow] = useState(
    /** @type {{ season: string, start: string, end: string } | null} */ (null)
  );
  const running = useRef(false);

  const isSignedInAccount = Boolean(session) && session.user?.is_anonymous !== true;
  const isAnonymousSession = Boolean(session) && session.user?.is_anonymous === true;
  // An anonymous session that already has a live demo goes back to it (the server would return that
  // demo, in its own season, whatever was asked for now).
  const hasLiveDemo = organizations.some((member) => {
    const expiresAt = demoExpiryMs(member.organizations);
    return expiresAt !== null && expiresAt > Date.now();
  });

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
      const started = await startDemoSession(season);
      setStartedOrgId(started.organizationId);
      setStartedWindow(
        started.season && started.seasonStart && started.seasonEnd
          ? { season: started.season, start: started.seasonStart, end: started.seasonEnd }
          : null
      );
      setPhase('opening');
      refetchOrgs?.();
    } catch (cause) {
      await fail(cause);
    }
  }, [session, season, captchaEnabled, token, resetCaptcha, refetchOrgs, fail]);

  // A visitor who is already in a live demo is taken back to it.
  useEffect(() => {
    if (!DEMO_ENABLED || phase !== 'choosing' || !isAnonymousSession || orgLoading) return;
    if (hasLiveDemo) navigate('/', { replace: true });
  }, [phase, isAnonymousSession, orgLoading, hasLiveDemo, navigate]);

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

  if (authLoading || (isAnonymousSession && orgLoading && phase === 'choosing')) {
    return <LoadingScreen message="Preparing the demo..." />;
  }

  const working = phase === 'starting' || phase === 'opening';
  const chosen = options.find((option) => option.season === season);
  // While it works, the page names the season and dates the server returned once it has them, and
  // until then the ones the visitor chose.
  const shown = startedWindow ?? { season, start: chosen.start, end: chosen.end };

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
        <h1>
          {phase === 'failed'
            ? 'The demo did not start'
            : working
              ? 'Starting your demo'
              : 'Choose a season for your demo'}
        </h1>
        {phase === 'failed' && (
          <div role="alert" className="demo-error">
            {error}
          </div>
        )}
        {working ? (
          <p role="status" aria-live="polite">
            Setting up a private copy of a ready-made league in the {shown.season} season (
            {describeDemoWindow(shown)}). This takes a few seconds.
          </p>
        ) : (
          <form
            className="demo-season-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready) begin();
            }}
          >
            {phase === 'choosing' && (
              <p>
                A private copy of a ready-made league: 128 teams, placeholder data only. Pick when
                its season runs. The league and its teams are the same either way; only the dates
                differ.
              </p>
            )}
            <fieldset className="demo-season-choice" aria-labelledby={legendId}>
              <legend id={legendId} className="demo-season-legend">
                Season
              </legend>
              {options.map((option) => {
                const inputId = `demo-season-${option.season}`;
                return (
                  <label
                    key={option.season}
                    htmlFor={inputId}
                    className={`demo-season-option${option.season === season ? ' is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      id={inputId}
                      name="demo-season"
                      value={option.season}
                      checked={option.season === season}
                      onChange={() => setSeason(option.season)}
                      aria-describedby={
                        option.note ? `${inputId}-dates ${inputId}-note` : `${inputId}-dates`
                      }
                    />
                    <span className="demo-season-text">
                      <span className="demo-season-name">{option.label} season</span>
                      <span id={`${inputId}-dates`} className="demo-season-dates">
                        {option.dates} · {option.weeks} weeks
                      </span>
                      {option.note && (
                        <span id={`${inputId}-note`} className="demo-season-dates">
                          {option.note}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <Turnstile
              resetKey={captcha.resetKey}
              onToken={captcha.onToken}
              onFailure={captcha.onFailure}
            />
            {captchaEnabled && !ready && (
              <p role="status" aria-live="polite" className="demo-season-wait">
                Complete the check above to start the demo.
              </p>
            )}
            <div className="demo-page-actions">
              <button type="submit" className="btn btn-primary" disabled={!ready}>
                {phase === 'failed' ? 'Try again' : 'Start the demo'}
              </button>
              <Link className="btn btn-default" to="/">
                Back to sign in
              </Link>
            </div>
          </form>
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
