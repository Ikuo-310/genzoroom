import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlapMs } from './diagnose-pipeline.mjs';

test('GC correlation uses interval overlap and excludes adjacent events', () => {
  const sample = { start: 10, end: 20 };
  assert.equal(overlapMs(sample, { startTime: 12, duration: 3 }), 3);
  assert.equal(overlapMs(sample, { startTime: 8, duration: 4 }), 2);
  assert.equal(overlapMs(sample, { startTime: 18, duration: 6 }), 2);
  assert.equal(overlapMs(sample, { startTime: 0, duration: 30 }), 10);
  assert.equal(overlapMs(sample, { startTime: 20, duration: 1 }), 0);
  assert.equal(overlapMs(sample, { startTime: 8, duration: 2 }), 0);
});
