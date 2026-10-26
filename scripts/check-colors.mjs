// Lists colors written by hand in views/src and app/src (everything must come from the tokens).
//   node scripts/check-colors.mjs   exit 1 and print file:line for each hit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.svelte', '.ts', '.css'];
const FUNCTION = /\b(?:rgba?|hsla?)\(/;
// A hex only counts as a color in a CSS declaration (`prop: ... #fff`, also in style=) or as a whole
// quoted string (`'#fff'`); anchors and ids (href="#fade", a#dead) are not colors.
const HEX = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})';
const DECLARATION = new RegExp(String.raw`[\w-]+\s*:\s*[^;{}]*${HEX}\b`);
const QUOTED = new RegExp(String.raw`(?<!\b(?:href|id|for|name)\s*=\s*)(['"\x60])${HEX}\1`);

function isColor(line) {
  if (FUNCTION.test(line) || QUOTED.test(line)) return true;
  return DECLARATION.test(line) && !/\{\s*$/.test(line);
}

// Blanks comments but keeps newlines, so line numbers stay exact.
function stripComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/(^|[^:'"`\w])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
}

function isIgnored(file) {
  const name = path.basename(file);
  return name === 'tokens.css' || /\.test\.[cm]?[jt]s$/.test(name);
}

export function findHardcodedColors(files) {
  const hits = [];
  for (const file of files) {
    if (isIgnored(file)) continue;
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, i) => {
      if (isColor(text)) hits.push({ file, line: i + 1 });
    });
  }
  return hits;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
    return EXTENSIONS.includes(path.extname(entry.name)) ? [full] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['views/src', 'app/src'].flatMap((d) => walk(path.join(root, d)));
  const hits = findHardcodedColors(files);
  for (const { file, line } of hits) console.log(`${path.relative(root, file)}:${line}`);
  if (hits.length) {
    console.error(`check-colors: ${hits.length} hardcoded color(s)`);
    process.exit(1);
  }
  console.log('check-colors: OK');
}
