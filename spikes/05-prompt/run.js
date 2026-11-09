const pty = require('../01-tui/node_modules/node-pty');
const [variant, sid] = process.argv.slice(2);
const block = ['/frugal code', 'Goal: Prueba T5, responde solo ok.', 'Done:', '- Nada todavia.', 'Next step: responder ok'].join('\n');
const claudeArgs = ['--session-id', sid, '--model', 'haiku', '--strict-mcp-config', block];
if (variant === 'shim') {
  var file = 'cmd.exe', args = ['/c', 'claude', ...claudeArgs];
} else {
  var file = process.env.T5_EXE, args = [...JSON.parse(process.env.T5_PRE || '[]'), ...claudeArgs];
}
const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: process.env });
p.onData(() => {});
setTimeout(() => { p.kill(); setTimeout(() => process.exit(0), 1000); }, 70000);
