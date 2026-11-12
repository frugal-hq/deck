// Parse the output of `claude mcp list` into server entries.
function parseMcpList(text) {
  const servers = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Checking MCP server health/i.test(line)) continue;
    const separator = line.search(/[^:]: /);
    if (separator === -1) continue;
    const name = line.slice(0, separator + 1).trim();
    const rest = line.slice(separator + 2).trim();
    const dash = rest.lastIndexOf(' - ');
    if (dash === -1) continue;
    const status = rest.slice(dash + 3).trim();
    if (!name || !status) continue;
    servers.push({ name, status });
  }
  return servers;
}

module.exports = { parseMcpList };

if (require.main === module) {
  const assert = require('assert');
  const sample = [
    'Checking MCP server health...',
    '',
    'claude.ai Linear: https://mcp.linear.app/mcp - ✓ Connected',
    'plugin:frugal:accounts: python server.py - ✓ Connected',
    'pylon: https://x/mcp (HTTP) - ✗ Failed to connect',
    'Some header line without separator',
  ].join('\n');
  assert.deepStrictEqual(parseMcpList(sample), [
    { name: 'claude.ai Linear', status: '✓ Connected' },
    { name: 'plugin:frugal:accounts', status: '✓ Connected' },
    { name: 'pylon', status: '✗ Failed to connect' },
  ]);
  console.log('mcp ok');
}
