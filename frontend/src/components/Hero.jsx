import React from 'react';

function Hero() {
    return (
        <section className="hero text-center mb-12 animate-fadeIn">
            <h1 className="text-5xl md:text-7xl font-display font-black mb-6 tracking-tight">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-text-primary via-blue-400 to-blue-600">
                    Admin Dashboard
                </span>
            </h1>
            <p className="text-lg md:text-xl text-text-secondary max-w-2xl mx-auto leading-relaxed animate-slideUp">
                Manage your league's season from start to finish. Import data, build teams, and generate schedules in one place.
            </p>
        </section>
    );

}

export default Hero;
