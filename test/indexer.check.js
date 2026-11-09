// Run with Electron's Node: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test/indexer.check.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openIndex, syncFile, scan, listSessions, listIndex, chatLinks, promptTitle, saveOrganization, saveAutomatic, clearAutoTitles, saveLink, undoLastLink, clearModelLinks, saveGroup, saveWorkspace, saveModelWorkspaces, clearModelWorkspaces, renameWorkspace, deleteWorkspace, renameGroup, deleteGroup } = require('../src/main/indexer.js');

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

// A new chat can receive its group before its first transcript exists.
assert.equal(saveGroup(db, id(1), ' Manual '), true);
assert.equal(row(1), undefined);
assert.equal(saveGroup(db, 'not-a-uuid', 'Deck'), false);
assert.equal(saveGroup(db, 1, 'Deck'), false);
assert.equal(saveGroup(db, id(1), 1), false);
assert.equal(saveGroup(db, id(1), 'x'.repeat(41)), false);

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

assert.equal(listSessions(db)[0].userGroup, 'Manual');
saveAutomatic(db, [{ id: id(1), topic: 'Automatic', title: null }]);
assert.equal(listSessions(db)[0].topic, 'Manual');
assert.equal(saveGroup(db, id(1), null), true);
assert.equal(listSessions(db)[0].userGroup, null);
assert.equal(listSessions(db)[0].topic, null);
assert.equal(listSessions(db)[0].noGroup, true);
assert.equal(saveGroup(db, id(1), 'Manual'), true);
assert.equal(saveGroup(db, id(1), '  '), true);
assert.equal(listSessions(db)[0].topic, null);
assert.equal(listSessions(db)[0].noGroup, true);

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
assert.equal(saveGroup(db, id(6), 'Kept'), true);
fs.rmSync(file(6));
scan(db, root, () => {});
assert.equal(row(6), undefined);
assert.equal(db.prepare('SELECT name FROM session_group WHERE session_id = ?').get(id(6)).name, 'Kept');
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

// Handoff joins: an assistant record emits the block, later sessions open with it and share the chat root.
const hand = 'Goal: Fix the deck\nDone: built\nPending: reviewed';
fs.writeFileSync(file(9), user('seed', '2026-03-31T00:00:00Z') + line({ type: 'assistant', timestamp: '2026-04-01T00:00:00Z', message: { content: [{ type: 'text', text: `Picking up:\n${hand}` }] } }));
syncFile(db, file(9));
assert.equal(row(9).handoff_hash, null);
assert.equal(row(9).started_at, '2026-03-31T00:00:00Z');
assert.deepEqual(db.prepare('SELECT session_id, goal, at FROM session_handoffs').all(), [{ session_id: id(9), goal: 'Fix the deck', at: '2026-04-01T00:00:00Z' }]);

const later = (n, at) => fs.writeFileSync(file(n), user(hand, at) + user(`go on ${n}`, new Date(Date.parse(at) + 864e5).toISOString()));
later(10, '2026-04-02T00:00:00Z');
later(11, '2026-04-04T00:00:00Z');
syncFile(db, file(10));
syncFile(db, file(11));
assert.equal(row(10).handoff_hash, row(11).handoff_hash);
assert.equal(db.prepare('SELECT hash FROM session_handoffs').get().hash, row(10).handoff_hash);
assert.equal(row(10).started_at, '2026-04-02T00:00:00Z');
let links = chatLinks(db);
assert.equal(links.parents.get(id(10)), id(9));
assert.equal(links.parents.get(id(11)), id(9));
assert.deepEqual(links.ambiguous, []);
let idx = listIndex(db);
assert.equal(idx.sessions.find((s) => s.id === id(10)).parentId, id(9));
assert.equal(idx.sessions.find((s) => s.id === id(10)).chatId, id(9));
assert.equal(idx.sessions.find((s) => s.id === id(11)).chatId, id(9));
assert.equal(idx.sessions.find((s) => s.id === id(9)).parentId, null);
assert.equal(idx.sessions.find((s) => s.id === id(9)).chatId, id(9));
assert.equal(idx.modelJoins, 0);

// A user link replaces the automatic join and undo brings it back.
assert.equal(saveLink(db, id(11), id(10), 'user'), true);
assert.equal(listIndex(db).sessions.find((s) => s.id === id(11)).parentId, id(10));
assert.equal(undoLastLink(db), true);
assert.equal(listIndex(db).sessions.find((s) => s.id === id(11)).parentId, id(9));

// A null parent separates the session, and undo restores the automatic join.
assert.equal(saveLink(db, id(11), null, 'user'), true);
assert.equal(listIndex(db).sessions.find((s) => s.id === id(11)).parentId, null);
assert.equal(undoLastLink(db), true);
assert.equal(listIndex(db).sessions.find((s) => s.id === id(11)).parentId, id(9));

// A cycle and a self link are rejected.
assert.equal(saveLink(db, id(9), id(11), 'user'), false);
assert.equal(saveLink(db, id(9), id(9), 'user'), false);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_links WHERE session_id = ?').get(id(9)).n, 0);
assert.equal(listIndex(db).sessions.find((s) => s.id === id(11)).parentId, id(9));

