const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const pty = require('node-pty');
const { createStatusBridge, readUserStatusLine } = require('./statusline');
const { validOptions, estimate, organize, estimateJoins, resolveJoins, estimateWorkspaces, resolveWorkspaces } = require('./organizer');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DROPPED_ENV = /^(CLAUDE.*|ELECTRON_RUN_AS_NODE|NO_COLOR)$/i;

const chats = new Map();
const pickedFolders = new Set();
let index = { indexing: true, sessions: [], error: null, ambiguous: [], modelJoins: 0, workspaces: {}, modelWorkspaces: 0 };
let win;
let indexer;
// frugal: the sidebar shows the newest sessions plus every organized one and every open chat, and never cuts a chat in half; the palette and resume use all of them.
const SIDEBAR_LIMIT = 500;
const sidebarIndex = () => {
  const kept = index.sessions.filter((s, i) => i < SIDEBAR_LIMIT || s.pinned || s.space || s.tags.length || chats.has(s.id));
  const chatIds = new Set(kept.map((s) => s.chatId));
  return { ...index, sessions: index.sessions.filter((s) => chatIds.has(s.chatId)) };
};

// frugal: only PATH and the npm layout are verified; other installs are pending (Test 5).
function findClaude() {
  let found;
  try {
    found = execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
  for (const entry of found) {
    if (entry.toLowerCase().endsWith('.exe')) return entry;
    const packaged = path.join(path.dirname(entry), 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    if (fs.existsSync(packaged)) return packaged;
  }
  return null;
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENV.test(key)));
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

const statusBridge = createStatusBridge((id, meters) => send('chat:meters', id, meters));

const isSize = (n) => Number.isInteger(n) && n > 0 && n <= 1000;

ipcMain.handle('folder:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (canceled) return null;
  pickedFolders.add(filePaths[0]);
  return filePaths[0];
});

// Outside the install folder: Program Files needs admin rights and an update or uninstall could remove it.
const SESSIONS_FOLDER = path.join(os.homedir(), 'Frugal Deck', 'Sessions');

ipcMain.handle('folder:default', () => {
  fs.mkdirSync(SESSIONS_FOLDER, { recursive: true });
  pickedFolders.add(SESSIONS_FOLDER);
  return SESSIONS_FOLDER;
});

ipcMain.handle('sessions:get', sidebarIndex);
ipcMain.handle('sessions:all', () => index.sessions);
ipcMain.on('sessions:organize', (_, id, organization) => indexer?.postMessage({ id, organization }));

ipcMain.handle('chat:start', (_, { id, cwd, cols, rows, resume, group }) => {
  // A resumed chat always runs in the folder the index recorded, never one sent by the renderer.
  const folder = resume ? index.sessions.find((session) => session.id === id)?.cwd : (pickedFolders.has(cwd) || index.sessions.some((s) => s.cwd === cwd)) && cwd;
  if (!UUID.test(id) || chats.has(id) || !folder || !isSize(cols) || !isSize(rows)) {
    return { error: 'Invalid request.' };
  }
  const claude = findClaude();
  if (!claude) return { error: 'claude.exe not found in PATH. Install Claude Code and reopen Deck.' };
  const env = cleanEnv();
  const status = statusBridge.register({ id, cwd: folder, env, statusLine: readUserStatusLine(path.join(os.homedir(), '.claude/settings.json')) });
  try {
    const args = [resume ? '--resume' : '--session-id', id, '--settings', JSON.stringify({ statusLine: status.statusLine })];
    const child = pty.spawn(claude, args, { name: 'xterm-256color', cols, rows, cwd: folder, env });
    chats.set(id, child);
    if (typeof group === 'string' && group) indexer?.postMessage({ setGroup: { id, name: group } });
    child.onData((data) => send('chat:data', id, data));
    child.onExit(({ exitCode }) => {
      chats.delete(id);
      statusBridge.release(status.token);
      send('chat:exit', id, exitCode);
    });
    send('sessions:changed', sidebarIndex());
    return { ok: true };
  } catch (error) {
    statusBridge.release(status.token);
    return { error: `Failed to start Claude: ${error.message}` };
  }
});

ipcMain.on('chat:input', (_, id, data) => chats.get(id)?.write(data));
ipcMain.on('chat:resize', (_, id, cols, rows) => {
  if (isSize(cols) && isSize(rows)) chats.get(id)?.resize(cols, rows);
});
ipcMain.on('chat:kill', (_, id) => chats.get(id)?.kill());

let topicRun = null;

