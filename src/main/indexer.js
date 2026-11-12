// Incremental index of Claude Code transcripts. Runs as a worker thread and owns deck.db.
const { parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handoffBlock, pickOrigin, nextBlock, contextTokens } = require('./handoff');

const CHUNK = 1 << 20;
const BATCH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const text = (value) => (typeof value === 'string' ? value : null);

function openIndex(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // user_version below 1 marks a pre-handoff index: dropping sessions re-reads every transcript once.
  const stale = db.prepare('PRAGMA user_version').get().user_version < 1;
  if (stale) db.exec('DROP TABLE IF EXISTS sessions');
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
    last_at TEXT,
    started_at TEXT,
    handoff_hash TEXT,
    handoff_goal TEXT
  )`);
  // Apart from sessions: syncFile replaces those rows, and this must survive a re-index.
  db.exec(`CREATE TABLE IF NOT EXISTS session_org (
    session_id TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL,
    space TEXT,
    tags TEXT NOT NULL
  )`);
  // Apart from session_org: the organizer never touches what the user set by hand.
  db.exec(`CREATE TABLE IF NOT EXISTS session_auto (
    session_id TEXT PRIMARY KEY,
    topic TEXT,
    title TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS session_handoffs (
    session_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    goal TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (session_id, hash)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS session_handoffs_hash ON session_handoffs (hash)');
  db.exec('CREATE INDEX IF NOT EXISTS session_handoffs_goal ON session_handoffs (goal)');
  // parent_id null means the user separated that session; session_links survives a re-index, like session_org.
  db.exec('CREATE TABLE IF NOT EXISTS session_links (session_id TEXT PRIMARY KEY, parent_id TEXT, origin TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_group (session_id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS group_workspace (name TEXT PRIMARY KEY COLLATE NOCASE, workspace TEXT NOT NULL, origin TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS workspace_parent (name TEXT PRIMARY KEY COLLATE NOCASE, parent TEXT NOT NULL)');
  if (stale) db.exec('PRAGMA user_version = 1');
  return db;
}

const firstText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.find((block) => block?.type === 'text')?.text ?? null : null);

function promptTitle(content) {
  const prompt = firstText(content);
  if (typeof prompt !== 'string') return null;
  const command = prompt.match(/<command-name>(.*?)<\/command-name>/)?.[1];
  const args = prompt.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '';
  const title = prompt.match(/^Goal:\s*(.+)$/m)?.[1] ?? (command ? `${command} ${args}` : prompt.replace(/<[^>]+>/g, ' '));
  return title.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

function applyRecord(row, record, emissions, handoffs) {
  if (record.isSidechain) return;
  if (record.type === 'custom-title') row.custom_title = text(record.customTitle);
  if (record.type === 'ai-title') row.ai_title = text(record.aiTitle);
  if (record.type === 'relocated') row.cwd = text(record.relocatedCwd) ?? row.cwd;
  row.cwd ??= text(record.cwd);
  row.entrypoint ??= text(record.entrypoint);
  if (record.type === 'user' && !record.isMeta && !record.toolUseResult) {
    row.turns += 1;
    if (row.first_prompt == null) {
      row.first_prompt = promptTitle(record.message?.content);
      const block = handoffBlock(firstText(record.message?.content));
      row.handoff_hash = block ? block.hash : null;
      row.handoff_goal = block ? block.goal : null;
    }
  }
  // Only real messages count: opening with --resume appends other records.
  if (record.type === 'user' || record.type === 'assistant') {
    row.last_at = text(record.timestamp) ?? row.last_at;
    row.started_at ??= text(record.timestamp);
  }
  if (record.type === 'assistant') {
    const content = record.message?.content;
    const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text) : [];
    for (const body of blocks) {
      const block = handoffBlock(body);
      if (block && typeof record.timestamp === 'string') emissions.push({ ...block, at: record.timestamp });
    }
    // Each content block is its own record; the reply's text comes last and carries end_turn.
    if (handoffs && record.message?.stop_reason === 'end_turn') {
      handoffs.push({ id: row.id, prompt: null });
      for (const body of blocks) {
        const prompt = nextBlock(body);
        if (prompt) handoffs.push({ id: row.id, prompt, tokens: contextTokens(record.message.usage) });
      }
    }
  }
}

function parseLine(row, line, emissions, handoffs) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record && typeof record === 'object') applyRecord(row, record, emissions, handoffs);
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

