// Run with Electron's Node: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test/organizer.check.js
const assert = require('assert');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

// A stand-in for claude.exe: `reply` closes it with that output, null leaves it hanging. Set before organizer.js binds spawn.
let reply = null;
const spawned = [];
childProcess.spawn = (command, args) => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false, kill() { child.killed = true; } });
  child.args = args;
  child.input = '';
  child.stdin.on('data', (data) => { child.input += data; });
  spawned.push(child);
  if (reply !== null) setImmediate(() => { child.stdout.end(reply); child.emit('close', 0); });
  return child;
};

const { validOptions, needsWork, inputLine, estimate, cleanItems, organize, cleanJoins, joinInput, workspaceGroups, workspaceInput, cleanWorkspaces, estimateWorkspaces, resolveWorkspaces } = require('../src/main/organizer.js');

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

const valid = { model: 'sonnet', effort: 'low', rename: false };
assert.equal(validOptions({ ...valid, resort: true, notes: 'x'.repeat(2000) }), true);
assert.equal(validOptions({ ...valid, resort: false, notes: '' }), true);
for (const resort of [null, 1, 'true']) assert.equal(validOptions({ ...valid, resort }), false);
for (const notes of [null, 1, 'x'.repeat(2001)]) assert.equal(validOptions({ ...valid, notes }), false);
assert.equal(needsWork(session('a', { topic: 'Deck' }), false, true), true);
assert.equal(needsWork(session('a', { topic: 'Deck', userGroup: 'Deck' }), false, true), false);
assert.equal(needsWork(session('a', { topic: 'Deck', userGroup: 'Deck' }), true, true), true);
assert.equal(estimate([session('a', { topic: 'Deck' })], { rename: false, resort: true }).sessions, 1);

const groupedSessions = [
  session('a', { topic: 'Support', title: 'Newest\ntitle', lastAt: '2026-11-09' }),
  session('b', { topic: 'Support', customTitle: 'Custom', cwd: '/work/app', lastAt: '2026-11-08' }),
  session('c', { topic: 'Support', aiTitle: 'AI', lastAt: '2026-11-07' }),
  session('d', { topic: 'Support', firstPrompt: 'Prompt', cwd: '/work/third', lastAt: '2026-11-06' }),
  session('e', { topic: 'Support', title: '', lastAt: '2026-11-05' }),
  session('f', { topic: 'Support', title: 'Oldest', lastAt: '2026-11-04' }),
  session('g', { topic: 'Plan', title: 'Plan' }),
  session('h'),
];
const groups = workspaceGroups(groupedSessions);
assert.deepEqual(groups, [
  { name: 'Support', count: 6, folders: ['deck', 'app'], titles: ['Newest\ntitle', 'Custom', 'AI', 'Prompt', ''] },
  { name: 'Plan', count: 1, folders: ['deck'], titles: ['Plan'] },
]);
assert.equal(workspaceInput(groups), '0\tSupport\t6\tdeck, app\tNewest title | Custom | AI | Prompt |\n1\tPlan\t1\tdeck\tPlan');
assert.deepEqual(estimateWorkspaces([]), { groups: 0, tokens: 0 });
assert.deepEqual(estimateWorkspaces(groupedSessions), { groups: 2, tokens: Math.round(workspaceInput(groups).length / 4 + 24) + 1400 });
assert.deepEqual(cleanWorkspaces(groups, null), []);
assert.deepEqual(cleanWorkspaces(groups, [null, { i: 99, workspace: 'x' }, { i: '0', workspace: 'x' }, { i: -1, workspace: 'x' }, { i: 0, workspace: 3 }, { i: 0, workspace: ' \n ' }]), []);
assert.deepEqual(cleanWorkspaces(groups, [{ i: 0, workspace: ' Frugal\nDeck ' }, { i: 1, workspace: 'x'.repeat(41) }]), [{ group: 'Support', workspace: 'Frugal Deck' }, { group: 'Plan', workspace: 'x'.repeat(40) }]);

const options = { model: 'sonnet', effort: 'low', rename: false };

const joinBatch = [{
  id: 's', title: 'Child\nname', cwd: 'C:\\work\\deck', lastAt: '2026-11-01T10:00:00Z',
  candidates: [
    { id: 'c1', title: 'One', cwd: 'C:\\work\\deck', lastAt: '2026-10-01T00:00:00Z' },
    { id: 'c2', title: 'Two', cwd: 'C:\\other\\app', lastAt: '2026-09-01T00:00:00Z' },
  ],
}];
assert.equal(joinInput(joinBatch), 'S\t0\tdeck\t2026-11-01\tChild name\nC\t1\tdeck\t2026-10-01\tOne\nC\t2\tapp\t2026-09-01\tTwo');
assert.deepEqual(cleanJoins(joinBatch, 'nope'), []);
assert.deepEqual(cleanJoins(joinBatch, [{ i: 9, origin: 1 }, { i: 0, origin: 9 }]), []);
assert.deepEqual(cleanJoins(joinBatch, [{ i: 0, origin: 0 }]), [{ id: 's', parentId: null }]);
assert.deepEqual(cleanJoins(joinBatch, [{ i: 0, origin: 2 }]), [{ id: 's', parentId: 'c2' }]);

(async () => {
  // A hung claude is killed and reported, so the locked menu always gets an answer.
  await assert.rejects(organize({ claude: 'claude', env: {}, sessions: [session('a')], options, run: {}, onBatch: () => assert.fail('no batch'), timeoutMs: 20 }), /did not answer/);
  assert.equal(spawned.at(-1).killed, true);

  // A normal reply saves the batch and clears the timer; a timer left behind would keep this check alive for the full timeout.
  reply = JSON.stringify({ structured_output: { items: [{ i: 0, topic: 'Deck' }] } });
  const saved = [];
  await organize({ claude: 'claude', env: {}, sessions: [session('a')], options, run: {}, onBatch: (rows) => saved.push(...rows) });
  assert.deepEqual(saved, [{ id: 'a', topic: 'Deck', title: null }]);
  assert.equal(spawned.at(-1).killed, false);

  await organize({ claude: 'claude', env: {}, sessions: [session('a', { topic: 'Old' }), session('b', { topic: 'Manual', userGroup: 'Manual' })], options: { ...options, resort: true, notes: ' Keep\nDeck together ' }, run: {}, onBatch: () => {} });
  assert.ok(spawned.at(-1).input.startsWith('Notes from the person: Keep Deck together\n\nExisting topics: Manual\n\n'));
  assert.ok(!spawned.at(-1).input.includes('Old'));
  reply = JSON.stringify({ structured_output: { items: [{ i: 0, workspace: 'Deck' }] } });
  assert.deepEqual(await resolveWorkspaces({ claude: 'claude', env: {}, sessions: groupedSessions, options: { ...options, notes: ' Keep\nDeck together ' }, run: {} }), [{ group: 'Support', workspace: 'Deck' }]);
  assert.equal(spawned.at(-1).input, 'Notes from the person: Keep Deck together\n\n' + workspaceInput(groups));
  const args = spawned.at(-1).args;
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.items.items.required, ['i', 'workspace']);
  const calls = spawned.length;
  assert.deepEqual(await resolveWorkspaces({ sessions: [], options, run: {} }), []);
  assert.equal(spawned.length, calls);
  console.log('organizer check ok');
})();
