import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const lighthouseDir = path.join(__dirname, '../Lighthouse');

if (!fs.existsSync(lighthouseDir)) {
    console.error(`Directory not found: ${lighthouseDir}`);
    process.exit(1);
}

const files = fs.readdirSync(lighthouseDir).filter(f => f.endsWith('.json'));

const results = [];

files.forEach(file => {
    const filePath = path.join(lighthouseDir, file);
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const report = JSON.parse(data);

        const categories = report.categories;
        const scores = {
            file: file,
            performance: categories.performance ? Math.round(categories.performance.score * 100) : 'N/A',
            accessibility: categories.accessibility ? Math.round(categories.accessibility.score * 100) : 'N/A',
            bestPractices: categories['best-practices'] ? Math.round(categories['best-practices'].score * 100) : 'N/A',
            seo: categories.seo ? Math.round(categories.seo.score * 100) : 'N/A',
        };

        // Find top failed audits (score < 1 and high impact)
        const audits = report.audits;
        const failedAudits = Object.values(audits)
            .filter(audit => audit.score !== null && audit.score < 1 && audit.scoreDisplayMode !== 'informative' && audit.scoreDisplayMode !== 'manual')
            .sort((a, b) => (a.score || 0) - (b.score || 0)) // Lower score first
            .slice(0, 5) // Top 5
            .map(a => ({
                id: a.id,
                title: a.title,
                score: a.score
            }));

        results.push({ scores, failedAudits });

    } catch (err) {
        console.error(`Error parsing ${file}:`, err.message);
    }
});

// Print Markdown Table
console.log('| Page | Performance | Accessibility | Best Practices | SEO |');
console.log('|---|---|---|---|---|');
results.forEach(r => {
    const s = r.scores;
    console.log(`| ${s.file.replace('.json', '')} | ${s.performance} | ${s.accessibility} | ${s.bestPractices} | ${s.seo} |`);
});

console.log('\n## Top Issues per Page');
results.forEach(r => {
    console.log(`\n### ${r.scores.file.replace('.json', '')}`);
    if (r.failedAudits.length === 0) {
        console.log('No major issues found.');
    } else {
        r.failedAudits.forEach(a => {
            console.log(`- **${a.title}** (Score: ${a.score})`);
        });
    }
});
