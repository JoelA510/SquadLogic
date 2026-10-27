import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { DEMO_ENABLED } from '../env.js';
import Turnstile, { useCaptcha } from './auth/Turnstile.jsx';
import logo from '../assets/SL-Logo.png';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // `/?signup=1` (the demo's "Create an account") opens the sign-up form.
  const [isSignUp, setIsSignUp] = useState(
    () => new URLSearchParams(window.location.search).get('signup') === '1'
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const { isConfigured, resetPasswordForEmail } = useAuth();
  const navigate = useNavigate();
  // Turnstile: the project's CAPTCHA setting covers sign-in, sign-up and password reset alike, so
  // each waits for a token, sends it, and gets a fresh one (a token is good for one call).
  const captcha = useCaptcha();
  const captchaOptions = captcha.token ? { captchaToken: captcha.token } : undefined;

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!isConfigured) {
      setError('Supabase is not configured. Please check your .env file.');
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);

    if (isForgotPassword) {
      const { error: resetError } = await resetPasswordForEmail(email, captchaOptions);
      if (resetError) {
        setError(resetError.message);
      } else {
        setMessage('Password reset link sent! Please check your email.');
        setIsForgotPassword(false);
      }
    } else if (isSignUp) {
      const { error, data } = await supabase.auth.signUp({
        email,
        password,
        ...(captchaOptions ? { options: captchaOptions } : {}),
      });
      if (error) {
        setError(error.message);
      } else if (data.user && !data.session) {
        setMessage('Registration successful! Please check your email to confirm your account.');
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
        ...(captchaOptions ? { options: captchaOptions } : {}),
      });
      if (error) {
        setError(error.message);
      }
    }
    captcha.reset();
    setLoading(false);
  };

  return (
    <div
      className="login-container"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '5%', // Responsive buffer
        background: 'var(--bg-app-gradient)',
      }}
    >
      <div
        className="section-panel glass-panel-premium"
        style={{ maxWidth: '480px', width: '100%', padding: '3rem' }}
      >
        <header
          className="section-header"
          style={{
            marginBottom: '2.5rem',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1.5rem',
          }}
        >
          <img
            src={logo}
            alt="SquadLogic Logo"
            width="120"
            height="120"
            style={{
              width: '120px',
              height: 'auto',
            }}
          />
          <div>
            <h2
              style={{
                color: 'var(--text-primary)',
                fontSize: '1.25rem',
                fontWeight: '500',
                margin: 0,
              }}
            >
              {isForgotPassword
                ? 'Reset your password'
                : isSignUp
                  ? 'Create an account'
                  : 'Sign in to manage schedules'}
            </h2>
          </div>
        </header>

        {error && (
          <div
            className="alert-banner"
            role="alert"
            aria-live="assertive"
            style={{
              marginBottom: '1.5rem',
              color: 'var(--color-status-error)',
              background: 'var(--color-status-error-bg)',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--color-status-error)',
            }}
          >
            <span aria-hidden="true">⚠</span> {error}
          </div>
        )}

        {message && (
          <div
            className="alert-banner"
            role="alert"
            aria-live="polite"
            style={{
              marginBottom: '1.5rem',
              color: 'var(--color-status-success)',
              background: 'var(--color-status-success-bg)',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--color-status-success)',
            }}
          >
            <span aria-hidden="true">✓</span> {message}
          </div>
        )}

        <form
          onSubmit={handleAuth}
          style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}
        >
          <div className="form-group">
            <label
              htmlFor="email"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontSize: '1rem',
                fontWeight: '500',
              }}
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              // `username` pairs the address with the saved password on sign-in; sign-up (and the
              // forgot-password form) is an address for a new or reset account.
              autoComplete={isSignUp || isForgotPassword ? 'email' : 'username'}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="glass-input"
              placeholder="admin@example.com"
              style={{
                width: '100%',
                padding: '1rem',
                fontSize: '1rem',
                borderRadius: '0.75rem',
                border: '1px solid var(--glass-border)',
                background: 'var(--glass-bg)',
                color: 'inherit',
              }}
            />
          </div>

          {!isForgotPassword && (
            <div className="form-group">
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <label
                  htmlFor="password"
                  style={{
                    display: 'block',
                    marginBottom: '0.5rem',
                    fontSize: '1rem',
                    fontWeight: '500',
                  }}
                >
                  Password
                </label>
                {!isSignUp && (
                  <button
                    type="button"
                    onClick={() => setIsForgotPassword(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent-color)',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      textDecoration: 'underline',
                      padding: 0,
                    }}
                  >
                    Forgot Password?
                  </button>
                )}
              </div>
              <input
                id="password"
                type="password"
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="glass-input"
                placeholder="••••••••"
                style={{
                  width: '100%',
                  padding: '1rem',
                  fontSize: '1rem',
                  borderRadius: '0.75rem',
                  border: '1px solid var(--glass-border)',
                  background: 'var(--glass-bg)',
                  color: 'inherit',
                }}
              />
            </div>
          )}

          <Turnstile
            resetKey={captcha.resetKey}
            onToken={captcha.onToken}
            onFailure={captcha.onFailure}
          />

          <button
            type="submit"
            disabled={loading || !captcha.ready}
            className="btn btn-primary lg"
            style={{
              marginTop: '1.5rem',
              width: '100%',
            }}
          >
            {loading
              ? isForgotPassword
                ? 'Sending reset link...'
                : isSignUp
                  ? 'Creating account...'
                  : 'Signing in...'
              : isForgotPassword
                ? 'Send Reset Link'
                : isSignUp
                  ? 'Sign Up'
                  : 'Sign In'}
          </button>
        </form>

        {DEMO_ENABLED && (
          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-default"
              onClick={() => navigate('/demo/start')}
            >
              Try the demo
            </button>
            <p
              style={{ margin: '0.5rem 0 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}
            >
              No account needed: a private copy of a ready-made league for 30 minutes.
            </p>
          </div>
        )}

        <div
          style={{
            marginTop: '2rem',
            textAlign: 'center',
            fontSize: '1rem',
            color: 'var(--text-secondary)',
          }}
        >
          {isForgotPassword ? (
            <button
              type="button"
              onClick={() => setIsForgotPassword(false)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-color)',
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0,
                font: 'inherit',
                fontWeight: '500',
              }}
            >
              Back to Sign In
            </button>
          ) : (
            <>
              {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                type="button"
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setError(null);
                  setMessage(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent-color)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  font: 'inherit',
                  fontWeight: '500',
                }}
              >
                {isSignUp ? 'Sign In' : 'Sign Up'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
