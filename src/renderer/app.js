import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { matchSessions } from './palette.mjs';
import { groupChats, buildTree } from './chats.mjs';
import { trustPromptKey } from './trust.mjs';
import { trimSilence, encodeWav, joinChunks } from './voice.mjs';
import { loadLocale, applyI18n, t, tp, languages, currentLanguage } from './i18n.mjs';

await loadLocale();
deck.setLanguage(currentLanguage()).catch((error) => console.warn('i18n:language', error));
applyI18n();

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const settingsDialog = $('settings-dialog');
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

const STATUS_LABEL = { working: t('chat.status.working'), waiting: t('chat.status.waiting'), replied: t('chat.status.replied') };
// Chats in the middle of a turn, highlighted in the tabs while the switch dialog asks about them.
let switchBusy = new Set();

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
  starting: () => t('chat.state.starting'),
  running: () => t('chat.state.running'),
  exited: (chat) => t('chat.state.exited', { code: chat.exitCode }),
  error: () => t('chat.state.failed'),
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
  close.dataset.tip = t('tab.close.tip');
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
      { label: chat.pinned ? t('tab.unpin') : t('tab.pin'), run: () => togglePin(chat) },
      { label: t('common.close'), run: () => closeChat(chat.id) },
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
    chat.name = currentIndex?.sessions?.find((s) => s.id === chat.id)?.title ?? chat.name;
    drawBadge(chat);
    chat.tab ??= $('tabs').appendChild(tabElement(chat));
    const [open, close] = chat.tab.children;
    open.querySelector('.tab__label').textContent = chat.name;
    open.dataset.tip = [chat.pinned ? chat.name : null, chat.cwd, STATUS_LABEL[chat.status]].filter(Boolean).join('\n');
    open.setAttribute('aria-label', chat.name);
    if (chat.id === activeId) open.setAttribute('aria-current', 'true');
    else open.removeAttribute('aria-current');
    chat.tab.classList.toggle('tab--busy', switchBusy.has(chat.id));
    close.setAttribute('aria-label', t('tab.close.label', { name: chat.name }));
  }

  const chat = chats.get(activeId);
  $('empty').hidden = Boolean(chat);
  $('readout').hidden = !chat;
  syncInfoPanel();
  $('notice').hidden = !chat?.error;
  $('notice').textContent = chat?.error ?? '';
  drawHandoff();
  const activeSession = currentIndex?.sessions?.find((s) => s.id === activeId);
  $('link-chat').hidden = !activeSession;
  $('attach').hidden = chat?.state !== 'running';
  $('mcp-servers').disabled = !chat;
  const activeChat = activeSession && chatsById.get(activeSession.chatId);
  const chatCount = activeChat ? activeChat.earlier.length + 1 : 0;
  const historyButton = $('chat-history');
  historyButton.hidden = chatCount < 2;
  const historyLabel = historyButton.querySelector('span');
  if (historyLabel) historyLabel.textContent = chatCount;
  historyButton.dataset.tip = tp('chat.history.tip', chatCount);
  historyButton.setAttribute('aria-label', tp('chat.history.label', chatCount));
  const linked = Boolean(activeSession?.parentId);
  const linkButton = $('link-chat');
  linkButton.classList.toggle('is-linked', linked);
  linkButton.querySelector('span').textContent = linked ? t('chat.link.linked') : t('chat.link.label');
  linkButton.dataset.tip = linked ? t('chat.link.linked-tip') : t('chat.link.tip');
  if (!chat) return;
  $('path').textContent = chat.cwd;
  drawMeters();
}

let accountState = { primary: null, accounts: [], others: [] };
let accountsLoading = null;
let accountsError = '';
const WARN_PCT = 80;
const DAY_MS = 86400000;
const resetDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const failureLabels = {
  causes: { account: t('clean.col.account'), env: t('task.cause.environment'), brief: t('task.cause.brief'), code: t('task.cause.code'), frugal: 'Frugal' },
  limit: (time) => t('usage.limit-until', { time }),
  errors: (time) => t('usage.errors-until', { time }),
  benched: (ready, count) => tp('usage.benched-count', count, { ready }),
};
const benchTime = resetDay;
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
  if (minutes < 60) return tp('time.minutes', minutes);
  if (minutes < 1440) {
    const hours = tp('time.hours', Math.floor(minutes / 60));
    return minutes % 60 ? t('time.hours-minutes', { hours, minutes: tp('time.minutes', minutes % 60) }) : hours;
  }
  return t('time.days-hours', { days: tp('time.days', Math.floor(minutes / 1440)), hours: tp('time.hours', Math.floor((minutes % 1440) / 60)) });
}

function resetLabel(resetsAt) {
  const ms = resetsAt * 1000 - Date.now();
  return t('usage.resets', { time: ms < DAY_MS ? t('usage.reset-in', { duration: spanText(ms) }) : resetDay.format(resetsAt * 1000) });
}

const limitTip = (label, limit) => (limit.resetsAt ? t('usage.reset-time', { label, time: resetExact.format(limit.resetsAt * 1000) }) : t('usage.no-reset', { label }));

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

// The `.empty` pattern for a panel's loading, empty and error states; an error passes retry to get a Retry button.
function emptyState(text, retry) {
  const box = node('div', 'empty');
  box.append(node('p', '', text));
  if (retry) {
    const button = node('button', 'btn', t('common.retry'));
    button.type = 'button';
    button.onclick = retry;
    box.append(button);
  }
  return box;
}

function usageMeter(label, limit) {
  const meter = Object.assign(node('meter'), { min: 0, max: 100, low: 60, high: 80, optimum: 0, value: limit.pct });
  meter.setAttribute('aria-label', t('usage.meter.used', { label }));
  return meter;
}

function askRename(account) {
  ask({
    title: t('account.rename.title'),
    text: t('account.rename.hint'),
    value: account.name,
    action: t('common.rename'),
    run: (name) => deck.renameAccount(account.id, name),
  });
}

function accountName(account, details) {
  const button = node('button', 'btn is-linked account__name', account.name);
  button.type = 'button';
  button.dataset.tip = [account.email, ...details, t('account.rename.tip')].filter(Boolean).join('\n');
  button.onclick = () => askRename(account);
  return button;
}

function report(result) {
  if (result?.error) ask({ title: t('clean.col.account'), text: result.error, action: t('common.close'), run: () => {} });
}

// Voice: the badge records here, whisper.cpp transcribes in the main process, and the text lands at the cursor unsent.
const VOICE_RATE = 16000;
const voiceMode = () => localStorage.getItem('voiceMode') ?? 'off';
const voiceModel = () => localStorage.getItem('voiceModel') ?? 'medium';
const voiceLanguage = () => localStorage.getItem('voiceLanguage') ?? 'en';
const voiceDevice = () => localStorage.getItem('voiceDevice');
// Answered from Settings, so WebView2 never shows its own permission prompt.
const allowsMic = () => localStorage.getItem('allowMic') !== 'false';
const allowsClipboard = () => localStorage.getItem('allowClipboard') !== 'false';
const applyPermissions = () => deck.setPermissions(allowsMic(), allowsClipboard());
applyPermissions();
// tokens.css derives every accent shade from --accent-hue, so a new hue repaints the app at once; terminals keep their own copy.
const ACCENTS = [
  [t('settings.appearance.accent.rose'), 12.5],
  [t('settings.appearance.accent.red'), 35],
  [t('settings.appearance.accent.orange'), 57.5],
  [t('settings.appearance.accent.yellow'), 80],
  [t('settings.appearance.accent.lime'), 102.5],
  [t('settings.appearance.accent.chartreuse'), 125],
  [t('settings.appearance.accent.green'), 147.5],
  [t('settings.appearance.accent.emerald'), 170],
  [t('settings.appearance.accent.teal'), 192.5],
  [t('settings.appearance.accent.cyan'), 215],
  [t('settings.appearance.accent.sky'), 237.5],
  [t('settings.appearance.accent.blue'), 260],
  [t('settings.appearance.accent.indigo'), 282.5],
  [t('settings.appearance.accent.violet'), 305],
  [t('settings.appearance.accent.magenta'), 327.5],
  [t('settings.appearance.accent.pink'), 350],
];
const accentHue = () => ACCENTS.find(([, hue]) => String(hue) === localStorage.getItem('accentHue'))?.[1] ?? 80;
const applyAccent = () => {
  document.documentElement.style.setProperty('--accent-hue', accentHue());
  for (const chat of chats.values()) chat.term.options.theme = { ...chat.term.options.theme, selectionBackground: token('--color-accent-soft') };
};
applyAccent();
const decimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const sizeText = (bytes, unit = 1000) => (bytes >= unit ** 3 ? t('voice.size-gb', { size: decimal.format(bytes / unit ** 3) }) : t('voice.size-mb', { size: decimal.format(bytes / unit ** 2) }));
const voiceError = (text) => ask({ title: t('settings.voice.title'), text, action: t('common.close'), run: () => {} });
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

function setVoice(chat, state, percent) {
  chat.voice = state;
  chat.voicePercent = percent;
  drawBadge(chat);
  const mic = chat.editPanel?.querySelector('.prompt-edit__mic');
  if (!mic) return;
  mic.setAttribute('aria-pressed', String(state === 'listening' && recording?.area?.form === chat.editPanel));
  mic.disabled = Boolean(state) && state !== 'listening';
}

deck.onVoiceProgress((received, total) => {
  if (downloadingFor) setVoice(downloadingFor, 'downloading', Math.floor((received / total) * 100));
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
    if (result.error) chat.error = result.error;
    if (result.stopped || result.error) render();
    if (result.error && !result.stopped) setTimeout(() => {
      if (chat.error !== result.error) return;
      chat.error = null;
      render();
    }, 5000);
    return;
  }
  let mic = {};
  try {
    mic = await openMic(chat);
  } catch {} // Only the spectrum needs it: Claude Code records on its own.
  recording = { chat, stream: mic.stream, context: mic.context, hold: setInterval(() => deck.input(chat.id, ' '), HOLD_MS) };
  setVoice(chat, 'listening');
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
    const size = sizeText(status.needs);
    const message = status.cli
      ? t('voice.download.model', { model, size })
      : t('voice.download.files', { model, size });
    if (!await askConfirm(t('voice.download.title'), message, t('voice.download.action'))) return;
    downloadingFor = chat;
    setVoice(chat, 'downloading');
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
    setVoice(chat, 'listening');
  } catch (error) {
    voiceError(t('voice.mic-unavailable', { error: error.message }));
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
    return voiceError(t('voice.no-speech'));
  }
  setVoice(chat, 'transcribing');
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
  if (settingsDialog.open) settingsDialog.close();
  openChat({ id: crypto.randomUUID(), cwd: t('account.sign-in.folder', { name: account.name }), name: t('account.sign-in.title', { name: account.name }), login: account.name, accountId: account.id });
}

async function confirmAccountAction(title, message, action, run) {
  const usage = $('usage');
  const reopen = usage.matches(':popover-open');
  const confirmed = await askConfirm(title, message, action, true);
  if (reopen) usage.showPopover();
  if (confirmed) report(await run());
}

// Free OpenCode models and Gemini's API key have no sign-in.
const delegateSignsIn = (account) => account.kind !== 'gemini' && !(account.kind === 'opencode' && /[-:]free$/.test(account.model ?? ''));

// Claude accounts sign in, sign out and delete their config folder; delegates sign in again when logged out and are removed from frugal.
function accountMenu(account, opener) {
  const items = [{ label: t('account.rename.menu'), run: () => askRename(account) }];
  if ('kind' in account) {
    if (!account.signedIn && delegateSignsIn(account)) items.push({ label: t('account.steps.sign-in'), run: () => signInDelegate(account) });
    if (account.capsApply === 'ok') items.push({ label: t('account.limits.menu'), run: () => askLimits(account, opener) });
    items.push({ separator: true }, { label: t('account.remove.action'), danger: true, run: () => confirmAccountAction(
      t('account.remove.title', { name: account.name }),
      t('account.remove.text'),
      t('account.remove.action'),
      () => removeDelegate(account),
    ) });
    return items;
  }
  if (account.signedIn === false) items.push({ label: t('account.steps.sign-in'), run: () => signIn(account) });
  else if (account.signedIn) items.push({ label: t('account.sign-out.action'), run: () => confirmAccountAction(
    t('account.sign-out.title', { name: account.name }),
    t(account.id === 'main' ? 'account.sign-out.main' : 'account.sign-out.text'),
    t('account.sign-out.action'),
    () => deck.logout(account.id),
  ) });
  if (account.capsApply === 'ok') items.push({ label: t('account.limits.menu'), run: () => askLimits(account, opener) });
  if (account.configDir && account.id !== 'main') items.push({ separator: true }, { label: t('account.delete.action'), danger: true, run: () => confirmAccountAction(
    t('account.delete.title', { name: account.name }),
    t('account.delete.text', { folder: account.configDir }),
    t('account.delete.action'),
    () => deck.removeAccount(account.id),
  ) });
  return items;
}

// The menu opens from the more button or a right-click anywhere on the account, over the panel, which stays open.
function withMenu(target, account) {
  const button = moreButton(account.name, () => accountMenu(account, button));
  button.classList.replace('group__new', 'account__more');
  button.dataset.account = account.id;
  target.oncontextmenu = (event) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, accountMenu(account, button), target);
  };
  return button;
}

// What the panel says under a name: that there is no login, and a warning when another account shares it. The email is in the name's tooltip.
function loginLines(account) {
  const lines = account.signedIn ? [] : [node('span', 'account__email', t('account.signed-out'))];
  if (account.sameLogin.length) lines.push(node('span', 'account__detail is-warn', t('account.same-sign-in', { names: account.sameLogin.join(', ') })));
  return lines;
}

const accountLimits = (account) => [
  [t('usage.five-hour'), liveLimit(account.limits?.fiveHour), t('account.meter.five-hour')],
  [t('usage.weekly'), liveLimit(account.limits?.sevenDay), t('account.meter.weekly')],
];

// One limit as a label, its reset and percent on a line, with a full-width bar under them.
function limitRow(label, limit) {
  const row = node('div', 'limit');
  row.dataset.tip = limitTip(label, limit);
  const used = node('span', 'limit__pct', t('common.percent', { percent: Math.round(limit.pct) }));
  used.classList.toggle('is-warn', limit.pct >= WARN_PCT);
  row.append(node('span', 'limit__label', label), resetNode('span', 'limit__reset', limit), used, usageMeter(label, limit));
  return row;
}

// One limit inside an account row: a short label, a bar and the percent; the full label and the reset are in its tooltip.
function limitMeter(label, limit, short) {
  const box = node('span', 'meter', short);
  box.dataset.tip = limitTip(label, limit);
  const used = node('span', 'measured', t('common.percent', { percent: Math.round(limit.pct) }));
  used.classList.toggle('is-warn', limit.pct >= WARN_PCT);
  box.append(usageMeter(label, limit), used);
  return box;
}

// The slider and the number mirror each other; the Limits dialog saves the number.
function capControl(account, field, label) {
  const value = account.caps?.[field] ?? 100;
  const row = node('label', 'cap');
  const slider = Object.assign(node('input'), { type: 'range', min: 0, max: 100, step: 5, value });
  slider.setAttribute('aria-label', label);
  const number = Object.assign(node('input'), { type: 'number', min: 0, max: 100, step: 5, value, name: field, required: true });
  number.setAttribute('aria-label', label);
  slider.oninput = () => { number.value = slider.value; };
  number.oninput = () => { slider.value = number.value; };
  row.append(node('span', 'cap__label', label), slider, number);
  return row;
}

const limitsDialog = $('limits-dialog');
let limitsFor = null;

function askLimits(account, opener) {
  limitsFor = { account, opener, reopen: $('usage').matches(':popover-open') };
  $('limits-title').textContent = t('account.limits.title', { name: account.name });
  $('limits-error').textContent = '';
  $('limits-caps').replaceChildren(capControl(account, 'fiveHour', t('usage.max-five-hour')), capControl(account, 'sevenDay', t('usage.max-weekly')));
  limitsDialog.showModal();
}

$('limits-form').onsubmit = async (event) => {
  event.preventDefault();
  const { account } = limitsFor;
  const { fiveHour, sevenDay } = event.target.elements;
  const caps = { fiveHour: Number(fiveHour.value), sevenDay: Number(sevenDay.value) };
  const save = $('limits-save');
  save.disabled = true;
  save.setAttribute('aria-busy', 'true');
  try {
    for (const [field, value] of Object.entries(caps)) await deck.setAccountCap(account.id, field, value);
    limitsDialog.close();
    const text = t('account.limits.saved', { name: account.name });
    if (settingsDialog.open) showStatus('accounts-status', text);
    else showUndo(text, () => { for (const field of Object.keys(caps)) deck.setAccountCap(account.id, field, account.caps?.[field] ?? 100); });
  } catch (error) {
    $('limits-error').textContent = t('account.limits.error', { error });
  } finally {
    save.disabled = false;
    save.removeAttribute('aria-busy');
  }
};
$('limits-cancel').onclick = () => limitsDialog.close();
// The panel redraws on every status line, so focus goes back to the same account's More button if the first one is gone.
limitsDialog.addEventListener('close', () => {
  const { account, opener, reopen } = limitsFor;
  if (reopen && !$('usage').matches(':popover-open')) $('usage').showPopover();
  const panel = settingsDialog.open ? $('settings-accounts') : $('usage');
  (opener.isConnected ? opener : panel.querySelector(`.account__more[data-account="${CSS.escape(account.id)}"]`))?.focus();
});

function useButton(account) {
  const button = node('button', 'btn', t('account.use'));
  button.type = 'button';
  button.dataset.tip = switchable(account).length ? t('account.use.restart-tip') : t('account.use.new-tip');
  button.onclick = () => useAccount(account);
  return button;
}

// frugal: blocks are redrawn on every status line, so keyboard focus on Use is lost when a reading arrives.
function accountBlock(account, featured) {
  const block = node('section', 'account');
  const head = node('div', 'row');
  const main = node('div', 'row__main');
  const controls = node('div', 'row__controls');
  const age = account.limits?.at ? t('account.read-ago', { duration: spanText(Date.now() - account.limits.at) }) : '';
  main.append(accountName(account, [account.configDir, featured ? '' : age]));
  if (account.id === accountState.primary) controls.append(node('span', 'tag tag--primary', t('account.primary')));
  if (account.signedIn && (!featured || switchable(account).length)) controls.append(useButton(account));
  controls.append(withMenu(block, account));
  head.append(main, controls);
  block.append(head, ...loginLines(account));
  const limits = accountLimits(account).filter(([, limit]) => limit);
  if (limits.length) block.append(...limits.map(([label, limit]) => limitRow(label, limit)));
  else if (!accountsLoading && !accountsError) {
    const message = account.signedIn
      ? t('account.no-reading.signed-in')
      : t('account.no-reading.signed-out');
    block.append(node('p', 'empty account__detail', message));
  }
  return block;
}

function delegateSummary(delegates) {
  const benched = delegates.filter((delegate) => delegate.exhaustedUntil);
  const ready = tp('usage.ready-count', delegates.length - benched.length);
  return benched.some((delegate) => delegate.benchReason === 'errors')
    ? failureLabels.benched(ready, benched.length)
    : benched.length ? tp('usage.at-limit-count', benched.length, { ready }) : ready;
}

function delegateState(other) {
  let state = t('account.steps.ready');
  if (other.exhaustedUntil) {
    const until = other.exhaustedUntil * 1000;
    const reason = other.benchReason;
    state = reason === 'limit' || reason === 'errors'
      ? failureLabels[reason](benchTime.format(until))
      : t('usage.until', { time: resetDay.format(until) });
  }
  return other.usedToday ? tp('usage.used-today', other.usedToday, { state }) : state;
}

// The muted line under a Claude account: no sign-in, a shared sign-in, today's delegated work, or a missing reading.
function claudeNotes(account) {
  const notes = account.signedIn ? [] : [t('account.signed-out')];
  if (account.sameLogin.length) notes.push(node('span', 'is-warn', t('account.same-sign-in', { names: account.sameLogin.join(', ') })));
  if (account.usedToday) notes.push(tp('account.delegated-today', account.usedToday));
  if (!accountLimits(account).some(([, limit]) => limit) && !accountsLoading && !accountsError) {
    notes.push(t(account.signedIn ? 'account.no-reading.signed-in' : 'account.no-reading.signed-out'));
  }
  return notes;
}

// Settings shows one row per account: its name, a muted line on its state, its live limits and its actions.
function accountRow(account, claude, featured) {
  const row = node('div', 'row account-row');
  const main = node('div', 'row__main');
  const controls = node('div', 'row__controls');
  const age = account.limits?.at ? t('account.read-ago', { duration: spanText(Date.now() - account.limits.at) }) : '';
  main.append(accountName(account, [claude ? account.configDir : account.model, age]));
  const notes = claude ? claudeNotes(account) : account.signedIn ? [delegateState(account)] : [t('account.signed-out')];
  if (notes.length) {
    const meta = node('span', 'row__meta');
    meta.append(...notes.flatMap((note, index) => (index ? [' · ', note] : [note])));
    main.append(meta);
  }
  for (const [label, limit, short] of accountLimits(account)) if (limit) controls.append(limitMeter(label, limit, short));
  if (account.id === accountState.primary) controls.append(node('span', 'tag tag--primary', t('account.primary')));
  if (claude && account.signedIn && (!featured || switchable(account).length)) controls.append(useButton(account));
  controls.append(withMenu(row, account));
  row.append(main, controls);
  return row;
}

// Settings lists accounts by kind in this order; the keys match the kind radios in the Add account dialog.
const ACCOUNT_KINDS = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok'], ['antigravity', 'Antigravity'], ['gemini', 'Gemini'], ['opencode', t('account.kind.opencode')]]);
const kindName = (kind) => ACCOUNT_KINDS.get(kind) ?? kind;

function kindSection(kind, rows) {
  const section = node('section', 'account-kind');
  const head = node('div', 'account-kind__head');
  const title = node('h4', 'account-kind__title', kindName(kind));
  title.id = `settings-kind-${kind}`;
  section.setAttribute('aria-labelledby', title.id);
  head.append(title);
  if (ACCOUNT_KINDS.has(kind)) {
    const label = t('settings.accounts.add-kind', { kind: kindName(kind) });
    const add = node('button', 'btn btn--icon');
    add.type = 'button';
    add.dataset.tip = label;
    add.setAttribute('aria-label', label);
    add.append(icon('plus'));
    add.onclick = () => addAccount(kind);
    head.append(add);
  }
  section.append(head, ...rows);
  return section;
}

function drawState(panel, status, failed) {
  panel.querySelector('[role="status"]').textContent = status;
  panel.hidden = !status;
  panel.querySelector('button').hidden = !failed;
}

function drawAccountStatus(panel, empty) {
  drawState(panel, accountsLoading ? t('account.loading') : accountsError || empty, Boolean(accountsError));
}

function drawAccounts() {
  const { accounts, primary, others } = accountState;
  const main = accounts.find((account) => account.id === primary);
  const currentId = chats.get(activeId)?.account;
  const current = accounts.find((account) => account.id === currentId) ?? main;
  drawAccountStatus($('accounts-state'), current ? '' : t('account.empty-chat'));
  $('accounts').replaceChildren(...(current ? [accountBlock(current, true)] : []));
  $('usage-delegates').hidden = !others.length;
  $('usage-delegate-count').textContent = others.length ? delegateSummary(others) : '';

  if (!settingsDialog.open || $('settings-accounts').closest('.settings__section').hidden) return;
  drawAccountStatus($('settings-accounts-state'), accounts.length ? '' : t('account.empty'));
  const ordered = main ? [main, ...accounts.filter((account) => account !== main)] : accounts;
  const kinds = new Set([...ACCOUNT_KINDS.keys(), ...others.map((other) => other.kind)]);
  $('settings-accounts').replaceChildren(...[...kinds].flatMap((kind) => {
    const list = kind === 'claude' ? ordered : others.filter((other) => other.kind === kind);
    return list.length ? [kindSection(kind, list.map((account) => accountRow(account, kind === 'claude', account === main)))] : [];
  }));
  drawOrder();
}

// The delegation order loads with the Accounts section; a move or a mode change saves at once, then reloads it.
const delegationOrder = { list: null, error: '' };

async function loadOrder() {
  if (!delegationOrder.list || delegationOrder.error) {
    delegationOrder.error = '';
    drawOrder();
  }
  try { delegationOrder.list = await deck.accountsOrder(); } catch (error) { delegationOrder.error = String(error); }
  drawOrder();
}

async function setOrder(mode, ids) {
  try { await deck.setAccountsOrder(mode, ids); } catch (error) {
    delegationOrder.error = String(error);
    return drawOrder();
  }
  loadOrder();
}

// The primary account is not a delegate: the list hides it, and saves append it last so the stored order stays complete.
function delegateOrder() {
  const list = delegationOrder.list ?? [];
  const primary = list.filter((entry) => entry.id === accountState.primary);
  return [list.filter((entry) => entry.id !== accountState.primary), primary];
}

