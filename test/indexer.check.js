// Run with Electron's Node: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test/indexer.check.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openIndex, syncFile, scan, listSessions, promptTitle, saveOrganization, saveAutomatic, clearAutoTitles } = require('../src/main/indexer.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-index-'));
const root = path.join(dir, 'projects');
const project = path.join(root, 'p');
fs.mkdirSync(project, { recursive: true });
const db = openIndex(path.join(dir, 'nested', 'deck.db'));

// Must exist and sit outside the temp folder, wherever the repo is checked out.
const cwd = os.homedir();
const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const file = (n) => path.join(project, `${id(n)}.jsonl`);
const line = (record) => `${JSON.stringify(record)}\n`;
const user = (content, timestamp, extra = {}) => line({ type: 'user', cwd, entrypoint: 'cli', timestamp, message: { content }, ...extra });
const row = (n) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id(n));
const listed = () => listSessions(db).map((s) => s.id);

// Half-written last line is not consumed, and a multi-byte prompt survives.
fs.writeFileSync(file(1), user('first naïve prompt', '2026-01-01T00:00:00Z') + '{"type":"user","cwd"');
assert.equal(syncFile(db, file(1)), true);
assert.equal(row(1).turns, 1);
assert.equal(row(1).first_prompt, 'first naïve prompt');
const partialAt = row(1).offset;
assert.ok(partialAt < row(1).size);

// The line is completed: counted once, unknown records and bad JSON tolerated.
fs.appendFileSync(file(1), ':"x"}\nnot json\nnull\n' + line({ type: 'something-new', sessionId: id(1) }) + user('second', '2026-01-02T00:00:00Z'));
syncFile(db, file(1));
assert.equal(row(1).turns, 3);
assert.equal(row(1).first_prompt, 'first naïve prompt');
assert.equal(row(1).last_at, '2026-01-02T00:00:00Z');

// Same size is skipped.
assert.equal(syncFile(db, file(1)), false);

// Records added by --resume with no message do not bump the date.
fs.appendFileSync(file(1), line({ type: 'mode', mode: 'x' }) + line({ type: 'last-prompt', timestamp: '2026-09-09T00:00:00Z' }));
syncFile(db, file(1));
assert.equal(row(1).last_at, '2026-01-02T00:00:00Z');

// A custom title beats an AI title, and a later one replaces the earlier one.
fs.appendFileSync(file(1), line({ type: 'ai-title', aiTitle: 'ai' }));
syncFile(db, file(1));
assert.equal(listSessions(db)[0].title, 'ai');
fs.appendFileSync(file(1), line({ type: 'custom-title', customTitle: 'one' }) + line({ type: 'custom-title', customTitle: 'two' }));
syncFile(db, file(1));
assert.equal(listSessions(db)[0].title, 'two');

// A file that shrinks is indexed again from the start.
fs.writeFileSync(file(1), user('short', '2026-02-01T00:00:00Z'));
syncFile(db, file(1));
assert.equal(row(1).turns, 1);
assert.equal(row(1).first_prompt, 'short');
assert.equal(row(1).custom_title, null);

// Listing: tool results, meta and sidechains are not turns; the rest are filtered out by origin or folder.
fs.writeFileSync(file(2), user('x', '2026-03-01T00:00:00Z', { toolUseResult: {} }) + user('y', '2026-03-01T00:00:00Z', { isMeta: true }) + user('z', '2026-03-01T00:00:00Z', { isSidechain: true }));
fs.writeFileSync(file(3), user('sdk', '2026-03-02T00:00:00Z', { entrypoint: 'sdk-cli' }));
fs.writeFileSync(file(4), user('gone', '2026-03-03T00:00:00Z', { cwd: path.join(dir, 'missing') }));
fs.writeFileSync(file(5), user('temp', '2026-03-04T00:00:00Z', { cwd: dir }));
fs.writeFileSync(file(6), user('recent', '2026-03-05T00:00:00Z') + line({ type: 'relocated', relocatedCwd: path.dirname(cwd) }));
scan(db, root, () => {});
assert.equal(row(2).turns, 0);
assert.deepEqual(listed(), [id(6), id(1)]);
assert.equal(listSessions(db)[0].cwd, path.dirname(cwd));

