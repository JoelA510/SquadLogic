import React from 'react';
import { useTheme } from '../contexts/ThemeContext';

const THEMES = [
    { id: 'dark', label: 'Dark', icon: '🌙' },
    { id: 'light', label: 'Light', icon: '☀️' },
    { id: 'party', label: 'Party', icon: '🎉' },
    { id: 'club', label: 'Club', icon: '🛡️' },
];

function ThemeToggle() {
    const { theme, setTheme, clubLogo } = useTheme();

    const cycleTheme = () => {
        const currentIndex = THEMES.findIndex((t) => t.id === theme);
        const nextIndex = (currentIndex + 1) % THEMES.length;
        setTheme(THEMES[nextIndex].id);
    };

    const getThemeIcon = (themeId) => {
        if (themeId === 'club' && clubLogo) {
            return (
                <div className="w-full h-full p-1 flex items-center justify-center">
                    <img src={clubLogo} alt="Club" className="w-full h-full object-contain drop-shadow-md" />
                </div>
            );
        }
        return THEMES.find((t) => t.id === themeId)?.icon;
    };

    return (
        <button
            onClick={cycleTheme}
            className="theme-toggle"
            aria-label={`Current theme: ${theme}. Click to switch.`}
            title={`Switch Theme (Current: ${THEMES.find(t => t.id === theme)?.label})`}
        >
            <span className="theme-toggle__icon flex items-center justify-center">
                {getThemeIcon(theme)}
            </span>
        </button>
    );
}

export default ThemeToggle;
