import assert from 'node:assert/strict';
import { trustPromptKey } from '../src/renderer/trust.mjs';

const screen = (...options) => ['Accessing workspace:', '', 'C:\\Windows\\Web', '', 'Security guide', '', ...options, '', 'Enter to confirm · Esc to cancel'];

assert.equal(trustPromptKey(screen('❯ No, exit', 'Yes, I trust this folder')), '\x1b[B');
assert.equal(trustPromptKey(screen('No, exit', '❯ Yes, I trust this folder')), '\r');
assert.equal(trustPromptKey(screen('> No, exit', 'Yes, I trust this folder')), '\x1b[B');
assert.equal(trustPromptKey(screen('No, exit', '> Yes, I trust this folder')), '\r');

// A reworded prompt or a chat that merely quotes the option is left to the user.
assert.equal(trustPromptKey(screen('❯ Leave', 'Trust')), null);
assert.equal(trustPromptKey(['❯ Yes, I trust this folder']), null);
assert.equal(trustPromptKey(['Accessing workspace:', '❯ Yes, I trust this folder']), null);
assert.equal(trustPromptKey(screen('● ❯ Yes, I trust this folder')), null);
console.log('trust ok');
