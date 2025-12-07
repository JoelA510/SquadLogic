import { createClient } from '@supabase/supabase-js';
// Load env vars via shell source
// import dotenv from 'dotenv';
// dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Bypass RLS

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testInsert() {
    console.log('Fetching season_settings_id...');
    const { data: settings, error: settingsError } = await supabase
        .from('season_settings')
        .select('id')
        .limit(1)
        .single();

    if (settingsError) {
        console.error('Failed to fetch season settings:', settingsError);
        return;
    }

    console.log('Attempting to insert into scheduler_runs with season_settings_id:', settings.id);
    const { data, error } = await supabase
        .from('scheduler_runs')
        .insert({
            season_settings_id: settings.id,
            run_type: 'team',
            status: 'running',
            metrics: { progress: 0, test: true },
            started_at: new Date().toISOString()
        })
        .select();

    if (error) {
        console.error('Insert failed:', error);
    } else {
        console.log('Insert successful:', data);
    }
}

testInsert();
