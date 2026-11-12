// Run with Electron's Node: ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe test/mcp.check.js
const assert = require('assert');
const { parseMcpList } = require('../src/main/mcp.js');

const sample = [
  'Checking MCP server health...',
  '',
  'claude.ai Linear: https://mcp.linear.app/mcp - ✓ Connected',
  'plugin:frugal:accounts: python server.py - ✓ Connected',
  'pylon: https://x/mcp (HTTP) - ✗ Failed to connect',
  'Header line',
].join('\n');

assert.deepStrictEqual(parseMcpList(sample), [
  { name: 'claude.ai Linear', status: '✓ Connected' },
  { name: 'plugin:frugal:accounts', status: '✓ Connected' },
  { name: 'pylon', status: '✗ Failed to connect' },
]);

console.log('mcp ok');
