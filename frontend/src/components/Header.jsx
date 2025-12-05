import React from 'react';

function Header() {
    return (
        <header className="app-header">
            <div className="brand-logo">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 2L3 7V12C3 17.52 6.84 22.74 12 24C17.16 22.74 21 17.52 21 12V7L12 2Z" fill="url(#logo-gradient)" />
                    <defs>
                        <linearGradient id="logo-gradient" x1="3" y1="2" x2="21" y2="24" gradientUnits="userSpaceOnUse">
                            <stop stopColor="var(--color-primary-400)" />
                            <stop offset="1" stopColor="var(--color-primary-600)" />
                        </linearGradient>
                    </defs>
                </svg>
                <span>SquadLogic</span>
            </div>
        </header>
    );
}

export default Header;
