import assert from 'node:assert/strict';
import { matchSessions } from '../src/renderer/palette.mjs';

const sessions = [
  { id: 'a1', title: 'Naïve test session', cwd: 'C:\\Users\\fake\\frugal-deck', space: null, tags: [] },
  { id: 'b2', title: 'Naive old session', cwd: 'C:\\fake\\project-x', space: null, tags: [] },
  { id: 'c3', title: 'Terminal refactor', cwd: 'C:\\fake\\frugal-deck', space: null, tags: [] },
  { id: 'd4', title: 'Initial setup', cwd: 'D:\\fake\\config', space: null, tags: [] },
  { id: 'e5', title: 'Urgent task', cwd: 'C:\\fake\\x', space: null, tags: ['urgent'] },
  { id: 'f6', title: 'Work session', cwd: 'C:\\fake\\y', space: 'Work', tags: [] },
];

// Empty query and spaces-only query return all in the same order.
assert.deepEqual(matchSessions(sessions, ''), sessions);
assert.deepEqual(matchSessions(sessions, '   '), sessions);

// Case-insensitive: 'TEST' finds 'Naïve test session'.
assert.deepEqual(matchSessions(sessions, 'TEST'), [sessions[0]]);
// Accent-insensitive both ways: 'naive' finds 'Naïve', 'naïve' finds 'Naive'.
assert.deepEqual(matchSessions(sessions, 'naive'), sessions.slice(0, 2));
assert.deepEqual(matchSessions(sessions, 'naïve'), sessions.slice(0, 2));

// Several words in any order must ALL match, across title and cwd together.
assert.deepEqual(matchSessions(sessions, 'terminal refactor'), [sessions[2]]);
assert.deepEqual(matchSessions(sessions, 'initial setup'.split(' ').reverse().join(' ')), [sessions[3]]);
assert.deepEqual(matchSessions(sessions, 'test frugal'), [sessions[0]]);

// No match returns [].
assert.deepEqual(matchSessions(sessions, 'doesnotexist'), []);

// Order preserved.
assert.deepEqual(matchSessions(sessions, 'fake'), sessions);

const orgSessions = [
  { id: 't1', title: 'x', cwd: 'C:\\fake\\y', space: null, tags: ['urgent'] },
  { id: 't2', title: 'y', cwd: 'C:\\fake\\z', space: 'Work', tags: [] },
];
assert.deepEqual(matchSessions(orgSessions, 'urgent'), [orgSessions[0]]);
assert.deepEqual(matchSessions(orgSessions, '#urgent'), [orgSessions[0]]);
assert.deepEqual(matchSessions(orgSessions, 'work'), [orgSessions[1]]);

console.log('palette check ok');
