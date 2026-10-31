#!/usr/bin/env node
// End-to-end test of CheckLink in headless Chromium, set up to behave like production.
//
//   node tests/e2e.mjs [--out DIR] [--only name,name] [--chromium PATH] [--keep]
//
// What "like production" means here:
//  * tests/serve.py serves the repository over HTTPS with the headers the stormberry.as zone
//    sends (the zone Content-Security-Policy verbatim, HSTS, nosniff, Speed Brain speculation
//    rules and so on), and only the files GitHub Pages would publish (rules/, tools/ and
//    tests/ are excluded by _config.yml, and this harness proves they give 404);
//  * Chromium loads the page as https://check.stormberry.as/. The name is mapped to the
//    local server and the throwaway certificate is trusted by its key hash, for this browser
//    only. Every other host name is made unresolvable, so nothing can leave this machine even
//    if the page tried, and any such attempt is still recorded;
//  * every flow runs in a fresh browser context, as a first-time visitor, so the first-run
//    notice (stage 5, gate.js) is up when the page has loaded; the harness closes it with a real
//    press on Got it, unless the flow is about the notice itself.
//
// It drives the page over the DevTools protocol with Node's own WebSocket (no packages):
// links go in through the real clipboard and Ctrl+V, or are typed; tick boxes and buttons
// are pressed with real mouse events (or taps on the phone-sized runs) after checking
// nothing covers them; the keyboard is used where a keyboard user would use it. Copy, Share
// and Go to are replaced by the recording stand-ins of tests/share-stub.mjs, so the test can
// read back exactly what the page handed over and nothing is ever opened.
//
// Every result is compared with the engine (src/link-core.js) run in Node: the red,
// struck-through segments, the tick boxes and the clean link for each choice.
//
// Recorded throughout: every network request, console message, browser log entry, uncaught
// exception and policy violation. The whole-run checks then require zero requests other
// than the page's own published files, zero fetch or XHR, zero policy violations and zero
// errors. Screenshots of the main states at 1280x900 and 390x844 go to DIR/shots.
//
// Stage 2: pictures go in through the Choose a picture button and the browser's own file
// chooser (answered with a fixture from tests/fixtures/qr/, made with qrencode), by dropping
// files on the page and by pasting an image from the real clipboard. The decoder worker is
// recorded through its own DevTools session, so its requests count in every network check,
// and each picture's result is compared with the vendored decoder and the inspector run in
// Node. The whole-run checks require that reading pictures makes no request at all.
//
// Stage 3: the live camera. Chromium runs with its fake camera (--use-fake-device-for-media-stream)
// fed by a video made at the start of the run from the tests/fixtures/qr/link.png fixture (six
// seconds of an empty, slightly noisy grey picture, then the code), written as Y4M in the run
// folder (--use-file-for-fake-video-capture). The camera flows press Scan with camera as a person
// would, with the camera allowed or refused for the page, and check that the code is read, the
// camera stops at once (every track the page was given has ended), nothing is recorded, the
// camera stops when the page is hidden, on Stop camera, on Escape and when the person types, and
// that none of it makes a request; a browser that makes up the camera picture (LibreWolf's
// fingerprinting protection, stood in for by frameReadStub) gets a plain message within seconds,
// while a dark picture (the lens covered) keeps the camera looking. The page is served with the Permissions-Policy
// camera=(self) that check.stormberry.as must send (tests/serve.py). Look-alike addresses (also
// stage 3) are pasted and their notes compared with the engine's.
//
// Stage 4b: a QR code of the clean link. Make a QR code is pressed on the desktop and the phone;
// the card's code must be exactly the one src/qr-make.js makes in Node. Save picture downloads for
// real (the browser saves into the run folder): the file is qr-code.png and its bytes are exactly
// the PNG Node writes, from a blob: address of the page's own origin, the only non-web load the
// whole run allows, one for each press of Save. Copy picture and Share picture go to the recording
// stand-ins and must hand over the same bytes. Nothing else is requested.
//
// Needs: /usr/bin/chromium (or --chromium), python3 and openssl (for tests/serve.py --tls).
//
// The file name does not end in .test.mjs, so `node --test tests/` does not run it.

import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:https';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_DATE, analyse, invisibleChunks } from '../src/link-core.js';
import { CAMERA_STATE, LINKISH, PAGE_STATE, PICTURE_STATE, QR_STATE, REPORT_PREFIX, RESULT_WORDS, TEXT, boldText, cameraStub, expectedQr, frameReadStub, goesText, linksOutsideFields, readMailto, shareStub } from './share-stub.mjs';
import { QR_REFUSED } from '../src/qr-make.js';
import { frameWith, pngPixels, y4m } from './png-pixels.mjs';
import { rowLabel } from '../src/row-words.js';
import { inspect } from '../src/qr-inspect.js';
import { decodePicture } from '../src/qr-decode.js';
import { FLAG_VALUE, GATE, GATE_STATE, LEGAL_STATE, copyProblems, metaCsp } from './legal-pages.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOST = 'check.stormberry.as';
const ORIGIN = `https://${HOST}`;
const PAGE_URL = `${ORIGIN}/`;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CHROMIUM = opt('--chromium', process.env.CHROMIUM || '/usr/bin/chromium');
const OUT = resolve(opt('--out', process.env.CL_E2E_OUT || join(tmpdir(), 'checklink-e2e')));
const ONLY = (opt('--only', '') || '').split(',').filter(Boolean);
const KEEP = args.includes('--keep');

const DESKTOP = { width: 1280, height: 900, mobile: false, label: 'desktop', init: shareStub({ share: false, clipboard: true, open: true }) };
const PHONE = { width: 390, height: 844, mobile: true, label: 'phone', init: shareStub({ share: true, clipboard: true, open: true }) };
// A browser with neither the Web Share API nor the async clipboard: Copy falls back to the
// copy command, and Share is not offered.
const BARE = { ...DESKTOP, label: 'desktop-bare', init: shareStub({ share: false, clipboard: false, open: true }) };

// ---------------------------------------------------------------------------------------
// Links

const corpus = JSON.parse(readFileSync(join(ROOT, 'rules', 'provider-test-corpus.json'), 'utf8')).samples;
const sample = (id) => {
  const c = corpus.find((x) => x.id === id);
  if (!c) throw new Error(`corpus sample ${id} is missing`);
  return c.dirty;
};
// The three corpus links pasted in the main flow: Google search, Amazon with a path part,
// and Amazon Music with an Associates tag (one of the five merged-policy samples).
const THREE = [['G1-01', sample('G1-01')], ['G3-01', sample('G3-01')], ['G2-91', sample('G2-91')]];
const ASSOCIATES = 'https://www.amazon.co.uk/dp/B0ABC?tag=me-21&linkCode=ll1&linkId=abc123&ref_=as_li_ss_tl';
const HTTP_LINK = 'http://example.com/a?utm_source=news&id=7';
const FBCLID = 'https://www.example.com/article?fbclid=IwAR3xYzAbCdEf0123456789&id=42';
// The interface build of 10 October 2026: Marcos's own links from rules/marcos-regression.json
// for the parts kept on purpose (spec 8), the Maps context note and Pin only (spec 10), the
// address disguise and the sharer ID, and the search engines; plus links whose report
// message must leave the original out (spec 15).
const REG = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, 'rules', 'marcos-regression.json'), 'utf8')).cases.map((c) => [c.id, c.dirty]));
const YT = REG['M2-youtube-time'];
const MAPS = [REG['M6-google-maps-place'], REG['M7-google-maps-trail']];
// Place only (spec 18): Google's cid for each place's own feature ID. Marcos opened the
// second one in his browser on 10 October 2026: it shows Kleppestø Senter. This test never
// opens either.
const PLACES = ['https://maps.google.com/?cid=11010736480805010322', 'https://maps.google.com/?cid=7942154548931413284'];
// Context but no feature ID in the place's block: only the clean link is offered.
const MAPS_NO_ID = 'https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m5!1m2!2m1!1sCafes!8m2!3d60.4!4d5.2';
const DISGUISE = REG['M8-at-trick-userinfo'];
const SHARER = REG['M12-instagram-exln'];
const SEARCHES = [REG['M5-google-search'], REG['M9-bing-search'], REG['M10-duckduckgo-search'], REG['M11-brave-search']];
const RESET = 'https://example.com/reset-password?token=abc123def456&utm_source=email';
const SAFE_LINKS = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://example.org/page?utm_source=x&a=1')}&data=05%7C01%7Cme%40corp.no%7Cabc&sdata=AbCdEf0123456789&reserved=0`;
const LONG = `https://example.com/a?x=${'y'.repeat(3000)}&utm_source=z`;
const ANALYSED = [...THREE.map(([, l]) => l), ASSOCIATES, HTTP_LINK, FBCLID, YT, ...MAPS, MAPS_NO_ID, ...PLACES, DISGUISE, SHARER, ...SEARCHES, RESET, SAFE_LINKS, LONG];

// ---------------------------------------------------------------------------------------
// Preconditions

for (const [tool, probe] of [['python3', ['--version']], ['openssl', ['version']]]) {
  if (spawnSync(tool, probe).status !== 0) {
    console.error(`This harness needs ${tool}.`);
    process.exit(1);
  }
}
if (!existsSync(CHROMIUM)) {
  console.error(`Chromium not found at ${CHROMIUM}. Pass --chromium PATH.`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const RUN = mkdtempSync(join(OUT, 'run-'));
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PROFILE = mkdtempSync(join(RUN, 'chromium-profile-'));

// The fake camera's video (stage 3): 60 frames (6 s at 10 a second) of an empty grey picture with
// a little noise, then 10 frames with the code from link.png in the middle; Chromium plays it in
// a loop. Made here from the fixture, so the repository holds no video.
const CAMERA_VIDEO = join(RUN, 'camera.y4m');
{
  const code = pngPixels(readFileSync(join(ROOT, 'tests', 'fixtures', 'qr', 'link.png')));
  const frames = [];
  for (let i = 0; i < 60; i++) frames.push(frameWith(null, { width: 480, height: 360, seed: i + 1 }));
  for (let i = 0; i < 10; i++) frames.push(frameWith(code, { width: 480, height: 360, size: 280, seed: i + 100 }));
  writeFileSync(CAMERA_VIDEO, y4m(frames, { width: 480, height: 360, fps: 10 }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

// ---------------------------------------------------------------------------------------
// Results

const results = []; // { flow, name, ok, category, detail, level }
let currentFlow = 'setup';
function check(name, ok, detail, category = 'ui') {
  results.push({ flow: currentFlow, name, ok: !!ok, category, detail: ok ? undefined : detail, level: ok ? 'pass' : 'fail' });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n         ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
  return !!ok;
}
function note(name, detail) {
  results.push({ flow: currentFlow, name, ok: true, category: 'note', detail, level: 'note' });
  console.log(`  note ${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
}

// What the page should show for a link and a choice, from the engine in Node.
function expected(link, removed) {
  const a = analyse(link);
  const set = removed ? new Set(removed) : new Set(a.defaultRemoved);
  return { a, set, clean: a.clean(set), outer: a.segmentsFor(set).filter((s) => s.removed).map((s) => ({ text: s.text, part: s.partId })) };
}

// ---------------------------------------------------------------------------------------
// The local production stand-in

const serveLog = join(RUN, 'serve.log');
const server = spawn('python3', [join(ROOT, 'tests', 'serve.py'), '--tls', '--log', serveLog], {
  env: { ...process.env, TMPDIR: RUN }, stdio: ['ignore', 'pipe', 'inherit'],
});
const ready = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('serve.py did not start')), 20000);
  server.stdout.on('data', (d) => {
    buf += d;
    const m = /READY (\S+) spki=(\S+)/.exec(buf);
    if (m) { clearTimeout(t); res({ url: m[1], spki: m[2] }); }
  });
  server.on('exit', (code) => rej(new Error(`serve.py exited with ${code}`)));
});
const PORT = Number(new URL(ready.url).port);

// What the stand-in publishes, asked from Node (the page itself can fetch nothing).
const status = (path) => new Promise((res) => {
  const req = request({ host: '127.0.0.1', port: PORT, path, method: 'HEAD', servername: HOST, headers: { Host: HOST }, rejectUnauthorized: false }, (r) => { r.resume(); res(r.statusCode); });
  req.on('error', () => res(0));
  req.end();
});

// ---------------------------------------------------------------------------------------
// Chromium and the DevTools protocol

const chrome = spawn(CHROMIUM, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`,
  `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${PORT}, MAP * ~NOTFOUND`,
  `--ignore-certificate-errors-spki-list=${ready.spki}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
  '--disable-sync', '--disable-component-update', '--disable-default-apps', '--password-store=basic',
  '--use-mock-keychain', '--lang=en-GB', '--hide-scrollbars', '--disable-breakpad', '--disable-crash-reporter',
  // Stage 3: a fake camera playing CAMERA_VIDEO. No --use-fake-ui-for-media-stream: each flow
  // allows or refuses the camera for the page itself (openPage), as a person would.
  '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${CAMERA_VIDEO}`,
  'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  // Chromium keeps its crash-report folder under the default profile location even when
  // --user-data-dir points elsewhere. Pointing the config home at the run folder keeps
  // this throwaway browser out of the person's own Chromium settings entirely.
  env: { ...process.env, XDG_CONFIG_HOME: join(RUN, 'xdg-config'), CHROME_CONFIG_HOME: join(RUN, 'xdg-config'), XDG_CACHE_HOME: join(RUN, 'xdg-cache') },
});
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('Chromium did not start')), 30000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) { clearTimeout(t); res(m[1]); }
  });
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const listeners = new Set();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
    else p.res(m.result);
  } else for (const fn of listeners) fn(m);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej, method });
  ws.send(J({ id, method, params, sessionId }));
});

// Everything recorded, across all flows.
const record = { requests: [], failed: [], responses: [], console: [], logs: [], exceptions: [], issues: [], csp: [], targets: [], workers: [] };
// Any new tab or window at all (Go to is stubbed, so there must be none).
listeners.add((m) => {
  if (m.method === 'Target.targetCreated' && m.params.targetInfo.type === 'page' && m.params.targetInfo.url !== 'about:blank') record.targets.push({ flow: currentFlow, url: m.params.targetInfo.url });
});
await send('Target.setDiscoverTargets', { discover: true });

// ---------------------------------------------------------------------------------------
// One page in a fresh browser context

