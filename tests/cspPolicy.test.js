/**
 * The production Content-Security-Policy (`vercel.json`) and its canonical
 * document (`docs/security/csp.md`) must name the same `connect-src` origins.
 *
 * Dev and E2E run without a CSP (Vite serves none, Playwright sets none), so a
 * browser test cannot catch a missing origin: the heat forecast would pass E2E
 * and then be refused in production. This is the gate that can.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function headerPolicy() {
  const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const header = vercel.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key.toLowerCase() === 'content-security-policy');
  return header.value;
}

/** @param {string} policy */
function directive(policy, name) {
  const part = policy
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name} `));
  return part ? part.split(/\s+/).slice(1) : null;
}

/** The host of a CSP source expression (`https://api.weather.gov` -> `api.weather.gov`). */
const hostOf = (source) => /^[a-z]+:\/\/([^/:]+)/i.exec(source)?.[1]?.toLowerCase() ?? '';
/** Is this source on weather.gov or any subdomain, judged on the parsed host? */
const isWeatherGov = (source) =>
  hostOf(source) === 'weather.gov' || hostOf(source).endsWith('.weather.gov');

function documentedPolicy() {
  const doc = readFileSync(path.join(ROOT, 'docs/security/csp.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Current policy'));
  const block = /```\n([\s\S]*?)```/.exec(section);
  return block ? block[1].replace(/\s+/g, ' ') : '';
}

describe('Content-Security-Policy', () => {
  it('connect-src in vercel.json and docs/security/csp.md name the same origins', () => {
    const header = directive(headerPolicy(), 'connect-src');
    const documented = directive(documentedPolicy(), 'connect-src');
    expect(header).not.toBeNull();
    expect(documented).not.toBeNull();
    expect(new Set(documented)).toEqual(new Set(header));
  });

  it('allows the NWS API for the heat forecast, by exact host', () => {
    const connect = directive(headerPolicy(), 'connect-src');
    expect(connect).toContain('https://api.weather.gov');
    // Compared on the parsed host, not a substring: every weather.gov source in
    // connect-src must be exactly the API host (no wildcard, no sibling site).
    expect(connect.filter(isWeatherGov)).toEqual(['https://api.weather.gov']);
  });

  it('never allows a bare wildcard', () => {
    for (const name of ['default-src', 'connect-src', 'script-src', 'img-src']) {
      const values = directive(headerPolicy(), name) ?? [];
      expect(values, name).not.toContain('*');
      expect(values, name).not.toContain('https:');
    }
  });

  it('the host check would catch a wildcard or a sibling weather.gov host', () => {
    expect(
      ['https://*.weather.gov', 'https://forecast.weather.gov'].filter(isWeatherGov)
    ).toHaveLength(2);
    expect(isWeatherGov('https://weather.gov.evil.example')).toBe(false);
  });

  it('the comparison would fail if the document drifted', () => {
    const header = new Set(directive(headerPolicy(), 'connect-src'));
    const drifted = new Set(
      directive(documentedPolicy().replace(' https://api.weather.gov', ''), 'connect-src')
    );
    expect(drifted).not.toEqual(header);
  });
});
