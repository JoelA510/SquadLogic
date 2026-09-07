import React, { useState } from 'react';
import Button from '../components/ui/Button.jsx';
import { MapPin, Plus, Edit2, Trash2, X, Check } from 'lucide-react';
import { useFields } from '../hooks/useFields.js';
import { logger } from '../lib/logger.js';

const MONTH_MARKERS = [
  { key: 'august', label: 'Aug' },
  { key: 'september', label: 'Sep' },
  { key: 'october', label: 'Oct' },
  { key: 'november', label: 'Nov' },
];

function hasMonthToken(profile, monthKey) {
  const value = `${profile?.blackout_months || ''} ${profile?.month_indicators || ''}`;
  const short = monthKey.slice(0, 3);
  return new RegExp(`\\b(${monthKey}|${short})\\b`, 'i').test(value);
}

function badgeClass() {
  return 'inline-flex items-center px-2 py-0.5 rounded-full border border-border-subtle text-xs text-text-primary bg-bg-app';
}

export default function FieldManagementPage() {
  const {
    locations,
    fields,
    availabilityProfiles,
    loading,
    addLocation,
    addField,
    updateField,
    deleteField,
  } = useFields();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingField, setEditingField] = useState(null);
  const [isAddingLocation, setIsAddingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState('');

  // Default form state
  const [formData, setFormData] = useState({
    location_id: '',
    name: '',
    surface_type: 'Grass',
    size: '11v11',
    supports_halves: false,
    priority_rating: 1,
    active: true,
  });

  const handleEdit = (field) => {
    setEditingField(field);
    setFormData({
      location_id: field.location_id,
      name: field.name,
      surface_type: field.surface_type || 'Grass',
      size: field.size || '11v11',
      supports_halves: field.supports_halves || false,
      priority_rating: field.priority_rating || 1,
      active: field.active !== false,
    });
    setIsAddingLocation(false);
    setIsModalOpen(true);
  };

  const handleAddNew = () => {
    setEditingField(null);
    setFormData({
      location_id: locations.length > 0 ? locations[0].id : '',
      name: '',
      surface_type: 'Grass',
      size: '11v11',
      supports_halves: false,
      priority_rating: 1,
      active: true,
    });
    setIsAddingLocation(locations.length === 0);
    setNewLocationName('');
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    logger.log('[DEBUG] [FieldManagementPage] handleSave formData:', formData);
    try {
      let finalLocationId = formData.location_id;

      if (isAddingLocation && newLocationName.trim()) {
        const newLoc = await addLocation(newLocationName);
        finalLocationId = newLoc.id;
      }

      if (!finalLocationId) {
        alert('Please select or create a location.');
        return;
      }

      const fieldPayload = {
        ...formData,
        location_id: finalLocationId,
      };

      if (editingField) {
        await updateField(editingField.id, fieldPayload);
      } else {
        await addField(fieldPayload);
      }
      setIsModalOpen(false);
      logger.log('[DEBUG] [FieldManagementPage] Save complete');
    } catch (err) {
      logger.error('Save failed', err);
      alert('Failed to save field: ' + err.message);
    }
  };

  const handleDelete = async (field) => {
    if (!window.confirm(`Are you sure you want to delete ${field.name}?`)) return;
    try {
      const attempt = await deleteField(field.id);
      if (attempt?.deleted) return;

      // **The RPC refused because the ground is booked, and it said what is
      // on it.** Before the guard existed this delete cascaded the field's
      // slots away, left its assigned games without a venue and left its
      // practice assignments pointing at a row that no longer existed --
      // silently. Showing the operator the count and what would happen to each
      // kind is the whole point of the refusal; swallowing it here would put
      // the silence back one level up.
      //
      // `window.confirm`/`alert` match what the rest of this page already
      // uses. The proper consequence preview is 8.4 PR 3's surface.
      const affected = attempt.affected ?? [];
      const byOutcome = affected.reduce((acc, row) => {
        acc[row.disposition] = (acc[row.disposition] || 0) + 1;
        return acc;
      }, /** @type {Record<string, number>} */ ({}));
      // **"Destroyed" and "left without a venue" are different losses**, and
      // which one a booking suffers depends on the row rather than its table:
      // a scheduled game is destroyed with its slot, while a free-standing
      // assignment survives venueless. The RPC works that out per row and this
      // just counts the words, so the prompt cannot promise a survival the
      // database is not going to deliver.
      const destroyed = byOutcome.deleted ?? 0;
      const unassigned = byOutcome.unassigned ?? 0;
      const proceed = window.confirm(
        `${field.name} has ${attempt.affected_count ?? affected.length} booking(s).\n` +
          `Deleting it permanently removes ${destroyed} of them` +
          (unassigned > 0 ? ` and leaves ${unassigned} without a venue` : '') +
          '.\n\nDelete anyway?'
      );
      if (!proceed) return;

      const confirmed = await deleteField(field.id, { confirm: true });
      if (!confirmed?.deleted) {
        alert('Failed to delete field: the request was refused.');
      }
    } catch (err) {
      logger.error('Delete failed', err);
      alert('Failed to delete field: ' + err.message);
    }
  };

  // Helper to join location name to field display
  const getLocationName = (locId) => {
    const loc = locations.find((l) => l.id === locId);
    return loc ? loc.name : 'Unknown Location';
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-text-secondary animate-pulse">Loading facilities...</div>
      </div>
    );
  }

  return (
    <div className="animate-fadeIn space-y-8 relative">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary mb-2">
            Field Management
          </h1>
          <p className="text-text-secondary">
            Configure venues, fields, sub-units, and practice availability.
          </p>
        </div>
        <Button variant="primary" className="flex items-center gap-2" onClick={handleAddNew}>
          <Plus size={18} /> Add Field
        </Button>
      </div>

      <section
        className="bg-bg-surface border border-border-subtle rounded-xl p-5"
        aria-labelledby="seasonal-availability-heading"
      >
        <h2
          id="seasonal-availability-heading"
          className="text-lg font-semibold text-text-primary mb-1"
        >
          Seasonal availability
        </h2>
        <p className="text-sm text-text-secondary mb-4">
          Seasonal availability metadata — not finalized schedule slots.
        </p>
        <p className="text-xs text-text-muted mb-4">
          No explicit day/time slots were provided; schedule slots were not created.
        </p>
        <div className="space-y-4">
          {availabilityProfiles.length === 0 && (
            <div className="text-sm text-text-muted" role="status">
              No seasonal availability profiles imported yet.
            </div>
          )}
          {Object.entries(
            availabilityProfiles.reduce((acc, profile) => {
              const season = profile.season_label || 'Unlabeled season';
              if (!acc[season]) acc[season] = [];
              acc[season].push(profile);
              return acc;
            }, {})
          ).map(([season, seasonProfiles]) => (
            <div key={season} className="border border-border-subtle rounded-lg p-3">
              <h3 className="text-sm font-semibold text-text-primary mb-2">{season}</h3>
              <div className="space-y-2">
                {seasonProfiles.map((profile) => (
                  <article
                    key={profile.id}
                    className="border border-border-subtle rounded-lg p-3 bg-bg-app"
                  >
                    <div className="text-sm font-semibold">
                      {profile.location} — {profile.field_name}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className={badgeClass()}>
                        Status: {profile.record_status || 'unknown'}
                      </span>
                      <span className={badgeClass()}>
                        Approval: {profile.approval_status || 'n/a'}
                      </span>
                      <span className={badgeClass()}>
                        Date window: {profile.available_from || '—'} to{' '}
                        {profile.available_until || '—'}
                      </span>
                      {profile.record_status === 'potential' && (
                        <span className={badgeClass()}>Potential state</span>
                      )}
                      {profile.record_status === 'conditional' && (
                        <span className={badgeClass()}>Conditional state</span>
                      )}
                      {profile.record_status === 'excluded' && (
                        <span className={badgeClass()}>Excluded state</span>
                      )}
                    </div>
                    <div className="mt-2 text-xs text-text-secondary">Month indicators:</div>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {MONTH_MARKERS.map((month) => (
                        <span key={`${profile.id}-${month.key}`} className={badgeClass()}>
                          {month.label}: {hasMonthToken(profile, month.key) ? 'Yes' : 'No'}
                        </span>
                      ))}
                    </div>
                    <div className="text-xs text-text-secondary mt-2">
                      Formats and quantities:{' '}
                      {(profile.field_availability_profile_formats || [])
                        .map((f) => `${f.format_code || 'format'} (${f.format_quantity || '—'})`)
                        .join(', ') || '—'}
                    </div>
                    <div className="text-xs text-text-secondary mt-1">
                      teams_per_hour: {profile.teams_per_hour || '—'} • aggregate_teams_per_hour:{' '}
                      {profile.aggregate_teams_per_hour || '—'}
                    </div>
                    <div className="text-xs text-text-secondary mt-1">
                      Blackouts:{' '}
                      {(profile.field_blackout_windows || [])
                        .map(
                          (b) =>
                            `${b.blackout_from || '—'} to ${b.blackout_until || '—'}${b.reason ? ` (${b.reason})` : ''}`
                        )
                        .join('; ') || 'None provided'}
                    </div>
                    <div className="text-xs text-text-secondary mt-1">
                      Equipment flags:{' '}
                      {(profile.field_equipment_requirements || [])
                        .map(
                          (r) =>
                            `${r.goal_equipment || 'equipment'} (${r.requirement_status || 'n/a'})`
                        )
                        .join(', ') || 'None provided'}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className={badgeClass()}>
                        Lighted: {profile.lighted === true ? 'Yes' : 'No/Unknown'}
                      </span>
                      <span className={badgeClass()}>
                        Restroom: {profile.restroom === true ? 'Yes' : 'No/Unknown'}
                      </span>
                      <span className={badgeClass()}>
                        Potty: {profile.potty === true ? 'Yes' : 'No/Unknown'}
                      </span>
                    </div>
                    <div className="text-xs text-text-secondary mt-1">
                      Day constraints: {profile.day_constraints || 'None'} • Move-to-location:{' '}
                      {profile.move_to_location || 'None'}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {fields.map((field) => (
          <div
            key={field.id}
            className={`bg-bg-surface border ${field.active ? 'border-border-subtle' : 'border-red-900/30 bg-red-900/5'} rounded-xl p-6 hover:bg-bg-surface-hover transition-colors group relative`}
          >
            {!field.active && (
              <div className="absolute top-4 right-4 text-xs font-bold text-red-500 bg-red-900/20 px-2 py-1 rounded">
                INACTIVE
              </div>
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
                  onClick={() => handleDelete(field)}
                  aria-label={`Delete ${field.name}`}
                  className="p-2 hover:bg-bg-surface-hover rounded-lg text-text-muted hover:text-red-400 transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>

            <div className="text-xs text-brand-400 font-semibold uppercase mb-1">
              {getLocationName(field.location_id)}
            </div>
            <h2 className="text-xl font-bold text-text-primary mb-1">{field.name}</h2>

            <div className="flex flex-wrap gap-2 text-sm text-text-secondary mt-2 mb-4">
              <span className="px-2 py-0.5 bg-bg-surface rounded-full border border-border-subtle">
                {field.surface_type || 'Grass'}
              </span>
              <span className="px-2 py-0.5 bg-bg-surface rounded-full border border-border-subtle">
                {field.size || '11v11'}
              </span>
              <span className="px-2 py-0.5 bg-blue-900/20 text-blue-300 rounded-full border border-blue-800/30">
                Priority: {field.priority_rating || 1}
              </span>
              {field.supports_halves && field.field_subunits?.length > 0 && (
                <span
                  className="px-2 py-0.5 bg-green-900/20 text-green-400 rounded-full border border-green-800/30 font-semibold"
                  data-testid={`subunit-indicator-${field.id}`}
                >
                  Sub-units: {field.field_subunits.length}
                </span>
              )}
            </div>

            {/* Visual 7-Day Grid */}
            <div className="grid grid-cols-7 gap-1 mt-4 pt-4 border-t border-border-subtle">
              {['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => {
                const slots = field.practice_slots?.filter((s) => s.day_of_week === day) || [];
                const isActive = slots.length > 0;

                return (
                  <div
                    key={day}
                    className={`flex flex-col items-center p-1.5 rounded border transition-all ${
                      isActive
                        ? 'bg-blue-500/10 border-blue-500/30'
                        : 'bg-bg-app border-border-subtle opacity-40'
                    }`}
                  >
                    <span className="text-[10px] uppercase font-bold text-text-muted mb-1">
                      {day.substring(0, 3)}
                    </span>
                    {isActive ? (
                      <div className="flex flex-col items-center">
                        {slots.map((slot) => (
                          <span
                            key={slot.id}
                            className="text-[9px] font-mono text-blue-300 whitespace-nowrap"
                            title={`${slot.start_time.substring(0, 5)} - ${slot.end_time.substring(0, 5)}`}
                          >
                            {slot.start_time.substring(0, 5)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[10px] font-mono text-text-muted opacity-50">—</span>
                    )}
                  </div>
                );
              })}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-bg-app border border-border-subtle rounded-xl p-6 w-full max-w-md shadow-md animate-scaleIn">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-text-primary">
                {editingField ? 'Edit Field' : 'Add New Field'}
              </h2>
              <button
                type="button"
                aria-label="Close modal"
                onClick={() => setIsModalOpen(false)}
                className="text-text-muted hover:text-text-primary"
              >
                <X size={24} />
              </button>
            </div>

            <div className="space-y-4">
              {/* Location Select or Create */}
              <div className="bg-bg-surface p-3 rounded-lg border border-border-subtle space-y-3">
                <div className="flex justify-between items-center">
                  <label
                    htmlFor="field-location-input"
                    className="block text-sm font-medium text-text-secondary"
                  >
                    Venue / Location
                  </label>
                  {!isAddingLocation && (
                    <button
                      onClick={() => setIsAddingLocation(true)}
                      className="text-xs text-brand-400 hover:text-brand-500 flex items-center"
                    >
                      <Plus size={12} className="mr-1" /> Add New Location
                    </button>
                  )}
                  {isAddingLocation && locations.length > 0 && (
                    <button
                      onClick={() => setIsAddingLocation(false)}
                      className="text-xs text-text-secondary hover:text-text-primary"
                    >
                      Select Existing
                    </button>
                  )}
                </div>

                {isAddingLocation ? (
                  <input
                    id="field-location-input"
                    type="text"
                    aria-label="New location name"
                    placeholder="e.g. Main Complex"
                    value={newLocationName}
                    onChange={(e) => setNewLocationName(e.target.value)}
                    className="w-full bg-bg-app border border-border-highlight rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                  />
                ) : (
                  <select
                    id="field-location-input"
                    value={formData.location_id}
                    onChange={(e) => setFormData({ ...formData, location_id: e.target.value })}
                    className="w-full bg-bg-app border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                  >
                    <option value="" disabled>
                      Select a location
                    </option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label
                  htmlFor="field-name"
                  className="block text-sm font-medium text-text-secondary mb-1"
                >
                  Field Name
                </label>
                <input
                  id="field-name"
                  type="text"
                  placeholder="e.g. Field 1"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="surface-type"
                    className="block text-sm font-medium text-text-secondary mb-1"
                  >
                    Surface Type
                  </label>
                  <select
                    id="surface-type"
                    value={formData.surface_type}
                    onChange={(e) => setFormData({ ...formData, surface_type: e.target.value })}
                    className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary text-sm"
                  >
                    <option>Grass</option>
                    <option>Turf</option>
                    <option>Indoor</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="field-size"
                    className="block text-sm font-medium text-text-secondary mb-1"
                  >
                    Size
                  </label>
                  <select
                    id="field-size"
                    value={formData.size}
                    onChange={(e) => setFormData({ ...formData, size: e.target.value })}
                    className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary text-sm"
                  >
                    <option>11v11</option>
                    <option>9v9</option>
                    <option>7v7</option>
                    <option>5v5</option>
                    <option>Clinic</option>
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="field-priority"
                  className="block text-sm font-medium text-text-secondary mb-1"
                >
                  Priority (1-10)
                </label>
                <input
                  id="field-priority"
                  type="number"
                  min="1"
                  max="10"
                  value={formData.priority_rating}
                  onChange={(e) =>
                    setFormData({ ...formData, priority_rating: parseInt(e.target.value) || 1 })
                  }
                  className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-2 focus:border-brand-400 focus:outline-none text-text-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-4 mt-2 p-3 bg-bg-surface border border-border-subtle rounded-lg">
                <label className="flex flex-col gap-2 cursor-pointer">
                  <span className="text-sm font-medium text-text-primary">Sub-fields</span>
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-6 rounded-full p-1 transition-colors ${formData.supports_halves ? 'bg-brand-500' : 'bg-bg-app border border-border-subtle'}`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white transition-transform ${formData.supports_halves ? 'translate-x-6' : 'translate-x-0'}`}
                      />
                    </div>
                    <span className="text-xs text-text-secondary">
                      {formData.supports_halves ? 'A/B Halves' : 'Full Field Only'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={formData.supports_halves}
                    onChange={(e) =>
                      setFormData({ ...formData, supports_halves: e.target.checked })
                    }
                  />
                </label>

                <label className="flex flex-col gap-2 cursor-pointer">
                  <span className="text-sm font-medium text-text-primary">Status</span>
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-6 rounded-full p-1 transition-colors ${formData.active ? 'bg-green-500' : 'bg-bg-app border border-border-subtle'}`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white transition-transform ${formData.active ? 'translate-x-6' : 'translate-x-0'}`}
                      />
                    </div>
                    <span className="text-xs text-text-secondary">
                      {formData.active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={formData.active}
                    onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                  />
                </label>
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
    </div>
  );
}
