const assert = require('assert/strict');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { HELPER_FLAG, spawnElevated, proof } = require('../src/main/elevated');

// The helper runs unelevated here, under the same binary as plain Node, with no UAC prompt.
const runHelper = (args) => spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../src/main/elevated'))}).runHelper(process.argv)`, '--', ...args], { stdio: 'ignore' });
const elevatedShell = require('child_process').spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0;

async function handshake() {
  const started = spawnElevated(process.env.ComSpec, ['/c', 'echo elevated-ok'], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env }, { exe: '', args: [] }, (_, args) => runHelper(args));
  if (!elevatedShell) {
    // Both proofs passed: the Deck only reads the helper's elevation after checking its proof.
    await assert.rejects(started, /did not give the chat administrator rights/);
    return;
  }
  const child = await started;
  let out = '';
  child.onData((data) => (out += data));
  await new Promise((resolve) => child.onExit(resolve));
  assert.match(out, /elevated-ok/);
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
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
