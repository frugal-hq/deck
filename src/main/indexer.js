// Incremental index of Claude Code transcripts. Runs as a worker thread and owns deck.db.
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHUNK = 1 << 20;
const BATCH = 500;

const text = (value) => (typeof value === 'string' ? value : null);

function openIndex(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    size INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    cwd TEXT,
    entrypoint TEXT,
    custom_title TEXT,
    ai_title TEXT,
    first_prompt TEXT,
    turns INTEGER NOT NULL,
    last_at TEXT
  )`);
  // Apart from sessions: syncFile replaces those rows, and this must survive a re-index.
  db.exec(`CREATE TABLE IF NOT EXISTS session_org (
    session_id TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL,
    space TEXT,
    tags TEXT NOT NULL
  )`);
  return db;
}

function promptTitle(content) {
  const prompt = typeof content === 'string' ? content : Array.isArray(content) ? content.find((block) => block?.type === 'text')?.text : null;
  if (typeof prompt !== 'string') return null;
  const command = prompt.match(/<command-name>(.*?)<\/command-name>/)?.[1];
  const args = prompt.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '';
  const title = prompt.match(/^Goal:\s*(.+)$/m)?.[1] ?? (command ? `${command} ${args}` : prompt.replace(/<[^>]+>/g, ' '));
  return title.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

function applyRecord(row, record) {
  if (record.isSidechain) return;
  if (record.type === 'custom-title') row.custom_title = text(record.customTitle);
  if (record.type === 'ai-title') row.ai_title = text(record.aiTitle);
  if (record.type === 'relocated') row.cwd = text(record.relocatedCwd) ?? row.cwd;
  row.cwd ??= text(record.cwd);
  row.entrypoint ??= text(record.entrypoint);
  if (record.type === 'user' && !record.isMeta && !record.toolUseResult) {
    row.turns += 1;
    row.first_prompt ??= promptTitle(record.message?.content);
  }
  // Only real messages count: opening with --resume appends other records.
  if (record.type === 'user' || record.type === 'assistant') row.last_at = text(record.timestamp) ?? row.last_at;
}

function parseLine(row, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record && typeof record === 'object') applyRecord(row, record);
}

// Returns the offset after the last complete line, so a half-written line is read again next time.
function readLines(file, start, onLine) {
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(CHUNK);
  let offset = start;
  let position = start;
  let pending = Buffer.alloc(0);
  try {
    for (let read; (read = fs.readSync(fd, chunk, 0, CHUNK, position)) > 0; position += read) {
      const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      let from = 0;
      for (let end; (end = data.indexOf(10, from)) !== -1; from = end + 1) onLine(data.toString('utf8', from, end));
      offset += from;
      pending = Buffer.from(data.subarray(from));
    }
  } finally {
    fs.closeSync(fd);
  }
  return offset;
}

const sessionId = (file) => path.basename(file, '.jsonl');

function syncFile(db, file) {
  const id = sessionId(file);
  const { size } = fs.statSync(file);
  let row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (row?.size === size) return false;
  // frugal: a rewrite that does not shrink the file goes unnoticed; compare a hash of the bytes before offset if that shows up.
  if (!row || size < row.offset) {
    row = { id, file, size, offset: 0, cwd: null, entrypoint: null, custom_title: null, ai_title: null, first_prompt: null, turns: 0, last_at: null };
  }
  row = { ...row, size };
  row.offset = readLines(file, row.offset, (line) => parseLine(row, line));
  db.prepare(`INSERT OR REPLACE INTO sessions (id, file, size, offset, cwd, entrypoint, custom_title, ai_title, first_prompt, turns, last_at)
    VALUES (:id, :file, :size, :offset, :cwd, :entrypoint, :custom_title, :ai_title, :first_prompt, :turns, :last_at)`).run(row);
  return true;
}

function removeSession(db, file) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId(file));
}

function scan(db, root, onBatch) {
  const seen = new Set();
  let changed = 0;
  db.exec('BEGIN');
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(root, project.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      seen.add(sessionId(entry.name));
      try {
        if (!syncFile(db, path.join(root, project.name, entry.name))) continue;
      } catch {
        continue;
      }
      if (++changed % BATCH === 0) {
        db.exec('COMMIT');
        onBatch();
        db.exec('BEGIN');
      }
    }
  }
  for (const { id, file } of db.prepare('SELECT id, file FROM sessions').all()) {
    if (!seen.has(id)) removeSession(db, file);
  }
  db.exec('COMMIT');
}

function listSessions(db) {
  const temp = path.join(os.tmpdir(), path.sep).toLowerCase();
  const usable = new Map();
  const isUsable = (cwd) => {
    if (!usable.has(cwd)) usable.set(cwd, !path.join(cwd, path.sep).toLowerCase().startsWith(temp) && fs.existsSync(cwd));
    return usable.get(cwd);
  };
  const sessions = [];
  // -p runs (sdk-cli) and sandboxes in Temp would bury the real chats; a missing cwd cannot be resumed.
  const rows = db.prepare(`SELECT id, cwd, COALESCE(NULLIF(custom_title, ''), NULLIF(ai_title, ''), first_prompt, 'Sin título') AS title, last_at AS lastAt, COALESCE(pinned, 0) AS pinned, space, COALESCE(tags, '[]') AS tags
    FROM sessions LEFT JOIN session_org ON session_id = id
    WHERE turns > 0 AND cwd IS NOT NULL AND last_at IS NOT NULL AND COALESCE(entrypoint, '') <> 'sdk-cli'
    ORDER BY last_at DESC`);
  for (const row of rows.iterate()) {
    if (!isUsable(row.cwd)) continue;
    sessions.push({ ...row, pinned: row.pinned === 1, tags: JSON.parse(row.tags) });
  }
  return sessions;
}

function cleanOrganization(input) {
  const { pinned, space, tags } = input ?? {};
  if (typeof pinned !== 'boolean' || typeof space !== 'string' || !Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) return null;
  const names = tags.map((tag) => tag.trim().replace(/^#+/, '')).filter(Boolean);
  return { pinned, space: space.trim() || null, tags: [...new Map(names.map((tag) => [tag.toLowerCase(), tag])).values()] };
}

// frugal: tags live as JSON on the row; a tags table when renaming a tag everywhere is needed.
function saveOrganization(db, id, input) {
  const clean = cleanOrganization(input);
  if (typeof id !== 'string' || !clean || !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) return false;
  const known = clean.space && db.prepare('SELECT space FROM session_org WHERE space = ? COLLATE NOCASE LIMIT 1').get(clean.space)?.space;
  db.prepare('INSERT OR REPLACE INTO session_org (session_id, pinned, space, tags) VALUES (?, ?, ?, ?)')
    .run(id, clean.pinned ? 1 : 0, known || clean.space, JSON.stringify(clean.tags));
  return true;
}

function runWorker({ root, dbFile }) {
  const db = openIndex(dbFile);
  const publish = (indexing) => parentPort.postMessage({ indexing, sessions: listSessions(db) });
  publish(true);
  if (!fs.existsSync(root)) return publish(false);
  scan(db, root, () => publish(true));
  publish(false);

  parentPort.on('message', ({ id, organization }) => {
    if (saveOrganization(db, id, organization)) publish(false);
  });
  const changed = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    for (const name of changed) {
      const file = path.join(root, name);
      try {
        syncFile(db, file);
      } catch (error) {
        if (error.code === 'ENOENT') removeSession(db, file);
      }
    }
    changed.clear();
    publish(false);
  };
  fs.watch(root, { recursive: true }, (_, name) => {
    // Subagent transcripts live one level deeper and are not sessions.
    if (!name?.endsWith('.jsonl') || name.split(path.sep).length !== 2) return;
    changed.add(name);
    timer ??= setTimeout(flush, 1000);
  });
}

if (parentPort) runWorker(workerData);

module.exports = { openIndex, syncFile, scan, listSessions, promptTitle, saveOrganization };
