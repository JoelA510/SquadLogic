/**
 * The Exports page says, in a demo, that the data is placeholder data that resets when the
 * demo ends (the D4 import notice's voice), and says nothing of the sort outside one.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ExportsPage from '../frontend/src/pages/ExportsPage.jsx';

const mocks = vi.hoisted(() => ({ organization: null }));

vi.mock('../frontend/src/hooks/useDashboardData.js', () => ({
  useDashboardData: () => ({
    team: { teams: [], summary: null },
    practice: { scheduleAssignments: [] },
    game: { assignments: [] },
    loading: { team: false, practice: false, game: false },
    error: null,
    errors: { team: null, practice: null, game: null },
  }),
}));
vi.mock('../frontend/src/contexts/OrganizationContext.jsx', () => ({
  useOrganization: () => ({ currentOrganization: mocks.organization }),
}));
vi.mock('../frontend/src/components/OutputGenerationPanel.jsx', () => ({
  default: () => <div>panel</div>,
}));
vi.mock('../frontend/src/components/chrome/Page.jsx', () => ({
  default: ({ children }) => <main>{children}</main>,
}));
vi.mock('../frontend/src/components/chrome/PageHeader.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/lib/supabaseClient.js', () => ({ supabase: {} }));

describe('ExportsPage demo note', () => {
  it('shows the placeholder-data line in a demo', () => {
    mocks.organization = { id: 'o', demo_expires_at: '2099-01-01T00:00:00Z' };
    render(<ExportsPage />);
    expect(screen.getByTestId('demo-exports-note')).toHaveTextContent(
      'placeholder data only, and it resets when the demo ends'
    );
  });

  it('POSITIVE CONTROL: a real organization sees no such line', () => {
    mocks.organization = { id: 'o', demo_expires_at: null };
    render(<ExportsPage />);
    expect(screen.getByText('panel')).toBeInTheDocument();
    expect(screen.queryByTestId('demo-exports-note')).toBeNull();
  });
});
