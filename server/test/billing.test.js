import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVAL_UNITS, monthsEquivalent, addInterval, frequencyLabel, perLabel, slugCode,
} from '../lib/billing.js';

test('INTERVAL_UNITS is week/month/year only (no day)', () => {
  assert.deepEqual(INTERVAL_UNITS, ['week', 'month', 'year']);
});

test('monthsEquivalent normalizes each unit for MRR', () => {
  assert.equal(monthsEquivalent('month', 1), 1);
  assert.equal(monthsEquivalent('month', 3), 3);
  assert.equal(monthsEquivalent('year', 1), 12);
  // week ~ 7/30.436875 months
  assert.ok(Math.abs(monthsEquivalent('week', 1) - 0.23) < 0.01);
  assert.ok(Math.abs(monthsEquivalent('week', 2) - 0.46) < 0.01);
});

test('monthsEquivalent throws on an unknown unit', () => {
  assert.throws(() => monthsEquivalent('day', 1));
});

test('addInterval advances the date by unit x count', () => {
  assert.equal(addInterval('2026-01-01', 'week', 1), '2026-01-08');
  assert.equal(addInterval('2026-01-01', 'week', 2), '2026-01-15');
  assert.equal(addInterval('2026-01-15', 'month', 1), '2026-02-15');
  assert.equal(addInterval('2026-01-15', 'month', 6), '2026-07-15');
  assert.equal(addInterval('2026-01-15', 'year', 1), '2027-01-15');
  // Accepts a full ISO timestamp and returns date only.
  assert.equal(addInterval('2026-01-01T12:00:00Z', 'month', 1), '2026-02-01');
});

test('frequencyLabel reads naturally for single and multi counts', () => {
  assert.equal(frequencyLabel('week', 1), 'weekly');
  assert.equal(frequencyLabel('week', 2), 'every 2 weeks');
  assert.equal(frequencyLabel('month', 1), 'monthly');
  assert.equal(frequencyLabel('month', 6), 'every 6 months');
  assert.equal(frequencyLabel('year', 1), 'yearly');
});

test('perLabel builds a price suffix', () => {
  assert.equal(perLabel('week', 1), '/ week');
  assert.equal(perLabel('month', 6), '/ 6 months');
  assert.equal(perLabel('year', 1), '/ year');
});

test('slugCode makes a safe unique-able plan code from a name', () => {
  assert.equal(slugCode('Standard Monthly'), 'StandardMonthly');
  assert.equal(slugCode('  bi-annual!! '), 'Biannual');
  assert.equal(slugCode(''), 'Plan');
});
