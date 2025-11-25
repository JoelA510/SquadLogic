import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurePersistenceEndpoint } from './configurePersistenceEndpoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const envFilePath = path.join(repoRoot, 'frontend', '.env.local');

const viteCommand = process.argv[2] || 'build';
const viteArgs = [viteCommand, ...process.argv.slice(3)];

configurePersistenceEndpoint(process.env, { persistEnvFilePath: envFilePath });

const viteProcess = spawn('vite', viteArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: true,
});

viteProcess.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

viteProcess.on('error', (error) => {
  console.error('Failed to start Vite:', error);
  process.exit(1);
});
