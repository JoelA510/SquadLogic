import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { DEMO_ENABLED } from '../env.js';
import { logger } from '../lib/logger.js';
import logo from '../assets/SL-Logo.png';

/**
 * `/demo/ended` (plan docs/changes/2026-10-22-demo-mode.md, D4): where a visitor lands when their
 * demo runs out, or when they open the app with a leftover anonymous session whose demo is gone.
 * The server removed the demo's data from view at expiry and deletes it within ten minutes; this
 * page only says so and offers the two ways on.
 */
export default function DemoEndedPage() {
  const navigate = useNavigate();
  const { session, signOut } = useAuth();

  // A leftover anonymous session has nothing left to open: close it. "Start again" stays disabled
  // while the session is still there (`isAnonymous` follows the auth state, so it clears only when the
  // sign-out has landed): /demo/start reuses a session it finds, and the ending demo's would then be
  // signed out from under the new one.
  const isAnonymous = session?.user?.is_anonymous === true;
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  });
  useEffect(() => {
    if (!isAnonymous) return;
    Promise.resolve(signOutRef.current()).catch((error) => {
      logger.warn('[Demo] could not close the ended demo session', error);
    });
  }, [isAnonymous]);

  return (
    <div className="demo-page">
      <div className="section-panel glass-panel-premium demo-page-card">
        <img src={logo} alt="SquadLogic" width="96" height="96" />
        <h1>Your demo has ended</h1>
        <p>
          The demo is a private, 30-minute copy of a ready-made league with placeholder data. Your
          copy has been removed.
        </p>
        <div className="demo-page-actions">
          {DEMO_ENABLED && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={isAnonymous}
              onClick={() => navigate('/demo/start')}
            >
              Start again
            </button>
          )}
          <button
            type="button"
            className={DEMO_ENABLED ? 'btn btn-default' : 'btn btn-primary'}
            onClick={() => navigate('/?signup=1')}
          >
            Create an account
          </button>
        </div>
      </div>
    </div>
  );
}
