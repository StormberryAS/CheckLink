// The stage 3 fixes of 11 October 2026: the findings of the interface review of stage 3 (the
// camera and the look-alike notes at 320, 390 and 1280 pixels) that can be checked without a
// browser, as the engine reports them and as the page's own files are written. The camera
// review's findings live in tests/camera-privacy-review.test.mjs and the look-alike accuracy
// review's in tests/lookalike-accuracy.test.mjs; tests/ui-smoke.mjs checks the placement on screen
// (H1, M2, M4, L4), the boxed letters and the first-screen notice (M1, H2) and what a screen
// reader hears (M5, L2).
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/link-core.js';
import { brandMatch, markedHost } from '../src/lookalike.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const app = text('app.js');
const html = text('index.html');
const css = text('style.css');
const LOOK = new Set(['look-alike-letters', 'look-alike-symbol', 'look-alike-brand', 'hidden-look-alike']);
const look = (r) => r.warnings.find((w) => LOOK.has(w.id));
const show = (r) => JSON.stringify(r.warnings.map((w) => `${w.id}/${w.tier}: ${w.text}`));

describe('H2 and M5: every look-alike note has a short form for the first screen and for screen readers', () => {
  for (const [input, short] of [
    ['https://pаypal.com/signin', 'This address is made to look like paypal.com.'],
    ['https://paypa1.com/', 'This address is made to look like paypal.com.'],
    ['https://gooogle.com/', 'This address is made to look like google.com.'],
    ['https://paypal-secure-login.com/', "This address mentions PayPal, but it is not one of PayPal's addresses that CheckLink knows."],
    ['https://paypal.com.evil.io/', 'This address has paypal.com written in it, but it belongs to evil.io.'],
    ['https://www.amazon.co.uk.evil.io/', 'This address has amazon.co.uk written in it, but it belongs to evil.io.'],
    ['https://paypal.pages.dev/', 'This address mentions PayPal, but it is a name under pages.dev that anyone can create.'],
    ['https://www.norsk‐tipping.no/', 'This address is made to look like norsk-tipping.no.'],
    ['https://сосо.com/', 'This address uses letters from another alphabet to look like coco.com.'],
    ['https://example.com/login?next=https://paypa1.com/', 'The address hidden inside this link is made to look like paypal.com.'],
  ]) {
    test(`${input}: "${short}"`, () => {
      const r = analyse(input);
      const w = look(r);
      assert.ok(w, show(r));
      assert.equal(w.short, short);
    });
  }

  test('the page shows the short form in the summary card and says it after the count of things to check', () => {
    assert.match(html, /<p class="cl-notice" id="lookalike-notice" data-tier="amber" hidden><\/p>/);
    assert.match(app, /setNotice\(\$\('lookalike-notice'\), look \? \{ tier: look\.tier, text: `\$\{look\.short \|\| look\.text\} Details under Things to know\.` \} : null\);/);
    assert.match(app, /\$\{plural\(checks, 'thing', 'things'\)\} to check\$\{look && look\.short \? `: \$\{lowerFirst\(look\.short\)\}` : '\.'\}/);
  });

  test('a web code whose link has something to check says so on its card, at that tier', () => {
    assert.match(app, /function webCodeNote\(p\) \{/);
    assert.match(app, /const tier = web && \(web\.tier === 'stop' \|\| p\.tier === 'info'\) \? web\.tier : p\.tier;/);
  });
});

describe('M1: the address in a look-alike note never looks exactly like the real one', () => {
  test('letters from another alphabet are named in brackets, runs of them together, the ending left alone', () => {
    assert.equal(markedHost('xn--pypal-4ve.com'), 'p[Cyrillic а]ypal.com');
    assert.equal(markedHost('xn--80ak6aa92e.xn--p1ai'), '[Cyrillic аррӏе].рф');
    assert.equal(markedHost('www.xn--pypal-4ve.com'), 'www.p[Cyrillic а]ypal.com');
    assert.equal(markedHost(new URL('https://bl\u00E5b\u00E6r.no/').hostname), 'bl\u00E5b\u00E6r.no', 'Norwegian letters are Latin');
    assert.equal(markedHost('example.com'), 'example.com');
  });

  test('the note starts "This address", like the others, and shows the marked name', () => {
    const w = look(analyse('https://pаypal.com/'));
    assert.match(w.text, /^This address has Cyrillic letters that look like Latin ones\. It reads like paypal\.com, but it is a different address: p\[Cyrillic а\]ypal\.com \(in the browser's form, xn--pypal-4ve\.com\)\./);
  });

  test('the analysis lists the letters to box where the page shows the address', () => {
    assert.deepEqual(analyse('https://pаypal.com/').lookAlikeLetters, [{ char: 'а', script: 'Cyrillic' }]);
    assert.deepEqual(analyse('https://paypal.com/').lookAlikeLetters, []);
    // A Russian word under the Cyrillic ending is ordinary there: nothing is boxed.
    assert.deepEqual(analyse('https://пример.рф/').lookAlikeLetters, []);
  });

  test('the box is drawn by the style sheet alone, so the address copies as written, and the legend explains it', () => {
    const rule = /\.cl-foreign \{[^}]*\}/.exec(css)[0];
    assert.ok(!/content\s*:/.test(rule), 'no generated text');
    assert.match(rule, /border: 1px solid/);
    assert.match(html, /<li id="legend-foreign" hidden><span class="cl-foreign">a<\/span> Boxed letter: from another alphabet; it only looks like a Latin letter\.<\/li>/);
    assert.match(app, /\$\('legend-foreign'\)\.hidden = !document\.querySelector\('#full-link \.cl-foreign, #target-link \.cl-foreign'\);/);
  });

  test('a letter put in that a reader would not mistake is named: "with ø in place of o", not "letters that only look the same"', () => {
    const w = look(analyse('https://pøsten.no/'));
    assert.ok(w.text.startsWith('This address is made to look like posten.no, with ø in place of o: it is pøsten.no'), w.text);
    assert.ok(look(analyse('https://vípps.no/')).text.includes('with í in place of i'));
    assert.equal(brandMatch('xn--psten-vua.no').detail, 'ø in place of o');
  });
});

describe('notes said once and written the British way', () => {
  test('a look-alike hidden in next= gives one note, not a second one naming the same address', () => {
    const r = analyse('https://example.com/login?next=https://paypa1.com/');
    assert.equal(r.warnings.filter((w) => w.id === 'hidden-look-alike').length, 1, show(r));
    assert.equal(r.warnings.filter((w) => w.id === 'hidden-address').length, 0, show(r));
    // Without a look-alike the plain note stays.
    assert.ok(analyse('https://example.com/go?next=https://evil.example/x').warnings.find((w) => w.id === 'hidden-address'));
  });

  test("a brand name ending in s takes 's (Vipps's own address)", () => {
    assert.ok(look(analyse('https://vipps-refusjon.com/')).text.endsWith("Vipps's own address is vipps.no."));
  });

  test('a short xn-- name in a note is kept on one line', () => {
    assert.match(app, /function noteText\(text\) \{/);
    assert.match(css, /\.cl-nowrap \{ white-space: nowrap; \}/);
  });

  test("the camera messages use the same plain apostrophe as the rest of the page's words", () => {
    const cam = /const CAM = \{[\s\S]*?\n\};/.exec(app)[0];
    assert.ok(!cam.includes('’') && !cam.includes('\\u2019'), 'no curly apostrophe');
  });
});

describe('the camera: placement, preview and help', () => {
  test('H1 and M2: the camera scrolls at once, never smoothly, and focus moves without a second scroll', () => {
    assert.match(app, /el\.scrollIntoView\(\{ block, inline: 'nearest', behavior: 'instant' \}\);/);
    const start = /async function startCamera\(\) \{[\s\S]*?\n\}/.exec(app)[0];
    assert.match(start, /scrollNow\(card\);\n\s*\$\('cam-stop'\)\.focus\(\{ preventScroll: true \}\);/);
    const stop = /function stopCamera\([\s\S]*?\n\}/.exec(app)[0];
    assert.match(stop, /\$\('cam-btn'\)\.focus\(\{ preventScroll: true \}\);\n\s*scrollNow\(document\.querySelector\('\.cl-pic-row'\)\);\n\s*scrollNow\(\$\('pic-status'\)\);/);
  });

  test('L3: no scroll asks for smooth motion; the style sheet decides, and turns it off under reduced motion', () => {
    assert.ok(!/behavior: 'smooth'/.test(app));
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n\s*html \{ scroll-behavior: auto; \}/);
  });

  test('M3: a code found by the camera brings into view the card whose heading holds focus', () => {
    assert.match(app, /\(camera \? \$\('picture-card'\) : \$\('summary-card'\)\)\.scrollIntoView\(\{ block: 'start' \}\);/);
  });

  test('M6: coming back to a tab hidden while scanning, focus is on Scan with camera with the message in view', () => {
    // Stage 4b (Q4): inside the Android app the line says "you left CheckLink" instead.
    assert.match(app, /stopCamera\((?:inApp\(\) \? CAM\.hiddenApp : )?CAM\.hidden, \{ focus: true \}\)/);
  });

  test('M4: the status line sits straight under the buttons, before the help lines', () => {
    assert.match(html, /<\/div>\n\s*<p class="cl-status" id="pic-status" role="status" aria-live="polite"><\/p>\n\s*<p class="cl-help" id="pic-help">/);
  });

  test('L5: the help lines are short (25 words at most each; they were 25 and 41)', () => {
    for (const id of ['pic-help', 'cam-help']) {
      const words = new RegExp(`<p class="cl-help" id="${id}"[^>]*>([^<]*)</p>`).exec(html)[1];
      assert.ok(words.split(/\s+/).length <= 25, `${id}: ${words}`);
    }
  });

  test('L2: while an error shows, both buttons are described by it', () => {
    assert.match(app, /\$\('cam-btn'\)\.setAttribute\('aria-describedby', isError \? 'pic-status' : 'cam-help'\);/);
    assert.match(app, /\$\('pic-btn'\)\.setAttribute\('aria-describedby', isError \? 'pic-status' : 'pic-help'\);/);
  });

  test('L4: the preview shows the whole frame the decoder reads, in the shape the camera sends', () => {
    assert.match(css, /\.cl-cam-video \{[^}]*object-fit: contain;/);
    assert.match(css, /aspect-ratio: var\(--cam-w, 4\) \/ var\(--cam-h, 3\);/);
    assert.match(app, /frame\.style\.setProperty\('--cam-w', String\(video\.videoWidth\)\);/);
  });
});