async function openPage(view, opts = {}) {
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const flow = currentFlow;
  const page = { view, flow, phase: 'loading', inflight: new Map(), lastNet: Date.now(), loadFired: false, chooser: [] };
  // The page's own session and those of its workers (stage 2: the decoder worker). A worker's
  // requests reach DevTools only through its own session, so the recorders listen there too.
  const sessions = new Set([sessionId]);

  const onMsg = (m) => {
    if (!sessions.has(m.sessionId)) return;
    const p = m.params;
    const at = { flow, view: view.label, phase: page.phase, worker: m.sessionId !== sessionId };
    switch (m.method) {
      case 'Target.attachedToTarget':
        sessions.add(p.sessionId);
        record.workers.push({ ...at, type: p.targetInfo.type, url: p.targetInfo.url });
        for (const d of ['Network.enable', 'Runtime.enable', 'Log.enable']) send(d, {}, p.sessionId).catch(() => {});
        send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
        break;
      case 'Page.fileChooserOpened':
        page.chooser.push(p);
        break;
      case 'Network.requestWillBeSent':
        record.requests.push({ ...at, id: p.requestId, url: p.request.url, method: p.request.method, type: p.type, initiator: p.initiator?.type });
        page.inflight.set(p.requestId, p.request.url);
        page.lastNet = Date.now();
        break;
      case 'Network.loadingFinished':
        page.inflight.delete(p.requestId);
        page.lastNet = Date.now();
        break;
      case 'Network.loadingFailed':
        record.failed.push({ ...at, url: page.inflight.get(p.requestId), error: p.errorText, blocked: p.blockedReason, cors: p.corsErrorStatus });
        page.inflight.delete(p.requestId);
        page.lastNet = Date.now();
        break;
      case 'Network.responseReceived':
        record.responses.push({ ...at, url: p.response.url, status: p.response.status, mime: p.response.mimeType, type: p.type });
        break;
      case 'Runtime.consoleAPICalled':
        record.console.push({ ...at, type: p.type, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
        break;
      case 'Log.entryAdded':
        record.logs.push({ ...at, level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url });
        break;
      case 'Runtime.exceptionThrown':
        record.exceptions.push({ ...at, text: p.exceptionDetails.exception?.description || p.exceptionDetails.text });
        break;
      case 'Audits.issueAdded':
        record.issues.push({ ...at, code: p.issue.code, details: p.issue.details });
        break;
      case 'Page.loadEventFired':
        page.loadFired = true;
        break;
      default:
    }
  };
  listeners.add(onMsg);

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Log.enable');
  await s('Audits.enable');
  await s('DOM.enable');
  // Workers attach paused, so their first requests are recorded too.
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // "Choose a picture" opens the browser's file chooser; the test answers it like a person.
  await s('Page.setInterceptFileChooserDialog', { enabled: true });
  await s('Emulation.setDeviceMetricsOverride', { width: view.width, height: view.height, deviceScaleFactor: view.mobile ? 2 : 1, mobile: view.mobile });
  if (view.mobile) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // The real clipboard, for pasting: the page reads nothing from it itself. Stage 3: a camera view
  // also allows the camera for the page (grant), or refuses it (deny), before the page loads.
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite', ...(view.camera === 'grant' ? ['videoCapture'] : [])], origin: ORIGIN, browserContextId });
  if (view.camera === 'deny') await send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: ORIGIN, browserContextId });
  if (view.init) await s('Page.addScriptToEvaluateOnNewDocument', { source: view.init });
  // Policy violations as the page sees them. DevTools-injected scripts are not subject to
  // the page policy, so this listener itself causes none.
  await s('Page.addScriptToEvaluateOnNewDocument', {
    source: "window.__e2eCsp=[];document.addEventListener('securitypolicyviolation',e=>window.__e2eCsp.push({d:e.violatedDirective,u:e.blockedURI,s:e.sourceFile,l:e.lineNumber,o:e.originalPolicy.slice(0,60)}),true);",
  });

  const ev = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000, label = expression) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(expression)) return true;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const networkIdle = async (quiet = 600, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (page.inflight.size === 0 && Date.now() - page.lastNet >= quiet) return;
      await sleep(50);
    }
  };

  // Presses an element where a person would: in its centre, after scrolling it into view,
  // and only if nothing else (an overlay, a sticky bar) is on top of it there.
  // The page scrolls smoothly (focus moves to the box after "Check this link", for
  // example); a press sent while it still moves would land somewhere else.
  const settle = async () => {
    let last = await ev('scrollY');
    for (let i = 0; i < 40; i++) {
      await sleep(60);
      const now = await ev('scrollY');
      if (now === last) return;
      last = now;
    }
  };
  const point = async (selector, index = 0) => {
    await settle();
    await ev(`document.querySelectorAll(${J(selector)})[${index}]?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })`);
    await settle();
    const r = await ev(`(() => {
      const el = document.querySelectorAll(${J(selector)})[${index}];
      if (!el) return { err: 'not found' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return { err: 'not visible' };
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit) || (el.control && el.control === hit) || (hit.control && hit.control === el));
      return { x, y, ok, hit: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null };
    })()`);
    if (r.err) throw new Error(`cannot press ${selector}: ${r.err}`);
    if (!r.ok) throw new Error(`cannot press ${selector}: covered by ${r.hit}`);
    return r;
  };
  const click = async (selector, index = 0) => {
    const { x, y } = await point(selector, index);
    if (view.mobile) {
      // A finger tap. (Input.synthesizeTapGesture gives a pointerdown but no click in
      // headless Chromium, so the touch events are sent directly.)
      await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 4, radiusY: 4 }] });
      await sleep(40);
      await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    await sleep(100);
  };
  const KEYS = {
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  };
  const key = async (name, modifiers = 0) => {
    const k = KEYS[name];
    await s('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...k });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
    await sleep(80);
  };
  // Selects everything in the box with Ctrl+A, as a person replacing what is there would.
  const selectBox = async () => {
    await click('#link-input');
    await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(50);
  };
  // Pastes through the real clipboard with Ctrl+V. The clipboard is filled with the
  // browser's own writeText, kept by the stand-in before it replaced it.
  const paste = async (text) => {
    await selectBox();
    await ev(`window.__realWriteText.call(navigator.clipboard, ${J(text)})`);
    await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await waitFor(`document.getElementById('link-input').value === ${J(text)}`, 3000, 'the pasted text in the box');
    await waitFor("!document.getElementById('result').hidden", 3000, 'the analysis');
    await sleep(60);
  };
  const type = async (text) => {
    await selectBox();
    await s('Input.insertText', { text });
    await sleep(450);
  };
  const shot = async (label, { selector, full } = {}) => {
    const file = join(SHOTS, `${view.label}-${label}.png`);
    // Rows off screen skip painting (content-visibility: auto); a picture paints them all.
    await ev("document.querySelectorAll('.cl-part-li').forEach((li) => { li.style.contentVisibility = 'visible'; })");
    let clip;
    if (selector) {
      const b = await ev(`(() => { const el = document.querySelector(${J(selector)}); el.scrollIntoView({ block: 'start', behavior: 'instant' }); const r = el.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; })()`);
      clip = { x: Math.max(0, b[0] - 8), y: Math.max(0, b[1] - 8), width: Math.min(view.width, b[2] + 16), height: Math.min(8000, b[3] + 16), scale: 1 };
    } else if (full) {
      const h = await ev('document.documentElement.scrollHeight');
      clip = { x: 0, y: 0, width: view.width, height: Math.min(12000, h), scale: 1 };
    }
    await sleep(200);
    const r = await s('Page.captureScreenshot', clip ? { format: 'png', captureBeyondViewport: true, clip } : { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  const layout = async (where) => {
    const o = await ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('main *, .site-footer *')) {
        const b = el.getBoundingClientRect();
        if (!b.width) continue;
        if (b.right > vw + 0.5 || b.left < -0.5) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0]);
      }
      return { sw: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 6) };
    })()`);
    check(`${view.label} ${where}: no sideways scrolling, nothing wider than the screen`, o.sw <= o.vw && !o.bad.length, o);
  };
  const state = () => ev(PAGE_STATE);
  const close = async () => {
    const csp = await ev('window.__e2eCsp || []').catch(() => []);
    for (const c of csp) record.csp.push({ flow, view: view.label, ...c });
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  };

  // Stage 2: pictures. Each way a person gives one: the Choose a picture button and the
  // browser's file chooser (answered with the fixture, as a person picks a file), dropping a
  // file on the page, and pasting an image from the real clipboard.
  const FIX = join(ROOT, 'tests', 'fixtures', 'qr');
  const pictureDone = async (ms = 20000) => {
    await waitFor("document.getElementById('pic-status').textContent !== 'Reading the picture on this device.'", ms, 'the picture to be read');
    await sleep(150);
    return ev(PICTURE_STATE);
  };
  const choosePicture = async (file) => {
    const before = page.chooser.length;
    await click('#pic-btn');
    const end = Date.now() + 5000;
    while (page.chooser.length === before && Date.now() < end) await sleep(30);
    if (page.chooser.length === before) throw new Error('the file chooser did not open');
    const { backendNodeId, mode } = page.chooser.at(-1);
    if (mode !== 'selectSingle') throw new Error(`the file chooser allows ${mode}`);
    await s('DOM.setFileInputFiles', { backendNodeId, files: [join(FIX, file)] });
    return pictureDone();
  };
  const dropPicture = async (files) => {
    const { x, y } = await point('#input-card');
    const data = { items: [], files: files.map((f) => join(FIX, f)), dragOperationsMask: 1 };
    await s('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
    await s('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    const dropping = await ev("document.getElementById('input-card').classList.contains('is-dropping')");
    await s('Input.dispatchDragEvent', { type: 'drop', x, y, data });
    const st = await pictureDone();
    return { ...st, dropping };
  };
  const pastePicture = async (file) => {
    const bytes = [...readFileSync(join(FIX, file))];
    await ev(`(async () => { const b = new Blob([new Uint8Array(${J(bytes)})], { type: 'image/png' }); await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); })()`);
    await click('#link-input');
    await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await sleep(100);
    return pictureDone();
  };
  const picture = () => ev(PICTURE_STATE);
  // Stage 3: the camera parts of the page, and hiding the page for real: another tab in the same
  // browser context is opened in front of it (the page's visibilityState becomes hidden), then
  // closed again and the page brought back.
  const camera = () => ev(CAMERA_STATE);
  const hide = async () => {
    const other = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    await send('Target.activateTarget', { targetId: other.targetId });
    await sleep(300);
    return async () => {
      await send('Target.closeTarget', { targetId: other.targetId }).catch(() => {});
      await send('Target.activateTarget', { targetId });
      await sleep(200);
    };
  };

  Object.assign(page, { browserContextId, s, ev, waitFor, click, key, paste, type, selectBox, shot, layout, state, close, networkIdle, point, choosePicture, dropPicture, pastePicture, picture, pictureDone, camera, hide });

  await s('Page.navigate', { url: PAGE_URL });
  const end = Date.now() + 20000;
  while (!page.loadFired && Date.now() < end) await sleep(50);
  await networkIdle();
  page.gate = await ev("!!document.querySelector('.sb-gate-overlay') || document.querySelector('main').inert === true");
  page.phase = 'after-load';
  // Stage 5: a first visit shows the first-run notice. It is closed with a real press on Got it, as
  // a person would close it, unless the flow is about the notice (keepGate).
  if (page.gate && !opts.keepGate) {
    await click('.sb-gate-btn');
    await waitFor("!document.querySelector('.sb-gate-overlay') && !document.querySelector('main').inert", 5000, 'the first-run notice to close');
  }
  return page;
}

// ---------------------------------------------------------------------------------------
// Shared checks

// Whether a URL is one of this site's published files (as GitHub Pages would serve it).
const published = (url) => {
  const u = new URL(url);
  if (u.origin !== ORIGIN) return false;
  if (u.pathname === '/cdn-cgi/speculation') return true;
  const rel = decodeURIComponent(u.pathname).replace(/^\//, '') || 'index.html';
  const file = join(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel);
  return file.startsWith(ROOT) && existsSync(file) && statSync(file).isFile() && !/^(tests|rules|tools|third_party|README|LICENSE|NOTICE|CHANGELOG|bump_assets|_config)/.test(rel);
};

// No attribute anywhere on the page may carry an analysed link or its clean form. The one
// exception is the report line's mailto: ("Did CheckLink break your link? Email us"),
// which carries the links only as text in a message body: exactly one mailto: anchor, id
// report-link, to info@stormberry.as with only a subject and a body, and no other.
async function noLinkTo(p, where, links) {
  const attrs = await p.ev(LINKISH);
  const bad = [];
  for (const link of links) {
    const forms = new Set([link, analyse(link).cleanLink].filter(Boolean));
    for (const a of attrs) {
      if (a.id === 'report-link' && a.attr === 'href') continue;
      for (const f of forms) if (a.value === f || a.value.includes(f) || (a.resolved && a.resolved.includes(f))) bad.push({ ...a, link: f });
    }
  }
  const anchors = await p.ev("[...document.querySelectorAll('a[href]')].map((a) => ({ id: a.id, href: a.getAttribute('href'), target: a.getAttribute('target') }))");
  const isReport = (a) => {
    if (a.id !== 'report-link' || a.target !== null) return false;
    if (a.href === 'mailto:info@stormberry.as') return true;
    const m = readMailto(a.href);
    return a.href.startsWith(REPORT_PREFIX) && !!m && m.to === 'info@stormberry.as' && J(m.params) === J(['subject', 'body']);
  };
  // (0.0.3: the footer's credits sentence links the nine projects and data CheckLink's function is built
  // on, https only, each pinned in tests/footer-credits.test.mjs.)
  const FOOTER_CREDITS = ['https://github.com/zxing-cpp/zxing-cpp', 'https://github.com/Sec-ant/zxing-wasm', 'https://github.com/nayuki/QR-Code-generator', 'https://publicsuffix.org/list/', 'https://github.com/bitcoin/bips/tree/master/bip-0039', 'https://github.com/trezor/python-shamir-mnemonic', 'https://github.com/monero-project/monero/tree/master/src/mnemonics', 'https://www.unicode.org/Public/security/latest/confusables.txt', 'https://github.com/mpchadwick/tracking-query-params-registry'];
  // (Links to Stormberry's own sites, the ecosystem carousel's among them, are part of the page,
  // and so, from stage 4, is the web-only section's link to CheckLink's own Zapstore listing (and
  // since 2026-10-30 its link to the Google Play listing), and
  // from stage 5 the footer's two links to the privacy page and the disclaimer.)
  const foreign = anchors.filter((a) => !isReport(a) && a.href !== 'privacy.html' && a.href !== 'disclaimer.html' && !/^(https:\/\/((?:[a-z]+\.)?stormberry\.as(?:\/|$)|linkedin\.com\/company\/StormberryAS|github\.com\/StormberryAS|virksomhet\.brreg\.no\/|zapstore\.dev\/apps\/no\.stormberry\.checklink$|play\.google\.com\/store\/apps\/details\?id=no\.stormberry\.checklink\.play$)|nostr:npub1|http:\/\/stormberry\w+\.onion)/.test(a.href) && !FOOTER_CREDITS.includes(a.href));
  const mailtos = anchors.filter((a) => /^mailto:/i.test(a.href));
  check(`${p.view.label} ${where}: no anchor or other element points at the analysed link (${anchors.length} anchors: the footer links and the one report mailto:)`, !bad.length && !foreign.length && mailtos.length === 1 && isReport(mailtos[0]), { bad, foreign, mailtos });
}

// What a person reads on the page: no em dashes, no double hyphens, British spelling,
// calm wording. The whole result is read as text too (closed sections and hidden rows
// included, the addresses themselves left out), not only what is on screen.
async function textCheck(p, where) {
  const text = `${await p.ev('document.body.innerText')}\n${await p.ev(RESULT_WORDS)}`;
  const dashes = [...new Set((text.match(/.{0,30}(\u2014|\u2013|--).{0,30}/g) || []))];
  check(`${p.view.label} ${where}: no em dashes, en dashes or double hyphens in the text`, !dashes.length, dashes);
  const us = [...new Set((text.match(/\b(color\w*|organiz\w*|gray|center(ed|s)?|favorite\w*|behavior\w*|analyz\w*|customiz\w*|optimiz\w*|recogniz\w*|cataloged)\b/gi) || []))];
  check(`${p.view.label} ${where}: British spelling`, !us.length, us);
  const alarm = [...new Set((text.replace(/Safe Links/g, '').match(/.{0,25}(\bsafe\w*|\bscam\w*|\bfake\b|\bmalicious\b|!).{0,25}/gi) || []))].filter((x) => !/https?:\/\/\S*!/.test(x));
  check(`${p.view.label} ${where}: calm wording (no "safe", "scam", "fake", "malicious" or exclamation marks)`, !alarm.length, alarm);
}

// Pastes one link and checks the page against the engine: summary, segments, tick boxes,
// labels and the clean link.
async function pasteAndCheck(p, label, link) {
  await p.paste(link);
  const st = await p.state();
  const ex = expected(link);
  const v = p.view.label;
  check(`${v} ${label}: says nothing has been opened, and where it goes`, st.summary === `A web address. ${TEXT.nothingOpened}` && st.goes === goesText(ex.a), { summary: st.summary, goes: st.goes, want: goesText(ex.a) });
  check(`${v} ${label}: the full link is shown whole, never cut short`, st.full === link, st.full);
  check(`${v} ${label}: the red, struck-through segments are exactly the engine's (${ex.outer.length})`, J(st.fullDel) === J(ex.outer), { page: st.fullDel, engine: ex.outer });
  check(`${v} ${label}: the removed parts are struck through, not only red`, ex.outer.length === 0 || /line-through/.test(st.delDecoration), st.delDecoration);
  // Stage 2: the bold part is the registrable domain the Public Suffix List names.
  check(`${v} ${label}: who owns the address is bold and underlined`, st.host === boldText(ex.a) && st.hostBold && /underline/.test(st.hostUnderline), { host: st.host, want: boldText(ex.a), bold: st.hostBold, u: st.hostUnderline });
  check(`${v} ${label}: one tick box per part, ticked when the rules remove it`, J(st.rows.map((r) => [r.id, r.checked])) === J(ex.a.parts.map((x) => [x.id, x.defaultRemove])), st.rows.map((r) => [r.id, r.checked]));
  check(`${v} ${label}: every tick box has a label and a description`, st.rows.every((r) => r.labelled && r.described), st.rows.filter((r) => !r.labelled || !r.described).map((r) => r.id));
  // The label drops the name "Who learns it" already gives (batch 3 interface review finding 6).
  check(`${v} ${label}: every row names the provider, who learns it, what it tells, and its badge`, st.rows.every((r, i) => r.provider === (rowLabel(ex.a.parts[i]) || null) && r.who && r.who.startsWith('Who learns it: ') && r.told === ex.a.parts[i].reveals && r.badge === (ex.a.parts[i].unique ? (ex.a.parts[i].unrecognised ? TEXT.looksUnique : TEXT.unique) : TEXT.same)), st.rows.map((r) => [r.id, r.provider, r.who, r.badge]));
  check(`${v} ${label}: affiliate parts say who they pay`, st.rows.every((r, i) => (ex.a.parts[i].affiliate ? r.aff === `Affiliate: pays the sharer, through ${ex.a.parts[i].affiliate}.` : r.aff === null)), st.rows.map((r) => r.aff));
  check(`${v} ${label}: the clean link is the engine's`, st.clean === ex.clean, { page: st.clean, engine: ex.clean });
  return { st, ex };
}

