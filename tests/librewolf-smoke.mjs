#!/usr/bin/env node
// Picture reading in headless LibreWolf (or Firefox), driven over WebDriver BiDi with Node's own
// WebSocket: no packages. The spec's stage-2 browser test asks for LibreWolf as well as
// Chromium, because LibreWolf's fingerprinting protection scrambles what a page reads back from
// a canvas; CheckLink decodes the picture file's own bytes inside WebAssembly instead, and this
// proves that route works there, under the site's policy, with no request after load.
//
//   node tests/librewolf-smoke.mjs [--browser /usr/bin/librewolf] [--out DIR]
//
// It serves the repository with tests/serve.py (plain HTTP on 127.0.0.1, the host header policy
// of NOTICE), starts LibreWolf headless with a throwaway profile that keeps its default
// privacy settings (resistFingerprinting on) and only turns off HTTPS-Only mode for this local
// address, chooses pictures through the page's file input, and checks what the page shows.
// Stage 3: it also presses Scan with camera, with the browser's fake camera allowed for the page
// (media.navigator.streams.fake). With fingerprinting protection on, LibreWolf hands the page
// made-up pixels for every frame, so live scanning cannot work there: the page must say so within
// seconds and turn the camera off, with no request.
// Stage 4b: Make a QR code and Save picture, for an ASCII link and one with æ, ø and å in its host
// and path. The code on the page must be the one src/qr-make.js makes in Node, and the saved
// qr-code.png byte for byte the PNG Node writes, which tests/e2e.mjs proves for Chromium too: no
// canvas is involved, so fingerprinting protection changes nothing.
// Stage 5: the first-run notice shows on the first visit and its own button closes it, storing its
// one flag; then the privacy page and the disclaimer load under the site's policy, styled by their
// own style sheets (Gecko refuses a style block under style-src 'self' as Chromium does).
// Exits 2 (skipped) when the browser is missing. Not run by `node --test tests/`.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PICTURE_STATE, QR_STATE, TEXT, expectedQr } from './share-stub.mjs';
import { analyse } from '../src/link-core.js';
import { FLAG_VALUE, GATE, GATE_STATE, LEGAL_STATE } from './legal-pages.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BROWSER = opt('--browser', process.env.LIBREWOLF || '/usr/bin/librewolf');
const OUT = resolve(opt('--out', join(tmpdir(), 'checklink-librewolf')));
if (!existsSync(BROWSER)) {
  console.log(`skipped: ${BROWSER} not found`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINK = 'https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&utm_campaign=autumn&id=42';

let passes = 0;
let failures = 0;
const check = (name, ok, detail) => {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${JSON.stringify(detail)}` : ''}`);
};

const server = spawn('python3', [join(ROOT, 'tests', 'serve.py'), '--quiet'], { stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('serve.py did not start')), 20000);
  server.stdout.on('data', (d) => {
    const m = /READY (\S+)/.exec(String(d));
    if (m) { clearTimeout(t); res(m[1]); }
  });
});

const profile = mkdtempSync(join(OUT, 'profile-'));
// Stage 4b: Save picture's downloads land here, without a question (test profile only).
const downloads = mkdtempSync(join(OUT, 'downloads-'));
writeFileSync(join(profile, 'user.js'), [
  `user_pref("browser.download.dir", ${JSON.stringify(downloads)});`,
  'user_pref("browser.download.folderList", 2);',
  'user_pref("browser.download.useDownloadDir", true);',
  'user_pref("browser.download.always_ask_before_handling_new_types", false);',
  'user_pref("browser.download.start_downloads_in_tmp_dir", false);',
  'user_pref("browser.download.alwaysOpenPanel", false);',
  'user_pref("dom.security.https_only_mode", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("remote.active-protocols", 1);',
  // Stage 3: a fake camera, allowed without a prompt (test profile only).
  'user_pref("media.navigator.streams.fake", true);',
  'user_pref("media.navigator.permission.disabled", true);',
].join('\n'));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(BROWSER, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: '1' } });
await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error(`the browser did not start: ${buf.slice(-400)}`)), 30000);
  const on = (d) => {
    buf += d;
    if (/WebDriver BiDi listening/.test(buf)) { clearTimeout(t); res(); }
  };
  browser.stderr.on('data', on);
  browser.stdout.on('data', on);
});

