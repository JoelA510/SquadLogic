import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Phase 4 Robustness...');

    // 1. Check Tracking Columns Stats
    const { count: processedPlayers, error: ppError } = await supabase
        .from('players')
        .select('*', { count: 'exact', head: true })
        .not('last_imported_at', 'is', null);

    if (ppError) console.error('Player count error:', ppError);
    else console.log(`Players Processed (with timestamp): ${processedPlayers}`);

    const { count: processedCoaches, error: pcError } = await supabase
        .from('coaches')
        .select('*', { count: 'exact', head: true })
        .not('last_imported_at', 'is', null);

    if (pcError) console.error('Coach count error:', pcError);
    else console.log(`Coaches Processed (with timestamp): ${processedCoaches}`);
}

main();
