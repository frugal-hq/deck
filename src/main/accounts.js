// Accounts are only a name and a config folder; tokens stay in each folder, owned by Claude Code.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const run = promisify(execFile);
const MAIN = 'main';
const home = os.homedir();
const settingsFile = path.join(home, '.frugal-deck', 'settings.json');
const frugalFile = path.join(home, '.frugal', 'accounts.json');
const FRESH_MS = 5 * 60 * 1000;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// For a file Deck writes back: only a missing file may count as empty, or an unreadable one would be overwritten.
function readStrict(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
}

const load = () => readJson(settingsFile, {});
const save = (settings) => writeJson(settingsFile, settings);
const frugalAccounts = () => [readJson(frugalFile, {}).accounts ?? []].flat().filter((entry) => entry && typeof entry === 'object');

// frugal.json is outside Deck, so a folder from it must look like an account folder before it becomes CLAUDE_CONFIG_DIR.
function isAccountDir(dir) {
  if (typeof dir !== 'string') return false;
  const resolved = path.resolve(dir);
  return path.dirname(resolved).toLowerCase() === home.toLowerCase() && /^\.claude-[\w.-]+$/.test(path.basename(resolved));
}

function claudeAccounts() {
  const found = [{ id: MAIN, name: 'Main', configDir: path.join(home, '.claude') }];
  const add = ({ id, name, configDir }) => {
    const taken = found.some((account) => account.id === id || account.configDir.toLowerCase() === path.resolve(configDir).toLowerCase());
    if (typeof id === 'string' && ID.test(id) && isAccountDir(configDir) && !taken) found.push({ id, name: name || id, configDir: path.resolve(configDir) });
  };
  for (const account of load().accounts ?? []) add(account);
  for (const entry of frugalAccounts()) {
    if (entry.kind === 'claude' && entry.enabled !== false) add({ id: entry.id, name: entry.id, configDir: entry.config_dir });
  }
  return found;
}

function primary() {
  const accounts = claudeAccounts();
  return accounts.find((account) => account.id === load().primary) ?? accounts[0];
}

function setPrimary(id) {
  save({ ...load(), primary: id });
}

// A /frugal prompt in an account without the plugin only gets Claude Code's unknown-command reply.
const hasFrugal = (account) => Boolean(readJson(path.join(account.configDir, 'plugins', 'installed_plugins.json'), {}).plugins?.['frugal@frugal']?.length);

// Automatic roles: a chat never delegates to the account it runs on. On unless turned off.
const roles = () => load().roles !== false;
const setRoles = (on) => save({ ...load(), roles: on });

// The login Claude Code reports: the main account's lives beside ~/.claude, the others' inside their folder.
const emails = new Map();

function signedInEmail({ id, configDir }) {
  if (!emails.has(id)) emails.set(id, readJson(path.join(id === MAIN ? home : configDir, '.claude.json'), {}).oauthAccount?.emailAddress ?? null);
  return emails.get(id);
}

// Only the file's presence is checked; Claude Code removes it on logout.
const isSignedIn = ({ configDir }) => fs.existsSync(path.join(configDir, '.credentials.json'));

