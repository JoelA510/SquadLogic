import React, { useState } from 'react';
import Button from '../components/ui/Button';
import { useNavigate } from 'react-router-dom';
import { MapPin, Plus, Edit2, Trash2 } from 'lucide-react';
import { useImport } from '../contexts/ImportContext';

export default function FieldManagementPage() {
    const navigate = useNavigate();
    const { importedFields } = useImport();
    const [fields, setFields] = useState([
        { id: 1, name: 'Main Complex - Field 1', type: 'Grass', size: '11v11' },
        { id: 2, name: 'Main Complex - Field 2', type: 'Turf', size: '11v11' },
        { id: 3, name: 'North Park - Field A', type: 'Grass', size: '9v9' },
    ]);

    // Use imported fields if available
    const displayFields = importedFields?.data?.length > 0
        ? importedFields.data.map((f, i) => ({ id: i, name: f['Field Name'] || f.Name || `Field ${i + 1}`, type: f.Type || 'Unknown', size: f.Size || 'Unknown' }))
        : fields;

    return (
        <div className="animate-fadeIn space-y-8">
            <div className="flex justify-between items-start mb-8">
                <div>
                    <h1 className="text-3xl font-display font-bold text-text-primary mb-2">Field Management</h1>
                    <p className="text-text-secondary">Configure fields, priorities, and practice slots.</p>
                </div>
                <Button variant="primary" className="flex items-center gap-2">
                    <Plus size={18} /> Add Field
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {displayFields.map((field) => (
                    <div key={field.id} className="bg-bg-surface border border-border-subtle rounded-xl p-6 hover:bg-bg-surface-hover transition-colors group">
                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 bg-blue-500/20 rounded-lg text-blue-400">
                                <MapPin size={24} />
                            </div>
                            <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    aria-label={`Edit ${field.name}`}
                                    className="p-2 hover:bg-bg-surface-hover rounded-lg text-text-muted hover:text-blue-400 transition-colors"
                                >
                                    <Edit2 size={16} />
                                </button>
                                <button
                                    aria-label={`Delete ${field.name}`}
                                    className="p-2 hover:bg-bg-surface-hover rounded-lg text-text-muted hover:text-red-400 transition-colors"
                                >
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>
                        <h2 className="text-xl font-bold text-text-primary mb-1">{field.name}</h2>
                        <div className="flex gap-2 text-sm text-text-secondary">
                            <span className="px-2 py-0.5 bg-bg-surface rounded-full border border-border-subtle">{field.type}</span>
                            <span className="px-2 py-0.5 bg-bg-surface rounded-full border border-border-subtle">{field.size}</span>
                        </div>
                    </div>
                ))}

                {/* Add New Card */}
                <button className="border-2 border-dashed border-border-subtle rounded-xl p-6 flex flex-col items-center justify-center text-text-muted hover:text-text-primary hover:border-border-highlight hover:bg-bg-surface transition-all min-h-[200px]">
                    <Plus size={48} className="mb-4 opacity-50" />
                    <span className="font-semibold">Add New Field</span>
                </button>
            </div>

            <div className="flex justify-end pt-8 border-t border-border-subtle">
                <Button
                    variant="secondary"
                    onClick={() => navigate('/schedule/practice')}
                >
                    Proceed to Practice Scheduling
                </Button>
            </div>
        </div>
    );
}
