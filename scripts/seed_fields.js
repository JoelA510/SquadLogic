import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seedFields() {
    console.log('Seeding Locations and Fields...');

    // 1. Create Locations
    const locations = [
        { name: 'Sunset Park', address: '123 Sunset Blvd', lighting_available: false },
        { name: 'City Stadium', address: '500 Main St', lighting_available: true },
        { name: 'North High School', address: '88 School Ln', lighting_available: true }
    ];

    const locMap = new Map();

    for (const loc of locations) {
        const { data, error } = await supabase
            .from('locations')
            .upsert(loc, { onConflict: 'name' })
            .select()
            .single();

        if (error) console.error(`Error seeding location ${loc.name}:`, error.message);
        else {
            console.log(`Seeded Location: ${loc.name}`);
            locMap.set(loc.name, data.id);
        }
    }

    // 2. Create Fields
    const fields = [
        {
            location_id: locMap.get('Sunset Park'),
            name: 'Field 1',
            surface_type: 'Grass',
            supports_halves: true,
            max_age: 'U12',
            priority_rating: 3,
            active: true
        },
        {
            location_id: locMap.get('Sunset Park'),
            name: 'Field 2',
            surface_type: 'Grass',
            supports_halves: true,
            max_age: 'U10',
            priority_rating: 2,
            active: true
        },
        {
            location_id: locMap.get('City Stadium'),
            name: 'Stadium Field',
            surface_type: 'Turf',
            supports_halves: false, // Full field only
            max_age: 'U19',
            priority_rating: 5,
            active: true
        },
        {
            location_id: locMap.get('North High School'),
            name: 'Varsity Field',
            surface_type: 'Turf',
            supports_halves: true,
            max_age: 'U16',
            priority_rating: 4,
            active: true
        }
    ];

    for (const field of fields) {
        if (!field.location_id) continue;
        const { error } = await supabase
            .from('fields')
            .upsert(field, { onConflict: 'location_id, name' });

        if (error) console.error(`Error seeding field ${field.name}:`, error.message);
        else console.log(`Seeded Field: ${field.name}`);
    }
}

seedFields();
