import fs from 'node:fs';

const envContent = fs.readFileSync('.env', 'utf8');
const keys = envContent.split('\n')
    .map(line => line.split('=')[0].trim())
    .filter(key => key && !key.startsWith('#'));

console.log('Available keys:', keys);
