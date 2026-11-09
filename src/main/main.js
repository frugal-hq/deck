const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { Worker } = require('worker_threads');
const pty = require('node-pty');
const { createStatusBridge, readUserStatusLine } = require('./statusline');
const { validOptions, estimate, organize, estimateJoins, resolveJoins, estimateWorkspaces, resolveWorkspaces } = require('./organizer');
const accounts = require('./accounts');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DROPPED_ENV = /^(CLAUDE.*|ELECTRON_RUN_AS_NODE|NO_COLOR)$/i;
const NO_CLAUDE = 'claude.exe not found in PATH. Install Claude Code and reopen Deck.';
// The TUI animates while it works, so a quiet terminal means Claude is idle.
const IDLE_MS = 2000;

const chats = new Map();
const chatInfo = new Map();
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

const publishAccounts = () => send('accounts:changed', accounts.snapshot());

const statusBridge = createStatusBridge((id, meters) => {
  const info = chatInfo.get(id);
  if (info && accounts.saveReading(info.account, meters)) publishAccounts();
  send('chat:meters', id, meters);
});

// FRUGAL_ROLES is read by frugal's accounts server, so the setting applies to chats started after it changes.
const accountEnv = (account) => ({ ...cleanEnv(), FRUGAL_ROLES: accounts.roles() ? 'on' : 'off', ...(account.id === accounts.MAIN ? {} : { CLAUDE_CONFIG_DIR: account.configDir }) });

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

function launchChat({ id, folder, cols, rows, resume, group, account, file, prompt }) {
  const claude = findClaude();
  if (!claude) return { error: NO_CLAUDE };
  const env = accountEnv(account);
  const status = statusBridge.register({ id, cwd: folder, env, statusLine: readUserStatusLine(path.join(account.configDir, 'settings.json')) });
  try {
    if (account.id !== accounts.MAIN) accounts.ensureOnboarded(account.configDir);
    if (resume) accounts.shareTranscript(file, account.configDir);
    const args = [resume ? '--resume' : '--session-id', id, '--settings', JSON.stringify({ statusLine: status.statusLine })];
    if (prompt) args.push(prompt);
    const child = pty.spawn(claude, args, { name: 'xterm-256color', cols, rows, cwd: folder, env });
    chats.set(id, child);
    chatInfo.set(id, { account: account.id, folder, lastOutput: Date.now() });
    if (typeof group === 'string' && group) indexer?.postMessage({ setGroup: { id, name: group } });
    child.onData((data) => {
      if (chats.get(id) !== child) return;
      chatInfo.get(id).lastOutput = Date.now();
      send('chat:data', id, data);
    });
    child.onExit(({ exitCode }) => {
      statusBridge.release(status.token);
      // An account switch removes the chat first, so the restart never reads as an exit.
      if (chats.get(id) !== child) return;
      chats.delete(id);
      chatInfo.delete(id);
      send('chat:exit', id, exitCode);
    });
    send('sessions:changed', sidebarIndex());
    return { ok: true, account: account.id };
  } catch (error) {
    statusBridge.release(status.token);
    return { error: `Failed to start Claude: ${error.message}` };
  }
}

ipcMain.handle('chat:start', (_, { id, cwd, cols, rows, resume, group }) => {
  const session = resume ? index.sessions.find((s) => s.id === id) : null;
  // A resumed chat always runs in the folder the index recorded, never one sent by the renderer.
  const folder = resume ? session?.cwd : (pickedFolders.has(cwd) || index.sessions.some((s) => s.cwd === cwd)) && cwd;
  if (!UUID.test(id) || chats.has(id) || !folder || !isSize(cols) || !isSize(rows)) {
    return { error: 'Invalid request.' };
  }
  return launchChat({ id, folder, cols, rows, resume, group, account: accounts.primary(), file: session?.file });
});

// A handoff continues in the folder its chat runs in, or the one the index recorded once it exits, on the account it ran on.
// frugal: no permission flags exist yet, so "same permissions" holds; pass them here when Phase 4 adds them.
ipcMain.handle('chat:continue', (_, { id, from, accountId, prompt, cols, rows }) => {
  const folder = chatInfo.get(from)?.folder ?? index.sessions.find((s) => s.id === from)?.cwd;
  const account = accounts.claudeAccounts().find((candidate) => candidate.id === accountId);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  // A leading dash would be read as a flag of claude.exe.
  if (!UUID.test(id) || chats.has(id) || !folder || !account || !text || text.startsWith('-') || !isSize(cols) || !isSize(rows)) {
    return { error: 'Invalid request.' };
  }
  return launchChat({ id, folder, cols, rows, account, prompt: text });
});

// Every live end_turn comes as an entry without a prompt; a handoff block adds one with it.
function offerHandoffs(handoffs) {
  for (const { id, prompt, tokens } of handoffs) {
    if (!chats.has(id)) continue;
    if (prompt) send('chat:handoff', id, { prompt, tokens });
    else send('chat:turn-end', id);
  }
}