const localDay = (now) => {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const names = (folder) => {
  try {
    return fs.readdirSync(folder).sort().reverse();
  } catch {
    return [];
  }
};

function newestRollout(folder) {
  try {
    return fs.readdirSync(folder)
      .filter((name) => /^rollout-.*\.jsonl$/.test(name))
      .map((name) => path.join(folder, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

function codexLimits(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  try {
    const sessions = path.join(home, 'sessions');
    let file = null;
    for (const year of names(sessions)) {
      for (const month of names(path.join(sessions, year))) {
        for (const day of names(path.join(sessions, year, month))) {
          file = newestRollout(path.join(sessions, year, month, day));
          if (file) break;
        }
        if (file) break;
      }
      if (file) break;
    }
    if (!file) return null;
    const at = fs.statSync(file).mtimeMs;
    let limits = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"rate_limits"')) continue;
      try {
        const record = JSON.parse(line);
        limits = record?.payload?.rate_limits ?? record?.rate_limits ?? limits;
      } catch {
        // Malformed lines are skipped.
      }
    }
    if (!limits) return null;
    const result = { fiveHour: null, sevenDay: null, at };
    for (const key of ['primary', 'secondary']) {
      const window = limits[key];
      if (!window) continue;
      const target = window.window_minutes === 300 ? 'fiveHour' : window.window_minutes === 10080 ? 'sevenDay' : null;
      if (target) result[target] = { pct: Number(window.used_percent), resetsAt: typeof window.resets_at === 'number' ? window.resets_at : null };
    }
    return result;
  } catch {
    return null;
  }
}

function snapshot(now = Date.now()) {
  const settings = load();
  const { readings = {}, labels = {} } = settings;
  const list = claudeAccounts().map((account) => {
    const signedIn = isSignedIn(account);
    return { ...account, name: labels[account.id] ?? account.name, signedIn, email: signedIn ? signedInEmail(account) : null, limits: readings[account.id] ?? null, caps: accountCaps(account.id, settings), capsApply: capsApply(account.id) };
  });
  // Two folders on one login share its limits, so switching between them gains nothing.
  for (const account of list) account.sameLogin = account.email ? list.filter((other) => other !== account && other.email?.toLowerCase() === account.email.toLowerCase()).map((other) => other.name) : [];
  return {
    primary: primary().id,
    accounts: list,
    others: frugalAccounts()
      .filter((entry) => entry.kind !== 'claude' && entry.enabled !== false && typeof entry.id === 'string')
      .map((entry) => ({ id: entry.id, name: labels[entry.id] ?? entry.id.replace(/^oc-/, ''), kind: String(entry.kind ?? ''), model: typeof entry.model === 'string' ? entry.model : null, exhaustedUntil: entry.exhausted_until > now / 1000 ? entry.exhausted_until : null, usedToday: entry.day === localDay(now) && typeof entry.used === 'number' ? entry.used : 0, limits: entry.kind === 'codex' ? codexLimits() : null, caps: accountCaps(entry.id, settings), capsApply: capsApply(entry.id) })),
  };
}

function renameAccount(id, name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 24) : '';
  if (!clean || ![...claudeAccounts(), ...frugalAccounts()].some((account) => account.id === id)) return false;
  const settings = load();
  save({ ...settings, labels: { ...settings.labels, [id]: clean } });
  return true;
}

const DEFAULT_CAP = 100;

function capOf(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : DEFAULT_CAP;
}

function accountCaps(id, settings = load()) {
  const stored = settings.caps?.[id];
  return { fiveHour: capOf(stored?.fiveHour), sevenDay: capOf(stored?.sevenDay) };
}

// Why a cap can or cannot act: Frugal only marks its own delegates, and only from a usage reading.
function capsApply(id) {
  const entry = frugalAccounts().find((item) => item.id === id);
  if (!entry) return 'not-delegate';
  return entry.kind === 'claude' || entry.kind === 'codex' ? 'ok' : 'no-reading';
}

const capReading = (entry, settings) => (entry.kind === 'codex' ? codexLimits() : settings.readings?.[entry.id]);

function resetUnix(resetsAt, now) {
  if (resetsAt == null || resetsAt === '') return Math.floor(now / 1000) + 3600;
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) return Math.floor(resetsAt > 1e12 ? resetsAt / 1000 : resetsAt);
  const parsed = Date.parse(resetsAt);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(now / 1000) + 3600;
}

function capExhaustedUntil(reading, caps, previous, now = Date.now()) {
  const windows = [
    [reading?.fiveHour, capOf(caps?.fiveHour)],
    [reading?.sevenDay, capOf(caps?.sevenDay)],
  ];
  let until = null;
  for (const [window, cap] of windows) {
    if (window == null || typeof window.pct !== 'number' || !Number.isFinite(window.pct) || window.pct < cap) continue;
    const resets = resetUnix(window.resetsAt, now);
    if (until == null || resets > until) until = resets;
  }
  if (until == null) return null;
  const existing = typeof previous === 'number' && Number.isFinite(previous) ? previous : 0;
  return until > existing ? until : null;
}

// frugal: caps only apply as fresh readings arrive while the Deck runs.
function applyAccountCaps(id, reading, now = Date.now()) {
  if (capsApply(id) !== 'ok') return;
  const settings = load();
  try {
    withFrugalLock(frugalFile, () => {
      const data = readStrict(frugalFile, null);
      const entry = (data?.accounts ?? []).find((item) => item?.id === id);
      const limits = entry && (reading ?? capReading(entry, settings));
      if (!limits) return;
      const until = capExhaustedUntil(limits, accountCaps(id, settings), entry.exhausted_until, now);
      if (until == null) return;
      entry.exhausted_until = until;
      writeJson(frugalFile, data);
    });
  } catch {
    // An unreadable accounts.json is left alone.
  }
}

// Codex readings come from its own session files, so its caps are checked each time the panel refreshes.
const applyCodexCaps = () => frugalAccounts().filter((entry) => entry.kind === 'codex').forEach((entry) => applyAccountCaps(entry.id));

function setAccountCap(id, field, value) {
  if ((field !== 'fiveHour' && field !== 'sevenDay') || capsApply(id) !== 'ok') return false;
  if (!Number.isFinite(Number(value))) return false;
  const n = Math.min(100, Math.max(0, Math.round(Number(value) / 5) * 5));
  const settings = load();
  save({ ...settings, caps: { ...settings.caps, [id]: { ...accountCaps(id, settings), [field]: n } } });
  applyAccountCaps(id);
  return true;
}

function saveReading(id, { fiveHour, sevenDay }, at = Date.now()) {
  if (!fiveHour && !sevenDay) return false;
  const settings = load();
  const previous = settings.readings?.[id] ?? {};
  const reading = { fiveHour: fiveHour ?? previous.fiveHour ?? null, sevenDay: sevenDay ?? previous.sevenDay ?? null, at };
  settings.readings = { ...settings.readings, [id]: reading };
  save(settings);
  applyAccountCaps(id, reading, at);
  return true;
}

function prepareAccount(name) {
  const clean = typeof name === 'string' ? name.trim().slice(0, 40) : '';
  const id = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!ID.test(id)) throw new Error('Use letters or numbers in the account name.');
  if ([...claudeAccounts(), ...frugalAccounts()].some((account) => account.id === id)) throw new Error(`An account named ${id} already exists.`);
  const configDir = path.join(home, `.claude-${id}`);
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  return { id, name: clean, configDir };
}

// A parse failure must stop here: writing over an unreadable .claude.json would lose the account's state.
function ensureOnboarded(configDir) {
  const file = path.join(configDir, '.claude.json');
  const config = readStrict(file, {});
  if (config.hasCompletedOnboarding !== true) writeJson(file, { ...config, hasCompletedOnboarding: true });
}

// frugal's server.py holds this lock around every read-modify-write of accounts.json; like it, wait 5 s and then go ahead.
function withFrugalLock(file, work) {
  const lock = path.join(path.dirname(file), 'files.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let handle = null;
  for (let tries = 0; tries < 500 && handle === null; tries += 1) {
    try {
      handle = fs.openSync(lock, 'wx');
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock);
      } catch {
        // Another process just released it.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    if (handle !== null) {
      fs.closeSync(handle);
      fs.rmSync(lock, { force: true });
    }
  }
}

function joinFrugalPool({ id, configDir }, file = frugalFile) {
  withFrugalLock(file, () => {
    const data = readStrict(file, { accounts: [] });
    data.accounts = [...(data.accounts ?? []), { id, kind: 'claude', enabled: true, used: 0, day: '', config_dir: configDir }];
    writeJson(file, data);
  });
}

// frugal: only the login check is done here; plugins, skills and settings are not copied to a new account yet.
function finishAccount(account) {
  if (!fs.existsSync(path.join(account.configDir, '.credentials.json'))) return false;
  ensureOnboarded(account.configDir);
  const settings = load();
  save({ ...settings, accounts: [...(settings.accounts ?? []), account] });
  try {
    joinFrugalPool(account);
  } catch {
    // An unreadable accounts.json is left alone; the account still works in Deck.
  }
  return true;
}

function leaveFrugalPool(id, file = frugalFile) {
  withFrugalLock(file, () => {
    const data = readStrict(file, null);
    const kept = (data?.accounts ?? []).filter((entry) => !(entry?.kind === 'claude' && entry.id === id));
    if (kept.length !== (data?.accounts ?? []).length) writeJson(file, { ...data, accounts: kept });
  });
}

// Shared project folders are junctions into another account; they are unlinked, never walked, so the delete stays inside this folder.
function removeTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeTree(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

// A chat started on this account lives only in its folder, so it moves to Main's before the delete. Junctions are Main's own folders and
// a file Main already has is the same hard link, so both stay; folders on both sides merge.
// frugal: only projects/ moves; todos and file-history of those chats are deleted with the folder.
function moveMissing(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (!fs.existsSync(target)) fs.renameSync(source, target);
    else if (entry.isDirectory()) moveMissing(source, target);
  }
}

// The folder goes first: if that fails the account stays listed, so Delete can be tried again.
function removeAccount(id) {
  const account = claudeAccounts().find((candidate) => candidate.id === id);
  if (!account || id === MAIN || !isAccountDir(account.configDir)) return false;
  if (fs.existsSync(account.configDir)) {
    const projects = path.join(account.configDir, 'projects');
    if (fs.existsSync(projects)) moveMissing(projects, path.join(home, '.claude', 'projects'));
    removeTree(account.configDir);
  }
  leaveFrugalPool(id);
  const { accounts: list = [], labels = {}, readings = {}, caps = {}, ...settings } = load();
  delete labels[id];
  delete readings[id];
  delete caps[id];
  if (settings.primary === id) delete settings.primary;
  save({ ...settings, accounts: list.filter((entry) => entry.id !== id), labels, readings, caps });
  emails.delete(id);
  return true;
}

// A project folder missing from the target account becomes a junction; a real one is never replaced, so only this session is hard-linked into it.
// frugal: a hard link follows appends only; copy the file if Claude Code ever rewrites transcripts by rename.
function shareTranscript(file, configDir) {
  const source = fs.realpathSync(path.dirname(file));
  const projects = path.join(configDir, 'projects');
  const target = path.join(projects, path.basename(path.dirname(file)));
  fs.mkdirSync(projects, { recursive: true });
  if (!fs.existsSync(target)) return fs.symlinkSync(source, target, 'junction');
  if (fs.realpathSync(target).toLowerCase() === source.toLowerCase()) return undefined;
  const link = path.join(target, path.basename(file));
  if (!fs.existsSync(link)) fs.linkSync(file, link);
  return undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The panel prints local wall-clock times with no year.
function parseReset(text, now) {
  const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm)/.exec(text ?? '');
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (month < 0) return null;
  const hour = (Number(match[3]) % 12) + (match[5] === 'pm' ? 12 : 0);
  const at = new Date(now.getFullYear(), month, Number(match[2]), hour, Number(match[4] ?? 0));
  if (at < now - 24 * 60 * 60 * 1000) at.setFullYear(at.getFullYear() + 1);
  return Math.floor(at.getTime() / 1000);
}

function parseUsage(text, now = new Date()) {
  const read = (label) => {
    const match = new RegExp(`^${label}:\\s*(\\d+)% used(?:.*?resets (.+))?$`, 'm').exec(text);
    return match ? { pct: Number(match[1]), resetsAt: parseReset(match[2], now) } : null;
  };
  return { fiveHour: read('Current session'), sevenDay: read('Current week \\(all models\\)') };
}

// The main account's -p /usage omits these lines (Test 7), so it only gets status line readings.
// only: one account read even with chats open on it, as when a chat just switched to it and has no status line yet.
async function refreshReadings(claude, env, openAccounts, only) {
  emails.clear();
  const { readings = {} } = load();
  const stale = claudeAccounts().filter((account) => account.id !== MAIN && (only ? account.id === only : !openAccounts.has(account.id)) && Date.now() - (readings[account.id]?.at ?? 0) >= FRESH_MS);
  await Promise.all(stale.map(async (account) => {
    try {
      const { stdout } = await run(claude, ['-p', '/usage', '--no-session-persistence', '--output-format', 'json'], { env: { ...env, CLAUDE_CONFIG_DIR: account.configDir }, cwd: home, timeout: 60000, windowsHide: true });
      saveReading(account.id, parseUsage(JSON.parse(stdout).result ?? ''));
    } catch {
      // The last reading stays on screen with its time.
    }
  }));
  return stale.length > 0;
}

const clearEmails = () => emails.clear();

module.exports = { MAIN, claudeAccounts, primary, setPrimary, hasFrugal, roles, setRoles, snapshot, renameAccount, saveReading, setAccountCap, applyCodexCaps, capExhaustedUntil, prepareAccount, ensureOnboarded, finishAccount, removeAccount, clearEmails, shareTranscript, parseUsage, refreshReadings, codexLimits };

if (require.main === module) {
  const assert = require('assert');
  const now = new Date(2026, 10, 9, 12, 0);
  const usage = parseUsage('Current session: 9% used · resets Nov 9, 3:10pm (America/Lima)\nCurrent week (all models): 95% used · resets Nov 9, 11pm (America/Lima)', now);
  assert.deepStrictEqual(usage, {
    fiveHour: { pct: 9, resetsAt: new Date(2026, 10, 9, 15, 10).getTime() / 1000 },
    sevenDay: { pct: 95, resetsAt: new Date(2026, 10, 9, 23, 0).getTime() / 1000 },
  });
  assert.strictEqual(parseUsage('Current session: 0% used · resets Jan 2, 12am (X)', now).fiveHour.resetsAt, new Date(2027, 0, 2, 0, 0).getTime() / 1000);
  assert.deepStrictEqual(parseUsage('breakdown only', now), { fiveHour: null, sevenDay: null });

  const codex = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-codex-'));
  const day = path.join(codex, 'sessions', '2026', '11', '09');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [
    '{"type":"event_msg","payload":{"type":"other"}}',
    '{"type":"event_msg","payload":{"rate_limits":',
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":4.0,"window_minutes":300,"resets_at":1794255884},"secondary":{"used_percent":39.0,"window_minutes":10080,"resets_at":1794417951},"credits":{}}}}',
  ].join('\n'));
  const limits = codexLimits(codex);
  assert.deepStrictEqual(limits.fiveHour, { pct: 4, resetsAt: 1794255884 });
  assert.deepStrictEqual(limits.sevenDay, { pct: 39, resetsAt: 1794417951 });
  const emptyCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-codex-'));
  assert.strictEqual(codexLimits(emptyCodex), null);
  fs.rmSync(codex, { recursive: true });
  fs.rmSync(emptyCodex, { recursive: true });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-accounts-'));
  const source = path.join(root, 'a', 'projects', 'slug');
  fs.mkdirSync(source, { recursive: true });
  const file = path.join(source, 'one.jsonl');
  fs.writeFileSync(file, 'x');

  const fresh = path.join(root, 'b');
  shareTranscript(file, fresh);
  assert.ok(fs.lstatSync(path.join(fresh, 'projects', 'slug')).isSymbolicLink(), 'missing folder becomes a junction');
  shareTranscript(file, fresh);

  const taken = path.join(root, 'c');
  fs.mkdirSync(path.join(taken, 'projects', 'slug'), { recursive: true });
  fs.writeFileSync(path.join(taken, 'projects', 'slug', 'own.jsonl'), 'keep');
  shareTranscript(file, taken);
  shareTranscript(file, taken);
  assert.ok(fs.lstatSync(path.join(taken, 'projects', 'slug')).isDirectory(), 'real folder is kept');
  assert.strictEqual(fs.readFileSync(path.join(taken, 'projects', 'slug', 'own.jsonl'), 'utf8'), 'keep');
  fs.appendFileSync(file, 'y');
  assert.strictEqual(fs.readFileSync(path.join(taken, 'projects', 'slug', 'one.jsonl'), 'utf8'), 'xy', 'hard link follows appends');

  shareTranscript(file, path.join(root, 'a'));
  assert.deepStrictEqual(fs.readdirSync(source), ['one.jsonl'], 'own account is untouched');

  const pool = path.join(root, 'frugal', 'accounts.json');
  fs.mkdirSync(path.dirname(pool));
  fs.writeFileSync(pool, JSON.stringify({ opencode_allow_training: true, accounts: [{ id: 'old', kind: 'grok' }] }));
  joinFrugalPool({ id: 'new', configDir: 'c' }, pool);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(pool, 'utf8')), { opencode_allow_training: true, accounts: [{ id: 'old', kind: 'grok' }, { id: 'new', kind: 'claude', enabled: true, used: 0, day: '', config_dir: 'c' }] });
  assert.ok(!fs.existsSync(path.join(root, 'frugal', 'files.lock')), 'lock is released');
  fs.writeFileSync(pool, '{broken');
  assert.throws(() => joinFrugalPool({ id: 'x', configDir: 'c' }, pool));
  assert.strictEqual(fs.readFileSync(pool, 'utf8'), '{broken', 'unreadable pool is untouched');
  assert.ok(!fs.existsSync(path.join(root, 'frugal', 'files.lock')), 'lock is released on failure');

  fs.writeFileSync(pool, JSON.stringify({ accounts: [{ id: 'new', kind: 'claude' }, { id: 'new', kind: 'grok' }] }));
  leaveFrugalPool('new', pool);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(pool, 'utf8')).accounts, [{ id: 'new', kind: 'grok' }], 'only the Claude entry leaves');

  // taken has its own chat, a hard link to a's, and a subagent file in a session folder a also has: all reach a before the delete.
  fs.mkdirSync(path.join(taken, 'projects', 'slug', 'one', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(source, 'one'));
  fs.writeFileSync(path.join(taken, 'projects', 'slug', 'one', 'subagents', 'agent.jsonl'), 'sub');
  fs.mkdirSync(path.join(taken, 'projects', 'other'));
  fs.writeFileSync(path.join(taken, 'projects', 'other', 'two.jsonl'), 'two');
  moveMissing(path.join(taken, 'projects'), path.join(root, 'a', 'projects'));
  assert.strictEqual(fs.readFileSync(path.join(source, 'own.jsonl'), 'utf8'), 'keep', 'own chat moves');
  assert.strictEqual(fs.readFileSync(path.join(source, 'one', 'subagents', 'agent.jsonl'), 'utf8'), 'sub', 'folders merge');
  assert.strictEqual(fs.readFileSync(path.join(root, 'a', 'projects', 'other', 'two.jsonl'), 'utf8'), 'two', 'new project moves');
  moveMissing(path.join(fresh, 'projects'), path.join(root, 'a', 'projects'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'xy', 'junction is skipped');

  // fresh/projects/slug is a junction to a/projects/slug; deleting fresh must leave a's transcript.
  fs.writeFileSync(path.join(fresh, 'own.txt'), 'x');
  removeTree(fresh);
  assert.ok(!fs.existsSync(fresh), 'account folder is gone');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'xy', 'junction target survives');
  removeTree(taken);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'xy', 'hard-linked transcript survives');

  assert.ok(!isAccountDir(path.join(root, '.claude-x')) && !isAccountDir(home) && isAccountDir(path.join(home, '.claude-x')));
  fs.rmSync(root, { recursive: true });
  console.log('accounts ok');
}
