const assert = require('assert/strict');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { HELPER_FLAG, createElevatedHost, proof } = require('../src/main/elevated');

// The helper runs unelevated here, under the same binary as plain Node, with no UAC prompt.
const runHelper = (args) => spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../src/main/elevated'))}).runHelper(process.argv)`, '--', ...args], { stdio: 'ignore' });
const elevatedShell = require('child_process').spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;

async function handshake() {
  let launches = 0;
  const host = createElevatedHost({ exe: '', args: [] }, (_, args) => (launches++, runHelper(args)));
  const echo = (text) => host.spawn(process.env.ComSpec, ['/c', `echo ${text}`], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
  if (!elevatedShell) {
    // Both proofs passed: the Deck only reads the helper's elevation after checking its proof.
    await assert.rejects(echo('elevated-ok'), /did not give the chat administrator rights/);
    return;
  }
  // Two chats share one helper, so Windows would ask once, and each gets only its own output.
  const outputs = await Promise.all(['first-ok', 'second-ok'].map(async (text) => {
    const child = await echo(text);
    let out = '';
    child.onData((data) => (out += data));
    await new Promise((resolve) => child.onExit(resolve));
    return out;
  }));
  assert.equal(launches, 1);
  assert.match(outputs[0], /first-ok/);
  assert.doesNotMatch(outputs[0], /second-ok/);
  assert.match(outputs[1], /second-ok/);
}

// A pipe server without the secret gets no proof from the helper, which quits.
async function impostor() {
  const pipe = `\\\\.\\pipe\\frugal-deck-${crypto.randomBytes(16).toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const replies = [];
  await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        for (const line of buffer.split('\n').slice(0, -1)) {
          const message = JSON.parse(line);
          replies.push(message.t);
          if (message.t === 'hello') socket.write(`${JSON.stringify({ t: 'proof', mac: proof(crypto.randomBytes(32).toString('hex'), 'deck', message.nonce), nonce: 'x' })}\n`);
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
      });
      socket.on('close', () => server.close(resolve));
      socket.on('error', () => {});
    });
    server.on('error', reject);
    server.listen(pipe, () => runHelper([HELPER_FLAG, pipe, secret]));
  });
  assert.deepEqual(replies, ['hello']);
}

(async () => {
  await handshake();
  await impostor();
  console.log(`elevated ok${elevatedShell ? '' : ' (unelevated shell: relay not run)'}`);
  // The shared helper stays up for later chats; exiting closes its pipe, and it quits.
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
