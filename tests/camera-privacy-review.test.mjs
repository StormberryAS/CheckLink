// Stage 3 camera review, 11 October 2026: privacy and permissions of Scan with camera. The review
// checked that the camera is asked for only on a press, that it stops on every way out, that no
// frame is kept or sent (memory, the frame canvas, blobs), that every track ends so the camera's
// light goes off, that a refused or missing camera is handled, that the page policy and the
// deploy-time Permissions-Policy are written down correctly, and that nothing is requested.
//
// Same convention as tests/adversarial.test.mjs: a test marked { todo: 'Cn ...' } fails today and
// documents finding Cn; it is reported but does not fail the suite. When a finding is fixed, its
// test passes: then remove its todo marker so the suite guards the fix. Tests without a marker pass
// today and guard what the review found sound, where the other suites do not already check it
// (tests/camera.test.mjs, tests/e2e.mjs, tests/ui-smoke.mjs and tests/librewolf-smoke.mjs cover a
// code found, Stop camera, Escape inside the card, a hidden tab, typing, a picture, a refused or
// missing camera, made-up pixels, the zone's camera=() and every request).
//
// FIXED 11 October 2026 (stage 3 fixes), so C1 to C4 are ordinary tests now: the limit is a timer
// of its own from the moment the camera is given (startLimit in app.js); every block the decoder
// takes through its _malloc is cleared as it is freed (clearingModule in src/qr-decode.js), and
// the worker clears the frame handed to it; NOTICE and the spec say the host rule must sit below
// the zone's own Permissions-Policy rule; Escape works anywhere on the page while the camera is
// on, unless a dialog is open.
//
// Findings, most serious first:
//   C1  the two-minute limit starts only once the preview plays and the cameras are listed; a
//       camera whose live track delivers no frames (Chromium's play() then never settles) stays
//       on, light and all, with no limit, until the person presses Stop camera or leaves
//   C2  the decoder worker keeps the last camera frame in its WebAssembly memory, as a full
//       greyscale picture, after the camera stops (zxing-wasm frees its buffer without clearing
//       it, and the worker lives on to read pictures)
//   C3  NOTICE does not say where the host Permissions-Policy rule must sit: Cloudflare runs the
//       zone's response-header rules in order and a later Set wins, and the zone's own
//       Permissions-Policy rule (camera=(), all requests) is third of seven (the zone's rule list
//       as recorded on 1 August 2026), so a host rule placed before it, where the beer CSP
//       exception sits, is overwritten and the camera stays blocked (it fails closed)
//   C4  Escape stops the camera only while focus is inside the camera card
//
// The browser tests drive headless Chromium over the DevTools protocol, as
// tests/stage2-review.test.mjs does, with Chromium's fake camera (--use-fake-device-for-media-stream,
// its moving test pattern, no code in it) and the camera allowed for the page; the page is served
// by tests/serve.py with the host Content-Security-Policy and Permissions-Policy camera=(self).
// They are skipped when Chromium or python3 is missing (CHROMIUM=/path overrides).

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeFrame, decodePicture } from '../src/qr-decode.js';
import { prepareZXingModule } from '../vendor/zxing-wasm-3.1.4/es/reader/index.js';
import { frameWith } from './png-pixels.mjs';
import { CAMERA_STATE, TEXT, cameraStub } from './share-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;
const NO_BROWSER = !existsSync(CHROMIUM) ? `Chromium not found at ${CHROMIUM}` : !HAVE_PYTHON ? 'python3 not found' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The zone's Permissions-Policy as moon.stormberry.as and stormberry.as sent it on 11 October 2026
// (read with curl by this review). tests/serve.py and NOTICE are built from it.
const LIVE_ZONE_PERMISSIONS = 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=(), browsing-topics=(), join-ad-interest-group=(), run-ad-auction=(), private-state-token-redemption=(), private-state-token-issuance=(), attribution-reporting=()';

