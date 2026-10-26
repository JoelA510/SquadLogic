import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import logo from '../assets/SL-Logo.png';

export default function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const { updatePassword, session } = useAuth();
  const navigate = useNavigate();

  const isInvalidLink = !session && !window.location.hash.includes('type=recovery');
  const displayedError =
    error || (isInvalidLink ? 'Invalid or expired reset link. Please request a new one.' : null);

  const handleReset = async (e) => {
    e.preventDefault();
    setError(null);
    setMessage(null);

    // Validation: 12-character minimum
    if (password.length < 12) {
      setError('Password must be at least 12 characters long for enterprise security.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const { error: resetError } = await updatePassword(password);

    if (resetError) {
      setError(resetError.message);
    } else {
      setMessage('Password updated successfully! Redirecting to login...');
      setTimeout(() => navigate('/'), 3000);
    }
    setLoading(false);
  };

  return (
    <div
      className="reset-password-container"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: 'var(--bg-app-gradient)',
      }}
    >
      <div
        className="section-panel glass-panel-premium"
        style={{ maxWidth: '440px', width: '100%', padding: '3rem' }}
      >
        <header
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
            style={{
              width: '100px',
              height: 'auto',
            }}
          />
          <h2
            style={{
              color: 'var(--text-primary)',
              fontSize: '1.5rem',
              fontWeight: '600',
              margin: 0,
            }}
          >
            Reset Your Password
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
            Enter a new secure password (min 12 characters)
          </p>
        </header>

        {displayedError && (
          <div
            className="alert-banner"
            role="alert"
            style={{
              marginBottom: '1.5rem',
              color: 'var(--color-status-error)',
              background: 'var(--color-status-error-bg)',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--color-status-error)',
              fontSize: '0.9rem',
            }}
          >
            {displayedError}
          </div>
        )}

        {message && (
          <div
            className="alert-banner"
            role="alert"
            style={{
              marginBottom: '1.5rem',
              color: 'var(--color-status-success)',
              background: 'var(--color-status-success-bg)',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              border: '1px solid var(--color-status-success)',
              fontSize: '0.9rem',
            }}
          >
            {message}
          </div>
        )}

        <form
          onSubmit={handleReset}
          style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
        >
          <div className="form-group">
            <label
              htmlFor="new-password"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontSize: '0.9rem',
                fontWeight: '500',
              }}
            >
              New Password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="glass-input"
              placeholder="Min 12 characters"
              style={{ width: '100%' }}
            />
          </div>

          <div className="form-group">
            <label
              htmlFor="confirm-password"
              style={{
                display: 'block',
                marginBottom: '0.5rem',
                fontSize: '0.9rem',
                fontWeight: '500',
              }}
            >
              Confirm Password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="glass-input"
              placeholder="Repeat new password"
              style={{ width: '100%' }}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary lg"
            style={{
              marginTop: '1rem',
              width: '100%',
            }}
          >
            {loading ? 'Updating...' : 'Update Password'}
          </button>
        </form>

        <div style={{ marginTop: '2rem', textAlign: 'center' }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '0.875rem',
              textDecoration: 'underline',
            }}
          >
            Back to Login
          </button>
        </div>
      </div>
    </div>
  );
}
