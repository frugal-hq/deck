import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { matchSessions } from './palette.mjs';
import { groupChats, buildTree } from './chats.mjs';
import { trustPromptKey } from './trust.mjs';

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

// Copies the symbol's shapes in place of <use>, so CSS can reach them: the working icon animates its levels.
function inlineIcon(name) {
  const symbol = $(`i-${name}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', symbol.getAttribute('viewBox'));
  svg.append(...[...symbol.children].map((shape) => shape.cloneNode(true)));
  return svg;
}

const STATUS_LABEL = { working: 'Working', waiting: 'Waiting for your answer', replied: 'Replied' };

function statusIcon(status) {
  if (!status) return icon('terminal');
  const svg = inlineIcon(status);
  svg.setAttribute('class', `icon status status--${status}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', STATUS_LABEL[status]);
  return svg;
}

function setRowStatus(row, status) {
  row.querySelector('.session__status')?.remove();
  if (!status) return;
  const svg = statusIcon(status);
  svg.classList.add('session__status');
  row.prepend(svg);
}

function drawStatus(chat) {
  chat.tab?.querySelector('.tab__open > svg').replaceWith(statusIcon(chat.status));
  for (const row of $('groups').querySelectorAll(`[data-session="${chat.id}"]`)) setRowStatus(row, chat.status);
  render();
}

// Moving a tab re-inserts it, which would replay its entrance; is-sorting turns that off for the move.
function moveTab(move) {
  const tabs = $('tabs');
  tabs.classList.add('is-sorting');
  move();
  tabs.getBoundingClientRect();
  tabs.classList.remove('is-sorting');
}

function togglePin(chat) {
  chat.pinned = !chat.pinned;
  moveTab(() => {
    const lastPinned = [...$('tabs').querySelectorAll('.tab.is-pinned')].filter((tab) => tab !== chat.tab).pop();
    if (lastPinned) lastPinned.after(chat.tab);
    else $('tabs').prepend(chat.tab);
  });
  chat.tab.classList.toggle('is-pinned', chat.pinned);
  render();
}

let draggedTab = null;

const STATE_LABEL = {
  starting: () => 'Starting',
  running: () => 'Running',
  exited: (chat) => `Exited with code ${chat.exitCode}`,
  error: () => 'Failed to start',
};

function tabElement(chat) {
  const tab = document.createElement('div');
  tab.className = 'tab';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'tab__open';
  const label = document.createElement('span');
  label.className = 'tab__label';
  open.append(statusIcon(null), label);
  open.onclick = () => activate(chat.id);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab__close';
  close.append(icon('x'));
  close.onclick = () => closeChat(chat.id);
  close.dataset.tip = 'Close this chat';
  tab.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    closeChat(chat.id);
  });
  tab.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  tab.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, [
      { label: chat.pinned ? 'Unpin tab' : 'Pin tab', run: () => togglePin(chat) },
      { label: 'Close', run: () => closeChat(chat.id) },
    ], tab);
  });
  tab.draggable = true;
  tab.addEventListener('dragstart', (event) => {
    draggedTab = tab;
    event.dataTransfer.effectAllowed = 'move';
    tab.classList.add('is-dragging');
  });
  tab.addEventListener('dragend', () => {
    tab.classList.remove('is-dragging');
    draggedTab = null;
  });
  // Pinned tabs sort among themselves, the rest after them.
  tab.addEventListener('dragover', (event) => {
    if (!draggedTab || draggedTab === tab || draggedTab.classList.contains('is-pinned') !== tab.classList.contains('is-pinned')) return;
    event.preventDefault();
    const { left, width } = tab.getBoundingClientRect();
    const before = event.clientX < left + width / 2;
    if ((before ? tab.previousElementSibling : tab.nextElementSibling) !== draggedTab) moveTab(() => tab[before ? 'before' : 'after'](draggedTab));
  });
  tab.addEventListener('drop', (event) => event.preventDefault());
  tab.append(open, close);
  return tab;
}

function fadeOut(element) {
  element.classList.add('leaving');
  Promise.allSettled(element.getAnimations().map((animation) => animation.finished)).then(() => element.remove());
}

function render() {
  // Tabs persist between renders: rebuilding them would replay the fade-in on every state change.
  for (const chat of chats.values()) {
    chat.name = currentIndex?.sessions?.find((s) => s.id === chat.id)?.title ?? chat.name;
    chat.tab ??= $('tabs').appendChild(tabElement(chat));
    const [open, close] = chat.tab.children;
    open.querySelector('.tab__label').textContent = chat.name;
    open.dataset.tip = [chat.pinned ? chat.name : null, chat.cwd, STATUS_LABEL[chat.status]].filter(Boolean).join('\n');
    open.setAttribute('aria-label', chat.name);
    if (chat.id === activeId) open.setAttribute('aria-current', 'true');
    else open.removeAttribute('aria-current');
    close.setAttribute('aria-label', `Close chat ${chat.name}`);
  }

  const chat = chats.get(activeId);
  $('empty').hidden = Boolean(chat);
  $('readout').hidden = !chat;
  $('notice').hidden = !chat?.error;
  $('notice').textContent = chat?.error ?? '';
  drawHandoff();
  const activeSession = currentIndex?.sessions?.find((s) => s.id === activeId);
  $('link-chat').hidden = !activeSession;
  $('attach').hidden = chat?.state !== 'running';
  const activeChat = activeSession && chatsById.get(activeSession.chatId);
  const chatCount = activeChat ? activeChat.earlier.length + 1 : 0;
  const historyButton = $('chat-history');
  historyButton.hidden = chatCount < 2;
  const historyLabel = historyButton.querySelector('span');
  if (historyLabel) historyLabel.textContent = chatCount;
  historyButton.dataset.tip = `${chatCount} sessions in this chat. Open another one`;
  historyButton.setAttribute('aria-label', `${chatCount} sessions in this chat`);
  const linked = Boolean(activeSession?.parentId);
  const linkButton = $('link-chat');
  linkButton.classList.toggle('is-linked', linked);
  linkButton.querySelector('span').textContent = linked ? 'Linked' : 'Link';
  linkButton.dataset.tip = linked ? 'Already linked to a chat. Click to move or unlink it' : 'Join this session to another chat';
  if (!chat) return;
  $('path').textContent = chat.cwd;
  $('session').textContent = chat.id.slice(0, 8);
  $('session').dataset.tip = chat.id;
  $('state').textContent = STATE_LABEL[chat.state](chat);
  $('state').dataset.state = chat.state;
  drawMeters();
}

let accountState = { primary: null, accounts: [], others: [] };
const WARN_PCT = 80;
const DAY_MS = 86400000;
const resetDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const resetExact = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact' });

function drawMeter(id, pct, text) {
  const element = $(id);
  element.hidden = pct === null || pct === undefined;
  if (element.hidden) return;
  element.querySelector('meter').value = pct;
  element.querySelector('.measured').textContent = text;
}