// The greyscale copy zxing-wasm makes of an RGBA frame before it hands it to the decoder
// (the formula in vendor/zxing-wasm-3.1.4/es/share.js).
function luminance({ data, width, height }) {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (306 * data[o] + 601 * data[o + 1] + 117 * data[o + 2] + 512) >> 10;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The DevTools-protocol harness: one Chromium with a fake camera, a fresh browser context per page

let browser = null;
let origin = null;
let server = null;

async function startBrowser() {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'checklink-camreview-'));
  const proc = spawn(CHROMIUM, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter', '--use-fake-device-for-media-stream',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'xdg'), CHROME_CONFIG_HOME: path.join(profile, 'xdg'), XDG_CACHE_HOME: path.join(profile, 'cache') } });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !existsSync(portFile); i++) await sleep(50);
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const close = async () => {
    try { ws.close(); } catch { /* closing */ }
    proc.kill('SIGKILL');
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { send, listeners, close };
}

async function startServer(...extra) {
  const srv = spawn('python3', [path.join(ROOT, 'tests', 'serve.py'), '--quiet', ...extra], { stdio: ['ignore', 'pipe', 'ignore'] });
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('serve.py did not start')), 15000);
    srv.stdout.on('data', (d) => {
      buf += d;
      const m = /READY (http:\/\/127\.0\.0\.1:\d+\/)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  return { url, srv };
}

// Opens CheckLink in a fresh browser context with the camera allowed for the page, after running
// `init` (page-world script, before the page's own) in every document of that page.
async function openPage(init = '', { at = origin } = {}) {
  const b = browser;
  const { browserContextId } = await b.send('Target.createBrowserContext', { disposeOnDetach: true });
  await b.send('Browser.grantPermissions', { permissions: ['videoCapture'], origin: at.slice(0, -1), browserContextId });
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId: s } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const requests = [];
  const listen = (m) => {
    if (m.sessionId === s && m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url);
  };
  b.listeners.push(listen);
  for (const domain of ['Page', 'Runtime', 'Network', 'DOM']) await b.send(`${domain}.enable`, {}, s);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, s);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: cameraStub() + init }, s);
  const evaluate = async (expression) => {
    const r = await b.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, s);
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`);
    return r.result.value;
  };
  const loaded = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await evaluate('document.readyState')) === 'complete') return;
      } catch { /* navigating */ }
      await sleep(100);
    }
  };
  await b.send('Page.navigate', { url: at }, s);
  await loaded();
  // The decoder worker starts while the page loads; give it time to say it is ready.
  await sleep(1200);
  // Stage 5: a first visit shows the first-run notice (gate.js), which takes Escape and keeps the
  // page inert until it is closed. These tests are about the camera, so it is closed first, as a
  // person would close it.
  await evaluate("(() => { const b = document.querySelector('.sb-gate-btn'); if (b) b.click(); return true; })()");
  for (let i = 0; i < 50 && (await evaluate("!!document.querySelector('.sb-gate-overlay')")); i++) await sleep(100);
  const camera = () => evaluate(CAMERA_STATE);
  const waitFor = async (expression, ms, what) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await evaluate(expression).catch(() => false)) return true;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const key = (k, code, keyCode) => b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }, s)
    .then(() => b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }, s));
  // Hides the page for real: another tab in the same browser context in front of it.
  const hide = async () => {
    const other = await b.send('Target.createTarget', { url: 'about:blank', browserContextId });
    await b.send('Target.activateTarget', { targetId: other.targetId });
    await sleep(300);
    return async () => {
      await b.send('Target.closeTarget', { targetId: other.targetId }).catch(() => {});
      await b.send('Target.activateTarget', { targetId });
      await sleep(200);
    };
  };
  const close = async () => {
    b.listeners.splice(b.listeners.indexOf(listen), 1);
    await b.send('Target.closeTarget', { targetId }).catch(() => {});
    await b.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  };
  return { evaluate, camera, waitFor, key, loaded, requests, hide, close, send: (m, p = {}) => b.send(m, p, s) };
}

const press = (id) => `document.getElementById(${JSON.stringify(id)}).click(), true`;
const ON = "document.getElementById('camera-card').dataset.state === 'on'";

// ---------------------------------------------------------------------------------------------
// C1. The time limit

describe('C1. the camera never stays on past its time limit', () => {
  before(async () => {
    if (NO_BROWSER) return;
    server = await startServer();
    origin = server.url;
    browser = await startBrowser();
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) server.srv.kill();
    browser = null;
    server = null;
  });

  // The page's clock runs 100 times faster (Date.now and performance.now), and so do its long
  // timers (30 seconds or more), so the two-minute limit comes after 1.2 seconds whichever way a
  // fix measures it. Short timers keep real time, so the decoder's own 10 and 20 second waits and
  // the four-a-second frame timer are not squeezed into false timeouts.
  const FAST = `(() => {
    const K = 100;
    const rp = performance.now.bind(performance);
    const t0 = rp();
    const d0 = Date.now();
    Date.now = () => Math.round(d0 + (rp() - t0) * K);
    performance.now = () => t0 + (rp() - t0) * K;
    const squeeze = (ms) => { const n = Math.max(0, Number(ms) || 0); return n >= 30000 ? n / K : n; };
    const st = window.setTimeout.bind(window);
    const si = window.setInterval.bind(window);
    window.setTimeout = (fn, ms, ...a) => st(fn, squeeze(ms), ...a);
    window.setInterval = (fn, ms, ...a) => si(fn, squeeze(ms), ...a);
  })();`;
  // A camera that is allowed and gives a live video track that never delivers a frame (a stalled
  // or frozen camera). It is stood in for by a canvas stream with nothing ever drawn on it; the
  // fake camera's own stream is ended at once and the page is given the empty one, which the
  // recorder (window.__cam) then watches. Chromium's play() never settles for such a track: the
  // preview stays at readyState 0 (seen by this review on 11 October 2026).
  const NO_PICTURE = `(() => {
    const g = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = async function (c) {
      const real = await g.call(this, c);
      real.getTracks().forEach((t) => t.stop());
      window.__cam.streams = window.__cam.streams.filter((x) => x !== real);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 48;
      const empty = canvas.captureStream(0);
      window.__cam.streams.push(empty);
      return empty;
    };
  })();`;

  test('a camera that gives no picture is still stopped by the time limit, and its light goes off', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(FAST + NO_PICTURE);
    try {
      await p.evaluate(press('cam-btn'));
      await p.waitFor('window.__cam.streams.length === 1 && !!document.getElementById(\'cam-video\').srcObject', 5000, 'the camera to be given');
      // 4 seconds here are 400 seconds on the page's clock: more than three times the limit.
      await sleep(4000);
      const c = await p.camera();
      assert.equal(c.live, 0, `the camera is still on after 400 seconds on the page's clock (card shown: ${c.card}, status: "${c.status}")`);
      assert.ok(!c.card, 'the camera card is gone');
    } finally {
      await p.close();
    }
  });

  test('guard: in that state Stop camera still ends the camera (the person can turn it off)', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(NO_PICTURE);
    try {
      await p.evaluate(press('cam-btn'));
      await p.waitFor('window.__cam.streams.length === 1 && !!document.getElementById(\'cam-video\').srcObject', 5000, 'the camera to be given');
      await sleep(500);
      let c = await p.camera();
      assert.ok(c.card && c.state === 'starting' && c.live === 1, `the stalled state (${JSON.stringify({ card: c.card, state: c.state, live: c.live })})`);
      await p.evaluate(press('cam-stop'));
      await sleep(200);
      c = await p.camera();
      assert.equal(c.live, 0);
      assert.ok(!c.card);
    } finally {
      await p.close();
    }
  });

  test('guard: with a camera that does give a picture, the same fast clock stops it at the limit with the plain message', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(FAST);
    try {
      await p.evaluate(press('cam-btn'));
      await p.waitFor('window.__cam.streams.length === 1', 5000, 'the camera to be given');
      await p.waitFor("document.getElementById('camera-card').hidden", 15000, 'the time limit');
      const c = await p.camera();
      assert.equal(c.live, 0);
      assert.match(c.picStatus, /^No code was found in two minutes, so CheckLink stopped the camera\./);
      assert.ok(c.picError);
    } finally {
      await p.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Asked for only on a press, and only where it can be used

describe('the camera is asked for only when Scan with camera is pressed, and only when it can be used', () => {
  let zoneCsp = null;
  before(async () => {
    if (NO_BROWSER) return;
    server = await startServer();
    origin = server.url;
    zoneCsp = await startServer('--zone-csp');
    browser = await startBrowser();
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) server.srv.kill();
    if (zoneCsp) zoneCsp.srv.kill();
    browser = null;
    server = null;
  });

  // Counts the ways a page can learn about the camera, or ask for it, without a press.
  const ASKS = `(() => {
    window.__asks = { query: 0 };
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      const q = Permissions.prototype.query;
      Permissions.prototype.query = function (d) { if (d && /camera|video/i.test(String(d.name))) window.__asks.query += 1; return q.call(this, d); };
    }
  })();`;

  test('typing, pasting and choosing a picture never ask for the camera, list cameras or query its permission; only the press does', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(ASKS);
    try {
      await p.send('Runtime.evaluate', { expression: "document.getElementById('link-input').focus()" });
      await p.send('Input.insertText', { text: 'https://example.com/a?utm_source=x&id=1' });
      await sleep(600);
      const { root } = await p.send('DOM.getDocument', {});
      const { nodeId } = await p.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#pic-input' });
      await p.send('DOM.setFileInputFiles', { nodeId, files: [path.join(ROOT, 'tests', 'fixtures', 'qr', 'link.png')] });
      await p.waitFor("!document.getElementById('picture-card').hidden", 10000, 'the picture to be read');
      let c = await p.camera();
      let q = await p.evaluate('window.__asks.query');
      assert.deepEqual({ calls: c.calls, enumerations: c.enumerations, query: q }, { calls: 0, enumerations: 0, query: 0 }, 'nothing about the camera before the press');
      await p.evaluate(press('cam-btn'));
      await p.waitFor(ON, 10000, 'the camera to be on');
      c = await p.camera();
      q = await p.evaluate('window.__asks.query');
      assert.deepEqual({ calls: c.calls, enumerations: c.enumerations, query: q }, { calls: 1, enumerations: 1, query: 0 }, 'one request on the press, cameras listed once after it');
      await p.evaluate(press('cam-stop'));
    } finally {
      await p.close();
    }
  });

  test('where the picture reader cannot start (the zone policy, no WebAssembly), Scan with camera says so and never asks for the camera', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(ASKS, { at: zoneCsp.url });
    try {
      await p.evaluate(press('cam-btn'));
      await p.waitFor("document.getElementById('pic-status').textContent !== ''", 15000, 'a message');
      const c = await p.camera();
      assert.equal(c.calls, 0, 'the camera was not asked for');
      assert.ok(!c.card && c.picError, 'no camera card; the message is an error');
      assert.equal(c.picStatus, TEXT.picNoReader);
    } finally {
      await p.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// C2. Memory: no frame is kept

describe('C2. no camera frame is kept, in the page or in the decoder', () => {
  test('after a frame is read, no copy of it is left in the decoder’s WebAssembly memory', async () => {
    const W = 1280;
    const H = 720;
    // A noisy frame with no code, standing in for the room the camera saw.
    const f = frameWith(null, { width: W, height: H, seed: 4242 });
    const r = await decodeFrame(f);
    assert.equal(r.codes.length, 0);
    // The same module the decoder prepared (zxing-wasm hands back the one it made).
    const mod = await prepareZXingModule({ fireImmediately: true });
    const heap = Buffer.from(mod.HEAPU8.buffer, mod.HEAPU8.byteOffset, mod.HEAPU8.byteLength);
    const lum = luminance(f);
    let left = 0;
    for (let y = 0; y < H; y += 8) if (heap.indexOf(Buffer.from(lum.buffer, y * W, W)) >= 0) left += 1;
    assert.equal(left, 0, `${left} of ${H / 8} sampled rows of the frame are still in the decoder's memory`);
  });

  test('frames of other sizes, and pictures read after them, leave no copy either (the allocator does not always hand back the place it freed, so the block is cleared as it is freed)', async () => {
    const mod = await prepareZXingModule({ fireImmediately: true });
    const heap = () => Buffer.from(mod.HEAPU8.buffer, mod.HEAPU8.byteOffset, mod.HEAPU8.byteLength);
    for (const [W, H] of [[640, 480], [720, 1280], [1280, 960]]) {
      const f = frameWith(null, { width: W, height: H, seed: W + H });
      await decodeFrame(f);
      const lum = luminance(f);
      const hp = heap();
      let left = 0;
      for (let y = 0; y < H; y += 16) if (hp.indexOf(Buffer.from(lum.buffer, y * W, W)) >= 0) left += 1;
      assert.equal(left, 0, `${W} by ${H}: ${left} sampled rows left`);
    }
    // Seen on 11 October 2026: after the frames above, taking a block of a picture's size again
    // landed elsewhere and left link.png and link.jpg readable in full.
    for (const file of ['link.png', 'link.jpg', 'link-photo.jpg']) {
      const bytes = new Uint8Array(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'qr', file)));
      const r = await decodePicture(bytes, {});
      assert.ok(r.codes.length >= 1, `${file} was read`);
      const hp = heap();
      let left = 0;
      for (let o = 64; o + 64 < bytes.length; o += Math.max(64, Math.floor(bytes.length / 50))) if (hp.indexOf(Buffer.from(bytes.buffer, o, 64)) >= 0) left += 1;
      assert.equal(left, 0, `${file}: ${left} slices of the file left in the decoder's memory`);
    }
  });

  test('guard: the needle search works (a row of the frame is found in a buffer that holds it)', () => {
    const f = frameWith(null, { width: 64, height: 8, seed: 1 });
    const lum = luminance(f);
    const hay = Buffer.concat([Buffer.alloc(100), Buffer.from(lum), Buffer.alloc(100)]);
    assert.ok(hay.indexOf(Buffer.from(lum.buffer, 3 * 64, 64)) >= 0);
  });

  describe('in the browser', () => {
    before(async () => {
      if (NO_BROWSER) return;
      server = await startServer();
      origin = server.url;
      browser = await startBrowser();
    });
    after(async () => {
      if (browser) await browser.close();
      if (server) server.srv.kill();
      browser = null;
      server = null;
    });

    // Records what a scan hands over and makes: every frame posted to the decoder worker (its
    // buffer's size before and after the post: 0 after means it was handed over, not copied),
    // every canvas the page creates, and any way a frame could leave as a file or a stream.
    const WATCH = `(() => {
      const log = window.__watch = { frames: [], canvases: [], blobs: 0, dataUrls: 0, objectUrls: 0, captures: 0, pip: 0, imageCaptures: 0 };
      const pm = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, transfer) {
        const frame = !!msg && msg.type === 'frame';
        const before = frame && msg.buffer ? msg.buffer.byteLength : null;
        const r = pm.call(this, msg, transfer);
        if (frame) log.frames.push({ before, after: msg.buffer ? msg.buffer.byteLength : null, width: msg.width, height: msg.height });
        return r;
      };
      const ce = Document.prototype.createElement;
      Document.prototype.createElement = function (name, ...a) {
        const el = ce.call(this, name, ...a);
        if (String(name).toLowerCase() === 'canvas') log.canvases.push(el);
        return el;
      };
      const count = (obj, name, key) => {
        if (!obj || typeof obj[name] !== 'function') return;
        const real = obj[name];
        obj[name] = function (...a) { log[key] += 1; return real.apply(this, a); };
      };
      count(HTMLCanvasElement.prototype, 'toBlob', 'blobs');
      count(HTMLCanvasElement.prototype, 'toDataURL', 'dataUrls');
      count(HTMLCanvasElement.prototype, 'captureStream', 'captures');
      count(HTMLMediaElement.prototype, 'captureStream', 'captures');
      count(window.OffscreenCanvas && OffscreenCanvas.prototype, 'convertToBlob', 'blobs');
      count(URL, 'createObjectURL', 'objectUrls');
      count(HTMLVideoElement.prototype, 'requestPictureInPicture', 'pip');
      if (typeof window.ImageCapture === 'function') {
        const IC = window.ImageCapture;
        window.ImageCapture = function (...a) { log.imageCaptures += 1; return new IC(...a); };
      }
    })();`;

    test('a scan hands each frame to the decoder without keeping a copy, draws it on a canvas that never enters the page and is emptied at the end, and makes no file, stream, recording or request', { skip: NO_BROWSER, timeout: 60000 }, async () => {
      const p = await openPage(WATCH);
      try {
        const before = p.requests.length;
        await p.evaluate(press('cam-btn'));
        await p.waitFor(ON, 10000, 'the camera to be on');
        await p.waitFor('window.__watch.frames.length >= 4', 10000, 'four frames');
        await p.evaluate(press('cam-stop'));
        await sleep(300);
        const w = await p.evaluate(`(() => { const l = window.__watch; return { frames: l.frames, canvases: l.canvases.map((c) => ({ inPage: c.isConnected, width: c.width, height: c.height })),
          blobs: l.blobs, dataUrls: l.dataUrls, objectUrls: l.objectUrls, captures: l.captures, pip: l.pip, imageCaptures: l.imageCaptures }; })()`);
        const c = await p.camera();
        assert.ok(w.frames.length >= 4, 'frames were read');
        for (const f of w.frames) {
          assert.ok(f.before > 0 && f.before === f.width * f.height * 4, `a whole RGBA frame was sent (${JSON.stringify(f)})`);
          assert.equal(f.after, 0, 'the frame was handed over (transferred), so the page kept no copy');
          assert.ok(Math.max(f.width, f.height) <= 1280, 'at most 1280 pixels on the longer side');
        }
        assert.equal(w.canvases.length, 1, 'one frame canvas, made once and reused');
        assert.deepEqual(w.canvases[0], { inPage: false, width: 0, height: 0 }, 'the frame canvas never entered the page and was emptied when the camera stopped');
        assert.deepEqual({ blobs: w.blobs, dataUrls: w.dataUrls, objectUrls: w.objectUrls, captures: w.captures, pip: w.pip, imageCaptures: w.imageCaptures }, { blobs: 0, dataUrls: 0, objectUrls: 0, captures: 0, pip: 0, imageCaptures: 0 });
        assert.equal(c.recorders, 0, 'no recorder');
        assert.equal(c.live, 0, 'every track ended: the camera light goes off');
        assert.ok(!c.srcObject, 'the preview holds nothing');
        assert.deepEqual(p.requests.slice(before), [], 'no request while scanning');
      } finally {
        await p.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The ways out: stopping before the camera is even given, leaving the page, Escape

describe('the camera stops on every way out', () => {
  before(async () => {
    if (NO_BROWSER) return;
    server = await startServer();
    origin = server.url;
    browser = await startBrowser();
  });
  after(async () => {
    if (browser) await browser.close();
    if (server) server.srv.kill();
    browser = null;
    server = null;
  });

  // The browser takes 1.5 seconds to give the camera, as while its permission prompt is open.
  const SLOW_PROMPT = `(() => {
    const g = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function (c) { return new Promise((r) => setTimeout(r, 1500)).then(() => g.call(this, c)); };
  })();`;

  test('Stop camera pressed while the browser is still asking: the stream that arrives late is ended at once', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(SLOW_PROMPT);
    try {
      await p.evaluate(press('cam-btn'));
      await sleep(300);
      await p.evaluate(press('cam-stop'));
      await p.waitFor('window.__cam.streams.length === 1', 5000, 'the late stream');
      await sleep(300);
      const c = await p.camera();
      assert.equal(c.live, 0, 'the late stream has no live track');
      assert.ok(!c.card && !c.srcObject);
      assert.equal(c.picStatus, 'Camera stopped.');
    } finally {
      await p.close();
    }
  });

  test('the page hidden while the browser is still asking: the late stream is ended too', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(SLOW_PROMPT);
    try {
      await p.evaluate(press('cam-btn'));
      await sleep(300);
      // Another tab in front, for real, then back.
      const back = await p.hide();
      const hidden = await p.evaluate('document.visibilityState');
      await p.waitFor('window.__cam.streams.length === 1', 5000, 'the late stream');
      await sleep(300);
      await back();
      const c = await p.camera();
      assert.equal(hidden, 'hidden', 'the page was hidden');
      assert.equal(c.live, 0, 'the late stream has no live track');
      assert.ok(!c.card);
    } finally {
      await p.close();
    }
  });

  // Counts, across the page's documents in this tab, the live tracks left when the page goes.
  const LEAVE = `(() => {
    if (location.pathname !== '/') return;
    window.addEventListener('load', () => {
      // Added after the page's own listener, so it sees what the page left behind.
      window.addEventListener('pagehide', (ev) => {
        const live = (window.__cam ? window.__cam.streams : []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length;
        sessionStorage.setItem('camreview', JSON.stringify({ live, persisted: ev.persisted }));
      });
      window.addEventListener('pageshow', (ev) => { window.__restored = ev.persisted; });
    });
  })();`;

  test('leaving the page (a link or Back) ends the camera before the page goes, and coming back with Back leaves it off', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage(LEAVE);
    try {
      await p.evaluate(press('cam-btn'));
      await p.waitFor(ON, 10000, 'the camera to be on');
      await p.evaluate("location.href = '/favicon.svg', true");
      await p.waitFor("location.pathname === '/favicon.svg' && document.readyState === 'complete'", 10000, 'the next page');
      const left = JSON.parse(await p.evaluate("sessionStorage.getItem('camreview')"));
      assert.equal(left.live, 0, 'no live track when the page went');
      await p.evaluate('history.back(), true');
      await p.waitFor("location.pathname === '/' && document.readyState === 'complete' && !!document.getElementById('cam-btn')", 10000, 'CheckLink again');
      await sleep(500);
      const c = await p.camera();
      assert.equal(c.live, 0, 'still off after Back');
      assert.ok(!c.card, 'no camera card after Back');
    } finally {
      await p.close();
    }
  });

  test('Escape stops the camera after focus has left the camera card (a click elsewhere on the page)', { skip: NO_BROWSER, timeout: 60000 }, async () => {
    const p = await openPage();
    try {
      await p.evaluate(press('cam-btn'));
      await p.waitFor(ON, 10000, 'the camera to be on');
      await p.evaluate('document.activeElement && document.activeElement.blur(), true');
      await p.key('Escape', 'Escape', 27);
      await sleep(300);
      const c = await p.camera();
      assert.equal(c.live, 0, `Escape left the camera on (focus on ${c.focus})`);
      assert.ok(!c.card);
    } finally {
      await p.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// C3. The deploy-time headers, as written down

describe('C3. the deploy-time camera header is written down so that it works', () => {
  const notice = text('NOTICE');
  const serve = text('tests/serve.py');
  const section = (() => {
    const start = notice.indexOf('Permissions-Policy (from stage 3, for Scan with camera)');
    const next = notice.indexOf('\n-------------------', start);
    return notice.slice(start, next < 0 ? undefined : next);
  })();

  test('guard: the zone policy that tests/serve.py and NOTICE start from is the one the zone sends today', () => {
    const zone = /ZONE_PERMISSIONS = \(([\s\S]*?)\n\)/.exec(serve)[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).join('');
    assert.equal(zone, LIVE_ZONE_PERMISSIONS);
    assert.ok(section.includes(`    ${LIVE_ZONE_PERMISSIONS.replace('camera=()', 'camera=(self)')}\n`), 'NOTICE gives the zone value with camera=(self) only');
  });

  test('guard: the policy keeps the microphone off and lets no other site use the camera', () => {
    const host = LIVE_ZONE_PERMISSIONS.replace('camera=()', 'camera=(self)');
    assert.match(host, /(^|, )microphone=\(\)/);
    assert.match(host, /(^|, )camera=\(self\)(,|$)/);
    assert.ok(!/camera=\*|camera=\(\*\)|camera=\(self [^)]/.test(host));
  });

  test('NOTICE says the host Permissions-Policy rule must run after the zone’s own Permissions-Policy rule', () => {
    assert.match(section, /\b(after|below)\b[^.]*\bzone'?s?\b[^.]*Permissions-Policy rule|later rules? (can )?overwrite|runs? last|last in the list/i, 'the Permissions-Policy section of NOTICE does not say where the rule must sit');
  });
});