ipcMain.handle('chat:switch-account', async (_, { id, accountId, cols, rows }) => {
  const child = chats.get(id);
  const info = chatInfo.get(id);
  const account = accounts.claudeAccounts().find((candidate) => candidate.id === accountId);
  if (!child || !info || !account || !isSize(cols) || !isSize(rows)) return { error: 'Invalid request.' };
  const session = index.sessions.find((s) => s.id === id);
  // Refused before the primary changes, so a chat that stays put never disagrees with the panel.
  if (session && info.account !== account.id && Date.now() - info.lastOutput < IDLE_MS) return { error: 'Claude is working. Switch accounts when it is idle.' };
  accounts.setPrimary(account.id);
  publishAccounts();
  if (info.account === account.id) return { ok: true, account: account.id };
  if (!session) return { error: 'Send a first message before switching this chat. New chats will use this account.' };
  const exited = new Promise((resolve) => child.onExit(resolve));
  chats.delete(id);
  chatInfo.delete(id);
  child.kill();
  await exited;
  send('chat:restarting', id);
  const started = launchChat({ id, folder: session.cwd, cols, rows, resume: true, account, file: session.file });
  return started.error ? { ...started, stopped: true } : started;
});

ipcMain.handle('accounts:get', () => accounts.snapshot());
ipcMain.handle('settings:roles', () => accounts.roles());
ipcMain.on('settings:set-roles', (_, on) => {
  if (typeof on === 'boolean') accounts.setRoles(on);
});

ipcMain.handle('accounts:rename', (_, { id, name }) => {
  if (accounts.renameAccount(id, name)) publishAccounts();
});

const findAccount = (id) => accounts.claudeAccounts().find((account) => account.id === id);
const isOpen = (accountId) => [...chatInfo.values()].some((info) => info.account === accountId);
const IN_USE = 'Close the chats on this account first, then open Accounts in the top bar.';

// accountId signs a known account in again; without it a new account is made from name.
ipcMain.handle('accounts:login', (_, { id, name, accountId, cols, rows }) => {
  if (!UUID.test(id) || chats.has(id) || !isSize(cols) || !isSize(rows)) return { error: 'Invalid request.' };
  const claude = findClaude();
  if (!claude) return { error: NO_CLAUDE };
  try {
    const existing = accountId === undefined ? null : findAccount(accountId);
    if (accountId !== undefined && !existing) return { error: 'Invalid request.' };
    const account = existing ?? accounts.prepareAccount(name);
    const child = pty.spawn(claude, ['auth', 'login'], { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: accountEnv(account) });
    chats.set(id, child);
    child.onData((data) => send('chat:data', id, data));
    child.onExit(({ exitCode }) => {
      chats.delete(id);
      if (existing) {
        accounts.clearEmails();
        publishAccounts();
      } else if (exitCode === 0 && accounts.finishAccount(account)) {
        publishAccounts();
        startIndexer();
      }
      send('chat:exit', id, exitCode);
    });
    return { ok: true };
  } catch (error) {
    return { error: error.message };
  }
});

const logout = (claude, account) => promisify(execFile)(claude, ['auth', 'logout'], { env: accountEnv(account), cwd: os.homedir(), timeout: 30000, windowsHide: true });

ipcMain.handle('accounts:logout', async (_, { id }) => {
  const account = findAccount(id);
  const claude = findClaude();
  if (!account) return { error: 'Invalid request.' };
  if (!claude) return { error: NO_CLAUDE };
  if (isOpen(id)) return { error: IN_USE };
  try {
    await logout(claude, account);
    return { ok: true };
  } catch (error) {
    return { error: `Sign out failed: ${error.message}` };
  } finally {
    accounts.clearEmails();
    publishAccounts();
  }
});

let refreshing = null;

// A usage reading still running on this account would write sessions/ and projects/ back after the delete, so it is awaited first.
// The sign-in goes with the folder, so no claude auth logout is needed.
ipcMain.handle('accounts:remove', async (_, { id }) => {
  const account = findAccount(id);
  if (!account || account.id === accounts.MAIN) return { error: 'Invalid request.' };
  if (isOpen(id)) return { error: IN_USE };
  await refreshing?.catch(() => {});
  try {
    if (!accounts.removeAccount(id)) return { error: 'Invalid request.' };
    return { ok: true };
  } catch (error) {
    return { error: `Delete failed: ${error.message}` };
  } finally {
    publishAccounts();
    startIndexer();
  }
});

ipcMain.handle('accounts:refresh', async () => {
  const claude = findClaude();
  if (refreshing || !claude) return;
  refreshing = accounts.refreshReadings(claude, cleanEnv(), new Set([...chatInfo.values()].map((info) => info.account)));
  try {
    if (await refreshing) publishAccounts();
  } finally {
    refreshing = null;
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
  if (!claude) return { error: NO_CLAUDE };
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

// The main account comes first: a session visible from several accounts is indexed once, from the first root.
function startIndexer() {
  indexer?.terminate();
  const worker = indexer = new Worker(path.join(__dirname, 'indexer.js'), {
    workerData: {
      roots: accounts.claudeAccounts().map((account) => path.join(account.configDir, 'projects')),
      dbFile: path.join(os.homedir(), '.frugal-deck', 'deck.db'),
    },
  });
  worker.on('message', (message) => (message.handoffs ? offerHandoffs(message.handoffs) : publishIndex(message)));
  worker.on('error', (error) => publishIndex({ indexing: false, error: error.message }));
}

app.whenReady().then(() => {
  createWindow();
  startIndexer();
});
