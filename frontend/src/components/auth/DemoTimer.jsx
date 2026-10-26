import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useDemo } from '../../hooks/useDemo.js';
import { DEMO_ANNOUNCE_AT_MS, formatTimeLeft, spokenTimeLeft } from '../../lib/demo.js';

/**
 * The demo's clock (plan docs/changes/2026-10-22-demo-mode.md, D4): fixed in the header for the
 * whole demo, "Demo league · 22:14 left", with **Leave demo**. It is the warning: there is no
 * separate visual alert. It is a `timer` that does not chatter (`aria-live="off"`); a screen-reader
 * user, who cannot see it, hears two polite announcements, at 5 minutes and at 1 minute left.
 *
 * The clock runs from the expiry the server set (`organizations.demo_expires_at`). At zero the
 * visitor is signed out and sent to `/demo/ended`; the server stopped honouring the demo at that
 * instant regardless.
 *
 * Renders nothing outside a demo. `floating` pins it to the corner on the few pages that have no
 * header (season setup).
 */
export default function DemoTimer({ floating = false }) {
  const { isDemo, expiresAtMs } = useDemo();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState('');
  const previousLeft = useRef(/** @type {number | null} */ (null));
  const ended = useRef(false);
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  });

  const active = isDemo && expiresAtMs !== null;

  useEffect(() => {
    if (!active) return undefined;
    ended.current = false;
    previousLeft.current = null;
    // A first reading at once (the clock may have been mounted well before the demo appeared),
    // then one a second.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active, expiresAtMs]);

  const msLeft = active ? expiresAtMs - now : null;

  // The two announcements: said when the clock crosses a threshold while the page is open (a page
  // opened with 3 minutes left does not claim 5).
  useEffect(() => {
    if (msLeft === null) return;
    const before = previousLeft.current;
    previousLeft.current = msLeft;
    if (before === null || msLeft <= 0) return;
    const crossed = DEMO_ANNOUNCE_AT_MS.filter((at) => before > at && msLeft <= at);
    if (crossed.length > 0) {
      setAnnouncement(`${spokenTimeLeft(Math.min(...crossed))} left in the demo.`);
    }
  }, [msLeft]);

  // At zero: leave, once.
  useEffect(() => {
    if (msLeft === null || msLeft > 0 || ended.current) return;
    ended.current = true;
    navigate('/demo/ended', { replace: true });
    signOutRef.current();
  }, [msLeft, navigate]);

  if (!active) return null;

  return (
    <>
      <div
        className={`demo-timer${floating ? ' demo-timer-floating' : ''}`}
        role="timer"
        aria-live="off"
        data-testid="demo-timer"
      >
        <span>
          <span className="demo-timer-label">Demo league · </span>
          <span className="demo-timer-clock">{formatTimeLeft(msLeft ?? 0)}</span> left
        </span>
        <button
          type="button"
          onClick={() => {
            navigate('/', { replace: true });
            signOutRef.current();
          }}
        >
          Leave demo
        </button>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </>
  );
}

DemoTimer.propTypes = {
  floating: PropTypes.bool,
};
