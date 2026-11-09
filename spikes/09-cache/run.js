const { spawnSync } = require('child_process');
const path = require('path');

const [configDir, a, b] = process.argv.slice(2);
const exe = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ELECTRON_RUN_AS_NODE$|^NO_COLOR$/.test(k)));
env.CLAUDE_CONFIG_DIR = configDir;

for (const round of [1, 2]) for (const flag of [false, true]) for (const [name, cwd] of [['a', a], ['b', b]]) {
  const args = ['-p', 'responde solo ok', '--model', 'haiku', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json'];
  if (flag) args.push('--exclude-dynamic-system-prompt-sections');
  const r = spawnSync(exe, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
  const u = JSON.parse(r.stdout).usage;
  console.log([`ronda${round}`, flag ? 'flag' : 'sin', name, `in=${u.input_tokens}`, `crea=${u.cache_creation_input_tokens}`, `lee=${u.cache_read_input_tokens}`].join(' '));
}