function moveOrder(index, step) {
  const [list, primary] = delegateOrder();
  [list[index], list[index + step]] = [list[index + step], list[index]];
  delegationOrder.list = [...list, ...primary];
  drawOrder();
  setOrder('custom', delegationOrder.list.map((entry) => entry.id));
}

function orderRow(entry, index, count, custom) {
  const name = accountLabel(entry.id);
  const row = node('li', 'row');
  const main = node('span', 'row__main');
  main.append(node('span', 'row__name', name));
  const stats = entry.tries
    ? t('settings.accounts.order.stats', { ok: entry.ok, tries: entry.tries, rate: Math.round((entry.rate ?? 0) * 100) })
    : t('settings.accounts.order.no-tasks');
  row.append(node('span', 'order__pos', String(index + 1)), main, node('span', 'row__meta', kindName(entry.kind)), node('span', 'row__meta', stats));
  if (!custom) return row;
  const controls = node('span', 'row__controls');
  for (const [step, dir] of [[-1, 'up'], [1, 'down']]) {
    const label = t(`settings.accounts.order.move-${dir}`, { name });
    const button = node('button', `btn btn--icon order__${dir}`);
    button.type = 'button';
    button.dataset.move = `${entry.id}:${dir}`;
    button.dataset.tip = label;
    button.setAttribute('aria-label', label);
    button.append(icon('chevron'));
    button.disabled = index + step < 0 || index + step >= count;
    button.onclick = () => moveOrder(index, step);
    controls.append(button);
  }
  row.append(controls);
  return row;
}

// A redraw keeps keyboard focus on the same move button, or its sibling once the row reaches an end.
function drawOrder() {
  const { list, error } = delegationOrder;
  const [shown] = delegateOrder();
  const mode = list?.[0]?.mode === 'custom' ? 'custom' : 'recommended';
  drawState($('settings-order-state'), error || (!list ? t('common.loading') : shown.length ? '' : t('settings.accounts.order.empty')), Boolean(error));
  for (const radio of document.getElementsByName('order-mode')) {
    radio.checked = radio.value === mode;
    radio.disabled = Boolean(error) || !shown.length;
  }
  $('settings-order-hint').textContent = t(`settings.accounts.order.${mode}-hint`);
  $('settings-order-hint').hidden = Boolean(error) || !shown.length;
  const box = $('settings-order');
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.move : null;
  box.replaceChildren(...(error || !list ? [] : shown.map((entry, index) => orderRow(entry, index, shown.length, mode === 'custom'))));
  if (!focused) return;
  const button = box.querySelector(`[data-move="${CSS.escape(focused)}"]`);
  (button?.disabled ? button.parentElement.querySelector('button:not(:disabled)') : button)?.focus();
}

for (const radio of document.getElementsByName('order-mode')) radio.onchange = () => setOrder(radio.value, delegateOrder().flat().map((entry) => entry.id));
$('settings-order-state').querySelector('button').onclick = loadOrder;

// Open chats on another account; login chats keep theirs.
const restartable = () => [...chats.values()].filter((chat) => !chat.login && chat.account && chat.state === 'running');
const switchable = (account) => restartable().filter((chat) => chat.account !== account.id);
const isWorking = (chat) => chat.status === 'working' || chat.status === 'waiting';
// A delegate runs inside its chat's frugal server, so a restart ends it with no result: a chat waiting on one is busy too.
async function busyChats(open) {
  const delegating = new Set((await deck.allTasks()).filter((task) => task.running).map((task) => task.chat));
  return open.filter((chat) => isWorking(chat) || delegating.has(chat.id));
}

// Switching accounts moves every open chat with --resume. Busy chats (working, or waiting for an answer) lose their
// turn, so the dialog lists them: switch all, switch only the idle ones (busy ones stay on their account), or cancel.
async function useAccount(account) {
  $('usage').hidePopover();
  const open = switchable(account);
  const busy = await busyChats(open);
  let moving = open;
  if (busy.length) {
    const name = account.email || account.id;
    const choice = await askBusy(busy, busy.length < open.length, {
      title: t('account.switch.title', { name }),
      message: t('account.switch.message', { name }),
      cancel: t('account.switch.cancel-tip'),
      idle: [t('account.switch.idle'), t('account.switch.idle-tip')],
      all: [t('account.switch.all'), t('account.switch.all-tip')],
    });
    if (choice !== 'all' && choice !== 'idle') return;
    if (choice === 'idle') {
      moving = open.filter((chat) => !busy.includes(chat));
      const labels = busy.map((chat) => chat.name).join(', ');
      deck.activityAdd('states', `Busy chats stayed on their account: ${labels}`);
    }
  }
  if (!moving.length) return report(await deck.setPrimary(account.id));
  for (const chat of moving) await switchChat(chat, account, busy.includes(chat));
}

// Busy chats lose their turn on a restart, so they are listed: restart all, only the idle ones, or cancel.
function askBusy(busy, someIdle, text) {
  const dialog = $('switch-dialog');
  $('switch-title').textContent = text.title;
  $('switch-message').textContent = tp('dialog.busy.message', busy.length, { message: text.message });
  $('switch-cancel').dataset.tip = text.cancel;
  [$('switch-idle').textContent, $('switch-idle').dataset.tip] = text.idle;
  [$('switch-all').textContent, $('switch-all').dataset.tip] = text.all;
  $('switch-list').replaceChildren(...busy.map((chat) => {
    const item = node('button', 'row row--interactive');
    item.type = 'button';
    const main = node('span', 'row__main');
    main.append(node('span', 'row__name', chat.name));
    const controls = node('span', 'row__controls');
    controls.append(node('span', 'row__meta', isWorking(chat) ? STATUS_LABEL[chat.status] : t('task.waiting')));
    item.append(main, controls);
    item.onclick = () => activate(chat.id);
    return item;
  }));
  $('switch-idle').hidden = !someIdle;
  switchBusy = new Set(busy.map((chat) => chat.id));
  render();
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.onclose = () => {
      switchBusy = new Set();
      render();
      resolve(dialog.returnValue);
    };
  });
}

// restart: the user chose to stop this chat's turn, or to restart it on its own account.
async function switchChat(chat, account, restart = false) {
  const bypass = chatBypass(chat, null);
  const admin = await confirmAdmin(bypass, chatAdmin(chat, null));
  const result = await deck.switchAccount({ id: chat.id, accountId: account.id, cols: chat.cols, rows: chat.rows, bypass, admin, restart });
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
  const tokenText = tracksTokens ? t('usage.tokens.in-out', { input: compact.format(chat.inputTokens ?? 0), output: compact.format(chat.outputTokens ?? 0) }) : '';
  const sized = chat?.contextTokens !== null && chat?.contextTokens !== undefined && chat?.contextSize !== null && chat?.contextSize !== undefined;
  drawMeter('meter-context', context, context === null ? '' : t('common.percent', { percent: Math.round(context) }));
  $('meter-context').dataset.tip = [sized ? t('usage.context.of', { used: compact.format(chat.contextTokens), total: compact.format(chat.contextSize) }) : '', tokenText].filter(Boolean).join('\n') || t('usage.context.tip');
  const tokens = $('usage-tokens');
  tokens.hidden = !tracksTokens || context !== null;
  if (!tokens.hidden) tokens.querySelector('.measured').textContent = tokenText;
  const button = $('usage-open');
  button.hidden = !chat?.account && !tracksTokens;
  const worst = Math.max(fiveHour?.pct ?? 0, sevenDay?.pct ?? 0);
  const warning = worst >= WARN_PCT;
  button.classList.toggle('is-warn', warning);
  button.dataset.tip = warning ? t('usage.limit-warning.tip') : t('usage.open.tip');
  button.textContent = warning ? t('usage.limit-percent', { percent: Math.round(worst) }) : context === null ? t('usage.label') : t('usage.context-percent', { percent: Math.round(context) });
  drawAccounts();
}

function markActiveSession() {
  for (const button of $('groups').querySelectorAll('[data-session]')) {
    if (button.dataset.session === activeId) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
}

function activate(id) {
  deck.debugLog('ui', `activate ${id}`);
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

let infoPanelOpen = false;
try {
  infoPanelOpen = localStorage.getItem('infoPanel') === 'open';
} catch {}
let infoElapsedClock = 0;
let infoAgentsClock = 0;
let infoChatId = null;
let infoGeneration = 0;

function elapsed(chat) {
  if (!chat.startedAt) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - chat.startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function drawInfo(chat) {
  if (!infoPanelOpen || !chat || chat.id !== activeId) return;
  const account = [...accountState.accounts, ...accountState.others].find((entry) => entry.id === chat.account);
  const context = [chat.context != null ? t('common.percent', { percent: Math.round(chat.context) }) : '', chat.contextTokens != null && chat.contextSize != null ? t('usage.context.ratio', { used: compact.format(chat.contextTokens), total: compact.format(chat.contextSize) }) : ''].filter(Boolean).join(' \u00b7 ');
  const tokens = chat.inputTokens != null || chat.outputTokens != null ? t('info.tokens.in-out', { input: compact.format(chat.inputTokens ?? 0), output: compact.format(chat.outputTokens ?? 0) }) : '';
  const title = chat.title?.replace(/^[^\p{L}\p{N}\s] /u, ''); // Without the spinner mark (isBusyTitle).
  const rows = [
    [t('info.task'), [chat.name, title !== chat.name && title].filter(Boolean).join('\n')],
    [t('info.state'), STATE_LABEL[chat.state](chat)],
    [t('info.session'), chat.id],
    [t('clean.col.account'), account?.name ?? chat.account],
    [t('account.model.label'), chat.model],
    [t('sort.effort.label'), chat.effort],
    [t('info.elapsed'), elapsed(chat), 'info-elapsed'],
    [t('usage.context.label'), context],
    [t('info.tokens'), tokens],
    [t('info.cost'), chat.cost > 0 ? t('common.cost-usd', { amount: chat.cost.toFixed(2) }) : ''],  // Claude Code may report 0 for a chat it did not price
  ];
  $('info-details').replaceChildren(...rows.filter(([, value]) => value != null && value !== '').map(([label, value, id]) => {
    const row = node('div', 'info-panel__row');
    const detail = node('dd', '', value);
    if (id) detail.id = id;
    row.append(node('dt', '', label), detail);
    return row;
  }));
}

const TASK_STATUS = { running: t('chat.state.running'), done: t('info.done.label'), failed: t('info.failed.label'), cancelled: t('info.cancelled.label'), 'not delegated': t('task.not-delegated') };

// Accounts go by the name the usage panel shows; a run job with no account ran its command here, with no model.
const accountLabel = (id) => [...accountState.accounts, ...accountState.others].find((account) => account.id === id)?.name ?? id.replace(/^oc-/, '');
// Local: subagents of the chat and run jobs that ran here. A delegate job's account is logged only when it ends, so its kind marks it while it runs.
const isLocal = (task) => !task.account && (!task.kind || task.kind === 'run');
const taskAccount = (task) => (task.account ? accountLabel(task.account) : task.kind === 'run' ? t('info.local.label') : '');
const taskSpan = (seconds) => (seconds == null ? '' : seconds < 60 ? tp('time.seconds', seconds) : spanText(seconds * 1000));
// A run job's command names it, without the cd, export and set steps around it.
const commandTitle = (check) => check.split(/;|&&/).map((part) => part.trim()).filter((part) => part && !/^(set|export|cd|taskkill)\b|^\w+=/.test(part)).join(' && ') || check;

const isFailed = (task) => task.status === 'failed' || task.status === 'not delegated';
// An edit whose check failed with no error, or the same way twice: the check or the brief was wrong, the changes stay in the tree.
const checkFailed = (task) => task.status === 'failed' && task.kind === 'edit' && task.cause === 'brief';
const taskStatus = (task) => (checkFailed(task) ? t('task.check-failed') : TASK_STATUS[task.status] ?? task.status);
const TASK_CAUSES = ['account', 'env', 'brief', 'code', 'frugal'];
const taskState = (task) => (task.running ? 'running' : isFailed(task) ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'done');
const TASK_MARK = { failed: 'x', cancelled: 'more', done: 'replied' };
const TASK_RANK = { running: 0, failed: 1, cancelled: 2, done: 2 };

function taskCauseChip(cause) {
  return TASK_CAUSES.includes(cause) ? node('span', 'tag tag--cause', failureLabels.causes[cause]) : null;
}

// Every failed try, from frugal 0.28.6 on; a job with no end logged was marked failed after 35 minutes.
function whyFailed(task) {
  if (!isFailed(task)) return '';
  const tries = task.failures ?? [];
  if (!tries.length) return task.result ? '' : t('task.no-end');
  const details = node('span', '', checkFailed(task) ? t('task.why-check-failed') : t('task.why-failed'));
  for (const f of tries) {
    details.append('\n- ');
    const cause = taskCauseChip(f.cause);
    if (cause) details.append(cause, ' ');
    const account = accountLabel(f.account);
    details.append(t('task.failure-detail', {
      account: f.model ? t('task.account-model', { account, model: f.model }) : account,
      duration: taskSpan(f.seconds), code: f.exit, reason: f.reason,
    }));
  }
  return details;
}

function taskRow(task) {
  // A button only so the details tooltip is reachable by keyboard; it has no click action.
  const local = isLocal(task);
  const row = node('button', `row row--interactive info-panel__task${local ? ' is-local' : ''}`);
  row.type = 'button';
  const state = taskState(task);
  const mark = node('span', `info-panel__status is-${state}`);
  mark.append(state === 'running' ? statusIcon('working') : icon(TASK_MARK[state]));
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', TASK_STATUS[state]);
  mark.dataset.tip = TASK_STATUS[state];
  row.append(mark);
  const account = taskAccount(task);
  if (local) row.append(node('span', 'tag tag--cause', t('info.local.label')));
  else if (account) row.append(node('span', 'row__meta row__meta--path', account));
  const title = task.check ? commandTitle(task.check) : task.description || task.name;
  const seconds = task.running ? Math.round((Date.now() - task.updatedAt) / 1000) : task.seconds;
  row.append(node('span', 'row__name', title), node('span', 'row__meta', taskSpan(seconds)));
  const cost = task.cost != null && t('common.cost-usd', { amount: task.cost.toFixed(2) });
  const tokens = task.tokens && tp('task.tokens', task.tokens, { count: compact.format(task.tokens) });
  const chat = task.chat && currentIndex?.sessions?.find((s) => s.id === task.chat)?.title;
  const label = (name, value) => (value ? t('common.label-value', { label: name, value }) : '');
  const details = [
    task.check ? label(t('task.command'), task.check) : label(t('info.task'), task.description),
    label(t('clean.col.status'), taskStatus(task)),
    whyFailed(task),
    label(t('mcp.add.type.label'), task.kind),
    label(t('task.level'), task.level),
    label(t('clean.col.account'), task.kind === 'run' && !task.account ? t('task.ran-here') : taskAccount(task)),
    label(t('account.model.label'), task.model),
    label(t('task.time'), taskSpan(task.seconds)),
    label(t('task.spend'), [tokens, cost].filter(Boolean).join(', ')),
    label(t('task.chat'), chat),
    label(t('task.when'), task.updatedAt && new Date(task.updatedAt).toLocaleString()),
    task.result ? `\n${task.result}` : '',
  ].filter(Boolean);
  const tip = node('span');
  details.forEach((detail, index) => {
    if (index) tip.append('\n');
    tip.append(detail);
  });
  row.dataset.tip = tip.textContent;
  row.tipContent = tip;
  return row;
}

// Delegate jobs and subagents of the active chat: running ones, then the last 20 that ended, failed before done and cancelled, newest first.
// Delegated rows first, then the chat's own (local) ones, LOCAL_SHOWN of them until expanded.
const LOCAL_SHOWN = 5;
let infoTasks = [];
let infoLocalExpanded = false;
function drawSubagents(tasks) {
  infoTasks = tasks;
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  const shown = [...tasks.filter((task) => task.running), ...tasks.filter((task) => !task.running).slice(0, 20)]
    .sort((a, b) => TASK_RANK[taskState(a)] - TASK_RANK[taskState(b)]);
  const local = shown.filter(isLocal);
  $('info-subagents').hidden = !shown.length;
  $('info-tasks-list').replaceChildren(...shown.filter((task) => !isLocal(task)).map(taskRow), ...local.slice(0, infoLocalExpanded ? local.length : LOCAL_SHOWN).map(taskRow));
  const more = $('info-tasks-more');
  more.hidden = local.length <= LOCAL_SHOWN;
  more.textContent = infoLocalExpanded ? t('sidebar.show-less') : tp('info.tasks.more', local.length - LOCAL_SHOWN);
  more.setAttribute('aria-expanded', String(infoLocalExpanded));
}
$('info-tasks-more').onclick = () => {
  infoLocalExpanded = !infoLocalExpanded;
  drawSubagents(infoTasks);
};

function procRow(chat, proc) {
  const row = node('div', 'row');
  row.dataset.tip = proc.cmd || proc.name;
  row.dataset.process = `${proc.pid}:${proc.started_ms}`;
  const main = node('div', 'row__main');
  const name = node('span', 'row__name', proc.name);
  name.append(' ', node('span', 'info-panel__muted', t('info.procs.pid', { pid: proc.pid })));
  main.append(name);
  const usage = [t('info.procs.cpu', { percent: Math.round(proc.cpu_pct) }), sizeText(proc.ram_bytes, 1024)];
  if (proc.gpu_pct != null) usage.push(t('info.procs.gpu', { percent: Math.round(proc.gpu_pct) }));
  const controls = node('div', 'row__controls');
  controls.append(node('span', 'row__meta', usage.join(' · ')));
  if (!proc.is_chat && !/^claude\.exe$/i.test(proc.name) && proc.started_ms) {
    const end = node('button', 'btn btn--icon');
    end.type = 'button';
    end.append(icon('x'));
    end.setAttribute('aria-label', t('info.procs.end.action'));
    end.dataset.tip = t('info.procs.end.action');
    end.onclick = () => endProcess(chat, proc);
    controls.append(end);
  }
  row.append(main, controls);
  return row;
}
const SHELL = /^(bash|sh|cmd|powershell|pwsh)\.exe$/i;
const CLAUDE = /^claude(\.exe)?$/i;
// What tool calls started: shells and all under them. Kept: the chat, Claude, conhost, MCP servers (what Claude starts that is not a shell) and all under those, delegated work included.
function backgroundProcs(processes) {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const underMcp = (proc) => {
    for (const seen = new Set(); proc && !seen.has(proc.pid); proc = byPid.get(proc.ppid)) {
      seen.add(proc.pid);
      // The chat's root counts as Claude: an npm install runs it as node.exe.
      const parent = byPid.get(proc.ppid);
      if (!SHELL.test(proc.name) && parent && (parent.is_chat || CLAUDE.test(parent.name))) return true;
    }
    return false;
  };
  return processes.filter((proc) => !proc.is_chat && !CLAUDE.test(proc.name) && !/^conhost\.exe$/i.test(proc.name) && !underMcp(proc));
}
function drawProcs(chat, { processes, totals }) {
  const background = backgroundProcs(processes);
  const end = $('info-procs-end');
  end.disabled = !background.length || end.getAttribute('aria-busy') === 'true';
  if (background.length) delete end.dataset.tip;
  else end.dataset.tip = t('info.procs.background.none');
  end.onclick = () => endBackground(chat, background);
  const list = $('info-procs-list');
  const summary = [processes.length, t('info.procs.cpu', { percent: Math.round(totals.cpu_pct) }), sizeText(totals.ram_bytes, 1024)];
  if (totals.gpu_pct != null) summary.push(t('info.procs.gpu', { percent: Math.round(totals.gpu_pct) }));
  $('info-procs-count').textContent = summary.join(' · ');
  const focused = document.activeElement?.closest('[data-process]')?.dataset.process;
  const rows = processes.sort((a, b) => b.ram_bytes - a.ram_bytes).map((proc) => procRow(chat, proc));
  list.replaceChildren(...(rows.length ? rows : [emptyState(t('info.procs.empty'))]));
  if (focused) (rows.find((row) => row.dataset.process === focused)?.querySelector('button') ?? $('info-procs').firstElementChild).focus();
}

let procsPolling;
let procsFailed = false;
const procsVisible = (generation) => generation === infoGeneration && !$('info-panel').hidden && $('info-procs').open;
async function refreshProcs(chat, generation) {
  if (!procsVisible(generation) || procsPolling === generation) return;
  if (chat.state === 'exited' || chat.state === 'error') {
    drawProcs(chat, { processes: [], totals: { cpu_pct: 0, ram_bytes: 0 } });
    return;
  }
  if (procsFailed) return;
  const list = $('info-procs-list');
  if (!list.childElementCount) list.replaceChildren(emptyState(t('common.loading')));
  if (chat.state === 'starting') return;
  procsPolling = generation;
  try {
    const data = await deck.processes(chat.id);
    if (procsVisible(generation) && !$('confirm-dialog').open) drawProcs(chat, data);
  } catch (error) {
    if (!procsVisible(generation) || $('confirm-dialog').open) return;
    procsFailed = true;
    $('info-procs-end').disabled = true;
    $('info-procs-count').textContent = '';
    list.replaceChildren(emptyState(t('info.procs.error', { error }), () => {
      procsFailed = false;
      list.replaceChildren();
      refreshProcs(chat, generation);
    }));
  } finally {
    if (procsPolling === generation) procsPolling = undefined;
  }
}
async function endProcess(chat, proc) {
  const text = t('info.procs.end.text', { name: proc.name, pid: proc.pid });
  if (await askConfirm(t('info.procs.end.title', { name: proc.name }), text, t('info.procs.end.action'), true)) endProcesses(chat, [proc]);
}
async function endBackground(chat, procs) {
  const text = tp('info.procs.background.text', procs.length);
  if (!await askConfirm(t('info.procs.background.title'), text, t('info.procs.background.confirm'), true)) return;
  const end = $('info-procs-end');
  end.disabled = true;
  end.setAttribute('aria-busy', 'true');
  await endProcesses(chat, procs, true);
  end.removeAttribute('aria-busy');
}
// The kill refuses the chat's root and rechecks each pid and start time, so a reused pid is never ended.
async function endProcesses(chat, procs, report = false) {
  const generation = infoGeneration;
  let failure = '';
  let ended = 0;
  for (const proc of procs) {
    try {
      await deck.processKill(chat.id, proc.pid, proc.started_ms);
      ended++;
    } catch (error) {
      failure ||= t('info.procs.end.failed', { name: proc.name, error });
    }
  }
  if (infoChatId === chat.id && generation === infoGeneration) {
    showStatus('info-procs-status', failure || (report ? tp('info.procs.background.done', ended) : ''), Boolean(failure));
    refreshProcs(chat, generation);
  }
}
$('info-procs').ontoggle = () => {
  const chat = chats.get(infoChatId);
  if (chat) refreshProcs(chat, infoGeneration);
};

function syncInfoPanel() {
  const chat = chats.get(activeId);
  const open = infoPanelOpen && Boolean(chat);
  $('info-panel').hidden = !open;
  $('info-resize').hidden = !open;
  const label = open ? t('info.hide') : t('info.show');
  $('info-toggle').dataset.tip = label;
  $('info-toggle').setAttribute('aria-label', label);
  $('info-toggle').setAttribute('aria-expanded', String(open));
  if (open) drawInfo(chat);
  const id = open ? chat.id : null;
  if (infoChatId === id) return;
  infoChatId = id;
  const generation = ++infoGeneration;
  clearInterval(infoElapsedClock);
  clearInterval(infoAgentsClock);
  infoLocalExpanded = false;
  drawSubagents([]);
  procsFailed = false;
  $('info-procs-end').disabled = true;
  $('info-procs-list').replaceChildren();
  $('info-procs-count').textContent = '';
  showStatus('info-procs-status', '');
  if (!open) return;
  infoElapsedClock = setInterval(() => {
    const detail = $('info-elapsed');
    if (detail) detail.textContent = elapsed(chat);
  }, 1000);
  let polling = false;
  const refresh = async () => {
    refreshProcs(chat, generation);
    if (polling) return;
    polling = true;
    try {
      const agents = await deck.subagents(chat.id, chat.cwd);
      if (generation === infoGeneration) drawSubagents(agents);
    } catch {
      if (generation === infoGeneration) drawSubagents([]);
    } finally {
      polling = false;
    }
  };
  refresh();
  infoAgentsClock = setInterval(refresh, 3000);
}

$('info-toggle').onclick = () => {
  infoPanelOpen = !infoPanelOpen;
  try {
    localStorage.setItem('infoPanel', infoPanelOpen ? 'open' : 'closed');
  } catch {}
  syncInfoPanel();
};
syncInfoPanel();

// Sits over the top-right corner of the terminal pane and only reads what the status line already sent.
function makeBadge(chat) {
  const badge = node('div', 'term-badge');
  const dot = node('button', 'term-badge__dot');
  dot.type = 'button';
  dot.append(icon('more'));
  dot.dataset.tip = t('badge.details.tip');
  const info = node('span', 'term-badge__info');
  const frugal = node('button', 'term-badge__action term-badge__frugal', 'Frugal');
  frugal.type = 'button';
  frugal.dataset.tip = t('badge.frugal.tip');
  frugal.onclick = () => {
    chat.term.paste('/frugal:frugal ');
    chat.term.focus();
    chat.frugal = true;
    drawBadge(chat);
  };
  const bypass = node('button', 'term-badge__action term-badge__bypass', t('badge.bypass.label'));
  bypass.type = 'button';
  bypass.dataset.tip = t('badge.bypass.tip');
  bypass.onclick = () => toggleBypass(chat);
  const admin = node('button', 'term-badge__action term-badge__admin', t('badge.admin.label'));
  admin.type = 'button';
  admin.dataset.tip = t('badge.admin.tip');
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
  more.dataset.tip = t('voice.options');
  more.setAttribute('aria-label', t('voice.options'));
  more.onclick = () => micMenu(chat);
  mic.append(record, more);
  const dock = node('div', 'term-dock');
  const dockButton = (name, tip, run, extra = '') => {
    const button = node('button', `term-dock__btn ${extra}`.trim());
    button.type = 'button';
    button.append(icon(name));
    button.dataset.tip = tip;
    button.setAttribute('aria-label', tip);
    button.onclick = () => {
      run();
      chat.term.focus();
    };
    return button;
  };
  const edit = dockButton('edit', t('prompt.edit.tip'), () => {
    holdOutput(chat);
    deck.input(chat.id, '\x07');
  }, 'term-dock__edit');
  const send = dockButton('send', t('prompt.send.tip'), () => deck.input(chat.id, '\r'), 'term-dock__send');
  dock.append(edit, send, mic);
  chat.badge = badge;
  chat.mic = mic;
  chat.dock = dock;
  chat.el.append(badge, dock);
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
    chat.error = result.error;
    render();
    if (result.stopped) return;
    setTimeout(() => {
      if (chat.error !== result.error) return;
      chat.error = null;
      render();
    }, 5000);
  }
}

async function toggleAdmin(chat) {
  if (!await askAdmin() || (chat.bypassOn && !await acceptBoth())) return;
  chat.adminOn = true;
  drawBadge(chat);
  const result = await deck.switchAccount({ id: chat.id, accountId: chat.account, cols: chat.cols, rows: chat.rows, bypass: chat.bypassOn, admin: true });
  if (result.error) {
    chat.adminOn = false;
    chat.error = result.error;
    render();
    if (result.stopped) return;
    setTimeout(() => {
      if (chat.error !== result.error) return;
      chat.error = null;
      render();
    }, 5000);
  }
}

function drawBadge(chat) {
  drawInfo(chat);
  if (!chat.badge) return;
  const running = chat.state === 'running' || chat.state === 'starting';
  const parts = [chat.model, chat.effort && t('badge.effort', { effort: chat.effort }), chat.context != null && t('badge.context', { percent: Math.round(chat.context) }), chat.cost > 0 && t('common.cost-usd', { amount: chat.cost.toFixed(2) })].filter(Boolean);
  const text = parts.join(' · ');
  const info = chat.badge.querySelector('.term-badge__info');
  info.textContent = text;
  let tip = text || t('badge.details.empty');
  if (chat.bypassOn) tip = t('badge.details.bypass', { details: tip });
  info.dataset.tip = chat.adminOn ? t('badge.details.admin', { details: tip }) : tip;
  // Once on, here or for every chat, there is nothing left to turn on: the dot's color and tip say it is on.
  chat.badge.querySelector('.term-badge__bypass').hidden = !running || !chat.account || chat.bypassOn === true || bypassOn();
  chat.badge.querySelector('.term-badge__frugal').hidden = !running || !chat.account || chat.frugal === true;
  drawMic(chat, running);
  chat.badge.querySelector('.term-badge__admin').hidden = !running || !chat.account || chat.adminOn === true || adminOn();
  chat.badge.classList.toggle('is-bypass', chat.bypassOn === true);
  chat.badge.classList.toggle('is-admin', chat.adminOn === true);
  chat.badge.classList.toggle('is-collapsed', infoCollapsed);
}

const VOICE_MODES = [['off', t('voice.off')], ['local', t('settings.voice.input.local')], ['anthropic', t('voice.anthropic')]];

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
    items.push({ label: t('voice.default-microphone'), checked: !voiceDevice(), run: () => localStorage.removeItem('voiceDevice') });
    inputs.forEach((device, index) => items.push({ label: device.label || t('voice.microphone', { number: index + 1 }), checked: voiceDevice() === device.deviceId, run: () => localStorage.setItem('voiceDevice', device.deviceId) }));
  }
  items.push({ label: t('voice.settings'), run: () => openSettings('voice') });
  const box = chat.mic.getBoundingClientRect();
  openMenu(box.right, box.top, items, chat.mic.querySelector('.term-mic__more'));
  menu.style.left = `${Math.max(8, box.right - menu.offsetWidth)}px`;
  menu.style.top = `${Math.max(8, box.top - menu.offsetHeight - 4)}px`;
}

