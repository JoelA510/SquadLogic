import { useEffect, useState } from 'react';
import { Outlet, useLocation, matchPath } from 'react-router-dom';
import TopBar from '../components/chrome/TopBar.jsx';
import SideNav from '../components/chrome/SideNav.jsx';
import SeasonStatusNotice from '../components/chrome/SeasonStatusNotice.jsx';
import { FULL_BLEED_ROUTES } from '../constants/navigation.js';

const COLLAPSE_KEY = 'sl-nav-collapsed';

/**
 * Lightning-class app shell: top bar, collapsible side nav, and the routed page in the main area.
 * Grid layout comes from `.app` in styles/chrome.css.
 */
export default function DashboardLayout() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const isFullBleed = [...FULL_BLEED_ROUTES].some((pattern) =>
    matchPath(pattern, location.pathname)
  );

  return (
    <div className={`app ${collapsed ? 'nav-collapsed' : ''}`}>
      <TopBar onToggleNav={() => setMobileNavOpen((open) => !open)} />
      <SideNav
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
      <div className="main">
        {isFullBleed ? (
          <Outlet />
        ) : (
          // Legacy scroll wrapper: pre-redesign pages expect outer padding
          // and a page-level scroll context.
          <main className="flex-1 p-4 md:p-8 overflow-y-auto">
            <div className="max-w-7xl mx-auto">
              <SeasonStatusNotice />
              <Outlet />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