// handoffs only on live changes: a scan must not offer turns that ended while Deck was closed.
function syncFile(db, file, handoffs) {
  const id = sessionId(file);
  const { size } = fs.statSync(file);
  let row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (row?.size === size) return false;
  // frugal: a rewrite that does not shrink the file goes unnoticed; compare a hash of the bytes before offset if that shows up.
  if (!row || size < row.offset) {
    db.prepare('DELETE FROM session_handoffs WHERE session_id = ?').run(id);
    row = { id, file, size, offset: 0, cwd: null, entrypoint: null, custom_title: null, ai_title: null, first_prompt: null, turns: 0, last_at: null, started_at: null, handoff_hash: null, handoff_goal: null };
  }
  row = { ...row, size };
  const emissions = [];
  row.offset = readLines(file, row.offset, (line) => parseLine(row, line, emissions, handoffs));
  db.prepare(`INSERT OR REPLACE INTO sessions (id, file, size, offset, cwd, entrypoint, custom_title, ai_title, first_prompt, turns, last_at, started_at, handoff_hash, handoff_goal)
    VALUES (:id, :file, :size, :offset, :cwd, :entrypoint, :custom_title, :ai_title, :first_prompt, :turns, :last_at, :started_at, :handoff_hash, :handoff_goal)`).run(row);
  // In order with OR IGNORE: on a repeated hash the earliest emission stays.
  const save = db.prepare('INSERT OR IGNORE INTO session_handoffs (session_id, hash, goal, at) VALUES (?, ?, ?, ?)');
  for (const { hash, goal, at } of emissions) save.run(id, hash, goal, at);
  return true;
}

function removeSession(db, file) {
  db.prepare('DELETE FROM session_handoffs WHERE session_id = ?').run(sessionId(file));
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId(file));
}

// Junctions report as links, not directories, so a project shared between accounts is read from its real folder only.
function scan(db, roots, onBatch) {
  const seen = new Set();
  let changed = 0;
  db.exec('BEGIN');
  for (const root of [roots].flat().filter((folder) => fs.existsSync(folder))) {
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const entry of fs.readdirSync(path.join(root, project.name), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || seen.has(sessionId(entry.name))) continue;
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
  }
  for (const { id, file } of db.prepare('SELECT id, file FROM sessions').all()) {
    if (!seen.has(id)) removeSession(db, file);
  }
  db.exec('COMMIT');
}

function chatLinks(db) {
  const parents = new Map();
  const ambiguous = [];
  const emissions = db.prepare('SELECT session_id, hash, goal, at FROM session_handoffs WHERE hash = ? OR goal = ?');
  for (const { id, hash, goal, started_at: at } of db
    .prepare('SELECT id, handoff_hash AS hash, handoff_goal AS goal, started_at FROM sessions WHERE handoff_hash IS NOT NULL AND started_at IS NOT NULL')
    .iterate()) {
    const origin = pickOrigin({ id, hash, goal, at }, emissions.all(hash, goal));
    if (origin.parent) parents.set(id, origin.parent);
    else if (origin.candidates.length) ambiguous.push({ id, candidates: origin.candidates });
  }
  // The user overrules the model: a link decides, a null parent separates.
  for (const { session_id, parent_id } of db.prepare('SELECT session_id, parent_id FROM session_links').iterate()) {
    const found = ambiguous.findIndex((entry) => entry.id === session_id);
    if (found !== -1) ambiguous.splice(found, 1);
    if (parent_id === null) parents.delete(session_id);
    else parents.set(session_id, parent_id);
  }
  return { parents, ambiguous };
}

