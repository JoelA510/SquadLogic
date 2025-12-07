import React from 'react';
import ImportPanel from '../components/ImportPanel';
import { useImport } from '../contexts/ImportContext';
import { useNavigate } from 'react-router-dom';

export default function ImportPage() {
    const { setImportedData } = useImport();
    const navigate = useNavigate();

    const handleImport = (data) => {
        console.log('Imported data:', data);
        setImportedData(data);
        navigate('/teams');
    };

    return (
        <div className="animate-fadeIn">
            <div className="mb-8">
                <h1 className="text-3xl font-display font-bold text-white mb-2">Data Import</h1>
                <p className="text-white/60">Upload player and coach data from GotSport CSVs to initialize the season.</p>
            </div>
            <ImportPanel onImport={handleImport} />
        </div>
    );
}
