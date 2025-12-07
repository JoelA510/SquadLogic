import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Phase 6 Schema Updates...');

    // Attempt to select the new columns. If they don't exist, this will error.
    const { data, error } = await supabase
        .from('fields')
        .select('id, name, max_age, priority_rating, active')
        .limit(1);

    if (error) {
        console.error('Verification Failed:', error.message);
        process.exit(1);
    } else {
        console.log('Success! Columns exist.');
        console.log('Sample data (or empty):', data);
    }

    // Optional: Insert a test field to verify constraints/defaults
    const testFieldName = `Test Field ${Date.now()}`;
    // We need a location first
    const { data: loc } = await supabase.from('locations').select('id').limit(1).single();

    if (loc) {
        const { data: newField, error: insertError } = await supabase
            .from('fields')
            .insert({
                location_id: loc.id,
                name: testFieldName,
                max_age: 'U12',
                priority_rating: 5,
                active: true
            })
            .select()
            .single();

        if (insertError) {
            console.error('Insert Failed:', insertError.message);
        } else {
            console.log('Successfully inserted test field with new columns:', newField);
            // Cleanup
            await supabase.from('fields').delete().eq('id', newField.id);
            console.log('Cleaned up test field.');
        }
    } else {
        console.log('No locations found, skipping insert test.');
    }
}

main();
