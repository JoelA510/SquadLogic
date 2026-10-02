import React, { useCallback, useRef, useState } from 'react';
import { Globe, User, Calendar, ThermometerSun } from 'lucide-react';
import SeasonModule from './modules/SeasonModule.jsx';
import AccountModule from './modules/AccountModule.jsx';
import HeatSafetyModule from './modules/HeatSafetyModule.jsx';
import { useTheme } from '../../contexts/ThemeContext.jsx';

const SUB_TABS = [
  { id: 'identity', label: 'League Identity', icon: Globe },
  { id: 'account', label: 'Account & Security', icon: User },
  { id: 'season', label: 'Season & Calendar', icon: Calendar },
  { id: 'heat', label: 'Heat Safety', icon: ThermometerSun },
];

export default function GeneralSettings() {
  const { leagueName, updateLeagueName } = useTheme();
  const [localLeagueName, setLocalLeagueName] = useState(leagueName);
  const [activeSubTab, setActiveSubTab] = useState('identity');
  const tabRefs = useRef({});

  const handleSubTabKeyDown = useCallback((event) => {
    const currentTabId = SUB_TABS.find(
      (tab) => event.target?.id === `general-settings-tab-${tab.id}`
    )?.id;
    if (!currentTabId) return;

    const currentIndex = SUB_TABS.findIndex((tab) => tab.id === currentTabId);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % SUB_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + SUB_TABS.length) % SUB_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SUB_TABS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = SUB_TABS[nextIndex];
    setActiveSubTab(nextTab.id);
    tabRefs.current[nextTab.id]?.focus();
  }, []);

  const renderSubContent = () => {
    switch (activeSubTab) {
      case 'identity':
        return (
          <div className="space-y-6 animate-fadeIn">
            <div>
              <label
                htmlFor="league-name"
                className="block text-sm font-medium text-text-secondary mb-2"
              >
                League Name
              </label>
              <input
                id="league-name"
                type="text"
                value={localLeagueName}
                onChange={(e) => setLocalLeagueName(e.target.value)}
                onBlur={() => updateLeagueName(localLeagueName)}
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
              />
            </div>
            {/* Switch League dropdown logic could also be moved to a module if it grows */}
            <div>
              <label
                htmlFor="switch-league"
                className="block text-sm font-medium text-text-secondary mb-2"
              >
                Switch Organization
              </label>
              <select
                id="switch-league"
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
              >
                <option value="current">Current Organization</option>
              </select>
            </div>
          </div>
        );
      case 'account':
        return <AccountModule />;
      case 'season':
        return <SeasonModule />;
      case 'heat':
        return <HeatSafetyModule />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-8">
      <div
        className="flex gap-2 overflow-x-auto pb-2 -mx-2 px-2 scrollbar-hide"
        role="tablist"
        aria-label="General settings sections"
        onKeyDown={handleSubTabKeyDown}
      >
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`general-settings-tab-${tab.id}`}
            ref={(element) => {
              tabRefs.current[tab.id] = element;
            }}
            type="button"
            role="tab"
            aria-selected={activeSubTab === tab.id}
            aria-controls="general-settings-panel"
            tabIndex={activeSubTab === tab.id ? 0 : -1}
            onClick={() => setActiveSubTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${
              activeSubTab === tab.id
                ? 'bg-brand-500/20 text-brand-400 border-brand-500/30'
                : 'bg-bg-surface/50 text-text-muted border-border-subtle hover:bg-bg-surface hover:text-text-primary'
            }`}
          >
            <tab.icon size={14} aria-hidden="true" />
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="general-settings-panel"
        role="tabpanel"
        aria-labelledby={`general-settings-tab-${activeSubTab}`}
        className="pt-2 border-t border-border-subtle"
      >
        {renderSubContent()}
      </div>
    </div>
  );
}