// The accessible name and description Chromium computes for one element.
async function axOf(p, selector) {
  const { root } = await p.s('DOM.getDocument', { depth: 0 });
  const { nodeId } = await p.s('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { nodes } = await p.s('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const n = nodes.find((x) => !x.ignored) || nodes[0];
  const prop = (name) => n.properties?.find((x) => x.name === name)?.value?.value;
  return { role: n.role?.value, name: n.name?.value, description: n.description?.value, checked: prop('checked'), live: prop('live') };
}

// ---------------------------------------------------------------------------------------
// Flows

const flows = [];
const flow = (name, view, fn, opts = {}) => flows.push({ name, view, fn, opts });

// First, prove the recorders work: break the rules on purpose and check each break is
// seen. These records are then left out of the whole-run checks below.
const SELF_TEST = 'harness-self-test';
flow(SELF_TEST, DESKTOP, async (p) => {
  const mark = { req: record.requests.length, exc: record.exceptions.length, con: record.console.length };
  await p.ev("fetch('https://example.org/e2e-self-test').catch(() => 0)");
  await p.ev("document.body.setAttribute('style', 'outline: 0')");
  await p.ev("new Image().src = 'https://example.org/e2e-self-test.png'");
  await p.ev("console.error('e2e self-test')");
  await p.ev("setTimeout(() => { throw new Error('e2e self-test') }, 0)");
  await sleep(600);
  const csp = await p.ev('window.__e2eCsp');
  check('self-test: a policy violation is recorded', csp.some((c) => c.d === 'connect-src') && csp.some((c) => /^style-src/.test(c.d)) && csp.some((c) => c.d === 'img-src'), csp);
  check('self-test: an off-site attempt is recorded', record.requests.slice(mark.req).some((r) => r.url.startsWith('https://example.org/')) || csp.some((c) => /example\.org/.test(c.u)), record.requests.slice(mark.req).map((r) => r.url));
  check('self-test: an uncaught exception is recorded', record.exceptions.length > mark.exc);
  check('self-test: a console error is recorded', record.console.slice(mark.con).some((c) => c.type === 'error'));
});

flow('paste-three', DESKTOP, async (p) => {
  check('a first visit shows the first-run notice (stage 5), and its Got it closes it', p.gate);
  const page = await p.ev(`({ rules: document.getElementById('rules-date').textContent, result: document.getElementById('result').hidden, store: localStorage.length + sessionStorage.length, cookie: document.cookie })`);
  check(`the empty page shows only the input, and the footer says "Rules dated ${RULES_DATE}"`, page.result && page.rules === `Rules dated ${RULES_DATE}`, page);
  await textCheck(p, 'empty page');
  await p.layout('empty page');
  await p.shot('1-empty', { full: true });
  // Every same-origin link and asset in the page points at a file GitHub Pages publishes.
  // Checked against the repository, not fetched, so it adds no requests.
  const refs = await p.ev(`[...document.querySelectorAll('a[href], img[src], link[href], script[src]')].map(e => e.href || e.src).filter(u => u.startsWith(location.origin + '/'))`);
  const broken = [...new Set(refs.filter((u) => !published(u)))];
  check(`every same-origin link and asset in the page exists and is published (${new Set(refs).size} checked)`, !broken.length, broken);

  for (const [id, link] of THREE) {
    const { ex } = await pasteAndCheck(p, id, link);
    await noLinkTo(p, `${id} before Go to`, [link]);
    await p.shot(`2-${id}`, { full: true });

    // Untick the first ticked part with the mouse: it comes back into the clean link.
    const part = ex.a.parts.find((x) => x.defaultRemove);
    await p.click(`label.cl-part[data-part="${part.id}"] .cl-part-name`);
    let st = await p.state();
    const kept = expected(link, ex.a.defaultRemoved.filter((x) => x !== part.id));
    check(`${id}: unticking ${part.name} keeps it, and the red segments and clean link follow`, st.clean === kept.clean && st.clean !== ex.clean && J(st.fullDel) === J(kept.outer) && !st.rows.find((r) => r.id === part.id).checked, { clean: st.clean, engine: kept.clean });
    // Tick it again with the mouse.
    await p.click(`label.cl-part[data-part="${part.id}"] .cl-part-name`);
    st = await p.state();
    check(`${id}: ticking it again removes it again`, st.clean === ex.clean, st.clean);

    // Copy.
    const before = st.clips.length;
    await p.click('#copy-btn');
    await p.waitFor("document.getElementById('action-status').textContent !== ''", 3000, 'the Copy message');
    st = await p.state();
    check(`${id}: Copy puts exactly the clean link on the clipboard, and says so`, st.clips.length === before + 1 && st.clips.at(-1).text === ex.clean && st.status === TEXT.copied, { clips: st.clips.slice(before), status: st.status });
    check(`${id}: Share is not offered in a browser that cannot share`, !st.share);

    // Go to: nothing to check on these, so it opens straight away, through the stand-in.
    const opened = st.opened.length;
    await p.click('#go-btn');
    st = await p.state();
    check(`${id}: Go to opens the clean link in a new tab, without opener or referrer`, st.opened.length === opened + 1 && st.opened.at(-1).url === ex.clean && st.opened.at(-1).target === '_blank' && st.opened.at(-1).features === 'noopener,noreferrer', st.opened.at(-1));
  }

  // An affiliate network's parts go together: unticking the Associates tag keeps the link
  // type and link ID too, because the credit needs all three.
  const { ex } = await pasteAndCheck(p, 'Associates', ASSOCIATES);
  const tag = ex.a.parts.find((x) => x.name === 'tag');
  await p.click(`label.cl-part[data-part="${tag.id}"] .cl-part-name`);
  const st = await p.state();
  const group = ex.a.parts.filter((x) => x.affiliate === 'Amazon Associates').map((x) => x.id);
  const want = expected(ASSOCIATES, ex.a.defaultRemoved.filter((x) => !group.includes(x)));
  check('Associates: unticking tag keeps every Amazon Associates part together, and only those', group.length === 3 && st.clean === want.clean && st.clean === 'https://www.amazon.co.uk/dp/B0ABC?tag=me-21&linkCode=ll1&linkId=abc123', { clean: st.clean, want: want.clean });
  await p.shot('3-associates-kept', { selector: '#parts-card' });
  await textCheck(p, 'with a result');
  await p.layout('with a result');
  await noLinkTo(p, 'after the flow', ANALYSED);
  const stored = await p.ev(`({ keys: Object.keys(localStorage), flag: localStorage.getItem(${J(GATE.key)}), session: sessionStorage.length, cookie: document.cookie })`);
  check('the one thing stored is the first-run notice\'s flag (the time it was closed): no other localStorage, no sessionStorage, no cookies', J(stored.keys) === J([GATE.key]) && FLAG_VALUE.test(stored.flag) && stored.session === 0 && stored.cookie === '', stored);
});

flow('phone-share', PHONE, async (p) => {
  const { ex } = await pasteAndCheck(p, 'fbclid', FBCLID);
  let st = await p.state();
  check('phone: Copy is the main button and Share is offered where the browser can share', st.copy && st.copyPrimary && st.share, { copy: st.copy, primary: st.copyPrimary, share: st.share });
  await p.layout('with a result');
  await p.shot('1-result', { full: true });
  // Tap the fbclid row to keep it, then tap it again.
  const fb = ex.a.parts.find((x) => x.name === 'fbclid');
  check('phone: fbclid is unique to this click and named as Meta\'s', !!fb && st.rows.find((r) => r.id === fb.id)?.badge === TEXT.unique && st.rows.find((r) => r.id === fb.id)?.who === 'Who learns it: Meta', st.rows);
  await p.click(`label.cl-part[data-part="${fb.id}"]`);
  st = await p.state();
  check('phone: a tap on the row unticks it and the clean link keeps fbclid', st.clean === FBCLID, st.clean);
  await p.click(`label.cl-part[data-part="${fb.id}"]`);
  st = await p.state();
  check('phone: a second tap removes it again', st.clean === ex.clean, st.clean);
  await p.click('#share-btn');
  await sleep(150);
  st = await p.state();
  check('phone: Share hands exactly the clean link to the share sheet, as text', st.shares.length === 1 && st.shares[0].text === ex.clean && !st.shares[0].url && st.status === '', { shares: st.shares, status: st.status });
  await p.ev("window.__share.mode = 'fail'");
  await p.click('#share-btn');
  await sleep(150);
  st = await p.state();
  check('phone: a share that fails says so calmly', st.status === TEXT.shareFailed, st.status);
  await p.click('#copy-btn');
  await sleep(150);
  st = await p.state();
  check('phone: Copy works with a tap', st.clips.at(-1)?.text === ex.clean && st.status === TEXT.copied, { clips: st.clips, status: st.status });
  await noLinkTo(p, 'after Share and Copy', [FBCLID]);
  await p.shot('2-after-copy', { selector: '#clean-card' });
});

flow('no-share-no-clipboard', BARE, async (p) => {
  const { ex } = await pasteAndCheck(p, 'fbclid', FBCLID);
  let st = await p.state();
  check('without the Web Share API, Share is not offered', !st.share);
  await p.click('#copy-btn');
  await sleep(150);
  st = await p.state();
  const focus = await p.ev('document.activeElement.id');
  check('without the async clipboard, Copy falls back to the copy command with exactly the clean link', st.clips.length === 1 && st.clips[0].via === 'execCommand' && st.clips[0].text === ex.clean && st.status === TEXT.copied, st.clips);
  check('the fallback leaves no extra field behind and gives focus back to Copy', focus === 'copy-btn' && (await p.ev("document.querySelectorAll('textarea').length")) === 1, focus);
  await p.ev("window.__clip.mode = 'fail'");
  await p.click('#copy-btn');
  await sleep(150);
  st = await p.state();
  check('a copy that fails says how to copy it by hand', st.status === TEXT.copyFailed, st.status);
});

flow('keyboard-and-confirm', DESKTOP, async (p) => {
  // Typed, not pasted: the analysis follows after the pause.
  await p.type(HTTP_LINK);
  await p.waitFor(`document.getElementById('full-link').textContent === ${J(HTTP_LINK)}`, 3000, 'the typed link');
  const ex = expected(HTTP_LINK);
  let st = await p.state();
  check('typed link: analysed after the pause, with the "not encrypted" warning', st.clean === ex.clean && st.warnings.includes('not-encrypted') && !st.noWarnings, { clean: st.clean, warnings: st.warnings });

  // Tab order: the box, Clear, each tick box, then Copy and Go to.
  await p.ev("document.getElementById('link-input').focus()");
  const order = [];
  for (let i = 0; i < 12; i++) {
    await p.key('Tab');
    const id = await p.ev("document.activeElement.id || document.activeElement.tagName.toLowerCase()");
    order.push(id);
    if (id === 'go-btn') break;
  }
  const boxes = ex.a.parts.map((x) => `part-${x.id}`);
  check('Tab moves through Choose a picture, Scan with camera, Clear, each tick box, Copy and Go to, in reading order', J(order) === J(['pic-btn', 'cam-btn', 'clear-btn', ...boxes, 'copy-btn', 'go-btn']), order);

  // The tick box as a screen reader hears it.
  const ax = await axOf(p, `#part-${ex.a.parts[0].id}`);
  check('a tick box is announced as "Remove utm_source", with the provider, who learns it and what it tells as its description', ax.role === 'checkbox' && ax.name === 'Remove utm_source' && /Campaign tag/.test(ax.description || '') && /Who learns it: /.test(ax.description || ''), ax);
  const live = await axOf(p, '#clean-link');
  check('the clean link is a polite live region', live.live === 'polite', live);

  // Space on a focused tick box.
  await p.ev(`document.getElementById('part-${ex.a.parts[0].id}').focus()`);
  await p.key('Space');
  st = await p.state();
  check('Space unticks the focused part, and the clean link keeps it', st.clean === HTTP_LINK, st.clean);
  await p.key('Space');

  // Go to with Enter: something to check, so a confirmation first.
  await p.ev("document.getElementById('go-btn').focus()");
  await p.key('Enter');
  await p.waitFor("document.getElementById('go-dialog').open", 2000, 'the confirmation');
  const dlg = await p.ev(`({ title: document.getElementById('go-dialog-title').textContent, items: [...document.querySelectorAll('#go-dialog-list .cl-note')].map((li) => li.textContent), focus: document.activeElement.id, confirm: document.getElementById('go-confirm').textContent, modal: document.getElementById('go-dialog').matches(':modal') })`);
  check('the confirmation is modal, names the host, repeats the reason and starts on Cancel', dlg.modal && dlg.title === 'Go to example.com?' && dlg.items.length === 1 && /not encrypted/.test(dlg.items[0]) && dlg.focus === 'go-cancel' && dlg.confirm === 'Go to example.com', dlg);
  await p.shot('1-confirm');
  await p.key('Escape');
  st = await p.state();
  check('Escape closes it, opens nothing and puts focus back on Go to', !st.dialog && st.opened.length === 0 && (await p.ev('document.activeElement.id')) === 'go-btn', { dialog: st.dialog, opened: st.opened });
  await p.key('Enter');
  await p.waitFor("document.getElementById('go-dialog').open", 2000, 'the confirmation again');
  await p.key('Tab');
  check('Tab moves to the Go to button inside the confirmation', (await p.ev('document.activeElement.id')) === 'go-confirm');
  await p.key('Enter');
  await sleep(150);
  st = await p.state();
  check('confirming opens exactly the clean link, once', !st.dialog && st.opened.length === 1 && st.opened[0].url === ex.clean, st.opened);
  await noLinkTo(p, 'after Go to', [HTTP_LINK]);

  // A short link: notice, and no Go to at all.
  await p.paste('https://bit.ly/3abcDEF?utm_source=x');
  st = await p.state();
  check('a short link gets the notice and no Go to', !!st.short && st.go === null, { short: st.short, go: st.go });
  // A script link: Stop, nothing to copy.
  await p.type('javascript:alert(document.domain)');
  await p.waitFor("document.getElementById('summary-line').textContent.startsWith('Not a web address')", 3000, 'the script refusal');
  st = await p.state();
  check('a javascript: link is refused with a Stop notice and no buttons', !!st.stop && !st.copy && st.go === null && st.clean === null, { stop: st.stop });
});

// ---------------------------------------------------------------------------------------
// The interface build of 10 October 2026, at 1280 and 390 pixels

const NARROW = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [...document.querySelectorAll('main *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > vw + 0.5 || b.left < -0.5); }).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0]).slice(0, 6);
  const bad = [...document.querySelectorAll('.cl-badge, .cl-tag, .cl-anyway')].filter((b) => b.getBoundingClientRect().right > b.closest('.cl-part').getBoundingClientRect().right + 0.5).length;
  return { vw, sw: document.documentElement.scrollWidth, bad, out };
})()`;

for (const view of [DESKTOP, PHONE]) {
  const v = view.label;

  // A. Kept on purpose (spec 8).
  flow(`kept-on-purpose-${v}`, view, async (p) => {
    await p.paste(YT);
    let st = await p.state();
    const a = analyse(YT);
    const t = a.kept.find((k) => k.name === 't');
    // The legend lists only the marks the link carries (batch 3 interface review finding 10).
    check(`${v} YouTube: t=354 has a grey dotted underline in the full link, the legend's third style`, J(st.fullFunc) === J([{ text: 't=354', part: t.id }]) && st.funcDecoration === 'dotted' && st.funcColour === 'rgb(154, 145, 174)' && st.legend.length === 4 && st.legend.some((x) => x.startsWith('Dotted underline, no box: ')), { func: st.fullFunc, deco: st.funcDecoration, colour: st.funcColour, legend: st.legend });
    const row = st.keptRows[0];
    check(`${v} YouTube: a "Kept on purpose" row explains it, with an unticked "Remove anyway" box`, st.keptRows.length === 1 && row.id === t.id && row.explain === 'Start time: opens the video at 5:54. It does not identify you.' && !row.checked && row.anyway === TEXT.removeAnyway, st.keptRows);
    const ax = await axOf(p, `#kept-${t.id}`);
    check(`${v} YouTube: the box is announced as "Remove anyway t", described by its value and what it does`, ax.role === 'checkbox' && ax.name === 'Remove anyway t' && /Start time: opens the video at 5:54\./.test(ax.description || ''), ax);
    await p.layout('kept on purpose');
    await p.shot('b2-kept-on-purpose', { selector: '#link-card' });
    await p.shot('b2-kept-on-purpose-rows', { selector: '#parts-card' });
    await p.click(`label.cl-part[data-kept="${t.id}"]`);
    st = await p.state();
    const want = expected(YT, [...a.defaultRemoved, t.id]);
    check(`${v} YouTube: "Remove anyway" takes t out of the clean link, struck through in red`, st.clean === 'https://youtu.be/WgewEn1mFPs' && st.clean === want.clean && J(st.fullDel) === J(want.outer) && st.keptRows[0].checked && st.keptRows[0].ticked, { clean: st.clean, dels: st.fullDel });
    await p.shot('b2-kept-removed-anyway', { selector: '#parts-card' });
    // Tab reaches it after the parts and before Copy.
    await p.ev("document.getElementById('link-input').focus()");
    const order = [];
    for (let i = 0; i < 8; i++) {
      await p.key('Tab');
      const id = await p.ev('document.activeElement.id || document.activeElement.tagName.toLowerCase()');
      order.push(id);
      if (id === 'copy-btn') break;
    }
    check(`${v} YouTube: Tab moves through Choose a picture, Scan with camera, Clear, the part, the kept box, then Copy`, J(order) === J(['pic-btn', 'cam-btn', 'clear-btn', ...a.parts.map((x) => `part-${x.id}`), `kept-${t.id}`, 'copy-btn']), order);
    await p.ev(`document.getElementById('kept-${t.id}').focus()`);
    await p.key('Space');
    st = await p.state();
    check(`${v} YouTube: Space on the focused kept box unticks it, and t comes back`, !st.keptRows[0].checked && st.clean === 'https://youtu.be/WgewEn1mFPs?t=354' && st.fullFunc.length === 1, { rows: st.keptRows, clean: st.clean });
    await textCheck(p, 'kept on purpose');
    await noLinkTo(p, 'kept on purpose', [YT]);
  });

  // B. The Google Maps context note, Pin only (spec 10) and Place only (spec 18).
  flow(`maps-context-${v}`, view, async (p) => {
    const pins = ['https://www.google.com/maps/@60.4211807,5.2337099,17z', 'https://www.google.com/maps/@60.4103774,5.2268809,17z'];
    const names = ["a category or search words ('Vacation rentals')", "a place viewed earlier ('Kleppest\u00F8')"];
    for (let i = 0; i < MAPS.length; i++) {
      await p.paste(MAPS[i]);
      let st = await p.state();
      const li = await p.ev(`(() => { const li = document.querySelector('#warn-list [data-warning="maps-context"]'); return li ? { text: li.textContent, tier: li.dataset.tier || null } : null; })()`);
      check(`${v} Maps ${i + 1}: a neutral "Good to know" note names ${names[i]}`, !!li && li.tier === null && li.text === `Good to know: This map address also holds something Maps picked up on the way to this place: ${names[i]}. Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.` && !/your search/i.test(li.text), li);
      check(`${v} Maps ${i + 1}: the place link stays the clean link, and "No warning signs found" still shows`, st.clean === expected(MAPS[i]).clean && st.noWarnings, st.clean);
      check(`${v} Maps ${i + 1}: "Pin only" offers the place's own coordinates`, !!st.pin && st.pin.link === pins[i], st.pin);
      await p.click('#pin-copy');
      await p.waitFor("document.getElementById('pin-status').textContent !== ''", 2000, 'the pin copy message');
      st = await p.state();
      check(`${v} Maps ${i + 1}: Copy pin only copies exactly that link`, st.clips.at(-1).text === pins[i] && st.pin.status === TEXT.pinCopied, { clip: st.clips.at(-1), status: st.pin.status });
      check(`${v} Maps ${i + 1}: "Place only" offers the place's own cid link, below Pin only, as text and not a link`, !!st.place && st.place.link === PLACES[i] && st.place.title === 'Place only' && st.place.button === 'Copy place only' && await p.ev("!document.querySelector('#place-card a') && !!(document.getElementById('pin-card').compareDocumentPosition(document.getElementById('place-card')) & Node.DOCUMENT_POSITION_FOLLOWING)"), st.place);
      check(`${v} Maps ${i + 1}: the Place only words say what it opens, plainly`, !!st.place && st.place.help === "A third link to the same place. It opens the place's own page, without the route or searches that led to it.", st.place && st.place.help);
      const before = record.requests.length;
      await p.click('#place-copy');
      await p.waitFor("document.getElementById('place-status').textContent !== ''", 2000, 'the place copy message');
      await sleep(300);
      st = await p.state();
      check(`${v} Maps ${i + 1}: Copy place only copies exactly that link, and the clean link stays the full place link`, st.clips.at(-1).text === PLACES[i] && st.place.status === TEXT.placeCopied && st.clean === expected(MAPS[i]).clean, { clip: st.clips.at(-1), status: st.place.status, clean: st.clean });
      const sent = record.requests.slice(before);
      check(`${v} Maps ${i + 1}: Copy place only makes no request at all (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
      await p.layout(`Maps ${i + 1}`);
      await p.shot(`b2-maps-${i + 1}-note`, { selector: '#warn-card' });
      await p.shot(`b2-maps-${i + 1}-pin`, { selector: '#pin-card' });
      await p.shot(`b2-maps-${i + 1}-place`, { selector: '#place-card' });
    }
    // The page-wide wording check reads the full link too, and a Maps data= blob is full of
    // '!' separators, so the Place only card's own words are checked on their own here.
    const placeWords = await p.ev(`(() => { const c = document.getElementById('place-card').cloneNode(true); for (const el of c.querySelectorAll('.cl-addr')) el.remove(); return c.textContent.replace(/\\s+/g, ' ').trim(); })()`);
    check(`${v} Place only words: no dashes or double hyphens, no exclamation marks, never "safe", British spelling`, placeWords.includes('Place only') && !/[–—!]|--/.test(placeWords) && !/\bsafe/i.test(placeWords) && !/\b(color|organiz|gray|center|favorite|behavior|analyz|customiz|optimiz|recogniz)/i.test(placeWords), placeWords);
    await p.paste(MAPS_NO_ID);
    let st = await p.state();
    check(`${v} Maps with no feature ID: only the clean link, no Pin only and no Place only`, st.clean === MAPS_NO_ID && st.pin === null && st.place === null, { clean: st.clean, pin: st.pin, place: st.place });
    await p.paste(THREE[0][1]);
    st = await p.state();
    check(`${v} Maps: Pin only and Place only go away for a link that is not a Maps place`, st.pin === null && st.place === null, { pin: st.pin, place: st.place });
    await textCheck(p, 'Maps');
    await noLinkTo(p, 'Maps', [...MAPS, MAPS_NO_ID, ...pins, ...PLACES]);
  });

  // C. "Did CheckLink break your link? Email us" (spec 15).
  flow(`report-mail-${v}`, view, async (p) => {
    await p.paste(YT);
    let st = await p.state();
    let m = readMailto(st.report && st.report.href);
    check(`${v} report: the line sits right under "Opens in a new tab, in this browser."`, !!st.report && st.report.line === TEXT.reportLine && await p.ev("document.getElementById('go-help').nextElementSibling.id === 'report-line' && !document.getElementById('go-help').hidden"), st.report);
    const ax = await axOf(p, '#report-link');
    check(`${v} report: "Email us" is a link to info@stormberry.as, with no target and nothing else`, ax.role === 'link' && ax.name === 'Email us' && await p.ev("(() => { const a = document.getElementById('report-link'); return a.getAttribute('target') === null && a.getAttribute('rel') === null && a.attributes.length === 3; })()"), ax);
    check(`${v} report: subject and body as agreed, the original as written and the clean link as shown`, !!m && m.subject === 'CheckLink: a cleaned link broke' && m.body === ['Before you send: the original link may hold personal parts, such as a code that identifies you. You can edit them out of this message.', '', `Original link: ${YT}`, "CheckLink's clean link: https://youtu.be/WgewEn1mFPs?t=354", 'What went wrong (optional): ', '', '', `Rules dated ${RULES_DATE}`].join('\r\n'), m);
    await p.shot('b2-report-line', { selector: '#clean-card' });
    // The message follows the choice: Remove anyway on t changes the clean link in it.
    const tk = analyse(YT).kept.find((k) => k.name === 't');
    await p.click(`label.cl-part[data-kept="${tk.id}"]`);
    st = await p.state();
    m = readMailto(st.report.href);
    check(`${v} report: a changed choice changes the clean link in the message too`, m.body.includes("CheckLink's clean link: https://youtu.be/WgewEn1mFPs\r\n"), m.body);
    // With nothing removed (t back, si unticked) CheckLink has changed nothing, so the line
    // goes (batch 3 interface review finding 15).
    const si = analyse(YT).parts[0];
    await p.click(`label.cl-part[data-kept="${tk.id}"]`);
    await p.click(`label.cl-part[data-part="${si.id}"]`);
    st = await p.state();
    check(`${v} report: with nothing removed the line is not offered`, st.report === null && st.clean === YT, { report: st.report, clean: st.clean });
    // Safeguards.
    // A reset link is left untouched: nothing is removed, so the line is not offered at all
    // (batch 3 interface review finding 15); the engine would keep both links out anyway.
    await p.paste(RESET);
    st = await p.state();
    check(`${v} report, reset link: nothing is removed, so the line is not offered`, st.report === null && st.clean === RESET, { report: st.report, clean: st.clean });
    for (const [label, link, secret, cleanIn] of [['Safe Links', SAFE_LINKS, 'corp.no', true]]) {
      await p.paste(link);
      st = await p.state();
      m = readMailto(st.report.href);
      check(`${v} report, ${label}: the original is left out with the reason, and nothing personal is in the message`, /^Original link: left out, because /m.test(m.body) && !m.body.includes(secret) && !st.report.href.includes(encodeURIComponent(secret)) && /^CheckLink's clean link: /m.test(m.body) && (cleanIn ? m.body.includes("CheckLink's clean link: https://example.org/page?a=1\r\n") : /^CheckLink's clean link: left out/m.test(m.body)), m.body);
    }
    await p.paste(LONG);
    st = await p.state();
    m = readMailto(st.report.href);
    check(`${v} report, a 3,000 character link: shortened in the middle, and the whole address stays under 1,800 characters`, st.report.href.length < 1800 && /^Original link \(shortened\): https:\/\/example\.com\/a\?x=y+\u2026y+/m.test(m.body), { length: st.report.href.length });
    await p.layout('report line');
    await noLinkTo(p, 'report line', [YT, RESET, SAFE_LINKS, LONG]);
  });

  // D. The rows build 1 added: the address disguise, the sharer ID and the search engines.
  flow(`new-rows-${v}`, view, async (p) => {
    await p.paste(DISGUISE);
    let st = await p.state();
    const d = st.rows[0];
    check(`${v} disguise: "Address disguise" with a Check badge, its explanation, and no "Who learns it" line`, st.rows.length === 1 && d.name === 'Address disguise' && d.badge === TEXT.disguiseBadge && d.who === null && d.value === null && d.told === analyse(DISGUISE).parts[0].reveals && d.checked && st.clean === 'http://kaspersky.com/blog/', d);
    await p.layout('disguise');
    await p.shot('b2-disguise', { selector: '#parts-card' });
    await p.paste(SHARER);
    st = await p.state();
    const sRow = st.rows.find((r) => r.name === 'exln');
    check(`${v} sharer ID: exln says "Tied to the sharer" and "Who learns it: Meta"`, !!sRow && sRow.badge === TEXT.sharer && sRow.who === 'Who learns it: Meta' && sRow.checked, sRow);
    await p.layout('sharer ID');
    await p.shot('b2-sharer', { selector: '#parts-card' });
    for (const link of SEARCHES) {
      const host = new URL(link).hostname;
      const { st: s2 } = await pasteAndCheck(p, host, link);
      check(`${v} ${host}: the search words are kept on purpose and explained`, s2.keptRows.some((r) => ['q'].includes(r.name) && r.explain === 'The search itself. Everyone who gets this link can read what was searched for.'), s2.keptRows);
      await p.layout(host);
      await p.shot(`b2-search-${host.replace(/^(www|search)\./, '').split('.')[0]}`, { selector: '#parts-card' });
    }
    // Rows that would repeat the row above (Bing's lq after ghc, qs and sk after sc) say
    // "Same kind as the part above"; Chromium still describes their boxes in full (batch 3
    // interface review finding 6).
    {
      const BING = REG['M9-bing-search'];
      await p.paste(BING);
      const st = await p.state();
      const a = analyse(BING);
      const folded = st.rows.filter((r) => r.same === TEXT.sameKind).map((r) => r.name);
      check(`${v} Bing: lq, qs and sk say "${TEXT.sameKind}" and show no repeated label or explanation`, J(folded) === J(['lq', 'qs', 'sk']) && st.rows.filter((r) => r.same).every((r) => r.shownTold === null && r.shownProvider === null && r.shownWho === null), st.rows.map((r) => [r.name, r.same, r.shownTold]));
      const lq = a.parts.find((x) => x.name === 'lq');
      // Rows below the fold skip layout (content-visibility: auto), and DevTools then reports
      // the box as ignored; a person reaching it brings it into view first, so the test does too.
      // (Stage 2's picture row moved this row below the fold on the phone.)
      await p.ev(`document.getElementById('part-${lq.id}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
      await sleep(150);
      const ax = await axOf(p, `#part-${lq.id}`);
      check(`${v} Bing: the folded lq box is still described by its label, who learns it and what it tells`, ax.role === 'checkbox' && (ax.description || '').includes(lq.reveals) && (ax.description || '').includes('Who learns it: Microsoft') && !(ax.description || '').includes(TEXT.sameKind), ax);
    }
    if (view.mobile) {
      // The narrowest phones, 320 pixels, for every new kind of row.
      await p.s('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
      await sleep(200);
      for (const link of [YT, MAPS[1], DISGUISE, SHARER, ...SEARCHES]) {
        await p.paste(link);
        const n = await p.ev(NARROW);
        check(`${v} at 320 pixels (${new URL(link).hostname}): no sideways scrolling, nothing wider than the screen, no badge outside its row`, n.sw <= n.vw && !n.out.length && n.bad === 0, n);
      }
      await p.paste(MAPS[1]);
      await p.shot('b2-320-maps', { full: true });
      await p.paste(DISGUISE);
      await p.shot('b2-320-disguise', { selector: '#parts-card' });
    }
    await textCheck(p, 'new rows');
    await noLinkTo(p, 'new rows', [DISGUISE, SHARER, ...SEARCHES]);
  });
}

// ---------------------------------------------------------------------------------------
// Stage 2: pictures and the QR inspector, at 1280 and 390 pixels

// What a fixture holds, from the vendored decoder and the inspector run in Node: the page must
// show exactly this.
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'qr');
const fixtureCache = new Map();
async function fixture(file) {
  if (!fixtureCache.has(file)) {
    const { codes } = await decodePicture(readFileSync(join(FIXTURE_DIR, file)));
    fixtureCache.set(file, codes.map((c) => ({ code: c, p: inspect(c.text, { bytes: c.bytes, format: c.format, contentType: c.contentType }) })));
  }
  return fixtureCache.get(file);
}
const QR_LINK = 'https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&utm_campaign=autumn&id=42';
const QR_SECOND = 'https://evil.example/login?utm_source=sticker';
ANALYSED.push(QR_LINK, QR_SECOND, 'https://example.org/app?utm_source=qr', 'https://example.no/ola?utm_source=card', 'HTTPS://EXAMPLE.COM/A?UTM_SOURCE=QR&ID=7');
const TIER_OF = { stop: 'red', check: 'amber', info: null };
const shownText = (s) => invisibleChunks(s).map((c) => (c.invisible ? c.label.split(' ')[0] : c.text)).join('');

// The page's card for one code against the inspector's payload. The format sits on its own line
// under the title (since the fixes of 11 October 2026), and an address shown whole as a detail
// has its Check this link button there instead of in the card's list of addresses.
// A single code holding a web address has its link checked below: since the stage 3 fixes its card
// says so instead of repeating "A web address. Nothing has been opened." (interface review M3).
function sameCard(card, p, n, i) {
  const below = n === 1 && p.kind === 'web' && p.summary === 'A web address. Nothing has been opened.';
  const summary = below ? 'Its link is checked below.' : p.summary;
  return card.kind === p.kind && card.tier === TIER_OF[p.tier]
    && card.title === `${n > 1 ? `Code ${i + 1}: ` : ''}${p.title}` && card.format === p.formatLabel
    && card.summary === `${{ stop: 'Stop', check: 'Check', info: 'Good to know' }[p.tier]}: ${summary}`
    && J(card.fields.map((f) => f.label)) === J(p.fields.map((f) => f.label))
    && J(card.notes) === J(p.warnings.map((w) => w.id))
    // Invisible characters are drawn as visible marks (U+202E), never as themselves.
    && J(card.links) === J(linksOutsideFields(p).map(shownText))
    && card.anchors === 0;
}

for (const view of [DESKTOP, PHONE]) {
  const v = view.label;

  // A. A link in a picture, from every kind of file: the box gets the link and the full analysis.
  flow(`picture-link-${v}`, view, async (p) => {
    const mark = record.requests.length;
    let st = await p.choosePicture('link.png');
    const ex = expected(QR_LINK);
    let page = await p.state();
    check(`${v} link.png through Choose a picture: one QR code, and nothing has been opened`, st.card && st.summary === TEXT.picOne && st.codes.length === 1 && st.codes[0].kind === 'web' && st.status === '', st);
    check(`${v} link.png: its link goes in the box and gets the full analysis, said to come from the picture`, st.box === QR_LINK && page.summary === TEXT.fromPicture && page.clean === ex.clean && J(page.fullDel) === J(ex.outer) && page.goes === goesText(ex.a), { box: st.box, summary: page.summary, clean: page.clean });
    check(`${v} link.png: the picture is drawn with the code outlined, and described for screen readers`, st.canvas.shown && st.canvas.width > 0 && st.canvas.label === 'Your picture, with the code CheckLink found outlined.', st.canvas);
    const want = await fixture('link.png');
    check(`${v} link.png: the code’s card is the inspector’s, with no live link anywhere`, sameCard(st.codes[0], want[0].p, 1, 0), { page: st.codes[0], engine: want[0].p.title });
    check(`${v} link.png: the card says its link is checked below, with no second Check this link`, st.codes[0].checkedBelow && !(await p.ev("!!document.querySelector('#code-0 button[data-use=\"code-link\"]')")), st.codes[0]);
    await noLinkTo(p, 'link.png', [QR_LINK]);
    await p.layout('a link from a picture');
    await p.shot('p2-link-png', { full: true });
    for (const file of ['link.jpg', 'link.gif', 'link.bmp', 'link-photo.jpg', 'link-exif6.jpg', 'link.avif']) {
      st = await p.choosePicture(file);
      check(`${v} ${file}: read on this device, the same link in the box`, st.card && st.box === QR_LINK && st.codes.length === 1, { status: st.status, box: st.box });
    }
    st = await p.choosePicture('link.heic');
    check(`${v} link.heic: read, or refused with a plain reason (this browser may not decode HEIC)`, (st.card && st.box === QR_LINK) || st.status === 'This kind of picture (HEIC) cannot be read in this browser. Save it as JPEG or PNG, or take a screenshot, and try again.', st.status);
    st = await p.choosePicture('upper.png');
    page = await p.state();
    check(`${v} upper.png: a link stored in capitals loses its UTM_ parts`, st.box === 'HTTPS://EXAMPLE.COM/A?UTM_SOURCE=QR&ID=7' && page.clean === 'HTTPS://EXAMPLE.COM/A?ID=7', { box: st.box, clean: page.clean });
    await p.click('#clear-btn');
    st = await p.picture();
    check(`${v} Clear empties the box and takes the picture away`, !st.card && st.box === '' && st.status === '', st);
    const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
    check(`${v} reading ten pictures made no request at all (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
    await textCheck(p, 'pictures');
  });

  // B. What other codes hold, each shown in plain words.
  flow(`picture-kinds-${v}`, view, async (p) => {
    const mark = record.requests.length;
    for (const file of ['wifi.png', 'epc.png', 'bitcoin.png', 'vcard.png', 'intent.png', 'script.png', 'rlo.png', 'aztec.png', 'datamatrix.png', 'pdf417.png', 'ean13.png', 'seed.png']) {
      const st = await p.choosePicture(file);
      const want = await fixture(file);
      check(`${v} ${file}: ${want[0].p.title}, ${want[0].p.tier}: the card matches the inspector, with no live link`, st.card && st.codes.length === 1 && sameCard(st.codes[0], want[0].p, 1, 0) && (want[0].p.kind === 'web' || st.box === ''), { page: st.codes[0], engine: { kind: want[0].p.kind, tier: want[0].p.tier, title: want[0].p.title, notes: want[0].p.warnings.map((w) => w.id) } });
      if (file === 'wifi.png' || file === 'epc.png' || file === 'aztec.png') await p.shot(`p2-${file.replace('.png', '')}`, { selector: '#picture-card' });
    }
    // A link inside a code is checked only when asked, then in the box.
    let st = await p.choosePicture('vcard.png');
    await p.click('#code-0 button[data-use="code-link"]');
    let page = await p.state();
    st = await p.picture();
    check(`${v} vCard: Check this link puts the card’s web address in the box; the card stays`, st.box === 'https://example.no/ola?utm_source=card' && st.card && page.clean === 'https://example.no/ola' && page.summary === TEXT.fromPicture, { box: st.box, clean: page.clean });
    st = await p.choosePicture('script.png');
    check(`${v} a javascript: code is Stop, shows no link and nothing to open`, st.codes[0].tier === 'red' && st.codes[0].links.length === 0 && st.box === '' && (await p.ev("document.getElementById('result').hidden")), st.codes[0]);
    await noLinkTo(p, 'codes', ['https://example.no/ola?utm_source=card', 'https://example.org/app?utm_source=qr']);
    await textCheck(p, 'code kinds');
    await p.layout('code kinds');
    const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
    check(`${v} reading every kind of code made no request at all (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
  });

  // C. Secrets: hidden until Show, copied only after a confirmation; the picture not redrawn.
  flow(`picture-secrets-${v}`, view, async (p) => {
    let st = await p.choosePicture('wifi.png');
    const pw = () => st.codes[0].fields.find((f) => f.label === 'Password');
    check(`${v} Wi-Fi: the password is hidden, with Show and Copy password; the code’s own text is not offered`, pw().hidden && /^•{8} hidden$/.test(pw().value) && J(pw().buttons.map((b) => b.text)) === J(['Show', 'Copy password']) && pw().buttons[0].pressed === 'false' && st.codes[0].raw === null, pw());
    check(`${v} Wi-Fi: it says anyone holding the code can join`, st.codes[0].noteTexts.some((x) => x.includes('Anyone who has this code, or a picture of it, can join this network.')), st.codes[0].noteTexts);
    check(`${v} Wi-Fi: the picture is not drawn again (a screenshot would give the password back), and the card says why`, !st.canvas.shown && st.notice === `Check: ${TEXT.picNotShown}`, { canvas: st.canvas, notice: st.notice });
    await p.click('#code-0 .cl-show');
    st = await p.picture();
    check(`${v} Wi-Fi: Show reveals it and says so to screen readers (pressed, "Hide Password")`, !pw().hidden && pw().value === 'correct horse battery' && pw().buttons[0].text === 'Hide' && pw().buttons[0].pressed === 'true' && pw().buttons[0].label === 'Hide Password', pw());
    await p.click('#code-0 .cl-show');
    st = await p.picture();
    check(`${v} Wi-Fi: Hide hides it again`, pw().hidden, pw());
    const clips = (await p.state()).clips.length;
    await p.click('#code-0 button[data-use="copy"][data-field="0"]');
    await sleep(150);
    let page = await p.state();
    st = await p.picture();
    check(`${v} Wi-Fi: Copy network name copies exactly the name, and says so`, page.clips.length === clips + 1 && page.clips.at(-1).text === 'Kleppesto Guest' && st.codes[0].status === 'Copied: Network name.', { clip: page.clips.at(-1), status: st.codes[0].status });
    st = await p.choosePicture('otp.png');
    const secret = st.codes[0].fields.find((f) => f.label === 'Secret');
    check(`${v} 2FA code: Stop, the secret hidden, and the picture is not drawn again, said in the picture card`, st.codes[0].tier === 'red' && secret.hidden && !st.canvas.shown && st.notice === `Stop: ${TEXT.picNotShown}` && st.status === '', { tier: st.codes[0].tier, secret, canvas: st.canvas, notice: st.notice, status: st.status });
    const before = (await p.state()).clips.length;
    await p.click('#code-0 button[data-use="copy"]');
    const dialog = await p.ev("({ open: document.getElementById('copy-dialog').open, modal: document.getElementById('copy-dialog').matches(':modal'), focus: document.activeElement.id })");
    check(`${v} 2FA code: Copy secret asks first, in a modal that starts on Cancel`, dialog.open && dialog.modal && dialog.focus === 'copy-cancel', dialog);
    await p.shot('p2-copy-dialog');
    await p.click('#copy-cancel');
    page = await p.state();
    check(`${v} 2FA code: Cancel copies nothing`, page.clips.length === before && !(await p.ev("document.getElementById('copy-dialog').open")), page.clips.length);
    await p.click('#code-0 button[data-use="copy"]');
    await p.click('#copy-confirm');
    await sleep(150);
    page = await p.state();
    st = await p.picture();
    check(`${v} 2FA code: confirming copies exactly the secret, once`, page.clips.length === before + 1 && page.clips.at(-1).text === 'JBSWY3DPEHPK3PXP' && st.codes[0].status === 'Copied: Secret.', page.clips.slice(before));
    st = await p.choosePicture('seed.png');
    const words = st.codes[0].fields.find((f) => f.label === 'The words');
    check(`${v} recovery words: Stop, hidden, with the "whoever has these words" warning`, st.codes[0].tier === 'red' && words.hidden && st.codes[0].noteTexts.some((x) => /Whoever has these words has the wallet/.test(x)), st.codes[0]);
    await p.shot('p2-secrets', { selector: '#picture-card' });
    await textCheck(p, 'secrets');
  });

  // D. Several codes in one picture, each with its own result.
  flow(`picture-two-codes-${v}`, view, async (p) => {
    let st = await p.choosePicture('two-codes.png');
    const want = await fixture('two-codes.png');
    check(`${v} two codes: both listed in reading order, numbered, with the sticker notice`, st.codes.length === 2 && st.summary === 'This picture holds 2 codes. Each one is described below. Nothing has been opened.' && st.notice === `Check: ${TEXT.picSeveral}` && st.codes.every((c, i) => sameCard(c, want[i].p, 2, i)), { notice: st.notice, codes: st.codes.map((c) => c.title) });
    check(`${v} two codes: nothing goes in the box by itself`, st.box === '' && (await p.ev("document.getElementById('result').hidden")), st.box);
    check(`${v} two codes: the picture marks them 1 and 2`, st.canvas.shown && /outlined and numbered 1 to 2/.test(st.canvas.label || ''), st.canvas);
    check(`${v} two codes: each address says who owns it`, J(st.codes.map((c) => c.goes)) === J([['Goes to example.com.'], ['Goes to evil.example.']]), st.codes.map((c) => c.goes));
    await p.click('#code-1 button[data-use="code-link"]');
    st = await p.picture();
    const page = await p.state();
    check(`${v} two codes: Check this link on code 2 analyses that link; the picture stays`, st.box === QR_SECOND && st.card && page.clean === 'https://evil.example/login' && page.summary === TEXT.fromPicture, { box: st.box, clean: page.clean });
    await p.click('#code-0 button[data-use="code-link"]');
    st = await p.picture();
    check(`${v} two codes: and code 1 after it`, st.box === QR_LINK && st.card, st.box);
    await p.layout('two codes');
    await p.shot('p2-two-codes', { full: true });
    st = await p.choosePicture('link-wifi.png');
    check(`${v} a link beside a Wi-Fi code: the picture is drawn with the Wi-Fi code painted over, and the card says so`, st.codes.length === 2 && st.canvas.shown && /Code 2 holds private details, so it is covered in the picture/.test(st.notice || '') && /painted over/.test(st.canvas.label || ''), { notice: st.notice, canvas: st.canvas });
    if (view.mobile) {
      await p.s('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
      await sleep(200);
      for (const file of ['two-codes.png', 'wifi.png', 'epc.png', 'aztec.png', 'otp.png']) {
        await p.choosePicture(file);
        const n = await p.ev(NARROW);
        check(`${v} at 320 pixels (${file}): no sideways scrolling, nothing wider than the screen`, n.sw <= n.vw && !n.out.length, n);
      }
      await p.choosePicture('epc.png');
      await p.shot('p2-320-epc', { full: true });
    }
    await textCheck(p, 'two codes');
    await noLinkTo(p, 'two codes', [QR_LINK, QR_SECOND]);
  });

  // E. Broken and hostile files: a plain reason, no card, no request.
  flow(`picture-hostile-${v}`, view, async (p) => {
    const mark = record.requests.length;
    for (const [file, msg] of [['not-image.png', TEXT.picNotImage], ['empty.png', TEXT.picNotImage], ['nocode.png', TEXT.picNone], ['truncated.png', TEXT.picNone],
      ['huge-header.png', 'This picture is too large to read here (900 megapixels). Take a screenshot of the code, or crop the picture, and try again.']]) {
      const st = await p.choosePicture(file);
      check(`${v} ${file}: "${msg.slice(0, 50)}…", no card, nothing in the box`, st.status === msg && !st.card && st.box === '', { status: st.status, card: st.card });
    }
    const st = await p.choosePicture('link.png');
    check(`${v} after the broken files, a good picture still reads`, st.card && st.box === QR_LINK, st.status);
    const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
    check(`${v} broken files made no request (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
  });
}

// F. Dropping and pasting pictures.
flow('picture-drop-paste', DESKTOP, async (p) => {
  let st = await p.dropPicture(['link.png']);
  check('drop: the input card is outlined while a file is dragged over it, and the dropped picture is read', st.dropping && st.card && st.box === QR_LINK, { dropping: st.dropping, status: st.status });
  st = await p.dropPicture(['wifi.png', 'link.png']);
  check('drop of two files: the first is read, and the page says so', st.card && st.codes[0].kind === 'wifi' && st.status === 'CheckLink reads one picture at a time, so it read the first one.', st.status);
  st = await p.pastePicture('two-codes.png');
  check('paste: an image pasted into the box is read as a picture, not as text', st.card && st.codes.length === 2 && st.box === '', { codes: st.codes.length, box: st.box });
  await p.paste(FBCLID);
  st = await p.picture();
  const page = await p.state();
  check('paste: text pasted afterwards is a link again, and the picture goes', !st.card && page.clean === expected(FBCLID).clean, { card: st.card, clean: page.clean });
  const url = await p.ev('location.href');
  check('nothing dropped ever replaced the page', url === PAGE_URL, url);
});


// ---------------------------------------------------------------------------------------
// Stage 3: the live camera (Chromium's fake camera playing CAMERA_VIDEO), and look-alikes

// ---------------------------------------------------------------------------------------
// Stage 5: the first-run notice, the privacy page and the disclaimer, as the site serves them.

// Waits for a navigation the page started itself (a link pressed); evaluation fails meanwhile.
async function arriveAt(p, path) {
  for (let i = 0; i < 150; i++) {
    try {
      if (await p.ev(`location.pathname === ${J(path)} && document.readyState === 'complete'`)) return true;
    } catch { /* the page is being replaced */ }
    await sleep(100);
  }
  return false;
}

flow('first-run-notice', PHONE, async (p) => {
  let g = await p.ev(GATE_STATE);
  check('notice: a first visit shows it, as a modal dialog named by its heading, dismissible', p.gate && g.open && g.tier === 'dismissible' && g.role === 'dialog' && g.modal === 'true' && g.title === GATE.title && g.kicker === GATE.kicker, g);
  check('notice: its words, word for word, and a link to the full disclaimer that opens in place', J(g.paragraphs) === J(GATE.paragraphs) && g.ack === GATE.ack && g.button === GATE.button && g.link === GATE.link && g.linkHref === GATE.linkHref && g.linkTarget === null, g);
  check('notice: the page behind it is inert and hidden from screen readers, and focus is on the notice', g.othersInert && g.mainInert && g.focusInside, { inert: g.othersInert, focus: g.focus });
  check('notice: nothing is stored before it is closed', g.stored === null && J(g.keys) === '[]', { stored: g.stored, keys: g.keys });
  const words = copyProblems([GATE.title, ...g.paragraphs, g.ack].join('\n'));
  check('notice: plain British English, no dashes, never "safe" or "verified"', !words.length, words);
  await p.shot('notice');
  // A tap behind the notice does nothing to the page: the box cannot be reached.
  const blocked = await p.ev("(() => { const t = document.getElementById('link-input'); const b = t.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !hit || !t.contains(hit); })()");
  check('notice: the link box cannot be reached while it is open', blocked);
  // Read the full disclaimer: the disclaimer opens in place; the notice is not counted as seen.
  await p.click('.sb-gate-link');
  let arrived = await arriveAt(p, '/disclaimer.html');
  const d = await p.ev(LEGAL_STATE);
  check('notice: Read the full disclaimer opens disclaimer.html in the same tab, styled, with no notice there', arrived && d.h1 === 'Disclaimer and terms of use' && !d.gate && d.mainMaxWidth === '736px' && d.styleElements === 0, { arrived, h1: d.h1, gate: d.gate });
  const kept = await p.ev(`localStorage.getItem(${J(GATE.key)})`);
  check('notice: leaving through the disclaimer link does not count as having closed it', kept === null, kept);
  await p.click('a.back');
  arrived = await arriveAt(p, '/');
  await p.waitFor("!!document.querySelector('.sb-gate-overlay')", 10000, 'the notice again');
  g = await p.ev(GATE_STATE);
  check('notice: Back to CheckLink shows it again, because it was not closed', arrived && g.open, { arrived, open: g.open });
  await p.click('.sb-gate-btn');
  await p.waitFor("!document.querySelector('.sb-gate-overlay')", 5000, 'the notice to close');
  g = await p.ev(GATE_STATE);
  check('notice: Got it closes it, the page can be used, and its one flag is stored: the time it was closed', !g.open && !g.mainInert && FLAG_VALUE.test(g.stored) && J(g.keys) === J([GATE.key]), g);
  await p.s('Page.reload', {});
  await arriveAt(p, '/');
  await p.networkIdle();
  g = await p.ev(GATE_STATE);
  check('notice: after a reload it does not show again', !g.open && !g.mainInert && FLAG_VALUE.test(g.stored), g);
  await p.paste(FBCLID);
  const st = await p.state();
  check('notice: once closed, the page works as before', st.clean === analyse(FBCLID).cleanLink, st.clean);
}, { keepGate: true });

flow('legal-pages', DESKTOP, async (p) => {
  const indexCsp = metaCsp(readFileSync(join(ROOT, 'index.html'), 'utf8'));
  const foot = await p.ev("[...document.querySelectorAll('a[href=\"privacy.html\"], a[href=\"disclaimer.html\"]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent, target: a.getAttribute('target'), footer: !!a.closest('.site-footer') }))");
  check('legal: the footer has one Privacy and one Disclaimer link, both opening in place', J(foot) === J([{ href: 'privacy.html', text: 'Privacy', target: null, footer: true }, { href: 'disclaimer.html', text: 'Disclaimer', target: null, footer: true }]), foot);
  await p.click('.site-footer a[href="privacy.html"]');
  let arrived = await arriveAt(p, '/privacy.html');
  await p.networkIdle();
  let st = await p.ev(LEGAL_STATE);
  check('legal: Privacy opens privacy.html, with no first-run notice there', arrived && st.h1 === 'Privacy' && !st.gate, { arrived, path: st.path });
  check('legal: privacy.html carries exactly the page\'s policy, no scripts and no inline styles', st.csp === indexCsp && st.scripts === 0 && st.styleElements === 0 && st.styleAttrs === 0, st);
  check('legal: privacy.html says what the 0.0.1 app does: on the device, one permission (the camera), no internet access, Zapstore, the notice\'s flag, rights and a date', ['one permission, the camera', 'no internet access', 'Zapstore', 'first-run notice', 'Datatilsynet', 'keeps no history', 'Last updated:'].every((x) => st.text.includes(x)), st.text.slice(0, 300));
  check('legal: privacy.html says how the website is hosted (The web version, 31 October 2026)', ['CheckLink is also a website, at check.stormberry.as', 'GitHub Pages stores the site and keeps its own logs; Cloudflare delivers it on our behalf and keeps short-lived logs.'].every((x) => st.text.includes(x)) && !/this site/i.test(st.text), (st.text.match(/.{0,40}(check\.stormberry\.as|GitHub Pages|Cloudflare|this site).{0,40}/i) || [])[0]);
  const pw = copyProblems(st.text);
  check('legal: privacy.html is plain British English, no dashes, never "safe" or "verified"', !pw.length, pw);
  await p.layout('privacy');
  await p.shot('privacy', { full: true });
  await p.click('.site-footer a[href="disclaimer.html"]');
  arrived = await arriveAt(p, '/disclaimer.html');
  await p.networkIdle();
  st = await p.ev(LEGAL_STATE);
  check('legal: Disclaimer opens disclaimer.html, styled by disclaimer.css under the site\'s policy, with no style block, script or notice', arrived && st.h1 === 'Disclaimer and terms of use' && st.styleElements === 0 && st.styleAttrs === 0 && st.scripts === 0 && !st.gate && st.mainMaxWidth === '736px' && st.h2Transform === 'uppercase', st);
  check('legal: the disclaimer links CheckLink\'s own privacy page and back to CheckLink', J(st.privacyLinks) === J([{ current: null, target: null }]) && st.back === './', { privacy: st.privacyLinks, back: st.back });
  const dw = copyProblems(st.text);
  check('legal: the disclaimer has no dashes and never "safe" or "verified"', !dw.length, dw);
  await p.shot('disclaimer', { full: true });
  await p.click('a.back');
  arrived = await arriveAt(p, '/');
  await p.networkIdle();
  const back = await p.ev("({ gate: !!document.querySelector('.sb-gate-overlay'), box: !!document.getElementById('link-input') })");
  check('legal: Back to CheckLink returns to the page, without the notice (it was closed on arrival)', arrived && back.box && !back.gate, back);
});

flow('legal-pages-phone', PHONE, async (p) => {
  for (const [path, link] of [['/privacy.html', '.site-footer a[href="privacy.html"]'], ['/disclaimer.html', '.site-footer a[href="disclaimer.html"]']]) {
    await p.click(link);
    const arrived = await arriveAt(p, path);
    await p.networkIdle();
    const st = await p.ev(LEGAL_STATE);
    check(`legal on a phone: ${path} opens with a tap and fits the screen`, arrived && st.sw <= st.vw && !st.gate, { arrived, sw: st.sw, vw: st.vw });
    await p.layout(path.slice(1));
    await p.shot(path.slice(1, -5), { full: true });
    await p.ev('history.back(), true');
    await arriveAt(p, '/');
    await p.networkIdle();
  }
});

const DESKTOP_CAM = { ...DESKTOP, label: 'desktop-camera', camera: 'grant', init: DESKTOP.init + cameraStub() };
const PHONE_CAM = { ...PHONE, label: 'phone-camera', camera: 'grant', init: PHONE.init + cameraStub() };
const NARROW_CAM = { width: 320, height: 640, mobile: true, label: 'narrow-camera', camera: 'grant', init: shareStub({ share: true, clipboard: true, open: true }) + cameraStub() };
const REFUSED_CAM = { ...DESKTOP, label: 'desktop-camera-refused', camera: 'deny', init: DESKTOP.init + cameraStub() };
const NO_CAM = { ...PHONE, label: 'phone-no-camera', camera: 'grant', init: PHONE.init + cameraStub({ mode: 'none' }) };
const MADE_UP_CAM = { ...DESKTOP, label: 'desktop-camera-made-up', camera: 'grant', init: DESKTOP.init + cameraStub() + frameReadStub('random') };
const DARK_CAM = { ...DESKTOP, label: 'desktop-camera-dark', camera: 'grant', init: DESKTOP.init + cameraStub() + frameReadStub('dark') };

const cameraOn = (p) => p.waitFor("document.getElementById('camera-card').dataset.state === 'on'", 10000, 'the camera to be on');

for (const view of [DESKTOP_CAM, PHONE_CAM, NARROW_CAM]) {
  const v = view.label;
  flow(`camera-scan-${v}`, view, async (p) => {
    const mark = record.requests.length;
    let c = await p.camera();
    check(`${v} Scan with camera is offered with its help line, and nothing has asked for the camera or listed cameras yet`, c.button && c.buttonText === 'Scan with camera' && c.help === TEXT.camHelp && c.calls === 0 && c.enumerations === 0 && !c.card && c.expanded === 'false', c);
    const ax = await axOf(p, '#cam-btn');
    check(`${v} the button is announced as "Scan with camera", with its help as the description`, ax.role === 'button' && ax.name === 'Scan with camera' && ax.description === TEXT.camHelp, ax);
    await p.click('#cam-btn');
    await cameraOn(p);
    c = await p.camera();
    check(`${v} pressing it asks for the camera once: video only, the rear camera preferred`, c.calls === 1 && /"facingMode":\{"ideal":"environment"\}/.test(c.constraints[0]) && /"audio":false/.test(c.constraints[0]), c.constraints);
    check(`${v} the preview plays, the card says the camera is on, and focus is on Stop camera`, c.card && c.playing && c.status === TEXT.camLooking && c.focus === 'cam-stop' && c.expanded === 'true' && c.live >= 1, c);
    check(`${v} one camera: no Switch camera button, and the cameras were listed only after the camera was allowed`, !c.switchShown && c.enumerations === 1, c);
    const vid = await p.s('Accessibility.getPartialAXTree', { nodeId: (await p.s('DOM.querySelector', { nodeId: (await p.s('DOM.getDocument', { depth: 0 })).root.nodeId, selector: '#cam-video' })).nodeId, fetchRelatives: false });
    const live = await axOf(p, '#cam-status');
    check(`${v} the preview itself is hidden from screen readers; the status line, a live region, speaks instead`, vid.nodes.every((x) => x.ignored) && live.role === 'status', { video: vid.nodes.map((x) => ({ ignored: x.ignored, role: x.role && x.role.value })), status: live });
    await p.layout('the camera on');
    await p.shot('p3-camera-on', { full: view.mobile });
    await p.waitFor("!document.getElementById('picture-card').hidden", 20000, 'the code to be read');
    c = await p.camera();
    const st = await p.picture();
    const page = await p.state();
    const ex = expected(QR_LINK);
    check(`${v} the code is read and the camera is off at once: every track ended, the preview empty, the card gone`, !c.card && c.tracks >= 1 && c.live === 0 && !c.srcObject && c.expanded === 'false', c);
    check(`${v} one QR code from the camera: its link in the box with the full analysis, said to come from the camera`, st.summary === TEXT.camFound && c.pictureTitle === TEXT.camTitle && st.box === QR_LINK && page.summary === TEXT.fromCamera && page.clean === ex.clean && J(page.fullDel) === J(ex.outer), { summary: st.summary, title: c.pictureTitle, box: st.box, page: page.summary, clean: page.clean });
    const want = await fixture('link.png');
    check(`${v} the code's card is the inspector's, with no live link anywhere`, st.codes.length === 1 && sameCard(st.codes[0], want[0].p, 1, 0), st.codes[0]);
    check(`${v} no frame from the camera is drawn or kept on the page`, !st.canvas.shown && st.canvas.width === 0 && st.canvas.height === 0, st.canvas);
    check(`${v} nothing was recorded: no MediaRecorder was made`, c.recorders === 0, c);
    const focus = await p.ev('document.activeElement && document.activeElement.id');
    check(`${v} focus moves from Stop camera, which has gone, to the heading of what was found`, focus === 'picture-title', focus);
    // The page goes to that heading, so focus is never left above the screen (interface review M3
    // of stage 3; it used to scroll to the summary, about 400 pixels below the focused heading).
    let seen = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      seen = await p.ev("(() => { const b = document.getElementById('picture-title').getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight }; })()");
      if (seen.top >= 0 && seen.bottom <= seen.vh) break;
    }
    check(`${v} the heading that holds focus is in view once the page has moved to it`, seen.top >= 0 && seen.bottom <= seen.vh, seen);
    await noLinkTo(p, 'camera', [QR_LINK]);
    await p.layout('a link from the camera');
    await p.shot('p3-camera-found', { full: true });
    await textCheck(p, 'camera');
    const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
    check(`${v} scanning with the camera made no request at all (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
  });
}

flow('camera-stop-and-leave', DESKTOP_CAM, async (p) => {
  const mark = record.requests.length;
  const off = (c) => !c.card && c.live === 0 && !c.srcObject && c.expanded === 'false';
  // Stop camera.
  await p.click('#cam-btn');
  await cameraOn(p);
  await p.click('#cam-stop');
  let c = await p.camera();
  check('Stop camera turns the camera off at once and says so; focus goes back to Scan with camera', off(c) && c.picStatus === TEXT.camStopped && !c.picError && c.focus === 'cam-btn', c);
  // Escape.
  await p.click('#cam-btn');
  await cameraOn(p);
  await p.key('Escape');
  c = await p.camera();
  check('Escape in the camera card turns the camera off too', off(c) && c.picStatus === TEXT.camStopped && c.focus === 'cam-btn', c);
  // The page hidden behind another tab.
  await p.click('#cam-btn');
  await cameraOn(p);
  const back = await p.hide();
  const hiddenNow = await p.ev('document.visibilityState');
  c = await p.camera();
  check(`hiding the page (another tab in front: ${hiddenNow}) turns the camera off at once`, hiddenNow === 'hidden' && off(c), c);
  await back();
  c = await p.camera();
  check('back on the page, the camera stays off until pressed again, and the page says why it stopped', off(c) && c.picStatus === TEXT.camHidden, c);
  // Typing a link means the person has moved on.
  await p.click('#cam-btn');
  await cameraOn(p);
  await p.type(FBCLID);
  c = await p.camera();
  const page = await p.state();
  check('typing in the box turns the camera off, and the typed link is analysed', off(c) && page.clean === expected(FBCLID).clean, { camera: c, clean: page.clean });
  // Choosing a picture while scanning.
  await p.click('#clear-btn');
  await p.click('#cam-btn');
  await cameraOn(p);
  const st = await p.choosePicture('wifi.png');
  c = await p.camera();
  check('choosing a picture turns the camera off and reads the picture', off(c) && st.card && st.codes[0].kind === 'wifi' && c.pictureTitle === 'From your picture', { camera: c, codes: st.codes.length });
  check('every stream the page was given has ended, and nothing was recorded', c.tracks >= 5 && c.live === 0 && c.recorders === 0, c);
  const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
  check(`starting and stopping the camera five times made no request (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
});

flow('camera-refused', REFUSED_CAM, async (p) => {
  await p.click('#cam-btn');
  await p.waitFor("document.getElementById('pic-status').textContent !== ''", 8000, 'the refusal');
  const c = await p.camera();
  check('a refused camera: a plain message in its box, no camera card, no stream, focus back on Scan with camera', c.picStatus === TEXT.camDenied && c.picError && !c.card && c.tracks === 0 && c.calls === 1 && c.focus === 'cam-btn', c);
  await p.shot('p3-camera-refused', { selector: '#input-card' });
});

flow('camera-none', NO_CAM, async (p) => {
  await p.click('#cam-btn');
  await p.waitFor("document.getElementById('pic-status').textContent !== ''", 8000, 'the message');
  const c = await p.camera();
  check('no camera on the device: a plain message in its box, no camera card, focus back on Scan with camera', c.picStatus === TEXT.camNone && c.picError && !c.card && c.tracks === 0 && c.focus === 'cam-btn', c);
  await p.layout('no camera');
});

// A browser that hides the camera picture from pages gives made-up pixels (LibreWolf and Tor Browser:
// random values, see-through ones among them). The page says so and stops, rather than looking for
// two minutes. A real camera with its lens covered gives dark frames, which are not taken for that.
flow('camera-made-up-pixels', MADE_UP_CAM, async (p) => {
  const mark = record.requests.length;
  await p.click('#cam-btn');
  await cameraOn(p);
  await p.waitFor("document.getElementById('pic-status').textContent !== ''", 10000, 'the message');
  const c = await p.camera();
  check('made-up camera pixels (random and see-through, as LibreWolf gives): the page says the browser hides the picture, in its box, within seconds, and the camera is off', c.picStatus === TEXT.camMadeUp && c.picError && !c.card && c.live === 0 && !c.srcObject && c.focus === 'cam-btn', c);
  const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
  check(`made-up camera pixels: no request (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
});

flow('camera-dark', DARK_CAM, async (p) => {
  await p.click('#cam-btn');
  await cameraOn(p);
  await sleep(4500);
  let c = await p.camera();
  check('a dark camera picture (the lens covered) is not taken for a hidden one: after 4.5 seconds the camera is still on and looking, with no message', c.card && c.state === 'on' && c.picStatus === '' && c.live === 1 && c.status === TEXT.camLooking, c);
  await p.click('#cam-stop');
  c = await p.camera();
  check('a dark camera picture: Stop camera still turns it off', !c.card && c.live === 0 && c.picStatus === TEXT.camStopped, c);
});

// Look-alike addresses (stage 3): the note on the page is the engine's, Go to asks first.
const LOOKALIKES = ['https://paypal.com.evil.io/signin?utm_source=mail', 'https://p\u0430ypal.com/login', 'https://dnb-sikkerhet.no/logg-inn?fbclid=abc', 'https://www.norsk\u2010tipping.no/'];
ANALYSED.push(...LOOKALIKES);
for (const view of [DESKTOP, PHONE]) {
  const v = view.label;
  flow(`look-alike-${v}`, view, async (p) => {
    const mark = record.requests.length;
    for (const link of LOOKALIKES) {
      await p.paste(link);
      const ex = expected(link);
      const st = await p.state();
      const notes = await p.ev("[...document.querySelectorAll('#warn-list .cl-note')].map((li) => ({ id: li.dataset.warning, tier: li.dataset.tier || null, text: li.textContent }))");
      const want = ex.a.warnings.filter((w) => w.id.startsWith('look-alike'));
      const shown = notes.filter((n) => n.id.startsWith('look-alike'));
      check(`${v} ${link}: the look-alike note is the engine's, as a Check note, and "No warning signs" is not shown`, want.length === 1 && shown.length === 1 && shown[0].text === `Check: ${want[0].text}` && shown[0].tier === 'amber' && !st.noWarnings && st.clean === ex.clean, { shown, want: want.map((w) => w.text) });
    }
    await p.shot('p3-look-alike', { selector: '#warn-card' });
    await p.paste(LOOKALIKES[0]);
    await p.click('#go-btn');
    const dialog = await p.ev("({ open: document.getElementById('go-dialog').open, items: [...document.querySelectorAll('#go-dialog-list .cl-note')].map((li) => li.dataset.warning) })");
    check(`${v} Go to asks first, and the question lists the look-alike note`, dialog.open && dialog.items.includes('look-alike-brand'), dialog);
    await p.click('#go-cancel');
    const opened = await p.ev('window.__opened.length');
    check(`${v} cancelled: nothing was opened`, opened === 0, opened);
    await p.layout('a look-alike note');
    const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
    check(`${v} checking look-alike addresses made no request (${sent.length})`, sent.length === 0, sent.map((r) => r.url));
  });
}

// A QR code of the clean link (stage 4b).
const DESKTOP_QR = { ...DESKTOP, label: 'desktop-qr', init: shareStub({ share: false, clipboard: true, open: true, pictures: true }) };
const PHONE_QR = { ...PHONE, label: 'phone-qr', init: shareStub({ share: true, clipboard: true, open: true, files: true }) };
const QR_LINKS = [sample('G1-01'), 'https://www.blåbærturer.no/tur/kløvsteinen?år=2026&utm_source=x'];
ANALYSED.push(...QR_LINKS);
// SC-9 (Marcos, 2026-10-12): links refused a code with a line above Copy and Share.
const QR_EMAIL = 'https://shop.example.com/confirm?email=someone%40example.no&utm_source=x';
const QR_SHORT_EMAIL = 'https://bit.ly/3xYz?email=someone%40example.no&utm_source=x';
ANALYSED.push(QR_EMAIL, QR_SHORT_EMAIL);
// Every press of Save picture, so the whole-run check can allow exactly that many blob: downloads.
const qrSaves = [];
for (const view of [DESKTOP_QR, PHONE_QR]) {
  const v = view.label;
  flow(`qr-code-${v}`, view, async (p) => {
    const mark = record.requests.length;
    const dir = join(RUN, `downloads-${v}`);
    mkdirSync(dir, { recursive: true });
    await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, browserContextId: p.browserContextId, eventsEnabled: true });
    const downloads = [];
    const onDownload = (m) => {
      if (m.method === 'Browser.downloadWillBegin') downloads.push({ guid: m.params.guid, url: m.params.url, name: m.params.suggestedFilename, state: 'begun' });
      if (m.method === 'Browser.downloadProgress') {
        const d = downloads.find((x) => x.guid === m.params.guid);
        if (d) d.state = m.params.state;
      }
    };
    listeners.add(onDownload);
    try {
      for (const [i, link] of QR_LINKS.entries()) {
        const want = expectedQr(link);
        await p.paste(link);
        await p.waitFor(`document.getElementById('clean-link').textContent === ${J(expected(link).clean)}`, 5000, 'the analysis');
        await p.click('#qr-btn');
        await p.waitFor("!document.getElementById('qr-card').hidden", 15000, 'the QR code card');
        const q = await p.ev(QR_STATE);
        check(`${v} ${i}: the card's code is exactly the one Node makes, as one path, black on white, labelled with the host`, q.svg.d === want.path && q.svg.viewBox === want.viewBox && q.svg.fill === '#000000' && q.svg.bg === '#ffffff' && !q.svg.styled && q.svg.label === TEXT.qrLabel(want.host) && q.text === want.text && q.frameBg === 'rgb(255, 255, 255)', { text: q.text, label: q.svg.label });
        // Copy picture wherever the clipboard takes a PNG (Chromium's does); Share only where the
        // browser can share files (the phone's stand-in can, the desktop has no share sheet).
        const pngClipboard = await p.ev("typeof ClipboardItem === 'function' && (typeof ClipboardItem.supports !== 'function' || ClipboardItem.supports('image/png'))");
        check(`${v} ${i}: the buttons this browser can carry out: Save, ${view === PHONE_QR ? 'Share' : 'no Share'}, and Copy where the clipboard takes a PNG`, q.save && q.share === (view === PHONE_QR) && q.copy === pngClipboard && pngClipboard, { save: q.save, share: q.share, copy: q.copy, pngClipboard });
        if (i === 0) {
          await noLinkTo(p, `${v} with the QR code card open`, [link]);
          await textCheck(p, 'the QR code card');
          await p.layout('the QR code card');
          await p.shot('qr-card', { selector: '#qr-card' });
        }
        const before = downloads.length;
        qrSaves.push(v);
        await p.click('#qr-save');
        const end = Date.now() + 10000;
        while (Date.now() < end && !(downloads.length > before && downloads.at(-1).state === 'completed')) await sleep(50);
        const d = downloads.at(-1);
        const bytes = d && d.state === 'completed' && existsSync(join(dir, d.guid)) ? readFileSync(join(dir, d.guid)) : null;
        check(`${v} ${i}: Save picture downloads qr-code.png whose bytes are exactly the PNG Node writes (${want.png.length} bytes)`, downloads.length === before + 1 && d.name === 'qr-code.png' && !!bytes && bytes.equals(want.png), { downloads: downloads.slice(before), size: bytes && bytes.length });
        // (Whether the address was let go of cannot be asked from the page without a fetch, which
        // its policy forbids; tests/qr-make.test.mjs reads saveQr for the revoke.)
        check(`${v} ${i}: from a blob: address of the page's own, with no download link left in the page`, !!d && d.url.startsWith(`blob:${ORIGIN}/`) && (await p.ev("document.querySelectorAll('a[download], a[href^=\"blob:\"]').length")) === 0, d);
        if (view === DESKTOP_QR) {
          await p.click('#qr-copy');
          await p.waitFor("document.getElementById('qr-status').textContent !== ''", 5000, 'Copy picture');
          const pics = await p.ev('({ pictures: window.__clip.pictures, status: document.getElementById("qr-status").textContent })');
          check(`${v} ${i}: Copy picture hands the clipboard exactly the same PNG, and says so`, pics.pictures.length === i + 1 && pics.pictures.at(-1).type === 'image/png' && Buffer.from(pics.pictures.at(-1).base64, 'base64').equals(want.png) && pics.status === TEXT.qrCopied, { n: pics.pictures.length, status: pics.status });
        } else {
          await p.click('#qr-share');
          await p.waitFor(`window.__share.files.length === ${i + 1}`, 5000, 'Share picture');
          const sh = await p.ev('({ calls: window.__share.calls, files: window.__share.files })');
          const f = sh.files.at(-1);
          check(`${v} ${i}: Share picture hands over qr-code.png alone, exactly the same PNG`, f.name === 'qr-code.png' && f.type === 'image/png' && Buffer.from(f.base64, 'base64').equals(want.png) && sh.calls.at(-1).text === undefined && sh.calls.at(-1).title === undefined, { name: f.name, type: f.type, call: sh.calls.at(-1) });
        }
      }
      // A link that gets no code: the line instead of the button, and nothing to save. Where the
      // browser can share, the line above (Share held back) gives the reason, so the QR line is the
      // short one (SC-9); where it cannot, that line is not shown and the QR line gives it in full.
      const share = view === PHONE_QR;
      await p.paste(RESET);
      await p.waitFor(`document.getElementById('clean-link').textContent === ${J(expected(RESET).clean)}`, 5000, 'the analysis');
      let q = await p.ev(QR_STATE);
      check(`${v}: a reset link gets no button and one plain line instead${share ? ', the short one under the line that gives the reason (SC-9)' : ', in full (no line above where the browser cannot share)'}`, !q.button && !q.card && (share ? q.shareNote === TEXT.shareHeldAuth && q.note === TEXT.qrSameReason : q.shareNote === null && q.note === QR_REFUSED.auth), { button: q.button, note: q.note, shareNote: q.shareNote });
      // SC-9: an email address gives the PD-1 line above Copy and Share in every browser, and the
      // short QR line under it; a short link with one keeps the short link's own reason in full.
      await p.paste(QR_EMAIL);
      await p.waitFor(`document.getElementById('clean-link').textContent === ${J(expected(QR_EMAIL).clean)}`, 5000, 'the analysis');
      q = await p.ev(QR_STATE);
      check(`${v} (SC-9): a link with an email address gets the PD-1 line and the short QR line`, !q.button && q.warn === TEXT.personalEmail && q.note === TEXT.qrSameReason, { warn: q.warn, note: q.note });
      await p.paste(QR_SHORT_EMAIL);
      await p.waitFor(`document.getElementById('clean-link').textContent === ${J(expected(QR_SHORT_EMAIL).clean)}`, 5000, 'the analysis');
      q = await p.ev(QR_STATE);
      check(`${v} (SC-9): a short link with an email address gets the PD-1 line and the QR line in full, for its own reason`, !q.button && q.warn === TEXT.personalEmail && q.note === QR_REFUSED.short, { warn: q.warn, note: q.note });
      const sent = record.requests.slice(mark).filter((r) => r.phase === 'after-load');
      const blobs = sent.filter((r) => r.url.startsWith(`blob:${ORIGIN}/`));
      check(`${v}: making, saving, copying and sharing QR codes requested nothing but the saved pictures from the page's own memory (${sent.length})`, sent.length === blobs.length && blobs.length <= QR_LINKS.length, sent.map((r) => `${r.type} ${r.url.slice(0, 60)}`));
    } finally {
      listeners.delete(onDownload);
    }
  });
}

// ---------------------------------------------------------------------------------------
// Run

const t0 = Date.now();
try {
  // What GitHub Pages would publish, as the stand-in serves it.
  currentFlow = 'published files';
  console.log('\n# published files');
  const want200 = ['/', '/app.js', '/style.css', '/favicon.svg', '/src/link-core.js', '/src/rules.js', '/src/row-words.js', '/fonts/inter/inter.css', '/robots.txt',
    '/src/domain.js', '/src/psl.js', '/src/qr-inspect.js', '/src/qr-worker.js', '/src/qr-decode.js', '/src/worker-lockdown.js', '/vendor/zxing-wasm-3.1.6/es/reader/index.js', '/vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js', '/licences/zxing-wasm-MIT.txt', '/licences/Public-Suffix-List-MPL-2.0.txt',
    '/src/wordlists.js', '/licences/Monero-BSD-3-Clause.txt', '/licences/SLIP-0039-wordlist-MIT.txt', '/licences/Inter-OFL-1.1.txt',
    '/src/lookalike.js', '/src/confusables.js', '/src/brands.js', '/licences/Unicode-3.0.txt',
    '/src/qr-make.js', '/vendor/qrcodegen-8329a71/qrcodegen.js', '/licences/QR-Code-generator-MIT.txt',
    '/privacy.html', '/disclaimer.html', '/disclaimer.css', '/gate.js', '/gate.css', '/og-image.png', '/switcher-icons/check.svg'];
  const want404 = ['/rules/provider-rules.json', '/rules/extra-rules.json', '/rules/provider-test-corpus.json', '/tools/build-rules.mjs', '/tests/e2e.mjs', '/tests/serve.py', '/bump_assets.py', '/_config.yml', '/LICENSE', '/NOTICE',
    '/tools/vendor.mjs', '/tools/upstream.lock.json', '/third_party/publicsuffix/public_suffix_list.dat', '/third_party/bip39/english.txt', '/tests/fixtures/qr/link.png',
    '/third_party/bip39/spanish.txt', '/third_party/monero/english.h', '/third_party/slip39/wordlist.txt',
    '/third_party/unicode/confusables.txt', '/rules/brands.json', '/rules/brands-verified.json', '/tools/brands.mjs', '/tests/fixtures/real-domains.txt', '/tests/png-pixels.mjs',
    '/third_party/qrcodegen/qrcodegen.ts', '/tests/qr-make.test.mjs',
    '/DISCLAIMER.md', '/README.md', '/CHANGELOG.md', '/fastlane/metadata/android/en-US/images/icon.png', '/android/tools/make_icons.py', '/tests/legal-pages.mjs',
    // The type checking's tooling (2026-10-16).
    '/package.json', '/package-lock.json', '/jsconfig.json', '/jsconfig.worker.json', '/types/page.d.ts', '/tools/typecheck-stamps.mjs'];
  const got = {};
  for (const path of [...want200, ...want404]) got[path] = await status(path);
  check('the page, its modules, styles and icon are published', want200.every((x) => got[x] === 200), Object.fromEntries(want200.map((x) => [x, got[x]])));
  check('rules/, tools/, tests/, the tooling and the repository-only files (DISCLAIMER.md, README.md, the store files) are not (404)', want404.every((x) => got[x] === 404), Object.fromEntries(want404.map((x) => [x, got[x]])));

  for (const f of flows) {
    if (ONLY.length && !ONLY.includes(f.name) && f.name !== SELF_TEST) continue;
    currentFlow = f.name;
    console.log(`\n# ${f.name} (${f.view.width}x${f.view.height})`);
    let p = null;
    try {
      p = await openPage(f.view, f.opts);
      await Promise.race([
        f.fn(p),
        sleep(180000).then(() => { throw new Error('flow took longer than 3 minutes'); }),
      ]);
    } catch (err) {
      check('flow ran to the end', false, String(err.stack || err).split('\n').slice(0, 4).join(' | '), 'harness');
      if (p) await p.shot('error', { full: true }).catch(() => {});
    } finally {
      if (p) await p.close();
    }
  }
} finally {
  currentFlow = 'whole run';
}

// ---------------------------------------------------------------------------------------
// Network, policy and error checks over the whole run

console.log('\n# network, policy and errors (all flows)');
await sleep(300);
for (const key of Object.keys(record)) record[key] = record[key].filter((r) => r.flow !== SELF_TEST);
// Stage 5: disclaimer.html, written by the shared build-disclaimers.py for every Labs app, names no
// icon, so a browser opening it asks for /favicon.ico, which the site does not have (404). That
// one request, of the browser's own, in the flows that open the disclaimer, is set aside here and
// counted on its own; the page itself never asks for it.
const LEGAL_FLOWS = /^(first-run-notice|legal-pages|legal-pages-phone)$/;
const isFavicon = (u) => { try { return new URL(u).pathname === '/favicon.ico'; } catch { return false; } };
const faviconProbes = record.requests.filter((r) => isFavicon(r.url));
check(`the only request for /favicon.ico is the browser's own, on the disclaimer page (${faviconProbes.length})`, faviconProbes.every((r) => LEGAL_FLOWS.test(r.flow) && r.method === 'GET'), faviconProbes.map((r) => `${r.flow}: ${r.type} ${r.url}`));
for (const key of ['requests', 'responses', 'failed']) record[key] = record[key].filter((r) => !(isFavicon(r.url || '') && LEGAL_FLOWS.test(r.flow)));
record.logs = record.logs.filter((l) => !(isFavicon(l.url || '') && LEGAL_FLOWS.test(l.flow)));
const web = record.requests.filter((r) => /^(https?|wss?):/.test(r.url));
const offsite = web.filter((r) => new URL(r.url).origin !== ORIGIN);
check('no request to any other origin, at any time', !offsite.length, offsite.map((r) => `${r.flow}: ${r.url}`));
const after = web.filter((r) => r.phase === 'after-load');
const afterBad = after.filter((r) => !published(r.url));
check(`after load, only the page's own published files are requested (${after.length} requests after load)`, !afterBad.length, afterBad.map((r) => `${r.flow}: ${r.type} ${r.url}`));
if (after.length) note('requests after load', [...new Set(after.map((r) => `${r.type} ${new URL(r.url).pathname}`))]);
// Stage 5: the zone's Speed Brain rules (served as on the live site) let the browser prefetch a
// same-origin page the moment a link to it is pressed. Pressing the footer's Privacy or Disclaimer,
// or a legal page's Back to CheckLink, prefetches that one page of the site itself, which is then
// opened; nothing else may ever be prefetched.
const OWN_PAGES = new Set(['/', '/privacy.html', '/disclaimer.html']);
const ownPagePrefetch = (r) => r.type === 'Prefetch' && /^(first-run-notice|legal-pages|legal-pages-phone)$/.test(r.flow) && new URL(r.url).origin === ORIGIN && OWN_PAGES.has(new URL(r.url).pathname) && !new URL(r.url).search;
const scripted = record.requests.filter((r) => ['Fetch', 'XHR', 'EventSource', 'WebSocket', 'Ping', 'Prefetch'].includes(r.type) && !ownPagePrefetch(r));
check('no fetch, XHR, beacon, socket or prefetch of anything, data: URLs included (a pressed link to the site\'s own privacy page, disclaimer or start page aside)', !scripted.length, scripted.map((r) => `${r.flow}: ${r.type} ${r.url.slice(0, 80)}`));
const ownPrefetches = record.requests.filter(ownPagePrefetch);
if (ownPrefetches.length) note('prefetched after a press on a link to them (Speed Brain)', [...new Set(ownPrefetches.map((r) => `${r.flow}: ${new URL(r.url).pathname}`))]);
// Stage 4b: Save picture is a download from a blob: address in the page's own memory; those, one for
// each press in the QR code flows, are the only non-web loads allowed.
const qrBlobs = record.requests.filter((r) => /^qr-code-/.test(r.flow) && r.url.startsWith(`blob:${ORIGIN}/`));
const nonWeb = record.requests.filter((r) => !/^(https?|wss?):/.test(r.url) && !qrBlobs.includes(r));
check('no data:, blob: or other non-web loads (Save picture\'s own downloads aside)', !nonWeb.length, nonWeb.map((r) => `${r.flow}: ${r.type} ${r.url.slice(0, 60)}`));
check(`Save picture's downloads: at most one blob: load for each of the ${qrSaves.length} presses, all in the QR code flows`, qrBlobs.length <= qrSaves.length, qrBlobs.map((r) => `${r.flow}: ${r.type} ${r.url.slice(0, 60)}`));
const loadSet = [...new Set(web.filter((r) => r.phase === 'loading').map((r) => new URL(r.url).pathname))].sort();
note('files a visitor loads', loadSet);
check('every file the page loads is one GitHub Pages publishes', web.every((r) => published(r.url)), web.filter((r) => !published(r.url)).map((r) => `${r.flow}: ${r.url}`));
check('the analysed links were never requested', !web.some((r) => ANALYSED.some((l) => r.url.startsWith(l) || r.url.includes(new URL(/^https?:\/\//i.test(l) ? l : `https://${l}`).hostname))), web.map((r) => r.url).filter((u) => !u.startsWith(ORIGIN)));
check('no new tab or window was opened (Go to is replaced by the stand-in)', !record.targets.length, record.targets);
const badStatus = record.responses.filter((r) => r.status >= 400);
check('no failed responses (404 and so on)', !badStatus.length, badStatus.map((r) => `${r.status} ${r.url}`));
check('no failed or blocked loads', !record.failed.length, record.failed);
const serverLines = existsSync(serveLog) ? readFileSync(serveLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const browserLines = serverLines.filter((l) => l.method === 'GET');
const serverBad = browserLines.filter((l) => (l.status >= 400 && !(l.path === '/favicon.ico' && l.status === 404 && faviconProbes.length)) || l.host.split(':')[0] !== HOST);
check(`the server saw only good requests for ${HOST} from the browser (${browserLines.length} requests)`, browserLines.length > 0 && !serverBad.length, serverBad);
// A vendored package sits in a folder named with its version (vendor/zxing-wasm-3.1.6/): a new
// version is a new address, and its files stay byte for byte as published, so they carry no stamp.
// (Stage 4b: the QR encoder is pinned by commit, so its folder is named with the commit.)
const unstamped = loadSet.filter((x) => /\.(js|css)$/.test(x) && !/^\/vendor\/[a-z0-9-]+-(?:\d+\.\d+\.\d+|[0-9a-f]{7,40})\//.test(x)).filter((x) => !web.some((r) => new URL(r.url).pathname === x && /[?&]v=/.test(r.url)));
check('every script and stylesheet is fetched with a ?v= cache stamp (bump_assets.py), or from a versioned vendor folder', !unstamped.length, unstamped);
check('the decoder worker started in every flow, and its own files were recorded', record.workers.length > 0 && web.some((r) => r.worker && /\/vendor\/zxing-wasm-3\.1\.6\/zxing_reader\.wasm\.js$/.test(new URL(r.url).pathname)), { workers: record.workers.length });

const cspIssues = record.issues.filter((i) => i.code === 'ContentSecurityPolicyIssue');
const cspLogs = record.logs.filter((l) => /Content Security Policy|Refused to/i.test(l.text));
check('zero policy (CSP) violations', !record.csp.length && !cspIssues.length && !cspLogs.length, { events: record.csp, issues: cspIssues.map((i) => i.details), logs: cspLogs.map((l) => l.text) });
check('zero uncaught exceptions', !record.exceptions.length, record.exceptions);
const consoleErrors = [...record.console.filter((c) => c.type === 'error' || c.type === 'assert'), ...record.logs.filter((l) => l.level === 'error')];
check('zero console errors', !consoleErrors.length, consoleErrors);
const consoleOther = record.console.filter((c) => c.type !== 'error');
if (consoleOther.length) note('console messages from the page', consoleOther.map((c) => `${c.flow}: ${c.type} ${c.text}`));
const warnings = [...new Set(record.logs.filter((l) => l.level === 'warning').map((l) => `${l.source}: ${l.text}`))];
if (warnings.length) note('browser warnings (not from the page code)', warnings);
const otherIssues = [...new Set(record.issues.filter((i) => i.code !== 'ContentSecurityPolicyIssue').map((i) => i.code))];
if (otherIssues.length) note('DevTools issues raised', otherIssues);

// ---------------------------------------------------------------------------------------
// Report

const shots = existsSync(SHOTS) ? readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort().map((f) => join(SHOTS, f)) : [];
const failures = results.filter((r) => !r.ok);
const report = {
  when: new Date().toISOString(),
  seconds: Math.round((Date.now() - t0) / 1000),
  url: PAGE_URL,
  chromium: spawnSync(CHROMIUM, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  passed: results.filter((r) => r.level === 'pass').length,
  failed: failures.length,
  results,
  network: { requests: record.requests, failed: record.failed, server: serverLines },
  console: record.console,
  logs: record.logs,
  exceptions: record.exceptions,
  csp: record.csp,
  issues: record.issues,
  screenshots: shots,
};
writeFileSync(join(OUT, 'e2e-report.json'), J(report, null, 2));

ws.close();
chrome.kill();
server.kill();
await sleep(500);
rmSync(PROFILE, { recursive: true, force: true });
if (!KEEP) rmSync(RUN, { recursive: true, force: true });

console.log(`\n${report.passed} passed, ${failures.length} failed in ${report.seconds} s. Report and screenshots in ${OUT}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  [${f.flow}] ${f.name}${f.detail !== undefined ? `\n      ${typeof f.detail === 'string' ? f.detail : J(f.detail)}` : ''}`);
}
process.exit(failures.length ? 1 : 0);
