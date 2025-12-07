import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import Papa from 'papaparse';

const PLAYERS_CSV_PATH = 'docs/sql/real-samples/players-20251206T063259.csv';
const COACHES_CSV_PATH = 'docs/sql/real-samples/coaches.csv';

// Initialize Supabase
const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Error: Supabase URL and Key must be provided via environment variables.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function parseCsv(filePath) {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    return new Promise((resolve, reject) => {
        Papa.parse(fileContent, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
            error: (error) => reject(error),
        });
    });
}

async function getOrCreateSeason() {
    const seasonLabel = 'Fall 2025'; // Default or derived
    const seasonYear = 2025;

    const { data: existing } = await supabase
        .from('season_settings')
        .select('id')
        .eq('season_label', seasonLabel)
        .eq('season_year', seasonYear)
        .single();

    if (existing) return existing.id;

    const { data: newSeason, error } = await supabase
        .from('season_settings')
        .insert({
            season_label: seasonLabel,
            season_year: seasonYear,
            season_start: '2025-09-01',
            season_end: '2025-12-01',
        })
        .select('id')
        .single();

    if (error) throw new Error(`Failed to create season: ${error.message}`);
    return newSeason.id;
}

// Normalization Helpers
function normalizePhone(phone) {
    if (!phone) return null;
    // Remove non-digits
    const digits = phone.replace(/\D/g, '');
    // If 10 digits, add +1
    if (digits.length === 10) return `+1${digits}`;
    // If 11 digits starting with 1, add +
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    // Return original if unsure (or maybe null? keeping original is safer for now)
    return phone;
}

function normalizeState(state) {
    if (!state) return null;
    const s = state.trim().toLowerCase();
    if (s === 'california' || s === 'ca') return 'CA';
    // Add more mappings as needed
    return state.trim().toUpperCase().substring(0, 2);
}

async function getOrCreateDivision(seasonId, age, gender) {
    // Normalize gender
    let genderPolicy = 'coed';
    if (gender.toLowerCase().startsWith('f') || gender.toLowerCase() === 'girls') genderPolicy = 'girls';
    if (gender.toLowerCase().startsWith('m') || gender.toLowerCase() === 'boys') genderPolicy = 'boys';

    const name = `${age} ${genderPolicy === 'girls' ? 'Girls' : genderPolicy === 'boys' ? 'Boys' : 'Coed'}`;

    const { data: existing } = await supabase
        .from('divisions')
        .select('id')
        .eq('season_settings_id', seasonId)
        .eq('name', name)
        .single();

    if (existing) return existing.id;

    const { data: newDivision, error } = await supabase
        .from('divisions')
        .insert({
            season_settings_id: seasonId,
            name: name,
            gender_policy: genderPolicy,
            max_roster_size: 14, // Default
            play_format: '7v7', // Default, maybe derive from age later
            season_start: '2025-09-01',
            season_end: '2025-12-01',
        })
        .select('id')
        .single();

    if (error) throw new Error(`Failed to create division ${name}: ${error.message}`);
    return newDivision.id;
}

