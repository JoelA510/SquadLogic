import React from 'react';
import PracticeReadinessPanel from '../components/PracticeReadinessPanel';
import { useDashboardData } from '../hooks/useDashboardData';
import { useTheme } from '../contexts/ThemeContext';

export default function PracticeSchedulingPage() {
    const { practice } = useDashboardData();
    const { timezone } = useTheme();

    return (
        <div className="animate-fadeIn space-y-8">
            <div className="mb-8">
                <h1 className="text-3xl font-display font-bold text-white mb-2">Practice Scheduling</h1>
                <p className="text-white/60">Generate and review practice schedules based on field availability.</p>
            </div>

            <PracticeReadinessPanel
                practiceReadinessSnapshot={practice.snapshot}
                practiceSummary={practice.summary}
                generatedAt={practice.generatedAt}
                timezone={timezone}
            />
        </div>
    );
}
