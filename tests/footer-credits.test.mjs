// CheckLink 0.0.3 (24 October 2026): what the footer credits.
//
// Marcos, 24 October 2026: "it's excessive to credit LinkedIn/GitHub icons and programming languages,
// these should be only in the documentation. The web/app should focus on crediting repos like suncalc."
// The footer's "Runs entirely on your device" sentence credits ONLY the third-party projects and data
// CheckLink's function is built on, each with a link and its licence. Icons, the typeface, programming
// languages and platform libraries are credited in NOTICE and the README only. CheckLink is a WebView
// of its web page, so index.html is the website's footer and the app's at once; privacy.html carries the
// same footer.
//
// Run from the repository root with: node --test tests/
//
// Node 24 built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// The credits, in the order the footer gives them: link text, address, licence label as shown, and the
// SPDX id NOTICE and the lock use for it.
const CREDITS = [
  { name: 'zxing-cpp', url: 'https://github.com/zxing-cpp/zxing-cpp', label: 'Apache 2.0', spdx: 'Apache-2.0' },
  { name: 'zxing-wasm', url: 'https://github.com/Sec-ant/zxing-wasm', label: 'MIT', spdx: 'MIT' },
  { name: 'QR Code generator', url: 'https://github.com/nayuki/QR-Code-generator', label: 'MIT', spdx: 'MIT' },
  { name: 'Public Suffix List', url: 'https://publicsuffix.org/list/', label: 'MPL 2.0', spdx: 'MPL-2.0' },
  { name: 'BIP-39', url: 'https://github.com/bitcoin/bips/tree/master/bip-0039', label: 'MIT', spdx: 'MIT' },
  { name: 'SLIP-39', url: 'https://github.com/trezor/python-shamir-mnemonic', label: 'MIT', spdx: 'MIT' },
  { name: 'Monero', url: 'https://github.com/monero-project/monero/tree/master/src/mnemonics', label: 'BSD 3-Clause', spdx: 'BSD-3-Clause' },
  { name: 'Unicode confusables', url: 'https://www.unicode.org/Public/security/latest/confusables.txt', label: 'Unicode License v3', spdx: 'Unicode-3.0' },
  { name: 'tracking query params registry', url: 'https://github.com/mpchadwick/tracking-query-params-registry', label: 'Unlicense', spdx: 'Unlicense' },
];

const NBSP = ' ';
const credits = (file) => {
  const html = read(file);
  const m = html.match(/<div class="footer-powered">\s*<p>([\s\S]*?)<\/p>\s*<\/div>/);
  assert.ok(m, `${file} has no footer-powered paragraph`);
  return m[1];
};
const plain = (inner) => inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, NBSP);

test('the footer credits sentence names exactly the projects and data the function is built on, each with a link and its licence', () => {
  for (const file of ['index.html', 'privacy.html']) {
    const inner = credits(file);
    const anchors = [...inner.matchAll(/<a href="([^"]+)" target="_blank" rel="noopener noreferrer">([^<]+)<\/a> \(<span class="nb">([^<]+)<\/span>\)/g)];
    assert.equal(anchors.length, CREDITS.length, `${file}: one link and one licence label per credit`);
    assert.equal([...inner.matchAll(/<a /g)].length, CREDITS.length, `${file}: no other link in the sentence`);
    anchors.forEach((a, i) => {
      assert.equal(a[1], CREDITS[i].url, `${file}: address of ${CREDITS[i].name}`);
      assert.ok(a[1].startsWith('https://'));
      assert.equal(a[2], CREDITS[i].name);
      assert.equal(a[3].replace(/&nbsp;/g, ' '), CREDITS[i].label, `${file}: licence of ${CREDITS[i].name}`);
    });
    assert.equal(plain(inner), 'Runs entirely on your device: our own code, zxing-cpp (Apache 2.0) through zxing-wasm (MIT), QR Code generator (MIT), the Public Suffix List (MPL 2.0), the recovery-phrase word lists of BIP-39 (MIT), SLIP-39 (MIT) and Monero (BSD 3-Clause), Unicode confusables (Unicode License v3) and the tracking query params registry (Unlicense). Nothing is sent.');
  }
});

