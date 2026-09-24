const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paceProfileSlots } = require('../static/pace-profile.js');

test('balanced workdays preserve weekends and total, including reset-day split', () => {
  for (const [reset_weekday, reset_hour] of [[5, 19], [0, 0], [2, 12]]) {
    const raw = Array.from({ length: 168 }, (_, i) => (i + 1) ** 2);
    const total = raw.reduce((a, b) => a + b, 0);
    const slots = raw.map(value => value / total);
    const original = [...slots];
    const profile = { weekly: { slots, reset_weekday, reset_hour } };
    assert.deepEqual(paceProfileSlots(profile, 'historical'), original);
    const result = paceProfileSlots(profile, 'equal_weekdays');
    const days = Array(7).fill(0);
    const hours = Array.from({ length: 7 }, () => Array(24));
    result.forEach((value, slot) => {
      const absolute = (reset_weekday * 24 + reset_hour + slot) % 168;
      const day = Math.floor(absolute / 24);
      days[day] += value;
      hours[day][absolute % 24] = value;
      if (day >= 5) assert.equal(value, original[slot]);
    });
    assert.ok(Math.abs(result.reduce((a, b) => a + b, 0) - 1) < 1e-12);
    for (let day = 1; day < 5; day++) {
      assert.ok(Math.abs(days[day] - days[0]) < 1e-12);
      assert.deepEqual(hours[day], hours[0]);
    }
    assert.deepEqual(slots, original);
  }
});

test('missing profile falls back and zero activity stays zero', () => {
  assert.equal(paceProfileSlots(null, 'equal_weekdays'), null);
  assert.equal(paceProfileSlots({ weekly: { slots: [] } }, 'equal_weekdays'), null);
  const slots = Array(168).fill(0);
  assert.deepEqual(paceProfileSlots({ weekly: { slots, reset_weekday: 5, reset_hour: 19 } }, 'equal_weekdays'), slots);
});
