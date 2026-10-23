// @vitest-environment node
/**
 * The dashboard's KPI tiles take their colour from theme tokens, not hex literals, so they follow
 * the palette in both themes (the light accents were darkened to AA in #581 while these tiles
 * still carried the old hex values). The tones are read from the page source, and each must be a
 * token both theme blocks of index.css define: an unknown token renders as no colour at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const page = readFileSync(path.resolve('frontend/src/pages/DashboardPage.jsx'), 'utf8');
const css = readFileSync(path.resolve('frontend/src/index.css'), 'utf8');
const darkAt = css.indexOf("[data-theme='dark'] {");
const light = css.slice(0, darkAt);
const dark = css.slice(darkAt);

/** The `tone="..."` values on `<KPI` elements in a source text. */
const tonesIn = (src) => [...src.matchAll(/<KPI\b[^>]*?\btone="([^"]+)"/gs)].map((m) => m[1]);

describe('DashboardPage KPI tones', () => {
  it('reads both theme blocks (meta)', () => {
    expect(darkAt).toBeGreaterThan(0);
    expect(light).toMatch(/--accent-teal:/);
    expect(dark).toMatch(/--accent-teal:/);
  });

  it('gives every tile a tone, and no tile a hex colour', () => {
    expect(tonesIn(page)).toHaveLength((page.match(/<KPI\b/g) ?? []).length);
    // Four admin tiles since R1 removed the Compliance tile (2026-10-22).
    expect(tonesIn(page).length).toBeGreaterThanOrEqual(4);
    expect(page).not.toMatch(/<KPI\b[^>]*?\bcolor="#/s);
  });

  it.each(tonesIn(page))('"%s" is a token in the light and dark themes', (tone) => {
    expect(light).toContain(`--${tone}:`);
    expect(dark).toContain(`--${tone}:`);
  });

  it('catches a hex colour and an unknown token (planted)', () => {
    const planted = page.replace('tone="accent-teal"', 'color="#0d8a8a"');
    expect(tonesIn(planted)).toHaveLength(tonesIn(page).length - 1);
    expect(planted).toMatch(/<KPI\b[^>]*?\bcolor="#/s);
    expect(light).not.toContain('--accent-tea:');
  });
});
