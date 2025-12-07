import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Levenshtein Distance for Fuzzy Matching
function levenshtein(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

async function runTeamingEngine() {
    console.log('Running Teaming Engine...');

    // 1. Coach Assignment Logic
    console.log('\n--- Coach Assignment Analysis ---');

    // Priority 1: Registered Coaches
    const { data: activeCoaches } = await supabase
        .from('coaches')
        .select('id, full_name, email')
        .eq('status', 'active');

    console.log(`Priority 1 (Registered): ${activeCoaches?.length || 0} coaches found.`);

    // Priority 2: Parents Willing to Coach
    const { data: parentCoaches } = await supabase
        .from('players')
        .select('id, first_name, last_name, guardian_contacts')
        .eq('willing_to_coach', true);

    console.log(`Priority 2 (Parents): ${parentCoaches?.length || 0} potential coaches found.`);

    // Priority 3: Historical (Simulated by checking inactive coaches or just noting it)
    // For now, we'll just list inactive coaches
    const { data: historicalCoaches } = await supabase
        .from('coaches')
        .select('id, full_name')
        .eq('status', 'inactive');

    console.log(`Priority 3 (Historical): ${historicalCoaches?.length || 0} inactive coaches found.`);


    // 2. Buddy Validation Logic
    console.log('\n--- Buddy Request Validation ---');

    const { data: playersWithRequests } = await supabase
        .from('players')
        .select('id, first_name, last_name, buddy_request')
        .not('buddy_request', 'is', null);

    if (!playersWithRequests || playersWithRequests.length === 0) {
        console.log('No buddy requests found.');
    } else {
        // Fetch all players to match against
        const { data: allPlayers } = await supabase
            .from('players')
            .select('id, first_name, last_name');

        const playerMap = new Map(allPlayers.map(p => [`${p.first_name} ${p.last_name}`.toLowerCase(), p]));

        for (const p of playersWithRequests) {
            const request = p.buddy_request.toLowerCase();
            const fullName = `${p.first_name} ${p.last_name}`;

            // Exact Match
            if (playerMap.has(request)) {
                console.log(`[MATCH] ${fullName} <-> ${playerMap.get(request).first_name} ${playerMap.get(request).last_name}`);
            } else {
                // Fuzzy Match
                let bestMatch = null;
                let minDist = Infinity;

                for (const [name, targetPlayer] of playerMap) {
                    const dist = levenshtein(request, name);
                    if (dist < minDist) {
                        minDist = dist;
                        bestMatch = targetPlayer;
                    }
                }

                if (minDist <= 3) { // Threshold for "close enough"
                    console.log(`[FUZZY] ${fullName} requested "${p.buddy_request}" -> Found "${bestMatch.first_name} ${bestMatch.last_name}" (Dist: ${minDist})`);
                } else {
                    console.log(`[FAIL] ${fullName} requested "${p.buddy_request}" -> No close match found.`);
                }
            }
        }
    }
}

runTeamingEngine();
