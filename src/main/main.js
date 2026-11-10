const elevated = require('./elevated');

// An administrator chat starts a UAC-elevated copy of the Deck with this flag, and that copy only hosts the PTY.
if (process.argv.includes(elevated.HELPER_FLAG)) return elevated.runHelper(process.argv);

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
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
const { createVoice } = require('./voice');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DROPPED_ENV = /^(CLAUDE.*|ELECTRON_RUN_AS_NODE|NO_COLOR|npm_.*|INIT_CWD)$/i;
const NO_CLAUDE = 'claude.exe not found in PATH. Install Claude Code and reopen Deck.';
// The TUI animates while it works, so a quiet terminal means Claude is idle.
const IDLE_MS = 2000;

const chats = new Map();
const chatInfo = new Map();
// Administrator chats wait on the UAC prompt; closing one there must not leave it running unseen.
const launching = new Map();
const pickedFolders = new Set();
let index = { indexing: true, sessions: [], error: null, ambiguous: [], modelJoins: 0, workspaces: {}, modelWorkspaces: 0 };
let win;
let indexer;
// Written to userData at startup: the .cmd runs the script with Deck's own binary as plain Node.
let editorCommand;
// frugal: one edit per chat is kept, so a second Ctrl+G replaces the waiting response.
const pendingEdits = new Map();

function endEdit(id, text) {
  const edit = pendingEdits.get(id);
  if (!edit) return;
  pendingEdits.delete(id);
  if (typeof text === 'string') fs.writeFileSync(edit.file, text, 'utf8');
  edit.res.end();
}

const dropEdits = () => {
  for (const edit of pendingEdits.values()) edit.res.end();
  pendingEdits.clear();
};
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

const publishAccounts = () => {
  accounts.applyCodexCaps();
  send('accounts:changed', accounts.snapshot());
};

const statusBridge = createStatusBridge((id, meters) => {
  const info = chatInfo.get(id);
  if (info && accounts.saveReading(info.account, meters)) publishAccounts();
  send('chat:meters', id, meters);
}, (id, file, res) => {
  // The body is the temp file Claude Code wants edited by $VISUAL.
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    res.writeHead(400).end();
    return;
  }
  endEdit(id);
  pendingEdits.set(id, { file, res });
  if (!win || win.isDestroyed()) endEdit(id);
  else send('chat:edit', id, text);
});

// FRUGAL_ROLES is read by frugal's accounts server, so the setting applies to chats started after it changes.
const accountEnv = (account) => ({ ...cleanEnv(), FRUGAL_ROLES: accounts.roles() ? 'on' : 'off', ...(account.id === accounts.MAIN ? {} : { CLAUDE_CONFIG_DIR: account.configDir }) });

const isSize = (n) => Number.isInteger(n) && n > 0 && n <= 1000;

ipcMain.handle('files:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return canceled ? [] : filePaths;
});

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

// Dev runs Electron with the app folder; a packaged build is the app itself.
const helperCommand = () => ({ exe: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });

