import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settleWithin } from '../index.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('reports a promise that settles inside the limit', async () => {
  const late = new Promise((resolve) => setTimeout(resolve, 2500));
  expect(await settleWithin(late, 3000)).toBe(true);
});

it('reports a rejection as settled', async () => {
  const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('x')), 500));
  expect(await settleWithin(late, 1000)).toBe(true);
});

it('reports a promise still pending at the limit, and advances no further', async () => {
  const start = Date.now();
  const late = new Promise((resolve) => setTimeout(resolve, 4000));
  expect(await settleWithin(late, 3000)).toBe(false);
  expect(Date.now() - start).toBe(3000);
});
