const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const pipePath = '\\\\.\\pipe\\frugal-deck-t4-' + crypto.randomBytes(16).toString('hex');
const token = crypto.randomBytes(32).toString('hex');
const helperPath = path.join(__dirname, 'helper.js');
const expectedElevated = !process.env.T4_NO_UAC;

const checks = {};
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
let rawOut = '';
// ConPTY positions lines with cursor moves instead of newlines and may skip spaces with cursor-forward.
const strip = () => rawOut.replace(/\x1b\[\d*;?\d*H/g, '\n').replace(/\x1b\[\d*C/g, ' ').replace(ANSI, '');

let sock = null;
let exitMsg = null;
let exitResolve = null;

setTimeout(() => {
  console.log(JSON.stringify(checks));
  process.exit(2);
}, 120000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(regex, ms = 20000) {
  const start = strip().length;
  return new Promise((resolve) => {
    const began = Date.now();
    const iv = setInterval(() => {
      if (regex.test(strip().slice(start))) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - began >= ms) {
        clearInterval(iv);
        resolve(false);
      }
    }, 50);
  });
}

function send(msg) {
  sock.write(JSON.stringify(msg) + '\n');
}

function onMsg(msg) {
  if (msg.t === 'out') {
    rawOut += msg.d;
  } else if (msg.t === 'exit') {
    exitMsg = msg;
    if (exitResolve) {
      const r = exitResolve;
      exitResolve = null;
      r(msg);
    }
  }
}

async function onHello(hello) {
  checks.helperElevated = hello.elevated === expectedElevated;

  send({
    t: 'start',
    cols: 80,
    rows: 24,
    cmd: 'cmd.exe',
    args: [],
    cwd: process.cwd(),
    env: { FRUGAL_T4: 'pipe-env-ok' },
  });
  checks.output = await waitFor(/>/);

  const steps = [
    ['ptyElevation', 'net session >nul 2>&1 && echo ELEV-YES || echo ELEV-NO',
      expectedElevated ? /^ELEV-YES\s*$/m : /^ELEV-NO\s*$/m, 20000],
    ['env', 'echo %FRUGAL_T4%', /^pipe-env-ok\s*$/m, 20000],
    ['claudeReachable', 'claude.cmd --version', /\d+\.\d+\.\d+ \(Claude Code\)/, 30000],
  ];
  for (const [name, line, re, ms] of steps) {
    send({ t: 'in', d: line + '\r' });
    checks[name] = await waitFor(re, ms);
  }

  send({ t: 'resize', cols: 132, rows: 40 });
  await sleep(500);
  send({ t: 'in', d: "powershell -NoProfile -c \"'W='+[Console]::WindowWidth\"" + '\r' });
  checks.resize = await waitFor(/W=132/, 30000);

  send({ t: 'in', d: 'exit\r' });
  checks.childExit = await new Promise((resolve) => {
    if (exitMsg) return resolve(true);
    exitResolve = () => resolve(true);
    setTimeout(() => resolve(false), 10000);
  });

  if (sock) sock.destroy();
  await sleep(2000);

  const tl = spawnSync('tasklist', ['/FI', `PID eq ${hello.pid}`, '/NH'], { encoding: 'utf8' });
  checks.helperGone = !String(tl.stdout || '').includes(String(hello.pid));

  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify(checks));
  process.exit(ok ? 0 : 1);
}

const server = net.createServer((socket) => {
  let buf = '';
  let authed = false;
  socket.on('data', (chunk) => {
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
      if (!authed) {
        if (msg.t !== 'hello' || msg.token !== token) {
          socket.destroy();
          return;
        }
        authed = true;
        sock = socket;
        server.close();
        onHello(msg);
      } else {
        onMsg(msg);
      }
    }
  });
  socket.on('close', () => {});
  socket.on('error', () => {});
});

server.on('error', (err) => {
  console.error(err.message);
  process.exit(2);
});

server.listen(pipePath, () => {
  if (process.env.T4_NO_UAC) {
    spawn(process.execPath, [helperPath, pipePath, token], { stdio: 'inherit' });
  } else {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath '${process.execPath}' -Verb RunAs -WindowStyle Hidden -ArgumentList '"${helperPath}" "${pipePath}" "${token}"'`],
      { stdio: 'inherit' }
    );
    ps.on('exit', (code) => {
      if (code !== 0) {
        console.log('UAC declined or failed');
        process.exit(3);
      }
    });
  }
});
