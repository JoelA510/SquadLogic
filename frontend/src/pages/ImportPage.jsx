import React from 'react';
import ImportPanel from '../components/ImportPanel.jsx';
import { useNavigate } from 'react-router-dom';

export default function ImportPage() {
  const navigate = useNavigate();

  // The applied import is already in `ImportContext`; continuing only moves on.
  const handleContinue = () => navigate('/teams');

  return (
    <div className="animate-fadeIn">
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold text-text-primary mb-2">Data Import</h1>
        <p className="text-text-muted">
          Upload player and coach data from GotSport CSVs to initialize the season.
        </p>
      </div>
      <ImportPanel onImport={handleContinue} />
    </div>
  );
}
