import assert from 'node:assert/strict';
import { matchSessions } from '../src/renderer/palette.mjs';

const sessions = [
  { id: 'a1', title: 'Sesión de prueba', cwd: 'C:\\Users\\fake\\frugal-deck', space: null, tags: [] },
  { id: 'b2', title: 'Sesion vieja', cwd: 'C:\\fake\\proyecto-x', space: null, tags: [] },
  { id: 'c3', title: 'Refactor terminal', cwd: 'C:\\fake\\frugal-deck', space: null, tags: [] },
  { id: 'd4', title: 'Configuración inicial', cwd: 'D:\\fake\\config', space: null, tags: [] },
  { id: 'e5', title: 'Urgente task', cwd: 'C:\\fake\\x', space: null, tags: ['urgente'] },
  { id: 'f6', title: 'Trabajo session', cwd: 'C:\\fake\\y', space: 'Trabajo', tags: [] },
];

// Empty query and spaces-only query return all in the same order.
assert.deepEqual(matchSessions(sessions, ''), sessions);
assert.deepEqual(matchSessions(sessions, '   '), sessions);

// Case-insensitive: 'PRUEBA' finds 'Sesión de prueba'.
assert.deepEqual(matchSessions(sessions, 'PRUEBA'), [sessions[0]]);
// Accent-insensitive both ways: 'sesion' finds 'Sesión', 'sesión' finds 'Sesion'.
assert.deepEqual(matchSessions(sessions, 'sesion'), sessions.slice(0, 2));
assert.deepEqual(matchSessions(sessions, 'sesión'), sessions.slice(0, 2));

// Several words in any order must ALL match, across title and cwd together.
assert.deepEqual(matchSessions(sessions, 'terminal refactor'), [sessions[2]]);
assert.deepEqual(matchSessions(sessions, 'inicial configuración'.split(' ').reverse().join(' ')), [sessions[3]]);
assert.deepEqual(matchSessions(sessions, 'prueba frugal'), [sessions[0]]);

// No match returns [].
assert.deepEqual(matchSessions(sessions, 'noexiste'), []);

// Order preserved.
assert.deepEqual(matchSessions(sessions, 'fake'), sessions);

const orgSessions = [
  { id: 't1', title: 'x', cwd: 'C:\\fake\\y', space: null, tags: ['urgente'] },
  { id: 't2', title: 'y', cwd: 'C:\\fake\\z', space: 'Trabajo', tags: [] },
];
assert.deepEqual(matchSessions(orgSessions, 'urgente'), [orgSessions[0]]);
assert.deepEqual(matchSessions(orgSessions, '#urgente'), [orgSessions[0]]);
assert.deepEqual(matchSessions(orgSessions, 'trabajo'), [orgSessions[1]]);

console.log('palette check ok');
