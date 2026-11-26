export const languages = ['en', 'es', 'es-ES', 'es-PE', 'es-MX', 'pt-PT', 'pt-BR', 'ru', 'tr', 'fr', 'de', 'it', 'ja', 'zh-CN', 'ko', 'pl', 'uk', 'nl'];
const DEFAULT_VARIANTS = { pt: 'pt-BR', zh: 'zh-CN' };
const attributes = ['tip', 'aria-label', 'placeholder', 'title'];
const selector = ['[data-i18n]', ...attributes.map(name => `[data-i18n-${name}]`)].join(', ');

let language = 'en';
let messages = Object.create(null);

export function pickLanguage(stored = globalThis.localStorage?.getItem('language'), preferred = globalThis.navigator?.languages ?? [], supported = languages) {
  const tags = [...supported];
  if (tags.includes(stored)) return stored;
  for (const preference of preferred) {
    const tag = preference.toLowerCase();
    const exact = tags.find(candidate => candidate.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split('-')[0];
    if (tags.includes(base)) return base;
    if (tags.includes(DEFAULT_VARIANTS[base])) return DEFAULT_VARIANTS[base];
  }
  return 'en';
}

export function chain(tag) {
  return [...new Set([tag, tag.split('-')[0], 'en'].filter(candidate => languages.includes(candidate)))];
}

export async function loadLocale(tag = pickLanguage()) {
  const tags = chain(tag);
  const locales = await Promise.all(tags.map(async tag => {
    const response = await fetch(new URL(`./locales/${tag}.json`, import.meta.url));
    if (response.ok) return response.json();
    // Tauri's asset protocol can return HTTP 500 for a missing file.
    if (tag === 'en') throw new Error(`Could not load en.json (HTTP ${response.status})`);
  }));
  messages = Object.assign(Object.create(null), ...locales.reverse());
  language = tags[0];
  if (globalThis.document) document.documentElement.lang = language;
}

export function currentLanguage() {
  return language;
}

function interpolate(message, vars) {
  return message.replace(/\{([^{}]+)\}/g, (placeholder, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : placeholder);
}

export function t(key, vars = {}) {
  const message = messages[key];
  return message === undefined ? key : interpolate(message, vars);
}

export function tp(key, count, vars = {}) {
  const form = `${key}.${new Intl.PluralRules(currentLanguage()).select(count)}`;
  return t(Object.hasOwn(messages, form) ? form : `${key}.other`, { count, ...vars });
}

export function applyI18n(root = document) {
  const elements = [...root.querySelectorAll(selector)];
  if (root.matches?.(selector)) elements.unshift(root);
  for (const element of elements) {
    const key = element.getAttribute('data-i18n');
    if (key !== null) {
      if (!element.children.length) element.textContent = t(key);
      else {
        const text = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
        if (text) text.textContent = text.textContent.replace(/\S(?:[\s\S]*\S)?/, () => t(key));
      }
    }
    for (const name of attributes) {
      const key = element.getAttribute(`data-i18n-${name}`);
      if (key === null) continue;
      if (name === 'tip') element.dataset.tip = t(key);
      else element.setAttribute(name, t(key));
    }
  }
}
