import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Phase 2 Data...');

    // Check Players with Medical Info
    const { data: playersWithMedical, error: pError } = await supabase
        .from('players')
        .select('id, first_name, medical_info')
        .not('medical_info', 'is', null)
        .limit(5);

    if (pError) console.error('Player query error:', pError);
    else {
        console.log('\n--- Players with Medical Info ---');
        playersWithMedical.forEach(p => {
            console.log(`${p.first_name}:`, JSON.stringify(p.medical_info));
        });
    }

    // Check Players with History
    const { data: playersWithHistory, error: hError } = await supabase
        .from('players')
        .select('id, first_name, registration_history')
        .not('registration_history', 'is', null)
        .limit(5);

    if (hError) console.error('History query error:', hError);
    else {
        console.log('\n--- Players with Registration History ---');
        playersWithHistory.forEach(p => {
            // Only show if history is not empty array
            if (Array.isArray(p.registration_history) && p.registration_history.length > 0) {
                console.log(`${p.first_name}:`, JSON.stringify(p.registration_history).substring(0, 100) + '...');
            }
        });
    }

    // Check Coaches with Certifications
    const { data: coaches, error: cError } = await supabase
        .from('coaches')
        .select('full_name, certifications')
        .limit(5);

    if (cError) console.error('Coach query error:', cError);
    else {
        console.log('\n--- Coaches with Certifications ---');
        coaches.forEach(c => {
            console.log(`${c.full_name}:`, JSON.stringify(c.certifications, null, 2));
        });
    }
}

main();
