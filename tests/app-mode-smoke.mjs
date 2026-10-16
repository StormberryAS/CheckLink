// Browser smoke test of CheckLink in APP MODE: the page as the Android app loads it (stage 4),
// driven over the Chrome DevTools Protocol with nothing but Node 24 built-ins.
//
//   node tests/app-mode-smoke.mjs [--chromium /usr/bin/chromium] [--out DIR] [--port 8951] [--cdp 9351] [--keep]
//
// What it serves is what the APK holds: index.html with the one line the build injects
// (<script src="android-bridge.js"></script> before the first script, as WebAssets.inject does
// in android/app/build.gradle.kts), android/web-overlay/android-bridge.js beside it, and every
// response with the headers the app's asset handler sends (ResponseHeaders.kt: the full
// Content-Security-Policy, and no Permissions-Policy at all).
//
// The app's side of the window.CLBridge channel is a stand-in (BRIDGE_STUB below), injected before
// the page loads, as the WebView injects the real one. It records every message the page posts
// and answers as MainActivity does. The real android-bridge.js runs on top of it, so this tests
// the bridge script and app.js's app-mode hooks together:
//   * window.CLAndroid exists, frozen; the website-only Zapstore section stays hidden, even when
//     its hidden attribute is taken off or a new website-only part is added;
//   * Copy, Share clean link and Go to go through the bridge (copy, share, open), never through
//     navigator.clipboard, navigator.share or window.open; a sign-in link and a code's secret are
//     copied as sensitive; Go to needs a real press; a refused open says so;
//   * shared text and a shared picture (chunked) reach the page's normal flow, and Share clean link
//     becomes the main button; typing makes Copy the main button again;
//   * the camera: secure(camera, on) reaches the app BEFORE the camera is asked for, and
//     secure(camera, off) when it stops; the app's camera-stop turns it off; a refusal says
//     where to allow the camera in Android, and after "Don't ask again" offers Android's settings;
//   * a secret: secure(secret, on) before Show reveals it (the value stays hidden until the app
//     answers), secure(secret, off) after Hide;
//   * the protection is lifted only after the page without the camera card or the secret has
//     been drawn (two animation frames later), and is kept when it is needed again by then;
//   * FAIL CLOSED: when the app refuses or never answers secure(), a secret stays hidden and the
//     camera is never asked for; the page says why, and tells the app to drop the request;
//   * a WebView too old for the bridge (android-bridge.js loaded, no CLBridge): window.CLAndroid is
//     an empty frozen object, Copy takes the website's way, and Show and the camera are refused;
//   * the same page without the bridge (the website) shows none of the app's parts.
// Stage 4b adds:
//   * a QR code of the clean link in the app: the code is shown; Save picture and Share picture go
//     through window.CLAndroid.saveImage and shareImage only when the app offers them, never
//     through a download or navigator.share; no Copy picture; a WebView too old for the bridge
//     shows the code only;
//   * the real bridge script's side of them (the Android side of stage 4b): the picture goes to
//     the app in chunks the app pulls (out-begin, out-pull, out-chunk), in order, and put back
//     together they are exactly the PNG the page made; out-done, out-error, an impossible pull and
//     silence each end it; a second tap never sends it twice; anything but a PNG Blob of at most
//     262,144 bytes is refused before anything is posted; secure('link', ...) reaches the app and
//     an unknown reason does not;
//   * with a stand-in window.CLAndroid that has the new calls (mode 'stub', the website's files
//     with no bridge script): Save and Share hand the app exactly the PNG the page made, as a Blob;
//     the page claims no save itself (the app confirms it once the file is written) and says so
//     plainly when the app refuses; SEC-10 asks secure('link', on) while a sign-in link or a link
//     with personal details is on screen and lifts it after, and the link stays on screen whatever
//     the app answers; PD-1 copies such a link as sensitive;
//   * the approved wording (Q4): the camera stopped "because you left CheckLink", and the secret and
//     camera lines that point to Android System WebView.
// Stage 5 (12 October 2026): the first-run notice in the app: a share that arrives while it is open
// waits behind it and reaches the page once it is closed; its one flag; and the privacy page and
// the disclaimer opened from the footer inside the app, under the app's own policy header, with no
// request leaving. Every other page here closes the notice first, as a person would.
// Since 12 October 2026 (SC-9): in the app Share always goes through the app, so a sign-in link's
// held-share line shows, and under it, as under the PD-1 line, the QR line is the short one; a
// short link keeps its own reason in full; a WebView too old for the bridge, which cannot share,
// shows no held-share line and the full QR line.
// Nothing leaves the machine: the browser can reach only this server.
//
// The file name does not end in .test.mjs, so `node --test tests/` does not run it.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyse } from '../src/link-core.js';
import { QR_STATE, TEXT, cameraStub, expectedQr, shareStub } from './share-stub.mjs';
import { QR_REFUSED } from '../src/qr-make.js';
import { FLAG_VALUE, GATE, GATE_STATE, LEGAL_STATE, copyProblems } from './legal-pages.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CHROMIUM = opt('--chromium', process.env.CHROMIUM || '/usr/bin/chromium');
const OUT = resolve(opt('--out', process.env.CL_APP_OUT || join(tmpdir(), 'checklink-app-mode')));
const PORT = Number(opt('--port', process.env.CL_APP_PORT || '8951'));
const CDP_PORT = Number(opt('--cdp', process.env.CL_APP_CDP || '9351'));
const KEEP = args.includes('--keep');
const J = JSON.stringify;

// The app's asset handler sends this on every response (android/app/.../ResponseHeaders.kt).
const APP_CSP = readFileSync(join(ROOT, 'android/app/src/main/kotlin/no/stormberry/checklink/ResponseHeaders.kt'), 'utf8')
  .match(/CONTENT_SECURITY_POLICY =\s*([\s\S]*?)\n\n/)[1]
  .match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).join('');
const BRIDGE_TAG = '<script src="android-bridge.js"></script>';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };

if (!existsSync(CHROMIUM)) {
  console.error(`Chromium not found at ${CHROMIUM}. Pass --chromium PATH.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(OUT, 'profile-'));

// WebAssets.inject: the bridge tag on its own line, before the first <script, same indent.
function inject(source) {
  const first = source.indexOf('<script');
  const lineStart = source.lastIndexOf('\n', first) + 1;
  const indent = source.slice(lineStart, first);
  return `${source.slice(0, lineStart)}${indent}${BRIDGE_TAG}\n${source.slice(lineStart)}`;
}

// ---- Static server: /app/... is the APK's copy, /web/... the website, both from the same files.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = decodeURIComponent(url.pathname);
  const app = path.startsWith('/app/');
  const web = path.startsWith('/web/');
  if (!app && !web) {
    // The carousel's /switcher-icons/... are referenced from the site root.
    path = `/web${path}`;
  }
  const rel = path.replace(/^\/(app|web)\//, '/');
  // ResponseHeaders.ALL, all four.
  const headers = { 'Content-Security-Policy': APP_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  let body = null;
  let type = null;
  if (app && rel === '/android-bridge.js') {
    body = readFileSync(join(ROOT, 'android', 'web-overlay', 'android-bridge.js'));
    type = TYPES['.js'];
  } else {
    const file = normalize(join(ROOT, rel.endsWith('/') ? `${rel}index.html` : rel));
    if (req.method === 'GET' && file.startsWith(ROOT) && !file.includes('/android/') && !file.includes('/tests/') && existsSync(file) && statSync(file).isFile()) {
      body = readFileSync(file);
      type = TYPES[extname(file)] || 'application/octet-stream';
      if (app && file === join(ROOT, 'index.html')) body = Buffer.from(inject(body.toString('utf8')));
    }
  }
  if (!body) {
    res.writeHead(404, headers);
    res.end('');
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': type });
  res.end(body);
});
await new Promise((r, j) => { server.once('error', j); server.listen(PORT, '127.0.0.1', r); });
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---- The app's side of CLBridge, as MainActivity answers it.
// window.__cl: { mode ('ok' | 'fail'), secureMode ('ok' | 'fail' | 'silent': the answer to secure),
// blocked (camera-state), holdSecure, posted: [message], order: [what happened, in order],
// offs: [{ reason, framesAfter, cardHidden, secretsShown }] for every secure off, send(msg),
// release(), sharePicture(batch, mime, chunks), outMode, out }. frame counts animation frames;
// lastChange[reason] is the frame at which the camera card was last hidden or a secret last hidden.
// Stage 4b: out is every picture the page hands over ({ id, action, mime, size, chunks, indexes,
// data }); outMode says how the stand-in app answers: 'ok' (pull every chunk, then out-done),
// 'error' (pull every chunk, then out-error), 'silent' (never answer out-begin) or 'badpull' (ask
// for a chunk that does not exist).
const BRIDGE_STUB = `(() => {
  const cl = window.__cl = { mode: 'ok', secureMode: 'ok', blocked: false, holdSecure: false, held: [], posted: [], order: [], offs: [], frame: 0, lastChange: {} };
  const tick = () => { cl.frame += 1; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target.id === 'camera-card' && r.target.hidden) cl.lastChange.camera = cl.frame;
        if (r.target.classList && r.target.classList.contains('cl-secret') && r.target.dataset.shown !== 'true') cl.lastChange.secret = cl.frame;
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-shown'] });
  });
  let listen = null;
  const deliver = (msg) => setTimeout(() => { if (listen) listen({ data: JSON.stringify(msg) }); }, 0);
  cl.send = deliver;
  cl.release = () => { const h = cl.held; cl.held = []; h.forEach(deliver); };
  cl.sharePicture = (batch, mime, chunks) => {
    cl.onPull = (m) => {
      if (m.batch !== batch || m.file !== 0) return;
      deliver({ t: 'in-chunk', batch, file: 0, index: m.index, data: chunks[m.index], last: m.index === chunks.length - 1 });
    };
    deliver({ t: 'incoming', batch, files: [{ mime, size: -1 }] });
  };
  cl.outMode = 'ok';
  cl.out = [];
  const ASK = ['copy', 'share', 'open', 'settings', 'secure', 'camera-state'];
  window.CLBridge = {
    postMessage(text) {
      const m = JSON.parse(text);
      cl.posted.push(m);
      cl.order.push('bridge:' + m.t + (m.t === 'secure' ? ':' + m.reason + ':' + m.on : ''));
      if (m.t === 'secure' && m.on === false) {
        const card = document.getElementById('camera-card');
        cl.offs.push({ reason: m.reason, framesAfter: cl.frame - (cl.lastChange[m.reason] ?? cl.frame), cardHidden: !!card && card.hidden,
          secretsShown: document.querySelectorAll('.cl-secret[data-shown="true"]').length });
      }
      if (ASK.includes(m.t) && typeof m.id === 'number') {
        const reply = { t: 'reply', id: m.id, ok: cl.mode === 'ok' };
        if (m.t === 'camera-state') reply.blocked = cl.blocked;
        if (m.t === 'secure') reply.ok = cl.secureMode === 'ok';
        if (m.t === 'secure' && m.on && cl.secureMode === 'silent') { /* never answers */ }
        else if (m.t === 'secure' && cl.holdSecure) cl.held.push(reply);
        else deliver(reply);
      }
      if (m.t === 'in-pull' && cl.onPull) cl.onPull(m);
      if (m.t === 'out-begin') {
        cl.out.push({ id: m.id, action: m.action, mime: m.mime, size: m.size, chunks: m.chunks, indexes: [], data: [] });
        if (cl.outMode === 'badpull') deliver({ t: 'out-pull', id: m.id, index: m.chunks });
        else if (cl.outMode !== 'silent') deliver({ t: 'out-pull', id: m.id, index: 0 });
      }
      if (m.t === 'out-chunk') {
        const job = cl.out.find((j) => j.id === m.id);
        if (job) {
          job.indexes.push(m.index);
          job.data.push(m.data);
          if (m.index + 1 < job.chunks) deliver({ t: 'out-pull', id: m.id, index: m.index + 1 });
          else if (cl.outMode === 'error') deliver({ t: 'out-error', id: m.id });
          else deliver({ t: 'out-done', id: m.id, ok: true });
        }
      }
    },
    addEventListener(type, fn) { if (type === 'message') listen = fn; },
  };
  const md = window.MediaDevices && MediaDevices.prototype;
  if (md && md.getUserMedia) {
    const gum = md.getUserMedia;
    md.getUserMedia = function (c) { cl.order.push('getUserMedia'); return gum.call(this, c); };
  }
})();`;

// ---- Stage 4b: a stand-in for window.CLAndroid with the calls the bridge contract adds
// (saveImage, shareImage, secure 'link'), for the page side of them before the app has them.
// window.__app: { mode ('ok' | 'fail': the answer to save and share), secureMode, calls: [{ t, ... }],
// secure: ['reason:on'] }. Each image call records whether it got a Blob, its type and its bytes.
const CLANDROID_STUB = `(() => {
  const st = window.__app = { mode: 'ok', secureMode: 'ok', calls: [], secure: [] };
  const b64 = async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const later = (v) => new Promise((r) => setTimeout(() => r(v), 0));
  const image = (t) => (blob) => {
    const rec = { t, blob: blob instanceof Blob, type: blob && blob.type, size: blob && blob.size, base64: null };
    st.calls.push(rec);
    return (blob instanceof Blob ? b64(blob).then((x) => { rec.base64 = x; }) : Promise.resolve()).then(() => st.mode === 'ok');
  };
  const api = {
    copyText: (text, sensitive) => { st.calls.push({ t: 'copy', text, sensitive }); return later(true); },
    shareText: (text) => { st.calls.push({ t: 'share', text }); return later(true); },
    open: (url) => { st.calls.push({ t: 'open', url }); return later(true); },
    openAppSettings: () => later(true),
    secure: (reason, on) => { st.secure.push(reason + ':' + on); return later(st.secureMode === 'ok'); },
    cameraBlocked: () => later(false),
    saveImage: image('save-image'),
    shareImage: image('share-image'),
  };
  Object.defineProperty(window, 'CLAndroid', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
})();`;

// ---- Chromium ---------------------------------------------------------------------------
const chrome = spawn(CHROMIUM, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--use-fake-device-for-media-stream', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, XDG_CONFIG_HOME: join(profile, 'xdg-config'), CHROME_CONFIG_HOME: join(profile, 'xdg-config'), XDG_CACHE_HOME: join(profile, 'xdg-cache') },
});
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  const t = setTimeout(() => rej(new Error('Chromium did not start')), 20000);
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
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  } else for (const fn of listeners) fn(m);
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Checks -----------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
}

// ---- One page ---------------------------------------------------------------------------
async function openPage({ mode = 'app', camera = 'grant', width = 412, height = 915, init = null, gate = 'close' } = {}) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const log = { errors: [], offsite: [], csp: [], blobs: [] };
  const sessions = new Set([sessionId]);
  const onMsg = (m) => {
    if (!sessions.has(m.sessionId)) return;
    if (m.method === 'Target.attachedToTarget') {
      sessions.add(m.params.sessionId);
      for (const d of ['Network.enable', 'Runtime.enable', 'Log.enable']) send(d, {}, m.params.sessionId).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId).catch(() => {});
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') log.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') log.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && /Content.Security.Policy|Refused to/i.test(m.params.entry.text)) log.csp.push(m.params.entry.text);
    if (m.method === 'Network.requestWillBeSent' && !m.params.request.url.startsWith(ORIGIN) && !m.params.request.url.startsWith('data:') && !m.params.request.url.startsWith('blob:')) log.offsite.push(m.params.request.url);
    if (m.method === 'Network.requestWillBeSent' && m.params.request.url.startsWith('blob:')) log.blobs.push(m.params.request.url);
  };
  listeners.add(onMsg);
  for (const d of ['Runtime.enable', 'Network.enable', 'Page.enable', 'DOM.enable', 'Log.enable']) await s(d);
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  if (camera === 'grant') await send('Browser.grantPermissions', { permissions: ['videoCapture'], origin: ORIGIN, browserContextId });
  else await send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: ORIGIN, browserContextId });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI),true);" });
  // The website's stand-ins record any use of navigator.clipboard, navigator.share (absent here,
  // as in Android's WebView) and window.open, so a test can prove the app mode never uses them.
  await s('Page.addScriptToEvaluateOnNewDocument', { source: shareStub({ share: false, clipboard: true, open: true }) });
  await s('Page.addScriptToEvaluateOnNewDocument', { source: cameraStub() });
  if (mode === 'app') await s('Page.addScriptToEvaluateOnNewDocument', { source: BRIDGE_STUB });
  // 'stub' (stage 4b): the website's files with a stand-in window.CLAndroid that has the new calls.
  if (mode === 'stub') await s('Page.addScriptToEvaluateOnNewDocument', { source: CLANDROID_STUB });
  // A script of the test's own, run before the page's (stage 4b fixes: a WebView whose workers fail).
  if (init) await s('Page.addScriptToEvaluateOnNewDocument', { source: init });
  // 'nobridge': the APK's page (the bridge script loaded) on a WebView with no CLBridge channel.
  await s('Page.navigate', { url: `${ORIGIN}/${mode === 'nobridge' ? 'app' : mode === 'stub' ? 'web' : mode}/index.html` });
  const ev = async (expression, { gesture = true } = {}) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await ev(expression, { gesture: false })) return true; } catch { /* page still loading */ }
      await sleep(50);
    }
    return false;
  };
  await waitFor("document.readyState === 'complete' && !!document.getElementById('rules-date') && !document.getElementById('rules-date').hidden", 20000);
  // The page scrolls smoothly (focusing the box, for example); a press sent while it still moves
  // would land somewhere else, so this waits until scrollY stops changing (as tests/ui-smoke.mjs).
  const settle = async () => {
    let last = await ev('scrollY', { gesture: false });
    for (let i = 0; i < 40; i++) {
      await sleep(60);
      const now = await ev('scrollY', { gesture: false });
      if (now === last) return;
      last = now;
    }
  };
  // A press in the element's centre with real mouse events, which give the page user activation.
  const click = async (selector) => {
    await settle();
    await ev(`document.querySelector(${J(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`, { gesture: false });
    await settle();
    const r = await ev(`(() => {
      const el = document.querySelector(${J(selector)});
      if (!el) return { err: 'not found' };
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return { err: 'not visible' };
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x, y, ok: !!hit && (hit === el || el.contains(hit)) };
    })()`, { gesture: false });
    if (r.err || !r.ok) throw new Error(`cannot press ${selector}: ${r.err || 'covered'}`);
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  // Types into the box the way a keyboard does (insertText, then the page's pause).
  const type = async (text) => {
    await ev("(() => { const t = document.getElementById('link-input'); t.focus(); t.select(); })()", { gesture: false });
    await s('Input.insertText', { text });
    await sleep(400);
  };
  const posted = () => ev('window.__cl ? window.__cl.posted : []', { gesture: false });
  // Stage 5: a first visit shows the first-run notice; it is closed with a real press, as a person
  // would close it, unless the test is about the notice (gate: 'keep').
  const gateShown = await ev("!!document.querySelector('.sb-gate-overlay')", { gesture: false });
  if (gate === 'close' && gateShown) {
    await click('.sb-gate-btn');
    if (!(await waitFor("!document.querySelector('.sb-gate-overlay') && !document.querySelector('main').inert", 5000))) throw new Error('the first-run notice did not close');
  }
  const close = async () => {
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  };
  return { s, ev, waitFor, click, type, posted, close, log, gateShown };
}

const vis = (sel) => `(() => { const el = document.querySelector(${J(sel)}); return !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0; })()`;
const clean = (link) => analyse(link).clean(new Set(analyse(link).defaultRemoved));
const LINK = 'https://example.com/a?utm_source=news&id=7';
const RESET = 'https://example.com/reset-password?token=abc123def456&utm_source=email';
const fixture = (name) => readFileSync(join(ROOT, 'tests', 'fixtures', 'qr', name));
const chunked = (buf, size) => {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size).toString('base64'));
  return out;
};

try {
  // ======================================================================== the website
  {
    const p = await openPage({ mode: 'web' });
    const st = await p.ev(`({
      api: typeof window.CLAndroid, zap: document.getElementById('android-app').hidden,
      settings: document.getElementById('cam-settings').hidden,
      goHelp: document.getElementById('go-help').textContent,
      bridgeTag: [...document.scripts].some((s) => /android-bridge/.test(s.src)),
    })`);
    check('website: no window.CLAndroid, no bridge script, the Zapstore section shown (since the 0.0.1 release), no settings button, Go to help unchanged', st.api === 'undefined' && !st.bridgeTag && !st.zap && st.settings && st.goHelp === 'Opens in a new tab, in this browser.', st);
    await p.type(LINK);
    await p.click('#copy-btn');
    const page = await p.ev('({ clips: window.__clip.calls, share: !document.getElementById("share-btn").hidden })');
    check('website: Copy still uses the browser clipboard, and Share stays hidden where the browser cannot share', page.clips.length === 1 && page.clips[0].text === clean(LINK) && !page.share, page);
    await p.click('#go-btn');
    const opened = await p.ev('window.__opened');
    check('website: Go to still opens a new tab with window.open', opened.length === 1 && opened[0].url === clean(LINK) && opened[0].target === '_blank', opened);
    check('website: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }

  // ======================================================================== the app: basics
  {
    const p = await openPage({ mode: 'app' });
    const st = await p.ev(`(() => {
      const api = window.CLAndroid;
      const desc = Object.getOwnPropertyDescriptor(window, 'CLAndroid');
      return {
        type: typeof api, frozen: Object.isFrozen(api), writable: desc && desc.writable, configurable: desc && desc.configurable,
        keys: Object.keys(api).sort(), zap: document.getElementById('android-app').hidden,
        hello: window.__cl.posted.filter((m) => m.t === 'hello').length,
        goHelp: document.getElementById('go-help').textContent,
        share: !document.getElementById('share-btn').hidden,
      };
    })()`);
    check('app: window.CLAndroid exists, frozen and not replaceable, with exactly the eight calls (stage 4b adds saveImage and shareImage)', st.type === 'object' && st.frozen && st.writable === false && st.configurable === false && J(st.keys) === J(['cameraBlocked', 'copyText', 'open', 'openAppSettings', 'saveImage', 'secure', 'shareImage', 'shareText']), st);
    check('app: the page said hello once, and the Zapstore section is hidden', st.hello === 1 && st.zap, st);
    check('app: Go to says it opens the browser, outside CheckLink', st.goHelp === 'Opens in your browser, outside CheckLink.', st.goHelp);
    const hidden = await p.ev(`(async () => {
      const z = document.getElementById('android-app');
      z.removeAttribute('hidden');
      const extra = document.createElement('p');
      extra.setAttribute('data-web-only', '');
      extra.id = 'late-web-only';
      extra.textContent = 'Website only';
      document.querySelector('main').append(extra);
      await new Promise((r) => setTimeout(r, 50));
      return { zap: z.hidden, late: extra.hidden };
    })()`);
    check('app: a website-only part stays hidden when its hidden attribute is taken off (stage 5), and one added later is hidden at once', hidden.zap && hidden.late, hidden);

    await p.type(LINK);
    check('app: Share clean link is shown although the WebView has no navigator.share', await p.ev(vis('#share-btn')));
    const order0 = await p.ev("[...document.querySelectorAll('#clean-card .cl-actions button:not([hidden])')].map((b) => b.id + ':' + (b.classList.contains('btn-primary') ? 'primary' : 'secondary'))");
    check('app: a typed link keeps Copy first and primary (Make a QR code last, stage 4b)', J(order0) === J(['copy-btn:primary', 'share-btn:secondary', 'qr-btn:secondary']), order0);
    await p.click('#copy-btn');
    let msgs = await p.posted();
    let copy = msgs.filter((m) => m.t === 'copy');
    check('app: Copy goes through the bridge, with the clean link, not sensitive', copy.length === 1 && copy[0].text === clean(LINK) && copy[0].sensitive === false && typeof copy[0].id === 'number', copy);
    let page = await p.ev("({ clips: window.__clip.calls.length, status: document.getElementById('action-status').textContent })");
    check('app: the browser clipboard is never touched, and the page says Copied', page.clips === 0 && page.status === 'Copied the clean link.', page);
    await p.click('#share-btn');
    msgs = await p.posted();
    const share = msgs.filter((m) => m.t === 'share');
    check('app: Share clean link goes through the bridge with the clean link as text', share.length === 1 && share[0].text === clean(LINK), share);
    await p.click('#go-btn');
    msgs = await p.posted();
    const open = msgs.filter((m) => m.t === 'open');
    page = await p.ev("({ opened: window.__opened.length, status: document.getElementById('action-status').textContent })");
    check('app: Go to goes through the bridge as open with the clean link, never window.open', open.length === 1 && open[0].url === new URL(clean(LINK)).href && page.opened === 0, { open, page });
    check('app: and says it is opening the browser', page.status === 'Opening example.com in your browser.', page.status);

    // The press above gave the page user activation, which Chromium keeps for about five seconds.
    await sleep(5600);
    const noPress = await p.ev("window.CLAndroid.open('https://example.com/').then((ok) => ({ ok, active: navigator.userActivation.isActive, opens: window.__cl.posted.filter((m) => m.t === 'open').length }))", { gesture: false });
    check('app: open() without a recent real press is refused in the page and never reaches the app', noPress.ok === false && !noPress.active && noPress.opens === 1, noPress);
    const badCalls = await p.ev(`Promise.all([
      window.CLAndroid.open('javascript:alert(1)'), window.CLAndroid.open('intent://x#Intent;end'), window.CLAndroid.open(42),
      window.CLAndroid.copyText(''), window.CLAndroid.copyText({}), window.CLAndroid.shareText('x'.repeat(65537)),
      window.CLAndroid.secure('microphone', true),
    ]).then((r) => ({ r, sent: window.__cl.posted.length }))`);
    check('app: calls with a wrong scheme, empty or oversized text or an unknown reason resolve false and send nothing', badCalls.r.every((x) => x === false) && badCalls.sent === msgs.length, badCalls);

    await p.ev("window.__cl.mode = 'fail'", { gesture: false });
    await p.click('#go-btn');
    page = await p.ev("document.getElementById('action-status').textContent");
    check('app: a Go to the app refuses says so plainly', page === 'The link could not be opened. Copy it instead.', page);
    await p.click('#copy-btn');
    page = await p.ev("document.getElementById('action-status').textContent");
    check('app: a Copy the app refuses says so plainly', page === 'The link could not be copied. Select the clean link above and copy it yourself.', page);
    await p.ev("window.__cl.mode = 'ok'", { gesture: false });

    await p.type(RESET);
    await p.click('#copy-btn');
    msgs = await p.posted();
    copy = msgs.filter((m) => m.t === 'copy').at(-1);
    check('app: a sign-in or reset link is copied as sensitive, and Share is not offered for it', copy.text === clean(RESET) && copy.sensitive === true && !(await p.ev(vis('#share-btn'))), { copy, box: await p.ev("document.getElementById('link-input').value"), focus: await p.ev('document.activeElement && document.activeElement.id') });
    check('app: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }

  // ======================================================================== the app: notice, privacy, disclaimer
  {
    const p = await openPage({ mode: 'app', gate: 'keep' });
    let g = await p.ev(GATE_STATE, { gesture: false });
    check('app: a first start shows the first-run notice, word for word, with the page inert behind it', p.gateShown && g.open && g.tier === 'dismissible' && g.title === GATE.title && J(g.paragraphs) === J(GATE.paragraphs) && g.ack === GATE.ack && g.button === GATE.button && g.othersInert, g);
    const TEXT_IN = `Shared while the notice is open: ${LINK}`;
    await p.ev(`window.__cl.send({ t: 'shared-text', text: ${J(TEXT_IN)} })`, { gesture: false });
    await sleep(1500);
    let st = await p.ev("({ box: document.getElementById('link-input').value, result: document.getElementById('result').hidden, done: window.__cl.posted.filter((m) => m.t === 'text-done').length })", { gesture: false });
    check('app: a link shared in while the notice is open waits behind it: nothing reaches the page yet', st.box === '' && st.result && st.done === 0, st);
    await p.click('.sb-gate-btn');
    const arrived = await p.waitFor("!document.querySelector('.sb-gate-overlay') && !document.getElementById('result').hidden", 5000);
    st = await p.ev("({ box: document.getElementById('link-input').value, clean: document.getElementById('clean-link').textContent, done: window.__cl.posted.filter((m) => m.t === 'text-done').length })", { gesture: false });
    check('app: once the notice is closed, the shared link reaches the page and is checked, once', arrived && st.box === TEXT_IN && st.clean === clean(LINK) && st.done === 1, st);
    g = await p.ev(GATE_STATE, { gesture: false });
    check('app: closing the notice stores its one flag in the WebView\'s local storage, and nothing else', !g.open && FLAG_VALUE.test(g.stored) && J(g.keys) === J([GATE.key]), { stored: g.stored, keys: g.keys });
    const arriveAt = async (path) => {
      for (let i = 0; i < 100; i++) {
        try { if (await p.ev(`location.pathname === ${J(path)} && document.readyState === 'complete'`, { gesture: false })) return true; } catch { /* the page is being replaced */ }
        await sleep(100);
      }
      return false;
    };
    const foot = await p.ev("[...document.querySelectorAll('.site-footer a[href=\"privacy.html\"], .site-footer a[href=\"disclaimer.html\"]')].map((a) => a.getAttribute('href') + ':' + a.getAttribute('target'))", { gesture: false });
    check('app: the footer links Privacy and Disclaimer, both opening inside the app', J(foot) === J(['privacy.html:null', 'disclaimer.html:null']), foot);
    await p.click('.site-footer a[href="privacy.html"]');
    let ok = await arriveAt('/app/privacy.html');
    await sleep(300);
    let page = await p.ev(LEGAL_STATE, { gesture: false });
    check('app: Privacy opens the bundled privacy.html inside the app, under the app\'s policy header, with its style sheets, no scripts and no notice', ok && page.h1 === 'Privacy' && page.sheetsLoaded === 2 && page.scripts === 0 && page.styleElements === 0 && page.styleAttrs === 0 && !page.gate, page);
    const pw = copyProblems(page.text);
    check('app: the privacy page reads as plain British English, never "safe" or "verified"', !pw.length, pw);
    await p.click('.site-footer a[href="disclaimer.html"]');
    ok = await arriveAt('/app/disclaimer.html');
    await sleep(300);
    page = await p.ev(LEGAL_STATE, { gesture: false });
    check('app: Disclaimer opens the bundled disclaimer.html inside the app, styled by disclaimer.css (the policy refuses style blocks)', ok && page.h1 === 'Disclaimer and terms of use' && page.mainMaxWidth === '736px' && page.h2Transform === 'uppercase' && page.styleElements === 0 && page.scripts === 0, page);
    await p.click('a.back');
    ok = await arriveAt('/app/');
    await p.waitFor("!!document.getElementById('rules-date') && !document.getElementById('rules-date').hidden", 10000);
    st = await p.ev("({ gate: !!document.querySelector('.sb-gate-overlay'), api: typeof window.CLAndroid, box: !!document.getElementById('link-input') })", { gesture: false });
    check('app: Back to CheckLink returns to the app\'s page, bridge and all, without the notice', ok && st.box && st.api === 'object' && !st.gate, st);
    check('app: notice and legal pages: no request left the server, no policy violation, no error', !p.log.offsite.length && !p.log.csp.length && !p.log.errors.length, { offsite: p.log.offsite, csp: p.log.csp, errors: p.log.errors });
    await p.close();
  }

  // ======================================================================== the app: share in
  {
    const p = await openPage({ mode: 'app' });
    const TEXT_IN = `Look at this: ${LINK}`;
    await p.ev(`window.__cl.send({ t: 'shared-text', text: ${J(TEXT_IN)} })`, { gesture: false });
    await p.waitFor("!document.getElementById('result').hidden && document.getElementById('clean-link').textContent.length > 0");
    let st = await p.ev(`({
      box: document.getElementById('link-input').value, clean: document.getElementById('clean-link').textContent,
      order: [...document.querySelectorAll('#clean-card .cl-actions button:not([hidden])')].map((b) => b.id + ':' + (b.classList.contains('btn-primary') ? 'primary' : 'secondary')),
      done: window.__cl.posted.filter((m) => m.t === 'text-done').length,
      focus: document.activeElement && document.activeElement.id,
    })`);
    check('app: shared text lands in the box and is analysed at once, without opening the keyboard', st.box === TEXT_IN && st.clean === clean(LINK) && st.focus !== 'link-input', st);
    check('app: arriving by Share makes Share clean link the main button, first in the row (spec decision 6)', J(st.order) === J(['share-btn:primary', 'copy-btn:secondary', 'qr-btn:secondary']), st.order);
    check('app: the page tells the app it has the text (text-done), once', st.done === 1, st.done);
    await p.type('https://example.org/?fbclid=abc');
    st = await p.ev("[...document.querySelectorAll('#clean-card .cl-actions button:not([hidden])')].map((b) => b.id + ':' + (b.classList.contains('btn-primary') ? 'primary' : 'secondary'))");
    check('app: typing a link of your own makes Copy the main button again', J(st) === J(['copy-btn:primary', 'share-btn:secondary', 'qr-btn:secondary']), st);

    const png = fixture('link.png');
    const chunks = chunked(png, 512);
    await p.ev(`window.__cl.sharePicture(7, 'image/png', ${J(chunks)})`, { gesture: false });
    const got = await p.waitFor("!document.getElementById('picture-card').hidden && !document.getElementById('result').hidden", 20000);
    st = await p.ev(`({
      title: document.getElementById('picture-title').textContent, summary: document.getElementById('picture-summary').textContent,
      box: document.getElementById('link-input').value,
      pulls: window.__cl.posted.filter((m) => m.t === 'in-pull' && m.batch === 7).map((m) => m.index),
      done: window.__cl.posted.filter((m) => m.t === 'in-done' && m.batch === 7).length,
      order: [...document.querySelectorAll('#clean-card .cl-actions button:not([hidden])')].map((b) => b.id + ':' + (b.classList.contains('btn-primary') ? 'primary' : 'secondary')),
    })`);
    check(`app: a shared picture is pulled chunk by chunk (${chunks.length} chunks, in order) and handed over as done`, got && J(st.pulls) === J(chunks.map((_, i) => i)) && st.done === 1, st);
    check('app: the shared picture goes through the normal picture flow: the code is read and its link checked', st.title === 'From your picture' && /^https?:\/\//.test(st.box) && !!analyse(st.box).found, st);
    check('app: a shared picture also makes Share clean link the main button', J(st.order) === J(['share-btn:primary', 'copy-btn:secondary', 'qr-btn:secondary']), st.order);
    await p.ev("window.__cl.send({ t: 'incoming', batch: 8, files: [{ mime: 'image/heic', size: 10 }] })", { gesture: false });
    await sleep(400);
    const heic = await p.ev("window.__cl.posted.filter((m) => m.batch === 8).length");
    check('app: an announced HEIC picture is not even pulled', heic === 0, heic);
    check('app: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }

  // ======================================================================== the app: camera
  {
    const p = await openPage({ mode: 'app', camera: 'grant' });
    check('app: Scan with camera is offered', await p.ev(vis('#cam-btn')));
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on'", 15000);
    let order = await p.ev('window.__cl.order');
    const on = order.indexOf('bridge:secure:camera:true');
    const gum = order.indexOf('getUserMedia');
    check('app: the screen is protected (secure camera on) BEFORE the camera is asked for', on >= 0 && gum > on, order);
    await p.click('#cam-stop');
    await p.waitFor("window.__cl.order.at(-1) === 'bridge:secure:camera:false'", 5000);
    order = await p.ev('window.__cl.order');
    check('app: Stop camera lifts the protection (secure camera off)', order.at(-1) === 'bridge:secure:camera:false', order.slice(-3));
    let off = await p.ev('window.__cl.offs.at(-1)');
    check('app: the protection is lifted only after the page without the camera card has been drawn (two frames later)', off && off.reason === 'camera' && off.cardHidden && off.framesAfter >= 2, off);

    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on'", 15000);
    await p.ev("window.__cl.send({ t: 'camera-stop' })", { gesture: false });
    await p.waitFor("document.getElementById('camera-card').hidden");
    await p.waitFor("window.__cl.order.at(-1) === 'bridge:secure:camera:false'", 5000);
    const st = await p.ev(`({ card: document.getElementById('camera-card').hidden, status: document.getElementById('pic-status').textContent,
      live: window.__cam.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length, last: window.__cl.order.at(-1) })`);
    check("app: the app's camera-stop turns the camera off, every track ends, and the protection is lifted", st.card && st.live === 0 && st.last === 'bridge:secure:camera:false' && st.status === 'The camera stopped because you left CheckLink. Press Scan with camera to start it again.', st);

    // Stopped and started again within two frames: the protection is kept, never dropped in between.
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on'", 15000);
    const quick = await p.ev(`(async () => {
      const before = window.__cl.order.length;
      document.getElementById('cam-stop').click();
      document.getElementById('cam-btn').click();
      await new Promise((r) => setTimeout(r, 400));
      return { after: window.__cl.order.slice(before).filter((x) => x.startsWith('bridge:secure')), state: document.getElementById('camera-card').dataset.state };
    })()`);
    check('app: a camera stopped and started again at once keeps the protection (no off in between)', !quick.after.includes('bridge:secure:camera:false') && quick.state !== undefined, quick);
    await p.click('#cam-stop');

    // Android asks while the card shows; the starting line says Android, not the browser.
    await p.ev('window.__cl.holdSecure = true', { gesture: false });
    await p.click('#cam-btn');
    await sleep(200);
    const starting = await p.ev("document.getElementById('cam-status').textContent");
    check('app: while the camera starts, the line says Android may ask (not the browser)', starting === 'Starting the camera. Android may ask whether CheckLink can use it.', starting);
    await p.ev('window.__cl.holdSecure = false; window.__cl.release()', { gesture: false });
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on'", 15000);
    await p.click('#cam-stop');
    check('app: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }
  {
    const p = await openPage({ mode: 'app', camera: 'deny' });
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('pic-status').textContent.length > 0", 10000);
    await sleep(300);
    let st = await p.ev(`({ status: document.getElementById('pic-status').textContent, settings: !document.getElementById('cam-settings').hidden,
      states: window.__cl.posted.filter((m) => m.t === 'camera-state').length, last: window.__cl.order.filter((x) => x.startsWith('bridge:secure')).at(-1) })`);
    check("app: a refused camera points to Android's settings for CheckLink, not the browser's, and lifts the protection", st.status === "CheckLink was not allowed to use the camera, so it cannot scan. Press Scan with camera to be asked again, or choose a picture of the code instead. The camera can also be allowed for CheckLink in Android's settings." && !st.settings && st.states === 1 && st.last === 'bridge:secure:camera:false', st);
    await p.ev('window.__cl.blocked = true', { gesture: false });
    await p.click('#cam-btn');
    await p.waitFor("!document.getElementById('cam-settings').hidden", 10000);
    st = await p.ev("({ status: document.getElementById('pic-status').textContent, settings: !document.getElementById('cam-settings').hidden, label: document.getElementById('cam-settings').textContent })");
    check("app: after \"Don't ask again\" the message says so and offers Android's settings for CheckLink", st.settings && st.label === "Open Android's settings for CheckLink" && st.status.startsWith('Android does not let CheckLink use the camera and will not ask again.'), st);
    await p.click('#cam-settings');
    const msgs = await p.posted();
    check('app: the settings button asks the app to open its settings page (settings)', msgs.filter((m) => m.t === 'settings').length === 1, msgs.map((m) => m.t));
    await p.type(LINK);
    await p.click('#clear-btn');
    st = await p.ev("({ settings: document.getElementById('cam-settings').hidden, status: document.getElementById('pic-status').textContent })");
    check('app: the settings button goes with its message (Clear takes both away)', st.settings && st.status === '', st);
    await p.close();
  }

  // ======================================================================== the app: secrets
  {
    const p = await openPage({ mode: 'app' });
    const id = (await p.s('DOM.getDocument', {})).root.nodeId;
    const { nodeId } = await p.s('DOM.querySelector', { nodeId: id, selector: '#pic-input' });
    await p.s('DOM.setFileInputFiles', { nodeId, files: [join(ROOT, 'tests', 'fixtures', 'qr', 'wifi.png')] });
    await p.waitFor("!document.getElementById('picture-card').hidden && !!document.querySelector('#code-0 .cl-show')", 20000);
    await p.ev('window.__cl.holdSecure = true', { gesture: false });
    await p.click('#code-0 .cl-show');
    await sleep(300);
    let st = await p.ev(`({ shown: document.querySelector('#code-0 .cl-secret').dataset.shown, text: document.querySelector('#code-0 .cl-secret').textContent,
      secure: window.__cl.order.filter((x) => x.startsWith('bridge:secure')) })`);
    check('app: Show asks the app to protect the screen first (secure secret on), and the password stays hidden until the app answers', st.shown === 'false' && !st.text.includes('correct horse') && J(st.secure) === J(['bridge:secure:secret:true']), st);
    await p.ev('window.__cl.release()', { gesture: false });
    await p.waitFor("document.querySelector('#code-0 .cl-secret').dataset.shown === 'true'");
    st = await p.ev("({ text: document.querySelector('#code-0 .cl-secret').textContent })");
    check('app: once the app has protected the screen, Show reveals the password', st.text === 'correct horse battery', st);
    await p.ev('window.__cl.holdSecure = false', { gesture: false });
    await p.click('#code-0 .cl-show');
    await p.waitFor("window.__cl.order.filter((x) => x.startsWith('bridge:secure')).at(-1) === 'bridge:secure:secret:false'", 5000);
    st = await p.ev("({ shown: document.querySelector('#code-0 .cl-secret').dataset.shown, last: window.__cl.order.filter((x) => x.startsWith('bridge:secure')).at(-1), off: window.__cl.offs.at(-1) })");
    check('app: Hide hides it and lifts the protection (secure secret off)', st.shown === 'false' && st.last === 'bridge:secure:secret:false', st);
    check('app: the protection is lifted only after the page without the secret has been drawn (two frames later)', st.off && st.off.reason === 'secret' && st.off.secretsShown === 0 && st.off.framesAfter >= 2, st.off);
    const pwField = await p.ev("[...document.querySelectorAll('#code-0 button[data-use=\"copy\"]')].find((b) => b.textContent === 'Copy password').dataset.field", { gesture: false });
    await p.click(`#code-0 button[data-use="copy"][data-field="${pwField}"]`);
    await sleep(200);
    const copies = (await p.posted()).filter((m) => m.t === 'copy');
    check('app: Copy password goes through the bridge as sensitive, so Android hides it in the clipboard preview', copies.length === 1 && copies[0].text === 'correct horse battery' && copies[0].sensitive === true, copies);
    await p.click('#code-0 .cl-show');
    await p.waitFor("document.querySelector('#code-0 .cl-secret').dataset.shown === 'true'");
    await p.click('#clear-btn');
    await p.waitFor("window.__cl.order.filter((x) => x.startsWith('bridge:secure')).at(-1) === 'bridge:secure:secret:false'", 5000);
    st = await p.ev("window.__cl.order.filter((x) => x.startsWith('bridge:secure')).at(-1)");
    check('app: Clear with a secret on show lifts the protection too', st === 'bridge:secure:secret:false', st);
    check('app: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }

  // ======================================================================== fail closed
  // The wording Marcos approved on 11 October 2026 (Q4).
  const SECRET_UNPROTECTED = 'The secret is not shown, because CheckLink could not keep it out of screenshots. Close CheckLink and open it again. If that does not help, update Android System WebView.';
  const CAM_UNPROTECTED = 'The camera did not start, because CheckLink could not keep the camera picture out of screenshots. Close CheckLink and open it again. If that does not help, update Android System WebView, or choose a picture of the code instead.';
  const loadWifi = async (p) => {
    const id = (await p.s('DOM.getDocument', {})).root.nodeId;
    const { nodeId } = await p.s('DOM.querySelector', { nodeId: id, selector: '#pic-input' });
    await p.s('DOM.setFileInputFiles', { nodeId, files: [join(ROOT, 'tests', 'fixtures', 'qr', 'wifi.png')] });
    await p.waitFor("!document.getElementById('picture-card').hidden && !!document.querySelector('#code-0 .cl-show')", 20000);
  };
  const secretState = (p) => p.ev(`({ shown: document.querySelector('#code-0 .cl-secret').dataset.shown, text: document.querySelector('#code-0 .cl-secret').textContent,
    status: document.getElementById('code-0-status') && document.getElementById('code-0-status').textContent,
    secure: window.__cl ? window.__cl.order.filter((x) => x.startsWith('bridge:secure')) : [] })`);
  const camState = (p) => p.ev(`({ card: document.getElementById('camera-card').hidden, status: document.getElementById('pic-status').textContent,
    gum: window.__cl ? window.__cl.order.includes('getUserMedia') : (window.__cam ? window.__cam.streams.length > 0 : null),
    live: window.__cam ? window.__cam.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length : 0,
    secure: window.__cl ? window.__cl.order.filter((x) => x.startsWith('bridge:secure')) : [] })`);
  {
    // The app answers false.
    const p = await openPage({ mode: 'app' });
    await loadWifi(p);
    await p.ev("window.__cl.secureMode = 'fail'", { gesture: false });
    await p.click('#code-0 .cl-show');
    await p.waitFor(`document.getElementById('code-0-status').textContent === ${J(SECRET_UNPROTECTED)}`, 5000);
    let st = await secretState(p);
    check('app, fail closed: when the app refuses to protect the screen, Show keeps the secret hidden and says why', st.shown === 'false' && !st.text.includes('correct horse') && st.status === SECRET_UNPROTECTED, st);
    await p.ev("window.__cl.secureMode = 'ok'", { gesture: false });
    await p.click('#code-0 .cl-show');
    await p.waitFor("document.querySelector('#code-0 .cl-secret').dataset.shown === 'true'", 5000);
    st = await secretState(p);
    check('app, fail closed: once the app confirms, the next Show asks it again and reveals the secret', st.text === 'correct horse battery', st);
    // Scan with camera replaces the picture on show, so the camera comes last.
    await p.ev("window.__cl.secureMode = 'fail'", { gesture: false });
    await p.click('#cam-btn');
    await p.waitFor(`document.getElementById('pic-status').textContent === ${J(CAM_UNPROTECTED)}`, 5000);
    const cs = await camState(p);
    check('app, fail closed: when the app refuses to protect the screen, the camera is never asked for, and the page says why', cs.card && !cs.gum && cs.live === 0 && cs.status === CAM_UNPROTECTED, cs);
    check('app, fail closed: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }
  {
    // The app never answers: the bridge gives up after its 8-second limit.
    const p = await openPage({ mode: 'app' });
    await loadWifi(p);
    await p.ev("window.__cl.secureMode = 'silent'", { gesture: false });
    await p.click('#code-0 .cl-show');
    await sleep(1000);
    let st = await secretState(p);
    check('app, fail closed: while the app has not answered, the secret stays hidden', st.shown === 'false' && !st.text.includes('correct horse'), st);
    await p.waitFor(`document.getElementById('code-0-status').textContent === ${J(SECRET_UNPROTECTED)}`, 12000);
    await sleep(300);
    st = await secretState(p);
    check('app, fail closed: with no answer at all, the secret is still hidden after the time limit, and the page says why', st.shown === 'false' && !st.text.includes('correct horse') && st.status === SECRET_UNPROTECTED, st);
    // Scan with camera replaces the picture on show, so the camera comes last.
    await p.click('#cam-btn');
    await sleep(1000);
    let cs = await camState(p);
    check('app, fail closed: while the app has not answered, the camera is not asked for', !cs.gum && cs.live === 0, cs);
    await p.waitFor(`document.getElementById('pic-status').textContent === ${J(CAM_UNPROTECTED)}`, 12000);
    await sleep(300);
    cs = await camState(p);
    check('app, fail closed: with no answer at all, the camera is never asked for, and the page says why', cs.card && !cs.gum && cs.live === 0 && cs.status === CAM_UNPROTECTED, cs);
    const ask = (r) => cs.secure.indexOf(`bridge:secure:${r}:true`);
    check('app, fail closed: the page then tells the app to drop each request it never confirmed', ask('secret') >= 0 && cs.secure.indexOf('bridge:secure:secret:false') > ask('secret') && ask('camera') >= 0 && cs.secure.indexOf('bridge:secure:camera:false') > ask('camera'), cs.secure);
    await p.close();
  }
  {
    // The APK's page on a WebView too old for the message channel.
    const p = await openPage({ mode: 'nobridge' });
    const st0 = await p.ev(`(() => {
      const api = window.CLAndroid;
      const desc = Object.getOwnPropertyDescriptor(window, 'CLAndroid');
      return { type: typeof api, keys: api ? Object.keys(api) : null, frozen: !!api && Object.isFrozen(api), writable: desc && desc.writable,
        zap: document.getElementById('android-app').hidden, goHelp: document.getElementById('go-help').textContent };
    })()`);
    check('app without the bridge: window.CLAndroid is an empty frozen object, and the Zapstore section is hidden', st0.type === 'object' && J(st0.keys) === '[]' && st0.frozen && st0.writable === false && st0.zap, st0);
    check('app without the bridge: Go to still says it opens the browser, outside CheckLink', st0.goHelp === 'Opens in your browser, outside CheckLink.', st0.goHelp);
    await p.type(LINK);
    await p.click('#copy-btn');
    const copied = await p.ev("({ clips: window.__clip.calls, status: document.getElementById('action-status').textContent })");
    check("app without the bridge: Copy takes the website's way", copied.clips.length === 1 && copied.clips[0].text === clean(LINK) && copied.status === 'Copied the clean link.', copied);
    await loadWifi(p);
    await p.click('#code-0 .cl-show');
    await p.waitFor(`document.getElementById('code-0-status').textContent === ${J(SECRET_UNPROTECTED)}`, 5000);
    const st = await secretState(p);
    check('app without the bridge: Show keeps the secret hidden and says why', st.shown === 'false' && !st.text.includes('correct horse') && st.status === SECRET_UNPROTECTED, st);
    await p.click('#cam-btn');
    await p.waitFor(`document.getElementById('pic-status').textContent === ${J(CAM_UNPROTECTED)}`, 5000);
    const cs = await camState(p);
    check('app without the bridge: the camera is never asked for, and the page says why', cs.card && cs.gum === false && cs.live === 0 && cs.status === CAM_UNPROTECTED, cs);
    check('app without the bridge: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }
  // ======================================================================== stage 4b: QR code
  const EMAIL = 'https://shop.example.com/confirm?email=someone%40example.no&utm_source=x';
  const SHORT_EMAIL = 'https://bit.ly/3xYz?email=someone%40example.no&utm_source=x';
  const openQr = async (p, link) => {
    await p.type(link);
    await p.waitFor(`document.getElementById('clean-link').textContent === ${J(clean(link))}`, 5000);
    await p.click('#qr-btn');
    return p.waitFor(vis('#qr-card'), 15000);
  };
  // SC-9: the lines about a link that gets no code, once its clean link is on screen.
  const refusedLines = async (p, link) => {
    await p.type(link);
    await p.waitFor(`document.getElementById('clean-link').textContent === ${J(clean(link))}`, 5000);
    return p.ev(QR_STATE);
  };
  {
    // The app as stage 4 built it: the real bridge script on the stand-in channel.
    const p = await openPage({ mode: 'app' });
    const shown = await openQr(p, LINK);
    const q = await p.ev(QR_STATE);
    const has = await p.ev("({ save: typeof window.CLAndroid.saveImage === 'function', share: typeof window.CLAndroid.shareImage === 'function' })");
    const want = expectedQr(LINK);
    check('app: Make a QR code shows the code, read back first, exactly the one Node makes', shown && q.svg && q.svg.d === want.path && q.text === want.text && q.svg.label === TEXT.qrLabel(want.host), { shown, text: q.text });
    check('app: Save and Share picture are offered exactly when the bridge has saveImage and shareImage; never Copy picture; otherwise the code is for scanning from the screen', q.save === has.save && q.share === has.share && !q.copy && (q.screen === TEXT.qrScreen) === (!has.save && !has.share), { q: { save: q.save, share: q.share, copy: q.copy, screen: q.screen }, has });
    check('app: no download link and no blob: address were made for the code', p.log.blobs.length === 0 && (await p.ev("document.querySelectorAll('a[download]').length")) === 0, p.log.blobs);
    // SC-9 (Marcos, 2026-10-12), with the real bridge script: Share goes through the app, so the
    // held-share line shows for a reset link, and the QR line under it is the short one.
    let r = await refusedLines(p, RESET);
    check('app (SC-9): a reset link: the held-share line, and the short QR line under it', !r.button && !r.card && r.shareNote === TEXT.shareHeldAuth && !r.warn && r.note === TEXT.qrSameReason, { shareNote: r.shareNote, warn: r.warn, note: r.note });
    r = await refusedLines(p, EMAIL);
    check('app (SC-9): a link with an email address: the PD-1 line, and the short QR line under it', !r.button && r.warn === TEXT.personalEmail && !r.shareNote && r.note === TEXT.qrSameReason, { warn: r.warn, note: r.note });
    r = await refusedLines(p, SHORT_EMAIL);
    check('app (SC-9): a short link with an email address: the PD-1 line, and the QR line in full for its own reason', !r.button && r.warn === TEXT.personalEmail && r.note === QR_REFUSED.short, { warn: r.warn, note: r.note });
    r = await refusedLines(p, LINK);
    check('app (SC-9): an ordinary link again: no line above, no QR line, the button back', r.button && !r.warn && !r.shareNote && r.note === null, { button: r.button, warn: r.warn, shareNote: r.shareNote, note: r.note });
    check('app (QR code): no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }
  {
    // Stage 4b, the Android side: the real bridge script hands the picture to the stand-in app in
    // the chunks it pulls, as MainActivity takes it (OutgoingRequest.parseImageBegin, ChunkAssembler).
    const p = await openPage({ mode: 'app' });
    const want = expectedQr(LINK);
    const shown = await openQr(p, LINK);
    const jobs = () => p.ev('window.__cl.out', { gesture: false });
    const bytesOf = (j) => Buffer.concat(j.data.map((d) => Buffer.from(d, 'base64')));
    const summary = (list) => list.map((j) => ({ action: j.action, mime: j.mime, size: j.size, chunks: j.chunks, indexes: j.indexes }));
    const allPulled = (n) => `window.__cl.out.length === ${n} && window.__cl.out[${n - 1}].indexes.length === window.__cl.out[${n - 1}].chunks`;
    let q = await p.ev(QR_STATE);
    check('app bridge: the code is shown with Save picture and Share picture through the app, and no Copy picture', shown && q.save && q.share && !q.copy && !q.screen, { save: q.save, share: q.share, copy: q.copy, screen: q.screen });
    await p.click('#qr-save');
    await p.waitFor(allPulled(1), 5000);
    await sleep(200);
    let out = await jobs();
    const begins = (await p.posted()).filter((m) => m.t === 'out-begin');
    check('app bridge: Save picture sends one out-begin (save-image, image/png, the size and chunk count of the PNG; no name, address or path)',
      out.length === 1 && out[0].action === 'save-image' && out[0].mime === 'image/png' && out[0].size === want.png.length && out[0].chunks === Math.ceil(want.png.length / 65536)
      && begins.length === 1 && J(Object.keys(begins[0]).sort()) === J(['action', 'chunks', 'id', 'mime', 'size', 't']), summary(out));
    check('app bridge: the chunks come in order, and put together they are exactly the PNG the page made', J(out[0].indexes) === J([...Array(out[0].chunks).keys()]) && bytesOf(out[0]).equals(want.png), { indexes: out[0].indexes, bytes: bytesOf(out[0]).length, want: want.png.length });
    q = await p.ev(QR_STATE);
    check('app bridge: after out-done the page says nothing itself (the app confirms once the file is written)', q.qrStatus === '' && p.log.blobs.length === 0, { status: q.qrStatus, blobs: p.log.blobs });
    await p.click('#qr-share');
    await p.waitFor(allPulled(2), 5000);
    await sleep(200);
    out = await jobs();
    q = await p.ev(QR_STATE);
    check('app bridge: Share picture sends the same PNG for share-image, and never touches navigator.share', out.length === 2 && out[1].action === 'share-image' && bytesOf(out[1]).equals(want.png) && q.qrStatus === '' && (await p.ev('window.__share.calls.length')) === 0, summary(out));

    // Every answer that is not out-done with ok true is a failure the page says plainly.
    await p.ev("window.__cl.outMode = 'error'", { gesture: false });
    await p.click('#qr-save');
    await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrSaveFailed)}`, 5000);
    check('app bridge: out-error from the app makes the page say the picture could not be saved', (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrSaveFailed);
    await p.click('#qr-share');
    await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrShareFailed)}`, 5000);
    check('app bridge: and could not be shared', (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrShareFailed);
    await p.ev("window.__cl.outMode = 'badpull'", { gesture: false });
    const bad = await p.ev(`(async () => {
      const b = Uint8Array.from(atob(${J(want.png.toString('base64'))}), (c) => c.charCodeAt(0));
      const before = window.__cl.posted.filter((m) => m.t === 'out-chunk').length;
      const started = Date.now();
      const ok = await window.CLAndroid.saveImage(new Blob([b], { type: 'image/png' }));
      return { ok, ms: Date.now() - started, chunks: window.__cl.posted.filter((m) => m.t === 'out-chunk').length - before };
    })()`, { gesture: false });
    check('app bridge: a pull for a chunk that does not exist ends the transfer at once, false, with no chunk sent', bad.ok === false && bad.chunks === 0 && bad.ms < 2000, bad);

    // A second tap while the picture is on its way: the answer already coming, not a second copy.
    await p.ev("window.__cl.outMode = 'silent'", { gesture: false });
    const twice = await p.ev(`(async () => {
      const b = Uint8Array.from(atob(${J(want.png.toString('base64'))}), (c) => c.charCodeAt(0));
      const blob = new Blob([b], { type: 'image/png' });
      const before = window.__cl.posted.filter((m) => m.t === 'out-begin').length;
      const started = Date.now();
      const calls = [window.CLAndroid.saveImage(blob), window.CLAndroid.saveImage(blob), window.CLAndroid.saveImage(new Blob([b], { type: 'image/png' })), window.CLAndroid.shareImage(blob)];
      await new Promise((r) => setTimeout(r, 300));
      const begun = window.__cl.posted.filter((m) => m.t === 'out-begin').slice(before).map((m) => m.action);
      const answers = await Promise.all(calls);
      return { begun, answers, ms: Date.now() - started, after: window.__cl.posted.filter((m) => m.t === 'out-begin').slice(before).map((m) => m.action) };
    })()`, { gesture: false });
    // The share waits its turn behind the save, and its own 8 seconds run while it waits.
    check('app bridge: the same picture asked for three times (the same Blob or the same bytes) is sent once; a share of it waits its turn', J(twice.begun) === J(['save-image']) && twice.after.filter((a) => a === 'save-image').length === 1, twice);
    check('app bridge: an app that never answers gives false after the 8-second limit, for every call, and none hangs', J(twice.answers) === J([false, false, false, false]) && twice.ms >= 7500 && twice.ms < 20000, twice);
    await p.click('#qr-save');
    const t0 = Date.now();
    await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrSaveFailed)}`, 12000);
    check('app bridge: Save picture with a silent app says it could not be saved after about 8 seconds', (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrSaveFailed && Date.now() - t0 >= 7000, Date.now() - t0);

    // Refused before anything is posted: only a PNG Blob of 1 to 262,144 bytes.
    await p.ev("window.__cl.outMode = 'ok'", { gesture: false });
    const refused = await p.ev(`(async () => {
      const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      const big = new Uint8Array(262145); big.set(sig);
      const before = window.__cl.posted.length;
      const api = window.CLAndroid;
      const r = {
        bytes: await api.saveImage(new Uint8Array(sig)),
        text: await api.shareImage('png'),
        none: await api.saveImage(),
        jpeg: await api.saveImage(new Blob([new Uint8Array(sig)], { type: 'image/jpeg' })),
        untyped: await api.shareImage(new Blob([new Uint8Array(sig)])),
        gif: await api.saveImage(new Blob(['GIF89a\u0001\u0000\u0001\u0000'], { type: 'image/png' })),
        empty: await api.saveImage(new Blob([], { type: 'image/png' })),
        tooBig: await api.saveImage(new Blob([big], { type: 'image/png' })),
      };
      r.posted = window.__cl.posted.length - before;
      return r;
    })()`, { gesture: false });
    check('app bridge: anything but a PNG Blob of 1 to 262,144 bytes is refused (false) and nothing is posted', Object.entries(refused).every(([k, v]) => (k === 'posted' ? v === 0 : v === false)), refused);
    const atCap = await p.ev(`(async () => {
      const max = new Uint8Array(262144); max.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ok = await window.CLAndroid.shareImage(new Blob([max], { type: 'image/png' }));
      const j = window.__cl.out[window.__cl.out.length - 1];
      return { ok, size: j.size, chunks: j.chunks, indexes: j.indexes };
    })()`, { gesture: false });
    check('app bridge: a picture of exactly 262,144 bytes goes in 4 chunks (the app checks what it is)', atCap.ok === true && atCap.size === 262144 && atCap.chunks === 4 && J(atCap.indexes) === J([0, 1, 2, 3]), atCap);

    // SEC-10 through the real bridge: 'link' reaches the app, an unknown reason does not.
    const before = (await p.posted()).length;
    await p.type(EMAIL);
    await p.waitFor("window.__cl.posted.some((m) => m.t === 'secure' && m.reason === 'link' && m.on === true)", 5000);
    await p.type(LINK);
    await p.waitFor("window.__cl.posted.some((m) => m.t === 'secure' && m.reason === 'link' && m.on === false)", 5000);
    const links = (await p.posted()).slice(before).filter((m) => m.t === 'secure').map((m) => `${m.reason}:${m.on}`);
    check('app bridge (SEC-10): a link with an email address asks secure link on, an ordinary link off', J(links) === J(['link:true', 'link:false']), links);
    const other = await p.ev(`(async () => {
      const before = window.__cl.posted.length;
      const mic = await window.CLAndroid.secure('microphone', true);
      return { mic, posted: window.__cl.posted.length - before };
    })()`, { gesture: false });
    check("app bridge: secure('microphone', true) is still refused, with nothing posted", other.mic === false && other.posted === 0, other);
    check('app bridge (QR code): no download, no request left the server, no CSP violation, no error', p.log.blobs.length === 0 && !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { blobs: p.log.blobs, offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }
  {
    // The page side of the bridge contract, against a stand-in window.CLAndroid that has the new calls.
    const p = await openPage({ mode: 'stub' });
    const want = expectedQr(LINK);
    const shown = await openQr(p, LINK);
    let q = await p.ev(QR_STATE);
    check('stand-in app: the code is shown, with Save picture and Share picture through the app and no Copy picture', shown && q.save && q.share && !q.copy && !q.screen && q.svg.d === want.path, { save: q.save, share: q.share, copy: q.copy, screen: q.screen });
    await p.click('#qr-save');
    await p.waitFor("window.__app.calls.some((c) => c.t === 'save-image' && c.base64)", 5000);
    await sleep(100);
    let calls = await p.ev('window.__app.calls');
    let save = calls.filter((c) => c.t === 'save-image');
    q = await p.ev(QR_STATE);
    check('stand-in app: Save picture hands the app exactly the PNG, as a Blob of type image/png, once', save.length === 1 && save[0].blob && save[0].type === 'image/png' && save[0].base64 === want.png.toString('base64'), save.map((c) => ({ blob: c.blob, type: c.type, size: c.size })));
    check('stand-in app: the page claims no save itself (the app confirms once the file is written), and makes no download', q.qrStatus === '' && p.log.blobs.length === 0 && (await p.ev("document.querySelectorAll('a[download]').length")) === 0, { status: q.qrStatus, blobs: p.log.blobs });
    await p.click('#qr-share');
    await p.waitFor("window.__app.calls.some((c) => c.t === 'share-image' && c.base64)", 5000);
    calls = await p.ev('window.__app.calls');
    const share = calls.filter((c) => c.t === 'share-image');
    check('stand-in app: Share picture hands the app exactly the PNG, as a Blob, and never touches navigator.share', share.length === 1 && share[0].blob && share[0].type === 'image/png' && share[0].base64 === want.png.toString('base64') && (await p.ev('window.__share.calls.length')) === 0, share.map((c) => ({ blob: c.blob, type: c.type })));
    await p.ev("window.__app.mode = 'fail'", { gesture: false });
    await p.click('#qr-save');
    await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrSaveFailed)}`, 5000);
    check('stand-in app: a save the app refuses says so plainly', (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrSaveFailed);
    await p.click('#qr-share');
    await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrShareFailed)}`, 5000);
    check('stand-in app: a share the app refuses says so plainly', (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrShareFailed);
    await p.ev("window.__app.mode = 'ok'", { gesture: false });

    // SEC-10 and PD-1.
    await p.ev('window.__app.secure.length = 0', { gesture: false });
    await p.type(EMAIL);
    await p.waitFor("window.__app.secure.includes('link:true')", 5000);
    let st = await p.ev(`({ secure: [...window.__app.secure], clean: document.getElementById('clean-link').textContent, card: !document.getElementById('qr-card').hidden,
      warn: document.getElementById('share-warn').hidden ? null : document.getElementById('share-warn').textContent, note: document.getElementById('qr-note').hidden ? null : document.getElementById('qr-note').textContent })`);
    check('stand-in app (SEC-10): a link with an email address on screen asks the app to block screenshots (secure link on)', J(st.secure) === J(['link:true']), st.secure);
    check('stand-in app: the QR card closed with the change, and the new link gets the PD-1 line and, under it, the short QR line (SC-9)', !st.card && st.warn === TEXT.personalEmail && st.note === TEXT.qrSameReason, st);
    check('stand-in app (SEC-10): the link stays on screen in full', st.clean === clean(EMAIL), st.clean);
    await p.click('#copy-btn');
    calls = await p.ev('window.__app.calls');
    check('stand-in app (PD-1): such a link is copied as sensitive', calls.filter((c) => c.t === 'copy').at(-1).sensitive === true, calls.filter((c) => c.t === 'copy').at(-1));
    await p.type(LINK);
    await p.waitFor("window.__app.secure.at(-1) === 'link:false'", 5000);
    st = await p.ev('[...window.__app.secure]');
    check('stand-in app (SEC-10): an ordinary link lifts it again (secure link off)', J(st) === J(['link:true', 'link:false']), st);
    await p.click('#copy-btn');
    calls = await p.ev('window.__app.calls');
    check('stand-in app: an ordinary link is copied as not sensitive', calls.filter((c) => c.t === 'copy').at(-1).sensitive === false, calls.filter((c) => c.t === 'copy').at(-1));
    // Best effort: when the app cannot confirm, the link is still shown, and the page asks again later.
    await p.ev("window.__app.secureMode = 'fail'", { gesture: false });
    await p.type(RESET);
    await p.waitFor("window.__app.secure.filter((x) => x === 'link:true').length === 2", 5000);
    await sleep(300);
    st = await p.ev("({ clean: document.getElementById('clean-link').textContent, result: !document.getElementById('result').hidden, secure: [...window.__app.secure] })");
    check('stand-in app (SEC-10): a sign-in link asks too, and stays on screen when the app cannot confirm (best effort, unlike a secret)', st.result && st.clean === clean(RESET) && st.secure.slice(2, 3)[0] === 'link:true', st);
    check('stand-in app: no request left the server, no CSP violation, no error', !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { offsite: p.log.offsite, csp: await p.ev('window.__csp'), errors: p.log.errors });
    await p.close();
  }
  {
    // Stage 4b review SC-3: in the app, a picture reader that cannot start is said without naming a
    // browser, and no code is shown.
    const p = await openPage({ mode: 'stub', init: "window.Worker = function () { throw new Error('no workers here'); };" });
    await p.type(LINK);
    await p.waitFor(`document.getElementById('clean-link').textContent === ${J(clean(LINK))}`, 5000);
    await p.click('#qr-btn');
    await p.waitFor(`document.getElementById('action-status').textContent === ${J(TEXT.qrNoReaderApp)}`, 15000);
    const q = await p.ev(QR_STATE);
    check('stand-in app without a picture reader: no code, and the line names no browser (SC-3)', !q.card && !q.svg && q.status === TEXT.qrNoReaderApp && !/browser/.test(q.status), { card: q.card, status: q.status });
    await p.close();
  }
  {
    // A WebView too old for the bridge: the code on screen only.
    const p = await openPage({ mode: 'nobridge' });
    const shown = await openQr(p, LINK);
    const q = await p.ev(QR_STATE);
    check('app without the bridge: Make a QR code shows the code only, with no Save, Share or Copy picture, and says to scan it from the screen', shown && !!q.svg && !q.save && !q.share && !q.copy && q.screen === TEXT.qrScreen, { shown, save: q.save, share: q.share, copy: q.copy, screen: q.screen });
    // SC-9: such a WebView cannot share (no bridge, no navigator.share), so Share is not offered at
    // all and its held-share line is not shown: the QR line gives the reason in full.
    const r = await refusedLines(p, RESET);
    check('app without the bridge (SC-9): a reset link: no held-share line, so the QR line in full', !r.button && !r.shareNote && !r.warn && r.note === QR_REFUSED.auth, { shareNote: r.shareNote, warn: r.warn, note: r.note });
    check('app without the bridge (QR code): no download, no request left the server, no CSP violation, no error', p.log.blobs.length === 0 && !p.log.offsite.length && !(await p.ev('window.__csp.length')) && !p.log.errors.length, { blobs: p.log.blobs, offsite: p.log.offsite, errors: p.log.errors });
    await p.close();
  }
} catch (err) {
  failures += 1;
  console.log(`FAIL the run stopped: ${err && err.stack ? err.stack : err}`);
} finally {
  ws.close();
  chrome.kill('SIGTERM');
  server.close();
  await sleep(300);
  if (!KEEP) rmSync(profile, { recursive: true, force: true });
}

console.log(`\napp-mode smoke: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
