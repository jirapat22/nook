// Run with: npm test  (uses Node's built-in test runner, no extra packages)
// Checks that "today" means Pat's day in New Zealand, not the UTC day.
const test = require('node:test');
const assert = require('node:assert');
const { serverToday, computeStreak } = require('../lib/streak');

test('NZ morning is already the next day (UTC is still yesterday)', () => {
  // 00:30 NZDT on 11/11 is 11:30 UTC on 10/11
  assert.strictEqual(serverToday(new Date('2026-11-10T11:30:00Z')), '2026-11-11');
});

test('daylight saving end (NZST, +12) still gives the NZ day', () => {
  assert.strictEqual(serverToday(new Date('2026-04-04T13:30:00Z')), '2026-04-05');
});

test('year rollover in NZ happens 13 hours before UTC', () => {
  assert.strictEqual(serverToday(new Date('2026-12-31T11:05:00Z')), '2027-01-01');
});

test('streak counts today when given an explicit day', () => {
  const s = computeStreak(['2026-11-09', '2026-11-10'], '2026-11-10');
  assert.strictEqual(s.current, 2);
});
