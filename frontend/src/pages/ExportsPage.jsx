import React from 'react';
import { Download } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import OutputGenerationPanel from '../components/OutputGenerationPanel.jsx';
import { useDashboardData } from '../hooks/useDashboardData.js';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { supabase } from '../lib/supabaseClient.js';

/**
 * Exports — roster/schedule CSV generation and coach welcome emails,
 * reusing the output-generation panel from the pipeline workflow.
 */
export default function ExportsPage() {
  // `errors` too, and that is the deferral #427 named closing.
  //
  // The banner told the operator that a read had failed; it did not stop them
  // acting on what the failure left behind. `teams={team?.teams || []}` turns
  // a refused `scheduler_runs` read into "this season has no teams", the
  // panel stayed enabled, and an operator who read the banner and clicked
  // anyway shipped a zero-row CSV to a league.
  //
  // The fix is not a `disabled` flag computed here. `|| []` is the line that
  // makes a failed read and an empty season identical, and the panel is what
  // knows which of its inputs feeds which artifact -- so the panel is given
  // the distinction (`sourceErrors`) and decides. Per source, because the
  // hook's single `error` string covers all of them: a refused
  // `game_assignments` read is a reason not to export a schedule and not a
  // reason to stop writing coach emails, which never mention a game.
  const { team, practice, game, loading, error: dataError, errors } = useDashboardData();

  return (
    <Page
      header={
        <PageHeader
          title="Exports"
          subtitle="Generate roster and schedule CSVs, store them, and prepare coach welcome emails."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--accent-teal)' }}>
              <Download size={20} aria-hidden="true" />
            </span>
          }
        />
      }
    >
      <div style={{ maxWidth: 860 }}>
        <DataErrorBanner message={dataError} className="mb-4" />
        <OutputGenerationPanel
          teams={team?.teams || []}
          teamSummary={team?.summary || null}
          practiceAssignments={practice?.assignments || []}
          gameAssignments={game?.assignments || []}
          supabaseClient={supabase}
          sourceErrors={errors}
          sourceLoading={loading}
        />
      </div>
    </Page>
  );
}
