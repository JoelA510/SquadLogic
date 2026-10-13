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

/**
 * Does a CSP host-source admit this URL? Implements the subset of the CSP3
 * rule this policy uses: `scheme://host` matches that exact host, and
 * `scheme://*.host` matches any host ending in `.host` (never the bare apex).
 * Keywords (`'self'`) and other forms admit nothing here.
 */
function sourceAllows(source, url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?([^/:*]+)$/i.exec(source);
  if (!m) return false;
  const target = new URL(url);
  if (target.protocol !== `${m[1].toLowerCase()}:`) return false;
  const host = target.hostname.toLowerCase();
  const base = m[3].toLowerCase();
  return m[2] ? host.endsWith(`.${base}`) : host === base;
}
const allows = (sources, url) => sources.some((s) => sourceAllows(s, url));

// Placeholder org and project ids, never a real DSN.
const SENTRY_US_ENVELOPE = 'https://o0.ingest.us.sentry.io/api/0/envelope/';
const SENTRY_DEFAULT_ENVELOPE = 'https://o0.ingest.sentry.io/api/0/envelope/';

/**
 * The sources that govern a Web Worker, per CSP3's fallback list:
 * worker-src, else child-src, else script-src, else default-src.
 * @param {string} policy
 */
function workerSources(policy) {
  for (const name of ['worker-src', 'child-src', 'script-src', 'default-src']) {
    const values = directive(policy, name);
    if (values) return values;
  }
  return [];
}
/** Would this policy let Replay start its worker from a `blob:` URL? */
const workerAllowsBlob = (policy) => workerSources(policy).includes('blob:');

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

  it('admits Sentry ingest for US-region and default-region projects', () => {
    const connect = directive(headerPolicy(), 'connect-src');
    expect(allows(connect, SENTRY_US_ENVELOPE)).toBe(true);
    expect(allows(connect, SENTRY_DEFAULT_ENVELOPE)).toBe(true);
  });

  it('the old policy, without the US entry, refuses the US ingest host', () => {
    const connect = directive(headerPolicy(), 'connect-src');
    const old = connect.filter((s) => s !== 'https://*.ingest.us.sentry.io');
    expect(old).toHaveLength(connect.length - 1);
    expect(old).toContain('https://*.ingest.sentry.io');
    expect(allows(old, SENTRY_US_ENVELOPE)).toBe(false);
    expect(allows(old, SENTRY_DEFAULT_ENVELOPE)).toBe(true);
  });

  it('the matcher follows the CSP wildcard rule', () => {
    const us = 'https://*.ingest.us.sentry.io';
    expect(sourceAllows(us, SENTRY_US_ENVELOPE)).toBe(true);
    expect(sourceAllows('https://*.ingest.sentry.io', SENTRY_US_ENVELOPE)).toBe(false);
    expect(sourceAllows(us, 'https://ingest.us.sentry.io/')).toBe(false);
    expect(sourceAllows(us, 'https://o0.ingest.us.sentry.io.evil.example/')).toBe(false);
    expect(sourceAllows(us, 'http://o0.ingest.us.sentry.io/')).toBe(false);
    expect(sourceAllows("'self'", SENTRY_US_ENVELOPE)).toBe(false);
    expect(sourceAllows('https://api.weather.gov', 'https://api.weather.gov/points')).toBe(true);
    expect(sourceAllows('https://api.weather.gov', 'https://x.api.weather.gov/')).toBe(false);
  });

  it('worker-src in vercel.json and docs/security/csp.md name the same sources', () => {
    const header = directive(headerPolicy(), 'worker-src');
    const documented = directive(documentedPolicy(), 'worker-src');
    expect(header).not.toBeNull();
    expect(new Set(documented)).toEqual(new Set(header));
  });

  it("admits Sentry Replay's blob: compression worker, and nothing broader", () => {
    const policy = headerPolicy();
    expect(workerSources(policy)).toEqual(["'self'", 'blob:']);
    expect(workerAllowsBlob(policy)).toBe(true);
    // blob: is admitted for workers only, never as a page script source.
    expect(directive(policy, 'script-src')).not.toContain('blob:');
  });

  it('the old policy, without worker-src, refuses a blob: worker (script-src fallback)', () => {
    const old = headerPolicy()
      .split(';')
      .filter((p) => !p.trim().startsWith('worker-src '))
      .join(';');
    expect(directive(old, 'worker-src')).toBeNull();
    expect(workerSources(old)).toEqual(directive(old, 'script-src'));
    expect(workerAllowsBlob(old)).toBe(false);
  });

  it('never allows a bare wildcard', () => {
    for (const name of ['default-src', 'connect-src', 'script-src', 'img-src', 'worker-src']) {
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
