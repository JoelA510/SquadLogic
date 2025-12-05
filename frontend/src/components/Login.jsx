import React, { useState } from 'react';
import { supabase } from '../utils/supabaseClient';
import { useAuth } from '../contexts/AuthContext';
import logo from '../assets/logo.png';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isSignUp, setIsSignUp] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);

    const { isConfigured } = useAuth();

    const handleAuth = async (e) => {
        e.preventDefault();
        if (!isConfigured) {
            setError('Supabase is not configured. Please check your .env file.');
            return;
        }
        setLoading(true);
        setError(null);
        setMessage(null);

        if (isSignUp) {
            const { error, data } = await supabase.auth.signUp({
                email,
                password,
            });
            if (error) {
                setError(error.message);
            } else if (data.user && !data.session) {
                setMessage('Registration successful! Please check your email to confirm your account.');
            } else {
                // Auto-login might happen if email confirmation is disabled
            }
        } else {
            const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (error) {
                setError(error.message);
            }
        }
        setLoading(false);
    };

    return (
        <div className="login-container" style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
            background: 'var(--bg-gradient)',
            color: 'var(--text-primary)'
        }}>
            <div className="section-panel glass-panel" style={{ maxWidth: '480px', width: '100%', padding: '3rem' }}>
                <header className="section-header" style={{ marginBottom: '2.5rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
                    <img src={logo} alt="SquadLogic Logo" style={{ width: '160px', height: 'auto', filter: 'drop-shadow(0 0 20px rgba(59, 130, 246, 0.5))' }} />
                    <div>
                        <p style={{ color: 'var(--text-primary)', fontSize: '1.25rem', fontWeight: '500', margin: 0 }}>
                            {isSignUp ? 'Create an account' : 'Sign in to manage schedules'}
                        </p>
                    </div>
                </header>

                {error && (
                    <div className="alert-banner" role="alert" style={{ marginBottom: '1.5rem', color: '#ff6b6b', background: 'rgba(255, 107, 107, 0.1)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(255, 107, 107, 0.2)' }}>
                        <span>⚠</span> {error}
                    </div>
                )}

                {message && (
                    <div className="alert-banner" role="alert" style={{ marginBottom: '1.5rem', color: '#51cf66', background: 'rgba(81, 207, 102, 0.1)', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid rgba(81, 207, 102, 0.2)' }}>
                        <span>✓</span> {message}
                    </div>
                )}

                <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div className="form-group">
                        <label htmlFor="email" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '1rem', fontWeight: '500' }}>Email</label>
                        <input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            className="glass-input"
                            placeholder="admin@example.com"
                            style={{ width: '100%', padding: '1rem', fontSize: '1rem', borderRadius: '0.75rem', border: '1px solid var(--glass-border)', background: 'var(--glass-bg)', color: 'inherit' }}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="password" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '1rem', fontWeight: '500' }}>Password</label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="glass-input"
                            placeholder="••••••••"
                            style={{ width: '100%', padding: '1rem', fontSize: '1rem', borderRadius: '0.75rem', border: '1px solid var(--glass-border)', background: 'var(--glass-bg)', color: 'inherit' }}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="action-button primary-button"
                        style={{ marginTop: '1.5rem', width: '100%', justifyContent: 'center', padding: '1rem', fontSize: '1.1rem' }}
                    >
                        {loading ? (isSignUp ? 'Creating account...' : 'Signing in...') : (isSignUp ? 'Sign Up' : 'Sign In')}
                    </button>
                </form>

                <div style={{ marginTop: '2rem', textAlign: 'center', fontSize: '1rem', color: 'var(--text-secondary)' }}>
                    {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
                    <button
                        type="button"
                        onClick={() => {
                            setIsSignUp(!isSignUp);
                            setError(null);
                            setMessage(null);
                        }}
                        style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', textDecoration: 'underline', padding: 0, font: 'inherit', fontWeight: '500' }}
                    >
                        {isSignUp ? 'Sign In' : 'Sign Up'}
                    </button>
                </div>
            </div>
        </div>
    );
}
