import React, { useState, useRef } from 'react';
import { Save, User, Shield, Palette, Globe, Upload, Calendar, Moon, Sun } from 'lucide-react';
import Button from '../components/ui/Button';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { PERSISTENCE_THEMES } from '../utils/themes';
import { extractColorsFromImage } from '../utils/colorUtils';

export default function SettingsPage() {
    const { user } = useAuth();
    const {
        theme: currentTheme,
        clubColors,
        updateClubColors,
        clubLogo,
        updateClubLogo,
        clubMode,
        updateClubMode,
        extractedColors,
        updateExtractedColors,
        leagueName,
        updateLeagueName,
        currentSeason,
        updateCurrentSeason,
        availableSeasons,
        addSeason
    } = useTheme();
    const [activeTab, setActiveTab] = useState('general');
    const fileInputRef = useRef(null);
    const [localLeagueName, setLocalLeagueName] = useState(leagueName);
    const [seasonFormat, setSeasonFormat] = useState('single'); // single or dual
    const [localCurrentSeason, setLocalCurrentSeason] = useState(currentSeason);

    // Password management state
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');

    const theme = PERSISTENCE_THEMES.blue; // Default theme for settings

    const tabs = [
        { id: 'general', label: 'General', icon: Globe },
        { id: 'account', label: 'Account & Security', icon: Shield },
        { id: 'appearance', label: 'Appearance & Branding', icon: Palette },
        { id: 'season', label: 'Season Configuration', icon: Calendar },
    ];

    const handleSave = () => {
        updateLeagueName(localLeagueName);
        updateCurrentSeason(localCurrentSeason);
        // Mock save functionality
        alert('Settings saved successfully!');
    };

    const handleLogoUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const dataUrl = event.target.result;
            updateClubLogo(dataUrl);

            try {
                const colors = await extractColorsFromImage(dataUrl);
                updateExtractedColors(colors);
            } catch (error) {
                console.error("Failed to extract colors", error);
            }
        };
        reader.readAsDataURL(file);
    };

    const handleColorSuggestionClick = (color, type) => {
        updateClubColors({ [type]: color });
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'general':
                return (
                    <div className="space-y-6 animate-fadeIn">
                        <div>
                            <label htmlFor="league-name" className="block text-sm font-medium text-text-secondary mb-2">League Name</label>
                            <input
                                id="league-name"
                                type="text"
                                value={localLeagueName}
                                onChange={(e) => setLocalLeagueName(e.target.value)}
                                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                            />
                        </div>
                        <div>
                            <label htmlFor="switch-league" className="block text-sm font-medium text-text-secondary mb-2">Switch League</label>
                            <select id="switch-league" className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors">
                                <option className="bg-slate-800" value="1">My Youth League (Current)</option>
                                <option className="bg-slate-800" value="new">+ Create New League</option>
                            </select>
                        </div>
                    </div>
                );
            case 'account':
                return (
                    <div className="space-y-6 animate-fadeIn">
                        <div className="p-4 bg-bg-surface rounded-lg border border-border-subtle flex items-center gap-4">
                            <div className="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                                <User size={24} />
                            </div>
                            <div>
                                <h3 className="text-text-primary font-medium">Logged in as</h3>
                                <p className="text-text-muted text-sm">{user?.email || 'user@example.com'}</p>
                            </div>
                        </div>

                        <div className="border-t border-white/10 pt-6">
                            <h3 className="text-lg font-medium text-text-primary mb-4">Change Password</h3>
                            <div className="space-y-4">
                                <div>
                                    <label htmlFor="current-password" className="block text-sm font-medium text-text-secondary mb-2">Current Password</label>
                                    <input
                                        id="current-password"
                                        type="password"
                                        value={currentPassword}
                                        onChange={(e) => setCurrentPassword(e.target.value)}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="new-password" className="block text-sm font-medium text-text-secondary mb-2">New Password</label>
                                    <input
                                        id="new-password"
                                        type="password"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="confirm-password" className="block text-sm font-medium text-text-secondary mb-2">Confirm New Password</label>
                                    <input
                                        id="confirm-password"
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                                    />
                                </div>
                                <Button variant="secondary" size="sm">Update Password</Button>
                            </div>
                        </div>
                    </div>
                );
            case 'appearance':
                return (
                    <div className="space-y-6 animate-fadeIn">
                        <div>
                            <h3 className="text-lg font-medium text-text-primary mb-4">Club Branding</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="space-y-4">
                                    <div>
                                        <label htmlFor="primary-accent" className="block text-sm font-medium text-text-secondary mb-2">Primary Accent</label>
                                        <div className="flex gap-3 items-center">
                                            <input
                                                id="primary-accent"
                                                type="color"
                                                value={clubColors.primaryAccent}
                                                onChange={(e) => updateClubColors({ primaryAccent: e.target.value })}
                                                className="w-12 h-12 rounded cursor-pointer bg-transparent border-0 p-0"
                                            />
                                            <span className="text-text-muted font-mono">{clubColors.primaryAccent}</span>
                                        </div>
                                    </div>
                                    <div>
                                        <label htmlFor="secondary-accent" className="block text-sm font-medium text-text-secondary mb-2">Secondary Accent</label>
                                        <div className="flex gap-3 items-center">
                                            <input
                                                id="secondary-accent"
                                                type="color"
                                                value={clubColors.secondaryAccent}
                                                onChange={(e) => updateClubColors({ secondaryAccent: e.target.value })}
                                                className="w-12 h-12 rounded cursor-pointer bg-transparent border-0 p-0"
                                            />
                                            <span className="text-text-muted font-mono">{clubColors.secondaryAccent}</span>
                                        </div>
                                    </div>
                                    <div>
                                        <label htmlFor="background-1" className="block text-sm font-medium text-text-secondary mb-2">Background 1 (Gradient Start)</label>
                                        <div className="flex gap-3 items-center">
                                            <input
                                                id="background-1"
                                                type="color"
                                                value={clubColors.background1}
                                                onChange={(e) => updateClubColors({ background1: e.target.value })}
                                                className="w-12 h-12 rounded cursor-pointer bg-transparent border-0 p-0"
                                            />
                                            <span className="text-text-muted font-mono">{clubColors.background1}</span>
                                        </div>
                                    </div>
                                    <div>
                                        <label htmlFor="background-2" className="block text-sm font-medium text-text-secondary mb-2">Background 2 (Gradient End)</label>
                                        <div className="flex gap-3 items-center">
                                            <input
                                                id="background-2"
                                                type="color"
                                                value={clubColors.background2}
                                                onChange={(e) => updateClubColors({ background2: e.target.value })}
                                                className="w-12 h-12 rounded cursor-pointer bg-transparent border-0 p-0"
                                            />
                                            <span className="text-text-muted font-mono">{clubColors.background2}</span>
                                        </div>
                                    </div>
                                </div>
                                <div>
                                    <label htmlFor="club-logo-upload" className="block text-sm font-medium text-text-secondary mb-2">Club Logo</label>
                                    <div
                                        className="border-2 border-dashed border-border-subtle rounded-lg p-6 text-center hover:bg-bg-surface-hover transition-colors cursor-pointer h-full flex flex-col items-center justify-center relative overflow-hidden"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        {clubLogo ? (
                                            <img src={clubLogo} alt="Club Logo" className="max-h-32 object-contain mb-2" />
                                        ) : (
                                            <Upload className="mx-auto h-8 w-8 text-text-muted mb-2" />
                                        )}
                                        <p className="text-sm text-text-muted">{clubLogo ? 'Click to change logo' : 'Click to upload logo'}</p>
                                        <p className="text-xs text-text-muted mt-1">PNG, JPG up to 2MB</p>
                                        <input
                                            id="club-logo-upload"
                                            type="file"
                                            ref={fileInputRef}
                                            className="hidden"
                                            accept="image/*"
                                            onChange={handleLogoUpload}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Color Suggestions */}
                            {extractedColors.length > 0 && (
                                <div className="mt-6 p-4 bg-bg-surface rounded-lg border border-border-subtle">
                                    <h4 className="text-sm font-medium text-text-primary mb-3">Detected Colors from Logo</h4>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                                        {extractedColors.map((color, index) => (
                                            <div key={index} className="flex items-center gap-3 p-2 rounded-lg border border-white/5 bg-white/5">
                                                <div
                                                    className="w-12 h-12 rounded-lg shadow-sm shrink-0"
                                                    style={{ backgroundColor: color }}
                                                />
                                                <div className="flex flex-col gap-1 w-full">
                                                    <div className="text-xs font-mono text-text-muted mb-1">{color}</div>
                                                    <div className="grid grid-cols-2 gap-1 w-full mt-1">
                                                        <button
                                                            onClick={() => handleColorSuggestionClick(color, 'background1')}
                                                            className="px-1 py-1 text-[10px] font-medium rounded bg-bg-surface hover:bg-brand-500 hover:text-white transition-colors border border-white/10 text-center truncate"
                                                            title="Set as Background 1"
                                                        >
                                                            BG 1
                                                        </button>
                                                        <button
                                                            onClick={() => handleColorSuggestionClick(color, 'background2')}
                                                            className="px-1 py-1 text-[10px] font-medium rounded bg-bg-surface hover:bg-brand-500 hover:text-white transition-colors border border-white/10 text-center truncate"
                                                            title="Set as Background 2"
                                                        >
                                                            BG 2
                                                        </button>
                                                        <button
                                                            onClick={() => handleColorSuggestionClick(color, 'primaryAccent')}
                                                            className="px-1 py-1 text-[10px] font-medium rounded bg-bg-surface hover:bg-brand-500 hover:text-white transition-colors border border-white/10 text-center truncate"
                                                            title="Set as Primary Accent"
                                                        >
                                                            Acc 1
                                                        </button>
                                                        <button
                                                            onClick={() => handleColorSuggestionClick(color, 'secondaryAccent')}
                                                            className="px-1 py-1 text-[10px] font-medium rounded bg-bg-surface hover:bg-brand-500 hover:text-white transition-colors border border-white/10 text-center truncate"
                                                            title="Set as Secondary Accent"
                                                        >
                                                            Acc 2
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-xs text-text-muted mt-3">
                                        Assign detected colors to your theme palette: <br />
                                        <span className="font-medium text-text-secondary">Acc 1</span> = Primary Accent,
                                        <span className="font-medium text-text-secondary ml-1">Acc 2</span> = Secondary Accent,
                                        <span className="font-medium text-text-secondary ml-1">BG 1</span> = Background Start,
                                        <span className="font-medium text-text-secondary ml-1">BG 2</span> = Background End.
                                    </p>
                                </div>
                            )}
                        </div>

                        <div className="border-t border-white/10 pt-6">
                            <h3 className="text-lg font-medium text-text-primary mb-4">Theme Configuration</h3>

                            <div className="mb-6">
                                <label className="block text-sm font-medium text-text-secondary mb-2">Base Theme Mode (for Club Theme)</label>
                                <div className="flex gap-4">
                                    <button
                                        onClick={() => updateClubMode('light')}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${clubMode === 'light'
                                            ? 'bg-brand-glow border-brand-400 text-text-primary'
                                            : 'bg-bg-surface border-border-subtle text-text-muted hover:bg-bg-surface-hover'}`}
                                    >
                                        <Sun size={16} /> Light Base
                                    </button>
                                    <button
                                        onClick={() => updateClubMode('dark')}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-all ${clubMode === 'dark'
                                            ? 'bg-brand-glow border-brand-400 text-text-primary'
                                            : 'bg-bg-surface border-border-subtle text-text-muted hover:bg-bg-surface-hover'}`}
                                    >
                                        <Moon size={16} /> Dark Base
                                    </button>
                                </div>
                                <p className="text-xs text-text-muted mt-2">Determines the default text and neutral background colors for the Club theme.</p>
                            </div>

                            <h3 className="text-lg font-medium text-text-primary mb-4">System Theme</h3>
                            <p className="text-text-muted text-sm mb-4">Use the theme toggle in the bottom right corner to switch between Light, Dark, and Club modes globally.</p>
                        </div>
                    </div>
                );
            case 'season':
                return (
                    <div className="space-y-6 animate-fadeIn">
                        <div>
                            <label className="block text-sm font-medium text-text-secondary mb-2">Season Naming Format</label>
                            <div className="grid grid-cols-2 gap-4">
                                <button
                                    onClick={() => setSeasonFormat('single')}
                                    className={`p-4 rounded-lg border text-left transition-all ${seasonFormat === 'single' ? 'bg-brand-glow border-brand-400 text-text-primary' : 'bg-bg-surface border-border-subtle text-text-muted hover:bg-bg-surface-hover'}`}
                                >
                                    <div className="font-medium mb-1">Single Year</div>
                                    <div className="text-xs opacity-70">e.g., "2025", "2026"</div>
                                </button>
                                <button
                                    onClick={() => setSeasonFormat('dual')}
                                    className={`p-4 rounded-lg border text-left transition-all ${seasonFormat === 'dual' ? 'bg-brand-glow border-brand-400 text-text-primary' : 'bg-bg-surface border-border-subtle text-text-muted hover:bg-bg-surface-hover'}`}
                                >
                                    <div className="font-medium mb-1">Dual Year</div>
                                    <div className="text-xs opacity-70">e.g., "2025-2026"</div>
                                </button>
                            </div>
                        </div>

                        <div>
                            <label htmlFor="current-season-label" className="block text-sm font-medium text-text-secondary mb-2">Current Season Label</label>
                            <div className="space-y-3">
                                <div className="relative">
                                    <input
                                        id="current-season-label"
                                        type="text"
                                        value={localCurrentSeason}
                                        onChange={(e) => setLocalCurrentSeason(e.target.value)}
                                        className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                                        placeholder={seasonFormat === 'single' ? '2025' : '2025-2026'}
                                    />
                                    {availableSeasons.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-2">
                                            {availableSeasons.map(season => (
                                                <button
                                                    key={season}
                                                    onClick={() => setLocalCurrentSeason(season)}
                                                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${localCurrentSeason === season
                                                        ? 'bg-brand-500/20 text-brand-400 border-brand-500/30'
                                                        : 'bg-bg-surface text-text-muted border-border-subtle hover:bg-bg-surface-hover'
                                                        }`}
                                                >
                                                    {season}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <p className="text-xs text-text-muted">
                                    Type a new season to create it, or select from saved seasons.
                                </p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label htmlFor="season-timezone" className="block text-sm font-medium text-text-secondary mb-2">Timezone</label>
                                <select
                                    id="season-timezone"
                                    className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                                >
                                    <option value="America/Log_Angeles">Pacific Time (US & Canada)</option>
                                    <option value="America/Denver">Mountain Time (US & Canada)</option>
                                    <option value="America/Chicago">Central Time (US & Canada)</option>
                                    <option value="America/New_York">Eastern Time (US & Canada)</option>
                                    <option value="UTC">UTC</option>
                                </select>
                                <p className="text-xs text-text-muted mt-1">All schedules will be generated relative to this timezone.</p>
                            </div>

                            <div>
                                <label htmlFor="school-day-end" className="block text-sm font-medium text-text-secondary mb-2">School Day End (Earliest Practice)</label>
                                <input
                                    id="school-day-end"
                                    type="time"
                                    defaultValue="16:00"
                                    className="w-full bg-bg-surface border border-border-subtle rounded-lg px-4 py-3 text-text-primary focus:outline-none focus:border-brand-400 transition-colors"
                                />
                                <p className="text-xs text-text-muted mt-1">Practices on Mon-Thu will not be scheduled before this time.</p>
                            </div>
                        </div>
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div className="p-8 max-w-6xl mx-auto">
            <header className="mb-8">
                <h1 className="text-3xl font-bold text-text-primary mb-2">Settings</h1>
                <p className="text-text-secondary">Manage your league configuration and preferences.</p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
                {/* Sidebar Navigation */}
                <div className="lg:col-span-1">
                    <nav className="space-y-1">
                        {tabs.map((tab) => {
                            const Icon = tab.icon;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id
                                        ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                        : 'text-text-muted hover:bg-bg-surface hover:text-text-primary'
                                        }`}
                                >
                                    <Icon size={18} />
                                    {tab.label}
                                </button>
                            );
                        })}
                    </nav>
                </div>

                {/* Main Content Area */}
                <div className="lg:col-span-3">
                    <div className="glass-panel p-8 rounded-xl border border-white/10 relative overflow-hidden min-h-[500px]">
                        <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none opacity-20`} />

                        <div className="relative z-10">
                            <div className="flex justify-between items-center mb-6">
                                <h2 className="text-xl font-semibold text-text-primary">
                                    {tabs.find(t => t.id === activeTab)?.label}
                                </h2>
                                <Button
                                    variant="primary"
                                    size="sm"
                                    icon={Save}
                                    onClick={handleSave}
                                >
                                    Save Changes
                                </Button>
                            </div>

                            {renderContent()}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
