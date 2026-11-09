// Frugal handoff blocks join sessions into chats; no model call is involved.
const crypto = require('crypto');

const CUT = /<\/pasted_content|<\/command-args/;
const GOAL = /^\s*Goal:/;
const DONE = /^\s*Done:/;
const PENDING = /^\s*Pending:/;
const FENCE = /^\s*```/;
const USAGE = /^\s*Usage:/;

function handoffBlock(body) {
  if (typeof body !== 'string') return null;
  const cut = body.search(CUT);
  const lines = (cut === -1 ? body : body.slice(0, cut)).split(/\r?\n/);
  const from = lines.findIndex((line) => GOAL.test(line));
  if (from === -1) return null;
  let taken = lines.slice(from);
  const fence = taken.findIndex((line, i) => i > 0 && FENCE.test(line));
  if (fence !== -1) taken = taken.slice(0, fence);
  if (!taken.some((line) => DONE.test(line)) || !taken.some((line) => PENDING.test(line))) return null;
  const kept = taken
    .filter((line) => !USAGE.test(line))
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return { hash: crypto.createHash('sha1').update(kept.join('\n')).digest('hex'), goal: kept[0].replace(/^Goal:/, '').trim() };
}

function pickOrigin({ id, hash, goal, at }, emissions) {
  const earlier = emissions.filter((row) => row.session_id !== id && row.at < at);
  const exact = earlier.filter((row) => row.hash === hash);
  const pool = exact.length ? exact : earlier.filter((row) => row.goal === goal);
  if (!pool.length) return { parent: null, candidates: [] };
  const latest = pool.reduce((a, row) => (row.at > a ? row.at : a), pool[0].at);
  const top = [...new Set(pool.filter((row) => row.at === latest).map((row) => row.session_id))];
  return top.length === 1 ? { parent: top[0], candidates: [] } : { parent: null, candidates: top };
}

module.exports = { handoffBlock, pickOrigin };
