import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Phase 3 Data...');

    // Check Players with Contact Info
    const { data: players, error: pError } = await supabase
        .from('players')
        .select('first_name, contact_info, emergency_contacts, medical_info')
        .limit(5);

    if (pError) console.error('Player query error:', pError);
    else {
        console.log('\n--- Players Data Sample ---');
        players.forEach(p => {
            console.log(`\nPlayer: ${p.first_name}`);
            console.log('Contact:', JSON.stringify(p.contact_info).substring(0, 100) + '...');
            console.log('Emergency:', JSON.stringify(p.emergency_contacts));
            console.log('Medical (Expanded):', JSON.stringify(p.medical_info).substring(0, 100) + '...');
        });
    }

    // Check Coaches with Contact Info
    const { data: coaches, error: cError } = await supabase
        .from('coaches')
        .select('full_name, contact_info')
        .limit(3);

    if (cError) console.error('Coach query error:', cError);
    else {
        console.log('\n--- Coaches Data Sample ---');
        coaches.forEach(c => {
            console.log(`\nCoach: ${c.full_name}`);
            console.log('Contact:', JSON.stringify(c.contact_info));
        });
    }
}

main();
