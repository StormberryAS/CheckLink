// Stage 5 (12 October 2026), what 0.0.1 adds around the app, checked statically (no browser, no
// Android tools; the browser tests in tests/ui-smoke.mjs, tests/e2e.mjs, tests/app-mode-smoke.mjs
// and tests/librewolf-smoke.mjs drive the same files):
//   * ICON-1 A ("A closer look", chosen 12 October 2026): favicon.svg, the carousel card, the
//     launcher icon's vector drawables (foreground, monochrome layer for themed icons, the Android 7
//     tiles) at the rule make_icons.py follows, the store icon and og-image.png;
//   * the legal framing: the first-run notice (gate.js and gate.css from build-gates.py, dismissible
//     tier), DISCLAIMER.md with disclaimer.html and disclaimer.css from build-disclaimers.py, and
//     privacy.html (the page's own policy, no scripts), all linked from the footer and bundled
//     into the app; the generators' CheckLink output pinned by hash, and regenerated and compared
//     byte for byte when the generators are beside this repository (the GitHub folder);
//   * README.md: the pinned certificate, how to verify a release with the workflow's real asset
//     name, the JIT-1 and WST-1 lines, and nothing that says a website is live;
//   * the build plumbing: the repository-only files stay out of the APK and off the website.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pngPixels } from './png-pixels.mjs';
import { GATE, copyProblems, metaCsp } from './legal-pages.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GITHUB = dirname(ROOT);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const bytes = (rel) => readFileSync(join(ROOT, rel));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const RES = 'android/app/src/main/res';
const CERT = '12dec5ac5eda5500ec233bd10f58515fd99d9a82480ed56445418b164f28a5d5';
const python = spawnSync('python3', ['--version']).status === 0;
const GATES_PY = join(GITHUB, 'build-gates.py');
const DISCLAIMERS_PY = join(GITHUB, 'build-disclaimers.py');
const generators = python && existsSync(GATES_PY) && existsSync(DISCLAIMERS_PY);