// A reading whose window already reset says nothing about the current one.
const liveLimit = (limit) => (limit && (!limit.resetsAt || limit.resetsAt * 1000 > Date.now()) ? limit : null);

function spanText(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
}

function resetLabel(resetsAt) {
  const ms = resetsAt * 1000 - Date.now();
  return ms < DAY_MS ? `in ${spanText(ms)}` : resetDay.format(resetsAt * 1000);
}

const limitTip = (label, limit) => (limit.resetsAt ? `${label} resets ${resetExact.format(limit.resetsAt * 1000)}` : `${label} has no reset time yet`);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function resetNode(tag, className, limit) {
  const element = node(tag, className, limit.resetsAt ? resetLabel(limit.resetsAt) : '');
  if (limit.resetsAt) element.dataset.reset = limit.resetsAt;
  return element;
}

function usageMeter(label, limit) {
  const meter = Object.assign(node('meter'), { min: 0, max: 100, low: 60, high: 80, optimum: 0, value: limit.pct });
  meter.setAttribute('aria-label', `${label} used`);
  return meter;
}

function askRename(account) {
  ask({
    title: 'Rename account',
    text: 'Only changes how Deck shows it.',
    value: account.name,
    action: 'Rename',
    run: (name) => deck.renameAccount(account.id, name),
  });
}

function accountName(account, details) {
  const button = node('button', 'account__name', account.name);
  button.type = 'button';
  button.dataset.tip = [...details, 'Click to rename'].filter(Boolean).join('\n');
  button.onclick = () => askRename(account);
  return button;
}

function report(result) {
  if (result?.error) ask({ title: 'Account', text: result.error, action: 'OK', run: () => {} });
}

function signIn(account) {
  $('usage').hidePopover();
  openChat({ id: crypto.randomUUID(), cwd: `Sign in to ${account.name}`, name: `Sign in: ${account.name}`, login: account.name, accountId: account.id });
}

function accountMenu(account) {
  const items = [{ label: 'Rename', run: () => askRename(account) }];
  if (!account.signedIn) items.push({ label: 'Sign in', run: () => signIn(account) });
  else items.push({ label: 'Sign out', run: () => ask({
    title: `Sign out of ${account.name}?`,
    text: `Its folder, chats and settings stay, so you can sign in to it again later.${account.id === 'main' ? ' Claude Code in your terminals uses this sign-in too, so finish their work first.' : ''}`,
    action: 'Sign out',
    run: async () => report(await deck.logout(account.id)),
  }) });
  if (account.id !== 'main') items.push({ label: 'Delete', danger: true, run: () => ask({
    title: `Delete ${account.name}?`,
    text: `This deletes ${account.configDir}, with its sign-in and settings. Its chats move to Main first. It also leaves Frugal. This cannot be undone.`,
    action: 'Delete',
    danger: true,
    run: async () => report(await deck.removeAccount(account.id)),
  }) });
  return items;
}

// The menu opens from the more button or a right-click anywhere on the account, over the panel, which stays open.
function withMenu(target, account) {
  const button = moreButton(account.name, () => accountMenu(account));
  button.classList.replace('group__new', 'account__more');
  target.oncontextmenu = (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, accountMenu(account), target);
  };
  return button;
}

// What the panel says under a name: the login or that there is none, and a warning when another account shares it.
function loginLines(account) {
  const lines = [node('span', 'account__email', account.signedIn ? account.email ?? 'Signed in' : 'Signed out')];
  if (account.sameLogin.length) lines.push(node('span', 'account__detail is-warn', `Same login as ${account.sameLogin.join(', ')}`));
  return lines;
}

const accountLimits = (account) => [['5-hour limit', liveLimit(account.limits?.fiveHour)], ['Weekly', liveLimit(account.limits?.sevenDay)]];

// One limit as a label, its reset and percent on a line, with a full-width bar under them.
function limitRow(label, limit) {
  const row = node('div', 'limit');
  row.dataset.tip = limitTip(label, limit);
  const used = node('span', 'limit__pct', `${Math.round(limit.pct)}%`);
  used.classList.toggle('is-warn', limit.pct >= WARN_PCT);
  row.append(node('span', 'limit__label', label), resetNode('span', 'limit__reset', limit), used, usageMeter(label, limit));
  return row;
}

// frugal: blocks are redrawn on every status line, so keyboard focus on Use is lost when a reading arrives.
function accountBlock(account, primary, chat) {
  const block = node('section', 'account');
  const head = node('div', 'account__head');
  const age = account.limits?.at ? `Read ${spanText(Date.now() - account.limits.at)} ago` : '';
  head.append(accountName(account, [account.configDir, primary ? '' : age]));
  if (primary) head.append(node('span', 'tag tag--primary', 'Primary'));
  else if (account.signedIn && chat?.account && chat.state === 'running') {
    const button = node('button', 'btn', 'Use');
    button.type = 'button';
    button.dataset.tip = 'Restart this chat on this account. New chats use it too';
    button.onclick = () => useAccount(chat, account);
    head.append(button);
  } else if (account.signedIn) {
    const hint = node('span', 'tag tag--switch', 'Can be primary');
    hint.dataset.tip = 'This account can take over as primary. Use, from a running chat, restarts it on this account';
    head.append(hint);
  }
  head.append(withMenu(block, account));
  block.append(head, ...loginLines(account));
  const limits = accountLimits(account).filter(([, limit]) => limit);
  block.append(...(limits.length ? limits.map(([label, limit]) => limitRow(label, limit)) : [node('span', 'account__detail', 'No reading yet')]));
  return block;
}

function drawOthers() {
  const { others } = accountState;
  const limited = others.filter((other) => other.exhaustedUntil).length;
  $('usage-others').hidden = !others.length;
  $('others-count').textContent = `${others.length - limited} ready${limited ? `, ${limited} at limit` : ''}`;
  $('others').replaceChildren(...others.flatMap((other) => {
    const state = other.exhaustedUntil ? `Until ${resetDay.format(other.exhaustedUntil * 1000)}` : 'Ready';
    return [
      accountName(other, [[other.kind, other.model].filter(Boolean).join(': ')]),
      node('span', '', other.usedToday ? `${state} · ${other.usedToday} today` : state),
      ...accountLimits(other).filter(([, limit]) => limit).map(([label, limit]) => limitRow(label, limit)),
    ];
  }));
}

function drawAccounts() {
  const chat = chats.get(activeId);
  const currentId = chat?.account ?? accountState.primary;
  const current = accountState.accounts.find((account) => account.id === currentId);
  const rest = accountState.accounts.filter((account) => account !== current);
  $('accounts').replaceChildren(...(current ? [accountBlock(current, true, chat)] : []), ...(rest.length ? [node('h3', 'accounts__heading', 'Other Claude accounts')] : []), ...rest.map((account) => accountBlock(account, false, chat)));
  drawOthers();
}

