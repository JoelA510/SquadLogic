import fs from 'node:fs';
import Papa from 'papaparse';

const COACHES_CSV_PATH = 'docs/sql/real-samples/coaches.csv';

const fileContent = fs.readFileSync(COACHES_CSV_PATH, 'utf8');
Papa.parse(fileContent, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
    complete: (results) => {
        console.log('Headers:', results.meta.fields);
        console.log('First Row:', results.data[0]);

        const row = results.data[0];
        const certKeys = Object.keys(row).filter(k => k.startsWith('USYS') || k.startsWith('USCLUB'));
        console.log('Cert Keys found:', certKeys);
    }
});