test('each licence label stays on one line: no ordinary space inside it, and a no-wrap class', () => {
  for (const file of ['index.html', 'privacy.html']) {
    const labels = [...credits(file).matchAll(/<span class="nb">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.equal(labels.length, CREDITS.length);
    for (const l of labels) assert.ok(!/ /.test(l), `${file}: "${l}" has an ordinary space`);
    assert.ok(labels.some((l) => l.includes('&nbsp;')));
  }
  assert.match(read('style.css'), /\.nb \{ white-space: nowrap; \}/);
});

test('the footer credits no icon, typeface, language or platform library, and no longer points at NOTICE', () => {
  for (const file of ['index.html', 'privacy.html']) {
    const text = plain(credits(file));
    for (const banned of ['Lucide', 'Feather', 'Inter', 'Kotlin', 'Jetpack', 'AndroidX', 'Android', 'Material', 'JavaScript', 'TypeScript', 'WebAssembly', 'Java', 'icon', 'font', 'NOTICE', 'open-source parts']) {
      assert.ok(!text.includes(banned), `${file}: the credits sentence says "${banned}"`);
    }
    const footer = read(file).slice(read(file).indexOf('<footer class="site-footer">'), read(file).indexOf('</footer>'));
    assert.ok(!/lucide|kotlin|jetpack|material|rsms\.me|rsms\/inter/i.test(footer), `${file}: the footer links or names an icon, language or font credit`);
  }
});

test('every credit has its entry and licence in NOTICE, and the licence texts that ship are in licences/', () => {
  const notice = read('NOTICE');
  const lock = JSON.parse(read('tools/upstream.lock.json'));
  const needs = {
    'zxing-cpp': ['zxing-cpp and the zxing-wasm C++ binding: Apache-2.0', 'licences/zxing-cpp-Apache-2.0.txt'],
    'zxing-wasm': ['https://github.com/Sec-ant/zxing-wasm', 'licences/zxing-wasm-MIT.txt'],
    'QR Code generator': ['https://github.com/nayuki/QR-Code-generator', 'licences/QR-Code-generator-MIT.txt'],
    'Public Suffix List': ['MPL-2.0', 'licences/Public-Suffix-List-MPL-2.0.txt'],
    'BIP-39': ['licences/BIP-0039-MIT.txt'],
    'SLIP-39': ['licences/SLIP-0039-wordlist-MIT.txt'],
    Monero: ['BSD-3-Clause, Copyright (c) 2014-2024 The Monero Project', 'licences/Monero-BSD-3-Clause.txt'],
    'Unicode confusables': ['Unicode License v3 (Unicode-3.0)', 'licences/Unicode-3.0.txt'],
    'tracking query params registry': ['https://github.com/mpchadwick/tracking-query-params-registry', 'Unlicense'],
  };
  for (const [name, parts] of Object.entries(needs)) for (const p of parts) assert.ok(notice.includes(p), `NOTICE does not hold "${p}" for ${name}`);
  for (const f of notice.matchAll(/licences\/[A-Za-z0-9._-]+\.txt/g)) {
    assert.ok(existsSync(join(ROOT, f[0])), `${f[0]} is named in NOTICE and missing`);
    assert.ok(lock.licence_files.some((l) => l.path === f[0]), `${f[0]} is not in the lock`);
  }
  // The footer's licence labels agree with the SPDX ids NOTICE and the lock use.
  for (const c of CREDITS) assert.ok(notice.includes(c.spdx) || notice.includes(c.label), `NOTICE names neither ${c.spdx} nor ${c.label}`);
});

test('what left the footer is documented: NOTICE and the README name the icons, the marks, the typeface, the languages and the libraries, and Lucide\'s licence text ships', () => {
  const notice = read('NOTICE');
  const readme = read('README.md');
  assert.match(notice, /Lucide icons \(the LinkedIn and GitHub marks in the page footer/);
  assert.ok(notice.includes('licences/Lucide-ISC.txt') && notice.includes('ISC'));
  assert.ok(notice.includes('Nostr ostrich mark') && notice.includes('Tor onion mark'));
  assert.ok(notice.includes('Inter (fonts/inter/)') && notice.includes('licences/Inter-OFL-1.1.txt'));
  assert.ok(notice.includes('Libraries: AndroidX') && notice.includes('the Kotlin standard library'));
  assert.ok(notice.includes('What the page footer credits'));
  for (const w of ['Lucide', 'Nostr and Tor marks', 'Inter typeface', 'Kotlin and AndroidX']) assert.ok(readme.includes(w), `README does not name ${w}`);
  assert.ok(readme.includes('**What the footer credits.**'));
  const lic = read('licences/Lucide-ISC.txt');
  assert.ok(lic.startsWith('ISC License') && lic.includes('Cole Bemis') && lic.includes('Lucide Contributors'));
  const lock = JSON.parse(read('tools/upstream.lock.json'));
  assert.ok(lock.licence_files.some((l) => l.path === 'licences/Lucide-ISC.txt' && l.licence.startsWith('ISC')));
  assert.ok(read('android/app/build.gradle.kts').includes('"licences/*.txt"'), 'the web licences/ folder, Lucide\'s text included, is bundled in the app');
});
