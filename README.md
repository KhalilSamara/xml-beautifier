# XML Beautifier

Beautifies JMeter error XML (View Results Tree saved as XML), the way a JSON beautifier does for JSON.

- Decodes XML entities (`&quot; &apos; &amp; &lt; &gt; &#xd;` …).
- Pretty-prints JSON bodies, keeping every value exactly as recorded.
- Shows Arabic text correctly.
- Collapsible samples, Find, response-code filter, copy and download.

Everything runs in the browser. Nothing is uploaded, and it works offline.

## Use

- Online: https://khalilsamara.github.io/xml-beautifier/
- Offline: copy `dist/xml-beautifier.html` to the machine and open it.

## Build

```
node tools/build.mjs        # writes dist/xml-beautifier.html and index.html (Pages)
node --test test/*.test.mjs # unit tests
```

No dependencies. Source is in `src/`; `tokens.css` holds the colours.
