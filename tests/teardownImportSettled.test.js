// #77: every test file waits for in-flight module loads before its environment
// is torn down. The race this closes cannot be forced from inside a test (it
// needs a module chain still loading when the file ends), so this pins the
// wiring: the setup file Vitest runs for every test file registers the
// afterAll that settles dynamic imports, and the config still points at it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

describe('test-teardown import race guard (#77)', () => {
  it('vitest.config.js runs tests/setup.js for every test file', () => {
    expect(read('vitest.config.js')).toMatch(/setupFiles:\s*'\.\/tests\/setup\.js'/);
  });

  it('tests/setup.js awaits vi.dynamicImportSettled() in a file-level afterAll', () => {
    const setup = read('tests/setup.js');
    expect(setup).toMatch(
      /^afterAll\(async \(\) => \{\n\s+await vi\.dynamicImportSettled\(\);\n\}\);$/m
    );
  });
});
