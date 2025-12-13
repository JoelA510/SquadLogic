import React, { useState } from 'react';
import Button from '../components/ui/Button.jsx';
import { useNavigate } from 'react-router-dom';
import { MapPin, Plus, Edit2, Trash2, X, Check, Power } from 'lucide-react';
import { useImport } from '../contexts/ImportContext.jsx';

export default function FieldManagementPage() {
    const navigate = useNavigate();
    const { importedFields } = useImport();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingField, setEditingField] = useState(null);

    // Default form state
    const [formData, setFormData] = useState({
        name: '',
        type: 'Grass',
        size: '11v11',
        priority: 1,
        active: true
    });

    const [fields, setFields] = useState([
        { id: 1, name: 'Main Complex - Field 1', type: 'Grass', size: '11v11', priority: 5, active: true },
        { id: 2, name: 'Main Complex - Field 2', type: 'Turf', size: '11v11', priority: 5, active: true },
        { id: 3, name: 'North Park - Field A', type: 'Grass', size: '9v9', priority: 3, active: true },
    ]);

    // Use imported fields if available but merge with local state structure if possible
    // For specific UI testing of new fields, we rely on local 'fields' state if imported is empty
    // or map imported fields to include defaults.
    const displayFields = importedFields?.data?.length > 0
        ? importedFields.data.map((f, i) => ({
            id: i,
            name: f['Field Name'] || f.Name || `Field ${i + 1}`,
            type: f.Type || 'Unknown',
            size: f.Size || 'Unknown',
            priority: f.Priority ? parseInt(f.Priority) : 1,
            active: f.Active !== 'false'
        }))
        : fields;

    const handleEdit = (field) => {
        setEditingField(field);
        setFormData({
            name: field.name,
            type: field.type,
            size: field.size,
            priority: field.priority || 1,
            active: field.active !== false
        });
        setIsModalOpen(true);
    };

    const handleAddNew = () => {
        setEditingField(null);
        setFormData({
            name: '',
            type: 'Grass',
            size: '11v11',
            priority: 1,
            active: true
        });
        setIsModalOpen(true);
    };

    const handleSave = () => {
        if (editingField) {
            setFields(fields.map(f => f.id === editingField.id ? { ...f, ...formData } : f));
        } else {
            setFields([...fields, { id: Date.now(), ...formData }]);
        }
        setIsModalOpen(false);
    };

    return (
        <div className="animate-fadeIn space-y-8 relative">
            <div className="flex justify-between items-start mb-8">
                <div>
                    <h1 className="text-3xl font-display font-bold text-text-primary mb-2">Field Management</h1>
                    <p className="text-text-secondary">Configure fields, priorities, and practice slots.</p>
                </div>
                <Button variant="primary" className="flex items-center gap-2" onClick={handleAddNew}>
                    <Plus size={18} /> Add Field
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {displayFields.map((field) => (
                    <div key={field.id} className={`bg-bg-surface border ${field.active ? 'border-border-subtle' : 'border-red-900/30 bg-red-900/5'} rounded-xl p-6 hover:bg-bg-surface-hover transition-colors group relative`}>
                        {!field.active && (
                            <div className="absolute top-4 right-4 text-xs font-bold text-red-500 bg-red-900/20 px-2 py-1 rounded">INACTIVE</div>
                        )}

                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 bg-blue-500/20 rounded-lg text-blue-400">
                                <MapPin size={24} />
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => handleEdit(field)}
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
                        <div className="flex flex-wrap gap-2 text-sm text-text-secondary mt-2">
                            <span className="px-2 py-0.5 bg-bg-surface rounded-full border border-border-subtle">{field.type}</span>
                            <span className="px-2 py-0.5 bg-bg-surface rounded-full border border-border-subtle">{field.size}</span>
                            <span className="px-2 py-0.5 bg-blue-900/20 text-blue-300 rounded-full border border-blue-800/30">Priority: {field.priority}</span>
                        </div>
                    </div>
                ))}

                {/* Add New Card */}
                <button
                    onClick={handleAddNew}
                    className="border-2 border-dashed border-border-subtle rounded-xl p-6 flex flex-col items-center justify-center text-text-muted hover:text-text-primary hover:border-border-highlight hover:bg-bg-surface transition-all min-h-[200px]"
                >
                    <Plus size={48} className="mb-4 opacity-50" />
                    <span className="font-semibold">Add New Field</span>
                </button>
            </div>

            {/* Edit Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
                    <div className="bg-bg-app border border-border-subtle rounded-xl p-6 w-full max-w-md shadow-2xl animate-scaleIn">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-xl font-bold text-text-primary">
                                {editingField ? 'Edit Field' : 'Add New Field'}
                            </h2>
                            <button onClick={() => setIsModalOpen(false)} className="text-text-muted hover:text-text-primary">
                                <X size={24} />
                            </button>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-text-secondary mb-1">Field Name</label>
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-text-secondary mb-1">Type</label>
                                    <select
                                        value={formData.type}
                                        onChange={e => setFormData({ ...formData, type: e.target.value })}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                                    >
                                        <option>Grass</option>
                                        <option>Turf</option>
                                        <option>Indoor</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-text-secondary mb-1">Size</label>
                                    <select
                                        value={formData.size}
                                        onChange={e => setFormData({ ...formData, size: e.target.value })}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                                    >
                                        <option>11v11</option>
                                        <option>9v9</option>
                                        <option>7v7</option>
                                        <option>5v5</option>
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-text-secondary mb-1">Priority (1-10)</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="10"
                                        value={formData.priority}
                                        onChange={e => setFormData({ ...formData, priority: parseInt(e.target.value) })}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                                    />
                                </div>
                                <div className="flex items-end mb-2">
                                    <label className="flex items-center gap-3 cursor-pointer">
                                        <div className={`w-12 h-6 rounded-full p-1 transition-colors ${formData.active ? 'bg-brand-500' : 'bg-bg-surface border border-border-subtle'}`}>
                                            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${formData.active ? 'translate-x-6' : 'translate-x-0'}`} />
                                        </div>
                                        <span className="text-sm font-medium text-text-primary">Active</span>
                                        <input
                                            type="checkbox"
                                            className="hidden"
                                            checked={formData.active}
                                            onChange={e => setFormData({ ...formData, active: e.target.checked })}
                                        />
                                    </label>
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end gap-3 mt-8">
                            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
                                Cancel
                            </Button>
                            <Button variant="primary" onClick={handleSave} className="flex items-center gap-2">
                                <Check size={18} /> Save Field
                            </Button>
                        </div>
                    </div>
                </div>
            )}

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
