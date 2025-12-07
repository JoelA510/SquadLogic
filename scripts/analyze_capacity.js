import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function analyzeCapacity() {
    console.log('Analyzing Field Capacity & Team Recommendations...');

    // 1. Fetch Data
    const { data: slots, error: sError } = await supabase
        .from('practice_slots')
        .select('id, field_id, day_of_week, start_time, end_time, label');

    const { data: fields, error: fError } = await supabase
        .from('fields')
        .select('id, name, max_age, priority_rating');

    if (sError || fError) {
        console.error('Error fetching data:', sError || fError);
        return;
    }

    // 2. Analyze Field Utilization (Slots per Field)
    const fieldUsage = {};
    fields.forEach(f => {
        fieldUsage[f.id] = { name: f.name, slots: 0, max_age: f.max_age };
    });

    slots.forEach(s => {
        if (fieldUsage[s.field_id]) {
            fieldUsage[s.field_id].slots++;
        }
    });

    console.log('\n--- Field Utilization (Low Usage Warning < 10 slots) ---');
    Object.values(fieldUsage).forEach(f => {
        if (f.slots < 10) {
            console.log(`WARNING: ${f.name} has only ${f.slots} slots generated.`);
        }
    });

    // 3. Calculate Max Teams per Age Group
    // Logic: 
    // - Group fields by max_age (or suitable ages).
    // - Total Slots for that age group / 2 (practices per week) = Max Teams.
    // - Note: This is a simplification. Real logic would need to account for shared fields.

    const ageGroups = ['U8', 'U10', 'U12', 'U14', 'U16', 'U19'];
    const capacityReport = {};

    ageGroups.forEach(age => {
        // Find fields suitable for this age (field.max_age >= age)
        // Simplified string comparison for now, assuming format "Uxx"
        const ageNum = parseInt(age.replace('U', ''));

        let suitableSlots = 0;

        fields.forEach(f => {
            if (!f.max_age) return; // No limit? Assume all? Or none? Let's assume none for safety.
            const fieldMax = parseInt(f.max_age.replace('U', ''));
            if (fieldMax >= ageNum) {
                suitableSlots += fieldUsage[f.id].slots;
            }
        });

        // We need to divide by the number of weeks in the season to get "slots per week"
        // Then divide by 2 practices/team.
        // Our generated slots are "template slots" (Mon-Thu). 
        // So `suitableSlots` is actually "Total Slots Available Per Week" (roughly, if we ignore phases for a moment).
        // Wait, our `practice_slots` table contains ALL slots for the WHOLE season (valid_from/until).
        // So `slots.length` is the total number of slot INSTANCES if we expanded them? 
        // NO. `practice_slots` are definitions. "Every Monday from X to Y".
        // But we have phases. So we have multiple definitions for the same time window.
        // We should count "Unique Slots Per Week" averaged?
        // Let's look at a single week in Phase 1 (Peak Season).

        // Filter slots valid during Phase 1 (Sept 1) OR Lighted Standard
        const phase1Slots = slots.filter(s => {
            return (s.label && s.label.includes('Phase 1')) || (s.label && s.label.includes('Lighted Field'));
        });

        // Count suitable slots in Phase 1
        let phase1Suitable = 0;
        phase1Slots.forEach(s => {
            const f = fields.find(field => field.id === s.field_id);
            if (f && f.max_age) {
                const fieldMax = parseInt(f.max_age.replace('U', ''));
                if (fieldMax >= ageNum) {
                    phase1Suitable++;
                }
            }
        });

        const maxTeams = Math.floor(phase1Suitable / 2); // 2 practices per week
        capacityReport[age] = maxTeams;
    });

    console.log('\n--- Recommended Max Teams (Based on Phase 1 Capacity) ---');
    console.table(capacityReport);
}

analyzeCapacity();
