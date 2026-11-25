import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowlist = [
  // The existing index progress bar animates the width of its filled segment.
  { file: 'app.css', rule: 'transition on width', text: 'transition: width var(--dur-short) var(--ease-out)' },
];

const renderer = fileURLToPath(new URL('../src/renderer/', import.meta.url));
const sources = new Map(readdirSync(renderer, { recursive: true })
  .filter((file) => /\.(?:css|[cm]?js|html)$/.test(file))
  .map((file) => [file.replaceAll('\\', '/'), readFileSync(join(renderer, file), 'utf8')]));
const failures = [];
const exceptions = [...allowlist];
const report = (file, index, rule, text) => {
  const allowed = exceptions.findIndex((entry) => entry.file === file && entry.rule === rule && entry.text === text);
  if (allowed !== -1) return void exceptions.splice(allowed, 1);
  const line = sources.get(file).slice(0, index).split('\n').length;
  failures.push(`src/renderer/${file}:${line}: ${rule}: ${text}`);
};

// Mask non-code text without moving the offsets used for diagnostics.
const blank = (text) => text.replace(/[^\r\n]/g, ' ');
const cssCode = (source) => source.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<![\w-])url\(\s*[^\s"')][^)]*\)/gi, blank);
const varUse = /(?<![\w-])var\(\s*(--[\w-]+)\s*[,)]/gi;
const declarations = /(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]*)(?=[;}]|$)/g;
const defined = new Set();

const jsCode = (source, maskLiterals = false) => {
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|(?<=[([=,:;!?&|]\s*)\/(?:\\.|\[(?:\\.|[^\]\\\r\n])*\]|[^/\[\\\r\n])+\/[a-z]*|[`{}]/g;
  const template = /(?:\\[\s\S]|[^`\\$]|\$(?!\{))*(?:`|\$\{)/y;
  const expressions = [];
  let depth = 0;
  let offset = 0;
  let code = '';
  for (let match; (match = tokens.exec(source));) {
    const [token] = match;
    if (token === '`' || (token === '}' && expressions.at(-1) === depth)) {
      if (token === '}') {
        expressions.pop();
        depth--;
      }
      template.lastIndex = tokens.lastIndex;
      const tail = template.exec(source);
      if (!tail) continue;
      tokens.lastIndex = template.lastIndex;
      if (tail[0].endsWith('${')) expressions.push(++depth);
    } else if (token === '{' || token === '}') {
      depth += token === '{' ? 1 : -1;
      continue;
    }
    if (maskLiterals || /^\/(?:\*|\/)/.test(token)) {
      code += source.slice(offset, match.index) + blank(source.slice(match.index, tokens.lastIndex));
      offset = tokens.lastIndex;
    }
  }
  return code + source.slice(offset);
};

const functionEnd = (value, start) => {
  let depth = 1;
  for (let i = start; i < value.length; i++) {
    if (value[i] === '(') depth++;
    if (value[i] === ')' && --depth === 0) return i;
  }
  return value.length;
};

const scanSources = new Map();
for (const [file, source] of sources) {
  const css = file.endsWith('.css');
  const code = css ? cssCode(source) : file.endsWith('.html')
    ? source.replace(/<!--[\s\S]*?-->/g, blank)
    : jsCode(source);
  scanSources.set(file, code);
  if (!css) continue;
  for (const [, name] of code.matchAll(/@property\s+(--[\w-]+)/gi)) defined.add(name);
  for (const match of code.matchAll(declarations)) {
    const [, name, rawValue] = match;
    if (name.startsWith('--')) defined.add(name);
    if (file !== 'app.css' && file !== 'base.css') continue;

    const index = match.index + match[0].indexOf(name);
    const text = source.slice(index, match.index + match[0].length).trim();
    const fail = (rule) => report(file, index, rule, text);
    const property = name.toLowerCase();
    const value = rawValue.replace(/!\s*important\s*$/i, '').trim();
    if (/(?<![\w-])#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})(?![\w-])|(?<![\w-])(?:rgba?|hsl)\(/i.test(value)) fail('literal colour');
    for (const colour of value.matchAll(/(?<![\w-])(?:oklch|color-mix)\(/gi)) {
      const start = colour.index + colour[0].length;
      if (![...value.slice(start, functionEnd(value, start)).matchAll(varUse)].length) fail('literal colour');
    }
    if (file === 'app.css' && property === 'font-family' &&
        ![...value.matchAll(varUse)].some(([, ref]) => ref.startsWith('--font-'))) fail('font-family without a font token');
    if (file === 'app.css' && property === 'border-radius') {
      const lengths = value.matchAll(/(?<![\w.])([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)(px|%)(?![\w-])/gi);
      if ([...lengths].some(([, number, unit]) => Number(number) !== (unit === '%' ? 50 : 1))) fail('literal border-radius');
    }
    if (file === 'app.css' && property === 'z-index') {
      const refs = [...value.matchAll(varUse)];
      const calc = /^calc\(/i.test(value) && functionEnd(value, 5) === value.length - 1;
      if (!/^var\(\s*--z-[\w-]+\s*\)$/i.test(value) &&
          !(calc && refs.length && refs.every(([, ref]) => ref.startsWith('--z-')))) fail('z-index without a z token');
    }
    if (property === 'transition' || property === 'transition-property') {
      let depth = 0;
      for (const [part] of value.matchAll(/[()]|[\w-]+/g)) {
        if (part === '(') depth++;
        if (part === ')') depth--;
        if (!depth && /^(all|width|height|top|left)$/i.test(part)) {
          fail(`transition on ${part.toLowerCase()}`);
          break;
        }
      }
    }
  }
}

const script = scanSources.get('app.js');
const appSource = sources.get('app.js');
const appCode = jsCode(appSource, true);
for (const match of appCode.matchAll(/(?<![$\p{ID_Continue}\u200C\u200D])(?<!\bfunction\s+)(?:alert|confirm)\s*(?:\?\.\s*)?\(/gu)) {
  const text = appSource.slice(match.index, match.index + match[0].length);
  report('app.js', match.index, 'native dialog call', text);
}
for (const match of appCode.matchAll(/\.setProperty\s*\(/g)) {
  const args = script.slice(match.index + match[0].length);
  const name = /^\s*(['"`])(--[\w-]+)\1\s*,/.exec(args)?.[2];
  if (name) defined.add(name);
}
const styles = /(?:\bstyle\s*[:=]|\.cssText\s*\+?=|\.setAttribute\s*\(\s*['"]style['"]\s*,)\s*(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
for (const [, , style] of script.matchAll(styles)) {
  for (const [, name] of cssCode(style).matchAll(declarations)) {
    if (name.startsWith('--')) defined.add(name);
  }
}

for (const [file, code] of scanSources) {
  for (const match of code.matchAll(varUse)) {
    if (!defined.has(match[1])) {
      report(file, match.index, `undefined custom property ${match[1]}`, sources.get(file).slice(match.index, match.index + match[0].length));
    }
  }
}

assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
console.log('ui check ok');
