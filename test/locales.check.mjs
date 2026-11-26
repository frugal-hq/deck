import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/renderer/locales/', import.meta.url);
const read = file => JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
const en = read('en.json');
const overlays = ['es-ES', 'es-PE', 'es-MX'];
const placeholders = text => new Set(text.match(/\{[^{}]+\}/g) ?? []);
const plural = new Set(Object.keys(en).filter(key => key.endsWith('.other')).map(key => key.slice(0, -6)));
const base = key => plural.has(key.replace(/\.[a-z]+$/, '')) ? key.replace(/\.[a-z]+$/, '') : key;
const failures = [];

for (const file of readdirSync(dir).filter(file => file.endsWith('.json') && file !== 'en.json' && (!process.argv[2] || process.argv.slice(2).includes(file.slice(0, -5))))) {
  const tag = file.slice(0, -5);
  const locale = read(file);
  const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  // `many` only covers large numbers in fr, es, it and pt; tp falls back to `other`.
  const required = categories.filter(form => form !== 'many' || categories.includes('few'));
  const fail = message => failures.push(`${file}: ${message}`);
  for (const [key, text] of Object.entries(locale)) {
    const group = base(key);
    if (typeof text !== 'string' || !text.trim()) { fail(`${key} is empty`); continue; }
    if (group === key && !(key in en)) { fail(`${key} is not in en.json`); continue; }
    const form = group === key ? null : key.slice(group.length + 1);
    if (form && !categories.includes(form)) { fail(`${key} is not a plural form of ${tag}`); continue; }
    const expected = placeholders(en[form ? `${group}.other` : key]);
    const actual = placeholders(text);
    if (form && form !== 'other') expected.delete('{count}');
    for (const name of actual) if (!placeholders(en[form ? `${group}.other` : key]).has(name)) fail(`${key} has unknown ${name}`);
    for (const name of expected) if (!actual.has(name)) fail(`${key} misses ${name}`);
  }
  if (overlays.includes(tag)) continue;
  for (const key of Object.keys(en)) {
    const group = base(key);
    if (group === key && !(key in locale)) fail(`missing ${key}`);
  }
  for (const group of plural) for (const form of required) if (!(`${group}.${form}` in locale)) fail(`missing ${group}.${form}`);
}

if (failures.length) {
  console.error(failures.slice(0, 50).join('\n') + (failures.length > 50 ? `\n…and ${failures.length - 50} more` : ''));
  process.exit(1);
}
console.log('locales check ok');
