const net = require('net');
const { spawnSync } = require('child_process');
const pty = require('../01-tui/node_modules/node-pty');

const [pipePath, token] = process.argv.slice(2);

let term = null;
let buf = '';

const sock = net.connect(pipePath);

function send(msg) {
  sock.write(JSON.stringify(msg) + '\n');
}

function quit() {
  if (term) {
    try {
      term.kill();
    } catch {}
    term = null;
  }
  process.exit(0);
}

sock.on('connect', () => {
  send({
    t: 'hello',
    token,
    pid: process.pid,
    elevated: spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0,
  });
});

sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  if (msg.t === 'start') {
    term = pty.spawn(msg.cmd, msg.args || [], {
      name: 'xterm-256color',
      cols: msg.cols,
      rows: msg.rows,
      cwd: msg.cwd,
      env: { ...process.env, ...(msg.env || {}) },
    });
    term.onData((d) => send({ t: 'out', d }));
    term.onExit(({ exitCode }) => send({ t: 'exit', code: exitCode }));
  } else if (msg.t === 'in') {
    if (term) term.write(msg.d);
  } else if (msg.t === 'resize') {
    if (term) term.resize(msg.cols, msg.rows);
  }
}

sock.on('close', quit);
sock.on('error', quit);

// frugal: the product must authenticate the server too (challenge with the token) and install this helper where non-admins cannot write.