// A scan drops transcripts that no longer exist.
fs.rmSync(file(6));
scan(db, root, () => {});
assert.equal(row(6), undefined);
assert.deepEqual(listed(), [id(1)]);

assert.equal(promptTitle('<command-message>a</command-message>\n<command-name>/frugal</command-name>\n<command-args>code\nGoal: Move to the org\nDone:</command-args>'), 'Move to the org');
assert.equal(promptTitle('<command-name>/usage</command-name><command-args></command-args>'), '/usage');
assert.equal(promptTitle([{ type: 'image' }, { type: 'text', text: 'hello  world' }]), 'hello world');
assert.equal(promptTitle([{ type: 'image' }]), null);

// org asserts
assert.equal(saveOrganization(db, 'nope', { pinned: false, space: '', tags: [] }), false);
assert.equal(saveOrganization(db, 123, { pinned: false, space: '', tags: [] }), false);
assert.equal(saveOrganization(db, id(1), { pinned: 'x', space: '', tags: [] }), false);
assert.equal(saveOrganization(db, id(1), { pinned: true, space: '', tags: 'a' }), false);
assert.equal(saveOrganization(db, id(1), { pinned: true, space: ' Work ', tags: [' a ', '#a', 'A', 'b', ''] }), true);
let s1 = listSessions(db).find((s) => s.id === id(1));
assert.equal(s1.pinned, true);
assert.equal(s1.space, 'Work');
assert.equal(s1.tags.length, 2);
assert.equal(s1.tags.filter((t) => t.toLowerCase() === 'a').length, 1);
assert.ok(s1.tags.includes('b'));
fs.writeFileSync(file(7), user('no org', '2026-03-06T00:00:00Z'));
syncFile(db, file(7));
let unorg = listSessions(db).find((s) => s.id === id(7));
assert.equal(unorg.pinned, false);
assert.equal(unorg.space, null);
assert.deepEqual(unorg.tags, []);
assert.equal(saveOrganization(db, id(3), { pinned: false, space: 'work', tags: [] }), true);
assert.equal(db.prepare('SELECT space FROM session_org WHERE session_id = ?').get(id(3)).space, 'Work');
fs.appendFileSync(file(1), user('third', '2026-02-02T00:00:00Z'));
syncFile(db, file(1));
s1 = listSessions(db).find((s) => s.id === id(1));
assert.equal(s1.pinned, true);
assert.equal(s1.space, 'Work');
assert.equal(s1.tags.length, 2);

// Organizer results: below a title the user set, kept when no new title comes, and titles restore without losing the topic.
fs.writeFileSync(file(8), user('original', '2026-03-07T00:00:00Z'));
syncFile(db, file(8));
const s8 = () => listSessions(db).find((s) => s.id === id(8));
assert.equal(s8().topic, null);
saveAutomatic(db, [{ id: id(8), topic: 'Deck', title: 'Better title' }]);
assert.equal(s8().topic, 'Deck');
assert.equal(s8().title, 'Better title');
saveAutomatic(db, [{ id: id(8), topic: 'Other', title: null }]);
assert.equal(s8().topic, 'Other');
assert.equal(s8().title, 'Better title');
clearAutoTitles(db);
assert.equal(s8().title, 'original');
assert.equal(s8().autoTitle, null);
assert.equal(s8().topic, 'Other');
saveAutomatic(db, [{ id: id(8), topic: 'Other', title: 'Better title' }]);
fs.appendFileSync(file(8), line({ type: 'custom-title', customTitle: 'mine' }));
syncFile(db, file(8));
assert.equal(s8().title, 'mine');
assert.equal(s8().topic, 'Other');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
