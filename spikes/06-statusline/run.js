const pty = require('../01-tui/node_modules/node-pty');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const js = f => path.join(__dirname, f).replace(/\\/g, '/');
const exe = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const log = path.join(__dirname, 'captured.jsonl');
const screen = path.join(__dirname, 'screen.txt');
fs.rmSync(log, { force: true });

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ELECTRON_RUN_AS_NODE$|^NO_COLOR$/.test(k)));
env.T6_LOG = log;
env.T6_CHAIN = `node "${js('user-line.js')}"`;

const settings = JSON.stringify({ statusLine: { type: 'command', command: `node "${js('capture.js')}"` } });
const sid = crypto.randomUUID();
const p = pty.spawn(exe, ['--session-id', sid, '--model', 'haiku', '--strict-mcp-config', '--settings', settings, 'responde solo ok'],
  { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env });
let out = '';
p.onData(d => { out += d; });
setTimeout(() => {
  fs.writeFileSync(screen, out);
  p.kill();
  setTimeout(() => {
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    const last = lines[lines.length - 1] || {};
    console.log(JSON.stringify({ sid, invocations: lines.length, keys: Object.keys(last), context_window: last.context_window, rate_limits: last.rate_limits, user_line_on_screen: /USERLINE/.test(out) }, null, 1));
    process.exit(0);
  }, 1000);
}, 45000);
