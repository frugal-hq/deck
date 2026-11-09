import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { matchSessions } from './palette.mjs';

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const chats = new Map();
let activeId = null;

const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const STATE_LABEL = {
  starting: () => 'Starting',
  running: () => 'Running',
  exited: (chat) => `Exited with code ${chat.exitCode}`,
  error: () => 'Failed to start',
};

function render() {
  const tabs = $('tabs');
  tabs.replaceChildren(...[...chats.values()].map((chat) => {
    const tab = document.createElement('div');
    tab.className = 'tab';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tab__open';
    const label = document.createElement('span');
    label.className = 'tab__label';
    label.textContent = chat.name;
    open.append(icon('terminal'), label);
    open.title = chat.cwd;
    if (chat.id === activeId) open.setAttribute('aria-current', 'true');
    open.onclick = () => activate(chat.id);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab__close';
    close.append(icon('x'));
    close.setAttribute('aria-label', `Close chat ${chat.name}`);
    close.onclick = () => closeChat(chat.id);
    tab.append(open, close);
    return tab;
  }));

  const chat = chats.get(activeId);
  $('empty').hidden = Boolean(chat);
  $('readout').hidden = !chat;
  $('notice').hidden = !chat?.error;
  $('notice').textContent = chat?.error ?? '';
  if (!chat) return;
  $('path').textContent = chat.cwd;
  $('session').textContent = chat.id.slice(0, 8);
  $('session').title = chat.id;
  $('state').textContent = STATE_LABEL[chat.state](chat);
  $('state').dataset.state = chat.state;
  drawMeters();
}

// frugal: one account for now, so limits are shared by every tab; Phase 3 keys them by account.
const limits = { fiveHour: null, sevenDay: null };
const resetToday = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' });
const resetDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function drawMeter(id, pct, resetsAt, format) {
  const element = $(id);
  element.hidden = pct === null || pct === undefined;
  if (element.hidden) return;
  element.querySelector('meter').value = pct;
  const reset = resetsAt ? format.format(resetsAt * 1000) : '';
  element.querySelector('.measured').textContent = reset ? `${Math.round(pct)}% - ${reset}` : `${Math.round(pct)}%`;
  element.title = reset ? `Resets: ${reset}` : '';
}

// frugal: readings refresh with each status line, so an idle chat keeps the last one until its next turn.
function drawMeters() {
  drawMeter('meter-context', chats.get(activeId)?.context);
  drawMeter('meter-five', limits.fiveHour?.pct, limits.fiveHour?.resetsAt, resetToday);
  drawMeter('meter-week', limits.sevenDay?.pct, limits.sevenDay?.resetsAt, resetDay);
}

