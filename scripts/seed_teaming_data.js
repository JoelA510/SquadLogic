import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seedTeamingData() {
    console.log('Seeding Teaming Test Data...');

    // 1. Set Willing to Coach
    // Let's pick a few players to be "Parent Coaches"
    const { data: potentialCoaches } = await supabase
        .from('players')
        .select('id, first_name')
        .limit(3);

    if (potentialCoaches && potentialCoaches.length > 0) {
        const ids = potentialCoaches.map(p => p.id);
        await supabase
            .from('players')
            .update({ willing_to_coach: true })
            .in('id', ids);
        console.log(`Marked ${ids.length} players as willing to coach.`);
    }

    // 2. Set Buddy Requests (with typos)
    // Get some players to be the "Requesters" and "Targets"
    const { data: players } = await supabase
        .from('players')
        .select('id, first_name, last_name')
        .limit(10);

    if (players && players.length >= 4) {
        const p1 = players[0]; // Requester 1
        const p2 = players[1]; // Target 1 (Exact)
        const p3 = players[2]; // Requester 2
        const p4 = players[3]; // Target 2 (Typo)

        // Exact Match
        await supabase
            .from('players')
            .update({ buddy_request: `${p2.first_name} ${p2.last_name}` })
            .eq('id', p1.id);
        console.log(`Set Buddy Request: ${p1.first_name} -> ${p2.first_name} ${p2.last_name} (Exact)`);

        // Typo Match (e.g., "Jon" instead of "John")
        // Let's manually create a typo version of p4's name
        const typoName = `${p4.first_name}x ${p4.last_name}`; // Simple typo
        await supabase
            .from('players')
            .update({ buddy_request: typoName })
            .eq('id', p3.id);
        console.log(`Set Buddy Request: ${p3.first_name} -> ${typoName} (Typo of ${p4.first_name} ${p4.last_name})`);
    }
}

seedTeamingData();