// session_links survives a restart of a file, like session_org.
fs.writeFileSync(file(12), user('late chat', '2026-04-06T00:00:00Z'));
syncFile(db, file(12));
assert.equal(saveLink(db, id(12), id(11), 'user'), true);
fs.writeFileSync(file(12), user('late again', '2026-04-07T00:00:00Z'));
syncFile(db, file(12));
const kept = db.prepare('SELECT parent_id, origin FROM session_links WHERE session_id = ?').get(id(12));
assert.equal(kept.parent_id, id(11));
assert.equal(kept.origin, 'user');
assert.equal(listIndex(db).sessions.find((s) => s.id === id(12)).parentId, id(11));

// Model workspaces update model rows only, including case-insensitive conflicts.
assert.deepEqual(listIndex(db).workspaces, {});
assert.equal(listIndex(db).modelWorkspaces, 0);
assert.equal(saveWorkspace(db, '', 'Deck'), false);
assert.equal(saveWorkspace(db, 'x'.repeat(501), 'Deck'), false);
assert.equal(saveWorkspace(db, 'Deck', 'x'.repeat(41)), false);
assert.equal(saveWorkspace(db, null, 'Deck'), false);
assert.equal(saveWorkspace(db, 'Deck', null), false);
assert.equal(saveWorkspace(db, ' Support ', ' Mine '), true);
saveModelWorkspaces(db, [{ group: 'support', workspace: 'Wrong' }, { group: 'Plan', workspace: 'Deck' }]);
assert.deepEqual(listIndex(db).workspaces, { Support: 'Mine', Plan: 'Deck' });
assert.equal(listIndex(db).modelWorkspaces, 1);
saveModelWorkspaces(db, [{ group: 'PLAN', workspace: 'Updated' }]);
assert.equal(listIndex(db).workspaces.Plan, 'Updated');
assert.equal(saveWorkspace(db, 'plan', 'User'), true);
saveModelWorkspaces(db, [{ group: 'Plan', workspace: 'Wrong' }]);
assert.equal(listIndex(db).workspaces.plan, 'User');
saveModelWorkspaces(db, [{ group: 'Other', workspace: 'Model' }]);
clearModelWorkspaces(db);
assert.deepEqual(listIndex(db).workspaces, { Support: 'Mine', plan: 'User' });
assert.equal(listIndex(db).modelWorkspaces, 0);
assert.equal(saveWorkspace(db, 'SUPPORT', '  '), true);
assert.deepEqual(listIndex(db).workspaces, { plan: 'User' });
assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);

fs.writeFileSync(file('a'), user('alpha', '2026-05-01T00:00:00Z'));
fs.writeFileSync(file('b'), user('beta', '2026-05-02T00:00:00Z'));
fs.writeFileSync(file('c'), user('gamma', '2026-05-03T00:00:00Z'));
fs.writeFileSync(file('d'), user('delta', '2026-05-04T00:00:00Z'));
syncFile(db, file('a'));
syncFile(db, file('b'));
syncFile(db, file('c'));
syncFile(db, file('d'));
const listedSession = (n) => listSessions(db).find((s) => s.id === id(n));

assert.equal(saveWorkspace(db, 'AlphaGroup', 'AlphaSpace'), true);
assert.equal(saveOrganization(db, id('a'), { pinned: false, space: 'AlphaSpace', tags: [] }), true);
assert.equal(saveGroup(db, id('a'), 'AlphaGroup'), true);
assert.equal(deleteWorkspace(db, 'alphaspace'), true);
assert.ok(db.prepare('SELECT id FROM sessions WHERE id = ?').get(id('a')));
assert.equal(listedSession('a').space, null);
assert.equal(listedSession('a').userGroup, 'AlphaGroup');
assert.equal(db.prepare('SELECT 1 FROM group_workspace WHERE workspace = ? COLLATE NOCASE').get('AlphaSpace'), undefined);

assert.equal(saveWorkspace(db, 'BetaGroup', 'OldSpace'), true);
assert.equal(saveOrganization(db, id('b'), { pinned: false, space: 'OldSpace', tags: [] }), true);
assert.equal(renameWorkspace(db, 'oldspace', 'NewSpace'), true);
assert.equal(listIndex(db).workspaces.BetaGroup, 'NewSpace');
assert.equal(listedSession('b').space, 'NewSpace');
assert.equal(db.prepare('SELECT origin FROM group_workspace WHERE name = ?').get('BetaGroup').origin, 'user');