// Visible text of an HTML file: comments, tags and character references taken out.
const htmlText = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&middot;/g, '·').replace(/&larr;/g, '←').replace(/&oslash;/g, 'ø').replace(/&copy;/g, '©').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// Runs a few lines of Python with a generator imported as a module, no bytecode written.
function py(script, ...args) {
  const r = spawnSync('python3', ['-B', '-c', script, ...args], { encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const IMPORT = (path, name) => `import importlib.util, sys\nspec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, ${JSON.stringify(path)})\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n`;

// ---------------------------------------------------------------- ICON-1 A

test('ICON-1 A: favicon.svg is "A closer look", the carousel card is the same file, and no provisional tick is left', () => {
  const svg = read('favicon.svg');
  assert.ok(bytes('favicon.svg').equals(bytes('switcher-icons/check.svg')), 'switcher-icons/check.svg must be a byte copy of favicon.svg');
  assert.match(svg, /<path d="M43 43 L56 56" stroke="url\(#handleGrad\)" stroke-width="8" stroke-linecap="round"\/>/);
  assert.match(svg, /<circle cx="28" cy="28" r="19\.5" fill="#1b1226" stroke="url\(#lensGrad\)" stroke-width="5"\/>/);
  assert.match(svg, /<path d="M24 22 H20 A6 6 0 0 0 20 34 H24 M32 22 H36 A6 6 0 0 1 36 34 H32 M24 28 H32" stroke="url\(#linkGrad\)" stroke-width="4"/);
  assert.ok(!/mask|tick|badge|rotate\(/i.test(svg.replace(/<!--[\s\S]*?-->/g, '')), 'no mask, tick or badge in the drawing');
  // Nothing in the app or the page still carries the provisional drawing.
  const files = ['favicon.svg', 'switcher-icons/check.svg', ...readdirSync(join(ROOT, RES, 'drawable')).map((f) => `${RES}/drawable/${f}`),
    ...readdirSync(join(ROOT, RES, 'mipmap-anydpi')).map((f) => `${RES}/mipmap-anydpi/${f}`), 'android/tools/make_icons.py', 'android/tools/build-store-icon.py'];
  for (const f of files) {
    const t = read(f);
    assert.ok(!/M42[ ,]48\.5 L46\.2[ ,]52\.7|rotate\(-35|android:rotation="-35"|provisional/i.test(t), `${f} still has the provisional icon`);
  }
});

// The rule make_icons.py follows: the mark centred on its own bounding box, its farthest point 31
// units from the centre of the 108 unit viewport. For A that point is the handle's round cap.
const BBOX = { minx: 6, maxx: 60, miny: 6, maxy: 60 };
const CENTRE = (BBOX.minx + BBOX.maxx) / 2;
const FAR = Math.hypot(56 - CENTRE, 56 - CENTRE) + 4;
const FG_SCALE = 31 / FAR;
const LEGACY_SCALE = FG_SCALE * 1.2 / 0.78;

function groupOf(xml) {
  const g = xml.match(/<group\s+android:scaleX="([\d.]+)"\s+android:scaleY="([\d.]+)"\s+android:translateX="([\d.]+)"\s+android:translateY="([\d.]+)">/);
  assert.ok(g, 'no scaled group');
  return { sx: Number(g[1]), sy: Number(g[2]), tx: Number(g[3]), ty: Number(g[4]) };
}

test('ICON-1 A: the adaptive foreground is favicon.svg shape for shape, inside the safe zone, with its gradients', () => {
  const fg = read(`${RES}/drawable/ic_launcher_foreground.xml`);
  const g = groupOf(fg);
  assert.equal(g.sx, g.sy);
  assert.ok(Math.abs(g.sx - FG_SCALE) < 5e-5, `scale ${g.sx}, rule ${FG_SCALE}`);
  assert.ok(Math.abs(g.tx - (54 - CENTRE * FG_SCALE)) < 0.006 && Math.abs(g.ty - (54 - CENTRE * FG_SCALE)) < 0.006);
  assert.ok(FAR * g.sx <= 31.001, 'the farthest point stays 31 units from the centre, inside the 33 unit safe zone');
  const paths = [...fg.matchAll(/android:pathData="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['M43,43 L56,56', 'M8.5,28 A19.5,19.5 0 1,0 47.5,28 A19.5,19.5 0 1,0 8.5,28 Z', 'M24,22 H20 A6,6 0 0,0 20,34 H24 M32,22 H36 A6,6 0 0,1 36,34 H32 M24,28 H32']);
  // The gradients, in the drawing's own coordinates as in the SVG (userSpaceOnUse).
  const grads = [...fg.matchAll(/startX="([\d.]+)" android:startY="([\d.]+)" android:endX="([\d.]+)" android:endY="([\d.]+)">\s*<item android:offset="0" android:color="#FF([0-9A-F]{6})" \/>\s*<item android:offset="1" android:color="#FF([0-9A-F]{6})" \/>/g)].map((m) => m.slice(1).join(' '));
  assert.deepEqual(grads, ['42 42 59 59 E879F9 9333EA', '8 8 48 48 F0ABFC A855F7', '12 20 44 36 FFFFFF F0ABFC']);
  const svg = read('favicon.svg');
  for (const [id, x1, y1, x2, y2, c1, c2] of [['handleGrad', 42, 42, 59, 59, 'e879f9', '9333ea'], ['lensGrad', 8, 8, 48, 48, 'f0abfc', 'a855f7'], ['linkGrad', 12, 20, 44, 36, 'ffffff', 'f0abfc']]) {
    assert.match(svg, new RegExp(`id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">\\s*<stop offset="0%"\\s+stop-color="#${c1}"/>\\s*<stop offset="100%" stop-color="#${c2}"/>`), id);
  }
  assert.match(fg, /android:fillColor="#FF1B1226"\s+android:strokeWidth="5"/);
  assert.match(fg, /android:strokeWidth="8"\s+android:strokeLineCap="round"/);
  assert.match(fg, /android:strokeWidth="4"\s+android:strokeLineCap="round"\s+android:strokeLineJoin="round"/);
});

test('ICON-1 A: the themed-icon layer is the outline in one colour, the lens a ring with no fill', () => {
  const mono = read(`${RES}/drawable/ic_launcher_monochrome.xml`);
  assert.deepEqual(groupOf(mono), groupOf(read(`${RES}/drawable/ic_launcher_foreground.xml`)));
  assert.ok(!mono.includes('fillColor') && !mono.includes('gradient'));
  assert.equal([...mono.matchAll(/android:strokeColor="#FFFFFFFF"/g)].length, 3);
});

test('ICON-1 A: the Android 7 tiles carry the same mark at the template\'s tile ratio, on the dark tile', () => {
  for (const [f, tile] of [['ic_launcher.xml', 'M12,0 H96'], ['ic_launcher_round.xml', 'M0,54 A54,54']]) {
    const xml = read(`${RES}/mipmap-anydpi/${f}`);
    const g = groupOf(xml);
    assert.ok(Math.abs(g.sx - LEGACY_SCALE) < 5e-5 && Math.abs(g.tx - (54 - CENTRE * LEGACY_SCALE)) < 0.006, `${f}: ${g.sx}`);
    assert.ok(xml.includes(`android:fillColor="#FF0C0A12" android:pathData="${tile}`), f);
    // Inside the tile: the bounding box and, on the round tile, the handle's tip.
    assert.ok(BBOX.minx * g.sx + g.tx > 12 && BBOX.maxx * g.sx + g.tx < 96, f);
    assert.ok(FAR * g.sx < 54, f);
  }
});

test('ICON-1 A: the adaptive icons name the foreground, the background colour and the monochrome layer; the manifest uses them', () => {
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const xml = read(`${RES}/mipmap-anydpi-v26/${f}`);
    assert.match(xml, /<background android:drawable="@color\/icon_background" \/>/);
    assert.match(xml, /<foreground android:drawable="@drawable\/ic_launcher_foreground" \/>/);
    assert.match(xml, /<monochrome android:drawable="@drawable\/ic_launcher_monochrome" \/>/);
  }
  assert.match(read(`${RES}/values/colors.xml`), /<color name="icon_background">#0C0A12<\/color>/);
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  // No raster icon in the APK: density PNGs are a source of build nondeterminism.
  assert.ok(!readdirSync(join(ROOT, RES)).some((d) => /^mipmap-(m|h|xh|xxh|xxxh)dpi$/.test(d)));
  assert.match(read('android/app/build.gradle.kts'), /vectorDrawables\.generatedDensities\(\)/);
});

test('ICON-1 A: make_icons.py writes exactly the vector drawables in the repository', { skip: !python && 'python3 not found' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'checklink-icons-'));
  try {
    for (const d of ['drawable', 'mipmap-anydpi']) mkdirSync(join(tmp, d), { recursive: true });
    const r = spawnSync('python3', ['-B', join(ROOT, 'android/tools/make_icons.py'), tmp], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /foreground scale 0\.8487 translate 25\.99,25\.99; legacy scale 1\.3057 translate 10\.91,10\.91/);
    for (const f of ['drawable/ic_launcher_foreground.xml', 'drawable/ic_launcher_monochrome.xml', 'mipmap-anydpi/ic_launcher.xml', 'mipmap-anydpi/ic_launcher_round.xml']) {
      assert.ok(readFileSync(join(tmp, f)).equals(bytes(`${RES}/${f}`)), `${f} differs from what make_icons.py writes`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('ICON-1 A: the store icon is rendered with the launcher\'s scale and translation, 512 by 512, and not blank', () => {
  const src = read('android/tools/build-store-icon.py');
  const fg = groupOf(read(`${RES}/drawable/ic_launcher_foreground.xml`));
  assert.match(src, new RegExp(`SCALE = ${fg.sx.toFixed(4).replace('.', '\\.')} `));
  assert.ok(src.includes(`TRANSLATE = (${fg.tx.toFixed(2)}, ${fg.ty.toFixed(2)})`));
  assert.match(src, /BACKGROUND = "#0C0A12"/);
  const png = pngPixels(bytes('fastlane/metadata/android/en-US/images/icon.png'));
  assert.equal(png.width, 512);
  assert.equal(png.height, 512);
  let mark = 0;
  let pink = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
    if (Math.abs(r - 0x0c) + Math.abs(g - 0x0a) + Math.abs(b - 0x12) > 30) mark++;
    if (r > 200 && b > 200 && g < 190) pink++;
  }
  assert.ok(mark > 0.05 * 512 * 512 && mark < 0.5 * 512 * 512, `${mark} pixels carry the mark`);
  assert.ok(pink > 2000, 'the lens ring is there');
  // The corners are the plain background (the store crops the tile itself).
  for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511]]) assert.deepEqual([...png.data.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 3)], [0x0c, 0x0a, 0x12]);
});

test('og-image.png is 1200 by 630, and the page names it for link previews', () => {
  const png = pngPixels(bytes('og-image.png'));
  assert.equal(png.width, 1200);
  assert.equal(png.height, 630);
  const html = read('index.html');
  assert.match(html, /<meta property="og:image" content="https:\/\/check\.stormberry\.as\/og-image\.png" \/>\s*<meta property="og:image:width" content="1200" \/>\s*<meta property="og:image:height" content="630" \/>/);
  for (const placeholder of ['STAGE 5: og-image', 'STAGE 5: the first-run gate', 'STAGE 5: the Privacy and Disclaimer links']) assert.ok(!html.includes(placeholder), `index.html still has the placeholder "${placeholder}"`);
});

// ---------------------------------------------------------------- the first-run notice

// What gate.js shows, its markup taken out and its quoting undone, as a person reads it.
function gateWords() {
  const js = read('gate.js');
  const lines = [...js.matchAll(/^ {4}'<p>(.*)<\/p>',$/gm)].map((m) => m[1].replace(/\\'/g, "'").replace(/<[^>]+>/g, ''));
  const title = js.match(/'<h2 class="sb-gate-title" id="' \+ TITLE_ID \+ '">(.*)<\/h2>',/)[1].replace(/\\'/g, "'");
  const ack = js.match(/'<p class="sb-gate-ack">(.*)<\/p>',/)[1].replace(/\\'/g, "'");
  const button = js.match(/'<button type="button" class="sb-gate-btn">(.*)<\/button>',/)[1];
  const link = js.match(/'<a class="sb-gate-link" href="([^"]+)">(.*)<\/a>',/);
  return { paragraphs: lines, title, ack, button, linkHref: link[1], link: link[2] };
}

test('the first-run notice: CheckLink\'s, dismissible, version 2, its words pinned word for word', () => {
  const js = read('gate.js');
  assert.match(js, /^\/\* =+\n {3}STORMBERRY FIRST-RUN GATE \(behaviour\)\n {3}CheckLink, dismissible tier\.\n\n {3}GENERATED FILE\./);
  assert.match(js, /var APP_ID = 'checklink';\n  var VERSION = '2';\n  var MANDATORY = false;/);
  assert.match(js, /var STORE_KEY = 'sb-gate:' \+ APP_ID \+ ':v' \+ VERSION;/);
  assert.equal(GATE.key, 'sb-gate:checklink:v2');
  const w = gateWords();
  assert.deepEqual(w.paragraphs, GATE.paragraphs);
  assert.equal(w.title, GATE.title);
  assert.equal(w.ack, GATE.ack);
  assert.equal(w.button, GATE.button);
  assert.equal(w.link, GATE.link);
  assert.equal(w.linkHref, GATE.linkHref);
  // It stores one flag, in localStorage, and fails open to showing again.
  assert.match(js, /window\.localStorage\.setItem\(STORE_KEY, new Date\(\)\.toISOString\(\)\);/);
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|document\.cookie|eval\(|new Function|\.style\./.test(js));
  const words = copyProblems([GATE.title, ...GATE.paragraphs, GATE.ack].join('\n'));
  assert.deepEqual(words, []);
});

test('the first-run notice: gate.css takes CheckLink\'s own tokens, and every token it uses exists in style.css', () => {
  const css = read('gate.css');
  assert.match(css, /--sb-gate-accent: {4}var\(--accent-primary\);\n {2}--sb-gate-accent-bg: var\(--grad-primary\);\n {2}--sb-gate-anim: {6}var\(--t-slow\);\n {2}--sb-gate-btn-fg: {4}var\(--on-accent\);/);
  const style = read('style.css');
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]).filter((t) => !t.startsWith('--sb-gate')));
  for (const t of used) assert.ok(new RegExp(`\\n\\s+${t}:`).test(style), `${t} is not defined in style.css`);
  // CheckLink's own addition: the notice scrolls when it is taller than the screen (200% text).
  assert.match(style, /html \.sb-gate-overlay \{\n {2}overflow-y: auto;\n {2}align-items: safe center;\n\}/);
  assert.match(style, /\.sb-gate-overlay \.sb-gate-dialog \{\n {2}max-height: none;\n {2}overflow: visible;\n\}/);
  assert.match(style, /\.sb-gate-overlay \.sb-gate-scroll \{\n {2}max-height: max\(12rem, calc\(88vh - 20rem\)\);\n\}/);
});

test('the first-run notice is wired into index.html after the style sheet, stamped, deferred, before the app', () => {
  const html = read('index.html');
  const css = html.match(/<link rel="stylesheet" href="gate\.css\?v=([0-9a-f]{8})" \/>/);
  const js = html.match(/<script src="gate\.js\?v=([0-9a-f]{8})" defer><\/script>/);
  assert.ok(css && js, 'gate.css and gate.js are linked with their stamps');
  assert.equal(css[1], sha256(bytes('gate.css')).slice(0, 8));
  assert.equal(js[1], sha256(bytes('gate.js')).slice(0, 8));
  assert.ok(html.indexOf('href="style.css?v=') < html.indexOf('href="gate.css?v=') && html.indexOf('src="gate.js?v=') < html.indexOf('<script type="module" src="app.js'));
  // The first <script in the page is gate.js: the APK build puts the bridge line before it.
  assert.equal(html.indexOf('<script'), html.indexOf('<script src="gate.js'));
  // The app waits for the notice before it hands over a share, and keeps its flag in DOM storage.
  assert.match(read('android/web-overlay/android-bridge.js'), /return domReady && !!document\.getElementById\('link-input'\) && !document\.querySelector\('\.sb-gate-overlay'\);/);
  assert.match(read('android/app/src/main/kotlin/no/stormberry/checklink/MainActivity.kt'), /domStorageEnabled = true/);
});

// ---------------------------------------------------------------- the disclaimer

test('DISCLAIMER.md: the shared framing, and CheckLink\'s own section (spec section 6)', () => {
  const md = read('DISCLAIMER.md');
  assert.match(md, /^# Disclaimer and terms of use\n\n\*\*Applies to this application and to every application published by Stormberry AS\.\*\*\n\n## What this is\n\nThis is a \*\*functioning prototype\*\*/);
  const own = md.slice(md.indexOf('## Specific to CheckLink'), md.indexOf('## No warranty'));
  const leads = [...own.matchAll(/^\*\*([^*]+)\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(leads, ['It is a second look, not a verdict.', 'It removes only what is on its list.', 'Cleaning can break a link.', 'It cannot see where short links go.', '"No warning signs found" is not a verdict.', 'Payment details are shown, never paid.']);
  assert.deepEqual(copyProblems(own.replace(/\s+/g, ' ')), []);
  assert.ok(own.includes('"Rules dated"') && read('app.js').includes('`Rules dated ${RULES_DATE}`'), 'the rules date the disclaimer points to is the footer\'s');
  // The shared sections are the template's, word for word (checked against MetadataScrubber when it is beside this repository).
  const template = join(GITHUB, 'MetadataScrubber', 'DISCLAIMER.md');
  if (existsSync(template)) {
    const strip = (t) => t.replace(/## Specific to [\s\S]*?(?=## No warranty)/, '');
    assert.equal(strip(md), strip(readFileSync(template, 'utf8')));
  }
});

// Pinned output of the shared generators for CheckLink, so a change to them shows up here even
// where the generators are not at hand (a clone of the public repository).
const PINNED = {
  'gate.js': '650fd78266fe0339b97be9db7e8b03aa212f0dca390f1c199725205b8441a7ac',
  'gate.css': 'cca16ec21b8442969f81f4cfa5d90a026b67521f9a0353643224d7d22ad191fe',
  'disclaimer.css': '14d0ec8be6482608350697244ba5e86255478a1d93170897015685f06697d159',
  'disclaimer.html': 'd67836b9d4cec08653dbaa357f11c3ff1ee6c4f196933daa17df4f3b66a7583a',
};

test('the generators\' CheckLink output is pinned by hash', () => {
  for (const [f, h] of Object.entries(PINNED)) assert.equal(sha256(bytes(f)), h, `${f} changed: run the generators, check the change, and pin the new hash`);
});

test('disclaimer.html: rendered from DISCLAIMER.md, with its style sheet beside it instead of a style block', () => {
  const html = read('disclaimer.html');
  assert.ok(!/<style|style=|<script/i.test(html), 'no style block, style attribute or script: the page policy (style-src \'self\') would refuse them');
  const link = html.match(/<link rel="stylesheet" href="disclaimer\.css\?v=([0-9a-f]{8})" \/>/);
  assert.ok(link);
  assert.equal(link[1], sha256(bytes('disclaimer.css')).slice(0, 8), 'the stamp is bump_assets.py\'s');
  assert.match(html, /<a class="back" href="\.\/">&larr; Back to CheckLink<\/a>/);
  assert.match(html, /<a href="privacy\.html">Privacy<\/a><\/footer>/);
  assert.match(html, /<title>Disclaimer and terms of use &middot; CheckLink &middot; Stormberry AS<\/title>/);
  assert.match(read('disclaimer.css'), /^\/\* Generated by build-disclaimers\.py/);
});

test('the generators, run here, write exactly the CheckLink files in this repository', { skip: !generators && 'build-gates.py and build-disclaimers.py are not beside this repository' }, () => {
  const out = py(`${IMPORT(GATES_PY, 'gates')}app = [a for a in m.APPS if a["dir"] == "CheckLink"][0]\nsys.stdout.write(m.render_js(app) + "\\x00" + m.render_css(app))`);
  const [js, css] = out.split('\0');
  assert.equal(js, read('gate.js'));
  assert.equal(css, read('gate.css'));
  const page = py(`${IMPORT(DISCLAIMERS_PY, 'disclaimers')}import os
md = open(sys.argv[1], encoding="utf-8").read()
assert m.NEW_WHAT in md
assert "CheckLink" in m.APPS and "CheckLink" in m.EXTERNAL_STYLE
page = m.PAGE.replace("@@BODY@@", m.to_html(md)).replace("@@APP@@", "CheckLink")
page = page.replace('<a href="https://stormberry.as/privacy.html">Privacy</a></footer>', '<a href="privacy.html">Privacy</a></footer>', 1)
page, css = m.split_style(page)
sys.stdout.write(page + "\\x00" + css)`, join(ROOT, 'DISCLAIMER.md'));
  const [html, dcss] = page.split('\0');
  assert.equal(html, read('disclaimer.html'));
  assert.equal(dcss, read('disclaimer.css'));
});

// ---------------------------------------------------------------- the privacy page

test('privacy.html: the page\'s own policy word for word, no scripts, no inline styles, the site\'s style sheets', () => {
  const html = read('privacy.html');
  assert.equal(metaCsp(html), metaCsp(read('index.html')));
  assert.ok(html.indexOf('<meta http-equiv="Content-Security-Policy"') < html.indexOf('<meta charset'), 'the policy is the first element in head');
  assert.ok(!/<script|<style|\sstyle=|\son[a-z]+=/i.test(html.replace(/<!--[\s\S]*?-->/g, '')));
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)\?v=([0-9a-f]{8})" \/>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sheets.map((s) => s[0]), ['fonts/inter/inter.css', 'style.css']);
  for (const [f, v] of sheets) assert.equal(v, sha256(bytes(f)).slice(0, 8), `${f} stamp`);
});

test('privacy.html covers spec section 6, made true for 0.0.1: offline, the camera, Copy and Share, the notice\'s flag, no history, Zapstore, rights, a date', () => {
  const text = htmlText(read('privacy.html'));
  for (const part of [
    'Nothing you check is sent anywhere', 'never opens the link it checks', 'no internet access at all',
    'one permission, the camera', 'never when the app starts', 'Nothing is recorded, stored or sent',
    'as soon as a code is found', 'when you press Stop camera', 'when you leave the page or the app', 'after two minutes without a code',
    'keeps the screen out of screenshots', 'Copy puts the clean link', 'Share hands it to the app you choose', 'Go to opens the clean link in your own browser',
    'when you close the first-run notice, the app stores the date and time in its local storage', 'keeps no history',
    'keeps all its data out of Android\'s backups', 'info@stormberry.as', 'the message reaches us only if you send it',
    'Zapstore', 'Norwegian Data Protection Authority (Datatilsynet', 'Norwegian Personal Data Act (personopplysningsloven)',
    'Last updated: 12 October 2026',
  ]) assert.ok(text.includes(part), `privacy.html does not say: ${part}`);
  // Nothing that implies a live website: no site address, no hosting, no store but Zapstore.
  assert.ok(!/check\.stormberry\.as|GitHub Pages|Cloudflare|Google Play|Play Store/i.test(text), (text.match(/.{0,50}(check\.stormberry\.as|GitHub Pages|Cloudflare|Google Play|Play Store).{0,50}/i) || [])[0]);
  assert.deepEqual(copyProblems(text), []);
  assert.ok(!/safer QR scanner/i.test(text));
});

test('privacy.html: Back to CheckLink, the same footer as the page, Privacy marked as the current page', () => {
  const html = read('privacy.html');
  assert.match(html, /<a class="pp-back" href="\.\/">&larr; Back to CheckLink<\/a>/);
  assert.match(html, /<a href="privacy\.html" aria-current="page">Privacy<\/a> &middot; <a href="disclaimer\.html">Disclaimer<\/a><\/p>/);
  const footer = (t) => t.slice(t.indexOf('<footer class="site-footer">'), t.indexOf('</footer>'));
  const index = footer(read('index.html')).replace(/\n\s*<!--[\s\S]*?-->/g, '').replace(/\n\s*<p class="footer-rules"[^\n]*<\/p>/g, '').replace(' aria-current="page"', '');
  assert.equal(footer(html).replace(' aria-current="page"', ''), index);
});

test('the footer of index.html links Privacy and Disclaimer once each, opening in place', () => {
  const html = read('index.html');
  assert.match(html, /· Askøy, Norway · <a href="privacy\.html">Privacy<\/a> &middot; <a href="disclaimer\.html">Disclaimer<\/a><\/p>/);
  assert.equal([...html.matchAll(/href="privacy\.html"/g)].length, 1);
  assert.equal([...html.matchAll(/href="disclaimer\.html"/g)].length, 1);
});

// ---------------------------------------------------------------- the app and the website

test('the app bundles the legal pages and the notice, and opens them in place: the include list, the workflow and the asset loader agree', () => {
  const gradle = read('android/app/build.gradle.kts');
  const includes = gradle.match(/val INCLUDES = listOf\(([\s\S]*?)\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  for (const f of ['privacy.html', 'disclaimer.html', 'disclaimer.css', 'gate.js', 'gate.css']) {
    assert.ok(includes.includes(f), `${f} is not in WebAssets.INCLUDES`);
    assert.ok(read('.github/workflows/android-release.yml').includes(`web/${f}`), `the workflow does not check web/${f}`);
    assert.ok(existsSync(join(ROOT, f)));
  }
  // Same-origin pages load in the WebView itself (NavigationPolicy IN_APP), offline from the APK.
  assert.match(read('android/app/src/main/kotlin/no/stormberry/checklink/NavigationPolicy.kt'), /if \(host == ASSET_HOST\) \{\n\s+return if \(scheme == "https" && \(uri\.port == -1 \|\| uri\.port == 443\)\) Decision\.IN_APP else Decision\.BLOCK/);
  assert.match(read('android/app/src/main/kotlin/no/stormberry/checklink/AssetPaths.kt'), /"html" to "text\/html",[\s\S]*"css" to "text\/css",/);
});

test('repository-only files stay out of the APK and off the website, and the website keeps the pages it links', () => {
  const gradle = read('android/app/build.gradle.kts');
  const excludes = gradle.match(/val APK_EXCLUDES = listOf\(([\s\S]*?)\n {4}\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  for (const f of ['fastlane/**', 'zapstore.yaml', 'README*', 'DISCLAIMER.md', 'LICENSE', 'NOTICE', 'CNAME', 'robots.txt', 'og-image.png', 'android/**', 'tests/**', 'tools/**', '.github/**',
    // The type checking's tooling (2026-10-16): the compiler, its configurations and declarations.
    'package.json', 'package-lock.json', 'node_modules/**', 'jsconfig.json', 'jsconfig.worker.json', 'types/**']) {
    assert.ok(excludes.includes(f), `${f} is not in APK_EXCLUDES`);
  }
  const includes = gradle.match(/val INCLUDES = listOf\(([\s\S]*?)\)/)[1];
  assert.ok(!/README|DISCLAIMER\.md|zapstore|fastlane|og-image|\*\.png|\*\.md|\*\.yaml/.test(includes), 'the include list must not reach a repository-only file');
  const config = read('_config.yml').replace(/#[^\n]*/g, '');
  const ex = [...config.matchAll(/^ {2}- (\S+)$/gm)].map((m) => m[1]);
  for (const f of ['README.md', 'DISCLAIMER.md', 'LICENSE', 'NOTICE', 'fastlane/', 'zapstore.yaml', 'android/', 'tests/', 'tools/',
    'package.json', 'package-lock.json', 'node_modules/', 'jsconfig.json', 'jsconfig.worker.json', 'types/']) assert.ok(ex.includes(f), `_config.yml does not exclude ${f}`);
  for (const f of ['privacy.html', 'disclaimer.html', 'disclaimer.css', 'gate.js', 'gate.css', 'og-image.png', 'favicon.svg']) assert.ok(!ex.some((e) => f === e || f.startsWith(e)), `_config.yml must not exclude ${f}`);
});

// ---------------------------------------------------------------- README.md

test('README.md: the release certificate, the real asset name, how to verify, the one permission, Zapstore', () => {
  const md = read('README.md');
  const wf = read('.github/workflows/android-release.yml');
  const version = read('android/app/build.gradle.kts').match(/versionName = "([^"]+)"/)[1];
  // The workflow names the asset checklink-<tag without "android-">.apk, so android-v0.0.1 gives checklink-v0.0.1.apk.
  assert.ok(wf.includes('VERSION="${GITHUB_REF_NAME#android-}"') && wf.includes('"checklink-${VERSION}.apk"'));
  const asset = `checklink-v${version}.apk`;
  assert.equal(asset, 'checklink-v0.0.1.apk');
  assert.ok(md.includes(`**Signing certificate SHA-256:** \`${CERT}\``));
  assert.ok(wf.includes(`EXPECTED_CERT=${CERT}`));
  for (const line of [`gh attestation verify ${asset} -R StormberryAS/CheckLink`, `apksigner verify --print-certs ${asset}`, `sha256sum -c ${asset}.sha256`, `aapt dump permissions ${asset}`, 'git checkout android-v0.0.1']) {
    assert.ok(md.includes(line), line);
  }
  const perms = read('android/expected-permissions.txt').trim().split('\n').map((l) => `# ${l}`).join('\n');
  assert.ok(md.includes(perms), 'the README shows the permissions as aapt prints them');
  assert.ok(md.includes('[CheckLink on Zapstore](https://zapstore.dev/apps/no.stormberry.checklink)'));
  assert.ok(md.includes('python3 tools/apk-without-signature.py mine.apk') && existsSync(join(ROOT, 'android/tools/apk-without-signature.py')));
  assert.ok(md.includes('LICENSE') && md.includes('NOTICE') && md.includes('MIT'));
});

test('README.md: the JIT-1 and WST-1 lines, and no claim that a website is live', () => {
  const md = read('README.md');
  assert.ok(md.includes('If you turn off JIT (the fast compiler) for CheckLink, for example in GrapheneOS\'s Exploit protection settings, scanning still works, only more slowly.'), 'JIT-1');
  assert.ok(md.includes('The web page does not register itself as a share target (the Web Share Target API).'), 'WST-1');
  assert.ok(md.includes('its private form needs a service worker'), 'WST-1, the reason');
  assert.ok(!/check\.stormberry\.as|\*\*Live:\*\*|GitHub Pages/i.test(md), 'nothing says or links a live website');
  assert.ok(!/safer QR scanner/i.test(md));
  // The prose, code blocks taken out: the writing rules.
  const prose = md.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\s+/g, ' ');
  assert.deepEqual(copyProblems(prose), []);
});

test('the new public files follow the writing rules: no em or en dashes, and no double hyphen used as a dash', () => {
  const files = ['README.md', 'DISCLAIMER.md', 'privacy.html', 'gate.js', 'disclaimer.html', 'android/tools/make_icons.py', 'android/tools/build-store-icon.py', 'android/tools/apk-without-signature.py', 'tests/legal-pages.mjs', 'tests/stage5-release.test.mjs'];
  for (const f of files) {
    const text = read(f).replace(/<!--|-->/g, '').replace(/^---$/m, '');
    assert.ok(!/[\u2013\u2014]/.test(text), `${f} has an em or en dash`);
    assert.ok(!/(^|[\s(])--(?=[\s).,]|$)/m.test(text), `${f} uses a double hyphen as a dash`);
  }
});

// ---------------------------------------------------------------- the store texts and the claims (stage 5a review fixes)

test('the store texts: the JIT-1 line in the Zapstore description too, zapstore.yaml\'s description equal to full_description.txt, the limits', () => {
  const fd = read('fastlane/metadata/android/en-US/full_description.txt');
  // Decision JIT-1 (11 October 2026): one line in the README and in the Zapstore description, word for word.
  assert.ok(fd.includes('If you turn off JIT (the fast compiler) for CheckLink, for example in GrapheneOS\'s Exploit protection settings, scanning still works, only more slowly.'), 'JIT-1');
  assert.ok([...fd].length <= 4000, `full_description.txt is ${[...fd].length} characters, over 4,000`);
  const yaml = read('zapstore.yaml');
  const start = yaml.indexOf('description: |\n') + 'description: |\n'.length;
  const desc = yaml.slice(start, yaml.indexOf('\ntags:\n'));
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  assert.equal(norm(desc), norm(fd), 'zapstore.yaml\'s description is full_description.txt, rewrapped');
  for (const f of ['title.txt', 'short_description.txt', 'full_description.txt', 'changelogs/1.txt']) {
    const t = norm(read(`fastlane/metadata/android/en-US/${f}`));
    assert.deepEqual(copyProblems(t), [], f);
    assert.ok(!/safer QR scanner|check\.stormberry\.as/i.test(t), f);
  }
});

test('claims checked against the code: only a Stop-tier secret asks before it is copied, and no note is given for a download', async () => {
  const { inspect } = await import('../src/qr-inspect.js');
  const { analyse } = await import('../src/link-core.js');
  // app.js copyField asks first only for `f.secret && p.tier === 'stop'`.
  assert.match(read('app.js'), /if \(f\.secret && p\.tier === 'stop'\) \{/);
  const wifi = inspect('WIFI:T:WPA;S:Example Guest;P:fictional-pass;;');
  assert.ok(wifi.tier !== 'stop' && wifi.fields.some((f) => f.secret), 'a Wi-Fi password is a secret that copies without the question');
  assert.equal(inspect('otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example').tier, 'stop');
  for (const f of ['README.md', 'privacy.html', 'fastlane/metadata/android/en-US/full_description.txt', 'zapstore.yaml']) {
    assert.ok(!/copying it asks first/.test(read(f).replace(/\s+/g, ' ')), `${f} says every secret asks before it is copied`);
  }
  // No note for a web link to an installer, so no public text may list "a download" among the signs.
  assert.equal(analyse('https://www.example.org/files/setup.apk').warnings.length, 0);
  assert.ok(!/a download, and more/.test(read('README.md')));
});
