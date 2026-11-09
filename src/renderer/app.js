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
  starting: () => 'Iniciando',
  running: () => 'En marcha',
  exited: (chat) => `Terminó con código ${chat.exitCode}`,
  error: () => 'No se pudo iniciar',
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
    close.setAttribute('aria-label', `Cerrar chat ${chat.name}`);
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
const resetToday = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const resetDay = new Intl.DateTimeFormat('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function drawMeter(id, pct, resetsAt, format) {
  const element = $(id);
  element.hidden = pct === null || pct === undefined;
  if (element.hidden) return;
  element.querySelector('meter').value = pct;
  const reset = resetsAt ? format.format(resetsAt * 1000) : '';
  element.querySelector('.measured').textContent = reset ? `${Math.round(pct)}% · ${reset}` : `${Math.round(pct)}%`;
  element.title = reset ? `Se reinicia: ${reset}` : '';
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

async function newChat() {
  const cwd = await deck.pickFolder();
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
  if (live && !confirm(`Claude sigue en marcha en ${chat.name}. ¿Cerrar este chat?`)) return;
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

const shortDate = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' });
const openGroups = new Set();
let groupsDrawn = false;
let drawnSignature = '';
let currentIndex;

function sessionButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session';
  button.dataset.session = session.id;
  button.title = `${session.title}\nClic derecho para organizar`;
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

function groupElement(cwd, sessions) {
  const group = document.createElement('details');
  group.className = 'group';
  group.open = openGroups.has(cwd);
  group.ontoggle = () => (group.open ? openGroups.add(cwd) : openGroups.delete(cwd));
  const summary = document.createElement('summary');
  summary.className = 'group__name';
  summary.title = cwd;
  const name = document.createElement('span');
  name.className = 'group__label';
  name.textContent = folderName(cwd);
  const count = document.createElement('span');
  count.className = 'group__count measured';
  count.textContent = sessions.length;
  const chevron = icon('chevron');
  chevron.classList.add('group__chevron');
  summary.append(chevron, icon('folder'), name, count);
  group.append(summary, ...sessions.map(sessionButton));
  return group;
}

function indexStatus({ indexing, sessions, error }) {
  if (error) return `No se pudo leer el índice: ${error}`;
  if (sessions.length) return '';
  return indexing ? 'Indexando sesiones' : 'Todavía no hay sesiones.';
}

function pinnedElement(sessions) {
  const section = document.createElement('section');
  section.className = 'pinned';
  const heading = document.createElement('h2');
  heading.className = 'pinned__title';
  heading.textContent = 'Fijadas';
  section.append(heading, ...sessions.map(sessionButton));
  return section;
}

function drawSpaces(sessions) {
  const names = [...new Set(sessions.map((s) => s.space).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const select = $('space-filter');
  const chosen = names.includes(select.value) ? select.value : '';
  select.replaceChildren(new Option('Todos los espacios', ''), ...names.map((name) => new Option(name, name)));
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
  const signature = `${index.indexing}\n${$('space-filter').value}\n${index.sessions.map((s) => `${s.id}\n${s.title}\n${s.cwd}\n${shortDate.format(new Date(s.lastAt))}\n${s.pinned}\n${s.space}\n${s.tags}`).join('\n')}`;
  if (signature === drawnSignature) return;
  drawnSignature = signature;

  drawSpaces(index.sessions);
  const space = $('space-filter').value;
  const visible = space ? index.sessions.filter((s) => s.space === space) : index.sessions;
  const pinned = visible.filter((s) => s.pinned);
  const groups = Map.groupBy(visible.filter((s) => !s.pinned), (session) => session.cwd);
  if (!groupsDrawn && groups.size && !index.indexing) {
    groupsDrawn = true;
    openGroups.add(groups.keys().next().value);
  }
  const focused = document.activeElement?.dataset?.session;
  $('groups').replaceChildren(...(pinned.length ? [pinnedElement(pinned)] : []), ...[...groups].map(([cwd, sessions]) => groupElement(cwd, sessions)));
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
  const folder = document.createElement('span');
  folder.className = 'session__folder';
  folder.textContent = folderName(session.cwd);
  folder.title = session.cwd;
  row.querySelector('time').before(folder);
  return row;
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

$('new').onclick = newChat;
$('pick').onclick = newChat;
render();
deck.onSessions(renderSessions);
deck.getSessions().then(renderSessions);
