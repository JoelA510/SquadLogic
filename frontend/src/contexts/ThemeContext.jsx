import React, { createContext, useContext, useEffect, useState } from 'react';
import { getContrastMode } from '../utils/colorUtils';

const ThemeContext = createContext();

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
};

export const ThemeProvider = ({ children }) => {
    const [theme, setTheme] = useState(() => {
        return localStorage.getItem('squadlogic-theme') || 'dark';
    });

    const [clubColors, setClubColors] = useState(() => {
        const saved = localStorage.getItem('squadlogic-club-colors');
        return saved ? JSON.parse(saved) : {
            primaryAccent: '#3b82f6',
            secondaryAccent: '#1e293b',
            background1: '#0f172a',
            background2: '#1e293b'
        };
    });

    const [clubLogo, setClubLogo] = useState(() => {
        return localStorage.getItem('squadlogic-club-logo') || null;
    });

    const [clubMode, setClubMode] = useState(() => {
        return localStorage.getItem('squadlogic-club-mode') || 'dark';
    });

    const [extractedColors, setExtractedColors] = useState(() => {
        const saved = localStorage.getItem('squadlogic-extracted-colors');
        return saved ? JSON.parse(saved) : [];
    });

    const [leagueName, setLeagueName] = useState(() => {
        return localStorage.getItem('squadlogic-league-name') || 'My Youth League';
    });

    const [currentSeason, setCurrentSeason] = useState(() => {
        return localStorage.getItem('squadlogic-current-season') || '2025';
    });

    const [availableSeasons, setAvailableSeasons] = useState(() => {
        const saved = localStorage.getItem('squadlogic-available-seasons');
        return saved ? JSON.parse(saved) : ['2025'];
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('squadlogic-theme', theme);

        if (theme === 'club') {
            applyClubTheme(clubColors, clubMode);
        } else {
            removeClubTheme();
        }
    }, [theme, clubColors, clubMode]);

    const updateClubColors = (colors) => {
        const newColors = { ...clubColors, ...colors };
        setClubColors(newColors);
        localStorage.setItem('squadlogic-club-colors', JSON.stringify(newColors));
    };

    const updateClubLogo = (logo) => {
        setClubLogo(logo);
        if (logo) {
            localStorage.setItem('squadlogic-club-logo', logo);
        } else {
            localStorage.removeItem('squadlogic-club-logo');
        }
    };

    const updateClubMode = (mode) => {
        setClubMode(mode);
        localStorage.setItem('squadlogic-club-mode', mode);
    };

    const updateExtractedColors = (colors) => {
        setExtractedColors(colors);
        localStorage.setItem('squadlogic-extracted-colors', JSON.stringify(colors));
    };

    const updateLeagueName = (name) => {
        setLeagueName(name);
        localStorage.setItem('squadlogic-league-name', name);
    };

    const updateCurrentSeason = (season) => {
        setCurrentSeason(season);
        localStorage.setItem('squadlogic-current-season', season);

        // Auto-add to available seasons if not present
        if (!availableSeasons.includes(season)) {
            const newSeasons = [...availableSeasons, season].sort();
            setAvailableSeasons(newSeasons);
            localStorage.setItem('squadlogic-available-seasons', JSON.stringify(newSeasons));
        }
    };

    const addSeason = (season) => {
        if (!availableSeasons.includes(season)) {
            const newSeasons = [...availableSeasons, season].sort();
            setAvailableSeasons(newSeasons);
            localStorage.setItem('squadlogic-available-seasons', JSON.stringify(newSeasons));
        }
    };

    const applyClubTheme = (colors, mode) => {
        const root = document.documentElement;
        root.setAttribute('data-club-mode', mode);

        // CRITICAL FIX: Guard against null/undefined colors object to prevent crash
        if (!colors) {
            console.warn('applyClubTheme called with null colors, falling back to defaults');
            // Create a safe default object
            colors = {
                primaryAccent: '#3b82f6',
                secondaryAccent: '#1e293b',
                background1: '#0f172a',
                background2: '#1e293b'
            };
        }

        // Helper to convert hex to rgb for rgba usage if needed, 
        // but for now we will just use the hex values directly where possible
        // or simple opacity tricks if we had hsl. 
        // Since we have hex, we might need a tiny helper for "glow" (rgba).

        const hexToRgb = (hex) => {
            if (!hex) return null;
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : null;
        };

        // Default Fallbacks (Dark Theme equivalents)
        const defaultPrimary = '#3b82f6';
        const defaultSecondary = '#1e293b';
        const defaultBg1 = '#0f172a';
        const defaultBg2 = '#1e293b';

        const primaryAccent = colors.primaryAccent || defaultPrimary;
        const secondaryAccent = colors.secondaryAccent || defaultSecondary;
        const bg1 = colors.background1 || defaultBg1;
        const bg2 = colors.background2 || defaultBg2;

        const primaryAccentRgb = hexToRgb(primaryAccent);
        const secondaryAccentRgb = hexToRgb(secondaryAccent);

        // Brand Colors (Primary Accent)
        root.style.setProperty('--color-primary', primaryAccent);
        root.style.setProperty('--color-primary-400', primaryAccent);
        root.style.setProperty('--color-primary-600', primaryAccent);
        if (primaryAccentRgb) {
            root.style.setProperty('--color-primary-glow', `rgba(${primaryAccentRgb}, 0.5)`);
        }

        // Backgrounds (Gradient from BG1 to BG2)
        root.style.setProperty('--color-bg-app', bg1);
        root.style.setProperty('--bg-app-gradient', `linear-gradient(135deg, ${bg1} 0%, ${bg2} 100%)`);

        // Surface/Glass (Secondary Accent)
        if (secondaryAccentRgb) {
            root.style.setProperty('--color-bg-surface', `rgba(${secondaryAccentRgb}, 0.7)`);
            root.style.setProperty('--color-bg-surface-hover', `rgba(${secondaryAccentRgb}, 0.9)`);
            root.style.setProperty('--color-bg-glass', `rgba(${secondaryAccentRgb}, 0.5)`);
        } else {
            root.style.setProperty('--color-bg-surface', secondaryAccent);
        }

        // Text Colors based on Mode or Adaptive Contrast
        // We calculate the contrast of the background1 color to determine if we should default to light or dark text
        const adaptiveMode = getContrastMode(colors.background1);

        // If the user has explicitly set a mode, we respect it. 
        // But we can also provide an "adaptive" variable for components that want to be smart.
        // For now, let's stick to the requested "adaptive to user's choices" by defaulting to the contrast mode
        // if the user hasn't explicitly toggled (though we persist the toggle, so maybe we just use the toggle).

        // However, to be truly "adaptive" as requested, we should probably ensure that the text color 
        // has enough contrast against the background.

        const effectiveMode = mode; // Or adaptiveMode if we wanted to force it. 
        // Let's stick to the mode passed in (which is user controlled), but maybe we can set a helper variable.

        if (effectiveMode === 'light') {
            root.style.setProperty('--color-text-primary', '#0f172a');
            root.style.setProperty('--color-text-secondary', '#334155');
            root.style.setProperty('--color-text-muted', '#64748b');
        } else {
            root.style.setProperty('--color-text-primary', '#ffffff');
            root.style.setProperty('--color-text-secondary', '#e2e8f0');
            root.style.setProperty('--color-text-muted', '#94a3b8');
        }

        // Set an adaptive color that ALWAYS contrasts with the background, regardless of the mode setting
        // This can be used by specific components if needed
        root.style.setProperty('--color-text-adaptive', adaptiveMode === 'light' ? '#0f172a' : '#ffffff');
    };

    const removeClubTheme = () => {
        const root = document.documentElement;
        root.removeAttribute('data-club-mode');
        const props = [
            '--color-primary', '--color-primary-400', '--color-primary-600', '--color-primary-glow',
            '--color-bg-app', '--bg-app-gradient', '--color-bg-surface', '--color-bg-surface-hover', '--color-bg-glass',
            '--color-text-primary', '--color-text-secondary', '--color-text-muted'
        ];
        props.forEach(p => root.style.removeProperty(p));
    };

    return (
        <ThemeContext.Provider value={{
            theme,
            setTheme,
            clubColors,
            updateClubColors,
            clubLogo,
            updateClubLogo,
            clubMode,
            updateClubMode,
            extractedColors,
            updateExtractedColors,
            leagueName,
            updateLeagueName,
            currentSeason,
            updateCurrentSeason,
            availableSeasons,
            addSeason
        }}>
            {children}
        </ThemeContext.Provider>
    );
};
