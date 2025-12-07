import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Phase 5 Advanced Data...');

    // 1. Check Players with Location/Timezone
    const { data: players, error: pError } = await supabase
        .from('players')
        .select('first_name, location_lat, location_lng, timezone, flags')
        .not('location_lat', 'is', null)
        .limit(5);

    if (pError) console.error('Player query error:', pError);
    else {
        console.log('\n--- Players Advanced Data Sample ---');
        if (players.length === 0) console.log('No players found with location data yet.');
        players.forEach(p => {
            console.log(`Player: ${p.first_name}`);
            console.log(`Location: ${p.location_lat}, ${p.location_lng}`);
            console.log(`Timezone: ${p.timezone}`);
            console.log(`Flags: ${JSON.stringify(p.flags)}`);
            console.log('---');
        });
    }

    // 2. Check Coaches with Location/Timezone
    const { data: coaches, error: cError } = await supabase
        .from('coaches')
        .select('full_name, location_lat, location_lng, timezone, flags')
        .limit(3);

    if (cError) console.error('Coach query error:', cError);
    else {
        console.log('\n--- Coaches Advanced Data Sample ---');
        coaches.forEach(c => {
            console.log(`Coach: ${c.full_name}`);
            console.log(`Location: ${c.location_lat}, ${c.location_lng}`);
            console.log(`Timezone: ${c.timezone}`);
            console.log(`Flags: ${JSON.stringify(c.flags)}`);
            console.log('---');
        });
    }
}

main();
