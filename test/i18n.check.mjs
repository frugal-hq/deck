import assert from 'node:assert/strict';
import { chain, currentLanguage, loadLocale, pickLanguage, t, tp } from '../src/renderer/i18n.mjs';

assert.equal(pickLanguage('fr', ['es-PE']), 'fr');
assert.equal(pickLanguage('unknown', ['es-AR']), 'es');
assert.equal(pickLanguage(null, ['es-PE']), 'es-PE');
assert.equal(pickLanguage(null, ['pt']), 'pt-BR');
assert.equal(pickLanguage(null, ['zh-TW']), 'zh-CN');
assert.equal(pickLanguage(null, ['unknown']), 'en');
assert.equal(pickLanguage('fr', ['es-PE'], ['en', 'es']), 'es');

assert.deepEqual(chain('es-PE'), ['es-PE', 'es', 'en']);
assert.deepEqual(chain('en'), ['en']);
assert.deepEqual(chain('pt-PT'), ['pt-PT', 'en']);

const fixtures = {
  'es-PE.json': { 'greeting.short': 'Hola' },
  'es.json': { 'greeting.short': 'Saludos', 'greeting.full': 'Hola, {name}. {name} has {count} messages.' },
  'en.json': { 'greeting.full': 'Hi, {name}.', 'greeting.bye': 'Goodbye', 'chat.one': '{name}: {count} chat', 'chat.other': '{name}: {count} chats' },
  'ru.json': { 'chat.few': '{name}: {count} (few)' },
};
globalThis.fetch = async url => {
  const file = url.pathname.split('/').pop();
  assert.equal(url.href, new URL(`../src/renderer/locales/${file}`, import.meta.url).href);
  return fixtures[file] ? Response.json(fixtures[file]) : new Response(null, { status: 500 });
};

await loadLocale('es-PE');
assert.equal(currentLanguage(), 'es-PE');
assert.equal(t('greeting.short'), 'Hola');
assert.equal(t('greeting.full', { name: '$&', count: 0 }), 'Hola, $&. $& has 0 messages.');
assert.equal(t('greeting.full', { name: 'Ada' }), 'Hola, Ada. Ada has {count} messages.');
assert.equal(t('greeting.bye'), 'Goodbye');
assert.equal(t('missing.{name}', { name: 'Ada' }), 'missing.{name}');

await loadLocale('en');
assert.equal(tp('chat', 1, { name: 'Ada' }), 'Ada: 1 chat');
assert.equal(tp('chat', 0, { name: 'Ada' }), 'Ada: 0 chats');
await loadLocale('ru');
assert.equal(tp('chat', 2, { name: 'Ada' }), 'Ada: 2 (few)');
assert.equal(tp('chat', 5, { name: 'Ada', count: '5.0' }), 'Ada: 5.0 chats');

await loadLocale('pt-PT');
assert.equal(t('greeting.full', { name: 'Ada' }), 'Hi, Ada.');
delete fixtures['en.json'];
await assert.rejects(loadLocale('en'), /Could not load en\.json \(HTTP 500\)/);
console.log('i18n check ok');