async function importPlayers(seasonId) {
    console.log('Importing players...');
    const players = await parseCsv(PLAYERS_CSV_PATH);
    const divisionCache = new Map();

    // Validation Stats
    const stats = {
        total: players.length,
        processed: 0,
        skipped: 0,
        missingAgeGender: 0,
        missingEmail: 0,
        missingPhone: 0,
        missingEmergency: 0
    };

    // Soft Delete Prep: Get all currently active players
    const { data: existingPlayers } = await supabase
        .from('players')
        .select('id, external_registration_id')
        .eq('status', 'active');

    const activePlayerIds = new Set((existingPlayers || []).map(p => p.id));
    const touchedPlayerIds = new Set();

    for (const row of players) {
        let age = row['Team Age'];
        const gender = row['Gender'];

        if (age && age.includes(';')) {
            age = age.split(';')[0].trim();
        }

        if (!age && row['Birthdate']) {
            const birthYear = new Date(row['Birthdate']).getFullYear();
            if (!isNaN(birthYear)) {
                age = `U${2025 - birthYear + 1}`; // Fall 2025 season
            }
        }

        if (!age || !gender) {
            console.warn(`Skipping player ${row['Id']}: Missing Age (${row['Team Age']}) or Gender (${row['Gender']})`);
            stats.skipped++;
            stats.missingAgeGender++;
            continue;
        }

        const divKey = `${age}-${gender}`;
        let divisionId = divisionCache.get(divKey);
        if (!divisionId) {
            divisionId = await getOrCreateDivision(seasonId, age, gender);
            divisionCache.set(divKey, divisionId);
        }

        // Construct Guardian Contacts
        const guardians = [];
        if (row['Parent One First Name']) {
            guardians.push({
                first_name: row['Parent One First Name'],
                last_name: row['Parent One Last Name'],
                email: row['Parent One Email'],
                phone: normalizePhone(row['Parent One Phone Number']),
                address: row['Parent One Address1'],
                city: row['Parent One City'],
                state: normalizeState(row['Parent One State']),
                zip: row['Parent One Zip'],
            });
        }
        if (row['Parent Two First Name']) {
            guardians.push({
                first_name: row['Parent Two First Name'],
                last_name: row['Parent Two Last Name'],
                email: row['Parent Two Email'],
                phone: normalizePhone(row['Parent Two Phone Number']),
            });
        }

        // Notes
        const notes = [
            row['Allergies'] !== 'N/a' ? `Allergies: ${row['Allergies']}` : null,
            row['Medical Conditions'] !== 'N/a' ? `Medical: ${row['Medical Conditions']}` : null,
        ].filter(Boolean).join('; ');

        // Medical Info
        const medicalInfo = {
            allergies: row['Allergies'] !== 'N/a' ? row['Allergies'] : null,
            conditions: row['Medical Conditions'] !== 'N/a' ? row['Medical Conditions'] : null,
            physician: {
                name: `${row['Physician First Name']} ${row['Physician Last Name']}`.trim(),
                phone: normalizePhone(row['Physician Phone Number']),
                alt_phone: normalizePhone(row['Physician Alternate Phone Number'])
            },
            insurance: {
                holder_name: `${row['Insurance Holder First Name']} ${row['Insurance Holder Last Name']}`.trim(),
                provider: row['Insurance Provider'],
                provider_phone: normalizePhone(row['Insurance Provider Phone']),
                policy_number: row['Insurance Policy Number']
            }
        };

        // Contact Info
        const contactInfo = {
            address: row['Address'],
            address_2: row['Address (Continued)'],
            city: row['City'],
            state: normalizeState(row['State/Province']),
            zip: row['Postal Code'],
            country: row['Country'],
            phone: normalizePhone(row['Mobile Phone Number']),
            alt_phone: normalizePhone(row['Alternate Phone Number']),
            email: row['Email'], // Player's own email
            alt_email: row['Alternate Email']
        };

        // Validation Checks
        if (!contactInfo.email && !guardians.some(g => g.email)) stats.missingEmail++;
        if (!contactInfo.phone && !guardians.some(g => g.phone)) stats.missingPhone++;

        // Emergency Contacts
        const emergencyContacts = [];
        if (row['Emergency Contact One First Name']) {
            emergencyContacts.push({
                name: `${row['Emergency Contact One First Name']} ${row['Emergency Contact One Last Name']}`.trim(),
                phone: normalizePhone(row['Emergency Contact One Phone Number']),
                alt_phone: normalizePhone(row['Emergency Contact One Alternate Phone Number'])
            });
        }
        if (row['Emergency Contact Two First Name']) {
            emergencyContacts.push({
                name: `${row['Emergency Contact Two First Name']} ${row['Emergency Contact Two Last Name']}`.trim(),
                phone: normalizePhone(row['Emergency Contact Two Phone Number']),
                alt_phone: normalizePhone(row['Emergency Contact Two Alternate Phone Number'])
            });
        }

        if (emergencyContacts.length === 0) stats.missingEmergency++;

        // Registration History
        const history = [];
        const teamNames = (row['Team Name'] || '').split(';');
        const teamLegacies = (row['Team Legacy'] || '').split(';');
        const teamAges = (row['Team Age'] || '').split(';');

        for (let i = 0; i < teamNames.length; i++) {
            const tName = teamNames[i].trim();
            if (tName) {
                history.push({
                    team_name: tName,
                    legacy_id: teamLegacies[i] ? teamLegacies[i].trim() : null,
                    team_age: teamAges[i] ? teamAges[i].trim() : null,
                });
            }
        }

        // Skill Tier
        let skillTier = 'novice';
        const compLevel = row['Competitive Level Name'];
        if (compLevel === 'Competitive') skillTier = 'advanced';
        else if (compLevel === 'Recreational') skillTier = 'novice';

        // Flags
        const flags = (row['Flags'] || '').split(';').map(f => f.trim()).filter(Boolean);

        const playerData = {
            division_id: divisionId,
            external_registration_id: row['Id'],
            first_name: row['First Name'],
            last_name: row['Last Name'],
            date_of_birth: row['Birthdate'] || null,
            guardian_contacts: guardians,
            skill_tier: skillTier,
            notes: notes, // Keep notes for backward compatibility or general info
            medical_info: medicalInfo,
            registration_history: history,
            contact_info: contactInfo,
            emergency_contacts: emergencyContacts,
            status: 'active',
            last_imported_at: new Date().toISOString(),
            import_source: 'gotsport_csv_2025',
            location_lat: row['Latitude'] ? parseFloat(row['Latitude']) : null,
            location_lng: row['Longitude'] ? parseFloat(row['Longitude']) : null,
            timezone: row['Time Zone Name'],
            flags: flags
        };

        const { data: upserted, error } = await supabase
            .from('players')
            .upsert(playerData, { onConflict: 'division_id, external_registration_id' })
            .select('id')
            .single();

        if (error) {
            console.error(`Failed to upsert player ${row['Id']}: ${error.message}`);
        } else {
            stats.processed++;
            if (upserted) touchedPlayerIds.add(upserted.id);
        }
    }

    // Soft Delete Logic
    let deactivatedCount = 0;
    for (const id of activePlayerIds) {
        if (!touchedPlayerIds.has(id)) {
            await supabase.from('players').update({ status: 'inactive' }).eq('id', id);
            deactivatedCount++;
        }
    }

    console.log('--- Player Import Summary ---');
    console.table(stats);
    console.log(`Deactivated ${deactivatedCount} players not found in this import.`);
}

