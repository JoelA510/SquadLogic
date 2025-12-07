import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Rules
// U6-U8 (5v5): Max 8
// U9-U10 (7v7): Max 11
// U11-U12 (9v9): Max 14
// U13+ (11v11): Max 17

function getFormatAndCap(divisionName) {
    const name = divisionName.toUpperCase();

    // Extract Age (Uxx)
    const match = name.match(/U(\d+)/);
    if (!match) return null;

    const age = parseInt(match[1], 10);

    if (age <= 8) return { format: '5v5', cap: 8 };
    if (age <= 10) return { format: '7v7', cap: 11 };
    if (age <= 12) return { format: '9v9', cap: 14 };
    return { format: '11v11', cap: 17 };
}

async function setCaps() {
    console.log('Setting Division Caps...');

    const { data: divisions, error } = await supabase
        .from('divisions')
        .select('id, name');

    if (error) {
        console.error('Error fetching divisions:', error);
        return;
    }

    let updatedCount = 0;

    for (const div of divisions) {
        const rule = getFormatAndCap(div.name);
        if (rule) {
            const { error: updateError } = await supabase
                .from('divisions')
                .update({
                    max_roster_size: rule.cap,
                    format: rule.format
                })
                .eq('id', div.id);

            if (updateError) console.error(`Error updating ${div.name}:`, updateError.message);
            else updatedCount++;
        } else {
            console.log(`Skipping unknown format for: ${div.name}`);
        }
    }

    console.log(`Updated ${updatedCount} divisions.`);
}

setCaps();
