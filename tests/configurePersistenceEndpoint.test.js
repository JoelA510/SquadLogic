import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { configurePersistenceEndpoint } from '../scripts/configurePersistenceEndpoint.js';

function createTempFile(initialContents = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-env-'));
  const filePath = path.join(dir, '.env.local');
  fs.writeFileSync(filePath, initialContents);
  return { dir, filePath };
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const derivedEndpoint = 'https://example.supabase.co/functions/v1';

function buildEnv() {
  return { SUPABASE_URL: 'https://example.supabase.co' };
}

const tempDirs = [];

function trackDir(dir) {
  tempDirs.push(dir);
  return dir;
}

after(() => {
  tempDirs.forEach((dir) => cleanupTempDir(dir));
});

describe('configurePersistenceEndpoint env persistence', () => {
  it('updates existing key while preserving comments and blank lines', () => {
    const { dir, filePath } = createTempFile(
      ['# existing comment', '', 'FOO=bar', 'VITE_SUPABASE_PERSISTENCE_URL=old', 'BAZ=qux', ''].join('\n'),
    );
    trackDir(dir);

    const env = buildEnv();
    configurePersistenceEndpoint(env, { persistEnvFilePath: filePath, persistDerivedValue: true });

    const contents = fs.readFileSync(filePath, 'utf8');
    assert.equal(
      contents,
      ['# existing comment', '', 'FOO=bar', `VITE_SUPABASE_PERSISTENCE_URL=${derivedEndpoint}`, 'BAZ=qux', ''].join('\n'),
    );
  });

  it('appends key to non-empty file without dropping trailing content', () => {
    const { dir, filePath } = createTempFile('FOO=bar');
    trackDir(dir);

    const env = buildEnv();
    configurePersistenceEndpoint(env, { persistEnvFilePath: filePath, persistDerivedValue: true });

    const contents = fs.readFileSync(filePath, 'utf8');
    assert.equal(contents, ['FOO=bar', `VITE_SUPABASE_PERSISTENCE_URL=${derivedEndpoint}`, ''].join('\n'));
  });
});
