// Run with Electron's Node: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test/organizer.check.js
const assert = require('assert');
const { validOptions, needsWork, inputLine, estimate, cleanItems } = require('../src/main/organizer.js');

const session = (id, extra = {}) => ({ id, cwd: 'C:\\work\\deck', lastAt: '2026-11-01T10:00:00Z', firstPrompt: 'fix\tthe\nlogin', aiTitle: null, customTitle: null, topic: null, autoTitle: null, ...extra });

// Only the known models and efforts reach the command line.
assert.equal(validOptions({ model: 'sonnet', effort: 'medium', rename: false }), true);
assert.equal(validOptions({ model: '--dangerous', effort: 'medium', rename: false }), false);
assert.equal(validOptions({ model: 'opus', effort: 'max; rm', rename: true }), false);
assert.equal(validOptions({ model: 'opus', effort: 'low', rename: 'yes' }), false);
assert.equal(validOptions(null), false);

// A second run only picks up what is missing; a title the user set is never rewritten.
assert.equal(needsWork(session('a'), false), true);
assert.equal(needsWork(session('a', { topic: 'Deck' }), false), false);
assert.equal(needsWork(session('a', { topic: 'Deck' }), true), true);
assert.equal(needsWork(session('a', { topic: 'Deck', autoTitle: 'x' }), true), false);
assert.equal(needsWork(session('a', { topic: 'Deck', customTitle: 'mine' }), true), false);

// One line per session, whatever the prompt contains.
assert.equal(inputLine(session('a'), 7, false), '7\tdeck\t2026-11-01\tfix the login');
assert.equal(inputLine(session('a', { aiTitle: 'Login fix' }), 0, true), '0\tdeck\t2026-11-01\tLogin fix\tfix the login');
assert.equal(inputLine(session('a', { aiTitle: 'Login fix' }), 0, false), '0\tdeck\t2026-11-01\tLogin fix');

const none = estimate([session('a', { topic: 'Deck' })], { rename: false });
assert.deepEqual(none, { sessions: 0, tokens: 0 });
const two = estimate([session('a'), session('b')], { rename: false });
assert.equal(two.sessions, 2);
assert.ok(two.tokens > 1400 && two.tokens < 1600);
assert.ok(estimate([session('a')], { rename: true }).tokens > estimate([session('a')], { rename: false }).tokens);

// A model reply is untrusted: unknown indexes, wrong types and empty topics are dropped.
const batch = [session('a'), session('b', { customTitle: 'mine' })];
assert.deepEqual(cleanItems(batch, 'nope', true), []);
assert.deepEqual(cleanItems(batch, [{ i: 9, topic: 'x' }, { i: 'length', topic: 'x' }, { i: 0, topic: '  ' }, { i: 0, topic: 3 }, null], true), []);
assert.deepEqual(cleanItems(batch, [{ i: 0, topic: ' Frugal \n Deck ', title: 'Fix login' }], true), [{ id: 'a', topic: 'Frugal Deck', title: 'Fix login' }]);
assert.deepEqual(cleanItems(batch, [{ i: 0, topic: 'Deck', title: 'ignored' }], false), [{ id: 'a', topic: 'Deck', title: null }]);
assert.deepEqual(cleanItems(batch, [{ i: 1, topic: 'Deck', title: 'replaced' }], true), [{ id: 'b', topic: 'Deck', title: null }]);
assert.equal(cleanItems(batch, [{ i: 0, topic: 'x'.repeat(99), title: 'y'.repeat(99) }], true)[0].topic.length, 40);
assert.equal(cleanItems(batch, [{ i: 0, topic: 'x', title: 'y'.repeat(99) }], true)[0].title.length, 80);

console.log('organizer check ok');