async function useAccount(chat, account) {
  $('usage').hidePopover();
  const result = await deck.switchAccount({ id: chat.id, accountId: account.id, cols: chat.cols, rows: chat.rows });
  chat.error = result.error ?? null;
  if (result.stopped) chat.state = 'error';
  if (result.account) chat.account = result.account;
  render();
  if (!result.error || result.stopped) return;
  setTimeout(() => {
    if (chat.error !== result.error) return;
    chat.error = null;
    render();
  }, 5000);
}

// frugal: readings refresh with each status line, so an idle chat keeps the last one until its next turn.
function drawMeters() {
  const chat = chats.get(activeId);
  const limits = accountState.accounts.find((account) => account.id === chat?.account)?.limits ?? {};
  const fiveHour = liveLimit(limits.fiveHour);
  const sevenDay = liveLimit(limits.sevenDay);
  const context = chat?.context ?? null;
  const tracksTokens = chat?.inputTokens !== null && chat?.inputTokens !== undefined || chat?.outputTokens !== null && chat?.outputTokens !== undefined;
  const tokenText = tracksTokens ? `${compact.format(chat.inputTokens ?? 0)} in, ${compact.format(chat.outputTokens ?? 0)} out` : '';
  const sized = chat?.contextTokens !== null && chat?.contextTokens !== undefined && chat?.contextSize !== null && chat?.contextSize !== undefined;
  drawMeter('meter-context', context, context === null ? '' : `${Math.round(context)}%`);
  $('meter-context').dataset.tip = [sized ? `${compact.format(chat.contextTokens)} of ${compact.format(chat.contextSize)}` : '', tokenText].filter(Boolean).join('\n') || 'Context used by this chat';
  const tokens = $('usage-tokens');
  tokens.hidden = !tracksTokens || context !== null;
  if (!tokens.hidden) tokens.querySelector('.measured').textContent = tokenText;
  const button = $('usage-open');
  button.hidden = !chat?.account && !tracksTokens;
  const worst = Math.max(fiveHour?.pct ?? 0, sevenDay?.pct ?? 0);
  const warning = worst >= WARN_PCT;
  button.classList.toggle('is-warn', warning);
  button.dataset.tip = warning ? 'This account is close to its limit. Open to switch accounts' : 'Usage and accounts';
  button.textContent = warning ? `Limit ${Math.round(worst)}%` : context === null ? 'Usage' : `Context ${Math.round(context)}%`;
  drawAccounts();
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
  if (chat.status === 'replied') setStatus(chat, null);
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
// chat:imagePaste of the Claude Code prompt: Alt+V on Windows, Ctrl+V elsewhere (2.1.287).
const TUI_IMAGE_PASTE = navigator.platform === 'Win32' ? '\x1bv' : '\x16';

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

function startChat(cwd, group) {
  if (cwd) openChat({ id: crypto.randomUUID(), cwd, name: 'New chat', resume: false, group });
}

function resumeSession(session) {
  if (chats.has(session.id)) activate(session.id);
  else openChat({ id: session.id, cwd: session.cwd, name: session.title, resume: true });
}

function addAccount() {
  $('usage').hidePopover();
  ask({
    title: 'Add account',
    text: 'Opens the Claude sign-in in a new tab. The account also joins Frugal as a secondary account.',
    value: '',
    names: accountState.accounts.map((account) => account.name),
    action: 'Sign in',
    run: (name) => openChat({ id: crypto.randomUUID(), cwd: `Sign in to ${name}`, name: `Sign in: ${name}`, login: name }),
  });
}

$('account-add').onclick = addAccount;

async function openChat({ id, cwd, name, resume, group, login, accountId, handoff }) {
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

  const chat = { id, cwd, name, el, term, fit, login, state: 'starting', trustUntil: Date.now() + TRUST_PROMPT_MS, status: null, busy: false, inputAt: 0 };
  chats.set(id, chat);
  activate(id);
  chat.cols = term.cols;
  chat.rows = term.rows;
  term.onData((data) => {
    chat.inputAt = Date.now();
    deck.input(id, data);
  });
  term.onTitleChange((title) => onTitle(chat, title));
  term.attachCustomKeyEventHandler((event) => handleTerminalKey(chat, event));

  const size = { id, cols: term.cols, rows: term.rows };
  const result = await (login ? deck.login({ ...size, name: login, accountId })
    : handoff ? deck.continueIn({ ...size, ...handoff })
    : deck.start({ ...size, cwd, resume, group }));
  if (result.error) {
    chat.state = 'error';
    chat.error = result.error;
  }
  chat.account = result.account;
  render();
  return result;
}

// From this context size on, every turn re-sends enough that a fresh session is worth starting unasked.
const HANDOFF_AUTO_TOKENS = 150000;
const HANDOFF_COUNTDOWN_S = 10;

function stopCountdown(chat) {
  if (!chat.handoff?.timer) return;
  clearInterval(chat.handoff.timer);
  chat.handoff.timer = null;
}

function drawHandoff() {
  const handoff = chats.get(activeId)?.handoff;
  $('handoff').hidden = !handoff;
  if (!handoff) return;
  const text = $('handoff-text');
  if (document.activeElement !== text) text.value = handoff.prompt;
  const size = `Context is ${compact.format(handoff.tokens)} tokens.`;
  $('handoff-status').textContent = handoff.timer ? `${size} A new session starts in ${handoff.left} s.` : size;
  const stop = $('handoff-stop');
  stop.textContent = handoff.timer ? 'Cancel' : 'Dismiss';
  stop.dataset.tip = handoff.timer ? 'Stop the countdown and keep this prompt' : 'Keep working in this session';
}

async function continueHandoff(chat) {
  stopCountdown(chat);
  if (chat.handoff.starting) return;
  chat.handoff.starting = true;
  const { prompt } = chat.handoff;
  const result = await openChat({ id: crypto.randomUUID(), cwd: chat.cwd, name: 'New chat', handoff: { from: chat.id, accountId: chat.account, prompt } });
  // A failed start keeps the prompt, so nothing typed into it is lost.
  if (!result.error) chat.handoff = null;
  else if (chat.handoff) chat.handoff.starting = false;
  render();
}

deck.onHandoff((id, { prompt, tokens }) => {
  const chat = chats.get(id);
  if (!chat) return;
  if (chat.handoff) stopCountdown(chat);
  chat.handoff = { prompt, tokens, left: HANDOFF_COUNTDOWN_S, timer: null };
  // Counts down only while its chat is on screen, so it never opens a tab over another chat.
  if (tokens >= HANDOFF_AUTO_TOKENS) chat.handoff.timer = setInterval(() => {
    if (activeId !== id) return;
    chat.handoff.left -= 1;
    if (chat.handoff.left > 0) drawHandoff();
    else continueHandoff(chat);
  }, 1000);
  drawHandoff();
});

$('handoff-text').addEventListener('focus', () => {
  const chat = chats.get(activeId);
  if (chat?.handoff) stopCountdown(chat);
  drawHandoff();
});
$('handoff-text').addEventListener('input', (event) => {
  const chat = chats.get(activeId);
  if (chat?.handoff) chat.handoff.prompt = event.target.value;
});
$('handoff-stop').onclick = () => {
  const chat = chats.get(activeId);
  if (!chat?.handoff) return;
  if (chat.handoff.timer) stopCountdown(chat);
  else chat.handoff = null;
  drawHandoff();
};
$('handoff-continue').onclick = () => {
  const chat = chats.get(activeId);
  if (chat?.handoff?.prompt.trim()) continueHandoff(chat);
};

// The prompt comes before anything else, so a slower start just shows it and a resumed transcript is never read as one.
const TRUST_PROMPT_MS = 15000;
const alwaysTrusts = () => localStorage.getItem('alwaysTrust') === 'true';

function answerTrustPrompt(chat) {
  if (!chats.has(chat.id) || !alwaysTrusts() || Date.now() > chat.trustUntil) return;
  const buffer = chat.term.buffer.active;
  const lines = Array.from({ length: chat.term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim() ?? '');
  const key = trustPromptKey(lines);
  if (!key || chat.trustSent === key) return;
  chat.trustSent = key;
  deck.input(chat.id, key);
}

const confirmsClose = () => localStorage.getItem('confirmClose') !== 'false';
const setConfirmsClose = (on) => localStorage.setItem('confirmClose', on);

function askToClose(chat) {
  const dialog = $('close-dialog');
  $('close-message').textContent = `Claude is still running in ${chat.name}. Closing this chat stops it.`;
  $('close-skip').checked = false;
  dialog.returnValue = ''; // Esc and the backdrop leave the last value in place.
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'close';
      // Only a confirmed close saves it: cancelling must not silence the next warning.
      if (confirmed && $('close-skip').checked) setConfirmsClose(false);
      resolve(confirmed);
    }, { once: true });
  });
}

