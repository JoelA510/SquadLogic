import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    const { count: playerCount, error: pError } = await supabase
        .from('players')
        .select('*', { count: 'exact', head: true });

    if (pError) console.error('Player count error:', pError);
    else console.log('Players in DB:', playerCount);

    const { count: coachCount, error: cError } = await supabase
        .from('coaches')
        .select('*', { count: 'exact', head: true });

    if (cError) console.error('Coach count error:', cError);
    else console.log('Coaches in DB:', coachCount);

    const { count: divCount } = await supabase
        .from('divisions')
        .select('*', { count: 'exact', head: true });
    console.log('Divisions in DB:', divCount);
}

main();
