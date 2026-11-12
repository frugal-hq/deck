// Administrator chats: one elevated copy of the Deck hosts their PTYs and relays them over a named pipe, so Windows
// asks UAC once, the first time (see launchElevated). The unelevated Deck owns the pipe, and each end proves it holds the secret before a PTY starts
// (spikes/04-elevated). Every message after the handshake names its chat's channel in `c`.
// frugal: the secret rides in the helper's arguments; a release build must install the helper where non-admins cannot write.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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

// The same surface launchChat uses from node-pty, for one channel of the shared pipe.
function remotePty(socket, c, onEnd) {
  const dataListeners = new Set();
  const exitListeners = new Set();
  let exited = false;
  const exit = (exitCode) => {
    if (exited) return;
    exited = true;
    onEnd();
    for (const listener of exitListeners) listener({ exitCode });
  };
  return {
    handle(message) {
      if (message.t === 'out' && typeof message.d === 'string') for (const listener of dataListeners) listener(message.d);
      else if (message.t === 'exit') exit(Number.isInteger(message.code) ? message.code : 1);
    },
    exit,
    write: (data) => !exited && sendTo(socket, { t: 'in', c, d: data }),
    resize: (cols, rows) => !exited && sendTo(socket, { t: 'resize', c, cols, rows }),
    // The helper kills the PTY, and its exit message comes back on the channel.
    kill: () => !exited && sendTo(socket, { t: 'kill', c }),
    onData: (listener) => (dataListeners.add(listener), { dispose: () => dataListeners.delete(listener) }),
    onExit: (listener) => (exitListeners.add(listener), { dispose: () => exitListeners.delete(listener) }),
  };
}

// The first elevated helper registers a scheduled task that runs it with highest privileges, so later Deck runs start it
// without UAC; Task Scheduler puts the pipe and secret into $(Arg0) and $(Arg1).
// frugal: any process of this user can run the task, and the Deck folder is user-writable until the installer (Phase 7).
const TASK_FOLDER = '\\Frugal Deck';
const TASK_NAME = 'Administrator helper';
const quote = (text) => `'${text.replace(/'/g, "''")}'`;
const taskArguments = (prefix) => [...prefix.map((arg) => `"${arg}"`), HELPER_FLAG, '$(Arg0)', '$(Arg1)'].join(' ');
// Exits 0 when the task exists and still starts this exe with these arguments.
const findTask = (exe, prefix) => `try { $service = New-Object -ComObject Schedule.Service; $service.Connect(); $task = $service.GetFolder(${quote(TASK_FOLDER)}).GetTask(${quote(TASK_NAME)}); $action = $task.Definition.Actions.Item(1); $current = $action.Path -eq ${quote(exe)} -and $action.Arguments -eq ${quote(taskArguments(prefix))} } catch { $current = $false; $why = "$_" }`;

const powershell = (script, callback) => execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true }, callback);

// Why a run fell back to UAC goes to this log.
const LOG = path.join(os.homedir(), '.frugal-deck', 'elevated.log');

// Start-Process fails when the UAC prompt is declined. args ends with the flag, pipe and secret.
function launchElevated(exe, args, onFail) {
  const [pipe, secret] = args.slice(-2);
  const argumentList = args.map((arg) => `"${arg}"`).join(' ');
  const script = `${findTask(exe, args.slice(0, -3))}
if ($current) { try { $task.Run([string[]]@(${quote(pipe)}, ${quote(secret)})) | Out-Null; exit 0 } catch { "task run failed: $_" } } elseif ($why) { "task lookup failed: $why" } else { "task missing or changed: $($action.Path) $($action.Arguments)" }
Start-Process -FilePath ${quote(exe)} -ArgumentList ${quote(argumentList)} -Verb RunAs -WindowStyle Hidden`;
  powershell(script, (error, stdout) => {
    if (stdout.trim()) fs.appendFile(LOG, `${new Date().toISOString()} ${stdout.trim()}\n`, () => {});
    if (error) onFail();
  });
}

