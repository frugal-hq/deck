// An administrator chat: a UAC-elevated copy of the Deck hosts the PTY and relays it over a named pipe.
// The unelevated Deck owns the pipe, and each end proves it holds the secret before a PTY starts (spikes/04-elevated).
// frugal: the secret rides in the helper's arguments; a release build must install the helper where non-admins cannot write.
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const HELPER_FLAG = '--elevated-helper';
// The UAC prompt waits for the user.
const CONNECT_MS = 120000;
const MAX_LINE = 8 * 1024 * 1024;
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const proof = (secret, side, nonce) => crypto.createHmac('sha256', secret).update(`${side}:${nonce}`).digest('hex');
const matches = (value, expected) => typeof value === 'string' && value.length === expected.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
const nonce = () => crypto.randomBytes(16).toString('hex');
const sendTo = (socket, message) => socket.writable && socket.write(`${JSON.stringify(message)}\n`);

// One JSON message per line; anything else ends the connection.
function onLines(socket, onMessage) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return socket.destroy();
      }
      onMessage(message);
      if (socket.destroyed) return;
    }
    if (buffer.length > MAX_LINE) socket.destroy();
  });
}

// The same surface launchChat uses from node-pty.
function remotePty(socket) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  let exited = false;
  const exit = (exitCode) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode });
    socket.destroy();
  };
  socket.on('close', () => exit(1));
  socket.on('error', () => {});
  return {
    handle(message) {
      if (message.t === 'out' && typeof message.d === 'string') for (const listener of dataListeners) listener(message.d);
      else if (message.t === 'exit') exit(Number.isInteger(message.code) ? message.code : 1);
    },
    write: (data) => sendTo(socket, { t: 'in', d: data }),
    resize: (cols, rows) => sendTo(socket, { t: 'resize', cols, rows }),
    // The helper kills its PTY and quits when the pipe closes.
    kill: () => socket.destroy(),
    onData: (listener) => (dataListeners.add(listener), { dispose: () => dataListeners.delete(listener) }),
    onExit: (listener) => (exitListeners.add(listener), { dispose: () => exitListeners.delete(listener) }),
  };
}

// Start-Process fails when the UAC prompt is declined.
function launchElevated(exe, args, onFail) {
  const quote = (text) => `'${text.replace(/'/g, "''")}'`;
  const argumentList = args.map((arg) => `"${arg}"`).join(' ');
  const script = `Start-Process -FilePath ${quote(exe)} -ArgumentList ${quote(argumentList)} -Verb RunAs -WindowStyle Hidden`;
  execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }, (error) => {
    if (error) onFail();
  });
}

// helper: { exe, args } that start this app; Windows shows the UAC prompt for it. launch is swapped only by the check.
function spawnElevated(file, args, { cols, rows, cwd, env }, helper, launch = launchElevated) {
  const pipe = `\\\\.\\pipe\\frugal-deck-${crypto.randomBytes(16).toString('hex')}`;
  const secret = crypto.randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = net.createServer((socket) => {
      if (settled) return socket.destroy();
      const mine = nonce();
      let step = 'hello';
      let child;
      socket.on('error', () => {});
      onLines(socket, (message) => {
        if (step === 'hello' && message.t === 'hello' && typeof message.nonce === 'string') {
          step = 'proof';
          sendTo(socket, { t: 'proof', mac: proof(secret, 'deck', message.nonce), nonce: mine });
        } else if (step === 'proof' && message.t === 'proof' && matches(message.mac, proof(secret, 'helper', mine))) {
          if (message.elevated !== true) {
            socket.destroy();
            return fail('Windows did not give the chat administrator rights.');
          }
          step = 'running';
          settled = true;
          clearTimeout(timer);
          server.close();
          child = remotePty(socket);
          sendTo(socket, { t: 'start', file, args, cols, rows, cwd, env });
          resolve(child);
        } else if (step === 'running') {
          child.handle(message);
        } else {
          socket.destroy();
        }
      });
    });
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('The administrator chat did not start in time.'), CONNECT_MS);
    server.on('error', (error) => fail(error.message));
    server.listen(pipe, () => launch(helper.exe, [...helper.args, HELPER_FLAG, pipe, secret], () => fail('Windows administrator permission was not granted.')));
  });
}

// Runs in the elevated copy instead of the app.
function runHelper(argv) {
  const at = argv.indexOf(HELPER_FLAG);
  const [pipe, secret] = argv.slice(at + 1, at + 3);
  if (!/^\\\\\.\\pipe\\frugal-deck-[0-9a-f]{32}$/.test(pipe ?? '') || !/^[0-9a-f]{64}$/.test(secret ?? '')) process.exit(1);
  const pty = require('node-pty');
  const mine = nonce();
  const socket = net.connect(pipe);
  let step = 'proof';
  let term = null;
  const quit = () => {
    try {
      term?.kill();
    } catch {}
    process.exit(0);
  };
  socket.on('connect', () => sendTo(socket, { t: 'hello', nonce: mine }));
  onLines(socket, (message) => {
    if (step === 'proof') {
      if (message.t !== 'proof' || !matches(message.mac, proof(secret, 'deck', mine)) || typeof message.nonce !== 'string') return quit();
      step = 'start';
      const elevated = spawnSync(path.join(SYSTEM32, 'net.exe'), ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
      sendTo(socket, { t: 'proof', mac: proof(secret, 'helper', message.nonce), elevated });
    } else if (step === 'start' && message.t === 'start') {
      step = 'running';
      try {
        term = pty.spawn(message.file, message.args, { name: 'xterm-256color', cols: message.cols, rows: message.rows, cwd: message.cwd, env: message.env });
      } catch {
        sendTo(socket, { t: 'exit', code: 1 });
        return socket.end();
      }
      term.onData((data) => sendTo(socket, { t: 'out', d: data }));
      term.onExit(({ exitCode }) => {
        sendTo(socket, { t: 'exit', code: exitCode });
        socket.end();
      });
    } else if (step === 'running' && message.t === 'in' && typeof message.d === 'string') {
      term.write(message.d);
    } else if (step === 'running' && message.t === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      term.resize(message.cols, message.rows);
    } else {
      quit();
    }
  });
  socket.on('close', quit);
  socket.on('error', quit);
}

module.exports = { HELPER_FLAG, spawnElevated, runHelper, proof };
