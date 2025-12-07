import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectData() {
    console.log('Inspecting Player Data for Teaming Logic...');

    // 1. Check Guardian Contacts for "Coach" indicators
    const { data: players, error } = await supabase
        .from('players')
        .select('id, first_name, guardian_contacts, notes')
        .limit(20);

    if (error) {
        console.error('Error fetching players:', error);
        return;
    }

    console.log('\n--- Guardian Contacts Sample ---');
    players.slice(0, 5).forEach(p => {
        console.log(`Player: ${p.first_name}`);
        console.log('Guardians:', JSON.stringify(p.guardian_contacts, null, 2));
        console.log('Notes:', p.notes);
        console.log('---');
    });

    // 2. Check for potential Buddy Request columns in the raw CSV headers (if we missed any)
    // We can't check CSV here easily, but we can check if 'notes' contains buddy info.
    // Or check if there are other columns in 'players' we missed.

    // Let's check if any notes look like buddy requests
    console.log('\n--- Potential Buddy Requests in Notes ---');
    const buddyNotes = players.filter(p => p.notes && (
        p.notes.toLowerCase().includes('buddy') ||
        p.notes.toLowerCase().includes('friend') ||
        p.notes.toLowerCase().includes('request')
    ));

    if (buddyNotes.length > 0) {
        buddyNotes.forEach(p => {
            console.log(`Player: ${p.first_name}, Note: ${p.notes}`);
        });
    } else {
        console.log('No obvious buddy keywords in sample notes.');
    }
}

inspectData();
