/* XML Beautifier UI */
(function () {
  'use strict';
  var C = globalThis.XBCore;
  var $ = function (id) { return document.getElementById(id); };

  var DEFAULTS = { indent: 2, attrs: 'inline', wrap: true, empty: true, unescape: true, split: 40 };
  var KEY = 'xmlBeautifier.settings.v1';
  var EXPAND_LIMIT = 20;
  var LINE_H = 20;
  var INPUT_LIMIT = 2000000; // characters; larger files are not copied into the input box

  var settings = loadSettings();
  var state = {
    name: '', size: 0, source: null, // 'file' | 'paste'
    doc: null, blocks: [], rootName: null,
    items: [], shown: [], codes: [], selected: null,
    find: '', txCount: 0, warnings: [], noBodies: false
  };
  var expandedMap = new WeakMap();
  var searchCache = new WeakMap();

  /* ---------- settings ---------- */
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { s = {}; }
    var out = {};
    for (var k in DEFAULTS) out[k] = Object.prototype.hasOwnProperty.call(s, k) ? s[k] : DEFAULTS[k];
    if (out.indent !== 2 && out.indent !== 4) out.indent = 2;
    if (out.attrs !== 'inline' && out.attrs !== 'stacked') out.attrs = 'inline';
    if (!(out.split >= 20 && out.split <= 80)) out.split = 40;
    return out;
  }
  function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* storage unavailable */ } }
  function opts() { return { indent: settings.indent, attrs: settings.attrs, empty: settings.empty, unescape: settings.unescape }; }

  function syncSettingsUi() {
    document.querySelectorAll('.seg[data-setting]').forEach(function (g) {
      var k = g.getAttribute('data-setting');
      g.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === String(settings[k]))); });
    });
    document.querySelectorAll('input[data-setting]').forEach(function (c) { c.checked = !!settings[c.getAttribute('data-setting')]; });
    $('scroller').classList.toggle('wrap', !!settings.wrap);
    applySplit();
  }

  /* ---------- favicon from the accent variable ---------- */
  function drawFavicon() {
    var acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 8 48 48"><rect x="8" y="8" width="48" height="48" rx="13" fill="' + acc +
      '"/><g fill="none" stroke="' + bg + '" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22.5 23.5 15 32l7.5 8.5"/><path d="M35.5 21.5 28.5 42.5"/><path d="M41.5 23.5 49 32l-7.5 8.5"/></g></svg>';
    $('favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /* ---------- helpers ---------- */
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; }); }
  function fmtN(n) { return n.toLocaleString('en-US'); }
  function fmtSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB'; }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function fmtTime(ms) {
    var d = new Date(ms);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  }
  function fmtDate(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + fmtTime(ms) + '.' + pad(d.getMilliseconds(), 3);
  }

  /* Escape text and wrap Find matches in <mark>. */
  function hl(s) {
    var f = state.find;
    if (!f) return esc(s);
    var low = s.toLowerCase(), out = '', i = 0, k;
    if (low.length !== s.length) return esc(s);
    while ((k = low.indexOf(f, i)) >= 0) {
      out += esc(s.slice(i, k)) + '<mark>' + esc(s.slice(k, k + f.length)) + '</mark>';
      i = k + f.length;
    }
    return out + esc(s.slice(i));
  }

  /* Quoted values: the content is isolated so Arabic runs never reorder the quotes. */
  function quoted(cls, s) {
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      return '<span class="' + cls + '">"<bdi>' + hl(s.slice(1, -1)) + '</bdi>"</span>';
    }
    return '<span class="' + cls + '">' + hl(s) + '</span>';
  }

  function lineHtml(line, unit) {
    var ind = line.d * unit;
    var h = '<div class="ln" style="--i:' + ind + '">' + ' '.repeat(ind);
    for (var i = 0; i < line.t.length; i++) {
      var t = line.t[i], cls = t[0], s = t[1];
      if (cls === 'av' || cls === 'js' || cls === 'jk') h += quoted(cls, s);
      else if (cls === 'tx') h += '<span class="tx"><bdi>' + hl(s) + '</bdi></span>';
      else h += '<span class="' + cls + '">' + hl(s) + '</span>';
    }
    return h + '</div>';
  }

  /* ---------- loading ---------- */
  function sniffEncoding(bytes) {
    var head = '';
    for (var i = 0; i < Math.min(bytes.length, 200); i++) head += String.fromCharCode(bytes[i]);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    var m = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
    return m ? m[1] : 'utf-8';
  }

  function loadFile(file) {
    if (!file) return;
    setBusy('Reading ' + file.name + '…');
    file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var dec;
      try { dec = new TextDecoder(sniffEncoding(bytes)); } catch (e) { dec = new TextDecoder('utf-8'); }
      var text = C.normEol(dec.decode(bytes));
      var fits = text.length <= INPUT_LIMIT;
      $('paste').value = fits ? text : '';
      $('paste').hidden = !fits;
      $('pasteNoteMsg').textContent = fits ? '' : 'Too large to show here (' + fmtSize(file.size) + ').';
      $('pasteNote').hidden = fits;
      setInputOpen(fits);
      state.name = file.name; state.size = file.size; state.source = 'file';
      run(text);
    }, function () {
      showEmpty('Could not read ' + file.name + '.', true);
    });
  }

  function setBusy(msg) {
    $('meta').textContent = msg;
  }

  var pasteTimer = 0;
  function onPaste() {
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(function () {
      var v = $('paste').value;
      if (!v.trim()) {
        if (state.source) reset();
        $('clearBtn').disabled = state.source !== 'file';
        return;
      }
      if (state.source !== 'file') { state.name = 'pasted'; state.source = 'paste'; }
      state.size = new Blob([v]).size;
      run(v);
    }, 250);
  }

  function reset() {
    state.doc = null; state.blocks = []; state.items = []; state.shown = []; state.codes = [];
    state.source = null; state.name = ''; state.size = 0; state.warnings = []; state.noBodies = false;
    $('pasteErr').hidden = true;
    $('pasteNote').hidden = true;
    $('paste').hidden = false;
    $('inMeta').textContent = '';
    $('filterBar').hidden = true;
    closeCodes();
    $('codesBox').hidden = true;
    $('list').innerHTML = '';
    $('meta').textContent = '';
    $('flags').innerHTML = '';
    $('outName').textContent = 'output';
    $('jobName').textContent = ''; $('jobSize').textContent = '';
    setEnabled(false);
    $('clearBtn').disabled = true;
    showEmpty('Drop an error XML or paste it.', false);
  }

  function run(text) {
    setBusy('Parsing…');
    setTimeout(function () {
      var doc = C.parseXml(text);
      var b = C.blocksOf(doc);
      $('clearBtn').disabled = false;
      $('jobName').textContent = state.name;
      $('jobSize').textContent = fmtSize(state.size);
      $('inMeta').textContent = fmtSize(state.size) + ' · ' + fmtN(lineCount(text)) + ' lines';
      $('outName').textContent = state.source === 'file' ? state.name : 'pasted';
      if (!b.blocks.length) {
        state.doc = null; state.items = []; state.shown = [];
        $('list').innerHTML = ''; $('codesBox').hidden = true; $('filterBar').hidden = true; $('flags').innerHTML = ''; $('meta').textContent = '';
        setEnabled(false);
        var msg = 'No XML elements found.';
        if (state.source) { $('pasteErr').textContent = msg; $('pasteErr').hidden = false; }
        showEmpty(msg, true);
        return;
      }
      $('pasteErr').hidden = true;
      $('filterBar').hidden = false;
      state.doc = doc; state.blocks = b.blocks; state.rootName = b.rootName;
      state.warnings = doc.warnings;
      state.selected = null;
      rebuildItems();
    }, 20);
  }

  /* Items follow the Transaction rows toggle; codes are rebuilt from them. */
  function rebuildItems() {
    var hideTx = !$('txRows').checked;
    var flat = C.flatten(state.blocks, hideTx);
    var all = C.flatten(state.blocks, false);
    state.txCount = all.filter(C.isTransaction).length;
    var autoOpen = flat.length <= EXPAND_LIMIT;
    var http = 0, withBody = 0;
    state.items = flat.map(function (el, k) {
      if (el.name === 'httpSample') { http++; if (C.hasResponseBody(el)) withBody++; }
      if (!expandedMap.has(el)) expandedMap.set(el, autoOpen);
      return { el: el, n: k + 1, code: C.codeOf(el) };
    });
    state.noBodies = http > 0 && withBody === 0;
    buildCodes();
    applyFilter();
  }

  function buildCodes() {
    var map = {};
    state.items.forEach(function (it) {
      var c = it.code;
      if (c.key === '~tx') return;
      var m = map[c.key] || (map[c.key] = { key: c.key, label: c.label, sort: c.sort, n: 0, rm: {} });
      m.n++;
      if (c.key.indexOf('c:') === 0) {
        var rm = C.attr(it.el, 'rm') || '';
        m.rm[rm] = (m.rm[rm] || 0) + 1;
      }
    });
    var list = Object.keys(map).map(function (k) { return map[k]; });
    list.sort(function (a, b) { return a.sort - b.sort || (a.label < b.label ? -1 : 1); });
    list.forEach(function (m) {
      var best = '', bn = 0;
      for (var r in m.rm) if (m.rm[r] > bn) { bn = m.rm[r]; best = r; }
      m.msg = best;
    });
    if (!state.selected) state.selected = {};
    var sel = {};
    list.forEach(function (m) { sel[m.key] = state.selected[m.key] !== false; });
    state.selected = sel;
    state.codes = list;
    var box = $('codesBox');
    if (list.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    var h = '<label class="coderow all"><input type="checkbox" id="codeAll"><span class="c">All</span><span class="m"></span><span class="n">' + fmtN(list.reduce(function (s, m) { return s + m.n; }, 0)) + '</span></label>';
    list.forEach(function (m) {
      h += '<label class="coderow" title="' + esc(m.label + (m.msg ? ' ' + m.msg : '')) + '"><input type="checkbox" data-code="' + esc(m.key) + '"' + (sel[m.key] ? ' checked' : '') + '>' +
        '<span class="c">' + esc(m.label) + '</span><span class="m">' + esc(m.msg) + '</span><span class="n">' + fmtN(m.n) + '</span></label>';
    });
    $('codes').innerHTML = h;
    syncAll();
  }

  function syncAll() {
    var all = $('codeAll');
    if (!all) return;
    var keys = Object.keys(state.selected);
    var on = keys.filter(function (k) { return state.selected[k]; }).length;
    all.checked = on === keys.length;
    all.indeterminate = on > 0 && on < keys.length;
    $('codesLbl').textContent = on === keys.length ? 'All codes' : on + ' of ' + keys.length + ' codes';
  }

  function searchOf(el) {
    var s = searchCache.get(el);
    if (s === undefined) { s = C.searchText(el); searchCache.set(el, s); }
    return s;
  }

  function applyFilter() {
    var f = state.find;
    state.shown = state.items.filter(function (it) {
      if (it.code.key !== '~tx' && state.selected && state.selected[it.code.key] === false) return false;
      if (f && searchOf(it.el).indexOf(f) < 0) return false;
      return true;
    });
    renderList();
    renderMeta();
  }

  function renderMeta() {
    var total = state.items.length, shown = state.shown.length;
    var parts = [];
    parts.push(shown === total ? '<b>' + fmtN(total) + '</b> samples' : '<b>' + fmtN(shown) + '</b> of ' + fmtN(total) + ' samples');
    if (state.txCount && !$('txRows').checked) parts.push(fmtN(state.txCount) + ' transaction rows hidden');
    if (state.rootName) parts.push('&lt;' + esc(state.rootName) + '&gt;');
    $('meta').innerHTML = parts.join(' · ');
    var flags = [];
    if (state.warnings.indexOf('truncated') >= 0) flags.push(['Truncated', 'The file ends before its closing tags. The last sample may be incomplete.']);
    if (state.warnings.indexOf('mismatch') >= 0) flags.push(['Not well-formed', 'Some tags or attributes are broken (e.g. a value with an unescaped quote, or a closing tag that does not match). Output for those lines may be wrong.']);
    if (state.noBodies) flags.push(['No response bodies', 'No sample has a response body. Distributed runs drop them unless sample_sender_strip_also_on_error=false is set on every load generator.']);
    $('flags').innerHTML = flags.map(function (f) { return '<span class="flagtag" tabindex="0" title="' + esc(f[1]) + '">' + esc(f[0]) + '</span>'; }).join('');
    setEnabled(shown > 0);
  }

  function setEnabled(on) {
    $('copyBtn').disabled = !on; $('dlBtn').disabled = !on;
    $('expandAll').disabled = !on; $('collapseAll').disabled = !on;
  }

  function showEmpty(msg, bad) {
    $('emptyMsg').textContent = msg;
    $('empty').classList.toggle('bad', !!bad);
    $('empty').hidden = false;
  }

  /* ---------- list rendering (lazy bodies) ---------- */
  var io = null;
  function shortLabel(lb) {
    var m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(lb);
    return m ? (m[1] || '/') : lb;
  }

  function headerHtml(it, idx) {
    var el = it.el, open = expandedMap.get(el);
    var h = '<span class="chev"><svg class="i" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></span><span class="ix">#' + it.n + '</span>';
    var lb = C.attr(el, 'lb'), ts = C.attr(el, 'ts'), title = [];
    if (C.isTransaction(el)) {
      h += '<span class="tx">TX</span><span class="lb"><bdi>' + esc(lb || '') + '</bdi></span>';
      title.push(lb || '');
    } else if (el.name === 'httpSample' || el.name === 'sample') {
      var rc = C.attr(el, 'rc') || '', rm = C.attr(el, 'rm') || '';
      if (it.code.key.indexOf('x:') === 0) h += '<span class="rc">' + esc(it.code.label) + '</span>';
      else { h += '<span class="rc">' + esc(rc || '—') + '</span>'; if (rm) h += '<span class="rm">' + esc(rm) + '</span>'; }
      h += '<span class="lb"><bdi>' + esc(shortLabel(lb || '')) + '</bdi></span>';
      title.push(rc + (rm ? ' ' + rm : ''), lb || '');
    } else {
      var first = el.attrs[0];
      h += '<span class="rc">' + esc(el.name) + '</span><span class="lb"><bdi>' + (first ? esc(first[0] + '="' + first[1] + '"') : '') + '</bdi></span>';
      title.push(el.name);
    }
    if (ts && /^\d{10,}$/.test(ts)) { h += '<span class="ts">' + fmtTime(+ts) + '</span>'; title.push(fmtDate(+ts)); }
    var tn = C.attr(el, 'tn'); if (tn) title.push(tn);
    var hn = C.attr(el, 'hn'); if (hn) title.push(hn);
    return '<div class="blk' + (open ? ' open' : '') + '" role="listitem" data-k="' + idx + '"><div class="bh">' +
      '<button class="tog" type="button" aria-expanded="' + open + '" aria-controls="bb' + idx + '" title="' + esc(title.join('\n')) + '">' + h + '</button>' +
      '<button class="ib bcopy" type="button" aria-label="Copy sample ' + it.n + '" title="Copy sample"><svg class="i" viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>' +
      '</div><div class="bb" id="bb' + idx + '"' + (open ? '' : ' hidden') + '></div></div>';
  }

  function estimate(it) {
    if (!it.lines) it.lines = C.elementLines(it.el, 0, [], opts()).length;
    return it.lines * LINE_H + 20;
  }

  function renderList() {
    if (io) io.disconnect();
    var list = $('list');
    if (!state.shown.length) {
      list.innerHTML = '';
      if (state.doc) showEmpty('No samples match.', false);
      return;
    }
    $('empty').hidden = true;
    var html = '';
    for (var i = 0; i < state.shown.length; i++) html += headerHtml(state.shown[i], i);
    list.innerHTML = html;
    io = new IntersectionObserver(onIntersect, { root: $('scroller'), rootMargin: '1200px 0px' });
    var bodies = list.children;
    for (var k = 0; k < bodies.length; k++) {
      var it = state.shown[k];
      it.rendered = false;
      if (expandedMap.get(it.el)) placeBody(bodies[k].lastChild, it);
    }
    setVw();
  }

  function placeBody(bb, it) {
    bb.hidden = false;
    bb.innerHTML = '';
    bb.style.height = (it.h || estimate(it)) + 'px';
    it.rendered = false;
    io.observe(bb);
  }

  function fillBody(bb, it) {
    var lines = C.elementLines(it.el, 0, [], opts());
    it.lines = lines.length;
    var unit = settings.indent, h = '';
    for (var i = 0; i < lines.length; i++) h += lineHtml(lines[i], unit);
    bb.innerHTML = h;
    bb.style.height = '';
    it.rendered = true;
  }

  function onIntersect(entries) {
    entries.forEach(function (e) {
      var bb = e.target, k = +bb.parentNode.getAttribute('data-k'), it = state.shown[k];
      if (!it || !expandedMap.get(it.el)) return;
      if (e.isIntersecting && !it.rendered) fillBody(bb, it);
      else if (!e.isIntersecting && it.rendered) {
        it.h = bb.offsetHeight;
        bb.style.height = it.h + 'px';
        bb.innerHTML = '';
        it.rendered = false;
      }
    });
  }

  function toggle(k, force) {
    var it = state.shown[k];
    var blk = $('list').children[k];
    var open = force === undefined ? !expandedMap.get(it.el) : force;
    expandedMap.set(it.el, open);
    blk.classList.toggle('open', open);
    blk.querySelector('.tog').setAttribute('aria-expanded', String(open));
    var bb = blk.lastChild;
    if (open) placeBody(bb, it);
    else { io.unobserve(bb); bb.hidden = true; bb.innerHTML = ''; bb.style.height = ''; it.rendered = false; }
  }

  function setAll(open) {
    state.shown.forEach(function (it) { expandedMap.set(it.el, open); });
    var top = $('scroller').scrollTop;
    renderList();
    if (!open) $('scroller').scrollTop = Math.min(top, $('scroller').scrollHeight);
  }

  function setVw() { $('list').style.setProperty('--vw', $('scroller').clientWidth + 'px'); }

  /* Settings that change the output re-render it from scratch. */
  function rerender() {
    state.items.forEach(function (it) { it.lines = 0; it.h = 0; });
    if (state.doc) renderList();
  }

  /* ---------- copy / download ---------- */
  function shownText() {
    var o = opts();
    return state.shown.map(function (it) { return C.blockText(it.el, o); }).join('\n\n') + '\n';
  }

  function copyText(text, btn) {
    var done = function () { flash(btn); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text) && done(); });
    } else if (legacyCopy(text)) done();
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  function flash(btn) {
    btn.classList.add('ok');
    var lbl = btn.querySelector('.bl'), old = lbl && lbl.textContent;
    if (lbl) lbl.textContent = 'Copied';
    setTimeout(function () { btn.classList.remove('ok'); if (lbl) lbl.textContent = old; }, 1200);
  }

  function download() {
    var base = state.source === 'file' ? state.name.replace(/\.[^.]+$/, '') : 'pasted';
    var blob = new Blob([shownText()], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = base + '.beautified.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------- drawer ---------- */
  var lastFocus = null;
  function openDrawer() {
    lastFocus = document.activeElement;
    $('scrim').hidden = false; $('drawer').hidden = false;
    var first = $('drawer').querySelector('.seg button');
    if (first) first.focus();
  }
  function closeDrawer() {
    $('scrim').hidden = true; $('drawer').hidden = true;
    if (lastFocus) lastFocus.focus();
  }

  function lineCount(t) {
    var n = 1, i = -1;
    while ((i = t.indexOf('\n', i + 1)) >= 0) n++;
    return n;
  }

  /* ---------- input pane and divider ---------- */
  function applySplit() {
    $('work').style.setProperty('--inw', settings.split + '%');
    $('split').setAttribute('aria-valuenow', String(Math.round(settings.split)));
  }
  function setInputOpen(open) {
    $('work').classList.toggle('nosplit', !open);
    $('showIn').hidden = open;
    setVw();
  }
  function initSplit() {
    var sp = $('split'), work = $('work');
    function toPct(x) {
      var r = work.getBoundingClientRect();
      var px = Math.min(Math.max(x - r.left, 240), r.width - 320);
      return Math.min(80, Math.max(20, px / r.width * 100));
    }
    sp.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('drag'); document.body.classList.add('resizing');
      function move(ev) { settings.split = toPct(ev.clientX); applySplit(); setVw(); }
      function up() {
        sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up);
        sp.classList.remove('drag'); document.body.classList.remove('resizing');
        saveSettings();
      }
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', function () { settings.split = DEFAULTS.split; applySplit(); saveSettings(); setVw(); });
    sp.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowLeft' ? -2 : e.key === 'ArrowRight' ? 2 : 0;
      if (!d) return;
      e.preventDefault();
      settings.split = Math.min(80, Math.max(20, settings.split + d));
      applySplit(); saveSettings(); setVw();
    });
  }

  /* ---------- response-code dropdown ---------- */
  function openCodes() { $('codesPop').hidden = false; $('codesBtn').setAttribute('aria-expanded', 'true'); var f = $('codesPop').querySelector('input'); if (f) f.focus(); }
  function closeCodes() { $('codesPop').hidden = true; $('codesBtn').setAttribute('aria-expanded', 'false'); }

  /* ---------- wiring ---------- */
  function init() {
    drawFavicon();
    syncSettingsUi();
    reset();

    $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('jobField').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) { loadFile(e.target.files[0]); e.target.value = ''; });
    $('paste').addEventListener('input', onPaste);
    /* Browsers turn each CR in pasted text into its own line break, so CR CR LF
       (common from Windows tools) would paste as a blank line after every line. */
    $('paste').addEventListener('paste', function (e) {
      var t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!t || t.indexOf('\r') < 0) return;
      e.preventDefault();
      var ta = $('paste');
      ta.setRangeText(C.normEol(t), ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    });
    $('clearBtn').addEventListener('click', function () { $('paste').value = ''; reset(); setInputOpen(true); $('paste').focus(); });
    $('hideIn').addEventListener('click', function () { setInputOpen(false); $('showIn').focus(); });
    $('showIn').addEventListener('click', function () { setInputOpen(true); $('hideIn').focus(); });
    initSplit();
    $('codesBtn').addEventListener('click', function () { if ($('codesPop').hidden) openCodes(); else closeCodes(); });
    document.addEventListener('click', function (e) { if (!$('codesPop').hidden && !e.target.closest('#codesBox')) closeCodes(); });

    var findTimer = 0;
    $('find').addEventListener('input', function () {
      clearTimeout(findTimer);
      findTimer = setTimeout(function () {
        state.find = $('find').value.toLowerCase();
        if (state.doc) applyFilter();
      }, 200);
    });
    $('txRows').addEventListener('change', function () { if (state.doc) rebuildItems(); });
    $('codes').addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'codeAll') {
        for (var k in state.selected) state.selected[k] = t.checked;
        $('codes').querySelectorAll('input[data-code]').forEach(function (c) { c.checked = t.checked; });
      } else if (t.hasAttribute('data-code')) state.selected[t.getAttribute('data-code')] = t.checked;
      syncAll();
      applyFilter();
    });

    $('list').addEventListener('click', function (e) {
      var blk = e.target.closest('.blk');
      if (!blk) return;
      var k = +blk.getAttribute('data-k');
      if (e.target.closest('.bcopy')) {
        var b = e.target.closest('.bcopy');
        copyText(C.blockText(state.shown[k].el, opts()) + '\n', b);
      } else if (e.target.closest('.tog')) toggle(k);
    });
    $('expandAll').addEventListener('click', function () { setAll(true); });
    $('collapseAll').addEventListener('click', function () { setAll(false); });
    $('copyBtn').addEventListener('click', function () { copyText(shownText(), $('copyBtn')); });
    $('dlBtn').addEventListener('click', download);

    $('gearBtn').addEventListener('click', openDrawer);
    $('drawerClose').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
      else if (e.key === 'Escape' && !$('codesPop').hidden) { closeCodes(); $('codesBtn').focus(); }
    });
    $('drawer').addEventListener('click', function (e) {
      var b = e.target.closest('.seg button');
      if (!b) return;
      var k = b.parentNode.getAttribute('data-setting'), v = b.getAttribute('data-v');
      settings[k] = k === 'indent' ? +v : v;
      saveSettings(); syncSettingsUi(); rerender();
    });
    $('drawer').addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-setting');
      if (!k) return;
      settings[k] = e.target.checked;
      saveSettings(); syncSettingsUi(); rerender();
    });
    $('resetBtn').addEventListener('click', function () {
      settings = JSON.parse(JSON.stringify(DEFAULTS));
      saveSettings(); syncSettingsUi(); rerender();
    });

    /* drag and drop anywhere */
    var depth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      e.preventDefault(); depth++; $('drop').hidden = false;
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
    window.addEventListener('drop', function (e) {
      e.preventDefault(); depth = 0; $('drop').hidden = true;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });

    if (window.ResizeObserver) new ResizeObserver(setVw).observe($('scroller'));
  }

  init();
})();
