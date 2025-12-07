import React from 'react';

export default function ProgramOverview({ programs, onSelectProgram, selectedProgramId }) {
    return (
        <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border-subtle bg-bg-surface-hover">
                <h3 className="font-bold text-text-primary">Program Overview</h3>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <thead>
                        <tr className="border-b border-border-subtle text-text-secondary">
                            <th className="p-4 font-medium">Program</th>
                            <th className="p-4 font-medium">Players</th>
                            <th className="p-4 font-medium">Est. Teams</th>
                            <th className="p-4 font-medium">Avg Roster</th>
                            <th className="p-4 font-medium">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        {programs.map(program => (
                            <tr
                                key={program.id}
                                onClick={() => onSelectProgram(program.id)}
                                className={`cursor-pointer transition-colors ${selectedProgramId === program.id
                                        ? 'bg-blue-500/10 border-l-4 border-l-blue-500'
                                        : 'hover:bg-bg-surface-hover border-l-4 border-l-transparent'
                                    }`}
                            >
                                <td className="p-4 font-medium text-text-primary">{program.name}</td>
                                <td className="p-4 text-text-secondary">{program.playerCount}</td>
                                <td className="p-4 text-text-secondary">{program.estimatedTeams}</td>
                                <td className="p-4 text-text-secondary">{program.avgRosterSize}</td>
                                <td className="p-4">
                                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-500">
                                        Ready
                                    </span>
                                </td>
                            </tr>
                        ))}
                        {programs.length === 0 && (
                            <tr>
                                <td colSpan="5" className="p-8 text-center text-text-muted">
                                    No programs found. Import data to see overview.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