function drawMic(chat, running) {
  const mode = voiceMode();
  const busy = mode === 'off' ? null : chat.voice;
  const state = mode === 'off' ? 'off' : busy === 'listening' ? 'listening' : busy ? 'busy' : mode === 'local' && voiceReady === false ? 'missing' : 'ready';
  const tip = {
    off: t('voice.off-tip'),
    missing: t('voice.missing-tip', { model: voiceModel() }),
    listening: t('voice.recording-tip'),
    busy: busy === 'transcribing' ? t('voice.transcribing')
      : chat.voicePercent == null ? t('voice.downloading') : t('voice.download-progress', { percent: chat.voicePercent }),
    ready: mode === 'local' ? t('voice.record-local-tip')
      : chat.voiceOn ? t('voice.record-anthropic-tip')
      : t('voice.restart-tip'),
  }[state];
  chat.mic.dataset.state = state;
  chat.mic.hidden = !chat.account;
  chat.dock.hidden = !chat.account;
  for (const button of chat.dock.querySelectorAll('.term-dock__btn')) button.disabled = !running;
  chat.mic.toggleAttribute('data-idle', state !== 'listening' && !running);
  const record = chat.mic.querySelector('.term-mic__record');
  record.disabled = state === 'busy' || (state !== 'off' && state !== 'listening' && !running);
  record.querySelector('use').setAttribute('href', state === 'off' ? '#i-mic-off' : '#i-mic');
  record.querySelector('.term-mic__text').textContent = state === 'busy' ? tip : '';
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
  form.setAttribute('aria-label', t('prompt.edit.label'));
  const area = node('textarea', 'prompt-edit__text');
  area.spellcheck = false;
  area.value = text;
  const files = node('ul', 'prompt-edit__files');
  files.setAttribute('aria-label', t('prompt.attachments'));
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
    remove.setAttribute('aria-label', t('prompt.remove-file', { name }));
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
  const micTip = voiceMode() === 'anthropic' ? t('prompt.dictate-anthropic-tip') : t('prompt.dictate-tip');
  mic.dataset.tip = micTip;
  mic.setAttribute('aria-label', micTip);
  // Anthropic voice needs a chat launched with it, and that restart would drop this edit.
  mic.hidden = voiceMode() === 'off' || (voiceMode() === 'anthropic' && !chat.voiceOn);
  mic.onclick = () => toggleDictation(chat, area);
  actions.append(mic);
  const cancel = node('button', 'btn', t('common.cancel'));
  cancel.type = 'button';
  cancel.dataset.tip = t('prompt.discard-tip');
  const save = node('button', 'btn btn--primary', t('common.save'));
  save.type = 'submit';
  save.dataset.tip = t('prompt.save-tip');
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
  if (cwd) openChat({ id: crypto.randomUUID(), cwd, name: t('bar.new.label'), resume: false, group });
}

function resumeSession(session) {
  if (chats.has(session.id)) activate(session.id);
  else openChat({ id: session.id, cwd: session.cwd, name: session.title, resume: true });
}

const accountDialog = $('account-dialog');
let accountAddReturn = false;
const accountForm = $('account-form');
let accountAdd = null;

function accountStep(index, state) {
  const step = $('account-steps').children[index];
  step.dataset.state = state;
  step.querySelector('svg')?.remove();
  step.prepend(state === 'running' ? statusIcon('working') : icon(state === 'done' ? 'replied' : state === 'failed' ? 'x' : 'more'));
  step.setAttribute('aria-label', t('common.label-value', {
    label: t(step.dataset.i18n), value: t(`account.steps.state.${state}`),
  }));
  $('account-progress').hidden = ![...$('account-steps').children].some((li) => li.dataset.state === 'running');
}

function accountFields() {
  const kind = accountForm.querySelector('[name="account-kind"]:checked').value;
  const locked = Boolean(accountAdd?.busy || accountAdd?.registered);
  const paid = kind === 'gemini' || kind === 'antigravity';
  for (const input of accountForm.querySelectorAll('input')) input.disabled = locked;
  $('account-model-field').hidden = kind !== 'opencode';
  $('account-model').disabled = locked || kind !== 'opencode';
  $('account-model').required = kind === 'opencode';
  $('account-key-field').hidden = kind !== 'gemini';
  $('account-paid-field').hidden = !paid;
  $('account-key-hint').hidden = kind !== 'gemini';
  $('account-agy-hint').hidden = kind !== 'antigravity';
  $('account-key').disabled = locked || kind !== 'gemini';
  $('account-key').required = kind === 'gemini' && !accountAdd?.registered;
  $('account-paid').disabled = locked || !paid;
  if (kind !== 'gemini') $('account-key').value = '';
  $('account-submit').disabled = Boolean(accountAdd?.busy);
}

function addAccount(kind = 'claude') {
  $('usage').hidePopover();
  if (!accountDialog.open) {
    accountAdd = null;
    accountForm.reset();
    accountForm.querySelector(`[name="account-kind"][value="${kind}"]`).checked = true;
    $('account-log').textContent = '';
    $('account-error').textContent = '';
    $('account-submit').textContent = t('common.add');
    $('account-cancel').textContent = t('common.cancel');
    $('account-cancel').disabled = false;
    for (let i = 0; i < 3; i++) accountStep(i, 'pending');
    accountFields();
    accountDialog.showModal();
    $('account-name').focus();
  }
}

function accountResult(result, json = false) {
  if (result.code !== 0) throw new Error($('account-log').textContent.trim().split('\n').at(-1) || result.last || t('account.error.command-exit', { code: result.code }));
  if (!json) return result;
  try { return JSON.parse(result.last); }
  catch { throw new Error(t('account.error.update')); }
}

function closeAccountAdd() {
  accountDialog.close();
  if (accountAddReturn) {
    accountAddReturn = false;
    openSettings('accounts').then(() => $('account-add').focus());
  }
}

async function accountReady(run) {
  run.step = 2;
  accountStep(2, 'running');
  setAccounts(await deck.getAccounts());
  if (accountAdd !== run) return;
  accountStep(2, 'done');
  run.busy = false;
  $('account-cancel').disabled = false;
  $('account-cancel').textContent = t('common.close');
  setTimeout(() => {
    if (accountAdd === run) { accountAdd = null; closeAccountAdd(); }
  }, 1000);
}

function cancelAccountAdd() {
  if ($('account-cancel').disabled) return;
  const run = accountAdd;
  accountAdd = null;
  run?.exit?.(1);
  $('account-key').value = '';
  closeAccountAdd();
  if (run?.tab) closeChat(run.tab, true);
}

accountForm.onchange = accountFields;
accountDialog.oncancel = (event) => { event.preventDefault(); cancelAccountAdd(); };
$('account-cancel').onclick = cancelAccountAdd;
$('account-add').onclick = () => addAccount();
deck.onAccountCliLine((line) => {
  if (!accountAdd?.busy) return;
  const log = $('account-log');
  log.textContent = `${log.textContent}\n${line}`.trimStart().split('\n').slice(-12).join('\n');
  log.scrollTop = log.scrollHeight;
});
deck.onAccountLoginFinished(({ id, error }) => {
  if (accountAdd?.tab === id) accountAdd.loginError = error;
});
deck.onExit((id, code) => {
  if (accountAdd?.tab !== id) return;
  accountAdd.exitCode = code;
  accountAdd.exit?.(code);
});

accountForm.onsubmit = async (event) => {
  event.preventDefault();
  if (accountAdd?.busy) return;
  const name = $('account-name').value.trim();
  const kind = accountForm.querySelector('[name="account-kind"]:checked').value;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  $('account-error').textContent = '';
  if (!id) { $('account-error').textContent = t('account.error.name'); return; }
  if (!accountAdd?.registered && [...accountState.accounts, ...accountState.others].some((a) => a.id === id)) {
    $('account-error').textContent = t('account.error.exists', { id });
    return;
  }
  runAccountAdd(accountAdd?.registered ? accountAdd : { kind, id, name, registered: false });
};

