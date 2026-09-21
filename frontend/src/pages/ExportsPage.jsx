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
  // `error` too. Without it a refused `scheduler_runs` read reached this page
  // as `team.teams === undefined`, and the panel below offered to export an
  // empty roster CSV as though the season genuinely had no teams in it -- the
  // one failure mode where a silent empty is worse than no page at all,
  // because the operator can act on it and ship the empty file.
  //
  // What the banner does is tell them. It does NOT gate the export: the panel
  // below still receives `teams={team?.teams || []}` and stays enabled, so an
  // operator who reads the banner and clicks anyway still ships a zero-row
  // CSV. Disabling generation on a failed read is a behaviour change to the
  // output path rather than an error surface, so it is named in the PR and
  // not smuggled in here.
  const { team, practice, game, error: dataError } = useDashboardData();

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
        />
      </div>
    </Page>
  );
}
