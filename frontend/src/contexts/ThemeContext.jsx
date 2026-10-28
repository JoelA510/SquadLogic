import React, { createContext, useContext, useEffect, useState } from 'react';

/**
 * App settings context.
 *
 * Drives the Lightning-class light/dark theme: `themeMode` is persisted to
 * localStorage (`sl-theme`) and reflected as `data-theme` on <html>, which the
 * `[data-theme='dark']` token block in index.css responds to. Light is the
 * default; no attribute is set for light so the :root tokens apply as-is.
 *
 * The league / timezone fields are legacy state retained from the
 * pre-redesign provider; OrganizationContext is the canonical source for
 * org/season data and these fields are slated for removal. The free-text season label that
 * lived here went with its control (Phase E3b): a season's name is written by the audited season
 * RPCs and the selected season is stored by id (`utils/seasonSelection.js`).
 */
const ThemeContext = createContext(null);

const THEME_STORAGE_KEY = 'sl-theme';

function getStoredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'dark' ? 'dark' : 'light';
}

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

export const ThemeProvider = ({ children }) => {
  const [themeMode, setThemeMode] = useState(getStoredTheme);

  useEffect(() => {
    if (themeMode === 'dark') {
      document.documentElement.dataset.theme = 'dark';
    } else {
      delete document.documentElement.dataset.theme;
    }
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  const toggleThemeMode = () => {
    setThemeMode((mode) => (mode === 'dark' ? 'light' : 'dark'));
  };

  const [leagueName, setLeagueName] = useState(() => {
    return localStorage.getItem('squadlogic-league-name') || 'My Youth League';
  });

  const [timezone, setTimezone] = useState(() => {
    return localStorage.getItem('squadlogic-timezone') || 'UTC';
  });

  const updateLeagueName = (name) => {
    setLeagueName(name);
    localStorage.setItem('squadlogic-league-name', name);
  };

  const updateTimezone = (tz) => {
    setTimezone(tz);
    localStorage.setItem('squadlogic-timezone', tz);
  };

  return (
    <ThemeContext.Provider
      value={{
        themeMode,
        setThemeMode,
        toggleThemeMode,
        leagueName,
        updateLeagueName,
        timezone,
        updateTimezone,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};
