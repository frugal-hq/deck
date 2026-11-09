const pty = require('../01-tui/node_modules/node-pty');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [label, configDir, cwd] = process.argv.slice(2);
const exe = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ELECTRON_RUN_AS_NODE$|^NO_COLOR$/.test(k)));
if (configDir !== '-') env.CLAUDE_CONFIG_DIR = configDir;

const strip = s => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, ' ').replace(/\x1b[=>()][0-9A-Za-z]?/g, '').replace(/[ \t]+/g, ' ');
const sid = crypto.randomUUID();
const p = pty.spawn(exe, ['--session-id', sid, '--model', 'haiku', '--strict-mcp-config', '/usage'],
  { name: 'xterm-256color', cols: 120, rows: 40, cwd, env });
let out = '';
p.onData(d => { out += d; });
setTimeout(() => {
  fs.writeFileSync(path.join(__dirname, `screen-${label}.txt`), strip(out));
  p.kill();
  setTimeout(() => { console.log(sid, out.length); process.exit(0); }, 1000);
}, 25000);