// Runs in the elevated helper, which may create the task. A failure only means the next Deck run asks UAC again.
function registerTask(exe, prefix) {
  const script = `${findTask(exe, prefix)}
if ($current) { exit 0 }
$action = New-ScheduledTaskAction -Execute ${quote(exe)} -Argument ${quote(taskArguments(prefix))}
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances Parallel -Priority 4
Register-ScheduledTask -TaskPath ${quote(`${TASK_FOLDER}\\`)} -TaskName ${quote(TASK_NAME)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null`;
  powershell(script, () => {});
}

// helper: { exe, args } that start this app; Windows shows the UAC prompt for it. launch is swapped only by the check.
// The first administrator chat starts the helper; later ones reuse it until the pipe closes, which ends all of them.
function createElevatedHost(helper, launch = launchElevated) {
  let connection = null;

  async function spawn(file, args, { cols, rows, cwd, env }) {
    connection ??= connect().catch((error) => {
      connection = null;
      throw error;
    });
    const { socket, channels } = await connection;
    // The helper quit while this chat waited on it: start a new one.
    if (!socket.writable) {
      connection = null;
      return spawn(file, args, { cols, rows, cwd, env });
    }
    const c = nonce();
    const child = remotePty(socket, c, () => channels.delete(c));
    channels.set(c, child);
    sendTo(socket, { t: 'start', c, file, args, cols, rows, cwd, env });
    return child;
  }

  const connect = () => new Promise((resolve, reject) => {
    const pipe = `\\\\.\\pipe\\frugal-deck-${crypto.randomBytes(16).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    let settled = false;
    const server = net.createServer((socket) => {
      if (settled) return socket.destroy();
      const mine = nonce();
      const channels = new Map();
      let step = 'hello';
      socket.on('error', () => {});
      socket.on('close', () => {
        if (step !== 'running') return;
        connection = null;
        for (const child of channels.values()) child.exit(1);
      });
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
          resolve({ socket, channels });
        } else if (step === 'running' && typeof message.c === 'string') {
          channels.get(message.c)?.handle(message);
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

  return { spawn };
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
  const terms = new Map();
  const quit = () => {
    for (const term of terms.values()) {
      try {
        term.kill();
      } catch {}
    }
    process.exit(0);
  };
  socket.on('connect', () => sendTo(socket, { t: 'hello', nonce: mine }));
  onLines(socket, (message) => {
    if (step === 'proof') {
      if (message.t !== 'proof' || !matches(message.mac, proof(secret, 'deck', mine)) || typeof message.nonce !== 'string') return quit();
      step = 'running';
      const elevated = spawnSync(path.join(SYSTEM32, 'net.exe'), ['session'], { stdio: 'ignore', windowsHide: true }).status === 0;
      sendTo(socket, { t: 'proof', mac: proof(secret, 'helper', message.nonce), elevated });
      if (elevated) registerTask(process.execPath, argv.slice(1, at));
      return;
    }
    const { c } = message;
    if (typeof c !== 'string' || !/^[0-9a-f]{32}$/.test(c)) return quit();
    // in, resize and kill can race a PTY's exit, so an unknown channel is ignored rather than fatal.
    const term = terms.get(c);
    if (message.t === 'start' && !terms.has(c)) {
      let child;
      try {
        child = pty.spawn(message.file, message.args, { name: 'xterm-256color', cols: message.cols, rows: message.rows, cwd: message.cwd, env: message.env });
      } catch {
        return sendTo(socket, { t: 'exit', c, code: 1 });
      }
      terms.set(c, child);
      child.onData((data) => sendTo(socket, { t: 'out', c, d: data }));
      child.onExit(({ exitCode }) => {
        terms.delete(c);
        sendTo(socket, { t: 'exit', c, code: exitCode });
      });
    } else if (message.t === 'in' && typeof message.d === 'string') {
      term?.write(message.d);
    } else if (message.t === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      term?.resize(message.cols, message.rows);
    } else if (message.t === 'kill') {
      try {
        term?.kill();
      } catch {}
    } else {
      quit();
    }
  });
  socket.on('close', quit);
  socket.on('error', quit);
}

module.exports = { HELPER_FLAG, createElevatedHost, runHelper, proof };