async function launchChat({ id, folder, cols, rows, resume, group, account, file, prompt, bypass, admin }) {
  const claude = findClaude();
  if (!claude) return { error: NO_CLAUDE };
  const env = accountEnv(account);
  const status = statusBridge.register({ id, cwd: folder, env, statusLine: readUserStatusLine(path.join(account.configDir, 'settings.json')) });
  // Claude Code runs $VISUAL with the prompt file path appended and waits for it to exit.
  // Quoted: Claude Code runs it through the shell, and the user folder may contain spaces.
  env.VISUAL = `"${editorCommand}"`;
  env.DECK_EDIT_URL = status.editUrl;
  try {
    if (account.id !== accounts.MAIN) accounts.ensureOnboarded(account.configDir);
    if (resume) accounts.shareTranscript(file, account.configDir);
    // The Deck's own warning took the consent, so Claude Code's disclaimer is skipped (it reads this key from flag settings too).
    const settings = { statusLine: status.statusLine, ...(bypass === true && { skipDangerousModePermissionPrompt: true }) };
    const args = [resume ? '--resume' : '--session-id', id, '--settings', JSON.stringify(settings)];
    if (prompt) args.push(prompt);
    if (bypass === true) args.push('--dangerously-skip-permissions');
    let child;
    if (admin === true) {
      const launch = { cancelled: false };
      launching.set(id, launch);
      try {
        child = await elevated.spawnElevated(claude, args, { cols, rows, cwd: folder, env }, helperCommand());
      } finally {
        launching.delete(id);
      }
      if (launch.cancelled) {
        child.kill();
        statusBridge.release(status.token);
        return { error: 'The chat was closed before it started.' };
      }
    } else {
      child = pty.spawn(claude, args, { name: 'xterm-256color', cols, rows, cwd: folder, env });
    }
    chats.set(id, child);
    chatInfo.set(id, { account: account.id, folder, lastOutput: Date.now(), bypass: bypass === true, admin: admin === true });
    if (typeof group === 'string' && group) indexer?.postMessage({ setGroup: { id, name: group } });
    child.onData((data) => {
      if (chats.get(id) !== child) return;
      chatInfo.get(id).lastOutput = Date.now();
      send('chat:data', id, data);
    });
    child.onExit(({ exitCode }) => {
      statusBridge.release(status.token);
      endEdit(id);
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

ipcMain.handle('chat:start', async (_, { id, cwd, cols, rows, resume, group, bypass, admin, frugal }) => {
  const session = resume ? index.sessions.find((s) => s.id === id) : null;
  // A resumed chat always runs in the folder the index recorded, never one sent by the renderer.
  const folder = resume ? session?.cwd : (pickedFolders.has(cwd) || index.sessions.some((s) => s.cwd === cwd)) && cwd;
  if (!UUID.test(id) || chats.has(id) || launching.has(id) || !folder || !isSize(cols) || !isSize(rows)) {
    return { error: 'Invalid request.' };
  }
  const account = accounts.primary();
  const withFrugal = !resume && frugal === true && accounts.hasFrugal(account);
  const started = await launchChat({ id, folder, cols, rows, resume, group, account, file: session?.file, bypass: bypass === true, admin: admin === true, prompt: withFrugal ? '/frugal:frugal' : undefined });
  return started.ok ? { ...started, frugal: withFrugal } : started;
});

// A handoff continues in the folder its chat runs in, or the one the index recorded once it exits, on the account it ran on.
// frugal: the chat's bypass flag rides along, so a continued session keeps the permissions it already ran with.
ipcMain.handle('chat:continue', (_, { id, from, accountId, prompt, cols, rows, bypass, admin }) => {
  const folder = chatInfo.get(from)?.folder ?? index.sessions.find((s) => s.id === from)?.cwd;
  const account = accounts.claudeAccounts().find((candidate) => candidate.id === accountId);
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  // A leading dash would be read as a flag of claude.exe.
  if (!UUID.test(id) || chats.has(id) || launching.has(id) || !folder || !account || !text || text.startsWith('-') || !isSize(cols) || !isSize(rows)) {
    return { error: 'Invalid request.' };
  }
  return launchChat({ id, folder, cols, rows, account, prompt: text, bypass: bypass === true, admin: admin === true });
});

// Every live end_turn comes as an entry without a prompt; a handoff block adds one with it.
function offerHandoffs(handoffs) {
  for (const { id, prompt, tokens } of handoffs) {
    if (!chats.has(id)) continue;
    if (prompt) send('chat:handoff', id, { prompt, tokens });
    else send('chat:turn-end', id);
  }
}

ipcMain.handle('chat:switch-account', async (_, { id, accountId, cols, rows, bypass, admin }) => {
  const child = chats.get(id);
  const info = chatInfo.get(id);
  const account = accounts.claudeAccounts().find((candidate) => candidate.id === accountId);
  if (!child || !info || !account || !isSize(cols) || !isSize(rows)) return { error: 'Invalid request.' };
  const session = index.sessions.find((s) => s.id === id);
  const bypassOn = bypass === true;
  const adminOn = admin === true;
  const flagsChanged = bypassOn !== Boolean(info.bypass) || adminOn !== Boolean(info.admin);
  // A bypass or administrator change restarts the chat, so it is subject to the same idle guard as an account change.
  if (session && (info.account !== account.id || flagsChanged) && Date.now() - info.lastOutput < IDLE_MS) return { error: 'Claude is working. Switch accounts when it is idle.' };
  // A bypass or administrator toggle restarts on the chat's own account, which is no reason to make it the primary.
  if (info.account !== account.id || !flagsChanged) {
    accounts.setPrimary(account.id);
    publishAccounts();
  }
  if (info.account === account.id && !flagsChanged) return { ok: true, account: account.id };
  if (!session) return { error: 'Send a first message before switching this chat. New chats will use this account.' };
  const exited = new Promise((resolve) => child.onExit(resolve));
  chats.delete(id);
  chatInfo.delete(id);
  child.kill();
  await exited;
  send('chat:restarting', id);
  const started = await launchChat({ id, folder: session.cwd, cols, rows, resume: true, account, file: session.file, bypass: bypassOn, admin: adminOn });
  return started.error ? { ...started, stopped: true } : started;
});

// With no running chat to restart, Use only picks the account new chats start on.
ipcMain.handle('accounts:set-primary', (_, { id }) => {
  if (!accounts.claudeAccounts().some((account) => account.id === id)) return { error: 'Invalid request.' };
  accounts.setPrimary(id);
  publishAccounts();
  return { ok: true };
});
ipcMain.handle('accounts:get', () => accounts.snapshot());
ipcMain.handle('settings:roles', () => accounts.roles());
ipcMain.on('settings:set-roles', (_, on) => {
  if (typeof on === 'boolean') accounts.setRoles(on);
});

ipcMain.handle('accounts:rename', (_, { id, name }) => {
  if (accounts.renameAccount(id, name)) publishAccounts();
});

ipcMain.handle('accounts:set-cap', (_, { id, field, value }) => {
  if (accounts.setAccountCap(id, field, value)) publishAccounts();
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
ipcMain.on('chat:kill', (_, id) => {
  if (launching.has(id)) launching.get(id).cancelled = true;
  chats.get(id)?.kill();
});
// A save writes the text back before the response ends; a cancel (text === null) ends it without writing.
ipcMain.on('chat:save-edit', (_, id, text) => endEdit(id, text));
// The renderer is not trusted with the protocol: only web links reach the OS.
ipcMain.on('link:open', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

let topicRun = null;

let voice;
const voiceFiles = () => (voice ??= createVoice(path.join(app.getPath('userData'), 'voice')));
ipcMain.handle('voice:status', (_, model) => voiceFiles().status(model));
ipcMain.handle('voice:prepare', async (_, model) => {
  try {
    await voiceFiles().prepare(model, (received, total) => send('voice:progress', received, total));
    return { ok: true };
  } catch (error) {
    return { error: `The voice download failed: ${error.message}` };
  }
});
ipcMain.handle('voice:transcribe', async (_, { audio, model, language } = {}) => {
  try {
    return { text: await voiceFiles().transcribe(audio, model, language) };
  } catch (error) {
    return { error: `Transcription failed: ${error.message}` };
  }
});

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
  // A gone renderer can neither save nor cancel, so Claude must not wait on it.
  win.webContents.on('render-process-gone', dropEdits);
  win.on('maximize', () => send('window:maximized', true));
  win.on('unmaximize', () => send('window:maximized', false));
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// The prompt editor: Claude Code runs the .cmd with the file path appended and waits for it,
// the .cmd swaps in the Deck's own binary as plain Node, and the script waits on the chat's edit URL.
const EDITOR_SCRIPT = [
  '// Waits for the Deck to finish the file, then exits so Claude Code can read it.',
  'const { request } = require("http");',
  'const req = request(process.env.DECK_EDIT_URL, { method: "POST", headers: { "content-type": "text/plain" } }, (res) => res.resume().on("end", () => process.exit(0)));',
  'req.on("error", () => process.exit(0));',
  'req.end(process.argv[2] ?? "");',
].join('\n');

function writePromptEditor() {
  const dir = app.getPath('userData');
  const script = path.join(dir, 'prompt-editor.js');
  fs.writeFileSync(script, `${EDITOR_SCRIPT}\n`);
  // ELECTRON_RUN_AS_NODE is set only inside the .cmd, so the chat env itself stays clean.
  fs.writeFileSync(path.join(dir, 'prompt-editor.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${script}" %*\r\n`);
  return path.join(dir, 'prompt-editor.cmd');
}

// app.quit() hung for 80 s with a dialog open in the TUI (Test 1); app.exit does not.
app.on('window-all-closed', () => {
  dropEdits();
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
  editorCommand = writePromptEditor();
  createWindow();
  startIndexer();
});
