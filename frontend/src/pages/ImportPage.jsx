import React from 'react';
import ImportPanel from '../components/ImportPanel.jsx';
import { useNavigate } from 'react-router-dom';
import { useOrganization } from '../contexts/OrganizationContext.jsx';

export default function ImportPage() {
  const navigate = useNavigate();
  const { currentSeasonSetting } = useOrganization();
  // Players and coaches belong to one season (E3b): an import adds to the season shown in the header,
  // and a draft takes registrations before it is activated.
  const intoDraft = currentSeasonSetting?.status === 'draft';

  // The applied import is already in `ImportContext`; continuing only moves on.
  const handleContinue = () => navigate('/teams');

  return (
    <div className="animate-fadeIn">
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold text-text-primary mb-2">Data Import</h1>
        <p className="text-text-muted">
          Upload player and coach data from GotSport CSVs to initialize the season.
        </p>
        {intoDraft && (
          <p className="mt-2 text-sm text-text-secondary" data-testid="import-season-note">
            {`Importing into the draft season "${currentSeasonSetting.name}". The active season's players and coaches are not changed.`}
          </p>
        )}
      </div>
      <ImportPanel onImport={handleContinue} />
    </div>
  );
}
