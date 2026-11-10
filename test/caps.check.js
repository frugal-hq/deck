const assert = require('assert');
const { capExhaustedUntil } = require('../src/main/accounts.js');

const now = 1700000000000;
const hour = Math.floor(now / 1000) + 3600;
const later = 1700100000;
const sooner = 1700003600;
const caps = { fiveHour: 80, sevenDay: 40 };

assert.equal(capExhaustedUntil({ fiveHour: { pct: 79, resetsAt: sooner } }, caps, null, now), null);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 80, resetsAt: sooner } }, caps, null, now), sooner);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: sooner } }, caps, null, now), sooner);
assert.equal(capExhaustedUntil({ sevenDay: { pct: 40, resetsAt: later } }, caps, null, now), later);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: sooner }, sevenDay: { pct: 50, resetsAt: later } }, caps, null, now), later);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: sooner } }, caps, later, now), null);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: later } }, caps, sooner, now), later);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: sooner } }, caps, sooner, now), null);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 100 } }, { fiveHour: 100, sevenDay: 100 }, null, now), hour);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 99 } }, { fiveHour: 100, sevenDay: 100 }, null, now), null);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: 1700003600000 } }, caps, null, now), sooner);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 0 } }, { fiveHour: 0, sevenDay: 100 }, null, now), hour);
assert.equal(capExhaustedUntil(null, caps, null, now), null);
assert.equal(capExhaustedUntil({ fiveHour: { pct: 90, resetsAt: '2026-11-09T12:00:00Z' } }, caps, null, now), Date.parse('2026-11-09T12:00:00Z') / 1000);

console.log('ok');
