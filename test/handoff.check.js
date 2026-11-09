const assert = require('assert');
const { handoffBlock, pickOrigin } = require('../src/main/handoff.js');

// non-text is not a handoff
assert.equal(handoffBlock(null), null);
assert.equal(handoffBlock(42), null);

// A block inside a code fence, with a /frugal line above it.
const fenced = ['Opening words.', '<command-name>/frugal</command-name>', '```', 'Goal: Ship the deck', 'Done: indexed sessions', 'Pending: link chats to roots', '```', 'coda'].join('\n');
const plain = ['Goal: Ship the deck', 'Done: indexed sessions', 'Pending: link chats to roots'].join('\n');
assert.deepEqual(handoffBlock(fenced), handoffBlock(plain));
assert.equal(handoffBlock(plain).goal, 'Ship the deck');

// Wrapped in pasted_content: words the user typed after the paste are cut off.
assert.deepEqual(handoffBlock(`<pasted_content>\n${plain}</pasted_content>\nand honestly the tests too`), handoffBlock(plain));

// command-args closed on the same line as the last content line.
assert.deepEqual(handoffBlock('<command-args>\n' + plain.replace('link chats to roots', 'link chats to roots</command-args>')).hash, handoffBlock(plain).hash);

// CRLF survives.
assert.deepEqual(handoffBlock(plain.replace(/\n/g, '\r\n')), handoffBlock(plain));

// A Usage line does not change the hash, whatever it says or where it sits.
const withUsage = ['Goal: Ship the deck', 'Usage: 12 tokens', 'Done: indexed sessions', 'Pending: link chats to roots'].join('\n');
const otherUsage = ['Goal: Ship the deck', 'Done: indexed sessions', 'Usage: 40 tokens', 'Pending: link chats to roots', 'Usage: more'].join('\n');
assert.equal(handoffBlock(withUsage).hash, handoffBlock(plain).hash);
assert.equal(handoffBlock(otherUsage).hash, handoffBlock(plain).hash);

// Whitespace and indentation do not change the hash either.
assert.equal(handoffBlock(['  Goal:   Ship   the deck ', '\tDone:\t indexed sessions', '\t Pending: link chats to roots'].join('\n')).hash, handoffBlock(plain).hash);

// Done and Pending are both required.
assert.equal(handoffBlock(plain.replace('Pending: link chats to roots', 'Later: link chats to roots')), null);
assert.equal(handoffBlock('Goal: Ship the deck'), null);

// pickOrigin
const at = { id: 'now', hash: 'h1', goal: 'g1', at: '2026-02-01T00:00:00Z' };
const e = (session_id, hash, goal, at) => ({ session_id, hash, goal, at });

// A unique exact emitter is the parent.
assert.deepEqual(pickOrigin(at, [e('a', 'zz', 'g1', '2026-01-09T00:00:00Z'), e('b', 'h1', 'g1', '2026-01-10T00:00:00Z')]), { parent: 'b', candidates: [] });

// Exact beats goal, whatever the goal match says.
assert.deepEqual(pickOrigin(at, [e('a', 'h1', 'g1', '2026-01-05T00:00:00Z'), e('b', 'zz', 'g1', '2026-01-09T00:00:00Z')]), { parent: 'a', candidates: [] });

// Goal only, when no hash matches.
assert.deepEqual(pickOrigin(at, [e('a', 'zz', 'g1', '2026-01-10T00:00:00Z')]), { parent: 'a', candidates: [] });

// Emissions from the future and from the session itself are ignored.
assert.deepEqual(pickOrigin(at, [e('a', 'h1', 'g1', at.at), e(at.id, 'h1', 'g1', '2026-01-01T00:00:00Z')]), { parent: null, candidates: [] });

// Several goal matches: the latest wins.
assert.deepEqual(pickOrigin(at, [e('a', 'zz', 'g1', '2026-01-02T00:00:00Z'), e('b', 'zz', 'g1', '2026-01-08T00:00:00Z')]), { parent: 'b', candidates: [] });

// A tie leaves it ambiguous.
assert.deepEqual(pickOrigin(at, [e('a', 'zz', 'g1', '2026-01-08T00:00:00Z'), e('b', 'zz', 'g1', '2026-01-08T00:00:00Z')]), { parent: null, candidates: ['a', 'b'] });

// Nothing to pool.
assert.deepEqual(pickOrigin(at, [e('a', 'h1', 'g1', '2026-03-01T00:00:00Z')]), { parent: null, candidates: [] });
assert.deepEqual(pickOrigin(at, []), { parent: null, candidates: [] });

console.log('ok');
