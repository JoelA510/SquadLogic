import React, { useEffect, useState } from 'react';

const THEMES = [
    { id: 'dark', label: 'Dark', icon: '🌙' },
    { id: 'light', label: 'Light', icon: '☀️' },
    { id: 'party', label: 'Party', icon: '🎉' },
];

function ThemeToggle() {
    const [currentTheme, setCurrentTheme] = useState(() => {
        return localStorage.getItem('squadlogic-theme') || 'dark';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', currentTheme);
        localStorage.setItem('squadlogic-theme', currentTheme);
    }, [currentTheme]);

    const cycleTheme = () => {
        const currentIndex = THEMES.findIndex((t) => t.id === currentTheme);
        const nextIndex = (currentIndex + 1) % THEMES.length;
        setCurrentTheme(THEMES[nextIndex].id);
    };

    return (
        <button
            onClick={cycleTheme}
            className="theme-toggle"
            aria-label={`Current theme: ${currentTheme}. Click to switch.`}
            title="Switch Theme"
        >
            <span className="theme-toggle__icon">{THEMES.find((t) => t.id === currentTheme)?.icon}</span>
        </button>
    );
}

export default ThemeToggle;
