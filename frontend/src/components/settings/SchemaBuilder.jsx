import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../../lib/supabaseClient.js';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { logger } from '../../lib/logger.js';
import { RESERVED_KEYS } from '../../utils/telemetryUtils.js';
import {
  Settings,
  Plus,
  Trash2,
  Save,
  ShieldCheck,
  Database,
  User,
  Users,
  Shield,
  Activity,
  AlertCircle,
} from 'lucide-react';

const SCHEMA_TABS = [
  { id: 'player', label: 'Players', icon: User },
  { id: 'coach', label: 'Coaches', icon: Shield },
  { id: 'team', label: 'Teams', icon: Users },
];

export function SchemaBuilder() {
  const { currentOrganization } = useOrganization();
  const [activeTab, setActiveTab] = useState('player'); // player, coach, team
  const tabRefs = useRef({});
  const [schemas, setSchemas] = useState({
    player: {},
    coach: {},
    team: {},
  });
  const [isSaving, setIsSaving] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState('string');
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadSchemas() {
      if (!currentOrganization?.id) return;
      const { data, error } = await supabase
        .from('organization_schemas')
        .select('*')
        .eq('organization_id', currentOrganization.id);

      if (error) {
        logger.error('Failed to load schemas:', error);
        return;
      }

      const loadedSchemas = { player: {}, coach: {}, team: {} };
      data?.forEach((s) => {
        loadedSchemas[s.entity_type] = s.schema_definition;
      });
      setSchemas(loadedSchemas);
    }
    loadSchemas();
  }, [currentOrganization?.id]);

  // Heavy Computation: Memoize entries to prevent O(N) object keys processing on every flicker
  const attributeEntries = useMemo(() => Object.entries(schemas[activeTab]), [schemas, activeTab]);

  const handleAddField = useCallback(() => {
    const fieldName = newFieldName.toLowerCase().trim().replace(/\s+/g, '_');

    if (!fieldName) return;

    // Core Immortality: RESERVED_KEYS Guard
    if (RESERVED_KEYS.has(fieldName)) {
      setError(`Cannot use '${fieldName}': It is a system-reserved field.`);
      return;
    }

    if (schemas[activeTab][fieldName]) {
      setError(`Field '${fieldName}' already exists.`);
      return;
    }

    setSchemas((prev) => ({
      ...prev,
      [activeTab]: {
        ...prev[activeTab],
        [fieldName]: newFieldType,
      },
    }));
    setNewFieldName('');
    setError(null);
  }, [newFieldName, activeTab, schemas, newFieldType]);

  const handleRemoveField = useCallback(
    (fieldName) => {
      setSchemas((prev) => {
        const updatedSchema = { ...prev[activeTab] };
        delete updatedSchema[fieldName];
        return {
          ...prev,
          [activeTab]: updatedSchema,
        };
      });
    },
    [activeTab]
  );

  const handleTabKeyDown = useCallback(
    (event) => {
      const currentTabId =
        SCHEMA_TABS.find((tab) => event.target?.id === `schema-tab-${tab.id}`)?.id ?? activeTab;
      const currentIndex = SCHEMA_TABS.findIndex((tab) => tab.id === currentTabId);
      if (currentIndex === -1) return;

      let nextIndex = currentIndex;
      if (event.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % SCHEMA_TABS.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + SCHEMA_TABS.length) % SCHEMA_TABS.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = SCHEMA_TABS.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextTab = SCHEMA_TABS[nextIndex];
      setActiveTab(nextTab.id);
      tabRefs.current[nextTab.id]?.focus();
    },
    [activeTab]
  );

  const saveSchema = async () => {
    if (!currentOrganization?.id) return;
    setIsSaving(true);
    setError(null);

    try {
      const { error: saveError } = await supabase.rpc('admin_upsert_organization_schema', {
        p_organization_id: currentOrganization.id,
        p_entity_type: activeTab,
        p_schema_definition: schemas[activeTab],
      });

      if (saveError) throw saveError;

      logger.log(`[SchemaBuilder] Saved ${activeTab} schema successfully.`);
      alert(`${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} schema updated!`);
    } catch (err) {
      setError(err.message);
      logger.error('Save failed:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary tracking-tight flex items-center gap-3">
            <Database className="text-text-accent w-7 h-7" aria-hidden="true" />
            Dynamic Schema Architect
          </h2>
          <p className="text-text-muted text-sm mt-1">
            Define organization-scoped custom attributes with enterprise validation.
          </p>
        </div>
        <div className="bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-xl flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-status-success-text" aria-hidden="true" />
          <span className="text-xs font-bold text-status-success-text uppercase tracking-widest">
            Level 5 Security Active
          </span>
        </div>
      </div>

      {/* Tabs */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the tablist delegates its tabs' arrow keys; each tab is a focusable button (roving tabindex) */}
      <div
        className="flex p-1 bg-bg-glass border border-border-subtle rounded-2xl w-fit"
        role="tablist"
        aria-label="Schema entity tabs"
        onKeyDown={handleTabKeyDown}
      >
        {SCHEMA_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`schema-tab-${tab.id}`}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls="schema-panel"
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all duration-300 ${
              activeTab === tab.id
                ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/20'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-glass'
            }`}
          >
            <tab.icon className="w-4 h-4" aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="schema-panel"
        role="tabpanel"
        aria-labelledby={`schema-tab-${activeTab}`}
        className="grid grid-cols-1 lg:grid-cols-3 gap-6"
      >
        {/* Field List */}
        <div className="lg:col-span-2 glass-panel-enterprise p-6 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-text-primary">Current Attributes</h3>
            <span className="text-[10px] font-bold text-text-muted uppercase tracking-widest">
              {Object.keys(schemas[activeTab]).length} Defined Fields
            </span>
          </div>

          <div className="space-y-3">
            {attributeEntries.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center text-text-muted border-2 border-dashed border-border-subtle rounded-2xl">
                <Settings className="w-12 h-12 mb-3 opacity-10" aria-hidden="true" />
                <p className="text-sm font-medium">
                  No custom attributes defined for {activeTab}s.
                </p>
              </div>
            ) : (
              attributeEntries.map(([name, type]) => (
                <div
                  key={name}
                  className="flex items-center justify-between p-4 rounded-xl bg-bg-glass border border-border-subtle group hover:border-border-highlight transition-all duration-300"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-2 h-2 rounded-full bg-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.4)]" />
                    <div>
                      <p className="text-sm font-bold text-text-primary tracking-tight">{name}</p>
                      <p className="text-[10px] font-bold text-text-accent uppercase tracking-widest">
                        {type}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${name} ${activeTab} attribute`}
                    onClick={() => handleRemoveField(name)}
                    className="p-2 text-text-muted hover:text-status-error-text hover:bg-red-500/10 rounded-lg transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              ))
            )}
          </div>

          <button
            type="button"
            disabled={isSaving}
            onClick={saveSchema}
            className="w-full py-4 rounded-2xl bg-gradient-to-r from-sky-600 to-indigo-600 text-white font-bold text-sm flex items-center justify-center gap-3 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:grayscale"
          >
            {isSaving ? (
              <Activity className="w-5 h-5 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="w-5 h-5" aria-hidden="true" />
            )}
            {isSaving ? 'Processing Evolution...' : `Finalize ${activeTab.toUpperCase()} Schema`}
          </button>
        </div>

        {/* Add Field Sidepanel */}
        <div className="space-y-6">
          <div className="glass-panel-enterprise p-6 space-y-6 border-indigo-500/10 bg-indigo-500/5">
            <h3 className="text-lg font-bold text-text-primary flex items-center gap-2">
              <Plus className="w-5 h-5 text-text-accent" aria-hidden="true" />
              New Attribute
            </h3>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="schema-field-name"
                  className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5 block"
                >
                  Field Identity
                </label>
                <input
                  id="schema-field-name"
                  type="text"
                  placeholder="e.g. jersey_size"
                  value={newFieldName}
                  onChange={(e) => setNewFieldName(e.target.value)}
                  className="w-full bg-bg-surface border border-border-subtle rounded-xl px-4 py-3 text-sm text-text-primary focus:border-indigo-500/50 outline-none transition-all placeholder:text-text-muted"
                />
              </div>

              <div>
                <label
                  htmlFor="schema-field-type"
                  className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1.5 block"
                >
                  Data Structure
                </label>
                <select
                  id="schema-field-type"
                  value={newFieldType}
                  onChange={(e) => setNewFieldType(e.target.value)}
                  className="w-full bg-bg-surface border border-border-subtle rounded-xl px-4 py-3 text-sm text-text-primary focus:border-indigo-500/50 outline-none transition-all"
                >
                  <option value="string">String (Text)</option>
                  <option value="number">Number (Decimal/Integer)</option>
                  <option value="boolean">Boolean (True/False)</option>
                  <option value="date">Date (YYYY-MM-DD)</option>
                </select>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-status-error-text" aria-hidden="true" />
                  <p className="text-[10px] text-status-error-text font-bold uppercase">{error}</p>
                </div>
              )}

              <button
                type="button"
                onClick={handleAddField}
                className="w-full py-4 rounded-xl bg-indigo-500/20 text-text-accent font-bold text-xs uppercase tracking-widest border border-indigo-500/30 hover:bg-indigo-500/30 transition-all"
              >
                Draft Attribute
              </button>
            </div>
          </div>

          <div className="p-5 rounded-2xl bg-bg-glass border border-border-subtle">
            <div className="flex gap-3">
              <Shield className="w-5 h-5 text-text-accent shrink-0" aria-hidden="true" />
              <p className="text-[11px] leading-relaxed text-text-muted">
                <strong className="text-text-primary">Governance Note:</strong> Changes to schema
                definitions are audited in{' '}
                <code className="text-text-accent">organization_schema_history</code>. System fields
                are immutable.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