function listIndex(db) {
  const temp = path.join(os.tmpdir(), path.sep).toLowerCase();
  const usable = new Map();
  const isUsable = (cwd) => {
    if (!usable.has(cwd)) usable.set(cwd, !path.join(cwd, path.sep).toLowerCase().startsWith(temp) && fs.existsSync(cwd));
    return usable.get(cwd);
  };
  const sessions = [];
  // -p runs (sdk-cli) and sandboxes in Temp would bury the real chats; a missing cwd cannot be resumed.
  const rows = db.prepare(`SELECT id, file, cwd, COALESCE(NULLIF(custom_title, ''), NULLIF(a.title, ''), NULLIF(ai_title, ''), first_prompt, 'Untitled') AS title, last_at AS lastAt, started_at AS startedAt, turns, COALESCE(pinned, 0) AS pinned, space, COALESCE(tags, '[]') AS tags,
      CASE WHEN g.name = '' THEN NULL ELSE COALESCE(g.name, a.topic) END AS topic, NULLIF(g.name, '') AS userGroup, COALESCE(g.name = '', 0) AS noGroup, a.title AS autoTitle, NULLIF(custom_title, '') AS customTitle, NULLIF(ai_title, '') AS aiTitle, first_prompt AS firstPrompt
    FROM sessions LEFT JOIN session_org o ON o.session_id = id LEFT JOIN session_auto a ON a.session_id = id LEFT JOIN session_group g ON g.session_id = id
    WHERE turns > 0 AND cwd IS NOT NULL AND last_at IS NOT NULL AND COALESCE(entrypoint, '') <> 'sdk-cli'
    ORDER BY last_at DESC`);
  for (const row of rows.iterate()) {
    if (!isUsable(row.cwd)) continue;
    sessions.push({ ...row, pinned: row.pinned === 1, noGroup: row.noGroup === 1, tags: JSON.parse(row.tags) });
  }
  const listed = new Map(sessions.map((session) => [session.id, { id: session.id, title: session.title, cwd: session.cwd, lastAt: session.lastAt }]));
  const { parents, ambiguous } = chatLinks(db);
  const unresolved = [];
  for (const { id, candidates } of ambiguous) {
    if (!listed.has(id)) continue;
    const kept = candidates.filter((candidate) => listed.has(candidate));
    if (!kept.length) continue;
    if (kept.length === 1) parents.set(id, kept[0]);
    else unresolved.push({ id, ...listed.get(id), candidates: kept.map((candidate) => listed.get(candidate)) });
  }
  for (const session of sessions) {
    const parent = parents.get(session.id);
    session.parentId = parent != null && listed.has(parent) ? parent : null;
    // chatId is the root of the chat; a cycle or an unlisted parent stops the walk.
    const seen = new Set([session.id]);
    let at = session.id;
    for (let next; (next = parents.get(at)) != null && listed.has(next) && !seen.has(next); at = next) seen.add(next);
    session.chatId = at;
  }
  return {
    workspaces: Object.fromEntries(db.prepare('SELECT name, workspace FROM group_workspace').all().map(({ name, workspace }) => [name, workspace])),
    workspaceParents: Object.fromEntries(db.prepare('SELECT name, parent FROM workspace_parent').all().map(({ name, parent }) => [name, parent])),
    modelWorkspaces: db.prepare("SELECT COUNT(*) AS n FROM group_workspace WHERE origin = 'model'").get().n,
    sessions, ambiguous: unresolved, modelJoins: db.prepare(`SELECT COUNT(*) AS n FROM session_links WHERE origin = 'model'`).get().n };
}

const listSessions = (db) => listIndex(db).sessions;

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

function saveAutomatic(db, rows) {
  const save = db.prepare(`INSERT INTO session_auto (session_id, topic, title) VALUES (?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET topic = excluded.topic, title = COALESCE(excluded.title, title)`);
  db.exec('BEGIN');
  for (const { id, topic, title } of rows) save.run(id, topic, title);
  db.exec('COMMIT');
}

function clearAutoTitles(db) {
  db.exec('UPDATE session_auto SET title = NULL');
}

// Only the last user link can be undone; model links come in batches and are cleared as a batch.
let lastLink = null;

function reaches(db, id, from) {
  const { parents } = chatLinks(db);
  const seen = new Set();
  for (let at = from; at != null; at = parents.get(at) ?? null) {
    if (at === id) return true;
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return false;
}

function saveLink(db, id, parentId, origin) {
  if (typeof id !== 'string' || !(parentId === null || typeof parentId === 'string')) return false;
  if (parentId !== null && (parentId === id || !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(parentId))) return false;
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) || reaches(db, id, parentId)) return false;
  const previous = db.prepare('SELECT parent_id, origin FROM session_links WHERE session_id = ?').get(id) ?? null;
  db.prepare('INSERT OR REPLACE INTO session_links (session_id, parent_id, origin) VALUES (?, ?, ?)').run(id, parentId, origin);
  if (origin === 'user') lastLink = { id, previous };
  return true;
}

function undoLastLink(db) {
  if (!lastLink) return false;
  const { id, previous } = lastLink;
  lastLink = null;
  if (previous) db.prepare('INSERT OR REPLACE INTO session_links (session_id, parent_id, origin) VALUES (?, ?, ?)').run(id, previous.parent_id, previous.origin);
  else db.prepare('DELETE FROM session_links WHERE session_id = ?').run(id);
  return true;
}

function clearModelLinks(db) {
  db.prepare(`DELETE FROM session_links WHERE origin = 'model'`).run();
}

function saveGroup(db, id, name) {
  if (typeof id !== 'string' || !UUID.test(id) || !(name === null || typeof name === 'string')) return false;
  const clean = name?.trim() ?? '';
  if (clean.length > 40) return false;
  db.prepare('INSERT OR REPLACE INTO session_group (session_id, name) VALUES (?, ?)').run(id, clean);
  return true;
}

