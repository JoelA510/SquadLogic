import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// CONFIGURATION
// ==========================================

const SEASON_CONFIG = {
    label: 'Fall 2025',
    year: 2025,
    start: '2025-08-01',
    end: '2025-11-15', // Includes post-season
    days: ['mon', 'tue', 'wed', 'thu'], // Default practice days
};

// Helper to find the first Monday ON or AFTER a given date string (YYYY-MM-DD)
function getNextMonday(dateStr) {
    const d = new Date(dateStr);
    const day = d.getDay();
    const diff = day === 1 ? 0 : (8 - day) % 7; // If Mon (1), diff 0. If Tue (2), diff 6...
    d.setDate(d.getDate() + diff);
    return d.toISOString().split('T')[0];
}

// Helper to add days to a date string
function addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

// Dynamic Transition Dates (2025)
// "nearest Monday following September 24" -> Sept 29, 2025
const PHASE_2_START = getNextMonday('2025-09-24');
// "nearest Monday following 10/15" -> Oct 20, 2025
const PHASE_3_START = getNextMonday('2025-10-15');
const POST_SEASON_START = '2025-11-01';

const PHASES = [
    {
        label: 'Phase 1 (Full Daylight)',
        start: SEASON_CONFIG.start,
        end: addDays(PHASE_2_START, -1), // End day before Phase 2 starts
        slotDurationMinutes: 60,
        startTimes: ['16:00', '17:00', '18:00'], // 4, 5, 6 PM
        days: SEASON_CONFIG.days
    },
    {
        label: 'Phase 2 (Waning Daylight)',
        start: PHASE_2_START,
        end: addDays(PHASE_3_START, -1),
        slotDurationMinutes: 50,
        startTimes: ['16:00', '16:50', '17:40'], // 4:00, 4:50, 5:40
        days: SEASON_CONFIG.days
    },
    {
        label: 'Phase 3 (Pre-DST/End of Regular)',
        start: PHASE_3_START,
        end: '2025-10-31',
        slotDurationMinutes: 40,
        startTimes: ['16:00', '16:40', '17:20'], // 4:00, 4:40, 5:20
        days: SEASON_CONFIG.days
    },
    {
        label: 'Post-Season (Limited)',
        start: POST_SEASON_START,
        end: SEASON_CONFIG.end,
        slotDurationMinutes: 40,
        startTimes: ['16:00', '16:40'], // Reduced slots?
        days: SEASON_CONFIG.days
    }
];

// Lighted Fields Schedule (Consistent)
const LIGHTED_SCHEDULE = {
    label: 'Lighted Field Standard',
    start: SEASON_CONFIG.start,
    end: SEASON_CONFIG.end,
    slotDurationMinutes: 60,
    startTimes: ['17:00', '18:00', '19:00', '20:00'], // 5-9 PM
    days: SEASON_CONFIG.days
};

// ==========================================
// LOGIC
// ==========================================

async function getSeasonId() {
    const { data, error } = await supabase
        .from('season_settings')
        .select('id')
        .eq('season_label', SEASON_CONFIG.label)
        .eq('season_year', SEASON_CONFIG.year)
        .single();

    if (error || !data) {
        console.log('Season not found, creating...');
        const { data: newSeason, error: createError } = await supabase
            .from('season_settings')
            .insert({
                season_label: SEASON_CONFIG.label,
                season_year: SEASON_CONFIG.year,
                season_start: SEASON_CONFIG.start,
                season_end: SEASON_CONFIG.end
            })
            .select('id')
            .single();
        if (createError) throw createError;
        return newSeason.id;
    }
    return data.id;
}

async function getOrCreateSubunits(fieldId, name) {
    const { data: existing } = await supabase
        .from('field_subunits')
        .select('id, label')
        .eq('field_id', fieldId);

    if (existing && existing.length >= 2) return existing;

    const subunits = [];
    for (const label of ['A', 'B']) {
        const { data: sub, error } = await supabase
            .from('field_subunits')
            .insert({ field_id: fieldId, label: label })
            .select()
            .single();
        if (error) throw error;
        subunits.push(sub);
    }
    return subunits;
}

function addMinutes(timeStr, mins) {
    const [h, m] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setHours(h, m + mins, 0);
    return date.toTimeString().slice(0, 5);
}

async function generateSlots() {
    console.log('Generating Practice Slots...');
    console.log('Configuration:', JSON.stringify(PHASES, null, 2));

    const seasonId = await getSeasonId();

    // Fetch Fields
    const { data: fields, error: fError } = await supabase
        .from('fields')
        .select(`
            id, name, supports_halves, active,
            locations (
                id, name, lighting_available
            )
        `)
        .eq('active', true);

    if (fError) {
        console.error('Error fetching fields:', fError);
        return;
    }

    // Clear existing slots for this season (optional, but good for idempotency if we link slots to season)
    // Currently slots are not directly linked to season_settings, but valid_from/until implies it.
    // For safety, let's just append or maybe delete all slots for these fields?
    // Let's DELETE existing slots for these fields to avoid duplicates on re-run.
    const fieldIds = fields.map(f => f.id);
    if (fieldIds.length > 0) {
        await supabase.from('practice_slots').delete().in('field_id', fieldIds);
        console.log('Cleared existing slots for active fields.');
    }

    let slotCount = 0;

    for (const field of fields) {
        const hasLights = field.locations.lighting_available;
        const useHalves = field.supports_halves;
        let subunits = [];

        if (useHalves) {
            subunits = await getOrCreateSubunits(field.id, field.name);
        }

        // Determine Rules to Apply
        let rules = [];
        if (hasLights) {
            rules.push(LIGHTED_SCHEDULE);
        } else {
            rules = PHASES;
        }

        // Generate Slots
        for (const rule of rules) {
            for (const startTime of rule.startTimes) {
                const endTime = addMinutes(startTime, rule.slotDurationMinutes);

                for (const day of rule.days) {
                    if (useHalves) {
                        for (const sub of subunits) {
                            const slot = {
                                field_id: field.id,
                                field_subunit_id: sub.id,
                                day_of_week: day,
                                start_time: startTime,
                                end_time: endTime,
                                valid_from: rule.start,
                                valid_until: rule.end,
                                label: `${rule.label} - ${rule.slotDurationMinutes}m - ${sub.label}`,
                                capacity: 1
                            };

                            const { error } = await supabase.from('practice_slots').insert(slot);
                            if (error) console.error('Slot insert error:', error.message);
                            else slotCount++;
                        }
                    } else {
                        const slot = {
                            field_id: field.id,
                            field_subunit_id: null,
                            day_of_week: day,
                            start_time: startTime,
                            end_time: endTime,
                            valid_from: rule.start,
                            valid_until: rule.end,
                            label: `${rule.label} - ${rule.slotDurationMinutes}m`,
                            capacity: 1
                        };

                        const { error } = await supabase.from('practice_slots').insert(slot);
                        if (error) console.error('Slot insert error:', error.message);
                        else slotCount++;
                    }
                }
            }
        }
    }

    console.log(`Generated ${slotCount} practice slots.`);
}

generateSlots();
