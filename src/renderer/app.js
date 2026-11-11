import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { matchSessions } from './palette.mjs';
import { groupChats, buildTree } from './chats.mjs';
import { trustPromptKey } from './trust.mjs';
import { trimSilence, encodeWav, joinChunks } from './voice.mjs';

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
  row.classList.toggle('is-attention', Boolean(chats.get(row.dataset.session)?.attention));
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
// The other tabs then slide from where they were, so a drag shows where the tab lands.
function moveTab(move) {
  const tabs = $('tabs');
  const was = new Map([...tabs.children].map((tab) => [tab, tab.getBoundingClientRect().left]));
  tabs.classList.add('is-sorting');
  move();
  tabs.getBoundingClientRect();
  tabs.classList.remove('is-sorting');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const [tab, left] of was) {
    const dx = left - tab.getBoundingClientRect().left;
    if (dx) tab.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }
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
    // A sliding tab's box is mid-flight, and measuring it would swap the pair back.
    if (tab.getAnimations().length) return;
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
  saveOpenChats();
  // Tabs persist between renders: rebuilding them would replay the fade-in on every state change.
  for (const chat of chats.values()) {
    drawBadge(chat);
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
  button.dataset.tip = [account.email, ...details, 'Click to rename'].filter(Boolean).join('\n');
  button.onclick = () => askRename(account);
  return button;
}

function report(result) {
  if (result?.error) ask({ title: 'Account', text: result.error, action: 'OK', run: () => {} });
}

// Voice: the badge records here, whisper.cpp transcribes in the main process, and the text lands at the cursor unsent.
const VOICE_RATE = 16000;
const voiceMode = () => localStorage.getItem('voiceMode') ?? 'off';
const voiceModel = () => localStorage.getItem('voiceModel') ?? 'medium';
const voiceLanguage = () => localStorage.getItem('voiceLanguage') ?? 'en';
const voiceDevice = () => localStorage.getItem('voiceDevice');
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const sizeText = (bytes) => (bytes >= 1e9 ? `${decimal.format(bytes / 1e9)} GB` : `${decimal.format(bytes / 1e6)} MB`);
const voiceError = (text) => ask({ title: 'Voice', text, action: 'OK', run: () => {} });
let recording = null;
let downloadingFor = null;
// Whether the chosen local model is on disk; null until checked or when local dictation is off.
let voiceReady = null;

async function checkVoice() {
  deck.setVoiceMode(voiceMode());
  const status = voiceMode() === 'local' ? await deck.voiceStatus(voiceModel()) : null;
  voiceReady = status ? !status.error && status.needs === 0 : null;
  for (const chat of chats.values()) drawBadge(chat);
}

function setVoice(chat, label) {
  chat.voice = label;
  drawBadge(chat);
  const mic = chat.editPanel?.querySelector('.prompt-edit__mic');
  if (!mic) return;
  mic.setAttribute('aria-pressed', String(label === 'Listening' && recording?.area?.form === chat.editPanel));
  mic.disabled = Boolean(label) && label !== 'Listening';
}

deck.onVoiceProgress((received, total) => {
  if (downloadingFor) setVoice(downloadingFor, `Downloading ${Math.floor((received / total) * 100)}%`);
});

// Claude Code records while Space is held, and a terminal sends a held key as repeated presses (checked with 2.1.322).
const HOLD_MS = 30;

// Opens the microphone and draws its live spectrum on the chat's voice control while it records.
async function openMic(chat) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: voiceDevice() ? { exact: voiceDevice() } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext({ sampleRate: VOICE_RATE });
  const source = context.createMediaStreamSource(stream);
  // The live spectrum: 128 bins of 62.5 Hz at 16 kHz, and speech lives in the first 64 (up to 4 kHz).
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const wave = chat.mic.querySelector('.term-mic__wave');
  const paint = wave.getContext('2d');
  const BARS = 16;
  const meter = () => {
    paint.clearRect(0, 0, wave.width, wave.height);
    if (recording?.context !== context) return;
    analyser.getByteFrequencyData(bins);
    paint.fillStyle = getComputedStyle(wave).color;
    const slot = wave.width / BARS;
    for (let bar = 0; bar < BARS; bar++) {
      const peak = Math.max(...bins.subarray(bar * 4, bar * 4 + 4));
      const height = Math.max(4, (peak / 255) * wave.height);
      paint.fillRect(bar * slot + 2, (wave.height - height) / 2, slot - 4, height);
    }
    requestAnimationFrame(meter);
  };
  requestAnimationFrame(meter);
  return { stream, context, source };
}

async function holdToTalk(chat) {
  if (!chat.voiceOn) {
    const result = await deck.switchAccount({ id: chat.id, accountId: chat.account, cols: chat.cols, rows: chat.rows, bypass: chat.bypassOn, admin: chat.adminOn });
    if (result.stopped) chat.state = 'error';
    if (result.error) report(result);
    return;
  }
  let mic = {};
  try {
    mic = await openMic(chat);
  } catch {} // Only the spectrum needs it: Claude Code records on its own.
  recording = { chat, stream: mic.stream, context: mic.context, hold: setInterval(() => deck.input(chat.id, ' '), HOLD_MS) };
  setVoice(chat, 'Listening');
}

// Claude Code reads the prompt file back and redraws before it takes the held Space.
const EDIT_SETTLE_MS = 500;

// area: the Ctrl+G panel's text, which takes local dictation in place of the terminal.
async function toggleDictation(chat, area) {
  if (recording) return stopDictation();
  if (chat.voice) return;
  if (voiceMode() === 'anthropic') {
    if (!area) return holdToTalk(chat);
    // Claude Code waits on this editor, so the text goes back to its prompt and the dictation follows it there.
    area.form.requestSubmit();
    return setTimeout(() => holdToTalk(chat), EDIT_SETTLE_MS);
  }
  const model = voiceModel();
  const status = await deck.voiceStatus(model);
  if (status.error) return voiceError(status.error);
  if (status.needs > 0) {
    const what = status.cli ? `the ${model} model` : `whisper.cpp and the ${model} model`;
    if (!await askConfirm('Download voice files?', `Local dictation needs ${what}: ${sizeText(status.needs)}. They download once and stay on this computer.`, 'Download')) return;
    downloadingFor = chat;
    setVoice(chat, 'Downloading');
    const result = await deck.voicePrepare(model);
    downloadingFor = null;
    setVoice(chat, null);
    checkVoice();
    if (result.error) return voiceError(result.error);
  }
  try {
    const { stream, context, source } = await openMic(chat);
    // frugal: ScriptProcessorNode is deprecated; an AudioWorklet module from 'self' is the upgrade.
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    source.connect(processor);
    processor.connect(context.destination);
    recording = { chat, stream, context, chunks, area };
    setVoice(chat, 'Listening');
  } catch (error) {
    voiceError(`The microphone is not available: ${error.message}`);
  }
}

