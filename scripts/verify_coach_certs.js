import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
    console.log('Verifying Coach Certifications...');

    // Check Coaches with Certifications (not empty array)
    // Note: JSONB containment operator @> '[]' matches everything that is an array.
    // We want to find where jsonb_array_length(certifications) > 0, but that's hard with standard select.
    // Let's just fetch all and filter in JS for this check, since there are only 60 coaches.

    // Check specific coach
    const { data: mag, error: mError } = await supabase
        .from('coaches')
        .select('full_name, certifications')
        .ilike('email', '%mag00alvarez%')
        .single();

    if (mError) console.error('Magdaleno query error:', mError);
    else {
        console.log('Magdaleno Certs:', JSON.stringify(mag.certifications, null, 2));
        console.log('Type of certifications:', typeof mag.certifications);
        console.log('Is Array?', Array.isArray(mag.certifications));
    }

    const { data: coaches, error: cError } = await supabase
        .from('coaches')
        .select('full_name, certifications');

    if (cError) console.error('Coach query error:', cError);
    else {
        const withCerts = coaches.filter(c => Array.isArray(c.certifications) && c.certifications.length > 0);
        console.log(`Found ${withCerts.length} coaches with certifications.`);

        if (withCerts.length > 0) {
            console.log('Sample:', JSON.stringify(withCerts[0], null, 2));
        } else {
            console.log('WARNING: No coaches found with certifications.');
        }
    }
}

main();