ipcMain.handle('topics:estimate', (_, options) => (validOptions(options) ? estimate(index.sessions, options) : { sessions: 0, tokens: 0 }));

async function exclusiveRun(options, work) {
  if (topicRun || !validOptions(options)) return { error: 'Invalid request.' };
  const claude = findClaude();
  if (!claude) return { error: 'claude.exe not found in PATH. Install Claude Code and reopen Deck.' };
  const run = topicRun = { child: null, stopped: false };
  try {
    await work(claude, run);
    return run.stopped ? { stopped: true } : { ok: true };
  } catch (error) {
    return run.stopped ? { stopped: true } : { error: error.message };
  } finally {
    topicRun = null;
  }
}

ipcMain.handle('topics:run', (_, options) => exclusiveRun(options, (claude, run) => organize({
  claude,
  env: cleanEnv(),
  sessions: index.sessions,
  options,
  run,
  onBatch: (rows, done, total) => {
    indexer?.postMessage({ automatic: rows });
    send('topics:progress', done, total);
  },
})));

ipcMain.on('sessions:set-group', (_, id, name) => indexer?.postMessage({ setGroup: { id, name } }));
ipcMain.on('sessions:set-workspace', (_, group, workspace) => indexer?.postMessage({ setWorkspace: { group, workspace } }));
ipcMain.on('workspaces:rename', (_, from, to) => indexer?.postMessage({ renameWorkspace: { from, to } }));
ipcMain.on('workspaces:delete', (_, name) => indexer?.postMessage({ deleteWorkspace: { name } }));
ipcMain.on('groups:rename', (_, ids, from, to) => indexer?.postMessage({ renameGroup: { ids, from, to } }));
ipcMain.on('groups:delete', (_, ids, group) => indexer?.postMessage({ deleteGroup: { ids, group } }));
ipcMain.on('workspaces:clear', () => indexer?.postMessage({ clearWorkspaces: true }));
ipcMain.handle('workspaces:estimate', () => estimateWorkspaces(index.sessions));
ipcMain.handle('workspaces:run', (_, options) => exclusiveRun(options, async (claude, run) => indexer?.postMessage({ modelWorkspaces: await resolveWorkspaces({ claude, env: cleanEnv(), sessions: index.sessions, options, run }) })));

ipcMain.handle('joins:estimate', () => estimateJoins(index.ambiguous));
ipcMain.handle('joins:run', (_, options) => exclusiveRun(options, async (claude, run) => indexer?.postMessage({ joins: await resolveJoins({ claude, env: cleanEnv(), ambiguous: index.ambiguous, options, run }) })));
ipcMain.on('sessions:link', (_, id, parentId) => indexer?.postMessage({ link: { id, parentId } }));
ipcMain.on('sessions:undo-link', () => indexer?.postMessage({ undoLink: true }));
ipcMain.on('joins:clear', () => indexer?.postMessage({ clearJoins: true }));

function stopTopics() {
  if (!topicRun) return;
  topicRun.stopped = true;
  topicRun.child?.kill();
}

ipcMain.on('topics:restore-titles', () => indexer?.postMessage({ clearTitles: true }));

const windowActions = new Map([
  ['minimize', () => win.minimize()],
  ['maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize())],
  ['close', () => win.close()],
]);
ipcMain.on('window:action', (_, action) => windowActions.get(action)?.());

function createWindow() {
  // The default menu would take Ctrl+R and Ctrl+W away from the TUI.
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    backgroundColor: '#14171b',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('maximize', () => send('window:maximized', true));
  win.on('unmaximize', () => send('window:maximized', false));
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// app.quit() hung for 80 s with a dialog open in the TUI (Test 1); app.exit does not.
app.on('window-all-closed', () => {
  for (const child of chats.values()) child.kill();
  stopTopics();
  setTimeout(() => app.exit(0), 1000);
});

function publishIndex(next) {
  index = { ...index, error: null, ...next };
  send('sessions:changed', sidebarIndex());
}

// claude.exe runs without CLAUDE_CONFIG_DIR (cleanEnv), so its transcripts are always under ~/.claude.
function startIndexer() {
  const worker = indexer = new Worker(path.join(__dirname, 'indexer.js'), {
    workerData: {
      root: path.join(os.homedir(), '.claude', 'projects'),
      dbFile: path.join(os.homedir(), '.frugal-deck', 'deck.db'),
    },
  });
  worker.on('message', publishIndex);
  worker.on('error', (error) => publishIndex({ indexing: false, error: error.message }));
}

app.whenReady().then(() => {
  createWindow();
  startIndexer();
});