function markActiveSession() {
  for (const button of $('groups').querySelectorAll('[data-session]')) {
    if (button.dataset.session === activeId) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function activate(id) {
  activeId = id;
  for (const chat of chats.values()) chat.el.hidden = chat.id !== id;
  render();
  markActiveSession();
  const chat = chats.get(id);
  if (!chat) return;
  syncSize(chat);
  chat.term.focus();
}

function syncSize(chat) {
  chat.fit.fit();
  if (chat.state === 'error' || (chat.term.cols === chat.cols && chat.term.rows === chat.rows)) return;
  chat.cols = chat.term.cols;
  chat.rows = chat.term.rows;
  deck.resize(chat.id, chat.cols, chat.rows);
}

// Ctrl+_ is the undo key of the Claude Code prompt; its TUI has no redo action (2.1.287).
const TUI_UNDO = '\x1f';
// Ctrl+V itself: with no text on the clipboard the TUI looks for an image.
const TUI_IMAGE_PASTE = '\x16';

function handleTerminalKey(chat, event) {
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return true;
  const key = event.key.toLowerCase();
  if (key === 'c' && chat.term.hasSelection()) {
    navigator.clipboard.writeText(chat.term.getSelection());
    chat.term.clearSelection();
  } else if (key === 'v') {
    navigator.clipboard.readText().catch(() => '').then((text) => {
      if (text) chat.term.paste(text);
      else deck.input(chat.id, TUI_IMAGE_PASTE);
    });
  } else if (key === 'z') {
    deck.input(chat.id, TUI_UNDO);
  } else {
    return true;
  }
  event.preventDefault();
  return false;
}

const folderName = (cwd) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

function startChat(cwd) {
  if (cwd) openChat({ id: crypto.randomUUID(), cwd, name: folderName(cwd), resume: false });
}

function resumeSession(session) {
  if (chats.has(session.id)) activate(session.id);
  else openChat({ id: session.id, cwd: session.cwd, name: session.title, resume: true });
}

async function openChat({ id, cwd, name, resume }) {
  const el = document.createElement('div');
  el.className = 'term';
  stage.append(el);
  const term = new Terminal({
    scrollback: 10000,
    fontFamily: token('--font-term'),
    fontSize: 14,
    theme: {
      background: token('--color-paper-3'),
      foreground: token('--color-ink'),
      cursor: token('--color-ink'),
      selectionBackground: token('--color-accent-soft'),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const chat = { id, cwd, name, el, term, fit, state: 'starting' };
  chats.set(id, chat);
  activate(id);
  chat.cols = term.cols;
  chat.rows = term.rows;
  term.onData((data) => deck.input(id, data));
  term.attachCustomKeyEventHandler((event) => handleTerminalKey(chat, event));

  const result = await deck.start({ id, cwd, cols: term.cols, rows: term.rows, resume });
  if (result.error) {
    chat.state = 'error';
    chat.error = result.error;
    render();
  }
}

function closeChat(id) {
  const chat = chats.get(id);
  const live = chat.state === 'starting' || chat.state === 'running';
  if (live && !confirm(`Claude is still running in ${chat.name}. Close this chat?`)) return;
  if (live) deck.kill(id);
  chat.term.dispose();
  chat.el.remove();
  chats.delete(id);
  if (activeId === id) activate([...chats.keys()].pop() ?? null);
  else render();
}

deck.onData((id, data) => {
  const chat = chats.get(id);
  if (!chat) return;
  chat.term.write(data);
  if (chat.state === 'starting') {
    chat.state = 'running';
    render();
  }
});

deck.onExit((id, code) => {
  const chat = chats.get(id);
  if (!chat) return;
  chat.state = 'exited';
  chat.exitCode = code;
  render();
});

deck.onMeters((id, { context, fiveHour, sevenDay }) => {
  const chat = chats.get(id);
  if (chat && context !== null) chat.context = context;
  limits.fiveHour = fiveHour ?? limits.fiveHour;
  limits.sevenDay = sevenDay ?? limits.sevenDay;
  if (chats.has(activeId)) drawMeters();
});

let frame = 0;
new ResizeObserver(() => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const chat = chats.get(activeId);
    if (chat) syncSize(chat);
  });
}).observe(stage);

const shortDate = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
const openGroups = new Set();
let groupsDrawn = false;
let drawnSignature = '';
let currentIndex;
const NO_TOPIC = 'No topic';
let sessionView = localStorage.getItem('sessionView') === 'topics' ? 'topics' : 'folders';

function sessionButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session';
  button.dataset.session = session.id;
  button.title = `${session.title}\nRight-click to organize`;
  const title = document.createElement('span');
  title.className = 'session__title';
  title.textContent = session.title;
  const date = document.createElement('time');
  date.className = 'session__date measured';
  date.dateTime = session.lastAt;
  date.textContent = shortDate.format(new Date(session.lastAt));
  button.append(title, date);
  if (session.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'session__tags';
    tags.textContent = session.tags.map((tag) => `#${tag}`).join(' ');
    date.before(tags);
  }
  button.oncontextmenu = (event) => {
    event.preventDefault();
    openOrganize(session);
  };
  button.onclick = () => resumeSession(session);
  return button;
}

function addFolderLabel(row, session) {
  const folder = document.createElement('span');
  folder.className = 'session__folder';
  folder.textContent = folderName(session.cwd);
  folder.title = session.cwd;
  row.querySelector('time').before(folder);
  return row;
}

function groupElement(key, sessions, byTopic) {
  const group = document.createElement('details');
  group.className = 'group';
  group.open = openGroups.has(key);
  group.ontoggle = () => (group.open ? openGroups.add(key) : openGroups.delete(key));
  const summary = document.createElement('summary');
  summary.className = 'group__name';
  summary.title = key;
  const name = document.createElement('span');
  name.className = 'group__label';
  name.textContent = byTopic ? key : folderName(key);
  const count = document.createElement('span');
  count.className = 'group__count measured';
  count.textContent = sessions.length;
  const chevron = icon('chevron');
  chevron.classList.add('group__chevron');
  summary.append(chevron, icon(byTopic ? 'topic' : 'folder'), name, count);
  group.append(summary, ...sessions.map((session) => (byTopic ? addFolderLabel(sessionButton(session), session) : sessionButton(session))));
  return group;
}

function indexStatus({ indexing, sessions, error }) {
  if (error) return `Could not read the index: ${error}`;
  if (sessions.length) return '';
  return indexing ? 'Indexing sessions' : 'No sessions yet.';
}

function pinnedElement(sessions) {
  const section = document.createElement('section');
  section.className = 'pinned';
  const heading = document.createElement('h2');
  heading.className = 'pinned__title';
  heading.textContent = 'Pinned';
  section.append(heading, ...sessions.map(sessionButton));
  return section;
}

function drawSpaces(sessions) {
  const names = [...new Set(sessions.map((s) => s.space).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-US'));
  const select = $('space-filter');
  const chosen = names.includes(select.value) ? select.value : '';
  select.replaceChildren(new Option('All spaces', ''), ...names.map((name) => new Option(name, name)));
  select.value = chosen;
  select.hidden = !names.length;
  $('space-names').replaceChildren(...names.map((name) => new Option(name, name)));
}

function renderSessions(index) {
  currentIndex = index;
  const status = indexStatus(index);
  $('index-status').hidden = !status;
  $('index-status').textContent = status;

  // Transcripts change every second during a turn; rebuilding only when the list changes keeps focus and scroll.
  const signature = `${sessionView}\n${index.indexing}\n${$('space-filter').value}\n${index.sessions.map((s) => `${s.id}\n${s.title}\n${s.cwd}\n${shortDate.format(new Date(s.lastAt))}\n${s.pinned}\n${s.space}\n${s.tags}\n${s.topic}`).join('\n')}`;
  if (signature === drawnSignature) return;
  drawnSignature = signature;
  if (sortDialog.open) drawSortEstimate();

  drawSpaces(index.sessions);
  const space = $('space-filter').value;
  const visible = space ? index.sessions.filter((s) => s.space === space) : index.sessions;
  const pinned = visible.filter((s) => s.pinned);
  const byTopic = sessionView === 'topics';
  const grouped = Map.groupBy(visible.filter((s) => !s.pinned), (session) => (byTopic ? session.topic ?? NO_TOPIC : session.cwd));
  const groups = [...grouped].sort(([a], [b]) => (a === NO_TOPIC) - (b === NO_TOPIC));
  if (!groupsDrawn && groups.length && !index.indexing) {
    groupsDrawn = true;
    openGroups.add(groups[0][0]);
  }
  const focused = document.activeElement?.dataset?.session;
  $('groups').replaceChildren(...(pinned.length ? [pinnedElement(pinned)] : []), ...groups.map(([key, sessions]) => groupElement(key, sessions, byTopic)));
  markActiveSession();
  if (focused) $('groups').querySelector(`[data-session="${focused}"]`)?.focus();
}

const palette = $('palette');
const paletteQuery = $('palette-query');
const paletteList = $('palette-list');
let paletteSessions = [];
let paletteRow = 0;

function selectPaletteRow(index) {
  paletteRow = index;
  [...paletteList.children].forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
  const row = paletteList.children[index];
  if (row) {
    paletteQuery.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  } else {
    paletteQuery.removeAttribute('aria-activedescendant');
  }
}

function chooseFromPalette(session) {
  palette.close();
  resumeSession(session);
}

function paletteOption(session, index) {
  const row = sessionButton(session);
  row.id = `palette-option-${index}`;
  row.role = 'option';
  row.tabIndex = -1;
  row.onclick = () => chooseFromPalette(session);
  row.title = session.title;
  row.oncontextmenu = null;
  return addFolderLabel(row, session);
}

function drawPalette() {
  const matches = matchSessions(paletteSessions, paletteQuery.value);
  paletteList.replaceChildren(...matches.map(paletteOption));
  $('palette-empty').hidden = matches.length > 0;
  selectPaletteRow(matches.length ? 0 : -1);
}

async function togglePalette() {
  if (palette.open) {
    palette.close();
    return;
  }
  paletteSessions = await deck.getAllSessions();
  paletteQuery.value = '';
  palette.showModal();
  drawPalette();
}

paletteQuery.oninput = drawPalette;

paletteQuery.onkeydown = (event) => {
  const count = paletteList.children.length;
  if (event.key === 'Enter') {
    event.preventDefault();
    paletteList.children[paletteRow]?.click();
  } else if (count && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    selectPaletteRow((paletteRow + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
  }
};

// Capture phase: xterm must never see this key, and Ctrl+K stays with the TUI (delete to end of line).
window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== 'k') return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) togglePalette();
}, true);

const organize = $('organize');
let organizing = null;

function openOrganize(session) {
  organizing = session;
  $('organize-title').textContent = session.title;
  $('organize-pinned').checked = session.pinned;
  $('organize-space').value = session.space ?? '';
  $('organize-tags').value = session.tags.join(', ');
  organize.showModal();
}

$('organize-form').onsubmit = () => {
  deck.organize(organizing.id, {
    pinned: $('organize-pinned').checked,
    space: $('organize-space').value,
    tags: $('organize-tags').value.split(','),
  });
};
$('organize-cancel').onclick = () => organize.close();
$('space-filter').onchange = () => renderSessions(currentIndex);

const viewRadios = document.querySelectorAll('input[name="session-view"]');
const sortDialog = $('sort-dialog');
let sorting = false;

function setSessionView(view) {
  sessionView = view;
  localStorage.setItem('sessionView', view);
  groupsDrawn = false;
  for (const radio of viewRadios) radio.checked = radio.value === view;
  renderSessions(currentIndex);
}

function sortOptions() {
  return { model: $('sort-model').value, effort: $('sort-effort').value, rename: $('sort-rename').checked };
}

function sortStatus(text, failed = false) {
  $('sort-status').hidden = !text;
  $('sort-status').textContent = text;
  $('sort-status').dataset.failed = failed;
}

async function drawSortEstimate() {
  if (sorting) return;
  const { sessions, tokens } = await deck.estimateTopics(sortOptions());
  $('sort-run').disabled = !sessions;
  $('sort-warning').textContent = sessions
    ? `This uses your Claude account: about ${tokens.toLocaleString('en-US')} tokens for ${sessions.toLocaleString('en-US')} session${sessions === 1 ? '' : 's'}. Only titles and folder names are sent.`
    : 'Every session already has what you asked for. Nothing to send.';
}

for (const radio of viewRadios) {
  radio.checked = radio.value === sessionView;
  radio.onchange = () => setSessionView(radio.value);
}
$('search').onclick = togglePalette;
$('sort').onclick = () => {
  sortDialog.showModal();
  drawSortEstimate();
};
$('sort-rename').onchange = drawSortEstimate;
$('sort-close').onclick = () => sortDialog.close();
$('sort-restore').onclick = () => {
  deck.restoreTitles();
  sortStatus('Original titles restored.');
};
$('sort-run').onclick = async () => {
  if (sorting) {
    deck.stopTopics();
    return;
  }
  sorting = true;
  $('sort-run').textContent = 'Stop';
  sortStatus('Sending the first batch');
  setSessionView('topics');
  const result = await deck.runTopics(sortOptions());
  sorting = false;
  $('sort-run').textContent = 'Find topics';
  sortStatus(result.error ?? (result.stopped ? 'Stopped. What was done is saved.' : 'Done.'), Boolean(result.error));
  drawSortEstimate();
};
deck.onTopicsProgress((done, total) => sortStatus(`Sorted ${done} of ${total}`));

const startInSessions = async () => startChat(await deck.defaultFolder());
const startInPicked = async () => startChat(await deck.pickFolder());
$('new').onclick = startInSessions;
$('start').onclick = startInSessions;
$('pick').onclick = startInPicked;
$('new-in-folder').onclick = startInPicked;
render();
for (const button of document.querySelectorAll('[data-window-action]')) {
  button.onclick = () => deck.windowAction(button.dataset.windowAction);
}
const maximizeButton = document.getElementById('window-maximize');
deck.onMaximized((maximized) => {
  maximizeButton.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
  maximizeButton.querySelector('use').setAttribute('href', maximized ? '#i-window-restore' : '#i-window-maximize');
});
deck.onSessions(renderSessions);
deck.getSessions().then(renderSessions);