async function closeChat(id) {
  const chat = chats.get(id);
  if (!chat) return;
  const live = chat.state === 'starting' || chat.state === 'running';
  if (live && confirmsClose() && !await askToClose(chat)) return;
  if (live) deck.kill(id);
  stopCountdown(chat);
  chat.term.dispose();
  chat.el.remove();
  fadeOut(chat.tab);
  chats.delete(id);
  if (activeId === id) activate([...chats.keys()].pop() ?? null);
  else render();
}

deck.onData((id, data) => {
  const chat = chats.get(id);
  if (!chat) return;
  chat.term.write(data, () => answerTrustPrompt(chat));
  if (chat.state === 'starting') {
    chat.state = 'running';
    render();
  }
});

// Claude Code animates a mark at the head of the terminal title while a turn runs (\u25d0 \u25d1 in 2.1.287, braille in older builds). It rests on \u2733
// when the turn ends and while a permission or question dialog waits, so a stop without the turn's end_turn record means it asks us.
const isBusyTitle = (title) => {
  const mark = /^(\S) /.exec(title)?.[1];
  return Boolean(mark) && mark !== '\u2733' && !/[\p{L}\p{N}]/u.test(mark);
};
// The end_turn record reaches the index a moment after the spinner stops.
const SETTLE_MS = 1500;
// Esc ends a turn without end_turn; a stop this soon after a key is taken as that.
const INTERRUPT_MS = 1000;

const seen = (chat) => chat.id === activeId && document.hasFocus();

function setStatus(chat, status) {
  if (chat.status === status) return;
  chat.status = status;
  drawStatus(chat);
}

function onTitle(chat, title) {
  const busy = isBusyTitle(title);
  if (busy === chat.busy) return;
  chat.busy = busy;
  clearTimeout(chat.settle);
  if (busy) {
    chat.turnEnded = false;
    setStatus(chat, 'working');
    return;
  }
  const interrupted = Date.now() - chat.inputAt < INTERRUPT_MS;
  chat.settle = setTimeout(() => {
    if (chat.turnEnded) setStatus(chat, seen(chat) ? null : 'replied');
    else setStatus(chat, interrupted ? null : 'waiting');
  }, SETTLE_MS);
}

// Before the spinner stops, the stop's timer reads the flag; after it, this replaces the waiting guess.
deck.onTurnEnd((id) => {
  const chat = chats.get(id);
  if (!chat) return;
  chat.turnEnded = true;
  if (!chat.busy && chat.status === 'waiting') setStatus(chat, seen(chat) ? null : 'replied');
});

window.addEventListener('focus', () => {
  const chat = chats.get(activeId);
  if (chat?.status === 'replied') setStatus(chat, null);
});