async function importCoaches() {
    console.log('Importing coaches...');
    const coaches = await parseCsv(COACHES_CSV_PATH);

    // Validation Stats
    const stats = {
        total: coaches.length,
        processed: 0,
        skipped: 0,
    };

    // Soft Delete Prep
    const { data: existingCoaches } = await supabase
        .from('coaches')
        .select('id, email')
        .eq('status', 'active');

    const activeCoachIds = new Set((existingCoaches || []).map(c => c.id));
    const touchedCoachIds = new Set();

    for (const row of coaches) {
        const email = row['Email'];
        if (!email) {
            console.warn('Skipping coach with no email');
            stats.skipped++;
            continue;
        }

        const certs = [];
        const processedKeys = new Set();
        Object.keys(row).forEach(key => {
            if ((key.startsWith('USYS') || key.startsWith('USCLUB')) && !key.includes('Expiration') && !processedKeys.has(key)) {
                const certName = key;
                let status = row[key];
                const expirationKey = `${key} Expiration`;
                const expiration = row[expirationKey];

                if (status) status = status.trim();

                if (status && status !== 'N/A' && status !== 'None') {
                    certs.push({
                        name: certName,
                        status: status,
                        expiration: expiration || null
                    });
                }
                processedKeys.add(key);
            }
        });

        const contactInfo = {
            address: row['Address'],
            address_2: row['Address (Continued)'],
            city: row['City'],
            state: normalizeState(row['State/Province']),
            zip: row['Postal Code'],
            country: row['Country'],
            phone: normalizePhone(row['Mobile Phone Number']),
            alt_phone: normalizePhone(row['Alternate Phone Number']),
            email: row['Email'],
            alt_email: row['Alternate Email']
        };

        // Flags (Coaches might not have Flags column in sample, but good to be safe/consistent if it exists)
        const flags = (row['Flags'] || '').split(';').map(f => f.trim()).filter(Boolean);

        const coachData = {
            email: email,
            full_name: `${row['First Name']} ${row['Last Name']}`,
            phone: normalizePhone(row['Mobile Phone Number']),
            certifications: certs,
            contact_info: contactInfo,
            status: 'active',
            last_imported_at: new Date().toISOString(),
            import_source: 'gotsport_csv_2025',
            location_lat: row['Latitude'] ? parseFloat(row['Latitude']) : null,
            location_lng: row['Longitude'] ? parseFloat(row['Longitude']) : null,
            timezone: row['Time Zone Name'],
            flags: flags
        };

        const { data: upserted, error } = await supabase
            .from('coaches')
            .upsert(coachData, { onConflict: 'email' })
            .select('id')
            .single();

        if (error) {
            console.error(`Failed to upsert coach ${email}: ${error.message}`);
        } else {
            stats.processed++;
            if (upserted) touchedCoachIds.add(upserted.id);
        }
    }

    // Soft Delete Logic
    let deactivatedCount = 0;
    for (const id of activeCoachIds) {
        if (!touchedCoachIds.has(id)) {
            await supabase.from('coaches').update({ status: 'inactive' }).eq('id', id);
            deactivatedCount++;
        }
    }

    console.log('--- Coach Import Summary ---');
    console.table(stats);
    console.log(`Deactivated ${deactivatedCount} coaches not found in this import.`);
}

async function main() {
    try {
        const seasonId = await getOrCreateSeason();
        console.log(`Using Season ID: ${seasonId}`);

        await importPlayers(seasonId);
        await importCoaches();

        console.log('Import completed successfully.');
    } catch (err) {
        console.error('Import failed:', err);
        process.exit(1);
    }
}

main();
