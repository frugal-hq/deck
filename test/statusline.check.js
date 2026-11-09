// Run with Electron's Node: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test/statusline.check.js
const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStatusBridge, readMeters, readUserStatusLine } = require('../src/main/statusline.js');

const EMPTY = { context: null, contextTokens: null, contextSize: null, inputTokens: null, outputTokens: null, fiveHour: null, sevenDay: null };
const FULL = {
  context_window: { used_percentage: 34.5, context_window_size: 200000, total_input_tokens: 12000, total_output_tokens: 3456 },
  rate_limits: { five_hour: { used_percentage: 67, resets_at: 1800000000 }, seven_day: { used_percentage: 13 } },
};

assert.deepStrictEqual(readMeters({}), EMPTY);
assert.deepStrictEqual(readMeters(null), EMPTY);
assert.deepStrictEqual(readMeters({ context_window: { used_percentage: null }, rate_limits: {} }), EMPTY);
assert.deepStrictEqual(readMeters({ context_window: { used_percentage: '40' } }), EMPTY);
assert.strictEqual(readMeters({ context_window: { used_percentage: -1 } }).context, null);
assert.strictEqual(readMeters({ context_window: { used_percentage: 130 } }).context, 100);
assert.deepStrictEqual(readMeters(FULL), {
  context: 34.5,
  contextTokens: 69000,
  contextSize: 200000,
  inputTokens: 12000,
  outputTokens: 3456,
  fiveHour: { pct: 67, resetsAt: 1800000000 },
  sevenDay: { pct: 13, resetsAt: null },
});

for (const value of [undefined, null, '20', NaN, Infinity, -Infinity]) {
  assert.deepStrictEqual(readMeters({ context_window: { used_percentage: value, context_window_size: value, total_input_tokens: value, total_output_tokens: value } }), EMPTY);
}
assert.equal(readMeters({ context_window: { context_window_size: 200000 } }).contextTokens, null);
assert.equal(readMeters({ context_window: { used_percentage: 20 } }).contextTokens, null);
assert.equal(readMeters({ context_window: { used_percentage: 33.3, context_window_size: 101 } }).contextTokens, 34);
assert.equal(readMeters({ context_window: { used_percentage: 130, context_window_size: 100 } }).contextTokens, 130);
assert.equal(readMeters({ context_window: { used_percentage: 0, context_window_size: 100, total_input_tokens: 0, total_output_tokens: 0 } }).inputTokens, 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-status-'));
const file = (text) => {
  const target = path.join(dir, `${Math.random()}.json`);
  fs.writeFileSync(target, text);
  return target;
};
assert.strictEqual(readUserStatusLine(path.join(dir, 'missing.json')), null);
assert.strictEqual(readUserStatusLine(file('{broken')), null);
assert.strictEqual(readUserStatusLine(file('null')), null);
assert.strictEqual(readUserStatusLine(file('{"statusLine":{"type":"other","command":"x"}}')), null);
assert.strictEqual(readUserStatusLine(file('{"statusLine":{"type":"command","command":5}}')), null);
assert.deepStrictEqual(readUserStatusLine(file('{"statusLine":{"type":"command","command":"x","padding":2}}')), { type: 'command', command: 'x', padding: 2 });

// Never execFileSync here: the server shares this event loop.
const run = (shell, args, input) => new Promise((resolve, reject) => {
  const child = execFile(shell, args, { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  child.stdin.end(input);
});
const bash = 'C:/Program Files/Git/bin/bash.exe';

(async () => {
  const seen = [];
  const bridge = createStatusBridge((id, meters) => seen.push({ id, meters }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const env = process.env;
  const plain = bridge.register({ id: 'a', cwd: dir, env, statusLine: null });
  assert.deepStrictEqual(Object.keys(plain.statusLine).sort(), ['command', 'type']);
  const url = plain.statusLine.command.split(' ').pop();
  const post = (target, body, method = 'POST') => fetch(target, { method, body });

  assert.strictEqual((await post(url.replace(plain.token, 'nope'), '{}')).status, 404);
  assert.strictEqual((await fetch(url)).status, 404);
  assert.strictEqual((await post(url, 'not json')).status, 400);
  assert.strictEqual(seen.length, 0, 'rejected requests must not reach the UI');

  // The exact command Claude Code receives, in both shells it can use on Windows.
  assert.strictEqual(await run(bash, ['-c', plain.statusLine.command], JSON.stringify(FULL)), '');
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0], { id: 'a', meters: readMeters(FULL) });
  await run('powershell.exe', ['-NoProfile', '-Command', plain.statusLine.command], JSON.stringify(FULL));
  assert.strictEqual(seen.length, 2, 'PowerShell must deliver the same payload');

  const chained = bridge.register({ id: 'b', cwd: dir, env, statusLine: { type: 'command', command: 'read -r line; echo "USER:${#line}"', padding: 3 } });
  assert.strictEqual(chained.statusLine.padding, 3);
  const body = JSON.stringify(FULL);
  assert.strictEqual((await run(bash, ['-c', chained.statusLine.command], body)).trim(), `USER:${body.length}`);

  bridge.release(chained.token);
  assert.strictEqual((await post(chained.statusLine.command.split(' ').pop(), '{}')).status, 404);
  bridge.close();
  fs.rmSync(dir, { recursive: true });
  console.log('statusline.check ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
