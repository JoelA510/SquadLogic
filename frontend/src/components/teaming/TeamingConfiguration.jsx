import React from 'react';
import Button from '../ui/Button';

export default function TeamingConfiguration({ program, config, onUpdate }) {
    if (!program) return (
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-8 text-center text-text-muted h-full flex items-center justify-center">
            Select a program to configure
        </div>
    );

    const handleChange = (field, value) => {
        const intValue = parseInt(value);
        onUpdate(program.id, { [field]: isNaN(intValue) ? null : intValue });
    };

    return (
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 h-full">
            <h3 className="font-bold text-text-primary mb-1">{program.name} Settings</h3>
            <p className="text-sm text-text-secondary mb-6">Configure team generation rules.</p>

            <div className="space-y-6">
                <div>
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                        Target Team Size
                    </label>
                    <input
                        type="number"
                        className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                        value={config?.targetTeamSize || 12}
                        onChange={(e) => handleChange('targetTeamSize', e.target.value)}
                    />
                    <p className="text-xs text-text-muted mt-1">Ideal number of players per team.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-2">
                            Min Roster
                        </label>
                        <input
                            type="number"
                            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            value={config?.minRosterSize || 10}
                            onChange={(e) => handleChange('minRosterSize', e.target.value)}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-text-secondary mb-2">
                            Max Roster
                        </label>
                        <input
                            type="number"
                            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            value={config?.maxRosterSize || 14}
                            onChange={(e) => handleChange('maxRosterSize', e.target.value)}
                        />
                    </div>
                </div>

                <div className="pt-4 border-t border-border-subtle">
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                        Override Team Count
                    </label>
                    <div className="flex gap-2">
                        <input
                            type="number"
                            placeholder="Auto"
                            className="flex-1 bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            value={config?.teamCountOverride || ''}
                            onChange={(e) => handleChange('teamCountOverride', e.target.value)}
                        />
                        <Button
                            variant="secondary"
                            onClick={() => handleChange('teamCountOverride', '')}
                            disabled={!config?.teamCountOverride}
                        >
                            Reset
                        </Button>
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                        Force a specific number of teams (currently estimated: {program.estimatedTeams})
                    </p>
                </div>

                <div className="pt-4 border-t border-border-subtle">
                    <label className="block text-sm font-medium text-text-secondary mb-2">
                        Random Seed (Optional)
                    </label>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            placeholder="e.g. 12345"
                            className="w-full bg-bg-base border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                            value={config?.seed || ''}
                            onChange={(e) => onUpdate(program.id, { seed: e.target.value })}
                        />
                        <Button
                            variant="secondary"
                            onClick={() => onUpdate(program.id, { seed: '' })}
                            disabled={!config?.seed}
                        >
                            Clear
                        </Button>
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                        Use the same seed to reproduce specific team assignments.
                    </p>
                </div>
            </div>
        </div>
    );
}