const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === 'error') p.rej(new Error(`${m.error}: ${m.message}`));
    else p.res(m.result);
  } else if (m.type === 'event') events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

let ctx;
try {
  const session = await send('session.new', { capabilities: {} });
  const version = `${session.capabilities.browserName} ${session.capabilities.browserVersion}`;
  console.log(`# ${version}`);
  await send('session.subscribe', { events: ['network.beforeRequestSent', 'log.entryAdded'] });
  ctx = (await send('browsingContext.getTree', {})).contexts[0].context;
  await send('browsingContext.navigate', { context: ctx, url: base, wait: 'complete' });
  // The page has loaded when its requests stop: the two decoder workers fetch their modules
  // after the load event (since stage 3 the page itself is larger, so a fixed wait was too short).
  // On a busy machine a worker can pause for longer than the quiet spell, so (stage 4b) the wait
  // also lasts until both workers have fetched the decoder, or 15 seconds have passed. (Stage 5:
  // 30 seconds; on a machine with a load average near 13 the workers once took longer than 15.)
  {
    const count = () => events.filter((e) => e.method === 'network.beforeRequestSent').length;
    const decoders = () => events.filter((e) => e.method === 'network.beforeRequestSent' && /\/zxing_reader\.wasm\.js$/.test(e.params.request.url)).length;
    let last = -1;
    let still = 0;
    for (let i = 0; i < 300 && (still < 15 || decoders() < 2); i++) {
      await sleep(100);
      const n = count();
      still = n === last ? still + 1 : 0;
      last = n;
    }
    await sleep(500);
  }
  const ev = async (expression, { press = false } = {}) => {
    const r = await send('script.evaluate', { expression: `JSON.stringify(${expression})`, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none', userActivation: press });
    if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
    return JSON.parse(r.result.value);
  };
  // Stage 5: the first-run notice, closed with its own button before anything else.
  {
    let g = await ev(GATE_STATE);
    check(`${version}: the first-run notice shows on a first visit, word for word, with the page inert behind it`, g.open && g.title === GATE.title && JSON.stringify(g.paragraphs) === JSON.stringify(GATE.paragraphs) && g.button === GATE.button && g.mainInert && g.stored === null, g);
    await ev("(document.querySelector('.sb-gate-btn').click(), true)", { press: true });
    for (let i = 0; i < 30 && (await ev("!!document.querySelector('.sb-gate-overlay')")); i++) await sleep(100);
    g = await ev(GATE_STATE);
    check(`${version}: Got it closes it and stores its one flag, the time it was closed`, !g.open && !g.mainInert && FLAG_VALUE.test(g.stored) && JSON.stringify(g.keys) === JSON.stringify([GATE.key]), { open: g.open, stored: g.stored, keys: g.keys });
  }
  const rfp = await ev("(() => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 8, 8); const d = x.getImageData(0, 0, 8, 8).data; return [...d].some((v, i) => i % 4 !== 3 && v !== 0); })()");
  console.log(`note canvas readback ${rfp ? 'is scrambled (fingerprinting protection on)' : 'is not scrambled'}`);
  const loadReqs = events.filter((e) => e.method === 'network.beforeRequestSent').length;
  const node = await send('script.evaluate', { expression: "document.getElementById('pic-input')", target: { context: ctx }, awaitPromise: false, resultOwnership: 'root' });
  const choose = async (file) => {
    await send('input.setFiles', { context: ctx, element: { sharedId: node.result.sharedId }, files: [join(ROOT, 'tests', 'fixtures', 'qr', file)] });
    for (let i = 0; i < 200; i++) {
      const s = await ev("document.getElementById('pic-status').textContent");
      if (s !== TEXT.picReading && (s || (await ev("!document.getElementById('picture-card').hidden")))) break;
      await sleep(100);
    }
    await sleep(300);
    return ev(PICTURE_STATE);
  };
  for (const file of ['link.png', 'link-photo.jpg', 'link.gif']) {
    const st = await choose(file);
    check(`${version}: ${file} is read from its own bytes, and its link goes in the box`, st.card && st.box === LINK, { status: st.status, box: st.box });
  }
  let st = await choose('wifi.png');
  check(`${version}: a Wi-Fi code is described, its password hidden`, st.card && st.codes[0].kind === 'wifi' && st.codes[0].fields.find((f) => f.label === 'Password').hidden, st.codes[0]);
  st = await choose('two-codes.png');
  check(`${version}: two codes in one picture each get a card`, st.codes.length === 2, st.codes.length);
  st = await choose('not-image.png');
  check(`${version}: a file that is not a picture gets a plain reason`, st.status === TEXT.picNotImage, st.status);
  // Stage 3: Scan with camera.
  const camShown = await ev("!document.getElementById('cam-btn').hidden");
  check(`${version}: Scan with camera is offered`, camShown, camShown);
  await ev("(document.getElementById('cam-btn').click(), true)");
  let camOn = false;
  for (let i = 0; i < 80 && !camOn; i++) {
    await sleep(100);
    camOn = await ev("document.getElementById('camera-card').dataset.state === 'on'");
  }
  check(`${version}: the camera starts and its preview plays`, camOn, camOn);
  if (rfp) {
    let said = '';
    for (let i = 0; i < 100 && !said; i++) {
      await sleep(100);
      said = await ev("document.getElementById('pic-status').textContent");
    }
    const card = await ev("!document.getElementById('camera-card').hidden");
    check(`${version}: with the camera picture hidden by fingerprinting protection, the page says so within seconds and turns the camera off`, said === TEXT.camMadeUp && !card, { said, card });
  } else {
    await sleep(4000);
    const on = await ev("document.getElementById('camera-card').dataset.state === 'on' && document.getElementById('pic-status').textContent === ''");
    check(`${version}: without fingerprinting protection the camera keeps looking`, on, on);
    await ev("(document.getElementById('cam-stop').click(), true)");
  }
  // Stage 4b: a QR code of the clean link, for an ASCII link and one with æ, ø and å.
  const waitFor = async (expression, ms) => {
    for (let i = 0; i < ms / 100; i++) {
      if (await ev(expression)) return true;
      await sleep(100);
    }
    return false;
  };
  const QR_LINKS = ['https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&id=42', 'https://www.blåbærturer.no/tur/kløvsteinen?år=2026&utm_source=x'];
  let saved = 0;
  for (const [i, link] of QR_LINKS.entries()) {
    const want = expectedQr(link);
    const a = analyse(link);
    await ev(`(() => { const t = document.getElementById('link-input'); t.value = ${JSON.stringify(link)}; t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); return true; })()`);
    await waitFor(`document.getElementById('clean-link').textContent === ${JSON.stringify(a.clean(a.defaultRemoved))}`, 5000);
    await ev("(document.getElementById('qr-btn').click(), true)", { press: true });
    const shown = await waitFor("!document.getElementById('qr-card').hidden", 15000);
    const q = await ev(QR_STATE);
    check(`${version}: QR code ${i}: shown after the read-back, exactly the code Node makes, black on white`, shown && !!q.svg && q.svg.d === want.path && q.text === want.text && q.frameBg === 'rgb(255, 255, 255)' && q.svg.pathFill === 'rgb(0, 0, 0)', { shown, text: q.text, status: q.status, frame: q.frameBg });
    if (i === 0) console.log(`note QR code buttons here: Save ${q.save}, Share ${q.share}, Copy ${q.copy}`);
    const before = new Set(readdirSync(downloads));
    await ev("(document.getElementById('qr-save').click(), true)", { press: true });
    saved += 1;
    let file = null;
    for (let k = 0; k < 100 && !file; k++) {
      await sleep(100);
      const now = readdirSync(downloads).filter((n) => !before.has(n) && !/\.part$/.test(n));
      if (now.length) file = now[0];
    }
    await sleep(300);
    const bytes = file ? readFileSync(join(downloads, file)) : null;
    check(`${version}: QR code ${i}: Save picture saves ${file || 'nothing'}, byte for byte the PNG Node writes (and Chromium saves) (${want.png.length} bytes)`, !!file && /^qr-code(\(\d+\))?\.png$/.test(file) && !!bytes && bytes.equals(want.png), { file, size: bytes && bytes.length });
  }
  const reqs = events.filter((e) => e.method === 'network.beforeRequestSent').map((e) => e.params.request.url);
  // Save picture is a download from a blob: address in the page's own memory: allowed, one a press.
  const savedBlobs = reqs.slice(loadReqs).filter((u) => u.startsWith('blob:'));
  const after = reqs.slice(loadReqs).filter((u) => !u.startsWith('blob:'));
  check(`${version}: reading six pictures, starting the camera and making and saving QR codes made no request at all (${after.length}; ${savedBlobs.length} saved pictures from the page's memory)`, after.length === 0 && savedBlobs.length <= saved, { after, savedBlobs });
  check(`${version}: every request went to the page's own server`, reqs.every((u) => u.startsWith(base) || u.startsWith(`blob:${base.replace(/\/$/, '')}/`)), reqs.filter((u) => !u.startsWith(base)));
  const logs = events.filter((e) => e.method === 'log.entryAdded').map((e) => `${e.params.level}: ${e.params.text}`);
  const bad = logs.filter((l) => /^error|Content-Security-Policy|Content Security Policy/i.test(l));
  check(`${version}: no errors and no policy violations in the console`, !bad.length, bad);
  // Stage 5: the privacy page and the disclaimer, as the site serves them.
  const legalFrom = events.length;
  for (const [path, h1] of [['privacy.html', 'Privacy'], ['disclaimer.html', 'Disclaimer and terms of use']]) {
    await send('browsingContext.navigate', { context: ctx, url: `${base}${path}`, wait: 'complete' });
    await sleep(600);
    const st = await ev(LEGAL_STATE);
    check(`${version}: ${path} loads under the site's policy, styled by its own style sheets, with no script, no style block and no notice`, st.h1 === h1 && st.scripts === 0 && st.styleElements === 0 && st.styleAttrs === 0 && st.sheetsLoaded === 2 && !st.gate && (path !== 'disclaimer.html' || (st.mainMaxWidth === '736px' && st.h2Transform === 'uppercase')), { h1: st.h1, sheets: st.sheetsLoaded, max: st.mainMaxWidth, gate: st.gate });
  }
  const legal = events.slice(legalFrom);
  const legalBad = legal.filter((e) => e.method === 'log.entryAdded' && /^error|Content-Security-Policy|Content Security Policy/i.test(`${e.params.level}: ${e.params.text}`)).map((e) => e.params.text);
  const legalReqs = legal.filter((e) => e.method === 'network.beforeRequestSent').map((e) => e.params.request.url);
  check(`${version}: the two pages raise no error or policy violation, and load only from the site itself (${legalReqs.length} requests)`, !legalBad.length && legalReqs.every((u) => u.startsWith(base)), { legalBad, other: legalReqs.filter((u) => !u.startsWith(base)) });
} catch (err) {
  failures++;
  console.log(`FAIL harness: ${err.stack || err}`);
} finally {
  try { await send('session.end', {}); } catch { /* closing anyway */ }
  ws.close();
  browser.kill();
  server.kill();
  await sleep(500);
  spawnSync('pkill', ['-f', profile]);
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}
console.log(`\n${passes} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
