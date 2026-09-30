# Test Helpers & Factories

## Overview

Shared test infrastructure exists to reduce per-test boilerplate and keep test data/mocks deterministic. The goal is leverage, not coverage: tests should stay behavior-equivalent while replacing repeated inline setup with stable helper/factory patterns.

## `tests/factories/`

Factories provide deterministic defaults with explicit override support.

- Use factory defaults for stable, reusable shapes.
- Override only fields required by the test case.
- Treat `supabase/migrations/` as the schema source of truth when factory fields drift.

### Usage examples

```js
import { makeUser, makeOrganization, makeOrganizationMember } from '../factories/index.js';

const user = makeUser({ id: 'user-42', email: 'coach@example.com' });
const org = makeOrganization({ id: 'org-42', name: 'North Club' });
const member = makeOrganizationMember({
  organization_id: org.id,
  profile_id: user.id,
  role: 'admin',
});
```

```js
import { makeTeam, makePracticeAssignment } from '../factories/index.js';

const team = makeTeam({ id: 'team-9', name: 'Falcons' });
const assignment = makePracticeAssignment({ team_id: team.id });
```

Do **not** add:

- faker/randomized data,
- random UUID generators,
- date math in defaults.

## `tests/helpers/`

### `createChainMock`

Use for Supabase fluent chains (`select().eq().order()` etc.) when the test only needs a resolved `{ data, error }` payload.

```js
import { createChainMock } from '../helpers/index.js';

vi.mocked(supabase.from).mockImplementation((table) => {
  if (table === 'organization_members') {
    return createChainMock({ data: [member], error: null });
  }
  return createChainMock({ data: [], error: null });
});
```

Guidance:

- Prefer a fresh chain per call path to avoid cross-test coupling.
- Reuse within one test only when the resolved value is intentionally shared.

### `renderWithProviders`

Use when a test requires app-level providers in the canonical app order.
It is async: like `main.jsx`, it renders only once `supabaseReady` has
settled, so the providers never read an unassigned mock client. Await it.

```jsx
import { renderWithProviders } from '../helpers/index.js';
import { makeUser, makeOrganization } from '../factories/index.js';

await renderWithProviders(<MyComponent />, {
  user: makeUser({ id: 'u-1' }),
  organization: makeOrganization({ id: 'org-1' }),
  route: '/dashboard',
});
```

### Auth-context hoisted mock idiom (not a runtime helper)

Vitest hoists `vi.mock()` factories before imports, so auth-context mocks that need mutable per-test state must remain file-local.

```js
const authState = vi.hoisted(() => ({ user: null }));

vi.mock('@/contexts/AuthContext.jsx', async () => {
  const React = await import('react');
  const { createContext, useContext, useState, useEffect } = React;
  const AuthContext = createContext({});

  const useAuth = () => useContext(AuthContext);

  const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(authState.user);
    useEffect(() => {
      setUser(authState.user);
    }, []);

    return React.createElement(
      AuthContext.Provider,
      { value: { user, session: user ? { user } : null, loading: false } },
      children
    );
  };

  return { useAuth, AuthProvider };
});
```

For mid-test transitions (login/logout), mutate `authState.user` before re-rendering or remounting.

### `seedMockDb`

Use in Playwright-BDD steps via `page.evaluate` to seed the in-browser mock database deterministically.

### `mockSupabaseShape`

Use as the default object shape for `vi.mock('@/lib/supabaseClient', ...)`, then customize behavior per-test.

## `tests/setup.js`

Current shared polyfills include:

- `ResizeObserver`
- `IntersectionObserver`
- `matchMedia`
- `scrollIntoView`

Add new polyfills only when both are true:

1. production code uses the API,
2. tests exercise the API.

## Migration patterns

Canonical representative migrations:

- `tests/useDashboardData.test.js`
- `tests/authIntegration.test.jsx`
- `tests/usePermission.test.js`
- `tests/teamPersistencePanel.test.js` (path drift from planned `.jsx` target)
- `tests/teamGeneration.test.js`

High-leverage before/after shape:

```js
// before
supabase.from.mockImplementation((table) => {
  if (table === 'organization_members') {
    return {
      select: vi
        .fn()
        .mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [row], error: null }) }),
    };
  }
  return {
    select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [], error: null }) }),
  };
});

// after
supabase.from.mockImplementation((table) => {
  if (table === 'organization_members') return createChainMock({ data: [row], error: null });
  return createChainMock({ data: [], error: null });
});
```

## What NOT to add

- Faker/randomized fixtures.
- Global `resetAllMocks` policy.
- Provider variants without a concrete consumer.
- Timezone/locale global locks.
- Global fetch mocks.

## Verification checklist for future test PRs

- Factory used for repeated data literals where practical.
- Shared helper used for repeated Supabase/provider setup where practical.
- Existing assertions preserved unless behavior intentionally changed.
- Coverage not regressed by factory defaults (use explicit overrides when needed).
- Test-only changes remain isolated from production bundles.