assert.equal(saveGroup(db, id('a'), 'Shared'), true);
assert.equal(saveGroup(db, id('b'), 'Shared'), true);
assert.equal(saveGroup(db, id('c'), 'Shared'), true);
assert.equal(saveWorkspace(db, 'Shared', 'KeepSpace'), true);
assert.equal(saveOrganization(db, id('b'), { pinned: false, space: '', tags: [] }), true);
assert.equal(saveOrganization(db, id('c'), { pinned: true, space: 'OtherSpace', tags: ['keep'] }), true);
assert.equal(deleteGroup(db, [id('a'), id('b'), id('c')], 'Shared'), true);
assert.equal(listedSession('a').space, 'KeepSpace');
assert.equal(listedSession('b').space, 'KeepSpace');
assert.equal(listedSession('c').space, 'OtherSpace');
assert.equal(listedSession('c').pinned, true);
assert.deepEqual(listedSession('c').tags, ['keep']);
assert.equal(listedSession('a').topic, null);
assert.equal(listedSession('a').userGroup, null);
assert.equal(listedSession('a').noGroup, true);
saveAutomatic(db, [{ id: id('a'), topic: 'AutoTopic', title: null }]);
assert.equal(listedSession('a').topic, null);
assert.equal(listedSession('a').userGroup, null);
assert.equal(db.prepare('SELECT 1 FROM group_workspace WHERE name = ?').get('Shared'), undefined);

assert.equal(saveGroup(db, id('d'), 'NoWs'), true);
assert.equal(listedSession('d').space, null);
assert.equal(deleteGroup(db, [id('d')], 'NoWs'), true);
assert.equal(listedSession('d').space, null);
assert.equal(listedSession('d').userGroup, null);
assert.equal(listedSession('d').noGroup, true);

assert.equal(saveGroup(db, id('a'), 'FromName'), true);
assert.equal(saveWorkspace(db, 'FromName', 'Ws1'), true);
assert.equal(renameGroup(db, [id('a')], 'FromName', 'ToName'), true);
assert.equal(listedSession('a').userGroup, 'ToName');
assert.equal(listIndex(db).workspaces.ToName, 'Ws1');
assert.equal(listIndex(db).workspaces.FromName, undefined);

assert.equal(saveGroup(db, id('b'), 'Source'), true);
assert.equal(saveWorkspace(db, 'Source', 'WsSource'), true);
assert.equal(saveWorkspace(db, 'Target', 'WsTarget'), true);
assert.equal(renameGroup(db, [id('b')], 'Source', 'Target'), true);
assert.equal(listedSession('b').userGroup, 'Target');
assert.equal(listIndex(db).workspaces.Target, 'WsTarget');
assert.equal(listIndex(db).workspaces.Source, undefined);

assert.equal(saveGroup(db, id('c'), 'mixed'), true);
assert.equal(saveWorkspace(db, 'mixed', 'WsCase'), true);
assert.equal(renameGroup(db, [id('c')], 'mixed', 'Mixed'), true);
assert.equal(listedSession('c').userGroup, 'Mixed');
assert.equal(listIndex(db).workspaces.Mixed, 'WsCase');
assert.equal(db.prepare('SELECT name FROM group_workspace WHERE name = ?').get('mixed').name, 'Mixed');

const gw = () => db.prepare('SELECT name, workspace, origin FROM group_workspace ORDER BY name').all();
const sg = () => db.prepare('SELECT session_id, name FROM session_group ORDER BY session_id').all();
const so = () => db.prepare('SELECT session_id, pinned, space, tags FROM session_org ORDER BY session_id').all();
const snap = { gw: gw(), sg: sg(), so: so() };
assert.equal(renameGroup(db, [], 'ToName', 'Other'), false);
assert.equal(renameGroup(db, ['not-a-uuid'], 'ToName', 'Other'), false);
assert.equal(renameGroup(db, [id('a'), 'not-a-uuid'], 'ToName', 'Other'), false);
assert.equal(renameGroup(db, [id('a'), 1], 'ToName', 'Other'), false);
assert.equal(deleteGroup(db, [], 'ToName'), false);
assert.equal(deleteGroup(db, ['not-a-uuid'], 'ToName'), false);
assert.equal(deleteGroup(db, [id('a'), 'x'], 'ToName'), false);
assert.deepEqual(gw(), snap.gw);
assert.deepEqual(sg(), snap.sg);
assert.deepEqual(so(), snap.so);

// Handoffs come only from live syncs, only from a reply that ended its turn, with the context it read.
const handoffFile = path.join(project, '00000000-0000-4000-8000-0000000000aa.jsonl');
const reply = (stop, text) => line({ type: 'assistant', cwd, timestamp: '2026-05-01T00:00:00Z', message: { stop_reason: stop, usage: { input_tokens: 5, cache_read_input_tokens: 160000 }, content: [{ type: 'text', text }] } });
const block = '/frugal code\nGoal: Ship it\nNext step: Test';
fs.writeFileSync(handoffFile, user('go', '2026-05-01T00:00:00Z') + reply('end_turn', block));
syncFile(db, handoffFile);
const live = [];
fs.appendFileSync(handoffFile, reply('tool_use', block) + reply('end_turn', 'no block') + reply('end_turn', `Done.\n${block}`));
syncFile(db, handoffFile, live);
assert.deepEqual(live, [{ id: '00000000-0000-4000-8000-0000000000aa', prompt: block, tokens: 160005 }]);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
