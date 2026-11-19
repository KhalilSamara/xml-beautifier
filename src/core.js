/* XML Beautifier core: tolerant XML scanner, entity decoding, JSON pretty-printing,
   line model. Pure: no DOM. Runs in the browser and in Node (tests). */
(function (g) {
  'use strict';

  var NAMED = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
  var ENT_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

  /* Decode XML entities. Unknown named entities are left as written. */
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(ENT_RE, function (m, e) {
      if (e.charCodeAt(0) === 35) {
        var hex = e[1] === 'x' || e[1] === 'X';
        var cp = hex ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!(cp >= 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return m;
        return String.fromCodePoint(cp);
      }
      return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
    });
  }

  /* One line break per line, whatever the source used. Windows tools can double the
     carriage return (CR CR LF); counting each CR as a break would add blank lines. */
  function normEol(s) {
    return s.indexOf('\r') < 0 ? s : s.replace(/\r*\n|\r+/g, '\n');
  }

  function isWs(c) { return c === 32 || c === 9 || c === 10 || c === 13; }

  /* Tolerant scanner. Never throws on bad input; collects warnings instead.
     Returns { root, decl, warnings, elementCount }. */
  function parseXml(src) {
    var n = src.length, i = 0;
    if (src.charCodeAt(0) === 0xfeff) i = 1;
    var root = { type: 'root', children: [] };
    var stack = [root];
    var warnings = [];
    var decl = null;
    var count = 0;

    function top() { return stack[stack.length - 1]; }
    function addText(t) {
      if (!t) return;
      var p = top();
      var last = p.children[p.children.length - 1];
      if (last && last.type === 'text') last.text += t;
      else p.children.push({ type: 'text', text: t });
    }

    while (i < n) {
      var lt = src.indexOf('<', i);
      if (lt < 0) { addText(decodeEntities(src.slice(i))); break; }
      if (lt > i) addText(decodeEntities(src.slice(i, lt)));
      var c1 = src.charCodeAt(lt + 1);

      if (c1 === 33 /* ! */) {
        if (src.startsWith('<!--', lt)) {
          var ce = src.indexOf('-->', lt + 4);
          top().children.push({ type: 'comment', text: src.slice(lt + 4, ce < 0 ? n : ce) });
          if (ce < 0) { warnings.push('truncated'); i = n; break; }
          i = ce + 3; continue;
        }
        if (src.startsWith('<![CDATA[', lt)) {
          var de = src.indexOf(']]>', lt + 9);
          addText(src.slice(lt + 9, de < 0 ? n : de));
          if (de < 0) { warnings.push('truncated'); i = n; break; }
          i = de + 3; continue;
        }
        var ge = src.indexOf('>', lt);
        i = ge < 0 ? n : ge + 1; continue;
      }
      if (c1 === 63 /* ? */) {
        var pe = src.indexOf('?>', lt + 2);
        if (decl === null) decl = src.slice(lt, pe < 0 ? n : pe + 2);
        i = pe < 0 ? n : pe + 2; continue;
      }
      if (c1 === 47 /* / */) {
        var gt = src.indexOf('>', lt);
        if (gt < 0) { warnings.push('truncated'); i = n; break; }
        var cname = src.slice(lt + 2, gt).trim();
        var k = stack.length - 1;
        while (k > 0 && stack[k].name !== cname) k--;
        if (k > 0) {
          if (k !== stack.length - 1) warnings.push('mismatch');
          stack.length = k;
        } else warnings.push('mismatch');
        i = gt + 1; continue;
      }

      /* start tag */
      var j = lt + 1;
      while (j < n) {
        var cj = src.charCodeAt(j);
        if (isWs(cj) || cj === 62 || cj === 47) break;
        j++;
      }
      var name = src.slice(lt + 1, j);
      if (!name) { addText('<'); i = lt + 1; continue; }
      var attrs = [];
      var self = false, closed = false;
      while (j < n) {
        while (j < n && isWs(src.charCodeAt(j))) j++;
        var cc = src.charCodeAt(j);
        if (cc === 62) { j++; closed = true; break; }
        if (cc === 47 && src.charCodeAt(j + 1) === 62) { j += 2; closed = true; self = true; break; }
        var as = j;
        while (j < n) {
          var ca = src.charCodeAt(j);
          if (ca === 61 || isWs(ca) || ca === 62 || ca === 47) break;
          j++;
        }
        var an = src.slice(as, j);
        while (j < n && isWs(src.charCodeAt(j))) j++;
        if (src.charCodeAt(j) !== 61) {
          if (an) { attrs.push([an, '']); warnings.push('mismatch'); }
          if (j === as) j++;
          continue;
        }
        if (/["'<]/.test(an)) warnings.push('mismatch');
        j++;
        while (j < n && isWs(src.charCodeAt(j))) j++;
        var q = src[j];
        if (q === '"' || q === "'") {
          var qe = src.indexOf(q, j + 1);
          if (qe < 0) { j = n; break; }
          attrs.push([an, normEol(decodeEntities(src.slice(j + 1, qe)))]);
          j = qe + 1;
        } else {
          var vs = j;
          while (j < n && !isWs(src.charCodeAt(j)) && src.charCodeAt(j) !== 62) j++;
          attrs.push([an, decodeEntities(src.slice(vs, j))]);
        }
      }
      if (!closed) { warnings.push('truncated'); i = n; break; }
      var el = { type: 'el', name: name, attrs: attrs, children: [] };
      count++;
      top().children.push(el);
      if (!self) stack.push(el);
      i = j;
    }
    if (stack.length > 1) warnings.push('truncated');
    return { root: root, decl: decl, warnings: uniq(warnings), elementCount: count };
  }

  function uniq(a) { return a.filter(function (x, k) { return a.indexOf(x) === k; }); }

  function elementChildren(node) {
    return node.children.filter(function (c) { return c.type === 'el'; });
  }

  /* Blocks are the samples: children of the single root element (e.g. testResults),
     or the top-level elements of a pasted fragment. */
  function blocksOf(doc) {
    var tops = elementChildren(doc.root);
    if (tops.length === 1 && elementChildren(tops[0]).length > 0 &&
        tops[0].name !== 'httpSample' && tops[0].name !== 'sample') {
      return { rootName: tops[0].name, rootAttrs: tops[0].attrs, blocks: elementChildren(tops[0]) };
    }
    return { rootName: null, rootAttrs: null, blocks: tops };
  }

  function attr(el, k) {
    for (var i = 0; i < el.attrs.length; i++) if (el.attrs[i][0] === k) return el.attrs[i][1];
    return null;
  }

  function childText(el, name) {
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'el' && c.name === name) return textOf(c);
    }
    return null;
  }

  function textOf(el) {
    var s = '';
    for (var i = 0; i < el.children.length; i++) if (el.children[i].type === 'text') s += el.children[i].text;
    return s;
  }

  var TX_RE = /^Number of samples in transaction/;
  function isTransaction(el) {
    return el.name === 'sample' && !attr(el, 'rc') && TX_RE.test(attr(el, 'rm') || '');
  }

  /* Hiding transaction rows: a parent with nested samples is replaced by its children. */
  function flatten(blocks, hideTx) {
    if (!hideTx) return blocks.slice();
    var out = [];
    (function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (isTransaction(b)) {
          walk(elementChildren(b).filter(function (c) { return c.name === 'sample' || c.name === 'httpSample'; }));
        } else out.push(b);
      }
    })(blocks);
    return out;
  }

  var NONHTTP = 'Non HTTP response code: ';
  /* Filter key and display label for a block's response code. */
  function codeOf(el) {
    if (isTransaction(el)) return { key: '~tx', label: 'Transaction', sort: 3e9 };
    var rc = attr(el, 'rc');
    if (rc === null || rc === '') return { key: '~none', label: 'No code', sort: 4e9 };
    if (rc.indexOf(NONHTTP) === 0) {
      var cls = rc.slice(NONHTTP.length).split('.').pop();
      return { key: 'x:' + cls, label: cls, sort: 2e9 };
    }
    var num = /^\d+$/.test(rc) ? parseInt(rc, 10) : 1e9;
    return { key: 'c:' + rc, label: rc, sort: num };
  }

  var EMPTY_BODY = 'Non-TEXT response data, cannot record: ()';
  function hasResponseBody(el) {
    var t = childText(el, 'responseData');
    return t !== null && t.trim() !== '' && t.trim() !== EMPTY_BODY;
  }

  /* ---------- JSON: strict parse that keeps tokens as written ---------- */

  function parseJson(s) {
    var i = 0, n = s.length;
    function ws() {
      while (i < n) {
        var c = s.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
      }
    }
    function fail() { throw 0; }
    function str() {
      var st = i; i++;
      while (i < n) {
        var c = s.charCodeAt(i);
        if (c === 34) { i++; return s.slice(st, i); }
        if (c === 92) {
          var e = s[i + 1];
          if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.substr(i + 2, 4))) fail(); i += 6; }
          else if ('"\\/bfnrt'.indexOf(e) >= 0 && e !== undefined) i += 2;
          else fail();
          continue;
        }
        if (c < 0x20) fail();
        i++;
      }
      fail();
    }
    var NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    function val(depth) {
      if (depth > 500) fail();
      ws();
      var c = s[i];
      if (c === '{') {
        i++; var mem = []; ws();
        if (s[i] === '}') { i++; return { t: 'o', v: mem }; }
        for (;;) {
          ws(); if (s[i] !== '"') fail();
          var k = str(); ws(); if (s[i] !== ':') fail(); i++;
          mem.push([k, val(depth + 1)]); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === '}') { i++; return { t: 'o', v: mem }; }
          fail();
        }
      }
      if (c === '[') {
        i++; var items = []; ws();
        if (s[i] === ']') { i++; return { t: 'a', v: items }; }
        for (;;) {
          items.push(val(depth + 1)); ws();
          if (s[i] === ',') { i++; continue; }
          if (s[i] === ']') { i++; return { t: 'a', v: items }; }
          fail();
        }
      }
      if (c === '"') return { t: 's', v: str() };
      if (s.startsWith('true', i)) { i += 4; return { t: 'l', v: 'true' }; }
      if (s.startsWith('false', i)) { i += 5; return { t: 'l', v: 'false' }; }
      if (s.startsWith('null', i)) { i += 4; return { t: 'l', v: 'null' }; }
      NUM.lastIndex = i;
      var m = NUM.exec(s);
      if (m && m[0].length) { i += m[0].length; return { t: 'n', v: m[0] }; }
      fail();
    }
    try {
      var v = val(0); ws();
      if (i !== n) return null;
      return v;
    } catch (e) {
      if (e === 0) return null;
      throw e;
    }
  }

  function looksJson(t) {
    var a = t.charCodeAt(0), b = t.charCodeAt(t.length - 1);
    return (a === 123 && b === 125) || (a === 91 && b === 93);
  }

  /* Turn \uXXXX escapes into characters, except where the character would be
     invisible or would change the string's meaning (controls, quote, backslash). */
  function unescapeU(raw) {
    if (raw.indexOf('\\u') < 0) return raw;
    var out = '', i = 0, n = raw.length;
    while (i < n) {
      var c = raw[i];
      if (c !== '\\') { out += c; i++; continue; }
      var e = raw[i + 1];
      if (e !== 'u') { out += c + (e === undefined ? '' : e); i += 2; continue; }
      var cp = parseInt(raw.substr(i + 2, 4), 16);
      if (cp >= 0xd800 && cp <= 0xdbff && raw[i + 6] === '\\' && raw[i + 7] === 'u') {
        var lo = parseInt(raw.substr(i + 8, 4), 16);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          out += String.fromCharCode(cp, lo); i += 12; continue;
        }
      }
      if (cp < 0x20 || cp === 0x22 || cp === 0x5c || (cp >= 0x7f && cp <= 0x9f) ||
          (cp >= 0xd800 && cp <= 0xdfff) || cp === 0x2028 || cp === 0x2029) {
        out += raw.substr(i, 6);
      } else out += String.fromCharCode(cp);
      i += 6;
    }
    return out;
  }

  /* ---------- line model ----------
     A line is { d: depth, t: [[cls, text], ...] }.
     Classes: p punctuation, tg tag, an attribute name, av attribute value,
     tx text, cm comment, jk JSON key, js JSON string, jn number, jl literal. */

  function jsonLines(v, d, out, opts, prefix, suffix) {
    var head = prefix ? prefix.slice() : [];
    function s(raw) { return opts.unescape ? unescapeU(raw) : raw; }
    if (v.t === 'o' || v.t === 'a') {
      var open = v.t === 'o' ? '{' : '[', close = v.t === 'o' ? '}' : ']';
      if (!v.v.length) {
        out.push({ d: d, t: head.concat([['p', open + close]], suffix ? [['p', suffix]] : []) });
        return;
      }
      out.push({ d: d, t: head.concat([['p', open]]) });
      for (var k = 0; k < v.v.length; k++) {
        var last = k === v.v.length - 1;
        if (v.t === 'o') {
          jsonLines(v.v[k][1], d + 1, out, opts, [['jk', s(v.v[k][0])], ['p', ': ']], last ? '' : ',');
        } else jsonLines(v.v[k], d + 1, out, opts, null, last ? '' : ',');
      }
      out.push({ d: d, t: [['p', close]].concat(suffix ? [['p', suffix]] : []) });
      return;
    }
    var cls = v.t === 's' ? 'js' : v.t === 'n' ? 'jn' : 'jl';
    head.push([cls, v.t === 's' ? s(v.v) : v.v]);
    if (suffix) head.push(['p', suffix]);
    out.push({ d: d, t: head });
  }

  function trimBlankLines(t) {
    return t.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
  }

  function openTag(el, d, out, opts) {
    if (opts.attrs === 'stacked' && el.attrs.length > 1) {
      out.push({ d: d, t: [['p', '<'], ['tg', el.name]] });
      for (var i = 0; i < el.attrs.length; i++) {
        out.push({ d: d + 1, t: [['an', el.attrs[i][0]], ['p', '='], ['av', '"' + el.attrs[i][1] + '"']] });
      }
      return out[out.length - 1];
    }
    var t = [['p', '<'], ['tg', el.name]];
    for (var k = 0; k < el.attrs.length; k++) {
      t.push(['p', ' '], ['an', el.attrs[k][0]], ['p', '='], ['av', '"' + el.attrs[k][1] + '"']);
    }
    var line = { d: d, t: t };
    out.push(line);
    return line;
  }

  function isEmptyEl(el) {
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.type === 'el' || c.type === 'comment') return false;
      if (c.type === 'text' && c.text.trim() !== '') return false;
    }
    return true;
  }

  /* opts: { indent, attrs: 'inline'|'stacked', empty: bool (show empty), unescape: bool }
     stats (optional): { json, text } counters */
  function elementLines(el, d, out, opts, stats) {
    var closeT = [['p', '</'], ['tg', el.name], ['p', '>']];
    if (isEmptyEl(el)) {
      if (!opts.empty) return out;
      var l0 = openTag(el, d, out, opts);
      l0.t.push(['p', el.children.length ? '></' : '/>']);
      if (el.children.length) l0.t.push(['tg', el.name], ['p', '>']);
      return out;
    }
    var kids = el.children;
    var hasEl = kids.some(function (c) { return c.type !== 'text'; });
    if (!hasEl) {
      var t = trimBlankLines(normEol(textOf(el)));
      var trimmed = t.trim();
      var json = looksJson(trimmed) ? parseJson(trimmed) : null;
      var l1 = openTag(el, d, out, opts);
      l1.t.push(['p', '>']);
      if (json) {
        if (stats) stats.json++;
        jsonLines(json, d + 1, out, opts, null, '');
        out.push({ d: d, t: closeT });
      } else if (t.indexOf('\n') < 0 && (opts.attrs !== 'stacked' || el.attrs.length <= 1)) {
        l1.t.push(['tx', t.trim()]);
        Array.prototype.push.apply(l1.t, closeT);
      } else {
        if (stats) stats.text++;
        var ls = t.split('\n');
        for (var k = 0; k < ls.length; k++) out.push({ d: d + 1, t: [['tx', ls[k]]] });
        out.push({ d: d, t: closeT });
      }
      return out;
    }
    var l2 = openTag(el, d, out, opts);
    l2.t.push(['p', '>']);
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.type === 'el') elementLines(c, d + 1, out, opts, stats);
      else if (c.type === 'comment') out.push({ d: d + 1, t: [['cm', '<!--' + c.text + '-->']] });
      else {
        var tt = trimBlankLines(normEol(c.text));
        if (tt.trim()) tt.split('\n').forEach(function (x) { out.push({ d: d + 1, t: [['tx', x]] }); });
      }
    }
    out.push({ d: d, t: closeT });
    return out;
  }

  function lineText(line, unit) {
    var s = unit.repeat(line.d);
    for (var i = 0; i < line.t.length; i++) s += line.t[i][1];
    return s;
  }

  function blockText(el, opts) {
    var unit = ' '.repeat(opts.indent || 2);
    return elementLines(el, 0, [], opts).map(function (l) { return lineText(l, unit); }).join('\n');
  }

  /* Flat lowercase text used by Find: decoded attribute values and text. */
  function searchText(el) {
    var parts = [];
    (function walk(e) {
      parts.push(e.name);
      for (var i = 0; i < e.attrs.length; i++) parts.push(e.attrs[i][0] + '="' + e.attrs[i][1] + '"');
      for (var k = 0; k < e.children.length; k++) {
        var c = e.children[k];
        if (c.type === 'el') walk(c); else parts.push(c.text);
      }
    })(el);
    return unescapeU(parts.join('\n')).toLowerCase();
  }

  g.XBCore = {
    decodeEntities: decodeEntities,
    parseXml: parseXml,
    blocksOf: blocksOf,
    flatten: flatten,
    isTransaction: isTransaction,
    codeOf: codeOf,
    attr: attr,
    childText: childText,
    hasResponseBody: hasResponseBody,
    parseJson: parseJson,
    unescapeU: unescapeU,
    elementLines: elementLines,
    normEol: normEol,
    lineText: lineText,
    blockText: blockText,
    searchText: searchText,
    EMPTY_BODY: EMPTY_BODY
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
