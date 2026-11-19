import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(fs.readFileSync(new URL('../src/core.js', import.meta.url), 'utf8'));
const C = globalThis.XBCore;
const O = { indent: 2, attrs: 'inline', empty: true, unescape: true };
const one = (xml, o = O) => C.blockText(C.parseXml(xml).root.children.find(c => c.type === 'el'), o);

test('entities: named, decimal, hex; unknown left alone', () => {
  assert.equal(C.decodeEntities('&quot;&apos;&amp;&lt;&gt;&#xd;&#13;&#x41;&#65;&nbsp;&amp;quot;'), `"'&<>\r\rAA&nbsp;&quot;`);
});

test('JSON body pretty-printed; tokens kept as written', () => {
  const t = one('<x>{&quot;a&quot;:12345678901234567890,&quot;b&quot;:[],&quot;c&quot;:{},&quot;d&quot;:&quot;\\u062f\\u001A\\\\u0627&quot;}</x>');
  assert.equal(t, '<x>\n  {\n    "a": 12345678901234567890,\n    "b": [],\n    "c": {},\n    "d": "د\\u001A\\\\u0627"\n  }\n</x>');
});

test('invalid JSON stays plain text', () => {
  assert.equal(one('<x>{"a": ${var}}</x>'), '<x>{"a": ${var}}</x>');
});

test('\\u decoding can be switched off', () => {
  assert.match(one('<x>{"m":"\\u062f"}</x>', { ...O, unescape: false }), /"\\u062f"/);
});

test('CRLF via &#xd; becomes one line break; multi-line text indented', () => {
  assert.equal(one('<h>A: 1&#xd;\nB: 2&#xd;\n</h>'), '<h>\n  A: 1\n  B: 2\n</h>');
});

test('empty elements can be hidden', () => {
  const xml = '<s><a></a><b>1</b></s>';
  assert.equal(one(xml), '<s>\n  <a/>\n  <b>1</b>\n</s>');
  assert.equal(one(xml, { ...O, empty: false }), '<s>\n  <b>1</b>\n</s>');
});

test('stacked attributes', () => {
  assert.equal(one('<s a="1" b="&quot;x&quot;"><n>v</n></s>', { ...O, attrs: 'stacked' }),
    '<s\n  a="1"\n  b=""x"">\n  <n>v</n>\n</s>');
});

test('truncated input is flagged, not thrown', () => {
  const d = C.parseXml('<testResults><httpSample rc="500"><responseData>abc');
  assert.deepEqual(d.warnings, ['truncated']);
  assert.equal(C.blocksOf(d).blocks.length, 1);
});

test('transaction rows hidden; nested children kept', () => {
  const d = C.parseXml('<testResults><sample lb="T" rc="" rm="Number of samples in transaction : 1, number of failing samples : 1"><httpSample rc="500"/></sample><sample lb="JSR" rc="500" rm="x"/></testResults>');
  const b = C.blocksOf(d).blocks;
  assert.equal(C.flatten(b, false).length, 2);
  assert.deepEqual(C.flatten(b, true).map(e => e.name + ':' + C.attr(e, 'rc')), ['httpSample:500', 'sample:500']);
});

// Golden test on a real 1000 vU distributed run. Results files are never committed:
// point XB_REAL_FILE at a local copy to run it.
const REAL = process.env.XB_REAL_FILE;
test('real file (1000 vU distributed run)', { skip: !REAL || !fs.existsSync(REAL) }, () => {
  const d = C.parseXml(fs.readFileSync(REAL, 'utf8'));
  const flat = C.flatten(C.blocksOf(d).blocks, true);
  assert.deepEqual(d.warnings, []);
  assert.equal(flat.length, 2055);
  const st = { json: 0, text: 0 };
  const out = flat.map(e => C.elementLines(e, 0, [], O, st).map(l => C.lineText(l, '  ')).join('\n')).join('\n');
  assert.equal(st.json, 1928);
  assert.equal((out.match(/&(quot|apos|amp|lt|gt|#x?[0-9a-f]+);/gi) || []).length, 0);
  assert.equal((out.match(/[\u0600-\u06FF]/g) || []).length, 71728);
  assert.equal(flat.filter(C.hasResponseBody).length, 0);
});

test('CR CR LF counts as one line break', () => {
  assert.equal(one('<h>A: 1\r\r\nB: 2\r\r\n</h>'), '<h>\n  A: 1\n  B: 2\n</h>');
  assert.equal(one('<h>A&#xd;&#xd;\nB\r\n\r\nC</h>'), '<h>\n  A\n  B\n  \n  C\n</h>');
});

test('attribute broken by a stray quote is flagged', () => {
  const d = C.parseXml('<s lb="x/insurances%22 rc=" 200" rm="OK"/>');
  assert.deepEqual(d.warnings, ['mismatch']);
  assert.deepEqual(C.parseXml('<s lb="a" rc="200"/>').warnings, []);
});