function validIds(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === 'string' && UUID.test(id));
}

function renameWorkspace(db, from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return false;
  from = from.trim();
  to = to.trim();
  if (!from || !to || from.length > 40 || to.length > 40) return false;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE group_workspace SET workspace = ?, origin = 'user' WHERE workspace = ? COLLATE NOCASE").run(to, from);
    db.prepare('UPDATE session_org SET space = ? WHERE space = ? COLLATE NOCASE').run(to, from);
    db.prepare('UPDATE OR REPLACE workspace_parent SET name = ? WHERE name = ? COLLATE NOCASE').run(to, from);
    db.prepare('UPDATE workspace_parent SET parent = ? WHERE parent = ? COLLATE NOCASE').run(to, from);
    db.prepare('DELETE FROM workspace_parent WHERE name = parent COLLATE NOCASE').run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function deleteWorkspace(db, name) {
  if (typeof name !== 'string') return false;
  name = name.trim();
  if (!name || name.length > 40) return false;
  db.exec('BEGIN');
  try {
    const up = db.prepare('SELECT parent FROM workspace_parent WHERE name = ?').get(name)?.parent;
    if (up) db.prepare('UPDATE workspace_parent SET parent = ? WHERE parent = ? COLLATE NOCASE').run(up, name);
    else db.prepare('DELETE FROM workspace_parent WHERE parent = ? COLLATE NOCASE').run(name);
    db.prepare('DELETE FROM workspace_parent WHERE name = ?').run(name);
    db.prepare('DELETE FROM group_workspace WHERE workspace = ? COLLATE NOCASE').run(name);
    db.prepare('UPDATE session_org SET space = NULL WHERE space = ? COLLATE NOCASE').run(name);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function saveWorkspaceParent(db, name, parent) {
  if (typeof name !== 'string' || typeof parent !== 'string') return false;
  name = name.trim();
  parent = parent.trim();
  if (!name || name.length > 40 || parent.length > 40) return false;
  if (!parent) {
    db.prepare('DELETE FROM workspace_parent WHERE name = ?').run(name);
    return true;
  }
  const find = db.prepare('SELECT parent FROM workspace_parent WHERE name = ?');
  const seen = new Set();
  for (let at = parent; at && !seen.has(at.toLowerCase()); at = find.get(at)?.parent) {
    if (at.toLowerCase() === name.toLowerCase()) return false;
    seen.add(at.toLowerCase());
  }
  db.prepare('INSERT OR REPLACE INTO workspace_parent (name, parent) VALUES (?, ?)').run(name, parent);
  return true;
}

function renameGroup(db, ids, from, to) {
  if (!validIds(ids) || typeof from !== 'string' || typeof to !== 'string') return false;
  from = from.trim();
  to = to.trim();
  if (!from || from.length > 500 || !to || to.length > 40) return false;
  const upsert = db.prepare('INSERT OR REPLACE INTO session_group (session_id, name) VALUES (?, ?)');
  const move = db.prepare('UPDATE OR IGNORE group_workspace SET name = ? WHERE name = ?');
  const drop = db.prepare('DELETE FROM group_workspace WHERE name = ?');
  db.exec('BEGIN');
  try {
    for (const id of ids) upsert.run(id, to);
    if (!move.run(to, from).changes) drop.run(from);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function deleteGroup(db, ids, group) {
  if (!validIds(ids) || typeof group !== 'string') return false;
  group = group.trim();
  if (!group || group.length > 500) return false;
  const upsert = db.prepare("INSERT OR REPLACE INTO session_group (session_id, name) VALUES (?, '')");
  const place = db.prepare(`INSERT INTO session_org (session_id, pinned, space, tags) VALUES (?, 0, ?, '[]')
    ON CONFLICT(session_id) DO UPDATE SET space = excluded.space WHERE session_org.space IS NULL OR session_org.space = ''`);
  db.exec('BEGIN');
  try {
    const workspace = db.prepare('SELECT workspace FROM group_workspace WHERE name = ?').get(group)?.workspace;
    for (const id of ids) upsert.run(id);
    if (workspace) for (const id of ids) place.run(id, workspace);
    db.prepare('DELETE FROM group_workspace WHERE name = ?').run(group);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

function saveWorkspace(db, group, workspace) {
  if (typeof group !== 'string' || typeof workspace !== 'string') return false;
  group = group.trim();
  workspace = workspace.trim();
  if (!group || group.length > 500 || workspace.length > 40) return false;
  if (!workspace) db.prepare('DELETE FROM group_workspace WHERE name = ?').run(group);
  else db.prepare("INSERT OR REPLACE INTO group_workspace (name, workspace, origin) VALUES (?, ?, 'user')").run(group, workspace);
  return true;
}

function saveModelWorkspaces(db, rows) {
  const save = db.prepare(`INSERT INTO group_workspace (name, workspace, origin) VALUES (?, ?, 'model')
    ON CONFLICT(name) DO UPDATE SET workspace = excluded.workspace WHERE origin = 'model'`);
  db.exec('BEGIN');
  try {
    for (const { group, workspace } of rows) {
      if (typeof group !== 'string' || typeof workspace !== 'string' || !group.trim() || group.trim().length > 500 || !workspace.trim() || workspace.trim().length > 40) continue;
      save.run(group.trim(), workspace.trim());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function clearModelWorkspaces(db) {
  db.prepare("DELETE FROM group_workspace WHERE origin = 'model'").run();
}

function runWorker({ roots, dbFile }) {
  const db = openIndex(dbFile);
  const publish = (indexing) => parentPort.postMessage({ indexing, ...listIndex(db) });
  publish(true);
  scan(db, roots, () => publish(true));
  publish(false);

  parentPort.on('message', ({ id, organization, automatic, clearTitles, link, undoLink, joins, clearJoins, setGroup, setWorkspace, setWorkspaceParent, modelWorkspaces, clearWorkspaces, renameWorkspace: spaceRename, deleteWorkspace: spaceDelete, renameGroup: groupRename, deleteGroup: groupDelete }) => {
    if (setGroup) {
      if (!saveGroup(db, setGroup.id, setGroup.name)) return;
    } else if (setWorkspace) {
      if (!saveWorkspace(db, setWorkspace.group, setWorkspace.workspace)) return;
    } else if (setWorkspaceParent) {
      if (!saveWorkspaceParent(db, setWorkspaceParent.name, setWorkspaceParent.parent)) return;
    } else if (spaceRename) {
      if (!renameWorkspace(db, spaceRename.from, spaceRename.to)) return;
    } else if (spaceDelete) {
      if (!deleteWorkspace(db, spaceDelete.name)) return;
    } else if (groupRename) {
      if (!renameGroup(db, groupRename.ids, groupRename.from, groupRename.to)) return;
    } else if (groupDelete) {
      if (!deleteGroup(db, groupDelete.ids, groupDelete.group)) return;
    } else if (modelWorkspaces) saveModelWorkspaces(db, modelWorkspaces);
    else if (clearWorkspaces === true) clearModelWorkspaces(db);
    else if (link) {
      if (!saveLink(db, link.id, link.parentId ?? null, 'user')) return;
    } else if (undoLink) undoLastLink(db);
    else if (clearJoins) clearModelLinks(db);
    else if (joins) {
      let ok = true;
      db.exec('BEGIN');
      for (const { id: joinId, parentId } of joins) ok = saveLink(db, joinId, parentId ?? null, 'model') && ok;
      db.exec('COMMIT');
      if (!ok) return;
    } else if (automatic) saveAutomatic(db, automatic);
    else if (clearTitles) clearAutoTitles(db);
    else if (!saveOrganization(db, id, organization)) return;
    publish(false);
  });
  const changed = new Set();
  let timer = null;
  const flush = () => {
    timer = null;
    const handoffs = [];
    for (const file of changed) {
      try {
        syncFile(db, file, handoffs);
      } catch (error) {
        if (error.code === 'ENOENT') removeSession(db, file);
      }
    }
    changed.clear();
    publish(false);
    if (handoffs.length) parentPort.postMessage({ handoffs });
  };
  for (const root of roots.filter((folder) => fs.existsSync(folder))) {
    fs.watch(root, { recursive: true }, (_, name) => {
      // Subagent transcripts live one level deeper and are not sessions.
      if (!name?.endsWith('.jsonl') || name.split(path.sep).length !== 2) return;
      changed.add(path.join(root, name));
      timer ??= setTimeout(flush, 1000);
    });
  }
}

module.exports = { saveGroup, saveWorkspace, saveWorkspaceParent, saveModelWorkspaces, clearModelWorkspaces, openIndex, syncFile, scan, listSessions, listIndex, chatLinks, promptTitle, saveOrganization, saveAutomatic, clearAutoTitles, saveLink, undoLastLink, clearModelLinks, renameWorkspace, deleteWorkspace, renameGroup, deleteGroup };

if (parentPort) runWorker(workerData);
