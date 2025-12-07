/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./frontend/src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                bg: {
                    app: 'var(--color-bg-app)',
                    surface: 'var(--color-bg-surface)',
                    'surface-hover': 'var(--color-bg-surface-hover)',
                    glass: 'var(--color-bg-glass)',
                },
                border: {
                    subtle: 'var(--color-border-subtle)',
                    highlight: 'var(--color-border-highlight)',
                },
                text: {
                    primary: 'var(--color-text-primary)',
                    secondary: 'var(--color-text-secondary)',
                    muted: 'var(--color-text-muted)',
                    accent: 'var(--color-text-accent)',
                },
                brand: {
                    DEFAULT: 'var(--color-primary)',
                    400: 'var(--color-primary-400)',
                    600: 'var(--color-primary-600)',
                    glow: 'var(--color-primary-glow)',
                },
                status: {
                    success: 'var(--color-status-success)',
                    warning: 'var(--color-status-warning)',
                    error: 'var(--color-status-error)',
                }
            },
            fontFamily: {
                display: ['Outfit', 'sans-serif'],
            },
            animation: {
                fadeIn: 'fadeIn 0.4s ease-out forwards',
                slideUp: 'slideUp 0.5s ease-out forwards',
                pulseGlow: 'pulseGlow 2s infinite',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                slideUp: {
                    '0%': { opacity: '0', transform: 'translateY(10px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                pulseGlow: {
                    '0%': { boxShadow: '0 0 0 0 rgba(56, 189, 248, 0.4)' },
                    '70%': { boxShadow: '0 0 0 10px rgba(56, 189, 248, 0)' },
                    '100%': { boxShadow: '0 0 0 0 rgba(56, 189, 248, 0)' },
                },
            },
        },
    },
    plugins: [],
}