async function stopDictation() {
  const { chat, stream, context, chunks, hold, area } = recording;
  recording = null;
  clearInterval(hold);
  for (const track of stream?.getTracks() ?? []) track.stop();
  await context?.close();
  // Claude Code transcribes once the spaces stop, and types the text into its prompt.
  if (hold) {
    setVoice(chat, null);
    return chat.term.focus();
  }
  const samples = trimSilence(joinChunks(chunks), VOICE_RATE);
  if (!samples.length) {
    setVoice(chat, null);
    return voiceError('No speech was heard.');
  }
  setVoice(chat, 'Transcribing');
  const result = await deck.voiceTranscribe({ audio: encodeWav(samples, VOICE_RATE), model: voiceModel(), language: voiceLanguage() });
  setVoice(chat, null);
  if (result.error) return voiceError(result.error);
  if (!result.text || !chats.has(chat.id)) return;
  if (area?.isConnected) {
    area.focus();
    insertText(area, result.text);
  } else {
    chat.term.paste(result.text);
    chat.term.focus();
  }
}

function showVoiceOptions() {
  for (const row of document.querySelectorAll('.settings__voice')) row.hidden = voiceMode() !== 'local';
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

// What the panel says under a name: that there is no login, and a warning when another account shares it. The email is in the name's tooltip.
function loginLines(account) {
  const lines = account.signedIn ? [] : [node('span', 'account__email', 'Signed out')];
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

function capControl(account, field, label) {
  const value = account.caps?.[field] ?? 100;
  const row = node('label', 'cap');
  const slider = Object.assign(node('input'), { type: 'range', min: 0, max: 100, step: 5, value });
  slider.setAttribute('aria-label', label);
  const number = Object.assign(node('input'), { type: 'number', min: 0, max: 100, step: 5, value });
  number.setAttribute('aria-label', label);
  slider.oninput = () => { number.value = slider.value; };
  number.oninput = () => { slider.value = number.value; };
  slider.onchange = () => { number.value = slider.value; deck.setAccountCap(account.id, field, slider.value); };
  number.onchange = () => { slider.value = number.value; deck.setAccountCap(account.id, field, number.value); };
  row.append(node('span', 'cap__label', label), slider, number);
  return row;
}

const CAPS_NOTE = {
  'not-delegate': 'Frugal does not delegate to this account, so no limit applies.',
  'no-reading': 'This account reports no usage, so no limit can apply.',
};
// Kept across redraws: the panel redraws on every status line.
const openCaps = new Set();

// The delegate limits fold into one line, so they do not crowd the panel.
function capsBlock(account) {
  const box = node('details', 'caps');
  box.open = openCaps.has(account.id);
  box.ontoggle = () => (box.open ? openCaps.add(account.id) : openCaps.delete(account.id));
  const applies = account.capsApply === 'ok';
  const value = applies ? `5h ${account.caps.fiveHour}% · weekly ${account.caps.sevenDay}%` : 'Not available';
  const summary = node('summary', 'caps__summary');
  summary.append(node('span', '', 'Delegate limits'), node('span', 'caps__value', value));
  box.append(summary, ...(applies ? [capControl(account, 'fiveHour', 'Max 5h %'), capControl(account, 'sevenDay', 'Max weekly %')] : [node('span', 'account__detail', CAPS_NOTE[account.capsApply])]));
  return box;
}

// frugal: blocks are redrawn on every status line, so keyboard focus on Use is lost when a reading arrives.
function accountBlock(account, primary, chat, caps) {
  const block = node('section', 'account');
  const head = node('div', 'account__head');
  const age = account.limits?.at ? `Read ${spanText(Date.now() - account.limits.at)} ago` : '';
  head.append(accountName(account, [account.configDir, primary ? '' : age]));
  if (primary) head.append(node('span', 'tag tag--primary', 'Primary'));
  else if (account.signedIn) {
    const running = chat?.account && chat.state === 'running';
    const button = node('button', 'btn', 'Use');
    button.type = 'button';
    button.dataset.tip = running ? 'Restart this chat on this account. New chats use it too' : 'New chats start on this account';
    button.onclick = async () => (running ? useAccount(chat, account) : report(await deck.setPrimary(account.id)));
    head.append(button);
  }
  head.append(withMenu(block, account));
  block.append(head, ...loginLines(account));
  const limits = accountLimits(account).filter(([, limit]) => limit);
  block.append(...(limits.length ? limits.map(([label, limit]) => limitRow(label, limit)) : [node('span', 'account__detail', 'No reading yet')]));
  if (caps) block.append(capsBlock(account));
  return block;
}

function drawOthers() {
  const { others } = accountState;
  const limited = others.filter((other) => other.exhaustedUntil).length;
  $('usage-others').hidden = !others.length;
  $('others-count').textContent = `${others.length - limited} ready${limited ? `, ${limited} at limit` : ''}`;
  $('others').replaceChildren(...others.flatMap((other) => {
    const state = other.exhaustedUntil ? `Until ${resetDay.format(other.exhaustedUntil * 1000)}` : 'Ready';
    const limits = accountLimits(other).filter(([, limit]) => limit).map(([label, limit]) => limitRow(label, limit));
    return [
      accountName(other, [[other.kind, other.model].filter(Boolean).join(': ')]),
      node('span', '', other.usedToday ? `${state} · ${other.usedToday} today` : state),
      ...(limits.length ? limits : [node('span', 'others__none', 'No usage reading')]),
      capsBlock(other),
    ];
  }));
}

function drawAccounts() {
  const chat = chats.get(activeId);
  const top = $('usage').classList.contains('usage--top');
  const currentId = chat?.account ?? accountState.primary;
  const current = accountState.accounts.find((account) => account.id === currentId);
  if (!top) {
    const main = accountState.accounts.find((account) => account.id === accountState.primary) ?? current;
    $('accounts').replaceChildren(...(main ? [accountBlock(main, true, chat)] : []));
    return;
  }
  const rest = accountState.accounts.filter((account) => account !== current);
  $('accounts').replaceChildren(...(current ? [accountBlock(current, true, chat, true)] : []), ...(rest.length ? [node('h3', 'accounts__heading', 'Other Claude accounts')] : []), ...rest.map((account) => accountBlock(account, false, chat, true)));
  drawOthers();
}

async function useAccount(chat, account) {
  $('usage').hidePopover();
  const bypass = chatBypass(chat, null);
  const admin = await confirmAdmin(bypass, chatAdmin(chat, null));
  const result = await deck.switchAccount({ id: chat.id, accountId: account.id, cols: chat.cols, rows: chat.rows, bypass, admin });
  if (!result.error) chat.adminOn = admin;
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
  setAttention(chat, false);
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

// One collapse state for every chat badge, so the readout stays the place for the full picture.
let infoCollapsed = false;
try {
  infoCollapsed = localStorage.getItem('chatInfoCollapsed') === 'true';
} catch {}

function setInfoCollapsed(value) {
  infoCollapsed = value;
  try {
    localStorage.setItem('chatInfoCollapsed', value);
  } catch {}
  for (const chat of chats.values()) drawBadge(chat);
}

// Sits over the top-right corner of the terminal pane and only reads what the status line already sent.
function makeBadge(chat) {
  const badge = node('div', 'term-badge');
  const dot = node('button', 'term-badge__dot');
  dot.type = 'button';
  dot.append(icon('more'));
  dot.dataset.tip = 'Session details. Click to show or hide them';
  const info = node('span', 'term-badge__info');
  const frugal = node('button', 'term-badge__action term-badge__frugal', 'Frugal');
  frugal.type = 'button';
  frugal.dataset.tip = 'Type /frugal:frugal in the prompt, so the next message runs in Frugal mode';
  frugal.onclick = () => {
    chat.term.paste('/frugal:frugal ');
    chat.term.focus();
    chat.frugal = true;
    drawBadge(chat);
  };
  const bypass = node('button', 'term-badge__action term-badge__bypass', 'Bypass permissions');
  bypass.type = 'button';
  bypass.dataset.tip = 'Restart this chat with Claude Code running every tool without asking';
  bypass.onclick = () => toggleBypass(chat);
  const admin = node('button', 'term-badge__action term-badge__admin', 'Administrator');
  admin.type = 'button';
  admin.dataset.tip = 'Restart this chat with Windows administrator rights';
  admin.onclick = () => toggleAdmin(chat);
  badge.append(dot, info, frugal, bypass, admin);
  dot.onclick = () => setInfoCollapsed(!infoCollapsed);
  const mic = node('div', 'term-mic');
  const record = node('button', 'term-mic__record');
  record.type = 'button';
  const wave = node('canvas', 'term-mic__wave');
  wave.width = 128; // Twice the CSS size, so the bars stay sharp on scaled displays.
  wave.height = 40;
  record.append(icon('mic'), wave, node('span', 'term-mic__text'));
  record.onclick = () => (recording?.chat === chat ? stopDictation() : voiceMode() === 'off' ? micMenu(chat) : toggleDictation(chat));
  const more = node('button', 'term-mic__more');
  more.type = 'button';
  more.append(icon('chevron'));
  more.dataset.tip = 'Voice options';
  more.setAttribute('aria-label', 'Voice options');
  more.onclick = () => micMenu(chat);
  mic.append(record, more);
  chat.badge = badge;
  chat.mic = mic;
  chat.el.append(badge, mic);
  drawBadge(chat);
}

async function toggleBypass(chat) {
  if (!chat.bypassOn && !await askBypass()) return;
  if (!chat.bypassOn && chat.adminOn && !await acceptBoth()) return;
  const previous = chat.bypassOn;
  chat.bypassOn = !previous;
  drawBadge(chat);
  const result = await deck.switchAccount({ id: chat.id, accountId: chat.account, cols: chat.cols, rows: chat.rows, bypass: chat.bypassOn, admin: chat.adminOn });
  if (result.error) {
    chat.bypassOn = previous;
    drawBadge(chat);
    report(result);
  }
}

async function toggleAdmin(chat) {
  if (!await askAdmin() || (chat.bypassOn && !await acceptBoth())) return;
  chat.adminOn = true;
  drawBadge(chat);
  const result = await deck.switchAccount({ id: chat.id, accountId: chat.account, cols: chat.cols, rows: chat.rows, bypass: chat.bypassOn, admin: true });
  if (result.error) {
    chat.adminOn = false;
    drawBadge(chat);
    report(result);
  }
}

function drawBadge(chat) {
  if (!chat.badge) return;
  const running = chat.state === 'running' || chat.state === 'starting';
  const parts = [chat.model, chat.effort && `${chat.effort} effort`, chat.context != null && `${Math.round(chat.context)}% ctx`, chat.cost != null && `$${chat.cost.toFixed(2)}`].filter(Boolean);
  const text = parts.join(' · ');
  const info = chat.badge.querySelector('.term-badge__info');
  info.textContent = text;
  info.dataset.tip = `${chat.adminOn ? 'Running as administrator: ' : ''}${chat.bypassOn ? 'Bypass permissions is on: ' : ''}${text || 'Shows the model, effort, context and cost once the chat sends a status line'}`;
  // Once on, here or for every chat, there is nothing left to turn on: the dot's color and tip say it is on.
  chat.badge.querySelector('.term-badge__bypass').hidden = !running || !chat.account || chat.bypassOn === true || bypassOn();
  chat.badge.querySelector('.term-badge__frugal').hidden = !running || !chat.account || chat.frugal === true;
  drawMic(chat, running);
  chat.badge.querySelector('.term-badge__admin').hidden = !running || !chat.account || chat.adminOn === true || adminOn();
  chat.badge.classList.toggle('is-bypass', chat.bypassOn === true);
  chat.badge.classList.toggle('is-admin', chat.adminOn === true);
  chat.badge.classList.toggle('is-collapsed', infoCollapsed);
}

const VOICE_MODES = [['off', 'Voice off'], ['local', 'Local model (whisper.cpp)'], ['anthropic', 'Anthropic (/voice)']];

async function setVoiceMode(choice) {
  if (VOICE_NOTICES[choice] && !await askConfirm(...VOICE_NOTICES[choice])) return false;
  localStorage.setItem('voiceMode', choice);
  showVoiceOptions();
  checkVoice();
  return true;
}

// Opens above the voice control: the voice mode, and for local dictation the microphone to record from.
async function micMenu(chat) {
  const mode = voiceMode();
  const items = [];
  for (const [value, label] of VOICE_MODES) items.push({ label, checked: mode === value, run: () => value !== mode && setVoiceMode(value) });
  if (mode === 'local') {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications');
    items.push({ label: 'Default microphone', checked: !voiceDevice(), run: () => localStorage.removeItem('voiceDevice') });
    inputs.forEach((device, index) => items.push({ label: device.label || `Microphone ${index + 1}`, checked: voiceDevice() === device.deviceId, run: () => localStorage.setItem('voiceDevice', device.deviceId) }));
  }
  items.push({ label: 'Voice settings…', run: () => $('settings-open').click() });
  const box = chat.mic.getBoundingClientRect();
  openMenu(box.right, box.top, items, chat.mic.querySelector('.term-mic__more'));
  menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`;
  menu.style.top = `${Math.max(8, box.top - menu.offsetHeight - 4)}px`;
}

function drawMic(chat, running) {
  const mode = voiceMode();
  const busy = mode === 'off' ? null : chat.voice;
  const state = mode === 'off' ? 'off' : busy === 'Listening' ? 'listening' : busy ? 'busy' : mode === 'local' && voiceReady === false ? 'missing' : 'ready';
  const tip = {
    off: 'Voice input is off. Click to turn it on',
    missing: `Local dictation needs the ${voiceModel()} model. Click to download it, then speak`,
    listening: 'Recording. Click to stop and type what was said into the prompt, unsent',
    busy: `${busy}…`,
    ready: mode === 'local' ? 'Click to record. Click again to stop, and the text lands in the prompt unsent'
      : chat.voiceOn ? 'Click to record on Anthropic servers. Click again to stop, and Claude Code types the text into the prompt'
      : 'Click to restart this chat with Anthropic voice on, then click again to record',
  }[state];
  chat.mic.dataset.state = state;
  chat.mic.hidden = !chat.account;
  chat.mic.toggleAttribute('data-idle', state !== 'listening' && !running);
  const record = chat.mic.querySelector('.term-mic__record');
  record.disabled = state === 'busy' || (state !== 'off' && state !== 'listening' && !running);
  record.querySelector('use').setAttribute('href', state === 'off' ? '#i-mic-off' : '#i-mic');
  record.querySelector('.term-mic__text').textContent = state === 'busy' ? `${busy}…` : '';
  record.dataset.tip = tip;
  record.setAttribute('aria-label', tip);
}

// Output is held while the prompt editor is open, so the terminal keeps its last screen under the panel.
// A Ctrl+G that opens no editor releases it after a moment.
function holdOutput(chat, timeout = 1500) {
  chat.held ??= [];
  clearTimeout(chat.holdTimer);
  chat.holdTimer = timeout ? setTimeout(() => releaseOutput(chat), timeout) : null;
}

function releaseOutput(chat) {
  clearTimeout(chat.holdTimer);
  const held = chat.held;
  chat.held = null;
  if (held?.length) chat.term.write(held.join(''), () => answerTrustPrompt(chat));
}

// Claude Code opens $VISUAL on a Ctrl+G prompt file; the Deck shows it here instead of an OS editor.
// The response stays open until Save ends it, so the panel replaces itself when Claude opens again.
function promptPanel(chat, text) {
  chat.editPanel?.remove();
  chat.editPanel = null;
  const form = node('form', 'prompt-edit');
  form.setAttribute('aria-label', 'Prompt Claude Code asked to edit');
  const area = node('textarea', 'prompt-edit__text');
  area.spellcheck = false;
  area.value = text;
  const files = node('ul', 'prompt-edit__files');
  files.setAttribute('aria-label', 'Attached files');
  const thumbs = new Map();
  const fileItem = (file) => {
    const item = node('li', 'prompt-edit__file');
    item.dataset.tip = file;
    const thumb = node('img', 'prompt-edit__thumb');
    thumb.alt = '';
    if (!thumbs.has(file)) thumbs.set(file, deck.thumbnail(file));
    thumbs.get(file).then((url) => (url ? (thumb.src = url) : thumb.remove()));
    const name = folderName(file);
    const remove = node('button', 'prompt-edit__remove');
    remove.type = 'button';
    remove.append(icon('x'));
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.onclick = () => {
      const mention = mentionOf(file);
      const start = area.value.indexOf(mention);
      if (start < 0) return;
      area.focus();
      area.setSelectionRange(start, start + mention.length + (area.value[start + mention.length] === ' ' ? 1 : 0));
      document.execCommand('delete');
    };
    item.append(thumb, node('span', 'prompt-edit__name', name), remove);
    return item;
  };
  const drawFiles = () => {
    const paths = [...new Set([...area.value.matchAll(MENTION)].map((match) => match[1]))];
    files.hidden = !paths.length;
    files.replaceChildren(...paths.map(fileItem));
  };
  const insertFiles = (paths) => {
    if (!paths.length) return;
    area.focus();
    insertText(area, `${paths.map(mentionOf).join(' ')} `);
  };
  area.addEventListener('input', drawFiles);
  area.addEventListener('paste', async (event) => {
    const list = [...event.clipboardData.files];
    if (!list.length || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    // A screenshot has no path, so the Deck saves it to a file Claude Code can read.
    const paths = await Promise.all(list.map(async (file) => deck.pathForFile(file) || deck.savePasted(new Uint8Array(await file.arrayBuffer()), file.type)));
    insertFiles(paths.filter(Boolean));
  });
  // The panel sits inside the stage, whose own drop would paste the files into the terminal.
  form.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    form.classList.add('is-drop');
  });
  form.addEventListener('dragleave', (event) => {
    if (!form.contains(event.relatedTarget)) form.classList.remove('is-drop');
  });
  form.addEventListener('drop', (event) => {
    form.classList.remove('is-drop');
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    insertFiles([...event.dataTransfer.files].map((file) => deck.pathForFile(file)).filter(Boolean));
  });
  const actions = node('div', 'prompt-edit__actions');
  const mic = node('button', 'btn btn--icon prompt-edit__mic');
  mic.type = 'button';
  mic.append(icon('mic'));
  mic.setAttribute('aria-pressed', 'false');
  const micTip = voiceMode() === 'anthropic' ? 'Save this text to the prompt and dictate there with Anthropic voice' : 'Dictate into this text. Click again to stop';
  mic.dataset.tip = micTip;
  mic.setAttribute('aria-label', micTip);
  // Anthropic voice needs a chat launched with it, and that restart would drop this edit.
  mic.hidden = voiceMode() === 'off' || (voiceMode() === 'anthropic' && !chat.voiceOn);
  mic.onclick = () => toggleDictation(chat, area);
  actions.append(mic);
  const cancel = node('button', 'btn', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.tip = 'Discard the edit and leave the prompt as it was';
  const save = node('button', 'btn btn--primary', 'Save');
  save.type = 'submit';
  save.dataset.tip = 'Save the prompt back to Claude Code';
  actions.append(cancel, save);
  const done = (text) => {
    deck.saveEdit(chat.id, text);
    if (chat.editPanel === form) chat.editPanel = null;
    form.remove();
    releaseOutput(chat);
    if (chat.id === activeId) chat.term.focus();
  };
  cancel.onclick = () => done(null);
  form.onsubmit = (event) => {
    event.preventDefault();
    done(area.value);
  };
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      form.onsubmit(event);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel.click();
    }
  });
  form.append(files, area, actions);
  drawFiles();
  chat.editPanel = form;
  chat.el.append(form);
  area.focus();
}

// Files go into the prompt file as @"path": the [Image #n] swap happens only on a paste into the TUI (test 2).
const MENTION = /@"([^"]+)"/g;
const mentionOf = (file) => `@"${file}"`;

// execCommand keeps the insert on the textarea's own undo stack, so Ctrl+Z takes it back.
function insertText(area, text) {
  if (document.execCommand('insertText', false, text)) return;
  area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
  area.dispatchEvent(new Event('input'));
}

deck.onEdit((id, text) => {
  // A chat the renderer does not hold can never be saved or cancelled by the user.
  const chat = chats.get(id);
  if (!chat) return deck.saveEdit(id, null);
  holdOutput(chat, 0);
  promptPanel(chat, text);
});

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
    linkHandler,
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

  const chat = { id, cwd, name, el, term, fit, login, state: 'starting', trustUntil: null, status: null, busy: false, inputAt: 0 };
  chats.set(id, chat);
  activate(id);
  chat.cols = term.cols;
  chat.rows = term.rows;
  term.onData((data) => {
    chat.inputAt = Date.now();
    if (data === '\x07') holdOutput(chat); // Ctrl+G: Claude Code clears the screen before it opens $VISUAL.
    deck.input(id, data);
  });
  term.onTitleChange((title) => onTitle(chat, title));
  term.attachCustomKeyEventHandler((event) => handleTerminalKey(chat, event));
  makeBadge(chat);

  const size = { id, cols: term.cols, rows: term.rows };
  chat.bypassOn = !login && chatBypass(chat, handoff);
  chat.adminOn = !login && await confirmAdmin(chat.bypassOn, chatAdmin(chat, handoff));
  const result = await (login ? deck.login({ ...size, name: login, accountId })
    : handoff ? deck.continueIn({ ...size, ...handoff, bypass: chat.bypassOn, admin: chat.adminOn })
    : deck.start({ ...size, cwd, resume, group, bypass: chat.bypassOn, admin: chat.adminOn, frugal: !resume && startsWithFrugal() }));
  if (result.error) {
    chat.state = 'error';
    chat.error = result.error;
  }
  chat.account = result.account;
  // A handoff block opens with /frugal, so that chat already runs in Frugal mode.
  chat.frugal = Boolean(handoff) || result.frugal === true;
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

// The prompt comes before anything else, so a resumed transcript later on is never read as one.
const TRUST_PROMPT_MS = 15000;
const alwaysTrusts = () => localStorage.getItem('alwaysTrust') === 'true';

const TRUST_RETRY_MS = 1000;

function answerTrustPrompt(chat) {
  if (!chats.has(chat.id) || !alwaysTrusts()) return;
  // Counted from the first output, so a slow start (UAC, a busy machine) still gets its answer.
  chat.trustUntil ??= Date.now() + TRUST_PROMPT_MS;
  if (Date.now() > chat.trustUntil) return;
  const buffer = chat.term.buffer.active;
  const lines = Array.from({ length: chat.term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim() ?? '');
  const key = trustPromptKey(lines);
  // A key sent before the TUI reads input is lost, so the same answer goes again while the screen still asks.
  if (!key || (chat.trustSent === key && Date.now() - chat.trustSentAt < TRUST_RETRY_MS)) return;
  chat.trustSent = key;
  chat.trustSentAt = Date.now();
  deck.input(chat.id, key);
  setTimeout(() => answerTrustPrompt(chat), TRUST_RETRY_MS);
}

const confirmsClose = () => localStorage.getItem('confirmClose') !== 'false';
const setConfirmsClose = (on) => localStorage.setItem('confirmClose', on);

const bypassOn = () => localStorage.getItem('bypassPermissions') === 'true';
const startsWithFrugal = () => localStorage.getItem('startWithFrugal') === 'true';
const setBypass = (on) => localStorage.setItem('bypassPermissions', on);
const adminOn = () => localStorage.getItem('runAsAdmin') === 'true';
// The Deck's own confirm(): native dialogs never show in this window.
function askConfirm(title, message, ok) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = ok;
  dialog.returnValue = ''; // Esc and the backdrop leave the last value in place.
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

const askBypass = () => askConfirm('Bypass permissions?', 'Claude will run every tool, including shell commands and file edits, without asking for permission.', 'Bypass permissions');
const askAdmin = () => askConfirm('Run as administrator?', "Claude will have Windows administrator permissions and can change system configuration, services, programs, and any user's files. Those changes can leave the machine unstable or insecure. Windows asks for permission for each administrator chat.", 'Run as administrator');
const askBoth = () => askConfirm('Administrator with bypass permissions?', 'Claude can make system-wide changes with no confirmation. A single error can damage Windows or your data irreversibly. You are asked again only after you turn bypass or administrator off in Settings.', 'Start anyway');
// Bypass and administrator together are confirmed once, across restarts, until either setting is turned off.
// Declined, the chat starts without administrator rights.
const BOTH_ACCEPTED = 'adminBypassAccepted';
async function acceptBoth() {
  if (localStorage.getItem(BOTH_ACCEPTED) === 'true') return true;
  const accepted = await askBoth();
  if (accepted) localStorage.setItem(BOTH_ACCEPTED, 'true');
  return accepted;
}
const confirmAdmin = async (bypass, admin) => admin && (!bypass || await acceptBoth());

// Replaces xterm's confirm() for OSC 8 links; only web links leave the Deck.
const linkHandler = {
  allowNonHttpProtocols: false,
  activate: async (_, uri) => {
    if (await askConfirm('Open this link?', uri, 'Open link')) deck.openLink(uri);
  },
};
// One flag per chat: what it was launched with, or what its badge toggle asked for.
const chatBypass = (chat, handoff) => bypassOn() || (handoff ? Boolean(chats.get(handoff.from)?.bypassOn) : Boolean(chat?.bypassOn));
const chatAdmin = (chat, handoff) => adminOn() || (handoff ? Boolean(chats.get(handoff.from)?.adminOn) : Boolean(chat?.adminOn));

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
  sendAttention();
  if (activeId === id) activate([...chats.keys()].pop() ?? null);
  else render();
}

deck.onData((id, data) => {
  const chat = chats.get(id);
  if (!chat) return;
  if (chat.held) chat.held.push(data);
  else chat.term.write(data, () => answerTrustPrompt(chat));
  if (chat.state === 'starting') {
    chat.state = 'running';
    chat.voiceOn = voiceMode() === 'anthropic';
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

let audioContext;
const notifyVolume = () => Number(localStorage.getItem('notifyVolume') ?? 50);

function chime(volume = notifyVolume()) {
  if (!volume) return;
  // Squared so the slider sounds even; 0.8 leaves headroom where the two notes overlap.
  const peak = 0.8 * (volume / 100) ** 2;
  audioContext ??= new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
  const start = audioContext.currentTime;
  for (const [frequency, offset] of [[659.25, 0], [830.61, 0.12]]) {
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(peak, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
    const oscillator = audioContext.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.24);
  }
}

function drawAttention(chat) {
  chat.tab?.classList.toggle('is-attention', Boolean(chat.attention));
  for (const row of $('groups').querySelectorAll(`[data-session="${chat.id}"]`)) row.classList.toggle('is-attention', Boolean(chat.attention));
}

function setAttention(chat, on) {
  if (chat.attention === on) return;
  chat.attention = on;
  drawAttention(chat);
  sendAttention();
}

const sendAttention = () => deck.setAttention([...chats.values()].filter((chat) => chat.attention).length);

function setStatus(chat, status) {
  if (chat.status === status) return;
  const wasWorking = chat.status === 'working';
  chat.status = status;
  if ((status === 'waiting' || status === 'replied') && wasWorking && !seen(chat)) {
    setAttention(chat, true);
    chime();
  }
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
  if (chat) setAttention(chat, false);
  if (chat?.status === 'replied') setStatus(chat, null);
});

function resetStatus(chat) {
  clearTimeout(chat.settle);
  chat.busy = false;
  chat.editPanel?.remove();
  chat.editPanel = null;
  releaseOutput(chat);
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

const SIDEBAR_WIDTH = { min: 220, max: 520, base: 280 };
const resizer = $('sidebar-resize');
resizer.setAttribute('aria-valuemin', SIDEBAR_WIDTH.min);
resizer.setAttribute('aria-valuemax', SIDEBAR_WIDTH.max);

// The terminal refits through the stage's ResizeObserver.
function setSidebarWidth(width) {
  const clamped = Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
  document.documentElement.style.setProperty('--sidebar-width', `${clamped}px`);
  resizer.setAttribute('aria-valuenow', clamped);
  localStorage.setItem('sidebarWidth', clamped);
}

const sidebarWidth = () => document.querySelector('.sidebar').getBoundingClientRect().width;

resizer.onpointerdown = (event) => {
  if (event.button !== 0) return;
  resizer.setPointerCapture(event.pointerId);
  const offset = event.clientX - sidebarWidth();
  resizer.onpointermove = (move) => setSidebarWidth(move.clientX - offset);
  resizer.onlostpointercapture = () => {
    resizer.onpointermove = null;
  };
};
resizer.ondblclick = () => setSidebarWidth(SIDEBAR_WIDTH.base);
resizer.onkeydown = (event) => {
  const width = { ArrowLeft: sidebarWidth() - 16, ArrowRight: sidebarWidth() + 16, Home: SIDEBAR_WIDTH.min, End: SIDEBAR_WIDTH.max }[event.key];
  if (width === undefined) return;
  event.preventDefault();
  setSidebarWidth(width);
};
setSidebarWidth(Number(localStorage.getItem('sidebarWidth')) || SIDEBAR_WIDTH.base);

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
    for (const key of ['contextTokens', 'contextSize', 'inputTokens', 'outputTokens', 'model', 'effort', 'cost']) {
      if (meters[key] != null) chat[key] = meters[key];
    }
    drawBadge(chat);
  }
  if (chats.has(activeId)) drawMeters();
});

deck.onRestarting((id) => {
  const chat = chats.get(id);
  if (!chat) return;
  chat.term.reset();
  resetStatus(chat);
  chat.state = 'starting';
  chat.trustUntil = null;
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
let restored = false;

// Tabs that come back on the next start: sessions only, since a sign-in or a chat with no message yet has nothing to resume.
function saveOpenChats() {
  if (!restored) return; // The first renders run before the saved tabs are back.
  try {
    localStorage.setItem('openChats', JSON.stringify({ ids: [...chats.values()].filter((chat) => !chat.login).map((chat) => chat.id), active: activeId }));
  } catch {}
}

const reopensChats = () => localStorage.getItem('reopenChats') !== 'false';

function restoreChats(index) {
  restored = true;
  let saved = {};
  try {
    if (reopensChats()) saved = JSON.parse(localStorage.getItem('openChats')) ?? {};
  } catch {}
  for (const id of Array.isArray(saved.ids) ? saved.ids : []) {
    const session = index.sessions.find((s) => s.id === id);
    if (session) resumeSession(session);
  }
  if (chats.has(saved.active)) activate(saved.active);
  saveOpenChats();
}
let drawnSignature = '';
let currentIndex;
const NO_TOPIC = 'No topic';
let sessionView = localStorage.getItem('sessionView') === 'topics' ? 'topics' : 'folders';

function readGroupOrder() {
  try {
    const order = JSON.parse(localStorage.getItem('groupOrder'));
    return Array.isArray(order) ? order : [];
  } catch {
    return [];
  }
}

function saveGroupOrder(order) {
  try {
    localStorage.setItem('groupOrder', JSON.stringify(order));
  } catch {
    // Ordering stays for this session only.
  }
}

function orderGroups(tree) {
  const keys = [
    ...tree.workspaces.map((workspace) => `workspace:${workspace.name}`),
    ...tree.workspaces.flatMap((workspace) => workspace.groups.map(([key]) => key)),
    ...tree.groups.map(([key]) => key),
  ];
  const saved = readGroupOrder();
  const missing = keys.filter((key, index) => !saved.includes(key) && keys.indexOf(key) === index);
  if (missing.length) {
    saved.unshift(...missing);
    saveGroupOrder(saved);
  }
  const rank = new Map(saved.map((key, index) => [key, index]));
  const compare = (a, b) => (a === NO_TOPIC) - (b === NO_TOPIC) || rank.get(a) - rank.get(b);
  tree.groups.sort(([a], [b]) => compare(a, b));
  tree.workspaces.sort((a, b) => compare(`workspace:${a.name}`, `workspace:${b.name}`));
  for (const workspace of tree.workspaces) workspace.groups.sort(([a], [b]) => compare(a, b));
}

let draggedGroup = null;
let dropTarget = null;

function clearDropTarget() {
  dropTarget?.classList.remove('is-drop-before', 'is-drop-after');
  dropTarget = null;
}

function moveGroup(from, to, before) {
  if (from === to) return;
  const order = readGroupOrder().filter((key) => key !== from);
  const index = order.indexOf(to);
  if (index === -1) return;
  order.splice(before ? index : index + 1, 0, from);
  saveGroupOrder(order);
  drawnSignature = '';
  renderSessions(currentIndex);
}

function configureGroupDrag(summary, group, key) {
  summary.draggable = true;
  summary.addEventListener('dragstart', (event) => {
    draggedGroup = { key, group };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
    group.classList.add('is-dragging');
  });
  summary.addEventListener('dragend', () => {
    group.classList.remove('is-dragging');
    clearDropTarget();
    draggedGroup = null;
  });
  summary.addEventListener('dragover', (event) => {
    if (!draggedGroup || draggedGroup.group === group || draggedGroup.group.parentElement !== group.parentElement) return;
    event.preventDefault();
    if (dropTarget !== summary) {
      clearDropTarget();
      dropTarget = summary;
    }
    const { top, height } = group.getBoundingClientRect();
    const before = event.clientY < top + height / 2;
    summary.classList.toggle('is-drop-before', before);
    summary.classList.toggle('is-drop-after', !before);
    summary.dataset.dropBefore = String(before);
  });
  summary.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && group.contains(event.relatedTarget)) return;
    if (dropTarget === summary) clearDropTarget();
  });
  summary.addEventListener('drop', (event) => {
    if (!draggedGroup || dropTarget !== summary) return;
    event.preventDefault();
    const before = summary.dataset.dropBefore === 'true';
    const { key: from } = draggedGroup;
    clearDropTarget();
    draggedGroup = null;
    moveGroup(from, key, before);
  });
}

// sessions: how many a chat holds, shown only past one.
function sessionTip(session, sessions) {
  const rows = [
    ['Folder', session.cwd],
    ['Last active', resetExact.format(new Date(session.lastAt))],
    session.startedAt && session.startedAt !== session.lastAt && ['Started', resetExact.format(new Date(session.startedAt))],
    session.turns && ['Prompts', String(session.turns)],
    sessions > 1 && ['Sessions', String(sessions)],
  ].filter(Boolean);
  return { title: session.title, rows, hint: 'Right-click to organize' };
}

const tipText = ({ title, rows, hint }) => [title, ...rows.map(([label, value]) => `${label}: ${value}`), hint].join('\n');

function sessionButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'session';
  button.dataset.session = session.id;
  // The list redraws once a day per session, so the tip is read again from the index on each hover.
  const sessions = session.earlier ? session.earlier.length + 1 : 0;
  const refreshTip = () => {
    button.tipRich = sessionTip(currentIndex?.sessions?.find((s) => s.id === session.id) ?? session, sessions);
    button.dataset.tip = tipText(button.tipRich);
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

// The folder lives in the row's tip, so the title keeps the room up to the sessions button.
function chatElement(chat) {
  const first = sessionButton(chat);
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
  group.append(summary, ...chats.map((chat) => chatElement(chat)));
  configureGroupDrag(summary, group, key);
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
    ...workspace.chats.map((chat) => chatElement(chat)),
  );
  configureGroupDrag(summary, group, key);
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
  section.append(heading, ...sessions.map((chat) => chatElement(chat)));
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
  if (!restored && !index.indexing) restoreChats(index);
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
  orderGroups(tree);
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
  menu.replaceChildren(...items.map(({ label, run, danger, checked }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu__item';
    item.role = checked === undefined ? 'menuitem' : 'menuitemradio';
    if (checked !== undefined) item.ariaChecked = String(checked);
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
$('accounts-open').addEventListener('click', () => {
  $('usage').classList.add('usage--top');
  drawAccounts();
});
$('usage-open').addEventListener('click', () => {
  $('usage').classList.remove('usage--top');
  drawAccounts();
});
$('usage-all').addEventListener('click', () => {
  $('usage').hidePopover();
  $('accounts-open').click();
});

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
  $('settings-bypass').checked = bypassOn();
  $('settings-admin').checked = adminOn();
  $('settings-voice').value = voiceMode();
  $('settings-voice-model').value = voiceModel();
  $('settings-voice-language').value = voiceLanguage();
  showVoiceOptions();
  $('settings-roles').checked = await deck.getRoles();
  $('settings-frugal').checked = startsWithFrugal();
  $('settings-tooltips').value = tooltipPlacement();
  $('settings-reopen').checked = reopensChats();
  $('settings-volume').value = notifyVolume();
  $('settings-volume-value').value = `${notifyVolume()}%`;
  $('settings-dialog').showModal();
};
$('settings-confirm-close').onchange = (event) => setConfirmsClose(event.target.checked);
$('settings-bypass').onchange = async (event) => {
  if (event.target.checked) {
    event.target.checked = false; // Stays off until the warning is accepted.
    if (!await askBypass()) return;
    event.target.checked = true;
  }
  setBypass(event.target.checked);
  if (!event.target.checked) localStorage.removeItem(BOTH_ACCEPTED);
  for (const chat of chats.values()) drawBadge(chat);
};
$('settings-admin').onchange = async (event) => {
  if (event.target.checked) {
    event.target.checked = false; // Stays off until the warning is accepted.
    if (!await askAdmin()) return;
    event.target.checked = true;
  }
  localStorage.setItem('runAsAdmin', event.target.checked);
  if (!event.target.checked) localStorage.removeItem(BOTH_ACCEPTED);
  for (const chat of chats.values()) drawBadge(chat);
};
$('settings-roles').onchange = (event) => deck.setRoles(event.target.checked);
const VOICE_NOTICES = {
  local: ['Use local dictation?', 'Audio stays on this computer. The first dictation downloads whisper.cpp (8.9 MB) and the model you choose. Names and technical terms often come out wrong, so the text lands in the prompt for you to edit and is never sent by itself. Windows dictation (Win+H) needs no download.', 'Use local dictation'],
  anthropic: ['Use Anthropic voice?', 'The microphone button records through Claude Code, which sends your audio to Anthropic servers to transcribe it. Open chats restart once to turn it on. Claude Code sets the dictation language (/config). It uses no tokens, needs a claude.ai account, and does not work with ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set. Windows dictation (Win+H) needs no download.', 'Use Anthropic voice'],
};
$('settings-voice').onchange = async (event) => {
  const choice = event.target.value;
  event.target.value = voiceMode(); // Stays as it was until the notice is accepted.
  if (await setVoiceMode(choice)) event.target.value = choice;
};
$('settings-voice-model').onchange = (event) => {
  localStorage.setItem('voiceModel', event.target.value);
  checkVoice();
};
$('settings-volume').oninput = (event) => ($('settings-volume-value').value = `${event.target.value}%`);
$('settings-volume').onchange = (event) => {
  localStorage.setItem('notifyVolume', event.target.value);
  chime(Number(event.target.value));
};
checkVoice();
$('settings-voice-language').onchange = (event) => localStorage.setItem('voiceLanguage', event.target.value);
$('settings-frugal').onchange = (event) => localStorage.setItem('startWithFrugal', event.target.checked);
$('settings-reopen').onchange = (event) => localStorage.setItem('reopenChats', event.target.checked);
$('settings-tooltips').onchange = (event) => localStorage.setItem('tooltipPlacement', event.target.value);
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
// frugal: the default Windows arrow; a larger or custom cursor can still reach a tip placed below it.
const TOOLTIP_CURSOR = 20;
const tooltipPlacement = () => localStorage.getItem('tooltipPlacement') ?? 'above';
let tooltipTarget = null;
let tooltipPointer = null;
let tooltipTimer;

function openTooltip() {
  if (!tooltipTarget.isConnected) return;
  const rich = tooltipTarget.tipRich;
  tooltip.classList.toggle('tooltip--rich', Boolean(rich));
  if (rich) tooltip.replaceChildren(richTip(rich));
  else tooltip.textContent = tooltipTarget.dataset.tip;
  tooltipTarget.setAttribute('aria-describedby', 'tooltip');
  tooltip.showPopover();
  const anchor = tooltipTarget.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = tooltip;
  // Clear of the cursor, which hangs below its hot spot: above it by default, or below with room for the arrow.
  const pointer = tooltipPointer ?? anchor.top;
  const above = Math.min(anchor.top, pointer) - height - TOOLTIP_GAP;
  const below = Math.max(anchor.bottom, tooltipPointer == null ? 0 : pointer + TOOLTIP_CURSOR) + TOOLTIP_GAP;
  const fitsAbove = above >= TOOLTIP_EDGE;
  const fitsBelow = below + height <= innerHeight - TOOLTIP_EDGE;
  const preferAbove = tooltipPlacement() === 'above';
  tooltip.style.top = `${(preferAbove ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove) ? above : below}px`;
  tooltip.style.left = `${Math.min(Math.max(TOOLTIP_EDGE, anchor.left + (anchor.width - width) / 2), innerWidth - width - TOOLTIP_EDGE)}px`;
}

// A labelled tip: the title, then each label muted beside its value.
function richTip({ title, rows, hint }) {
  const content = document.createDocumentFragment();
  const list = node('dl', 'tooltip__rows');
  for (const [label, value] of rows) list.append(node('dt', null, label), node('dd', null, value));
  content.append(node('strong', 'tooltip__title', title), list, node('p', 'tooltip__hint', hint));
  return content;
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
document.addEventListener('pointermove', (event) => {
  tooltipPointer = event.clientY;
}, { passive: true });
document.addEventListener('focusin', (event) => {
  if (!event.target.matches(':focus-visible')) return;
  tooltipPointer = null; // A keyboard tip sits by its anchor, wherever the mouse rests.
  aimTooltip(event.target.closest('[data-tip]'));
});
document.addEventListener('focusout', () => aimTooltip(null));
document.documentElement.addEventListener('pointerleave', () => aimTooltip(null));
document.addEventListener('pointerdown', closeTooltip, true);
document.addEventListener('keydown', closeTooltip, true);
