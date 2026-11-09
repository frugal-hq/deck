const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const CHAIN_TIMEOUT_MS = 4000;

const percent = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(value, 100) : null);

function limit(window) {
  const pct = percent(window?.used_percentage);
  return pct === null ? null : { pct, resetsAt: Number.isFinite(window.resets_at) ? window.resets_at : null };
}

// The first invocations of a session omit these fields or send null (Test 6).
function readMeters(input) {
  const window = input?.context_window;
  const finite = (value) => Number.isFinite(value) ? value : null;
  return {
    context: percent(window?.used_percentage),
    contextTokens: Number.isFinite(window?.used_percentage) && Number.isFinite(window?.context_window_size) ? finite(Math.round(window.used_percentage / 100 * window.context_window_size)) : null,
    contextSize: finite(window?.context_window_size),
    inputTokens: finite(window?.total_input_tokens),
    outputTokens: finite(window?.total_output_tokens),
    fiveHour: limit(input?.rate_limits?.five_hour),
    sevenDay: limit(input?.rate_limits?.seven_day),
  };
}

// Only the user-level setting: a project's .claude/settings.json is untrusted until Claude's trust
// dialog is accepted, and running its command here would bypass that dialog.
function readUserStatusLine(file) {
  try {
    const { statusLine } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return statusLine?.type === 'command' && typeof statusLine.command === 'string' ? statusLine : null;
  } catch {
    return null;
  }
}

// Same order as Claude Code on Windows: Git Bash when installed, otherwise PowerShell.
// frugal: only finds Git Bash through git on PATH; add a setting if other layouts turn up.
function findChainShell() {
  try {
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0];
    const bash = ['../bin/bash.exe', '../../bin/bash.exe'].map((p) => path.join(path.dirname(git), p)).find(fs.existsSync);
    if (bash) return { file: bash, args: ['-c'] };
  } catch {}
  return { file: 'powershell.exe', args: ['-NoProfile', '-Command'] };
}

const runChain = ({ shell, command, cwd, env }, stdin) => new Promise((resolve) => {
  const child = execFile(shell.file, [...shell.args, command], { cwd, env, timeout: CHAIN_TIMEOUT_MS, windowsHide: true }, (_, stdout) => resolve(stdout ?? ''));
  child.stdin?.on('error', () => {});
  child.stdin?.end(stdin);
});

// curl.exe ships with Windows and runs the same from Git Bash and PowerShell, so a native
// Claude install needs neither Node nor ELECTRON_RUN_AS_NODE in its environment.
function createStatusBridge(onMeters) {
  const clients = new Map();

  const server = http.createServer((req, res) => {
    const client = clients.get(req.url.slice(1));
    if (req.method !== 'POST' || !client) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      onMeters(client.id, readMeters(input));
      res.end(client.chain ? await runChain(client.chain, body) : '');
    });
  });
  server.listen(0, '127.0.0.1');

  return {
    register({ id, cwd, env, statusLine }) {
      const token = crypto.randomBytes(24).toString('hex');
      const chain = statusLine && { shell: findChainShell(), command: statusLine.command, cwd, env };
      clients.set(token, { id, chain });
      const url = `http://127.0.0.1:${server.address().port}/${token}`;
      const command = `curl.exe -s -m 5 --noproxy 127.0.0.1 --data-binary "@-" ${url}`;
      return { token, statusLine: { ...statusLine, type: 'command', command } };
    },
    release: (token) => clients.delete(token),
    close: () => server.close(),
  };
}

module.exports = { createStatusBridge, readMeters, readUserStatusLine };
