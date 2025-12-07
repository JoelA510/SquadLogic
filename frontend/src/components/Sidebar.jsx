import React from 'react';
import {
    LayoutDashboard,
    Upload,
    Users,
    Map,
    Calendar,
    Trophy,
    LogOut,
    Settings
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { NavLink } from 'react-router-dom';

const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: '/' },
    { id: 'import', label: 'Data Import', icon: Upload, path: '/import' },
    { id: 'teams', label: 'Team Management', icon: Users, path: '/teams' },
    { id: 'fields', label: 'Field Management', icon: Map, path: '/fields' },
    { id: 'schedule-practice', label: 'Practice Schedule', icon: Calendar, path: '/schedule/practice' },
    { id: 'schedule-game', label: 'Game Schedule', icon: Trophy, path: '/schedule/game' },
    { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' }
];

export default function Sidebar({ isOpen, toggleSidebar }) {
    const { signOut } = useAuth();

    return (
        <>
            {/* Overlay for mobile */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden"
                    onClick={toggleSidebar}
                />
            )}

            <aside className={`
                fixed md:static inset-y-0 left-0 z-[100]
                w-72 bg-bg-app border-r border-border-subtle
                transform transition-transform duration-300 ease-in-out
                ${isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
                flex flex-col
            `}>
                {/* Logo Area */}
                <div className="p-6 border-b border-border-subtle flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-600 to-brand-400 flex items-center justify-center shadow-lg shadow-brand-glow">
                        <span className="text-white font-bold text-xl">S</span>
                    </div>
                    <div>
                        <h1 className="text-xl font-display font-bold text-text-primary tracking-tight">
                            SquadLogic
                        </h1>
                        <p className="text-xs text-brand-400 font-medium">League Management</p>
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.id}
                            to={item.path}
                            onClick={() => {
                                if (window.innerWidth < 768) {
                                    toggleSidebar();
                                }
                            }}
                            className={({ isActive }) => `
                                w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 group border
                                ${isActive
                                    ? 'bg-brand-glow text-brand-400 border-brand-400/50 shadow-[0_0_20px_var(--color-primary-glow)]'
                                    : 'bg-bg-surface text-text-muted border-border-subtle hover:bg-bg-surface-hover hover:text-text-primary hover:border-border-highlight'
                                }
                            `}
                        >
                            {({ isActive }) => (
                                <>
                                    <item.icon
                                        size={20}
                                        className={`transition-colors ${isActive ? 'text-brand-400' : 'text-text-muted group-hover:text-text-primary'}`}
                                    />
                                    <span className="font-medium">{item.label}</span>

                                    {isActive && (
                                        <div className="ml-auto w-1.5 h-1.5 rounded-full bg-brand-400 shadow-[0_0_8px_var(--color-primary-glow)]" />
                                    )}
                                </>
                            )}
                        </NavLink>
                    ))}
                </nav>

                {/* User Profile / Logout */}
                <div className="p-4 border-t border-border-subtle">
                    <button
                        onClick={signOut}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-text-muted hover:text-status-error hover:bg-status-error-bg transition-all duration-200 group"
                    >
                        <LogOut size={20} className="transition-colors group-hover:text-status-error" />
                        <span className="font-medium">Sign Out</span>
                    </button>
                </div>
            </aside>
        </>
    );
}
