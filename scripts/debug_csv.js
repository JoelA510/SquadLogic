import fs from 'node:fs';
import Papa from 'papaparse';

const PLAYERS_CSV_PATH = 'docs/sql/real-samples/players-20251206T063259.csv';

const fileContent = fs.readFileSync(PLAYERS_CSV_PATH, 'utf8');
Papa.parse(fileContent, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
    complete: (results) => {
        console.log('Headers:', results.meta.fields);
        console.log('First Row:', results.data[0]);

        const row = results.data[0];
        console.log('Team Age:', row['Team Age']);
        console.log('Gender:', row['Gender']);
    }
});