// Registers the account unless it already is, signs it in, then reloads the accounts. Add account and a delegate's Sign in both run it.
async function runAccountAdd(run) {
  const { kind, id, name } = run;
  accountAdd = run;
  run.busy = true;
  run.step = 0;
  run.exitCode = null;
  run.loginError = null;
  $('account-log').textContent = '';
  $('account-cancel').disabled = true;
  accountStep(2, 'pending');
  accountFields();
  try {
    if (!run.registered) {
      for (let i = 0; i < 3; i++) accountStep(i, 'pending');
      accountStep(0, 'running');
      if (kind === 'claude') {
        const result = accountResult(await deck.installCli(kind));
        accountStep(0, result.skipped ? 'skipped' : 'done');
      } else {
        const args = ['add', kind, id];
        if (kind === 'opencode') args.push($('account-model').value.trim());
        if ((kind === 'gemini' || kind === 'antigravity') && $('account-paid').checked) args.push('--paid');
        // Clear the input immediately; the key lives only in this invocation's stdin.
        let pending;
        try { pending = deck.accountCli(args, kind === 'gemini' ? `${$('account-key').value}\n` : null); }
        finally { $('account-key').value = ''; }
        const result = accountResult(await pending, true);
        if (result.ok !== true || result.id !== id || result.kind !== kind || typeof result.loggedIn !== 'boolean') throw new Error(t('account.error.add'));
        run.registered = true;
        accountStep(0, 'done');
      }
    }
    run.step = 1;
    accountStep(1, 'running');
    if (kind !== 'claude' || !run.registered) {
      const command = kind === 'claude' ? null : accountResult(await deck.accountCli(['login-command', id]), true);
      if (command && command.argv === null) accountStep(1, 'skipped');
      else {
        if (command && (!Array.isArray(command.argv) || !command.argv.length || !command.env || typeof command.env !== 'object')) {
          throw new Error(t('account.error.update'));
        }
        run.tab = crypto.randomUUID();
        const exited = new Promise((resolve) => { run.exit = resolve; });
        // Leave the progress dialog visible while allowing interaction with the login tab.
        accountDialog.close();
        if (settingsDialog.open) {
          accountAddReturn = true;
          settingsDialog.close();
        }
        accountDialog.show();
        $('account-cancel').disabled = false;
        const result = await openChat({ id: run.tab, cwd: t('account.sign-in.folder', { name }), name: t('account.sign-in.title', { name }), login: name,
          accountSetup: true, loginCommand: command });
        if (accountAdd !== run) { await closeChat(run.tab, true); return; }
        if (result.error) throw new Error(result.error);
        if (kind === 'claude') {
          const code = await exited;
          if (accountAdd !== run) return;
          const state = await deck.getAccounts();
          if (code !== 0 || !state.accounts.some((a) => a.id === id && a.signedIn)) throw new Error(run.loginError || t('account.error.sign-in'));
          run.registered = true;
        } else {
          const deadline = Date.now() + 10 * 60 * 1000;
          while (true) {
            if (accountAdd !== run) return;
            if (Date.now() >= deadline) throw new Error(t('account.error.sign-in'));
            const status = accountResult(await deck.accountCli(['status', id]), true);
            if (accountAdd !== run) return;
            if (status.id !== id || status.kind !== kind || typeof status.installed !== 'boolean' || typeof status.loggedIn !== 'boolean') {
              throw new Error(t('account.error.update'));
            }
            if (status.loggedIn) break;
            if (run.exitCode != null && run.exitCode !== 0) throw new Error(t('account.error.sign-in'));
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
        if (accountAdd !== run) return;
        await closeChat(run.tab, true);
        run.tab = null;
        accountStep(1, 'done');
      }
    } else accountStep(1, 'done');
    if (accountAdd === run) await accountReady(run);
  } catch (error) {
    if (accountAdd !== run) return;
    run.busy = false;
    accountStep(run.step, 'failed');
    $('account-error').textContent = error.message || String(error);
    $('account-cancel').disabled = false;
    $('account-cancel').textContent = t('common.close');
    $('account-submit').textContent = t('common.retry');
    accountFields();
    if (run.tab) { await closeChat(run.tab, true); run.tab = null; }
  }
}

// A signed-out delegate signs in again through the Add account dialog, already past its add step.
function signInDelegate(account) {
  if (accountDialog.open) return;
  addAccount(account.kind);
  $('account-name').value = account.name;
  accountStep(0, 'done');
  runAccountAdd({ kind: account.kind, id: account.id, name: account.name, registered: true });
}

async function removeDelegate(account) {
  let result;
  try { result = await deck.accountCli(['remove', account.id]); } catch (error) { return { error: String(error) }; }
  if (result.code !== 0) return { error: result.last || t('account.error.command-exit', { code: result.code }) };
  setAccounts(await deck.getAccounts());
  loadOrder();
}

// xterm reports a selection only on mouseup, so output during a drag would see it as stale and clear it.
let mouseHeld = false;
addEventListener('mousedown', () => (mouseHeld = true), true);
addEventListener('mouseup', () => (mouseHeld = false), true);
// WebView2 shows the browser's own menu (Back, Refresh, Print) wherever the Deck has none; Electron showed nothing. Text fields keep it for cut, copy and paste.
addEventListener('contextmenu', (event) => event.target.closest('input, textarea:not(.xterm-helper-textarea), [contenteditable="true"]') || event.preventDefault());

// A chat's look; the MCP sign-in window shares it.
const termOptions = () => ({
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

async function openChat({ id, cwd, name, resume, group, login, accountId, handoff, loginCommand, accountSetup }) {
  const el = document.createElement('div');
  el.className = 'term';
  stage.append(el);
  const term = new Terminal({ scrollback: 10000, ...termOptions() });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const chat = { id, cwd, name, el, term, fit, login, accountSetup, state: 'starting', trustUntil: null, status: null, busy: false, inputAt: 0 };
  chats.set(id, chat);
  activate(id);
  chat.cols = term.cols;
  chat.rows = term.rows;
  term.onData((data) => {
    chat.inputAt = Date.now();
    if (data === '\x07') holdOutput(chat); // Ctrl+G: Claude Code clears the screen before it opens $VISUAL.
    deck.input(id, data);
  });
  // xterm keeps a selection over cells that Claude Code redraws; it goes once the text under it changes.
  term.onSelectionChange(() => (chat.selected = term.getSelection()));
  term.onWriteParsed(() => {
    if (!mouseHeld && term.hasSelection() && term.getSelection() !== chat.selected) term.clearSelection();
  });
  term.onTitleChange((title) => onTitle(chat, title));
  term.attachCustomKeyEventHandler((event) => handleTerminalKey(chat, event));
  term.registerLinkProvider(linkProvider(chat));
  makeBadge(chat);

  const size = { id, cols: term.cols, rows: term.rows };
  chat.bypassOn = !login && chatBypass(chat, handoff);
  chat.adminOn = !login && await confirmAdmin(chat.bypassOn, chatAdmin(chat, handoff));
  const result = await (login ? deck.login({ ...size, name: login, accountId, ...loginCommand })
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
  const pending = resume && !result.error && pendingHandoffs()[id];
  if (pending) {
    deck.debugLog('handoff', `${id}: pending handoff offered again`);
    offerHandoff(id, pending);
  }
  return result;
}

// From this context size on, every turn re-sends enough that a fresh session is worth starting unasked.
const HANDOFF_AUTO_TOKENS = 150000;
const handoffAuto = () => localStorage.getItem('handoffAuto') !== 'false';
const handoffDelay = () => {
  const seconds = Number(localStorage.getItem('handoffDelay') ?? 10);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 600 ? seconds : 10;
};
const handoffNotes = () => localStorage.getItem('handoffNote') !== 'false';
// A handoff not yet answered outlives a Deck restart: its chat offers it again when it resumes.
const pendingHandoffs = () => {
  try { return JSON.parse(localStorage.getItem('pendingHandoffs') || '{}'); } catch { return {}; }
};
function savePendingHandoff(id, handoff) {
  const all = pendingHandoffs();
  if (handoff) all[id] = handoff;
  else delete all[id];
  localStorage.setItem('pendingHandoffs', JSON.stringify(all)); // frugal: a chat closed for good keeps its entry; prune by age if the list grows
}

function stopCountdown(chat) {
  if (!chat.handoff?.timer) return;
  clearInterval(chat.handoff.timer);
  chat.handoff.timer = null;
}

// Counts down only while its chat is on screen, so it never opens a tab over another chat.
function startCountdown(chat) {
  chat.handoff.paused = false;
  chat.handoff.timer = setInterval(() => {
    if (activeId !== chat.id) {
      if (!chat.handoff.waiting) deck.debugLog('handoff', `${chat.id}: countdown waits, its chat is not on screen`);
      chat.handoff.waiting = true;
      return;
    }
    chat.handoff.waiting = false;
    chat.handoff.left -= 1;
    if (chat.handoff.left > 0) drawHandoff();
    else continueHandoff(chat);
  }, 1000);
}

// Typing in the handoff pauses its countdown; Save and wait resumes it.
function pauseCountdown() {
  const chat = chats.get(activeId);
  if (!chat?.handoff?.timer) return;
  stopCountdown(chat);
  chat.handoff.paused = true;
  drawHandoff();
}

function drawHandoff() {
  const handoff = chats.get(activeId)?.handoff;
  $('handoff').hidden = !handoff;
  if (!handoff) return;
  const text = $('handoff-text');
  if (document.activeElement !== text) text.value = handoff.prompt;
  const note = $('handoff-note');
  note.hidden = !handoffNotes();
  if (document.activeElement !== note) note.value = handoff.note;
  const size = tp('handoff.context', handoff.tokens, { count: compact.format(handoff.tokens) });
  const counting = handoff.timer || handoff.paused;
  $('handoff-status').textContent = handoff.timer ? tp('handoff.countdown', Math.max(handoff.left, 0), { size }) : handoff.paused ? t('handoff.paused', { size }) : size;
  const stop = $('handoff-stop');
  stop.textContent = counting ? t('common.cancel') : t('undo.dismiss.label');
  stop.dataset.tip = counting ? t('handoff.stop.tip') : t('handoff.dismiss.tip');
  $('handoff-save').hidden = !handoff.paused;
}

async function continueHandoff(chat) {
  stopCountdown(chat);
  if (chat.handoff.starting) return;
  chat.handoff.starting = true;
  const { note, instant } = chat.handoff;
  const prompt = note.trim() ? t('handoff.prompt-note', { prompt: chat.handoff.prompt.trimEnd(), note: note.trim() }) : chat.handoff.prompt;
  const result = await openChat({ id: crypto.randomUUID(), cwd: chat.cwd, name: t('bar.new.label'), handoff: { from: chat.id, accountId: chat.account, prompt } });
  deck.debugLog('handoff', `${chat.id}: new session ${result.error ? `failed: ${result.error}` : 'started'}`);
  // A failed start keeps the prompt, so nothing typed into it is lost.
  if (!result.error) {
    chat.handoff = null;
    savePendingHandoff(chat.id, null);
  }
  else if (chat.handoff) chat.handoff.starting = false;
  render();
  if (!result.error && instant && localStorage.getItem('handoffInstantShown') !== 'true') {
    localStorage.setItem('handoffInstantShown', 'true');
    if (await askConfirm(t('handoff.instant.title'), t('handoff.instant.text'), t('handoff.instant.settings'))) openSettings('handoff');
  }
}

deck.onHandoff(offerHandoff);
function offerHandoff(id, { prompt, tokens }) {
  const chat = chats.get(id);
  if (!chat) {
    deck.debugLog('handoff', `${id}: no tab for this chat, handoff dropped`);
    return;
  }
  savePendingHandoff(id, { prompt, tokens });
  if (chat.handoff) stopCountdown(chat);
  const delay = handoffDelay();
  const auto = handoffAuto() && tokens >= HANDOFF_AUTO_TOKENS;
  deck.debugLog('handoff', `${id}: ${tokens} tokens, auto ${auto} (setting ${handoffAuto()}, from ${HANDOFF_AUTO_TOKENS}), delay ${delay} s, on screen ${activeId === id}`);
  chat.handoff = { prompt, note: '', tokens, left: delay, timer: null, paused: false, instant: auto && delay === 0 };
  if (auto && delay === 0 && activeId === id) {
    continueHandoff(chat);
    return;
  }
  if (auto) startCountdown(chat);
  drawHandoff();
}

$('handoff-text').addEventListener('focus', pauseCountdown);
$('handoff-note').addEventListener('focus', pauseCountdown);
$('handoff-text').addEventListener('input', (event) => {
  const chat = chats.get(activeId);
  if (chat?.handoff) chat.handoff.prompt = event.target.value;
});
$('handoff-note').addEventListener('input', (event) => {
  const chat = chats.get(activeId);
  if (chat?.handoff) chat.handoff.note = event.target.value;
});
$('handoff-stop').onclick = () => {
  const chat = chats.get(activeId);
  if (!chat?.handoff) return;
  if (chat.handoff.timer || chat.handoff.paused) {
    stopCountdown(chat);
    chat.handoff.paused = false;
  } else {
    chat.handoff = null;
    savePendingHandoff(chat.id, null);
  }
  drawHandoff();
};
$('handoff-save').onclick = () => {
  const chat = chats.get(activeId);
  if (!chat?.handoff?.paused) return;
  startCountdown(chat);
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
const sendsExcerpts = () => localStorage.getItem('aiSearchExcerpts') === 'true';
const setBypass = (on) => localStorage.setItem('bypassPermissions', on);
const adminOn = () => localStorage.getItem('runAsAdmin') === 'true';
// The Deck's own confirm(): native dialogs never show in this window.
function askConfirm(title, message, ok, danger = false) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-ok').textContent = ok;
  $('confirm-ok').classList.toggle('btn--primary', !danger);
  $('confirm-ok').classList.toggle('btn--danger', danger);
  dialog.returnValue = ''; // Esc and the backdrop leave the last value in place.
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

const askBypass = () => askConfirm(t('dialog.bypass.title'), t('dialog.bypass.text'), t('badge.bypass.label'));
const askAdmin = () => askConfirm(t('dialog.admin.title'), t('dialog.admin.text'), t('dialog.admin.action'));
const askBoth = () => askConfirm(t('dialog.admin-bypass.title'), t('dialog.admin-bypass.text'), t('dialog.admin-bypass.action'));
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

// Web links ask first; files open in their default app (main only opens ones that exist and do not run code).
async function openLink(uri, cwd) {
  if (/^https?:/i.test(uri) && !await askConfirm(t('dialog.link.title'), uri, t('dialog.link.action'))) return;
  deck.openLink(uri, cwd);
}
// Replaces xterm's confirm() for OSC 8 links, which Claude Code also writes for file:// paths.
const linkHandler = { allowNonHttpProtocols: true, activate: (_, uri) => openLink(uri) };
// Plain-text web links and file paths (absolute, or relative to the chat's folder, with an optional :line:col).
const LINK_PATTERN = /https?:\/\/[^\s"'<>()]*[^\s"'<>().,;:!?]|(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|[\w.-]+[\\/])[\w.\\/-]*\.\w+(?::\d+)*/g;
// frugal: columns follow string indices, so a line with wide characters before a link is off; links that wrap are not joined.
const linkProvider = (chat) => ({
  provideLinks(y, callback) {
    const line = chat.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
    const links = [...line.matchAll(LINK_PATTERN)].map((match) => ({
      text: match[0],
      range: { start: { x: match.index + 1, y }, end: { x: match.index + match[0].length, y } },
      activate: (_, text) => openLink(text, chat.cwd),
    }));
    callback(links.length ? links : undefined);
  },
});
// One flag per chat: what it was launched with, or what its badge toggle asked for.
const chatBypass = (chat, handoff) => bypassOn() || (handoff ? Boolean(chats.get(handoff.from)?.bypassOn) : Boolean(chat?.bypassOn));
const chatAdmin = (chat, handoff) => adminOn() || (handoff ? Boolean(chats.get(handoff.from)?.adminOn) : Boolean(chat?.adminOn));

function askToClose(chat) {
  const dialog = $('close-dialog');
  $('close-message').textContent = t('dialog.close.message', { name: chat.name });
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

async function closeChat(id, force = false) {
  const chat = chats.get(id);
  if (!chat) return;
  const live = chat.state === 'starting' || chat.state === 'running';
  if (live && !force && confirmsClose() && !await askToClose(chat)) return;
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
    chat.startedAt ??= Date.now();
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
  chat.title = title;
  drawInfo(chat);
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
  // Every turn end comes before its own handoff block, so a turn after the block clears it and the block itself sets it again.
  savePendingHandoff(id, null);
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

// A side column's drag handle; side is 1 for a column on the left, -1 on the right. The terminal refits through the stage's ResizeObserver.
function columnResizer(resizer, panel, { min, max, base, variable, key, side }) {
  resizer.setAttribute('aria-valuemin', min);
  resizer.setAttribute('aria-valuemax', max);
  const setWidth = (width) => {
    const clamped = Math.round(Math.min(max, Math.max(min, width)));
    document.documentElement.style.setProperty(variable, `${clamped}px`);
    resizer.setAttribute('aria-valuenow', clamped);
    localStorage.setItem(key, clamped);
  };
  const width = () => panel.getBoundingClientRect().width;
  resizer.onpointerdown = (event) => {
    if (event.button !== 0) return;
    resizer.setPointerCapture(event.pointerId);
    const offset = event.clientX - side * width();
    resizer.onpointermove = (move) => setWidth(side * (move.clientX - offset));
    resizer.onlostpointercapture = () => {
      resizer.onpointermove = null;
    };
  };
  resizer.ondblclick = () => setWidth(base);
  resizer.onkeydown = (event) => {
    const next = { ArrowLeft: width() - 16 * side, ArrowRight: width() + 16 * side, Home: min, End: max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next);
  };
  setWidth(Number(localStorage.getItem(key)) || base);
}
columnResizer($('sidebar-resize'), document.querySelector('.sidebar'), { min: 220, max: 520, base: 280, variable: '--sidebar-width', key: 'sidebarWidth', side: 1 });
columnResizer($('info-resize'), $('info-panel'), { min: 220, max: 560, base: 288, variable: '--info-width', key: 'infoWidth', side: -1 });

deck.onExit((id, code) => {
  const chat = chats.get(id);
  if (!chat) return;
  resetStatus(chat);
  chat.state = 'exited';
  chat.exitCode = code;
  render();
  // A finished sign-in closes its tab after "Login successful" shows, and the panel opens on the account; a failed one stays to show why.
  if (chat.login && !chat.accountSetup && code === 0) setTimeout(() => {
    if (!chats.has(id)) return;
    closeChat(id);
    openSettings('accounts');
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
  drawInfo(chats.get(activeId));
}

async function loadAccounts(refresh = false) {
  if (accountsLoading) {
    drawAccounts();
    await accountsLoading;
    if (accountsLoading) return;
  }
  accountsError = '';
  const request = async () => {
    if (refresh) await deck.refreshAccounts();
    return deck.getAccounts();
  };
  accountsLoading = request().catch(() => null);
  drawAccounts();
  const state = await accountsLoading;
  accountsLoading = null;
  if (state) setAccounts(state);
  else {
    accountsError = refresh
      ? t('account.error.refresh')
      : t('account.error.load');
    drawAccounts();
  }
}

for (const id of ['accounts-state', 'settings-accounts-state']) $(id).querySelector('button').onclick = () => loadAccounts(true);
deck.onAccounts(setAccounts);
loadAccounts();

$('usage').addEventListener('toggle', (event) => {
  if (event.newState === 'open') loadAccounts(true);
  else if (!settingsDialog.open) chats.get(activeId)?.term.focus();
});

setInterval(() => {
  const resets = document.querySelectorAll('#usage:popover-open [data-reset], #settings-dialog[open] [data-section="accounts"]:not([hidden]) [data-reset]');
  for (const element of resets) element.textContent = resetLabel(Number(element.dataset.reset));
}, 30000);

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

// Workspaces and groups share one order, so either can sit before the other at any level.
let compareKeys = () => 0;
const spaceKey = (name) => `workspace:${name}`;

function orderGroups(tree) {
  const keys = [];
  const collect = (spaces) => {
    for (const workspace of spaces) {
      keys.push(spaceKey(workspace.name), ...workspace.groups.map(([key]) => key));
      collect(workspace.spaces);
    }
  };
  collect(tree.workspaces);
  keys.push(...tree.groups.map(([key]) => key));
  const saved = readGroupOrder();
  const missing = keys.filter((key, index) => !saved.includes(key) && keys.indexOf(key) === index);
  if (missing.length) {
    saved.unshift(...missing);
    saveGroupOrder(saved);
  }
  const rank = new Map(saved.map((key, index) => [key, index]));
  compareKeys = (a, b) => (a === NO_TOPIC) - (b === NO_TOPIC) || rank.get(a) - rank.get(b);
}

// Child workspaces and groups in their shared order; a workspace's own chats follow them.
function branchElements(spaces, groups, byTopic) {
  return [
    ...spaces.map((workspace) => [spaceKey(workspace.name), () => workspaceElement(workspace, byTopic)]),
    ...groups.map(([key, list]) => [key, () => groupElement(key, list, byTopic)]),
  ].sort(([a], [b]) => compareKeys(a, b)).map(([, make]) => make());
}

const workspaceCount = (workspace) => workspace.chats.length + workspace.groups.reduce((total, [, list]) => total + list.length, 0) + workspace.spaces.reduce((total, child) => total + workspaceCount(child), 0);

// The workspace an element sits in: '' at the top of the list.
const parentSpace = (element) => (element.parentElement?.classList.contains('group--workspace') ? element.parentElement.dataset.workspace : '');

function placeGroup(key, workspace) {
  if (key.startsWith('workspace:')) deck.setWorkspaceParent(key.slice('workspace:'.length), workspace);
  else deck.setWorkspace(key, workspace);
}

function placeChat(chat, { workspace, group }) {
  for (const s of currentIndex.sessions) {
    if (s.chatId !== chat.chatId) continue;
    if (group !== undefined) deck.setGroup(s.id, group);
    deck.organize(s.id, { pinned: chat.pinned, space: workspace ?? '', tags: chat.tags });
  }
}

let draggedGroup = null;
let dropTarget = null;

function clearDropTarget() {
  dropTarget?.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-into');
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

let draggedChat = null;

function configureChatDrag(row, chat) {
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    draggedChat = chat;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', chat.title);
  });
  row.addEventListener('dragend', () => {
    clearDropTarget();
    draggedChat = null;
  });
}

// Over a row's middle a drop goes into it: anything into a workspace, a chat into a group. Over its edges a group or
// workspace goes before or after it, joining the workspace that row sits in.
function dropZone(event, summary, group, key) {
  const intoSpace = key.startsWith('workspace:');
  const intoGroup = !intoSpace && key !== NO_TOPIC && sessionView === 'topics';
  if (draggedChat) return intoSpace || intoGroup ? 'into' : null;
  if (!draggedGroup || draggedGroup.group === group || draggedGroup.group.contains(group)) return null;
  const { top, height } = summary.getBoundingClientRect();
  const y = (event.clientY - top) / height;
  if (intoSpace && y > 0.25 && y < 0.75) return 'into';
  return y < 0.5 ? 'before' : 'after';
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
    const zone = dropZone(event, summary, group, key);
    if (!zone) return;
    event.preventDefault();
    if (dropTarget !== summary) {
      clearDropTarget();
      dropTarget = summary;
    }
    summary.classList.toggle('is-drop-before', zone === 'before');
    summary.classList.toggle('is-drop-after', zone === 'after');
    summary.classList.toggle('is-drop-into', zone === 'into');
    summary.dataset.dropZone = zone;
  });
  summary.addEventListener('dragleave', (event) => {
    if (event.relatedTarget && group.contains(event.relatedTarget)) return;
    if (dropTarget === summary) clearDropTarget();
  });
  summary.addEventListener('drop', (event) => {
    if ((!draggedGroup && !draggedChat) || dropTarget !== summary) return;
    event.preventDefault();
    const zone = summary.dataset.dropZone;
    const chat = draggedChat;
    const from = draggedGroup?.key;
    const fromParent = draggedGroup && parentSpace(draggedGroup.group);
    clearDropTarget();
    draggedGroup = null;
    draggedChat = null;
    if (chat) {
      placeChat(chat, key.startsWith('workspace:') ? { workspace: key.slice('workspace:'.length) } : { group: key });
      return;
    }
    if (zone === 'into') {
      placeGroup(from, key.slice('workspace:'.length));
      return;
    }
    const target = parentSpace(group);
    if (target !== fromParent) placeGroup(from, target);
    moveGroup(from, key, zone === 'before');
  });
}

// sessions: how many a chat holds, shown only past one.
function sessionTip(session, sessions) {
  const rows = [
    [t('session.folder'), session.missing ? t('session.folder-removed', { folder: session.cwd }) : session.cwd],
    [t('session.last-active'), resetExact.format(new Date(session.lastAt))],
    session.startedAt && session.startedAt !== session.lastAt && [t('session.started'), resetExact.format(new Date(session.startedAt))],
    session.turns && [tp('session.prompts', session.turns), String(session.turns)],
    sessions > 1 && [tp('session.sessions', sessions), String(sessions)],
  ].filter(Boolean);
  return { title: session.title, rows, hint: t('session.organize.tip') };
}

const tipText = ({ title, rows, hint }) => [title, ...rows.map(([label, value]) => t('common.label-value', { label, value })), hint].join('\n');

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
  configureChatDrag(first, chat);
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
  summary.append(icon('chevron'), document.createTextNode(String(n)));
  const syncSummary = () => {
    const label = history.open ? t('chat.history.hide') : tp('chat.history.show', n);
    summary.setAttribute('aria-label', label);
    summary.dataset.tip = label;
  };
  syncSummary();
  history.ontoggle = () => {
    if (history.open) openGroups.add(key);
    else openGroups.delete(key);
    syncSummary();
  };
  history.append(summary, foldLine(history), ...chat.earlier.map((session) => sessionButton(session)));
  container.append(first, history);
  return container;
}

// The line beside an open group or chat folds it. The summary does the same from the keyboard.
function foldLine(details) {
  const line = node('div', 'tree-rail');
  line.ariaHidden = 'true';
  line.dataset.tip = t('sidebar.collapse');
  line.onclick = () => (details.open = false);
  return line;
}

const groupLimit = () => Math.max(1, Number(localStorage.getItem('groupLimit')) || 10);

// A group longer than the limit shows its first chats and a row that shows the rest.
function limitedChats(key, chats) {
  const limit = groupLimit();
  if (chats.length <= limit) return chats.map((chat) => chatElement(chat));
  const all = openGroups.has(`more:${key}`);
  const more = node('button', 'session group__more', all ? t('sidebar.show-less') : tp('sidebar.show-more', chats.length - limit));
  more.type = 'button';
  more.onclick = () => {
    if (all) openGroups.delete(`more:${key}`);
    else openGroups.add(`more:${key}`);
    drawnSignature = '';
    renderSessions(currentIndex);
  };
  return [...(all ? chats : chats.slice(0, limit)).map((chat) => chatElement(chat)), more];
}

function newChatButton(chats, group, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--icon group__new';
  button.append(icon('plus'));
  const text = t('sidebar.new-chat', { label });
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
  const text = t('sidebar.options', { label });
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
  // Listed from the folder of one of its chats, nested workspaces included.
  const folder = currentIndex.sessions.find((s) => withinSpace(s.space ?? currentIndex.workspaces?.[chatsById.get(s.chatId)?.topic] ?? currentIndex.workspaces?.[s.cwd], name, currentIndex))?.cwd;
  if (folder) fetchMcp({ workspace: name, folder }, 30_000);
  return [
    ...(folder ? [{ label: t('mcp.title'), icon: 'plug', run: () => openMcpDialog({ workspace: name, folder }) }] : []),
    { label: t('account.rename.menu'), icon: 'edit', run: () => ask({
      title: t('organize.rename.title', { name }),
      text: t('organize.workspace.rename-text'),
      value: name,
      names: spaceNames.filter((other) => other !== name),
      action: t('common.rename'),
      run: (to) => {
        if (to === name) return;
        renameOpenKey(`workspace:${name}`, `workspace:${to}`);
        deck.renameWorkspace(name, to);
      },
    }) },
    { label: t('organize.workspace.move'), icon: 'topic', run: () => openWorkspace(spaceKey(name), name) },
    { label: t('common.remove'), icon: 'trash', danger: true, run: () => ask({
      title: t('organize.remove.title', { name }),
      text: t('organize.workspace.remove-text'),
      action: t('common.remove'),
      danger: true,
      run: () => deck.deleteWorkspace(name),
    }) },
  ];
}

const sessionsOfGroup = (key) => currentIndex.sessions.filter((s) => chatsById.get(s.chatId)?.topic === key).map((s) => s.id);

function groupMenu(key, label, byTopic) {
  const move = { label: t('organize.workspace.move'), icon: 'topic', run: () => openWorkspace(key, label) };
  // A group's servers are listed from the folder of one of its chats.
  const folder = byTopic ? currentIndex.sessions.find((s) => chatsById.get(s.chatId)?.topic === key)?.cwd : key;
  const listScope = byTopic ? { group: key, folder } : { folder };
  // `claude mcp list` takes seconds per account: listing while the menu is open lets the dialog show it sooner.
  if (folder) fetchMcp(listScope, 30_000);
  const mcp = { label: t('mcp.title'), icon: 'plug', run: () => openMcpDialog(listScope) };
  if (!byTopic) return [move, mcp];
  const workspace = currentIndex.workspaces?.[key];
  const otherGroups = () => groupNames.filter((name) => name !== key).map((value) => ({ name: groupLabel(value), value }));
  return [
    { label: t('account.rename.menu'), icon: 'edit', run: () => ask({
      title: t('organize.rename.title', { name: label }),
      text: t('organize.group.rename-text'),
      value: key,
      names: otherGroups(),
      action: t('common.rename'),
      run: (to) => {
        if (to === key) return;
        renameOpenKey(key, to);
        deck.renameGroup(sessionsOfGroup(key), key, to);
      },
    }) },
    { label: t('organize.group.merge'), icon: 'merge', run: () => ask({
      title: t('organize.group.merge-title', { label }),
      text: t('organize.group.merge-text'),
      names: otherGroups(),
      action: t('organize.merge'),
      run: (to) => {
        if (to === key) return;
        renameOpenKey(key, to);
        deck.renameGroup(sessionsOfGroup(key), key, to);
      },
    }) },
    move,
    ...(folder ? [mcp] : []),
    { label: t('common.remove'), icon: 'trash', danger: true, run: () => ask({
      title: t('organize.remove.title', { name: label }),
      text: workspace ? t('organize.group.remove-in-workspace', { workspace }) : t('organize.group.remove-text'),
      action: t('common.remove'),
      danger: true,
      run: () => deck.deleteGroup(sessionsOfGroup(key), key),
    }) },
  ];
}

const groupLabel = (key) => key === NO_TOPIC ? t('sidebar.no-topic') : key;

function groupElement(key, chats, byTopic) {
  const group = document.createElement('details');
  group.className = 'group';
  group.open = openGroups.has(key);
  group.ontoggle = () => (group.open ? openGroups.add(key) : openGroups.delete(key));
  const summary = document.createElement('summary');
  summary.className = 'group__name';
  const label = byTopic ? groupLabel(key) : folderName(key);
  summary.dataset.tip = byTopic ? label : key;
  const name = document.createElement('span');
  name.className = 'group__label';
  name.textContent = label;
  const count = document.createElement('span');
  count.className = 'group__count measured';
  count.textContent = chats.length;
  const chevron = icon('chevron');
  chevron.classList.add('group__chevron');
  summary.append(chevron, icon(key === NO_TOPIC ? 'inbox' : byTopic ? 'topic' : 'folder'), name, count);
  if (key === NO_TOPIC) group.classList.add('group--none');
  else {
    summary.append(newChatButton(chats, byTopic ? key : undefined, label));
    addMenu(summary, label, () => groupMenu(key, label, byTopic));
  }
  group.append(summary, foldLine(group), ...limitedChats(key, chats));
  configureGroupDrag(summary, group, key);
  return group;
}

function workspaceElement(workspace, byTopic) {
  const key = spaceKey(workspace.name);
  const group = document.createElement('details');
  group.className = 'group group--workspace';
  group.dataset.workspace = workspace.name;
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
  count.textContent = workspaceCount(workspace);
  const chevron = icon('chevron');
  chevron.classList.add('group__chevron');
  summary.append(chevron, icon('workspace'), name, count);
  addMenu(summary, workspace.name, () => workspaceMenu(workspace.name));
  group.append(
    summary,
    foldLine(group),
    ...branchElements(workspace.spaces, workspace.groups, byTopic),
    ...limitedChats(key, workspace.chats),
  );
  configureGroupDrag(summary, group, key);
  return group;
}

function indexStatus({ indexing, sessions, error, progress }) {
  if (error) return t('sidebar.index.error', { error });
  if (indexing && progress?.total) return tp('sidebar.index.progress', progress.total, { done: progress.done.toLocaleString(), count: progress.total.toLocaleString(), percent: Math.floor(100 * progress.done / progress.total) });
  if (sessions.length) return '';
  return indexing ? t('sidebar.index.loading') : t('sidebar.index.empty');
}

function pinnedElement(sessions) {
  const section = document.createElement('section');
  section.className = 'pinned';
  const heading = document.createElement('h2');
  heading.className = 'pinned__title';
  heading.textContent = t('sidebar.pinned');
  section.append(heading, ...sessions.map((chat) => chatElement(chat)));
  return section;
}

// True when workspace name is space or sits inside it, at any depth.
function withinSpace(name, space, index) {
  const parents = new Map(Object.entries(index.workspaceParents ?? {}).map(([child, parent]) => [child.toLowerCase(), parent]));
  for (let at = name, depth = 0; at && depth < 50; at = parents.get(at.toLowerCase()), depth++) {
    if (at.toLowerCase() === space.toLowerCase()) return true;
  }
  return false;
}

function drawSpaces(sessions, index) {
  const names = [...new Set([...sessions.map((s) => s.space), ...Object.values(index.workspaces ?? {}), ...Object.values(index.workspaceParents ?? {})].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-US'));
  const select = $('space-filter');
  const chosen = names.includes(select.value) ? select.value : '';
  select.replaceChildren(new Option(t('sidebar.all-workspaces'), ''), ...names.map((name) => new Option(name, name)));
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
  if (!index.indexing && !index.error && localStorage.getItem('externalImported') === null) {
    localStorage.setItem('externalImported', 'true');
    const ids = index.sessions.filter((s) => !s.deck).map((s) => s.id);
    if (localStorage.getItem('showExternal') !== 'false' && ids.length) {
      deck.importSessions(ids).catch((error) => deck.debugLog('index', `Could not import external sessions: ${error}`));
    }
  }
  if (!restored && !index.indexing) restoreChats(index);
  const status = indexStatus(index);
  $('index-status').hidden = !status;
  $('index-status').textContent = status;
  const progress = $('index-progress');
  progress.hidden = !(index.indexing && index.progress?.total);
  if (!progress.hidden) {
    progress.max = index.progress.total;
    progress.value = index.progress.done;
  }

  // Transcripts change every second during a turn; rebuilding only when the list changes keeps focus and scroll.
  const signature = `${sessionView}\n${index.indexing}\n${$('space-filter').value}\n${index.modelJoins}\n${index.modelWorkspaces}\n${JSON.stringify(index.workspaces ?? {})}\n${JSON.stringify(index.workspaceParents ?? {})}\n${index.ambiguous.length}\n${index.sessions.map((s) => `${s.id}\n${s.chatId}\n${s.title}\n${s.cwd}\n${shortDate.format(new Date(s.lastAt))}\n${s.pinned}\n${s.deck}\n${s.space}\n${s.tags}\n${s.topic}\n${s.userGroup ?? ''}`).join('\n')}`;
  if (signature === drawnSignature) {
    updateExternalCount();
    return;
  }
  drawnSignature = signature;
  if (sortDialog.open) drawSortEstimate();

  const sessions = index.sessions.filter((s) => s.deck);
  const allChats = groupChats(sessions);
  chatsById.clear();
  for (const chat of allChats) chatsById.set(chat.chatId, chat);

  drawSpaces(allChats, index);
  drawGroupNames(index);
  if (sortDialog.open && !$('sort-groups').hidden) drawSortGroups();
  const byTopic = sessionView === 'topics';
  const keyOf = (chat) => (byTopic ? chat.topic ?? NO_TOPIC : chat.cwd);
  const space = $('space-filter').value;
  const visible = space ? allChats.filter((c) => withinSpace(c.space ?? index.workspaces?.[keyOf(c)], space, index)) : allChats;
  const pinned = visible.filter((c) => c.pinned);
  const tree = buildTree(visible.filter((c) => !c.pinned), keyOf, index.workspaces ?? {}, index.workspaceParents ?? {});
  orderGroups(tree);
  const focused = document.activeElement?.dataset?.session;
  const list = $('groups');
  list.replaceChildren(
    ...(pinned.length ? [pinnedElement(pinned)] : []),
    ...branchElements(tree.workspaces, tree.groups, byTopic),
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
  updateExternalCount();
}

const palette = $('palette');
const paletteQuery = $('palette-query');
const paletteList = $('palette-list');
let paletteSessions = [];
let paletteRow = 0;
let paletteChoose = null;
// Message matches arrive after the title matches; an AI answer replaces both until the query changes.
let paletteText = new Set();
let paletteAi = null;
let paletteError = '';
let paletteLoading = '';
let paletteSearch = 0;
let paletteTimer = 0;

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
  const titled = matchSessions(paletteSessions, paletteQuery.value);
  const shown = new Set(titled.map((session) => session.id));
  const matches = paletteAi ?? [...titled, ...paletteSessions.filter((session) => paletteText.has(session.id) && !shown.has(session.id))];
  paletteList.replaceChildren(...matches.map(paletteOption));
  $('palette-empty').textContent = paletteLoading || paletteError || t('palette.empty');
  $('palette-state').hidden = matches.length > 0 && !paletteLoading && !paletteError;
  $('palette-retry').hidden = !paletteError;
  selectPaletteRow(matches.length ? 0 : -1);
}

function resetPaletteSearch() {
  paletteSearch += 1;
  clearTimeout(paletteTimer);
  paletteText = new Set();
  paletteAi = null;
  paletteError = '';
  paletteLoading = '';
}

function searchMessages() {
  resetPaletteSearch();
  const query = paletteQuery.value.trim();
  const search = paletteSearch;
  paletteLoading = query.length >= 2 ? t('palette.searching-messages') : '';
  drawPalette();
  if (!paletteLoading) return;
  paletteTimer = setTimeout(async () => {
    if (!palette.open) return;
    const ids = await deck.searchMessages(query).catch((error) => (console.warn('Message search failed', error), null));
    if (search !== paletteSearch || !palette.open) return;
    paletteLoading = '';
    if (ids) paletteText = new Set(ids);
    else {
      paletteError = t('palette.error.messages');
      $('palette-retry').onclick = searchMessages;
    }
    drawPalette();
  }, 200);
}

async function askAi() {
  const query = paletteQuery.value.trim();
  const button = $('palette-ask');
  if (!query || button.disabled || paletteQuery.readOnly) return;
  resetPaletteSearch();
  const search = paletteSearch;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = t('palette.ask.pending');
  paletteLoading = t('palette.searching-ai');
  drawPalette();
  const reply = await deck.searchAi({ model: $('palette-model').value, effort: $('palette-effort').value, rename: false, excerpts: sendsExcerpts() }, query)
    .catch((error) => ({ error: String(error) }));
  button.disabled = false;
  button.removeAttribute('aria-busy');
  button.textContent = t('palette.ask.label');
  if (search !== paletteSearch || !palette.open) return;
  paletteLoading = '';
  if (reply.error) {
    console.warn('AI search failed', reply.error);
    paletteError = t('palette.error.ai');
    $('palette-retry').onclick = askAi;
  } else if (!reply.stopped) {
    const byId = new Map(paletteSessions.map((session) => [session.id, session]));
    paletteAi = (reply.ids ?? []).map((id) => byId.get(id)).filter(Boolean);
  }
  drawPalette();
}

$('palette-ask').onclick = askAi;

async function loadPalette(load) {
  resetPaletteSearch();
  const search = paletteSearch;
  paletteSessions = [];
  paletteQuery.readOnly = true;
  $('palette-ai').hidden = true;
  $('palette-sends').hidden = true;
  paletteLoading = t('palette.loading');
  drawPalette();
  let sessions;
  try {
    sessions = await load();
  } catch {
    sessions = null;
  }
  if (search !== paletteSearch || !palette.open) return;
  paletteLoading = '';
  if (!sessions) {
    paletteError = t('palette.error.load');
    $('palette-retry').onclick = () => loadPalette(load);
  } else {
    paletteSessions = sessions;
    paletteQuery.readOnly = false;
    $('palette-ai').hidden = load !== deck.getAllSessions;
    $('palette-sends').hidden = $('palette-ai').hidden;
  }
  drawPalette();
}

async function showPalette(load, choose, placeholder = t('palette.query.placeholder')) {
  if (palette.open) {
    palette.close();
    return;
  }
  paletteChoose = choose;
  paletteQuery.placeholder = placeholder;
  paletteQuery.value = '';
  $('palette-sends').textContent = sendsExcerpts() ? t('palette.privacy.excerpts') : t('palette.privacy.standard');
  palette.showModal();
  await loadPalette(load);
}

async function togglePalette() {
  await showPalette(deck.getAllSessions, resumeSession);
}

paletteQuery.oninput = searchMessages;

paletteQuery.onkeydown = (event) => {
  const count = paletteList.children.length;
  if (event.key === 'Enter' && event.ctrlKey && !$('palette-ai').hidden) {
    event.preventDefault();
    askAi();
  } else if (event.key === 'Enter') {
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

let undoAction = null;
function showUndo(text, undo = null) {
  undoAction = undo;
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
  setComboValue($('organize-group'), group, groupLabel(group));
  $('organize-group').dataset.prefill = group;
  $('organize-tags').value = chat.tags.join(', ');
  $('organize-unlink').hidden = !session.parentId;
  organize.showModal();
}

function openWorkspace(key, label) {
  movingGroup = key;
  $('workspace-title').textContent = label;
  $('workspace-name').value = (key.startsWith('workspace:') ? currentIndex?.workspaceParents?.[label] : currentIndex?.workspaces?.[key]) ?? '';
  workspaceDialog.showModal();
}

$('organize-form').onsubmit = () => {
  const value = {
    pinned: $('organize-pinned').checked,
    space: $('organize-space').value,
    tags: $('organize-tags').value.split(','),
  };
  const input = $('organize-group');
  const group = input.dataset.selectedValue ?? input.value;
  const groupChanged = group !== input.dataset.prefill;
  for (const s of currentIndex.sessions) {
    if (s.chatId === organizing.chatId) {
      deck.organize(s.id, value);
      if (groupChanged) deck.setGroup(s.id, group);
    }
  }
};
$('workspace-form').onsubmit = () => {
  if (movingGroup) placeGroup(movingGroup, $('workspace-name').value);
};
$('workspace-cancel').onclick = () => workspaceDialog.close();
$('organize-archive').onclick = () => {
  organize.close();
  const ids = currentIndex.sessions.filter((s) => s.chatId === organizing.chatId).map((s) => s.id);
  deck.setArchived(ids, true);
  showUndo(t('organize.archived'), () => deck.setArchived(ids, false));
};

// Newest first. A session that is not the first of its chat names that chat; opening one brings its chat back.
async function drawArchived() {
  const all = await deck.getAllSessions();
  const byId = new Map(all.map((s) => [s.id, s]));
  const archived = all.filter((s) => s.archived).sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  $('archived-empty').hidden = archived.length > 0;
  $('archived-list').replaceChildren(...archived.map((session) => {
    const item = document.createElement('li');
    item.className = 'archived__item';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'session';
    open.dataset.tip = session.cwd;
    const title = document.createElement('span');
    title.className = 'session__title';
    title.textContent = session.title;
    const from = document.createElement('span');
    from.className = 'session__folder';
    const chat = byId.get(session.chatId);
    from.textContent = session.chatId !== session.id && chat ? t('organize.archived-from', { title: chat.title }) : folderName(session.cwd);
    open.append(title, from);
    open.onclick = () => {
      $('archived-dialog').close();
      resumeSession(session);
    };
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn';
    restore.textContent = t('organize.unarchive');
    restore.dataset.tip = t('organize.unarchive-tip');
    restore.onclick = () => {
      deck.setArchived([session.id], false);
      item.remove();
      $('archived-empty').hidden = $('archived-list').childElementCount > 0;
    };
    item.append(open, restore);
    return item;
  }));
}
$('archived').onclick = async () => {
  await drawArchived();
  $('archived-dialog').showModal();
};

const menu = $('menu');
settingsDialog.addEventListener('close', () => {
  if (settingsDialog.contains(menu)) menu.hidePopover();
});

// A source inside another popover nests the menu in it, so opening the menu leaves that popover open.
function openMenu(x, y, items, source) {
  if (menu.matches(':popover-open')) menu.hidePopover();
  // A menu inside a modal must be its descendant to receive focus and clicks.
  const parent = source?.closest('dialog') ?? document.body;
  if (menu.parentElement !== parent) parent.append(menu);
  menu.replaceChildren(...items.map(({ label, run, danger, checked, icon: glyph, separator }) => {
    if (separator) return Object.assign(node('div', 'menu__separator'), { role: 'separator' });
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu__item';
    item.role = checked === undefined ? 'menuitem' : 'menuitemradio';
    if (checked !== undefined) item.ariaChecked = String(checked);
    item.toggleAttribute('data-danger', Boolean(danger));
    item.textContent = label;
    if (glyph) item.prepend(icon(glyph));
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
  const items = [...menu.querySelectorAll('.menu__item')];
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
  setComboValue(input, value ?? '');
  askNames = names;
  askRun = run;
  $('ask-submit').textContent = action;
  $('ask-submit').classList.toggle('btn--danger', danger);
  askDialog.showModal();
  if (value !== null) input.select();
}

$('ask-form').onsubmit = () => {
  const input = $('ask-value');
  askRun((input.dataset.selectedValue ?? input.value).trim());
};
$('ask-cancel').onclick = () => askDialog.close();
// A question asked from the accounts panel returns to it.
askDialog.addEventListener('close', () => {
  if (askReturn && !$('usage').matches(':popover-open')) $('usage').showPopover();
});
$('usage-manage').onclick = () => openSettings('accounts');

// A translated group label can share its spelling with a user-defined group.
function setComboValue(input, value, label = value) {
  input.value = label;
  if (label === value) delete input.dataset.selectedValue;
  else input.dataset.selectedValue = value;
}

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
    // An entry is a name, or { name, branch: 'mid' | 'last', pick } for a row of a tree; a search shows the rows flat.
    const matches = names().map((entry) => (typeof entry === 'string' ? { name: entry } : entry)).filter(({ name }) => name.toLowerCase().includes(query));
    list.replaceChildren(...matches.map(({ name, value = name, branch, pick }, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.id = `${list.id}-${i}`;
      item.className = 'menu__item';
      if (branch && !query) item.classList.add('branch', ...(branch === 'last' ? ['branch--last'] : []));
      item.role = 'option';
      item.tabIndex = -1;
      item.textContent = name;
      item.onmousedown = (event) => event.preventDefault();
      item.onclick = () => {
        if (pick) pick();
        else setComboValue(input, value, name);
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
  input.addEventListener('input', () => {
    delete input.dataset.selectedValue;
    open(input.value.trim().toLowerCase());
  });
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
// Each workspace with its groups under it: a workspace places the chat in it outside any group, a group places it in that group.
function placeTree() {
  const spaceOf = new Map(Object.entries(currentIndex?.workspaces ?? {}).map(([group, space]) => [group.toLowerCase(), space]));
  const place = (space, group) => () => {
    $('organize-space').value = space;
    setComboValue($('organize-group'), group, groupLabel(group));
  };
  return [
    ...spaceNames.flatMap((space) => {
      const groups = groupNames.filter((group) => spaceOf.get(group.toLowerCase()) === space);
      return [{ name: space, pick: place(space, '') }, ...groups.map((group, i) => ({ name: groupLabel(group), branch: i === groups.length - 1 ? 'last' : 'mid', pick: place('', group) }))];
    }),
    ...groupNames.filter((group) => !spaceNames.includes(spaceOf.get(group.toLowerCase()))).map((group) => ({ name: groupLabel(group), pick: place('', group) })),
  ];
}
attachCombo($('organize-group'), placeTree);
attachCombo($('workspace-name'), () => spaceNames);
attachCombo($('ask-value'), () => askNames);
$('organize-cancel').onclick = () => organize.close();
$('organize-link').onclick = () => {
  organize.close();
  const session = organizing;
  const otherChats = async () => groupChats(await deck.getAllSessions()).filter((c) => c.chatId !== session.chatId);
  showPalette(otherChats, (target) => {
    deck.link(session.chatId, target.id);
    showUndo(t('organize.linked', { title: target.title }));
  }, t('palette.link-prompt'));
};
$('organize-unlink').onclick = () => {
  organize.close();
  deck.link(organizing.id, null);
  showUndo(t('organize.unlinked'));
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

// '' stands for the sessions with no topic. Checks survive redraws while the dialog is open.
const sortGroups = new Set();

function sortOptions() {
  const scope = $('sort-scope').value;
  return {
    model: $('sort-model').value,
    effort: $('sort-effort').value,
    rename: $('sort-rename').checked,
    notes: $('sort-notes').value,
    resort: scope === 'all',
    ...(scope === 'groups' && { groups: [...sortGroups].filter((name) => name === '' || groupNames.includes(name)) }),
  };
}

function chip(label, checked, onchange) {
  const input = Object.assign(node('input'), { type: 'checkbox', checked });
  input.onchange = onchange;
  const row = node('label', 'sort__chip');
  row.append(input, label);
  return { row, input };
}

// Groups as chips under their workspace; All checks or clears the section.
function drawSortGroups() {
  const spaceOf = new Map(Object.entries(currentIndex?.workspaces ?? {}).map(([group, space]) => [group.toLowerCase(), space]));
  const bySpace = new Map();
  for (const name of [...groupNames, '']) {
    const space = (name && spaceOf.get(name.toLowerCase())) || '';
    bySpace.set(space, [...(bySpace.get(space) ?? []), name]);
  }
  const spaces = [...bySpace].sort(([a], [b]) => (a === '') - (b === '') || a.localeCompare(b, 'en-US'));
  $('sort-group-list').replaceChildren(...spaces.map(([space, names]) => {
    const all = chip(t('sort.groups.all'), names.every((name) => sortGroups.has(name)), () => {
      for (const [name, { input }] of chips) {
        input.checked = all.input.checked;
        if (all.input.checked) sortGroups.add(name);
        else sortGroups.delete(name);
      }
      drawSortEstimate();
    });
    const chips = names.map((name) => [name, chip(groupLabel(name || NO_TOPIC), sortGroups.has(name), (event) => {
      if (event.target.checked) sortGroups.add(name);
      else sortGroups.delete(name);
      all.input.checked = names.every((other) => sortGroups.has(other));
      drawSortEstimate();
    })]);
    const head = node('div', 'sort__space-head');
    head.append(node('span', '', space || (spaces.length > 1 ? t('sort.groups.unassigned') : t('sort.groups.title'))), all.row);
    const list = node('div', space ? 'sort__chips sort__chips--tree' : 'sort__chips');
    list.append(...chips.map(([, { row }]) => {
      if (!space) return row;
      const branch = node('div', 'branch');
      branch.append(row);
      return branch;
    }));
    const section = node('section', 'sort__space');
    section.append(head, list);
    return section;
  }));
}

// Each model and effort shows what the run would cost with it.
function labelCosts(select, costs) {
  for (const option of select.options) {
    option.dataset.name ??= option.textContent;
    option.textContent = costs ? tp('sort.option-cost', costs[option.value], { name: option.dataset.name, count: compact.format(costs[option.value]) }) : option.dataset.name;
  }
}

// Time per session, learned from the last finished run with each model and effort. Measured on 2026-11-11 with 348 sessions,
// renaming on, through claude-sm: batches of 300 and 48 took 59.9 s and 9.9 s, so a call's start-up (~0.4 s) barely counts.
// frugal: only Sonnet at medium is measured; the others show no time until they have run once.
const SORT_PACE_MEASURED = { 'sonnet/medium': 200 };
const sortPaces = () => ({ ...SORT_PACE_MEASURED, ...JSON.parse(localStorage.getItem('sortPace') ?? '{}') });
const paceKey = (options) => `${options.model}/${options.effort}`;
const duration = (ms) => (ms < 60000 ? t('sort.time.short') : tp('sort.time.minutes', Math.round(ms / 60000)));
let sortRun = null;
let sortTicker = null;

// The bar follows finished batches and, once a pace is known, the clock; it never reaches the end before the run does.
function drawSortProgress() {
  const bar = $('sort-progress');
  bar.hidden = !sortRun;
  if (!sortRun) return;
  const { started, expected, done, total, label } = sortRun;
  const left = expected - (Date.now() - started);
  const share = Math.max(total ? done / total : 0, expected ? Math.min(1 - left / expected, 0.99) : 0);
  if (share) bar.value = share;
  else bar.removeAttribute('value');
  const sorted = total && tp('sort.progress.sorted', total, { done });
  const remaining = expected && (left > 0 ? t('sort.progress.remaining', { duration: duration(left) }) : t('sort.progress.almost-done'));
  sortStatus(label ?? ([sorted, remaining].filter(Boolean).join(' · ') || t('sort.progress.first-batch')));
}

function trackSort(run) {
  sortRun = run && { started: Date.now(), expected: 0, done: 0, total: 0, ...run };
  clearInterval(sortTicker);
  sortTicker = sortRun && setInterval(drawSortProgress, 1000);
  drawSortProgress();
}

function sortStatus(text, failed = false) {
  $('sort-status').hidden = !text;
  $('sort-status').textContent = text;
  $('sort-status').dataset.failed = failed;
}

// An error stays. Success clears after a few seconds, unless a later status replaced it.
const STATUS_MS = 4000;
const statusTimers = new Map();
function showStatus(id, text, failed = false) {
  const status = $(id);
  clearTimeout(statusTimers.get(id));
  status.textContent = text;
  status.hidden = !text;
  status.dataset.failed = failed;
  if (!text || failed) {
    statusTimers.delete(id);
    return;
  }
  statusTimers.set(id, setTimeout(() => {
    if (status.textContent !== text) return;
    showStatus(id, '');
  }, STATUS_MS));
}

async function drawSortEstimate() {
  if (sorting) return;
  const options = sortOptions();
  const [topics, workspaces] = await Promise.all([deck.estimateTopics(options), deck.estimateWorkspaces()]);
  const nest = $('sort-nest').checked && workspaces.groups > 0;
  const extra = nest ? workspaces.tokens : 0;
  const plus = (costs) => costs && Object.fromEntries(Object.entries(costs).map(([key, value]) => [key, value + extra]));
  labelCosts($('sort-model'), plus(topics.byModel));
  labelCosts($('sort-effort'), plus(topics.byEffort));
  const tokens = topics.tokens + extra;
  const pace = sortPaces()[paceKey(options)];
  const time = pace && topics.sessions ? duration(pace * topics.sessions) : '';
  const sessions = topics.sessions && tp('sort.estimate.sessions', topics.sessions, { count: topics.sessions.toLocaleString('en-US') });
  const moving = nest && tp('sort.estimate.groups', workspaces.groups);
  const parts = sessions && moving ? t('sort.estimate.both', { sessions, moving }) : sessions || moving;
  $('sort-run').disabled = !parts;
  const warning = $('sort-warning');
  if (options.groups?.length === 0 && !nest) {
    warning.textContent = t('sort.estimate.choose-group');
  } else if (parts) {
    const estimate = tp('sort.estimate.warning', tokens, { count: tokens.toLocaleString('en-US'), parts });
    warning.textContent = time ? t('sort.estimate.with-time', { estimate, duration: time }) : estimate;
  } else {
    warning.textContent = t('sort.estimate.nothing');
  }
  const join = await deck.estimateJoins();
  $('join-row').hidden = join.sessions === 0;
  if (join.sessions !== 0) {
    $('join-text').textContent = tp('sort.join.estimate', join.sessions, { tokens: join.tokens.toLocaleString('en-US') });
  }
  $('join-undo').hidden = !(currentIndex?.modelJoins > 0);
  $('workspace-undo').hidden = !(currentIndex?.modelWorkspaces > 0);
}

for (const radio of viewRadios) {
  radio.checked = radio.value === sessionView;
  radio.onchange = () => setSessionView(radio.value);
}
const debugConsole = $('debug-console');
const DEBUG_KEEP = 2000;
// Settings, MCP servers and Plugins share one layout: a nav of tabs and one section shown at a time.
function showSection(dialog, name) {
  const sections = [...dialog.querySelectorAll('.settings__section')];
  if (!sections.some((section) => section.dataset.section === name)) name = sections[0].dataset.section;
  for (const tab of dialog.querySelectorAll('.settings__tab')) {
    if (tab.dataset.section === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const section of sections) section.hidden = section.dataset.section !== name;
  return name;
}
for (const dialog of document.querySelectorAll('dialog.settings')) {
  dialog.querySelector('.settings__nav').onclick = (event) => {
    const tab = event.target.closest('.settings__tab');
    if (!tab) return;
    if (dialog.id === 'settings-dialog') showSettingsSection(tab.dataset.section);
    else showSection(dialog, tab.dataset.section);
  };
}
function showSettingsSection(name) {
  name = showSection(settingsDialog, name);
  if (name === 'accounts' && settingsDialog.open) {
    loadAccounts(true);
    loadOrder();
  }
  if (name === 'debug') debugConsole.scrollTop = debugConsole.scrollHeight;
  if (name === 'updates' && !updatesBusy) loadUpdates();
  if (name === 'performance' && !perfTimer && !perfWrite) loadPerf();
  localStorage.setItem('settingsSection', name);
  return name;
}

const PERF_SAVE_MS = 400;
const PERF_FIELDS = [
  { field: 'cpu', min: 5, max: 100 },
  { field: 'ram', min: 5, max: 100 },
  { field: 'gpu', min: 0, max: 100, gpu: true },
  { field: 'parallel', min: 0, max: 16 },
];
let perf;
let perfMachine;
let perfCustom;
let perfLoading = false;
let perfTimer;
let perfWrite;
let perfRevision = 0;
const perfMode = () => settingsDialog.querySelector('[name="perf-mode"]:checked').value;
const perfFields = () => PERF_FIELDS.filter((item) => !item.gpu || perfMachine.gpus.length);
const perfValue = (field, value) => (field !== 'parallel' ? t('common.percent', { percent: value }) : value ? String(value) : t('settings.performance.no-limit'));
const budgetText = (budget) => perfFields().map(({ field }) => `${t(`settings.performance.${field}`)} ${perfValue(field, budget[field])}`).join(' · ');
function machineText(machine) {
  const gpus = machine.gpus.map((gpu) => t('settings.performance.gpu-name', { name: gpu.name, vram: sizeText(gpu.vram_bytes, 1024) })).join(', ');
  return t('settings.performance.machine', { cores: machine.cores, ram: sizeText(machine.ram_bytes, 1024), gpu: gpus || t('settings.performance.no-gpu') });
}
function drawPerf() {
  const mode = perfMode();
  const custom = mode === 'custom';
  const budget = custom ? perfCustom : perf.presets[mode];
  $('perf-about').hidden = custom;
  $('perf-about').textContent = custom ? '' : t(`settings.performance.${mode}.about`);
  $('perf-budgets').replaceChildren(...perfFields().map(({ field, min, max }) => {
    const label = t(`settings.performance.${field}`);
    const row = node('div', 'cap');
    const caption = node(custom ? 'label' : 'span', 'cap__label', label);
    const value = node(custom ? 'output' : 'span', 'cap__value', perfValue(field, budget[field]));
    row.append(caption);
    if (custom) {
      const slider = Object.assign(node('input'), { id: `perf-${field}`, type: 'range', min, max, step: 1, value: budget[field] });
      caption.htmlFor = slider.id;
      value.setAttribute('for', slider.id);
      slider.oninput = () => {
        perfCustom[field] = Number(slider.value);
        value.textContent = perfValue(field, perfCustom[field]);
        savePerf();
      };
      row.append(slider);
    }
    row.append(value);
    return row;
  }));
}
function showPerf() {
  perfCustom = perf.custom && { ...perf.custom };
  settingsDialog.querySelector(`[name="perf-mode"][value="${perf.mode}"]`).checked = true;
  $('perf-machine').textContent = machineText(perfMachine);
  drawPerf();
}
async function loadPerf() {
  if (perfLoading) return;
  perfLoading = true;
  $('perf-body').hidden = true;
  $('perf-suggest-row').hidden = true;
  $('perf-state').replaceChildren(emptyState(t('common.loading')));
  try {
    [perf, perfMachine] = await Promise.all([deck.perfGet(), deck.perfMachine()]);
    showPerf();
    $('perf-state').replaceChildren();
    $('perf-body').hidden = false;
    $('perf-suggest-row').hidden = false;
  } catch (error) {
    $('perf-state').replaceChildren(emptyState(t('settings.performance.error', { error }), loadPerf));
  } finally {
    perfLoading = false;
  }
}
async function writePerf(mode, custom) {
  const write = (perfWrite?.catch(() => {}) ?? Promise.resolve()).then(() => deck.perfSet(mode, custom));
  perfWrite = write;
  try {
    perf = await write;
  } finally {
    if (perfWrite === write) perfWrite = undefined;
  }
}
function savePerf() {
  clearTimeout(perfTimer);
  const revision = ++perfRevision;
  const mode = perfMode();
  const custom = perfCustom && { ...perfCustom };
  showStatus('perf-status', '');
  perfTimer = setTimeout(async () => {
    perfTimer = undefined;
    try {
      await writePerf(mode, custom);
      if (revision === perfRevision) showStatus('perf-status', t('common.saved'));
    } catch (error) {
      if (revision !== perfRevision) return;
      showStatus('perf-status', String(error), true);
      showPerf();
    }
  }, PERF_SAVE_MS);
}
for (const radio of settingsDialog.querySelectorAll('[name="perf-mode"]')) {
  radio.onchange = () => {
    if (radio.value === 'custom' && !perfCustom) {
      const { cpu, ram, gpu, parallel } = perf.presets[perf.mode];
      perfCustom = { cpu, ram, gpu, parallel };
    }
    drawPerf();
    savePerf();
  };
}
function busyPerf(button, busy) {
  button.disabled = busy;
  button.setAttribute('aria-busy', busy);
}
const perfSuggestButton = $('perf-suggest');
const perfSuggestion = $('perf-suggestion');
async function askPerf(profile) {
  perfSuggestion.replaceChildren(emptyState(t('settings.performance.suggest.asking')));
  perfSuggestion.hidden = false;
  busyPerf(perfSuggestButton, true);
  const reply = await deck.perfSuggest(profile, currentLanguage()).catch((error) => ({ error: String(error) }));
  busyPerf(perfSuggestButton, false);
  const restoreFocus = !settingsDialog.contains(document.activeElement);
  if (!reply.ok) {
    perfSuggestion.replaceChildren(emptyState(t('settings.performance.suggest.failed', { error: reply.error ?? '' }), () => askPerf(profile)));
    if (restoreFocus) perfSuggestion.querySelector('button').focus();
    return;
  }
  const { mode, custom, reason } = reply.suggestion;
  const budget = mode === 'custom' ? custom : perf.presets[mode];
  const cancel = node('button', 'btn', t('common.cancel'));
  const apply = node('button', 'btn btn--primary', t('common.apply'));
  cancel.type = apply.type = 'button';
  cancel.onclick = () => {
    perfSuggestion.hidden = true;
    perfSuggestion.replaceChildren();
    showStatus('perf-suggest-status', '');
    perfSuggestButton.focus();
  };
  apply.onclick = async () => {
    clearTimeout(perfTimer);
    perfTimer = undefined;
    ++perfRevision;
    busyPerf(apply, true);
    busyPerf(perfSuggestButton, true);
    cancel.disabled = true;
    $('perf-body').inert = true;
    showStatus('perf-suggest-status', '');
    try {
      await writePerf(mode, mode === 'custom' ? budget : perfCustom);
      showPerf();
      showStatus('perf-status', t('common.saved'));
      cancel.onclick();
    } catch (error) {
      apply.textContent = t('common.retry');
      showStatus('perf-suggest-status', t('settings.performance.apply-failed', { error }), true);
    } finally {
      $('perf-body').inert = false;
      cancel.disabled = false;
      busyPerf(apply, false);
      busyPerf(perfSuggestButton, false);
      if (!settingsDialog.contains(document.activeElement)) (perfSuggestion.hidden ? perfSuggestButton : apply).focus();
    }
  };
  const actions = node('div', 'organize__actions');
  actions.append(cancel, apply);
  const text = t('settings.performance.suggestion', { mode: t(`settings.performance.${mode}`), budgets: budgetText(budget) });
  perfSuggestion.replaceChildren(node('p', 'sort__warning', text), node('p', 'settings__hint', reason), actions);
  if (restoreFocus) apply.focus();
}
async function suggestPerf() {
  busyPerf(perfSuggestButton, true);
  perfSuggestion.hidden = false;
  perfSuggestion.replaceChildren(emptyState(t('common.loading')));
  showStatus('perf-suggest-status', '');
  let profile;
  try {
    profile = await deck.perfProfile();
  } catch (error) {
    perfSuggestion.replaceChildren(emptyState(t('settings.performance.suggest.failed', { error }), suggestPerf));
    return;
  } finally {
    busyPerf(perfSuggestButton, false);
  }
  perfSuggestion.hidden = true;
  perfSuggestion.replaceChildren();
  if (!settingsDialog.open || !perfSuggestButton.getClientRects().length) return;
  perfSuggestButton.focus();
  const none = t('settings.performance.suggest.none');
  const text = t('settings.performance.suggest.text', {
    machine: machineText(profile), programs: profile.programs.join(', ') || none, games: profile.games.join(', ') || none,
  });
  if (await askConfirm(t('settings.performance.suggest.title'), text, t('settings.performance.suggest.action'))) askPerf(profile);
}
perfSuggestButton.onclick = suggestPerf;

function updateExternalCount() {
  const n = currentIndex?.sessions.filter((s) => !s.deck).length ?? 0;
  $('settings-external-count').textContent = n ? tp('settings.general.external.remaining', n) : t('settings.general.external.all');
  $('settings-import-external').disabled = n === 0;
}

async function openSettings(section = localStorage.getItem('settingsSection')) {
  section = showSettingsSection(section);
  $('settings-confirm-close').checked = confirmsClose();
  $('settings-always-trust').checked = alwaysTrusts();
  $('settings-bypass').checked = bypassOn();
  $('settings-admin').checked = adminOn();
  $('settings-voice').value = voiceMode();
  $('settings-voice-model').value = voiceModel();
  $('settings-voice-language').value = voiceLanguage();
  showVoiceOptions();
  $('settings-roles').checked = await deck.getRoles();
  $('settings-mouse').checked = await deck.getMouse();
  $('settings-keep-transcripts').checked = await deck.getKeepTranscripts();
  $('settings-frugal').checked = startsWithFrugal();
  updateExternalCount();
  $('settings-ai-excerpts').checked = sendsExcerpts();
  $('settings-mic').checked = allowsMic();
  $('settings-clipboard').checked = allowsClipboard();
  $('settings-handoff-auto').checked = handoffAuto();
  $('settings-handoff-delay').value = handoffDelay();
  $('settings-handoff-delay').disabled = !handoffAuto();
  $('settings-handoff-note').checked = handoffNotes();
  $('settings-accent').querySelector(`[value="${accentHue()}"]`).checked = true;
  $('settings-tooltips').value = tooltipPlacement();
  $('settings-reopen').checked = reopensChats();
  $('settings-volume').value = notifyVolume();
  $('settings-volume-value').value = t('common.percent', { percent: notifyVolume() });
  $('settings-group-limit').value = groupLimit();
  $('settings-debug').checked = localStorage.getItem('debugLog') === 'true';
  debugConsole.replaceChildren();
  showDebugLines(await deck.debugLines());
  if (!settingsDialog.open) {
    settingsDialog.showModal();
    if (section === 'accounts') {
      loadAccounts(true);
      loadOrder();
    }
  }
  debugConsole.scrollTop = debugConsole.scrollHeight;
  loadActivity();
}

// Settings > Debug: the console shows debug.rs's last lines and follows new ones while the dialog is open.
function showDebugLines(lines) {
  const atEnd = debugConsole.scrollHeight - debugConsole.scrollTop - debugConsole.clientHeight < 24;
  debugConsole.append(...lines.map((line) => `${line}
`));
  while (debugConsole.childNodes.length > DEBUG_KEEP) debugConsole.firstChild.remove();
  if (atEnd) debugConsole.scrollTop = debugConsole.scrollHeight;
}
const activityLine = ({ at, kind, text }) => `${new Date(at).toLocaleString()}  ${kind}  ${text}\n`;
let pendingActivity = null;

async function loadActivity() {
  const live = [];
  pendingActivity = live;
  $('activity-log').replaceChildren();
  $('activity-log').hidden = true;
  $('activity-state').hidden = false;
  $('activity-status').textContent = t('settings.activity.loading');
  $('activity-status').dataset.failed = false;
  $('activity-retry').hidden = true;
  const entries = await deck.activityList().catch(() => null);
  if (pendingActivity !== live) return;
  pendingActivity = null;
  if (!entries) {
    showStatus('activity-status', t('settings.activity.error'), true);
    $('activity-retry').hidden = false;
    showActivity(live);
    return;
  }
  // The saved history can already include live entries delivered during the read.
  const key = ({ at, kind, text }) => JSON.stringify([at, kind, text]);
  const seen = new Set(entries.map(key));
  $('activity-status').textContent = t('settings.activity.empty');
  showActivity([...entries, ...live.filter((entry) => !seen.has(key(entry)))]);
}

$('activity-retry').onclick = loadActivity;

function showActivity(entries) {
  const activityLog = $('activity-log');
  const atEnd = activityLog.scrollHeight - activityLog.scrollTop - activityLog.clientHeight < 24;
  activityLog.append(...entries.map(activityLine));
  activityLog.hidden = !activityLog.hasChildNodes();
  $('activity-state').hidden = !activityLog.hidden && $('activity-retry').hidden;
  if (atEnd) activityLog.scrollTop = activityLog.scrollHeight;
}
deck.onDebugLine((line) => {
  if ($('settings-dialog').open) showDebugLines([line]);
});
deck.onActivity((entry) => {
  if (!$('settings-dialog').open) return;
  if (pendingActivity) pendingActivity.push(entry);
  else showActivity([entry]);
});
$('settings-debug').onchange = (event) => {
  localStorage.setItem('debugLog', event.target.checked);
  deck.setDebug(event.target.checked);
};
$('debug-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(debugConsole.textContent);
    showStatus('debug-status', t('settings.debug.copied'));
  } catch {
    showStatus('debug-status', t('settings.debug.copy-error'), true);
  }
};
$('debug-reveal').onclick = () => deck.debugReveal();
$('debug-clear').onclick = () => {
  deck.debugClear();
  debugConsole.replaceChildren();
};
const describe = (node) => (node instanceof Element ? `${node.localName}${node.id ? `#${node.id}` : ''}${[...node.classList].map((name) => `.${name}`).join('')}` : '');
// A click names the element that got it and its parents, so a control that ignores clicks shows what covers it.
document.addEventListener('pointerdown', (event) => {
  deck.debugLog('ui', `pointerdown ${event.composedPath().slice(0, 4).map(describe).filter(Boolean).join(' < ')}`);
}, true);
window.addEventListener('error', (event) => deck.debugLog('error', `${event.message} at ${event.filename}:${event.lineno}:${event.colno}`));
window.addEventListener('unhandledrejection', (event) => deck.debugLog('error', `unhandled rejection: ${event.reason?.stack ?? event.reason}`));
$('settings-group-limit').onchange = (event) => {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    event.target.value = groupLimit();
    return;
  }
  localStorage.setItem('groupLimit', value);
  drawnSignature = '';
  if (currentIndex) renderSessions(currentIndex);
};
$('settings-handoff-auto').onchange = (event) => {
  localStorage.setItem('handoffAuto', event.target.checked);
  $('settings-handoff-delay').disabled = !event.target.checked;
};
$('settings-handoff-delay').onchange = (event) => {
  const value = Number(event.target.value);
  if (event.target.value === '' || !Number.isInteger(value) || value < 0 || value > 600) {
    event.target.value = handoffDelay();
    return;
  }
  localStorage.setItem('handoffDelay', value);
};
$('settings-handoff-note').onchange = (event) => {
  localStorage.setItem('handoffNote', event.target.checked);
  drawHandoff();
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
// A folder ({ folder }), or a sidebar group or workspace ({ group | workspace, folder }) whose servers go off on top of each chat's folder.
// Only connected servers and the ones turned off are listed; the rest wait in the Add menu.
let mcpScope = null;
let mcpShown = null;
// Saves queue on one promise, so quick toggles land in order.
let mcpSaving = Promise.resolve();
// `claude mcp list` health-checks every server, so a list stays cached and shows at once; a fresh one replaces it while untouched.
const mcpCache = new Map();
const mcpKey = (scope) => JSON.stringify([scope.global, scope.folder, scope.group, scope.workspace]);
// From Claude Code's MCP docs and `claude mcp add --help` (2026-11-15). A server whose name already appears is left out.
const MCP_RECOMMENDED = [
  { name: 'notion', transport: 'http', target: 'https://mcp.notion.com/mcp' },
  { name: 'linear', transport: 'http', target: 'https://mcp.linear.app/mcp' },
  { name: 'sentry', transport: 'http', target: 'https://mcp.sentry.dev/mcp' },
  { name: 'asana', transport: 'sse', target: 'https://mcp.asana.com/sse' },
];

function fetchMcp(scope, maxAge) {
  const key = mcpKey(scope);
  const known = mcpCache.get(key);
  if (known && Date.now() - known.at < maxAge) return known.pending;
  const pending = deck.mcpList(scope).catch((error) => ({ error: String(error) }));
  mcpCache.set(key, { pending, at: Date.now() });
  pending.then((result) => { if (result?.error && mcpCache.get(key)?.pending === pending) mcpCache.delete(key); });
  return pending;
}

// "√ Connected" or "✗ Failed to connect - ECONNREFUSED…": the words without the mark, and their first part.
function mcpStatus(status) {
  const full = status.replace(/^[^\p{L}]+/u, '');
  return { full, short: full.split(/ [—-] |: /)[0] };
}

// Checked means on in the chats this dialog applies to.
function mcpRow(row) {
  const item = node('div', 'row row--interactive');
  const label = node('label', 'row__main organize__check');
  const controls = node('div', 'row__controls');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = row.checked;
  input.dataset.name = row.name;
  // Frugal's own servers are always on: the Deck delegates through them.
  if (row.name.startsWith('plugin:frugal:')) {
    input.checked = input.disabled = true;
    item.dataset.tip = t('mcp.frugal.always-tip');
  }
  if (row.deck) input.dataset.deck = '1';
  label.append(input, node('span', 'row__name', row.name));
  item.append(label, controls);
  if (row.status) {
    const status = node('span', 'row__meta', row.status);
    status.title = row.title ?? row.status;
    controls.append(status);
  }
  if (row.signIn) {
    const button = node('button', 'btn btn--bar', row.signIn);
    button.type = 'button';
    button.dataset.tip = row.signInOn.length ? t('mcp.sign-in.accounts-tip', { accounts: row.signInOn.join(', ') }) : t('mcp.sign-in.shared-tip');
    button.onclick = () => openMcpLogin(row);
    controls.append(button);
  }
  if (row.access) {
    const state = accessState(row);
    mcpAccess.set(row.name, state);
    const button = node('button', 'btn btn--bar');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.dataset.tip = row.delegable ? t('mcp.access.kinds-tip') : t('mcp.access.chat-tip');
    button.onclick = () => openAccess(state);
    state.button = button;
    drawAccessButton(state);
    controls.append(button);
  }
  if (row.removable) {
    const button = node('button', 'btn btn--bar btn--icon');
    button.type = 'button';
    button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>';
    button.setAttribute('aria-label', t('prompt.remove-file', { name: row.name }));
    button.dataset.tip = row.deck
      ? t('mcp.remove.deck-tip')
      : t('mcp.remove.accounts-tip', { accounts: row.accounts.join(', ') });
    button.onclick = () => removeMcp(row, button);
    controls.append(button);
  }
  return item;
}

const MCP_KINDS = { claude: 'Claude', codex: 'Codex', grok: 'Grok', opencode: 'OpenCode' };
const MCP_MODES = { checked: t('mcp.access.label'), auto: t('mcp.access.auto.label'), delegates: t('mcp.access.delegates.label') };
// Per server: the accounts whose chats load it, its chat mode and the delegate kinds that may use it. The Access dialog edits and saves it.
const mcpAccess = new Map();

function accessState(row) {
  const ids = row.deck ? accountState.accounts.map((account) => account.id) : row.accountIds ?? [];
  const mode = (mcpShown.delegateOnly ?? []).includes(row.name) ? 'delegates' : (mcpShown.auto ?? []).includes(row.name) ? 'auto' : 'checked';
  const kinds = row.delegable ? ((mcpShown.noDelegate ?? []).includes(row.name) ? [] : mcpShown.kinds?.[row.name] ?? Object.keys(MCP_KINDS)) : null;
  return { row, ids, off: new Set((mcpShown.accountsOff?.[row.name] ?? []).filter((id) => ids.includes(id))), mode, kinds, button: null };
}

function drawAccessButton(state) {
  state.button.textContent = MCP_MODES[state.mode];
  state.button.toggleAttribute('data-mode', state.mode !== 'checked');
}

function openAccess(state) {
  const { row } = state;
  const dialog = $('mcp-access-dialog');
  $('mcp-access-title').textContent = t('mcp.access.title', { name: row.name });
  const box = (text, checked, value) => {
    const label = node('label', 'organize__check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.value = value;
    label.append(input, text);
    return label;
  };
  const kinds = $('mcp-access-kinds');
  kinds.hidden = !state.kinds;
  kinds.querySelector('.access__list').replaceChildren(...Object.entries(MCP_KINDS).map(([kind, label]) => box(label, Boolean(state.kinds?.includes(kind)), kind)));
  const sync = () => {
    for (const radio of dialog.querySelectorAll('[name="mcp-access-mode"]')) radio.checked = radio.value === state.mode;
    for (const input of kinds.querySelectorAll('input')) input.checked = Boolean(state.kinds?.includes(input.value));
  };
  sync();
  // Moving a server to the Deck lets every account and delegate run it.
  const move = $('mcp-access-move');
  move.replaceChildren();
  if (row.import || row.everywhere) {
    const button = node('button', 'btn', row.import ? t('mcp.add.submit.label') : t('mcp.access.use-everywhere'));
    button.type = 'button';
    button.onclick = () => {
      dialog.close();
      if (row.import) showMcpForm(row.import);
      else useEverywhere(row, state.button);
    };
    move.append(node('span', 'access__legend', t('mcp.access.every-account')), node('p', 'settings__hint', row.import
      ? t('mcp.access.import-hint', { accounts: row.accounts.join(', ') })
      : t('mcp.access.move-hint', { target: row.everywhere.target })), button);
  }
  showStatus('mcp-access-status', '');
  // Each change saves at once; a failed save puts the previous choice back.
  const onchange = dialog.onchange = () => {
    const previous = { mode: state.mode, kinds: state.kinds };
    state.mode = dialog.querySelector('[name="mcp-access-mode"]:checked')?.value ?? 'checked';
    if (state.kinds) state.kinds = [...kinds.querySelectorAll('input:checked')].map((input) => input.value);
    const next = { mode: state.mode, kinds: state.kinds };
    drawAccessButton(state);
    saveMcp('mcp-access-status', () => {
      if (state.mode !== next.mode || state.kinds !== next.kinds) return;
      Object.assign(state, previous);
      drawAccessButton(state);
      if (dialog.open && dialog.onchange === onchange) sync();
    });
  };
  dialog.showModal();
}

// A claude.ai connector lives in one Claude account; its URL as a Deck server reaches every account and delegate, and replaces the connector in chats.
async function useEverywhere(row, button) {
  button.disabled = true;
  const { name, transport, target } = row.everywhere;
  const message = $('mcp-error');
  message.hidden = false;
  const added = await deck.mcpAdd({ name, transport, target }).catch((error) => ({ error: String(error) }));
  // On everywhere the connector was on; chats deny the connector by name while its copy loads.
  const global = mcpShown.global ?? [];
  const result = added?.error || !global.includes(row.name) ? added : await deck.mcpSet({ global: true }, [], [...global, name]).catch((error) => ({ error: String(error) }));
  if (result?.error) {
    message.textContent = result.error;
    button.disabled = false;
    return;
  }
  message.textContent = t('mcp.access.moved', { previous: row.name, name });
  refreshMcp();
}

// Unlike its checkbox, which applies to this folder, group or workspace, removing reaches every folder and delegated work.
async function removeMcp(row, button) {
  const text = row.deck ? t('mcp.remove.deck-text') : t('mcp.remove.account-text', { accounts: row.accounts.join(', ') });
  if (!await askConfirm(t('organize.remove.title', { name: row.name }), text, t('common.remove'), true)) return;
  button.disabled = true;
  const result = await deck.mcpRemove(row.name, Boolean(row.deck), mcpScope).catch((error) => ({ error: String(error) }));
  const message = $('mcp-error');
  message.hidden = false;
  if (result?.error) {
    message.textContent = result.error;
    button.disabled = false;
    return;
  }
  message.textContent = t('mcp.remove.done', { name: row.name });
  button.closest('.row').remove();
  mcpAccess.delete(row.name);
  refreshMcp();
}

// After a change outside the checkboxes: a fresh list once queued saves land, drawn unless another save started meanwhile.
function refreshMcp() {
  mcpCache.clear();
  const scope = mcpScope;
  const saving = mcpSaving;
  if (scope && $('mcp-dialog').open) saving.then(() => fetchMcp(scope, 0)).then((result) => { if (mcpScope === scope && mcpSaving === saving && $('mcp-dialog').open) drawMcp(result); });
}

// An MCP sign-in in a window over the Deck: Claude Code on the chosen account opens /mcp, and closing the window ends it.
let mcpLogin = null;

function openMcpLogin(row) {
  const accounts = accountState.accounts.filter((account) => account.signedIn);
  const fallback = accounts.find((account) => account.id === chats.get(activeId)?.account) ?? accounts[0];
  const select = $('mcp-login-account');
  select.replaceChildren(...accounts.map((account) => new Option(account.name, account.id)));
  select.value = (accounts.find((account) => row.signInOn.includes(account.name)) ?? fallback)?.id ?? '';
  $('mcp-login-title').textContent = t('account.sign-in.folder', { name: row.name });
  $('mcp-login').showModal();
  mcpLogin = { row };
  startMcpLogin();
}

async function startMcpLogin() {
  const { row } = mcpLogin;
  stopMcpLogin();
  const term = new Terminal(termOptions());
  const fit = new FitAddon();
  term.loadAddon(fit);
  $('mcp-login-term').replaceChildren();
  term.open($('mcp-login-term'));
  fit.fit();
  const id = crypto.randomUUID();
  mcpLogin = { id, row, term };
  term.onData((data) => deck.input(id, data));
  term.focus();
  const accountId = $('mcp-login-account').value;
  if (!accountId) return term.write(t('mcp-login.no-account'));
  // The home folder asks for trust on every run, so a global sign-in runs in the default chat folder.
  const folder = mcpScope?.global ? await deck.defaultFolder().catch(() => null) : mcpScope?.folder ?? null;
  const result = await deck.mcpLogin({ id, cols: term.cols, rows: term.rows, accountId, folder, deckServer: row.deck ? row.name : null })
    .catch((error) => ({ error: String(error) }));
  if (result?.error && mcpLogin?.id === id) term.write(result.error);
}

function stopMcpLogin() {
  if (!mcpLogin?.id) return;
  deck.kill(mcpLogin.id);
  mcpLogin.term.dispose();
  mcpLogin.id = null;
}

function closeMcpLogin() {
  stopMcpLogin();
  mcpLogin = null;
  $('mcp-login').close();
  refreshMcp();
}

deck.onData((id, data) => { if (mcpLogin?.id === id) mcpLogin.term.write(data); });
// Leaving Claude Code closes the window; a failed start stays open to show why.
deck.onExit((id, code) => { if (mcpLogin?.id === id && code === 0) closeMcpLogin(); });
$('mcp-login-account').onchange = startMcpLogin;
$('mcp-login-close').onclick = closeMcpLogin;

// A server the backup holds that is gone from its account, folder or the Deck; Restore puts its saved config back.
function removedRow(entry) {
  const row = node('div', 'row');
  const main = node('div', 'row__main');
  const controls = node('div', 'row__controls');
  const where = entry.folder ? t('mcp.removed.location', { account: entry.account, folder: entry.folder }) : entry.account;
  const status = node('span', 'row__meta', where);
  status.title = t('mcp.removed.location-tip', { target: entry.target, where });
  const button = node('button', 'btn btn--bar', t('common.restore'));
  button.type = 'button';
  button.onclick = async () => {
    button.disabled = true;
    const result = await deck.mcpRestore(entry.owner, entry.place, entry.name).catch((error) => ({ error: String(error) }));
    const message = $('mcp-error');
    message.hidden = false;
    if (result?.error) {
      message.textContent = result.error;
      button.disabled = false;
      return;
    }
    message.textContent = t('mcp.removed.restored', { name: entry.name, where });
    mcpCache.clear();
    row.remove();
  };
  main.append(node('span', 'row__name', entry.name));
  controls.append(status, button);
  row.append(main, controls);
  return row;
}

function mcpSection(title, rows, empty) {
  const section = node('section', 'mcp__section');
  section.append(node('h4', 'dialog__section', title));
  if (rows.length) section.append(...rows.map(mcpRow));
  else section.append(node('p', 'mcp__empty', empty));
  return section;
}

// `claude mcp list` never sees Deck servers: they reach chats through --mcp-config, so only /mcp checks or signs them in.
// Signed in: an account holds a live token for it, and every account shares it. Needs sign-in: a chat was asked to sign in and no token came since.
function deckRow(name, config, checked, signedIn, needsAuth) {
  const remote = config.type !== 'stdio';
  return { name, deck: true, checked, status: remote ? (needsAuth ? t('mcp.status.needs-sign-in') : signedIn ? t('mcp.status.signed-in') : t('mcp.status.checked')) : t('mcp.status.local'), title: remote ? config.url : undefined,
    signIn: remote && !signedIn ? t('account.steps.sign-in') : null, signInOn: [], removable: true, access: !name.startsWith('plugin:frugal:'), delegable: true };
}

function drawMcp(result) {
  const list = $('mcp-list');
  if (result?.error) {
    list.replaceChildren(emptyState(result.error, () => {
      list.replaceChildren(emptyState(t('common.loading')));
      refreshMcp();
    }));
    return;
  }
  mcpShown = result;
  mcpAccess.clear();
  const global = new Set(result.global ?? []);
  const off = new Set(result.off ?? []);
  const on = new Set(result.on ?? []);
  const checked = (name) => (mcpScope?.global ? global.has(name) : (global.has(name) || on.has(name)) && !off.has(name));
  const deckServers = Object.entries(result.deck ?? {});
  // A server imported into the Deck shows once, as the Deck's: same name, same on and off, and it runs on any account.
  // A claude.ai connector moved to the Deck shows only as its Deck copy, and comes back when that copy is removed.
  const deckUrls = new Set(deckServers.map(([, config]) => config.url).filter(Boolean));
  const moved = (result.servers ?? []).filter(({ name, target }) => /^claude\.ai /.test(name) && deckUrls.has(target)).map(({ name }) => name);
  const rows = (result.servers ?? []).filter(({ name }) => !result.deck?.[name] && !moved.includes(name)).map(({ name, status, target, transport, accounts, accountIds, statuses = {} }) => {
    // Connected only when every account that has it connects; otherwise the first failing account's status, and where it fails.
    const failing = Object.entries(statuses).filter(([, each]) => !/^connected$/i.test(mcpStatus(each).short));
    const { full, short } = mcpStatus(failing[0]?.[1] ?? status);
    const failingAccounts = failing.map(([account]) => account);
    const withAccounts = (status) => failingAccounts.length && failingAccounts.length < accounts.length
      ? t('mcp.status.in-accounts', { status, accounts: failingAccounts.join(', ') }) : status;
    // A plain account server missing from some account can become a Deck server; claude.ai connectors and plugin servers cannot.
    const own = !/^(claude\.ai |plugin:)/.test(name) && /^[A-Za-z0-9][\w-]{0,63}$/.test(name);
    const portable = own && accounts.length < result.accounts;
    const copy = name.replace(/^claude\.ai /, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 64);
    const everywhere = /^claude\.ai /.test(name) && /^https?:\/\/\S+$/.test(target) && copy && !result.deck?.[copy] && accounts.length < result.accounts
      ? { name: copy, transport, target } : null;
    const connected = /^connected$/i.test(short);
    return { name, accounts, status: withAccounts(short), title: t('mcp.status.details', { status: withAccounts(full), target, accounts: accounts.join(', ') }), checked: checked(name),
      connected, removable: own, access: !name.startsWith('plugin:frugal:'), delegable: own, accountIds, everywhere, import: portable ? { name, transport, target } : null, signIn: connected ? null : /auth/i.test(full) ? t('account.steps.sign-in') : t('mcp.reconnect'),
      signInOn: failingAccounts.length ? failingAccounts : accounts };
  });
  const listed = new Set([...rows.map((row) => row.name), ...deckServers.map(([name]) => name), ...moved]);
  const gone = new Set((result.removed ?? []).map((entry) => entry.name));
  for (const name of new Set([...global, ...on, ...off])) if (!listed.has(name) && !gone.has(name)) rows.push({ name, status: t('mcp.status.not-listed'), checked: checked(name), connected: true, access: !name.startsWith('plugin:frugal:') });
  const frugal = (row) => row.name.startsWith('plugin:frugal:');
  const sections = [
    ...(rows.some(frugal) ? [mcpSection(t('mcp.frugal.title'), rows.filter(frugal), '')] : []),
    mcpSection(t('mcp.account-servers.title'), rows.filter((row) => row.connected && !frugal(row)), t('mcp.account-servers.empty')),
    Object.assign(mcpSection(t('mcp.deck-servers.title'), deckServers.map(([name, config]) => deckRow(name, config, checked(name), (result.signedIn ?? []).includes(name), (result.needsAuth ?? []).includes(name))), t('mcp.deck-servers.empty')), { id: 'mcp-deck' }),
  ];
  list.replaceChildren(...sections);
  // Not connected and Removed get their own sections, shown in the nav only when they hold something.
  const failing = rows.filter((row) => !row.connected && !frugal(row));
  const removed = result.removed ?? [];
  $('mcp-failing').replaceChildren(...failing.map(mcpRow));
  $('mcp-removed').replaceChildren(...removed.map(removedRow));
  for (const [tab, count] of [['mcp-tab-failing', failing.length], ['mcp-tab-removed', removed.length]]) {
    $(tab).hidden = !count;
    $(tab).querySelector('.settings__count').textContent = count;
  }
  if ($('mcp-dialog').querySelector('.settings__tab[aria-current][hidden]')) showSection($('mcp-dialog'), 'servers');
  const names = [...rows.map((row) => row.name), ...deckServers.map(([name]) => name)].map((name) => name.toLowerCase());
  drawMcpSuggestions(MCP_RECOMMENDED.filter((server) => !names.some((name) => name.includes(server.name))));
}

function drawMcpSuggestions(servers) {
  const chip = (label, onclick) => {
    const button = node('button', 'btn btn--bar');
    button.type = 'button';
    button.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>';
    button.append(label);
    button.onclick = onclick;
    return button;
  };
  $('mcp-suggest').replaceChildren(...servers.map((server) => {
    const button = chip(server.name, () => showMcpForm(server));
    button.dataset.tip = server.target;
    button.dataset.name = server.name;
    return button;
  }), chip(t('mcp.add.custom'), () => showMcpForm({ name: '', transport: 'http', target: '' })));
  $('mcp-add-section').hidden = false;
}

async function openMcpDialog(scope) {
  await mcpSaving; // Queued saves read the rows shown now.
  mcpScope = scope;
  mcpShown = null;

  $('mcp-folder').textContent = $('mcp-folder').title = scope.global ? t('mcp.scope.all') : scope.workspace ?? groupLabel(scope.group) ?? scope.folder;
  showSection($('mcp-dialog'), 'servers');
  mcpAccess.clear();
  for (const id of ['mcp-failing', 'mcp-removed']) $(id).replaceChildren();
  $('mcp-tab-failing').hidden = $('mcp-tab-removed').hidden = true;
  const signIn = t('mcp.scope.sign-in');
  $('mcp-note').textContent = scope.global
    ? t('mcp.scope.global-note', { signIn })
    : scope.workspace ? t('mcp.scope.workspace-note', { signIn })
    : scope.group ? t('mcp.scope.group-note', { signIn })
    : t('mcp.scope.folder-note', { signIn });
  $('mcp-add-section').hidden = true;
  $('mcp-new').hidden = true;
  $('mcp-task').value = '';
  $('mcp-ask').value = '';
  syncMcpAsk();
  $('mcp-list').replaceChildren(emptyState(t('common.loading')));
  $('mcp-error').hidden = true;
  $('mcp-dialog').showModal();
  const saving = mcpSaving;
  const known = mcpCache.get(mcpKey(scope));
  const fresh = fetchMcp(scope, 30_000);
  if (known && known.pending !== fresh) {
    const cached = await known.pending;
    if (mcpScope === scope && mcpSaving === saving && !cached?.error) drawMcp(cached);
  }
  const result = await fresh;
  if (mcpScope === scope && mcpSaving === saving) drawMcp(result);
}

function syncMcpTarget() {
  const stdio = $('mcp-new-transport').value === 'stdio';
  $('mcp-new-target-label').textContent = stdio ? t('task.command') : t('mcp.add.url');
  $('mcp-new-target').placeholder = stdio ? t('mcp.add.command-placeholder') : t('mcp.add.url-placeholder');
}

function showMcpForm(server) {
  $('mcp-new-name').value = server.name;
  $('mcp-new-transport').value = server.transport;
  $('mcp-new-target').value = server.target;
  syncMcpTarget();
  $('mcp-new').hidden = false;
  showSection($('mcp-dialog'), 'add');
  (server.name ? $('mcp-new-add') : $('mcp-new-name')).focus();
}

$('mcp-dialog').onchange = ({ target }) => {
  if (!target.matches('input[data-name]')) return;
  const checked = target.checked;
  saveMcp('mcp-error', () => { if (target.checked === checked) target.checked = !checked; });
};
// One Haiku request at low effort, as mcp_from_prompt in organizer.rs sends it: ~1,400 tokens of overhead, ~110 of instructions, ~80 out, plus the description.
const mcpAskTokens = (text) => 1590 + Math.ceil(text.length / 4);
function syncMcpAsk() {
  const text = $('mcp-ask').value.trim();
  $('mcp-ask-run').disabled = !text;
  const tokens = mcpAskTokens(text);
  $('mcp-ask-cost').textContent = text ? tp('mcp.add.estimate', tokens, { count: tokens.toLocaleString() }) : '';
}
$('mcp-ask').oninput = syncMcpAsk;
$('mcp-ask').onkeydown = (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('mcp-ask-run').click();
};
$('mcp-ask-run').onclick = async () => {
  const scope = mcpScope;
  const text = $('mcp-ask').value.trim();
  if (!scope || !text || $('mcp-ask-run').disabled) return;
  $('mcp-ask-run').disabled = true;
  $('mcp-ask-cost').textContent = t('mcp.add.asking');
  const reply = await deck.mcpFromPrompt(text).catch((error) => ({ error: String(error) }));
  if (mcpScope !== scope) return;
  syncMcpAsk();
  const server = reply?.server;
  if (reply?.error || !server?.name) {
    $('mcp-ask-cost').textContent = reply?.error ?? t('mcp.add.no-server');
    return;
  }
  showMcpForm({ name: server.name, transport: server.transport, target: server.target ?? '' });
  $('mcp-ask-cost').textContent = server.note || t('mcp.add.check-target');
};
$('mcp-new-transport').onchange = syncMcpTarget;
$('mcp-new-cancel').onclick = () => { $('mcp-new').hidden = true; };
$('mcp-new-add').onclick = async () => {
  const scope = mcpScope;
  if (!scope) return;
  const server = { name: $('mcp-new-name').value.trim(), transport: $('mcp-new-transport').value, target: $('mcp-new-target').value.trim() };
  const result = await deck.mcpAdd(server).catch((error) => ({ error: String(error) }));
  if (mcpScope !== scope) return;
  const message = $('mcp-error');
  message.hidden = false;
  if (result?.error) { message.textContent = result.error; return; }
  mcpCache.clear();
  $('mcp-new').hidden = true;
  const section = $('mcp-deck');
  section?.querySelector('.mcp__empty')?.remove();
  for (const input of $('mcp-dialog').querySelectorAll(`input[data-name="${CSS.escape(server.name)}"]`)) input.closest('.row').remove();
  const row = mcpRow(deckRow(server.name, server.transport === 'stdio' ? { type: 'stdio' } : { url: server.target }, true));
  section?.append(row);
  showSection($('mcp-dialog'), 'servers');
  $('mcp-suggest').querySelector(`[data-name="${CSS.escape(server.name)}"]`)?.remove();
  // On here at once; a failed save leaves it in the Deck, unchecked.
  saveMcp('mcp-error', () => { row.querySelector('input').checked = false; }, t('mcp.add.added', { name: server.name }));
};
function saveMcp(status, revert, text = t('common.saved')) {
  mcpSaving = mcpSaving.then(() => writeMcp().catch(String)).then((error) => {
    if (error) revert();
    showStatus(status, error || text, Boolean(error));
  });
}
// Writes what the rows show when its turn in the queue comes; returns an error message or null.
async function writeMcp() {
  if (!mcpScope || !mcpShown) return null;
  // Only the difference from the global list is kept, and names this list did not show stay as they were.
  const inputs = [...$('mcp-dialog').querySelectorAll('.row input[data-name]')];
  const shown = new Set(inputs.map((input) => input.dataset.name));
  const kept = (names) => new Set((names ?? []).filter((name) => !shown.has(name)));
  const global = new Set(mcpShown.global ?? []);
  const on = kept(mcpScope.global ? mcpShown.global : mcpShown.on);
  const off = kept(mcpShown.off);
  for (const { checked, dataset: { name } } of inputs) {
    if (mcpScope.global) { if (checked) on.add(name); }
    else if (checked && !global.has(name)) on.add(name);
    else if (!checked && global.has(name)) off.add(name);
  }
  const scope = mcpScope.global ? { global: true } : { folder: mcpScope.folder, group: mcpScope.group, workspace: mcpScope.workspace };
  const saved = await deck.mcpSet(scope, [...off], [...on]).catch((error) => ({ error: String(error) }));
  if (saved?.error) return saved.error;
  // An account the list did not show keeps its setting.
  const access = {};
  for (const [name, state] of mcpAccess) {
    const accountsOff = (mcpShown.accountsOff?.[name] ?? []).filter((id) => !state.ids.includes(id));
    accountsOff.push(...state.off);
    access[name] = { accountsOff, delegateOnly: state.mode === 'delegates', auto: state.mode === 'auto' };
    if (state.kinds) access[name].kinds = state.kinds;
  }
  const applied = Object.keys(access).length ? await deck.mcpAccessSet(access).catch((error) => ({ error: String(error) })) : null;
  if (applied?.error) return applied.error;
  mcpCache.clear();
  return null;
}
let pluginsShown = null;
let pluginSuggestion = null;
let pluginsVisit = 0;

function drawPlugins(result, states = result.states) {
  pluginsShown = result;
  $('plugins-list').replaceChildren(...result.plugins.map((plugin, index) => {
    const row = node('div', 'row');
    row.dataset.plugin = plugin.id;
    const info = node('div', 'row__main');
    const controls = node('div', 'row__controls');
    info.append(node('span', 'row__name', plugin.id));
    if (plugin.description) {
      const description = node('span', 'row__meta', plugin.description);
      description.title = plugin.description;
      info.append(description);
    }
    const group = node('div', 'segmented');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', plugin.id);
    const state = states?.[plugin.id] ?? 'on';
    for (const [value, text] of [['on', t('plugins.state.on')], ['auto', t('mcp.access.auto.label')], ['off', t('settings.voice.input.off')]]) {
      const label = node('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `plugin-${index}`;
      input.value = value;
      input.checked = value === state;
      label.append(input, text);
      group.append(label);
    }
    row.dataset.state = state;
    controls.append(group);
    row.append(info, controls);
    return row;
  }));
  if (!result.plugins.length) $('plugins-list').append(emptyState(t('plugins.installed.empty')));
}

// The row's radio and data-state hold the state the latest change asked for.
function setPluginState(row, state) {
  row.querySelector(`input[value="${state}"]`).checked = true;
  row.dataset.state = state;
}

// Saves queue on one promise, so quick changes land in order; each writes what the rows show when its turn comes.
let pluginsSaving = Promise.resolve();
function savePlugins(revert, text = t('common.saved')) {
  pluginsSaving = pluginsSaving.then(async () => {
    if (!pluginsShown) return;
    try {
      await deck.pluginsSet(pluginStates());
      showStatus('plugins-error', text);
    } catch (error) {
      revert();
      showStatus('plugins-error', String(error), true);
    }
  });
}

$('plugins-list').onchange = ({ target }) => {
  const row = target.closest('[data-plugin]');
  if (!row) return;
  const previous = row.dataset.state;
  row.dataset.state = target.value;
  savePlugins(() => { if (row.dataset.state === target.value) setPluginState(row, previous); });
};

function pluginStates() {
  const states = { ...pluginsShown.states };
  for (const row of $('plugins-list').querySelectorAll('[data-plugin]')) {
    const state = row.querySelector('input:checked')?.value ?? 'on';
    if (state === 'on') delete states[row.dataset.plugin];
    else states[row.dataset.plugin] = state;
  }
  return states;
}

async function openPluginsDialog() {
  await pluginsSaving; // Queued saves read the rows shown now.
  const visit = ++pluginsVisit;
  pluginsShown = null;
  pluginSuggestion = null;
  $('plugins-confirm').hidden = true;
  $('plugins-error').hidden = true;
  $('plugins-request').value = '';
  $('plugins-task').value = '';
  showSection($('plugins-dialog'), 'installed');
  $('plugins-dialog').showModal();
  await loadPlugins(visit);
}

async function loadPlugins(visit = ++pluginsVisit) {
  $('plugins-list').replaceChildren(emptyState(t('common.loading')));
  try {
    const result = await deck.pluginsList();
    if (visit === pluginsVisit) drawPlugins(result);
  } catch (error) {
    if (visit === pluginsVisit) $('plugins-list').replaceChildren(emptyState(String(error), () => loadPlugins()));
  }
}

let cleanChoices = [];
let cleanVisit = 0;

function cleanActions(item) {
  if (item.kind === 'copy') return ['remove', 'keep'];
  if (item.kind === 'account') return ['import', 'keep'];
  if (item.status === "can't import") return ['keep', 'remove'];
  const places = item.places;
  const desktop = item.kind === 'mcp' && places.some((place) => place.scope === 'desktop')
    && places.every((place) => place.scope === 'desktop' || place.account === 'Deck store');
  return desktop ? ['keep', 'import'] : ['import', 'keep', 'remove'];
}

const CLEAN_ACTION_LABELS = { import: t('settings.general.external.import'), keep: t('clean.action.keep'), remove: t('common.remove') };

function fillClean(id, items, cells) {
  const table = $(id);
  const body = table.tBodies[0];
  table.hidden = !items.length;
  $(`${id}-count`).textContent = tp('clean.item-count', items.length);
  body.replaceChildren();
  for (const item of items) {
    const row = body.insertRow();
    for (const value of cells(item)) row.insertCell().textContent = value;
    const select = node('select', 'settings__select');
    select.setAttribute('aria-label', t(`clean.action-for.${item.kind}`, { name: item.name }));
    // For a plugin the store already has, remove drops only the accounts' copies: the store's stays the one in use.
    for (const action of cleanActions(item)) {
      const label = action === 'remove' && item.status === 'in store' ? t('clean.action.use-store') : CLEAN_ACTION_LABELS[action];
      select.add(new Option(label, action));
    }
    select.value = item.action;
    row.insertCell().append(select);
    cleanChoices.push({ item, select });
  }
}

// Indeterminate while scanning; Apply fills it from the backend's consolidate:progress steps.
function cleanBusy(step, done, total) {
  $('clean-busy').hidden = step == null;
  $('clean-choices').disabled = step != null;
  $('clean-step').textContent = step ?? '';
  const bar = $('clean-progress');
  if (total) { bar.max = total; bar.value = done; } else bar.removeAttribute('value');
}

const placeText = (place) => [place.account, place.scope, place.version ?? place.projectPath].filter(Boolean).join(' / ');

function cleanStatus(text) {
  const status = $('clean-status');
  status.textContent = text;
  status.hidden = !text;
}

// Sessions stay out: removing transcripts while chats run is unsafe, and that stays in the uninstaller.
async function openCleanDialog() {
  const visit = ++cleanVisit;
  cleanChoices = [];
  cleanStatus('');
  $('clean-empty').hidden = true;
  cleanBusy(t('clean.scanning'));
  $('clean-apply').disabled = true;
  for (const id of ['clean-plugins', 'clean-mcp', 'clean-accounts', 'clean-copies-more']) $(id).hidden = true;
  if (!$('clean-dialog').open) $('clean-dialog').showModal();
  try {
    const inventory = await deck.cleanInventory();
    if (visit !== cleanVisit || !$('clean-dialog').open) return;
    fillClean('clean-plugins', inventory.plugins, (item) => [item.name, item.places.map(placeText).join('\n'), item.store_version ?? '—', item.status]);
    fillClean('clean-mcp', inventory.mcp, (item) => [item.name, item.places.map(placeText).join('\n'), item.status]);
    fillClean('clean-accounts', inventory.accounts, (item) => [item.account]);
    // A copy is <account>/plugins/cache/<market>/<plugin>/<version>.
    fillClean('clean-copies', inventory.copies, (item) => {
      const [market, plugin, version] = item.name.split(/[\\/]/).slice(-3);
      return [item.account, `${plugin}@${market}`, version];
    });
    $('clean-copies-more').hidden = !inventory.copies.length;
    $('clean-empty').hidden = Boolean(inventory.plugins.length || inventory.mcp.length || inventory.accounts.length || inventory.copies.length);
  } catch (error) {
    if (visit === cleanVisit && $('clean-dialog').open) cleanStatus(String(error));
  } finally {
    if (visit === cleanVisit) {
      cleanBusy();
      $('clean-apply').disabled = false;
    }
  }
}

$('plugins-open').onclick = openPluginsDialog;
for (const [button, dialog] of [['plugins-clean', 'plugins-dialog'], ['mcp-clean', 'mcp-dialog']]) {
  $(button).onclick = () => { $(dialog).close(); openCleanDialog(); };
}
$('clean-cancel').onclick = () => $('clean-dialog').close();
for (const id of ['mcp', 'plugins', 'clean']) $(id + '-close').onclick = () => $(id + '-dialog').close();
$('clean-recommended').onclick = () => { for (const { item, select } of cleanChoices) select.value = item.action; };
$('clean-keep').onclick = () => { for (const { select } of cleanChoices) select.value = 'keep'; };
$('clean-apply').onclick = async () => {
  const picked = cleanChoices
    .filter(({ select }) => select.value !== 'keep')
    .map(({ item, select }) => ({ kind: item.kind, name: item.name, action: select.value }));
  if (!picked.length) { $('clean-dialog').close(); return; }
  const removing = picked.filter((item) => item.action === 'remove').length;
  if (removing && !await askConfirm(tp('clean.remove.title', removing), t('clean.remove.text'), t('common.remove'), true)) return;
  const visit = cleanVisit;
  $('clean-apply').disabled = true;
  cleanStatus('');
  cleanBusy(t('clean.backing-up'), 0, picked.length + 1);
  try {
    const { zip, errors } = await deck.cleanApply(picked);
    const imported = picked.filter((item) => item.kind === 'plugin' && item.action === 'import').map((item) => item.name);
    if (imported.length) errors.push(...await deck.cleanUpdate(imported));
    deck.activityAdd('clean', `Import and clean: ${picked.map((item) => `${item.action} ${item.kind} ${item.name}`).join(', ')}${errors.length ? `. Failed: ${errors.join('; ')}` : ''}${zip ? `. Backup: ${zip}` : ''}`.slice(0, 4000));
    if (visit !== cleanVisit || !$('clean-dialog').open) return;
    if (!errors.length) {
      const count = picked.length;
      const text = tp('clean.applied', count);
      await openCleanDialog();
      if ($('clean-dialog').open && $('clean-status').hidden) showStatus('clean-status', text);
      return;
    }
    cleanStatus([zip ? t('clean.backup', { zip }) : '', ...errors].filter(Boolean).join('\n'));
  } catch (error) {
    deck.activityAdd('clean', `Import and clean failed: ${error}`.slice(0, 4000));
    if (visit === cleanVisit && $('clean-dialog').open) cleanStatus(String(error));
  } finally {
    if (visit === cleanVisit && $('clean-dialog').open) {
      cleanBusy();
      $('clean-apply').disabled = false;
    }
  }
};
deck.onCleanProgress(({ done, total, step }) => {
  if (!$('clean-busy').hidden) cleanBusy(tp('clean.progress', total, { step, done }), done, total);
});
$('plugins-find').onclick = async () => {
  const request = $('plugins-request').value.trim();
  if (!request) return;
  const visit = pluginsVisit;
  $('plugins-find').disabled = true;
  $('plugins-confirm').hidden = true;
  pluginSuggestion = null;
  try {
    const result = await deck.pluginFind(request);
    if (visit !== pluginsVisit || !$('plugins-dialog').open) return;
    if (result.none) { $('plugins-error').textContent = result.none; $('plugins-error').hidden = false; return; }
    pluginSuggestion = result.id;
    $('plugins-suggestion').textContent = t('plugins.install.suggestion', { id: result.id, why: result.why });
    $('plugins-confirm').hidden = false;
  } catch (error) {
    if (visit === pluginsVisit) { $('plugins-error').textContent = String(error); $('plugins-error').hidden = false; }
  } finally { $('plugins-find').disabled = false; }
};
$('plugins-install-cancel').onclick = () => { pluginSuggestion = null; $('plugins-confirm').hidden = true; };
$('plugins-install').onclick = async () => {
  if (!pluginSuggestion || !pluginsShown) return;
  const visit = pluginsVisit;
  $('plugins-install').disabled = true;
  try {
    const output = await deck.pluginInstall(pluginSuggestion);
    const result = await deck.pluginsList();
    if (visit !== pluginsVisit || !$('plugins-dialog').open) return;
    drawPlugins(result, pluginStates());
    showSection($('plugins-dialog'), 'installed');
    pluginSuggestion = null;
    $('plugins-confirm').hidden = true;
    $('plugins-error').textContent = output;
    $('plugins-error').hidden = false;
  } catch (error) {
    if (visit === pluginsVisit) { $('plugins-error').textContent = String(error); $('plugins-error').hidden = false; }
  } finally { $('plugins-install').disabled = false; }
};

for (const prefix of ['mcp', 'plugins']) {
  $(prefix + '-forget-picks').onclick = async () => {
    const button = $(prefix + '-forget-picks');
    button.disabled = true;
    try {
      await deck.autoPicksClear();
      showStatus(prefix + '-error', t('common.forgot-picks'));
    } catch (error) {
      showStatus(prefix + '-error', String(error), true);
    } finally { button.disabled = false; }
  };
  $(prefix + '-recommend').onclick = async () => {
    const task = $(prefix + '-task').value.trim();
    if (!task || (prefix === 'mcp' ? !mcpShown : !pluginsShown)) return;
    const scope = mcpScope;
    const visit = pluginsVisit;
    const button = $(prefix + '-recommend');
    const message = $(prefix + '-error');
    button.disabled = true;
    try {
      const reply = await deck.recommend(task);
      if (!$(prefix + '-dialog').open || (prefix === 'mcp' ? scope !== mcpScope : visit !== pluginsVisit)) return;
      // Applied and saved at once; a failed save puts back each choice nobody changed since.
      const undo = [];
      if (prefix === 'mcp') {
        for (const input of $('mcp-dialog').querySelectorAll('.row input[data-name]')) {
          const suggestion = reply.mcp[input.dataset.name];
          if (!suggestion || input.disabled) continue;
          const checked = input.checked;
          input.checked = suggestion.state !== 'off';
          undo.push(() => { if (input.checked !== checked) input.checked = checked; });
          input.closest('.row').dataset.tip = suggestion.why;
          const state = mcpAccess.get(input.dataset.name);
          if (!state) continue;
          const mode = state.mode;
          state.mode = ['auto', 'delegates'].includes(suggestion.state) ? suggestion.state : 'checked';
          const next = state.mode;
          undo.push(() => { if (state.mode === next) { state.mode = mode; drawAccessButton(state); } });
          drawAccessButton(state);
        }
      } else {
        for (const row of $('plugins-list').querySelectorAll('[data-plugin]')) {
          const suggestion = reply.plugins[row.dataset.plugin];
          if (!suggestion) continue;
          if (row.querySelector(`input[value="${CSS.escape(suggestion.state)}"]`)) {
            const previous = row.dataset.state;
            setPluginState(row, suggestion.state);
            undo.push(() => { if (row.dataset.state === suggestion.state) setPluginState(row, previous); });
          }
          row.dataset.tip = suggestion.why;
        }
      }
      showSection($(prefix + '-dialog'), prefix === 'mcp' ? 'servers' : 'installed');
      const revert = () => { for (const step of undo) step(); };
      if (prefix === 'mcp') saveMcp('mcp-error', revert, t('common.suggestions-applied'));
      else savePlugins(revert, t('common.suggestions-applied'));
    } catch (error) {
      message.textContent = String(error);
      message.hidden = false;
    } finally { button.disabled = false; }
  };
}

$('mcp-servers').onclick = () => {
  const chat = chats.get(activeId);
  if (!chat) return;
  // The chat's group, else its workspace, else its folder: the most specific scope its launch reads.
  const placed = chatsById.get(currentIndex?.sessions.find((s) => s.id === chat.id)?.chatId);
  openMcpDialog(placed?.topic ? { group: placed.topic, folder: chat.cwd } : placed?.space ? { workspace: placed.space, folder: chat.cwd } : { folder: chat.cwd });
};
$('mcp-servers').onpointerenter = () => {
  const chat = chats.get(activeId);
  if (chat) fetchMcp({ folder: chat.cwd }, 30_000);
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
for (const [id, key] of [['settings-mic', 'allowMic'], ['settings-clipboard', 'allowClipboard']]) {
  $(id).onchange = (event) => {
    localStorage.setItem(key, event.target.checked);
    applyPermissions();
  };
}
for (const [name, hue] of ACCENTS) {
  const swatch = Object.assign(document.createElement('input'), { type: 'radio', name: 'accent', value: hue });
  swatch.setAttribute('aria-label', name);
  swatch.dataset.tip = name;
  swatch.style.setProperty('--hue', hue);
  $('settings-accent').append(swatch);
}
$('settings-accent').onchange = (event) => {
  localStorage.setItem('accentHue', event.target.value);
  applyAccent();
};
$('settings-keep-transcripts').onchange = (event) => deck.setKeepTranscripts(event.target.checked).catch((error) => showStatus('transcripts-status', t('settings.accounts.keep-transcripts.error', { error }), true));
$('settings-mouse').onchange = async (event) => {
  if (event.target.checked) {
    event.target.checked = false; // Stays off until the warning is accepted.
    if (!await askConfirm(t('settings.chats.mouse.confirm.title'), t('settings.chats.mouse.confirm.text'), t('settings.chats.mouse.confirm.action'))) return;
    event.target.checked = true;
  }
  deck.setMouse(event.target.checked);
};
const VOICE_NOTICES = {
  local: [t('voice.confirm.local.title'), t('voice.confirm.local.text'), t('voice.confirm.local.action')],
  anthropic: [t('voice.confirm.anthropic.title'), t('voice.confirm.anthropic.text'), t('voice.confirm.anthropic.action')],
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
$('settings-volume').oninput = (event) => ($('settings-volume-value').value = t('common.percent', { percent: event.target.value }));
$('settings-volume').onchange = (event) => {
  localStorage.setItem('notifyVolume', event.target.value);
  chime(Number(event.target.value));
};
checkVoice();
$('settings-voice-language').onchange = (event) => localStorage.setItem('voiceLanguage', event.target.value);
$('settings-frugal').onchange = (event) => localStorage.setItem('startWithFrugal', event.target.checked);
$('settings-import-external').onclick = async () => {
  const ids = currentIndex?.sessions.filter((s) => !s.deck).map((s) => s.id) ?? [];
  $('settings-import-external').disabled = true;
  try {
    await deck.importSessions(ids);
    const count = ids.length;
    showStatus('import-status', tp('settings.general.external.imported', count));
  } catch (error) {
    showStatus('import-status', t('settings.general.external.error', { error }), true);
  } finally { updateExternalCount(); }
};
$('settings-ai-excerpts').onchange = (event) => localStorage.setItem('aiSearchExcerpts', event.target.checked);
$('settings-reopen').onchange = (event) => localStorage.setItem('reopenChats', event.target.checked);
$('settings-language').append(new Option(t('settings.general.language.auto'), ''), ...languages.map((tag) => {
  const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
  return new Option(name[0].toLocaleUpperCase(tag) + name.slice(1), tag);
}));
$('settings-language').value = languages.includes(localStorage.getItem('language')) ? localStorage.getItem('language') : '';
$('settings-language').onchange = (event) => {
  if (event.target.value) localStorage.setItem('language', event.target.value);
  else localStorage.removeItem('language');
  location.reload();
};
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
  showPalette(async () => currentIndex.sessions.filter((s) => s.chatId === session.chatId), resumeSession, t('palette.history-prompt'));
};
$('link-chat').onclick = () => {
  const activeSession = currentIndex?.sessions?.find((s) => s.id === activeId);
  if (!activeSession) return;
  const otherChats = async () => groupChats(await deck.getAllSessions()).filter((c) => c.chatId !== activeSession.chatId);
  if (!activeSession.parentId) {
    showPalette(otherChats, linkTo, t('palette.link-prompt'));
    return;
  }
  const { left, bottom } = $('link-chat').getBoundingClientRect();
  openMenu(left, bottom + 4, [
    { label: t('organize.move-chat'), run: () => showPalette(otherChats, (target) => {
      deck.link(activeSession.id, target.id);
      showUndo(t('organize.moved', { title: target.title }));
    }, t('palette.move-prompt')) },
    { label: t('organize.unlink.label'), run: () => {
      deck.link(activeSession.id, null);
      showUndo(t('organize.unlinked'));
    } },
  ]);
};
async function linkTo(target) {
  const activeSession = currentIndex?.sessions?.find((s) => s.id === activeId);
  deck.link(activeSession.chatId, target.id);
  showUndo(t('organize.linked', { title: target.title }));
}
$('sort').onclick = () => {
  if (!$('sort-groups').hidden) drawSortGroups();
  sortDialog.showModal();
  drawSortEstimate();
};
$('sort-notes').value = localStorage.getItem('sortNotes') ?? '';
$('sort-notes').oninput = (event) => localStorage.setItem('sortNotes', event.target.value);
$('sort-rename').onchange = drawSortEstimate;
$('sort-model').onchange = drawSortEstimate;
$('sort-effort').onchange = drawSortEstimate;
$('sort-nest').checked = localStorage.getItem('sortNest') === 'true';
$('sort-nest').onchange = (event) => {
  localStorage.setItem('sortNest', event.target.checked);
  drawSortEstimate();
};
$('sort-scope').onchange = () => {
  $('sort-groups').hidden = $('sort-scope').value !== 'groups';
  if (!$('sort-groups').hidden) drawSortGroups();
  drawSortEstimate();
};
$('sort-close').onclick = () => sortDialog.close();
$('undo-run').onclick = () => {
  if (undoAction) undoAction();
  else deck.undoLink();
  undoAction = null;
  $('undo-bar').hidden = true;
};
$('undo-close').onclick = () => {
  $('undo-bar').hidden = true;
};
$('sort-restore').onclick = () => {
  deck.restoreTitles();
  sortStatus(t('sort.restore.done'));
};
function lockSortDialog(locked) {
  sorting = locked;
  sortDialog.closedBy = locked ? 'none' : 'any';
  for (const control of sortDialog.querySelector('form').elements) control.disabled = locked;
  $('sort-run').setAttribute('aria-busy', locked);
}

$('sort-run').onclick = async () => {
  lockSortDialog(true);
  const options = sortOptions();
  const { sessions } = await deck.estimateTopics(options);
  const paces = sortPaces();
  trackSort({ expected: (paces[paceKey(options)] ?? 0) * sessions });
  setSessionView('topics');
  let result = await deck.runTopics(options).catch((error) => ({ error: error.message }));
  if (result.ok && sessions) localStorage.setItem('sortPace', JSON.stringify({ ...paces, [paceKey(options)]: (Date.now() - sortRun.started) / sessions }));
  if (result.ok && $('sort-nest').checked) {
    trackSort({ label: t('sort.progress.moving') });
    result = await deck.runWorkspaces(options).catch((error) => ({ error: error.message }));
  }
  trackSort(null);
  lockSortDialog(false);
  if (result.error) {
    sortStatus(result.error, true);
    drawSortEstimate();
    return;
  }
  sortStatus('');
  sortDialog.close();
};
deck.onTopicsProgress((done, total) => {
  if (!sortRun) return;
  Object.assign(sortRun, { done, total });
  drawSortProgress();
});

$('join-run').onclick = async () => {
  lockSortDialog(true);
  sortStatus(t('sort.join.asking'));
  const result = await deck.runJoins(sortOptions()).catch((error) => ({ error: error.message }));
  lockSortDialog(false);
  if (result.error) sortStatus(result.error, true);
  else sortStatus('');
  drawSortEstimate();
};
$('join-undo').onclick = () => {
  deck.clearJoins();
  sortStatus(t('sort.join-undo.done'));
};
$('workspace-undo').onclick = () => {
  deck.clearWorkspaces();
  sortStatus(t('sort.workspace-undo.done'));
};

const startInSessions = async () => startChat(await deck.defaultFolder());
const startInPicked = async () => startChat(await deck.pickFolder());
$('new').onclick = startInSessions;
$('update-badge').onclick = () => openSettings('updates');
$('start').onclick = startInSessions;
$('pick').onclick = startInPicked;
// Deck-wide actions; the ones for the open chat sit in the readout.
$('app-menu').onclick = () => {
  const { right, bottom } = $('app-menu').getBoundingClientRect();
  openMenu(right, bottom + 4, [
    { label: t('menu.new-in-folder'), run: startInPicked, icon: 'folder' },
    { label: t('settings.accounts.title'), run: () => openSettings('accounts'), icon: 'user' },
    { label: t('menu.tasks'), run: openTasks, icon: 'tasks' },
    { label: t('settings.title'), run: () => openSettings(), icon: 'settings' },
    { label: t('mcp.title'), run: () => openMcpDialog({ global: true }), icon: 'plug' },
    { label: t('plugins.title'), run: openPluginsDialog, icon: 'puzzle' },
  ], $('app-menu'));
};
let tasksLoad = 0;
// Every delegate job, from any chat: how many each account took today and in all, newest first.
async function openTasks() {
  const load = ++tasksLoad;
  const summary = $('tasks-summary');
  $('tasks-list').replaceChildren();
  $('tasks-retry').hidden = true;
  summary.classList.remove('empty');
  summary.textContent = t('tasks.loading');
  if (!$('tasks-dialog').open) $('tasks-dialog').showModal();
  const tasks = await deck.allTasks().catch(() => null);
  if (load !== tasksLoad || !$('tasks-dialog').open) return;
  if (!tasks) {
    summary.classList.add('empty');
    summary.textContent = t('tasks.error');
    $('tasks-retry').hidden = false;
    return;
  }
  const delegated = tasks.filter((task) => !isLocal(task));
  const local = tasks.filter((task) => isLocal(task));
  const today = new Date().toDateString();
  const counts = new Map();
  for (const task of delegated) {
    const name = taskAccount(task) || t('tasks.unknown');
    const count = counts.get(name) ?? { all: 0, today: 0 };
    count.all += 1;
    if (task.updatedAt && new Date(task.updatedAt).toDateString() === today) count.today += 1;
    counts.set(name, count);
  }
  const todayTotal = [...counts.values()].reduce((sum, count) => sum + count.today, 0);
  const byAccount = [...counts].sort((a, b) => b[1].all - a[1].all).map(([name, count]) => {
    const account = tp('tasks.account-count', count.all, { name });
    return count.today ? tp('tasks.account-today', count.today, { account }) : account;
  });
  summary.classList.toggle('empty', !delegated.length);
  if (delegated.length) {
    const today = tp('tasks.today', todayTotal);
    const total = tp('tasks.summary', delegated.length, { today, accounts: byAccount.join(' · ') });
    summary.textContent = local.length ? tp('tasks.summary-local', local.length, { total }) : total;
  } else {
    summary.textContent = t('tasks.empty');
  }
  const rows = delegated.map(taskRow);
  if (local.length) {
    const fold = node('details', 'info-panel__local');
    const summary = document.createElement('summary');
    summary.append(tp('tasks.local-heading', local.length), ' ', node('span', 'info-panel__muted', String(local.length)));
    fold.append(summary, ...local.map(taskRow));
    rows.push(fold);
  }
  $('tasks-list').replaceChildren(...rows);
}
$('tasks-retry').onclick = openTasks;
let updateCheck;
let updatesBusy = false;
function checkUpdates() {
  return updateCheck ??= deck.checkUpdates().then((found) => {
    $('update-badge').hidden = !(found?.local || found?.remote || found?.frugalLatest?.newer);
    return found;
  }, (error) => {
    $('update-badge').hidden = true;
    throw error;
  }).finally(() => { updateCheck = null; });
}
function pollUpdates() {
  checkUpdates().catch(() => {});
}

function lockUpdates(button, locked) {
  updatesBusy = locked;
  for (const control of $('settings-updates').querySelectorAll('button')) control.disabled = locked;
  if (locked) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

// Installing closes the Deck, its chats with it, and the installer opens it again.
async function installUpdate(source, button) {
  lockUpdates(button, true);
  const status = $('update-status');
  status.textContent = '';
  try {
    const file = source ?? await deck.pickInstaller();
    if (!file) return;
    status.textContent = t('update.installing');
    await deck.installUpdate(file);
  } catch (error) {
    status.textContent = t('update.install-error', { error });
  } finally {
    lockUpdates(button, false);
  }
}

function updateRow(text, action, tip, run, detail, primary = false) {
  const row = node('div', 'row');
  const label = node('div', 'row__main');
  if (text) label.append(node('span', null, text));
  if (detail) {
    const line = node('p', 'settings__hint row__meta row__meta--path', detail);
    line.dataset.tip = detail;
    label.append(line);
  }
  row.append(label);
  if (run) {
    const controls = node('div', 'row__controls');
    const button = node('button', primary ? 'btn btn--primary' : 'btn', action);
    button.type = 'button';
    button.disabled = updatesBusy;
    button.dataset.tip = tip;
    button.onclick = () => run(button);
    controls.append(button);
    row.append(controls);
  }
  return row;
}

function updateRetry(text, error) {
  const state = node('div', 'empty');
  const message = node('p', 'settings__hint row__meta', text);
  message.setAttribute('role', 'status');
  state.append(message);
  if (error) state.append(node('p', 'settings__hint row__meta', error));
  const retry = node('button', 'btn', t('common.retry'));
  retry.type = 'button';
  retry.disabled = updatesBusy;
  retry.onclick = loadUpdates;
  state.append(retry);
  return state;
}

// The Deck checks GitHub releases and this exe's build folder. Frugal checks the source Claude Code records.
async function loadUpdates() {
  const deckList = $('update-deck-list');
  const pluginList = $('update-plugin-list');
  const status = $('update-status');
  deckList.replaceChildren();
  pluginList.replaceChildren();
  status.textContent = t('update.checking');
  let found, failure;
  try {
    // An update can finish while a background check still holds the previous version.
    if (updatesBusy) await updateCheck?.catch(() => {});
    found = await checkUpdates();
  } catch (error) {
    failure = error?.message ?? error;
  }
  status.textContent = '';
  if (!found?.version) {
    deckList.append(updateRetry(t('update.check-error'), failure));
    return;
  }
  const { version, local, remote, error, buildFolder, frugal, frugalSource, frugalLatest } = found;
  const install = t('update.install-tip');
  const versionHint = (version) => node('p', 'settings__hint', t('update.version', { version }));
  const rows = [versionHint(version)];
  const fromBuilds = Boolean(buildFolder) && localStorage.getItem('deckUpdateSource') !== 'github';
  // The Deck gets the primary action when both have an update to install.
  const deckNewer = fromBuilds ? Boolean(local) : Boolean(remote?.url);
  if (fromBuilds) rows.push(local ? updateRow(t('update.local.build', { date: new Date(local.built).toLocaleString() }), t('common.install'), install, (button) => installUpdate(local.path, button), undefined, true) : updateRow(t('update.local.no-build')));
  else if (remote?.url) rows.push(updateRow(t('update.available', { version: remote.version }), t('common.install'), install, (button) => installUpdate(remote.url, button), undefined, true));
  else if (remote) rows.push(updateRow(t('update.github.no-installer', { version: remote.version }), t('common.open'), t('update.github.open-tip'), () => deck.openLink(remote.page)));
  else rows.push(error != null ? updateRetry(t('update.github.check-error'), error) : updateRow(t('update.current')));
  if (buildFolder) {
    const use = (source) => () => {
      localStorage.setItem('deckUpdateSource', source);
      loadUpdates();
    };
    rows.push(fromBuilds
      ? updateRow(t('update.source.local-builds'), t('update.source.use-github'), t('update.source.deck-github-tip'), use('github'), buildFolder)
      : updateRow(t('update.source.github'), t('update.source.use-builds'), t('update.source.builds-tip'), use('local'), 'frugal-hq/deck'));
  } else rows.push(updateRow(t('update.source.github'), undefined, undefined, undefined, 'frugal-hq/deck'));
  rows.push(updateRow('', t('update.file.label'), t('update.file.tip'), (button) => installUpdate(null, button)));
  deckList.replaceChildren(...rows);

  const pluginRows = [];
  if (frugal) {
    pluginRows.push(versionHint(frugal));
    const { version: latest, newer, dirty } = frugalLatest ?? {};
    if (dirty) pluginRows.push(updateRow(t('update.plugin.dirty'), undefined, undefined, undefined, t('update.plugin.dirty-tip')));
    else if (newer) pluginRows.push(updateRow(t('update.available', { version: latest }), t('update.plugin.update'), t('update.plugin.update-tip'), updateFrugal, undefined, !deckNewer));
    else pluginRows.push(latest ? updateRow(t('update.current')) : updateRetry(t('update.plugin.unknown-version')));
  } else {
    pluginRows.push(updateRow(t('update.plugin.not-installed'), t('common.install'), t('update.plugin.install-tip'), (button) => setFrugalSource(true, button)));
  }
  const fromFolder = frugalSource?.source === 'directory';
  const source = fromFolder ? frugalSource.path : frugalSource?.repo ?? frugalSource?.url;
  const kind = fromFolder ? t('update.source.folder') : frugalSource?.repo ? 'GitHub' : source ? t('update.source.other-kind') : t('update.source.unknown');
  const sourceTip = fromFolder ? t('update.source.plugin-github-tip') : t('update.source.folder-tip');
  pluginRows.push(updateRow(t('update.source.label', { kind }), fromFolder ? t('update.source.use-github') : t('update.source.use-folder'), sourceTip, (button) => setFrugalSource(fromFolder, button), source));
  pluginList.replaceChildren(...pluginRows);
}

async function setFrugalSource(github, button) {
  lockUpdates(button, true);
  const status = $('update-plugin-status');
  status.textContent = t('update.source.changing');
  try {
    const source = await deck.setFrugalSource(github);
    if (source) await frugalChanged(t('update.source.changed', { source }));
    else status.textContent = '';
  } catch (error) {
    status.textContent = t('update.source.error', { error });
  } finally {
    lockUpdates(button, false);
  }
}

// New chats load the new frugal; open ones keep the copy they started with until they restart.
async function frugalChanged(text) {
  await loadUpdates();
  const open = restartable();
  $('update-plugin-status').textContent = open.length ? t('update.plugin.load-on-restart', { text }) : t('update.plugin.load-on-start', { text });
  const restart = $('update-plugin-restart');
  restart.replaceChildren();
  if (open.length) restart.append(updateRow(tp('update.restart.previous', open.length), t('update.restart.action'), t('update.restart.tip'), restartChats));
}
async function restartChats(button) {
  lockUpdates(button, true);
  try {
    const open = restartable();
    const busy = await busyChats(open);
    let restarting = open;
    if (busy.length) {
      const choice = await askBusy(busy, busy.length < open.length, {
        title: t('update.restart.title'),
        message: t('update.restart.message'),
        cancel: t('update.restart.cancel-tip'),
        idle: [t('update.restart.idle'), t('update.restart.idle-tip')],
        all: [t('update.restart.all'), t('update.restart.all-tip')],
      });
      if (choice !== 'all' && choice !== 'idle') return;
      if (choice === 'idle') {
        restarting = open.filter((chat) => !busy.includes(chat));
        const labels = busy.map((chat) => chat.name).join(', ');
        deck.activityAdd('states', `Busy chats kept the previous frugal: ${labels}`);
      }
    }
    for (const chat of restarting) await switchChat(chat, { id: chat.account }, true);
    $('update-plugin-status').textContent = restarting.length < open.length
      ? tp('update.restart.done-idle', restarting.length)
      : tp('update.restart.done', restarting.length);
    $('update-plugin-restart').replaceChildren();
  } finally {
    lockUpdates(button, false);
  }
}
async function updateFrugal(button) {
  lockUpdates(button, true);
  const status = $('update-plugin-status');
  status.textContent = t('update.plugin.updating');
  try {
    const result = await deck.updateFrugal();
    const message = t('update.plugin.result', { result });
    if (/ updated from /.test(result)) await frugalChanged(message);
    else {
      await loadUpdates();
      status.textContent = message;
    }
  } catch (error) {
    status.textContent = t('update.plugin.error', { error });
  } finally {
    lockUpdates(button, false);
  }
}
pollUpdates();
setInterval(pollUpdates, 6 * 60 * 60 * 1000);
// Builds and plugin releases land while the Deck stays open; recheck on focus, throttled for GitHub's rate limit.
let lastFocusPoll = Date.now();
window.addEventListener('focus', () => {
  if (Date.now() - lastFocusPoll < 15 * 60 * 1000) return;
  lastFocusPoll = Date.now();
  pollUpdates();
});
render();
for (const button of document.querySelectorAll('[data-window-action]')) {
  button.onclick = () => deck.windowAction(button.dataset.windowAction);
}
const maximizeButton = document.getElementById('window-maximize');
function drawMaximizeButton(maximized) {
  maximizeButton.setAttribute('aria-label', maximized ? t('common.restore') : t('bar.maximize.label'));
  maximizeButton.dataset.tip = maximized ? t('bar.restore.tip') : t('bar.maximize.tip');
  maximizeButton.querySelector('use').setAttribute('href', maximized ? '#i-window-restore' : '#i-window-maximize');
}
drawMaximizeButton(false);
deck.onMaximized(drawMaximizeButton);
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
  else if (tooltipTarget.tipContent) tooltip.replaceChildren(tooltipTarget.tipContent);
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
