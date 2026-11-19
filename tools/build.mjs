// Zero-dependency inliner: src/ -> dist/xml-beautifier.html (one offline file).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, 'src', p), 'utf8');

const parts = {
  '/*@TOKENS*/': read('tokens.css'),
  '/*@CSS*/': read('app.css'),
  '/*@CORE*/': read('core.js'),
  '/*@APP*/': read('app.js'),
};
let html = read('index.html');
for (const [k, v] of Object.entries(parts)) {
  if (!html.includes(k)) throw new Error('missing slot ' + k);
  if (/<\/script/i.test(v) || /<\/style/i.test(v)) throw new Error('closing tag inside ' + k);
  html = html.split(k).join(v);
}

// Fail on any external reference: the file must run on air-gapped machines.
const external = html.match(/(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+|@import|url\(\s*["']?(?:https?:)?\/\//gi);
if (external) throw new Error('external reference: ' + external.join(', '));

// dist/ holds the file to copy onto air-gapped machines; docs/ is what GitHub Pages serves.
mkdirSync(join(root, 'dist'), { recursive: true });
mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'dist', 'xml-beautifier.html'), html);
writeFileSync(join(root, 'docs', 'index.html'), html);
console.log('dist/xml-beautifier.html + docs/index.html', (Buffer.byteLength(html) / 1024).toFixed(1), 'KB');
