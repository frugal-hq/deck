const fs = require('fs');
const { spawnSync } = require('child_process');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.T6_LOG, input.replace(/\r?\n/g, ' ') + '\n');
const r = spawnSync(process.env.T6_CHAIN, { shell: true, input, encoding: 'utf8', timeout: 5000 });
process.stdout.write(r.stdout || '');
