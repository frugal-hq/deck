import assert from 'node:assert/strict';
import { groupChats, buildTree } from '../src/renderer/chats.mjs';

const sessions = [
  { id: 's1', chatId: 'c1', title: 'First', lastAt: '2026-01-03', pinned: false, space: 'Work', tags: ['a'], topic: 'T', parentId: null },
  { id: 's2', chatId: 'c1', title: 'Second', lastAt: '2026-01-02', pinned: true, space: null, tags: ['b', 'a'], topic: null, parentId: 's1' },
  { id: 's3', chatId: 'c2', title: 'Third', lastAt: '2026-01-01', pinned: false, space: null, tags: [], topic: 'U', parentId: null },
];

const chats = groupChats(sessions);
assert.equal(chats.length, 2);
assert.equal(chats[0].id, 's1');
assert.deepEqual(chats[0].earlier, [sessions[1]]);
assert.equal(chats[1].earlier.length, 0);
assert.equal(chats[0].pinned, true);
assert.equal(chats[0].space, 'Work');
assert.deepEqual(chats[0].tags, ['a', 'b']);
assert.equal(chats[0].topic, 'T');
assert.equal(chats[1].space, null);
assert.equal(chats[1].topic, 'U');

const headWins = groupChats([
  { id: 'a', chatId: 'x', lastAt: '2026', pinned: false, space: 'OlderSpace', tags: [], topic: 'OlderTopic', parentId: null },
  { id: 'b', chatId: 'x', lastAt: '2025', pinned: false, space: 'HeadSpace', tags: [], topic: 'HeadTopic', parentId: null },
]);
// newest first expected; but if input not sorted, head is first in list
assert.equal(headWins[0].space, 'OlderSpace');

const handGrouped = groupChats([
  { id: 'h1', chatId: 'y', lastAt: '2026', pinned: false, space: null, tags: [], topic: 'Auto', userGroup: null, parentId: null },
  { id: 'h2', chatId: 'y', lastAt: '2025', pinned: false, space: null, tags: [], topic: null, userGroup: 'Hand', parentId: null },
]);
// The first non-null user group wins over the automatic topic, and is exposed.
assert.equal(handGrouped[0].userGroup, 'Hand');
assert.equal(handGrouped[0].topic, 'Hand');

const treeChats = [
  { id: 'a', space: 'Client A' },
  { id: 'b' },
  { id: 'c' },
  { id: 'd' },
];
const tree = buildTree(treeChats, (chat) => (chat.id === 'd' ? 'b' : chat.id), { b: 'Work' });
assert.deepEqual(tree.workspaces, [
  { name: 'Client A', groups: [], chats: [treeChats[0]] },
  { name: 'Work', groups: [['b', [treeChats[1], treeChats[3]]]], chats: [] },
]);
assert.deepEqual(tree.groups, [['c', [treeChats[2]]]]);

const plain = buildTree(treeChats, (chat) => chat.id);
assert.deepEqual(plain.workspaces, [{ name: 'Client A', groups: [], chats: [treeChats[0]] }]);
assert.deepEqual(plain.groups, [['b', [treeChats[1]]], ['c', [treeChats[2]]], ['d', [treeChats[3]]]]);

console.log('chats check ok');