function resetStatus(chat) {
  clearTimeout(chat.settle);
  chat.busy = false;
  setStatus(chat, null);
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
// A pasted image path turns into [Image #n] in place; other files and folders attach only as @"path", quoted for spaces (test 2).
const attachment = (file) => (IMAGE_FILE.test(file) ? `"${file}"` : `@"${file}"`);

function attach(chat, files) {
  if (!files.length || chat.state !== 'running') return;
  chat.term.paste(`${files.map(attachment).join(' ')} `);
  chat.term.focus();
}

$('attach').onclick = async () => {
  const chat = chats.get(activeId);
  if (chat) attach(chat, await deck.pickFiles());
};

stage.addEventListener('dragover', (event) => {
  if (chats.get(activeId)?.state !== 'running' || !event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

stage.addEventListener('drop', (event) => {
  const chat = chats.get(activeId);
  if (!chat || !event.dataTransfer.files.length) return;
  event.preventDefault();
  attach(chat, [...event.dataTransfer.files].map((file) => deck.pathForFile(file)).filter(Boolean));
});

deck.onExit((id, code) => {
  const chat = chats.get(id);
  if (!chat) return;
  resetStatus(chat);
  chat.state = 'exited';
  chat.exitCode = code;
  render();
  // A finished sign-in closes its tab after "Login successful" shows, and the panel opens on the account; a failed one stays to show why.
  if (chat.login && code === 0) setTimeout(() => {
    if (!chats.has(id)) return;
    closeChat(id);
    $('usage').classList.add('usage--top');
    $('usage').showPopover();
  }, 1500);
});

deck.onMeters((id, meters) => {
  const chat = chats.get(id);
  if (chat) {
    if (meters.context != null) chat.context = meters.context;
    for (const key of ['contextTokens', 'contextSize', 'inputTokens', 'outputTokens']) {
      if (meters[key] != null) chat[key] = meters[key];
    }
  }
  if (chats.has(activeId)) drawMeters();
});

deck.onRestarting((id) => {
  const chat = chats.get(id);
  if (!chat) return;
  chat.term.reset();
  resetStatus(chat);
  chat.state = 'starting';
  chat.trustUntil = Date.now() + TRUST_PROMPT_MS;
  chat.trustSent = null;
  render();
});

function setAccounts(state) {
  accountState = state;
  drawMeters();
}

deck.getAccounts().then(setAccounts);
deck.onAccounts(setAccounts);

let resetClock = 0;

$('usage').addEventListener('toggle', (event) => {
  clearInterval(resetClock);
  if (event.newState === 'closed') {
    chats.get(activeId)?.term.focus();
    return;
  }
  deck.refreshAccounts();
  resetClock = setInterval(() => {
    for (const element of $('usage').querySelectorAll('[data-reset]')) element.textContent = resetLabel(Number(element.dataset.reset));
  }, 30000);
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
let chatsById = new Map();
let groupsDrawn = false;
let drawnSignature = '';
let currentIndex;
const NO_TOPIC = 'No topic';
let sessionView = localStorage.getItem('sessionView') === 'topics' ? 'topics' : 'folders';

function sessionTip(session) {
  const started = session.startedAt && session.startedAt !== session.lastAt ? `Started ${resetExact.format(new Date(session.startedAt))}` : null;
  const prompts = session.turns ? `${session.turns} prompt${session.turns === 1 ? '' : 's'}` : null;
  return [session.title, session.cwd, `Last active ${resetExact.format(new Date(session.lastAt))}`, started, prompts, 'Right-click to organize'].filter(Boolean).join('\n');
}

function sessionButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session';
  button.dataset.session = session.id;
  // The list redraws once a day per session, so the tip is read again from the index on each hover.
  const refreshTip = () => {
    button.dataset.tip = sessionTip(currentIndex?.sessions?.find((s) => s.id === session.id) ?? session);
  };
  refreshTip();
  button.addEventListener('pointerover', refreshTip);
  button.addEventListener('focusin', refreshTip);
  const title = document.createElement('span');
  title.className = 'session__title';
  title.textContent = session.title;
  button.append(title);
  if (session.tags.length) {
    const tags = document.createElement('span');
    tags.className = 'session__tags';
    tags.textContent = session.tags.map((tag) => `#${tag}`).join(' ');
    button.append(tags);
  }
  setRowStatus(button, chats.get(session.id)?.status);
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
  folder.dataset.tip = session.cwd;
  row.append(folder);
  return row;
}

function chatElement(chat, decorate) {
  const row = sessionButton(chat);
  const first = decorate ? decorate(row, chat) : row;
  if (!chat.earlier.length) return first;
  const container = document.createElement('div');
  container.className = 'chat';
  const history = document.createElement('details');
  history.className = 'chat__history';
  const key = `chat:${chat.chatId}`;
  history.open = openGroups.has(key);
  const n = chat.earlier.length;
  const summary = document.createElement('summary');
  summary.className = 'chat__more measured';
  const syncSummary = () => {
    const label = history.open ? 'Hide the earlier sessions of this chat' : `Show ${n} earlier session${n === 1 ? '' : 's'} of this chat`;
    summary.textContent = history.open ? '\u2212' : `+${n}`;
    summary.setAttribute('aria-label', label);
    summary.dataset.tip = label;
  };
  syncSummary();
  history.ontoggle = () => {
    if (history.open) openGroups.add(key);
    else openGroups.delete(key);
    syncSummary();
  };
  history.append(summary, ...chat.earlier.map((session) => sessionButton(session)));
  container.append(first, history);
  return container;
}

function newChatButton(chats, group, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--icon group__new';
  button.append(icon('plus'));
  const text = `New chat in ${label}`;
  button.dataset.tip = text;
  button.setAttribute('aria-label', text);
  button.onclick = (event) => {
    event.preventDefault();
    startChat(chats[0].cwd, group);
  };
  return button;
}

function moreButton(label, items) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--icon group__new';
  button.append(icon('more'));
  const text = `Options for ${label}`;
  button.dataset.tip = text;
  button.setAttribute('aria-label', text);
  button.onclick = (event) => {
    event.preventDefault();
    const { left, bottom } = button.getBoundingClientRect();
    openMenu(left, bottom + 4, items(), button);
  };
  return button;
}

function addMenu(summary, label, items) {
  summary.append(moreButton(label, items));
  summary.oncontextmenu = (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, items());
  };
}

function renameOpenKey(from, to) {
  if (openGroups.delete(from)) openGroups.add(to);
}

function workspaceMenu(name) {
  return [
    { label: 'Rename', run: () => ask({
      title: `Rename ${name}`,
      text: 'Use the name of another workspace to merge them.',
      value: name,
      names: spaceNames.filter((other) => other !== name),
      action: 'Rename',
      run: (to) => {
        if (to === name) return;
        renameOpenKey(`workspace:${name}`, `workspace:${to}`);
        deck.renameWorkspace(name, to);
      },
    }) },
    { label: 'Delete', danger: true, run: () => ask({
      title: `Delete ${name}?`,
      text: 'Its groups and chats stay, outside any workspace.',
      action: 'Delete',
      danger: true,
      run: () => deck.deleteWorkspace(name),
    }) },
  ];
}

const sessionsOfGroup = (key) => currentIndex.sessions.filter((s) => chatsById.get(s.chatId)?.topic === key).map((s) => s.id);

function groupMenu(key, label, byTopic) {
  const move = { label: 'Move to workspace', run: () => openWorkspace(key, label) };
  if (!byTopic) return [move];
  const workspace = currentIndex.workspaces?.[key];
  return [
    { label: 'Rename', run: () => ask({
      title: `Rename ${label}`,
      text: 'Use the name of another group to merge them.',
      value: key,
      names: groupNames.filter((other) => other !== key),
      action: 'Rename',
      run: (to) => {
        if (to === key) return;
        renameOpenKey(key, to);
        deck.renameGroup(sessionsOfGroup(key), key, to);
      },
    }) },
    move,
    { label: 'Delete', danger: true, run: () => ask({
      title: `Delete ${label}?`,
      text: workspace ? `Its chats stay in ${workspace}, without a group.` : 'Its chats stay, outside any group.',
      action: 'Delete',
      danger: true,
      run: () => deck.deleteGroup(sessionsOfGroup(key), key),
    }) },
  ];
}

function groupElement(key, chats, byTopic) {
  const group = document.createElement('details');
  group.className = 'group';
  group.open = openGroups.has(key);
  group.ontoggle = () => (group.open ? openGroups.add(key) : openGroups.delete(key));
  const summary = document.createElement('summary');
  summary.className = 'group__name';
  summary.dataset.tip = key;
  const label = byTopic ? key : folderName(key);
  const name = document.createElement('span');
  name.className = 'group__label';
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'group__count measured';
  count.textContent = chats.length;
  const chevron = icon('chevron');
  chevron.classList.add('group__chevron');
  summary.append(chevron, icon(byTopic ? 'topic' : 'folder'), name, count);
  if (key !== NO_TOPIC) {
    summary.append(newChatButton(chats, byTopic ? key : undefined, label));
    addMenu(summary, label, () => groupMenu(key, label, byTopic));
  }
  group.append(summary, ...chats.map((chat) => chatElement(chat, byTopic ? addFolderLabel : null)));
  return group;
}

function workspaceElement(workspace, byTopic) {
  const key = `workspace:${workspace.name}`;
  const group = document.createElement('details');
  group.className = 'group group--workspace';
  group.open = openGroups.has(key);
  group.ontoggle = () => (group.open ? openGroups.add(key) : openGroups.delete(key));
  const summary = document.createElement('summary');
  summary.className = 'group__name';
  summary.dataset.tip = workspace.name;
  const name = document.createElement('span');
  name.className = 'group__label';
  name.textContent = workspace.name;
  const count = document.createElement('span');
  count.className = 'group__count measured';
  count.textContent = workspace.chats.length + workspace.groups.reduce((total, [, list]) => total + list.length, 0);
  const chevron = icon('chevron');
  chevron.classList.add('group__chevron');
  summary.append(chevron, icon('topic'), name, count);
  addMenu(summary, workspace.name, () => workspaceMenu(workspace.name));
  group.append(
    summary,
    ...workspace.groups.map(([groupKey, list]) => groupElement(groupKey, list, byTopic)),
    ...workspace.chats.map((chat) => chatElement(chat, byTopic ? addFolderLabel : null)),
  );
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
  section.append(heading, ...sessions.map((chat) => chatElement(chat, null)));
  return section;
}

function drawSpaces(sessions, index) {
  const names = [...new Set([...sessions.map((s) => s.space), ...Object.values(index.workspaces ?? {})].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-US'));
  const select = $('space-filter');
  const chosen = names.includes(select.value) ? select.value : '';
  select.replaceChildren(new Option('All workspaces', ''), ...names.map((name) => new Option(name, name)));
  select.value = chosen;
  select.hidden = !names.length;
  spaceNames = names;
}

function drawGroupNames(index) {
  groupNames = [...new Set(index.sessions.map((session) => session.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-US'));
}

let drawnView;
let spaceNames = [];
let groupNames = [];

function renderSessions(index) {
  currentIndex = index;
  const status = indexStatus(index);
  $('index-status').hidden = !status;
  $('index-status').textContent = status;

  // Transcripts change every second during a turn; rebuilding only when the list changes keeps focus and scroll.
  const signature = `${sessionView}\n${index.indexing}\n${$('space-filter').value}\n${index.modelJoins}\n${index.modelWorkspaces}\n${JSON.stringify(index.workspaces ?? {})}\n${index.ambiguous.length}\n${index.sessions.map((s) => `${s.id}\n${s.chatId}\n${s.title}\n${s.cwd}\n${shortDate.format(new Date(s.lastAt))}\n${s.pinned}\n${s.space}\n${s.tags}\n${s.topic}\n${s.userGroup ?? ''}`).join('\n')}`;
  if (signature === drawnSignature) return;
  drawnSignature = signature;
  if (sortDialog.open) drawSortEstimate();

  const allChats = groupChats(index.sessions);
  chatsById.clear();
  for (const chat of allChats) chatsById.set(chat.chatId, chat);

  drawSpaces(allChats, index);
  drawGroupNames(index);
  const byTopic = sessionView === 'topics';
  const keyOf = (chat) => (byTopic ? chat.topic ?? NO_TOPIC : chat.cwd);
  const space = $('space-filter').value;
  const visible = space ? allChats.filter((c) => (c.space ?? index.workspaces?.[keyOf(c)]) === space) : allChats;
  const pinned = visible.filter((c) => c.pinned);
  const tree = buildTree(visible.filter((c) => !c.pinned), keyOf, index.workspaces ?? {});
  tree.groups.sort(([a], [b]) => (a === NO_TOPIC) - (b === NO_TOPIC));
  if (!groupsDrawn && (tree.workspaces.length || tree.groups.length) && !index.indexing) {
    groupsDrawn = true;
    openGroups.add(tree.workspaces.length ? `workspace:${tree.workspaces[0].name}` : tree.groups[0][0]);
  }
  const focused = document.activeElement?.dataset?.session;
  const list = $('groups');
  list.replaceChildren(
    ...(pinned.length ? [pinnedElement(pinned)] : []),
    ...tree.workspaces.map((workspace) => workspaceElement(workspace, byTopic)),
    ...tree.groups.map(([key, chats]) => groupElement(key, chats, byTopic)),
  );
  // Only a change of view fades: the list also rebuilds while transcripts update.
  const view = `${sessionView}\n${space}`;
  if (view !== drawnView) {
    drawnView = view;
    list.classList.remove('fade-in');
    void list.offsetWidth;
    list.classList.add('fade-in');
  }
  markActiveSession();
  if (focused) $('groups').querySelector(`[data-session="${focused}"]`)?.focus();
  render();
}

const palette = $('palette');
const paletteQuery = $('palette-query');
const paletteList = $('palette-list');
let paletteSessions = [];
let paletteRow = 0;
let paletteChoose = null;

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
  paletteChoose(session);
}

function paletteOption(session, index) {
  const row = sessionButton(session);
  row.id = `palette-option-${index}`;
  row.role = 'option';
  row.tabIndex = -1;
  row.onclick = () => chooseFromPalette(session);
  row.dataset.tip = session.title;
  row.oncontextmenu = null;
  return addFolderLabel(row, session);
}

function drawPalette() {
  const matches = matchSessions(paletteSessions, paletteQuery.value);
  paletteList.replaceChildren(...matches.map(paletteOption));
  $('palette-empty').hidden = matches.length > 0;
  selectPaletteRow(matches.length ? 0 : -1);
}

async function showPalette(load, choose, placeholder = 'Search by title or folder') {
  if (palette.open) {
    palette.close();
    return;
  }
  paletteSessions = await load();
  paletteChoose = choose;
  paletteQuery.placeholder = placeholder;
  paletteQuery.value = '';
  palette.showModal();
  drawPalette();
}

async function togglePalette() {
  await showPalette(deck.getAllSessions, resumeSession);
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

function showUndo(text) {
  $('undo-text').textContent = text;
  $('undo-bar').hidden = false;
}

const organize = $('organize');
const workspaceDialog = $('workspace-dialog');
let organizing = null;
let movingGroup = null;

function openOrganize(session) {
  organizing = session;
  $('organize-title').textContent = session.title;
  const chat = chatsById.get(session.chatId) ?? session;
  $('organize-pinned').checked = chat.pinned;
  $('organize-space').value = chat.space ?? '';
  const group = chat.userGroup ?? chat.topic ?? '';
  $('organize-group').value = group;
  $('organize-group').dataset.prefill = group;
  $('organize-tags').value = chat.tags.join(', ');
  $('organize-unlink').hidden = !session.parentId;
  organize.showModal();
}

function openWorkspace(key, label) {
  movingGroup = key;
  $('workspace-title').textContent = label;
  $('workspace-name').value = currentIndex?.workspaces?.[key] ?? '';
  workspaceDialog.showModal();
}

$('organize-form').onsubmit = () => {
  const value = {
    pinned: $('organize-pinned').checked,
    space: $('organize-space').value,
    tags: $('organize-tags').value.split(','),
  };
  const group = $('organize-group').value;
  const groupChanged = group !== $('organize-group').dataset.prefill;
  for (const s of currentIndex.sessions) {
    if (s.chatId === organizing.chatId) {
      deck.organize(s.id, value);
      if (groupChanged) deck.setGroup(s.id, group);
    }
  }
};
$('workspace-form').onsubmit = () => {
  if (movingGroup) deck.setWorkspace(movingGroup, $('workspace-name').value);
};
$('workspace-cancel').onclick = () => workspaceDialog.close();

const menu = $('menu');

// A source inside another popover nests the menu in it, so opening the menu leaves that popover open.
function openMenu(x, y, items, source) {
  if (menu.matches(':popover-open')) menu.hidePopover();
  menu.replaceChildren(...items.map(({ label, run, danger }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu__item';
    item.role = 'menuitem';
    item.toggleAttribute('data-danger', Boolean(danger));
    item.textContent = label;
    item.onclick = () => {
      menu.hidePopover();
      run();
    };
    return item;
  }));
  menu.showPopover({ source });
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 8)}px`;
  menu.firstChild.focus();
}

menu.onkeydown = (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const items = [...menu.children];
  items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
};

const askDialog = $('ask-dialog');
let askRun = null;
let askNames = [];
let askReturn = false;

function ask({ title, text, value = null, names = [], action, danger = false, run }) {
  const input = $('ask-value');
  askReturn = $('usage').matches(':popover-open');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  $('ask-field').hidden = value === null;
  input.disabled = value === null;
  input.value = value ?? '';
  askNames = names;
  askRun = run;
  $('ask-submit').textContent = action;
  $('ask-submit').classList.toggle('btn--danger', danger);
  askDialog.showModal();
  if (value !== null) input.select();
}

$('ask-form').onsubmit = () => askRun($('ask-value').value.trim());
$('ask-cancel').onclick = () => askDialog.close();
// A question asked from the accounts panel returns to it.
askDialog.addEventListener('close', () => {
  if (askReturn && !$('usage').matches(':popover-open')) $('usage').showPopover();
});
// The panel opens under the bar button or over the footer one, whichever was clicked.
$('accounts-open').addEventListener('click', () => $('usage').classList.add('usage--top'));
$('usage-open').addEventListener('click', () => $('usage').classList.remove('usage--top'));

// The native datalist popup cannot be styled, so these fields share the app's list.
function attachCombo(input, names) {
  const list = document.createElement('div');
  list.id = `${input.id}-list`;
  list.className = 'menu combo';
  list.popover = 'manual';
  list.role = 'listbox';
  input.closest('label').after(list);
  input.style.anchorName = `--${list.id}`;
  list.style.positionAnchor = `--${list.id}`;
  input.role = 'combobox';
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  let row = -1;
  const isOpen = () => list.matches(':popover-open');
  const close = () => {
    if (isOpen()) list.hidePopover();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    row = -1;
  };
  const mark = (index) => {
    row = index;
    [...list.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
    if (index < 0) return input.removeAttribute('aria-activedescendant');
    list.children[index].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', list.children[index].id);
  };
  const open = (query) => {
    const matches = names().filter((name) => name.toLowerCase().includes(query));
    list.replaceChildren(...matches.map((name, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.id = `${list.id}-${i}`;
      item.className = 'menu__item';
      item.role = 'option';
      item.tabIndex = -1;
      item.textContent = name;
      item.onmousedown = (event) => event.preventDefault();
      item.onclick = () => {
        input.value = name;
        close();
      };
      return item;
    }));
    if (!matches.length) return close();
    if (!isOpen()) list.showPopover();
    input.setAttribute('aria-expanded', 'true');
    mark(-1);
  };
  input.addEventListener('click', () => (isOpen() ? close() : open('')));
  input.addEventListener('input', () => open(input.value.trim().toLowerCase()));
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !isOpen()) {
      event.preventDefault();
      open('');
    } else if (!isOpen()) {
      return;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = list.children.length;
      mark(event.key === 'ArrowDown' ? (row + 1) % count : (row <= 0 ? count : row) - 1);
    } else if (event.key === 'Enter' && row >= 0) {
      event.preventDefault();
      list.children[row].click();
    }
  });
}

attachCombo($('organize-space'), () => spaceNames);
attachCombo($('organize-group'), () => groupNames);
attachCombo($('workspace-name'), () => spaceNames);
attachCombo($('ask-value'), () => askNames);
$('organize-cancel').onclick = () => organize.close();
$('organize-unlink').onclick = () => {
  organize.close();
  deck.link(organizing.id, null);
  showUndo('Session unlinked.');
};
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
  return {
    model: $('sort-model').value,
    effort: $('sort-effort').value,
    rename: $('sort-rename').checked,
    notes: $('sort-notes').value,
    resort: $('sort-resort').checked,
  };
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
    ? `This uses your Claude account: about ${tokens.toLocaleString('en-US')} tokens for ${sessions.toLocaleString('en-US')} session${sessions === 1 ? '' : 's'}. Only titles, folder names and your notes are sent.`
    : 'Every session already has what you asked for. Nothing to send.';
  const join = await deck.estimateJoins();
  $('join-row').hidden = join.sessions === 0;
  if (join.sessions !== 0) {
    $('join-text').textContent = `${join.sessions} continued session${join.sessions === 1 ? ' has' : 's have'} more than one possible origin. Claude can pick one: about ${join.tokens.toLocaleString('en-US')} tokens, titles and folder names only.`;
  }
  $('join-undo').hidden = !(currentIndex?.modelJoins > 0);
  const workspaces = await deck.estimateWorkspaces();
  $('workspace-row').hidden = workspaces.groups === 0;
  if (workspaces.groups !== 0) {
    $('workspace-text').textContent = `Claude can nest your ${workspaces.groups} groups into workspaces: about ${workspaces.tokens.toLocaleString('en-US')} tokens, group names, folder names, sample titles and your notes only.`;
  }
  $('workspace-undo').hidden = !(currentIndex?.modelWorkspaces > 0);
}

for (const radio of viewRadios) {
  radio.checked = radio.value === sessionView;
  radio.onchange = () => setSessionView(radio.value);
}
$('settings-open').onclick = async () => {
  $('settings-confirm-close').checked = confirmsClose();
  $('settings-always-trust').checked = alwaysTrusts();
  $('settings-roles').checked = await deck.getRoles();
  $('settings-dialog').showModal();
};
$('settings-confirm-close').onchange = (event) => setConfirmsClose(event.target.checked);
$('settings-roles').onchange = (event) => deck.setRoles(event.target.checked);
$('settings-always-trust').onchange = (event) => {
  if (!event.target.checked) {
    localStorage.setItem('alwaysTrust', false);
    return;
  }
  event.target.checked = false; // Stays off until the warning is accepted.
  $('trust-dialog').returnValue = '';
  $('trust-dialog').showModal();
};
$('trust-dialog').onclose = () => {
  if ($('trust-dialog').returnValue !== 'trust') return;
  localStorage.setItem('alwaysTrust', true);
  $('settings-always-trust').checked = true;
};
$('search').onclick = togglePalette;
$('chat-history').onclick = () => {
  const session = currentIndex?.sessions?.find((s) => s.id === activeId);
  if (!session) return;
  showPalette(async () => currentIndex.sessions.filter((s) => s.chatId === session.chatId), resumeSession, 'Search this chat');
};
$('link-chat').onclick = () => {
  const activeSession = currentIndex?.sessions?.find((s) => s.id === activeId);
  if (!activeSession) return;
  const otherChats = async () => groupChats(await deck.getAllSessions()).filter((c) => c.chatId !== activeSession.chatId);
  if (!activeSession.parentId) {
    showPalette(otherChats, linkTo, 'Link to which chat?');
    return;
  }
  const { left, bottom } = $('link-chat').getBoundingClientRect();
  openMenu(left, bottom + 4, [
    { label: 'Move to another chat', run: () => showPalette(otherChats, (target) => {
      deck.link(activeSession.id, target.id);
      showUndo(`Moved to ${target.title}.`);
    }, 'Move to which chat?') },
    { label: 'Unlink from chat', run: () => {
      deck.link(activeSession.id, null);
      showUndo('Session unlinked.');
    } },
  ]);
};
async function linkTo(target) {
  const activeSession = currentIndex?.sessions?.find((s) => s.id === activeId);
  deck.link(activeSession.chatId, target.id);
  showUndo(`Linked to ${target.title}.`);
}
$('sort').onclick = () => {
  sortDialog.showModal();
  drawSortEstimate();
};
$('sort-notes').value = localStorage.getItem('sortNotes') ?? '';
$('sort-notes').oninput = (event) => localStorage.setItem('sortNotes', event.target.value);
$('sort-rename').onchange = drawSortEstimate;
$('sort-resort').onchange = drawSortEstimate;
$('sort-close').onclick = () => sortDialog.close();
$('undo-run').onclick = () => {
  deck.undoLink();
  $('undo-bar').hidden = true;
};
$('undo-close').onclick = () => {
  $('undo-bar').hidden = true;
};
$('sort-restore').onclick = () => {
  deck.restoreTitles();
  sortStatus('Original titles restored.');
};
function lockSortDialog(locked) {
  sorting = locked;
  sortDialog.closedBy = locked ? 'none' : 'any';
  for (const control of sortDialog.querySelector('form').elements) control.disabled = locked;
  $('sort-run').setAttribute('aria-busy', locked);
}

$('sort-run').onclick = async () => {
  lockSortDialog(true);
  sortStatus('Sending the first batch');
  setSessionView('topics');
  const result = await deck.runTopics(sortOptions()).catch((error) => ({ error: error.message }));
  lockSortDialog(false);
  if (result.error) {
    sortStatus(result.error, true);
    drawSortEstimate();
    return;
  }
  sortStatus('');
  sortDialog.close();
};
deck.onTopicsProgress((done, total) => sortStatus(`Sorted ${done} of ${total}`));

$('join-run').onclick = async () => {
  lockSortDialog(true);
  sortStatus('Asking Claude');
  const result = await deck.runJoins(sortOptions()).catch((error) => ({ error: error.message }));
  lockSortDialog(false);
  if (result.error) sortStatus(result.error, true);
  else sortStatus('');
  drawSortEstimate();
};
$('join-undo').onclick = () => {
  deck.clearJoins();
  sortStatus("Claude's joins removed.");
};
$('workspace-run').onclick = async () => {
  lockSortDialog(true);
  sortStatus('Asking Claude');
  const result = await deck.runWorkspaces(sortOptions()).catch((error) => ({ error: error.message }));
  lockSortDialog(false);
  if (result.error) sortStatus(result.error, true);
  else sortStatus('');
  drawSortEstimate();
};
$('workspace-undo').onclick = () => {
  deck.clearWorkspaces();
  sortStatus("Claude's workspaces removed.");
};

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
  maximizeButton.dataset.tip = maximized ? 'Restore the window size' : 'Maximize the window';
  maximizeButton.querySelector('use').setAttribute('href', maximized ? '#i-window-restore' : '#i-window-maximize');
});
deck.onSessions(renderSessions);
deck.getSessions().then(renderSessions);

// One shared popover: it renders in the top layer, so the sidebar and dialogs cannot clip it.
const tooltip = $('tooltip');
const TOOLTIP_DELAY = 400;
const TOOLTIP_GAP = 6;
const TOOLTIP_EDGE = 8;
let tooltipTarget = null;
let tooltipTimer;

function openTooltip() {
  if (!tooltipTarget.isConnected) return;
  tooltip.textContent = tooltipTarget.dataset.tip;
  tooltipTarget.setAttribute('aria-describedby', 'tooltip');
  tooltip.showPopover();
  const anchor = tooltipTarget.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = tooltip;
  const below = anchor.bottom + TOOLTIP_GAP;
  tooltip.style.top = `${below + height > innerHeight - TOOLTIP_EDGE ? anchor.top - height - TOOLTIP_GAP : below}px`;
  tooltip.style.left = `${Math.min(Math.max(TOOLTIP_EDGE, anchor.left + (anchor.width - width) / 2), innerWidth - width - TOOLTIP_EDGE)}px`;
}

function closeTooltip() {
  clearTimeout(tooltipTimer);
  if (tooltip.matches(':popover-open')) tooltip.hidePopover();
}

function aimTooltip(target) {
  if (target === tooltipTarget) return;
  tooltipTarget?.removeAttribute('aria-describedby');
  closeTooltip();
  tooltipTarget = target?.dataset.tip ? target : null;
  if (tooltipTarget) tooltipTimer = setTimeout(openTooltip, TOOLTIP_DELAY);
}

document.addEventListener('pointerover', (event) => aimTooltip(event.target.closest('[data-tip]')));
document.addEventListener('focusin', (event) => {
  if (event.target.matches(':focus-visible')) aimTooltip(event.target.closest('[data-tip]'));
});
document.addEventListener('focusout', () => aimTooltip(null));
document.documentElement.addEventListener('pointerleave', () => aimTooltip(null));
document.addEventListener('pointerdown', closeTooltip, true);
document.addEventListener('keydown', closeTooltip, true);
