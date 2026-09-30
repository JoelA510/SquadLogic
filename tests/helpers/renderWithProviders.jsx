import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { AuthProvider } from '../../frontend/src/contexts/AuthContext.jsx';
import { OrganizationProvider } from '../../frontend/src/contexts/OrganizationContext.jsx';
import { ImportProvider } from '../../frontend/src/contexts/ImportContext.jsx';
import { ThemeProvider } from '../../frontend/src/contexts/ThemeContext.jsx';
import { supabaseReady } from '../../frontend/src/lib/supabaseClient.js';
import { makeOrganization, makeUser } from '../factories/index.js';

/**
 * RTL `render()` wrapped with SquadLogic's canonical provider chain.
 *
 * Provider order mirrors `frontend/src/App.jsx` exactly:
 *   BrowserRouter → AuthProvider → OrganizationProvider → ImportProvider → ThemeProvider
 *
 * Differences from App.jsx (intentional):
 * - `<BrowserRouter>` becomes `<MemoryRouter>` to avoid jsdom URL issues.
 * - `<ErrorBoundary>` and `<OfflineGuard>` are omitted. Tests that need to
 *   assert error-boundary or offline behavior wrap manually.
 *
 * Async, like `frontend/src/main.jsx`: it renders only once `supabaseReady`
 * has settled. In mock mode `supabase` is assigned when the lazily imported
 * mock client has loaded, and the providers' effects read it on mount, so a
 * render before that reads `undefined` (see `lib/supabaseClient.js`). Await it.
 *
 * @param {React.ReactElement} ui
 * @param {{
 *   user?: any,
 *   organization?: any,
 *   route?: string,
 * } & import('@testing-library/react').RenderOptions} [options]
 * @returns {Promise<import('@testing-library/react').RenderResult>}
 */
export async function renderWithProviders(ui, options = {}) {
  const {
    user = makeUser(),
    organization = makeOrganization(),
    route = '/',
    ...rtlOptions
  } = options;

  sessionStorage.setItem('squadlogic_mock_user', JSON.stringify(user));
  if (organization?.id) localStorage.setItem('squadlogic_active_org', organization.id);

  function Wrapper({ children }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <OrganizationProvider>
            <ImportProvider>
              <ThemeProvider>{children}</ThemeProvider>
            </ImportProvider>
          </OrganizationProvider>
        </AuthProvider>
      </MemoryRouter>
    );
  }

  await supabaseReady;
  return render(ui, { wrapper: Wrapper, ...rtlOptions });
}
