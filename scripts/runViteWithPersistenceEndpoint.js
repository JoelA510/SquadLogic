import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurePersistenceEndpoint } from './configurePersistenceEndpoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const viteCommand = process.argv[2] || 'build';
const viteArgs = [viteCommand, ...process.argv.slice(3)];

// The derived value reaches Vite through the child's environment.
configurePersistenceEndpoint(process.env);

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const viteProcess = spawn(npmCommand, ['exec', 'vite', ...viteArgs], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
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
