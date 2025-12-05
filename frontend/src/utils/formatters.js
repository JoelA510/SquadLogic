export const formatPercent = (value) => `${Math.round((value ?? 0) * 100)}%`;

export const formatPercentPrecise = (value) => {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return '0%';
    }
    const scaled = Math.round(numeric * 1000) / 10;
    return `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}%`;
};

export const formatList = (items) => (items.length > 0 ? items.join(', ') : 'None');

export const formatReasons = (reasons) =>
    Object.entries(reasons)
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(', ');

export const formatTime = (value) => {
    if (!value) {
        return 'unspecified time';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'unspecified time';
    }
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

export const formatClockFromMinutes = (minutes) => {
    if (!Number.isFinite(minutes)) {
        return 'unspecified time';
    }
    const normalized = Math.max(0, Math.round(minutes));
    const hours = Math.floor(normalized / 60) % 24;
    const mins = normalized % 60;
    const label = `${hours.toString().padStart(2, '0')}:${mins
        .toString()
        .padStart(2, '0')}`;
    const suffix = hours >= 12 ? 'pm' : 'am';
    const adjustedHour = ((hours + 11) % 12) + 1;
    return `${adjustedHour}:${mins.toString().padStart(2, '0')} ${suffix} (${label})`;
};

export const formatGameWarningDetails = (details) => {
    if (!details) {
        return 'See evaluator details';
    }
    if (details.dominantDivision) {
        return `${details.dominantDivision} at ${formatPercentPrecise(details.dominantShare)}`;
    }
    if (details.coachId) {
        return `Coach ${details.coachId} · Week ${details.weekIndex}`;
    }
    return 'See evaluator details';
};
