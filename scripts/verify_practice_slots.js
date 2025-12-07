import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Practice Slots...');

    // 1. Check Total Count
    const { count, error: cError } = await supabase
        .from('practice_slots')
        .select('*', { count: 'exact', head: true });

    if (cError) console.error('Count error:', cError);
    else console.log(`Total Slots: ${count}`);

    // 2. Check Sample of Unlighted Field (should have phases)
    // Find an unlighted field
    const { data: unlitField } = await supabase
        .from('fields')
        .select('id, name, locations!inner(lighting_available)')
        .eq('locations.lighting_available', false)
        .limit(1)
        .single();

    if (unlitField) {
        console.log(`\n--- Unlighted Field: ${unlitField.name} ---`);
        const { data: slots } = await supabase
            .from('practice_slots')
            .select('label, valid_from, valid_until, start_time, end_time')
            .eq('field_id', unlitField.id)
            .eq('day_of_week', 'mon') // Check Mondays
            .order('valid_from', { ascending: true })
            .order('start_time', { ascending: true });

        if (slots) {
            slots.forEach(s => {
                console.log(`[${s.valid_from} to ${s.valid_until}] ${s.start_time}-${s.end_time} (${s.label})`);
            });
        }
    } else {
        console.log('No unlighted fields found.');
    }

    // 3. Check Sample of Lighted Field (should be consistent)
    const { data: litField } = await supabase
        .from('fields')
        .select('id, name, locations!inner(lighting_available)')
        .eq('locations.lighting_available', true)
        .limit(1)
        .single();

    if (litField) {
        console.log(`\n--- Lighted Field: ${litField.name} ---`);
        const { data: slots } = await supabase
            .from('practice_slots')
            .select('label, valid_from, valid_until, start_time, end_time')
            .eq('field_id', litField.id)
            .eq('day_of_week', 'mon')
            .order('valid_from', { ascending: true })
            .order('start_time', { ascending: true });

        if (slots) {
            slots.forEach(s => {
                console.log(`[${s.valid_from} to ${s.valid_until}] ${s.start_time}-${s.end_time} (${s.label})`);
            });
        }
    } else {
        console.log('No lighted fields found.');
    }
}

main();
