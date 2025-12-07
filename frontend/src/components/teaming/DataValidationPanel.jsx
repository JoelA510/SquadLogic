import React from 'react';
import { AlertTriangle, CheckCircle, XCircle } from 'lucide-react';

export default function DataValidationPanel({ errors }) {
    if (!errors || errors.length === 0) {
        return (
            <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-6 flex items-center gap-4">
                <div className="p-3 bg-green-500/10 rounded-full text-green-500">
                    <CheckCircle size={24} />
                </div>
                <div>
                    <h3 className="font-bold text-green-500">Data Validation Passed</h3>
                    <p className="text-sm text-text-secondary">No critical errors found in the imported dataset.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
            <div className="p-4 border-b border-border-subtle bg-bg-surface-hover flex justify-between items-center">
                <h3 className="font-bold text-text-primary flex items-center gap-2">
                    <AlertTriangle size={18} className="text-amber-500" />
                    Data Validation Issues ({errors.length})
                </h3>
            </div>
            <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-bg-surface">
                        <tr className="border-b border-border-subtle text-text-secondary">
                            <th className="p-4 font-medium">Type</th>
                            <th className="p-4 font-medium">Description</th>
                            <th className="p-4 font-medium">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {errors.map((error, idx) => (
                            <tr key={idx} className="border-b border-border-subtle last:border-0">
                                <td className="p-4">
                                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 capitalize">
                                        {error.type.replace('_', ' ')}
                                    </span>
                                </td>
                                <td className="p-4 text-text-primary">{error.message}</td>
                                <td className="p-4">
                                    <button className="text-blue-400 hover:text-blue-300 text-xs font-medium">
                                        Review
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
