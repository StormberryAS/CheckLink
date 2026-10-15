// Browser smoke test of the CheckLink interface, driven over the Chrome DevTools Protocol
// with nothing but Node 24 built-ins.
//
//   node tests/ui-smoke.mjs [--chromium /usr/bin/chromium] [--out DIR] [--keep]
//
// It serves the repository read-only with the policy header check.stormberry.as sends from
// stage 2 on (HOST_CSP, as tests/serve.py does; the zone's own policy for one scenario that
// proves the page degrades plainly without the Cloudflare rule), so the browser enforces it
// and the page's own policy together, as in production, starts headless Chromium with a throwaway profile under DIR, pastes and
// types links the way a person would, ticks and unticks parts, presses Copy, Share and Go
// to (all three replaced by the recording stand-ins of tests/share-stub.mjs, so nothing
// leaves the machine), and checks every result against the engine run in Node. It is a
// smoke test, not the full browser suite (tests/e2e.mjs): it proves the main paths work.
//
// Stage 4b: Make a QR code, its card at 1280, 390 and 320 pixels and at 200% text, in dark, light
// and forced colours, with its screen-reader label; the card closing on any change; the reason
// line for every kind of link that gets none; the PD-1 line above Copy and Share; and no code where
// the reader cannot run (the zone's policy without WebAssembly, or no worker at all).
//
// Stage 5: the first-run notice (gate.js, generated) at 1280, 390 and 320 pixels and at 200% text,
// closed by Escape, the backdrop, a mouse press and the keyboard, and not shown again after a
// reload; the one flag it stores; the footer's Privacy and Disclaimer links, and both pages under
// the host policy, in dark and light, at 1280 and 320 pixels. Every other page here closes the
// notice first, as a person would.
//
// Stage 3: Scan with camera runs against Chromium's fake camera (two of them, showing its moving test
// pattern), served with no Permissions-Policy header or with camera=(self), as check.stormberry.as
// must send it, and once with the zone's camera=(), which turns the camera off for the page.
//
// The file name does not end in .test.mjs, so `node --test tests/` does not run it.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_DATE, analyse } from '../src/link-core.js';
import { CAMERA_STATE, LINKISH, PAGE_STATE, PICTURE_STATE, QR_STATE, REPORT_PREFIX, RESULT_WORDS, TEXT, cameraStub, expectedQr, readMailto, shareStub } from './share-stub.mjs';
import { rowLabel } from '../src/row-words.js';
import { QR_REFUSED } from '../src/qr-make.js';
import { FLAG_VALUE, GATE, GATE_STATE, LEGAL_STATE, copyProblems, metaCsp } from './legal-pages.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const CHROMIUM = opt('--chromium', process.env.CHROMIUM || '/usr/bin/chromium');
const OUT = resolve(opt('--out', process.env.CL_UI_OUT || join(tmpdir(), 'checklink-ui')));
const KEEP = args.includes('--keep');
const J = JSON.stringify;

const ZONE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; "
  + "connect-src 'self' https://stormberry-contact-form.marcos-495.workers.dev; "
  + "frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; "
  + "form-action 'self' https://stormberry-contact-form.marcos-495.workers.dev; object-src 'none'";
// From stage 2: the host-scoped header (see tests/serve.py and NOTICE). cspMode 'zone' sends the
// zone's own policy instead, which does not allow WebAssembly.
const HOST_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; worker-src 'self'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
let cspMode = 'host';
const csp = () => (cspMode === 'zone' ? ZONE_CSP : HOST_CSP);
// Stage 3: permMode 'host' sends camera=(self) (the rule check.stormberry.as needs), 'zone' the
// zone's camera=().
let permMode = 'host';
const perm = () => (permMode === 'zone' ? 'camera=(), microphone=(), geolocation=()' : 'camera=(self), microphone=(), geolocation=()');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown', '.txt': 'text/plain' };

if (!existsSync(CHROMIUM)) {
  console.error(`Chromium not found at ${CHROMIUM}. Pass --chromium PATH.`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(OUT, 'profile-'));

// ---- Links ------------------------------------------------------------------------------
const corpus = JSON.parse(readFileSync(join(ROOT, 'rules', 'provider-test-corpus.json'), 'utf8')).samples;
const sample = (id) => {
  const c = corpus.find((x) => x.id === id);
  if (!c) throw new Error(`corpus sample ${id} is missing`);
  return c.dirty;
};
// Three corpus links: Google search (query parts only), Amazon (a path part, and psc kept
// because it picks the size), Apple Music (an affiliate token and two "ask" parts).
const GOOGLE = sample('G1-01');
const AMAZON = sample('G3-01');
const APPLE = sample('G1-22');
const INNER = 'https://example.org/page?utm_source=x&a=1';
const SAFE_LINKS = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(`https://www.google.com/url?q=${encodeURIComponent(INNER)}&sa=D&ust=123`)}&data=05%7C01%7Cme%40corp.no%7Cabc&sdata=AbCdEf0123456789&reserved=0`;
const HTTP_LINK = 'http://example.com/a?utm_source=news&id=7';
const SHORT = 'https://bit.ly/3abcDEF?utm_source=x';
const SIGNED = 'https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Signature=abc&utm_source=x';
const TWO = 'Have a look: https://example.com/a?utm_source=x&id=2, thanks. Also www.example.no/side?fbclid=abc.';
// Review fixes of 10 October 2026: a reset link (Share held back, Go to behind a
// confirmation), a bare wrapper (Go to opens the address inside), a direction override
// before @ (drawn as a mark), and two links typed in quick succession (Copy acts on the
// second).
const RESET = 'https://example.com/reset-password?token=abc123def456&utm_source=email';
const BARE_WRAPPER = 'www.google.com/url?q=https%3A%2F%2Fexample.com%2Fpage&sa=D';
const RLO = 'https://\u202Emoc.elgoog@moc.elgoog.ac/';
const QUICK_A = 'https://a.example/?utm_source=x';
const QUICK_B = 'https://b.example/?utm_medium=y&id=3';
// Marcos's Instagram test of 10 October 2026, with mdxt (now a verified sharer rule, spec
// decision 17) replaced by a name on no list: a post page is fully
// addressed by its path, so it goes as an Unrecognised part; a profile keeps it.
const INSTAGRAM = 'https://www.instagram.com/p/DeTqc0NDifd/?utm_source=ig_web_copy_link&unknownid=NTc4MTIwNjQ2YQ==';
const IG_PROFILE = 'https://www.instagram.com/stormberry.as/?hl=en&unknownid=NTc4MTIwNjQ2YQ==';
// A protected short name on a canonical page (canonical review finding C5): s on a TikTok
// video is Unrecognised but unticked; mystery is ticked. t was this example until spec
// decision 23 (10 October 2026) put it on the page's remove list: it is ticked now, under
// its own label.
const TIKTOK_S = 'https://www.tiktok.com/@stormberry/video/7420000000000000000?s=2&mystery=1';
const TIKTOK_T = 'https://www.tiktok.com/@stormberry/video/7420000000000000000?t=1700000000&mystery=1';
// The interface build of 10 October 2026: Marcos's YouTube test (t=354 kept on purpose,
// spec 8), his two Maps place links (context note and Pin only, spec 10), the address
// disguise and the Instagram sharer ID from build 1, and three search engines.
const REG = Object.fromEntries(JSON.parse(readFileSync(join(ROOT, 'rules', 'marcos-regression.json'), 'utf8')).cases.map((c) => [c.id, c.dirty]));
const YT = REG['M2-youtube-time'];
const MAPS_A = REG['M6-google-maps-place'];
const MAPS_B = REG['M7-google-maps-trail'];
// Place only (spec 18): the third Maps option, Google's cid for the place's own feature ID.
// MAPS_PIN_ONLY has a place block with its own pin, but the final coordinates come after
// it, so no feature ID can be paired with them; MAPS_NO_ID has context but no feature ID.
const PLACE_A = 'https://maps.google.com/?cid=11010736480805010322';
const PLACE_B = 'https://maps.google.com/?cid=7942154548931413284';
const PLACE_HELP = "A third link to the same place. It opens the place's own page, without the route or searches that led to it.";
const MAPS_PIN_ONLY = 'https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m11!1m2!2m1!1sCafes!3m4!1s0x1:0x2!8m2!3d60.4!4d5.2!8m2!3d61.5!4d6.5';
const MAPS_NO_ID = 'https://www.google.com/maps/place/X/@60.4,5.2,15z/data=!4m5!1m2!2m1!1sCafes!8m2!3d60.4!4d5.2';
const DISGUISE = REG['M8-at-trick-userinfo'];
const SHARER = REG['M1-instagram-mdxt'];
const SEARCHES = [REG['M9-bing-search'], REG['M10-duckduckgo-search'], REG['M11-brave-search']];
const UNSUB = 'https://example.com/unsubscribe?mkt_tok=abc123zz&utm_source=x';
// Batch 3 interface review (10 October 2026): sign-in details before @, empty pairs on
// Naver, Baidu's run of identical rows, a playlist with four kept parts, Brave's Goggle (an
// address the page needs), an address hidden inside with a long host, and a link with
// nothing to remove.
const SIGNIN = 'https://admin:hunter2@login.example.com/';
const NAVER_EMPTY = 'https://search.naver.com/search.naver?where=nexearch&query=bergen&nso=&ssc=&sm=top_hty';
const BAIDU_RUN = 'https://www.baidu.com/s?wd=bergen&rsv_spt=1&rsv_iqid=0x1&rsv_bp=1&rsv_t=abc';
const PLAYLIST = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=2&t=30&si=abcDEF123ghi';
const GOGGLE = 'https://search.brave.com/goggles?q=rust&goggles_id=https%3A%2F%2Fraw.githubusercontent.com%2Fbrave%2Fgoggles-quickstart%2Fmain%2Fgoggles%2Frust_programming.goggle&source=web';
const HIDDEN_LONG = 'https://example.com/go?next=https://notificationsandaccountupdates.examplehostingprovider.co.uk/page';
const PLAIN = 'https://example.com/a';
// 20,000 characters (the box's limit) with 4,994 parts: the page must stay usable.
const MANY = `https://www.apple.com/?${'awc&'.repeat(5000)}`.slice(0, 20000);
const ALL_LINKS = [GOOGLE, AMAZON, APPLE, SAFE_LINKS, HTTP_LINK, SHORT, SIGNED, 'https://example.com/a?utm_source=x&id=2', 'www.example.no/side?fbclid=abc', RESET, BARE_WRAPPER, RLO, QUICK_A, QUICK_B, INSTAGRAM, IG_PROFILE, YT, MAPS_A, MAPS_B, MAPS_PIN_ONLY, MAPS_NO_ID, DISGUISE, SHARER, ...SEARCHES, UNSUB, SIGNIN, NAVER_EMPTY, BAIDU_RUN, PLAYLIST, GOGGLE, HIDDEN_LONG];

// ---- Static server ---------------------------------------------------------------------
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  requests.push(path);
  const file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  if (req.method !== 'GET' || !file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Security-Policy': csp() });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': csp(), 'Permissions-Policy': perm(), 'Cache-Control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---- Chromium --------------------------------------------------------------------------
const chrome = spawn(CHROMIUM, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--use-fake-device-for-media-stream=device-count=2', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
  // Keeps Chromium's crash-report folder inside the throwaway profile instead of the
  // person's own ~/.config/chromium, which --user-data-dir alone does not cover.
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

// ---- Checks ----------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail !== undefined ? `\n     ${typeof detail === 'string' ? detail : J(detail)}` : ''}`);
}
const notes = [];
function note(text) {
  notes.push(text);
  console.log(`note ${text}`);
}

// What the page should show for an analysis and a choice, from the engine in Node.
function expected(link, removed) {
  const a = analyse(link);
  const set = removed ? new Set(removed) : new Set(a.defaultRemoved);
  const outer = a.segmentsFor(set).filter((s) => s.removed).map((s) => ({ text: s.text, part: s.partId }));
  const kept = a.wrappers.findIndex((w) => !set.has(w.partId));
  const inner = a.wrappers.length ? (kept >= 0 ? a.target.segmentsFor([]) : a.target.segmentsFor(set)).filter((s) => s.removed).map((s) => ({ text: s.text, part: s.partId })) : [];
  return { a, set, clean: a.clean(set), outer, inner };
}

// ---- One page --------------------------------------------------------------------------
async function openPage(width, height, { init = shareStub(), camera = false, gate = 'close' } = {}) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  const log = { errors: [], offsite: [], requests: [] };
  // The page and its workers (stage 2: the decoder worker): a worker's requests and errors reach
  // DevTools only through its own session.
  const sessions = new Set([sessionId]);
  const onMsg = (m) => {
    if (!sessions.has(m.sessionId)) return;
    if (m.method === 'Target.attachedToTarget') {
      sessions.add(m.params.sessionId);
      for (const d of ['Network.enable', 'Runtime.enable']) send(d, {}, m.params.sessionId).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId).catch(() => {});
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') log.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') log.errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Network.requestWillBeSent') {
      log.requests.push({ url: m.params.request.url, type: m.params.type });
      if (!m.params.request.url.startsWith(BASE)) log.offsite.push(m.params.request.url);
    }
  };
  listeners.add(onMsg);
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Page.enable');
  await s('DOM.enable');
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite', ...(camera ? ['videoCapture'] : [])], origin: BASE.slice(0, -1), browserContextId }).catch(() => {});
  await s('Page.addScriptToEvaluateOnNewDocument', { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI),true);" });
  if (init) await s('Page.addScriptToEvaluateOnNewDocument', { source: init });
  await s('Page.navigate', { url: BASE });
  await sleep(900);
  // On a busy machine the module can take longer than that: wait until the page has set
  // itself up (the footer's rules date is the last thing it writes).
  for (let i = 0; i < 100; i++) {
    const r = await s('Runtime.evaluate', { expression: "document.readyState === 'complete' && !!document.getElementById('rules-date') && !document.getElementById('rules-date').hidden", returnByValue: true });
    if (r.result && r.result.value) break;
    await sleep(100);
  }
  const ev = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(expression)) return true;
      await sleep(50);
    }
    return false;
  };
  // Stage 5: every page here opens in a fresh browser context, as a first visit, so the first-run
  // notice (gate.js) is up. It is closed with its own button, as a person would, unless the test
  // is about the notice itself (gate: 'keep').
  const gateShown = await ev("!!document.querySelector('.sb-gate-overlay')");
  if (gate === 'close' && gateShown) {
    await ev("document.querySelector('.sb-gate-btn').click()");
    if (!(await waitFor("!document.querySelector('.sb-gate-overlay') && !document.querySelector('main').inert", 5000))) throw new Error('the first-run notice did not close');
  }
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
  // Presses an element in its centre with real mouse events, after scrolling it into view
  // and checking nothing covers it there.
  const click = async (selector) => {
    await settle();
    await ev(`document.querySelector(${J(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
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
    })()`);
    if (r.err || !r.ok) throw new Error(`cannot press ${selector}: ${r.err || 'covered'}`);
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await s('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(80);
  };
  const key = async (k) => {
    const map = {
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    };
    const d = map[k];
    await s('Input.dispatchKeyEvent', { type: 'keyDown', ...d });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.windowsVirtualKeyCode });
    await sleep(60);
  };
  // Empties the box the way a person would (select all, delete), then waits for the page.
  const clearBox = async () => {
    await ev("(() => { const t = document.getElementById('link-input'); t.focus(); t.select(); })()");
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await waitFor("document.getElementById('result').hidden", 3000);
  };
  // Pastes text into the box through the real clipboard and Ctrl+V. The page's paste
  // handling is what is tested, so the clipboard is filled with the browser's own
  // writeText, kept by the stand-in before it replaced it. Returns how long the analysis
  // took to appear after the key press.
  const paste = async (text) => {
    await ev("(() => { const t = document.getElementById('link-input'); t.focus(); t.select(); })()");
    await ev(`window.__realWriteText.call(navigator.clipboard, ${J(text)})`);
    const t0 = Date.now();
    await s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    const landed = await waitFor(`document.getElementById('link-input').value === ${J(text)}`, 3000);
    if (!landed) throw new Error('the paste did not reach the box');
    await waitFor(`!document.getElementById('result').hidden && document.getElementById('summary-line').textContent !== ''`, 3000);
    return Date.now() - t0;
  };
  // Types text in a few pieces, as a person typing fast would.
  const type = async (text) => {
    await ev("(() => { const t = document.getElementById('link-input'); t.focus(); t.select(); })()");
    const step = Math.ceil(text.length / 4);
    for (let i = 0; i < text.length; i += step) {
      await s('Input.insertText', { text: text.slice(i, i + step) });
      await sleep(30);
    }
  };
  const shot = async (label) => {
    // Rows off screen skip painting (content-visibility: auto); a full-page picture paints them all.
    await ev("document.querySelectorAll('.cl-part-li').forEach((li) => { li.style.contentVisibility = 'visible'; })");
    await sleep(100);
    const h = await ev('document.documentElement.scrollHeight');
    const r = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.min(8000, h), scale: 1 } });
    writeFileSync(join(OUT, `${label}.png`), Buffer.from(r.data, 'base64'));
  };
  const state = () => ev(PAGE_STATE);
  // Stage 2: a picture given to the page's file input, as the file chooser would.
  const choose = async (file) => {
    const { root } = await s('DOM.getDocument', { depth: 0 });
    const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: '#pic-input' });
    await s('DOM.setFileInputFiles', { nodeId, files: [join(ROOT, 'tests', 'fixtures', 'qr', file)] });
    await waitFor("document.getElementById('pic-status').textContent !== 'Reading the picture on this device.'", 20000);
    await sleep(150);
    return ev(PICTURE_STATE);
  };
  const close = async () => {
    listeners.delete(onMsg);
    await send('Target.closeTarget', { targetId });
    await send('Target.disposeBrowserContext', { browserContextId });
  };
  return { s, ev, waitFor, click, key, paste, type, clearBox, shot, state, close, log, choose, gateShown };
}

// No attribute anywhere on the page may carry an analysed link (or its clean form). The
// one exception is the report line's mailto: (#report-link), which is checked on its own:
// exactly one mailto: anchor, to info@stormberry.as, with only a subject and a body.
async function noLinkTo(p, tag, links) {
  const attrs = await p.ev(LINKISH);
  const bad = [];
  for (const link of links) {
    const forms = new Set([link, analyse(link).cleanLink].filter(Boolean));
    for (const a of attrs) {
      if (a.id === 'report-link' && a.attr === 'href') continue;
      for (const f of forms) if (a.value === f || a.value.includes(f) || (a.resolved && a.resolved.includes(f))) bad.push({ ...a, link: f });
    }
  }
  const anchors = await p.ev("[...document.querySelectorAll('a[href]')].map((a) => ({ id: a.id, href: a.getAttribute('href') }))");
  check(`${tag}: no element links to the analysed address (${anchors.length} anchors on the page, all part of the page itself)`, !bad.length, bad);
  const mailtos = anchors.filter((a) => /^mailto:/i.test(a.href));
  const m = mailtos.length === 1 ? readMailto(mailtos[0].href) : null;
  const okMail = mailtos.length === 1 && mailtos[0].id === 'report-link' && (mailtos[0].href === 'mailto:info@stormberry.as' || (mailtos[0].href.startsWith(REPORT_PREFIX) && m && m.to === 'info@stormberry.as' && J(m.params) === J(['subject', 'body'])));
  check(`${tag}: the only mailto: is the report line's, to info@stormberry.as with a subject and a body only`, okMail, mailtos);
}

async function textChecks(p, tag) {
  // What is on screen, plus the whole result as text (closed sections and hidden rows
  // included, the addresses themselves left out), so wording in "Kept on purpose" or in a
  // row that is not visible is checked too.
  const text = `${await p.ev('document.body.innerText')}\n${await p.ev(RESULT_WORDS)}`;
  const dashes = [...new Set(text.match(/.{0,30}(\u2014|\u2013|--).{0,30}/g) || [])];
  check(`${tag}: no em dashes, en dashes or double hyphens in the text`, !dashes.length, dashes);
  const bangs = [...new Set(text.match(/.{0,30}!.{0,10}/g) || [])].filter((x) => !/https?:\/\/\S*!/.test(x));
  check(`${tag}: no exclamation marks`, !bangs.length, bangs);
  const safe = [...new Set((text.replace(/Safe Links/g, '').match(/.{0,30}\bsafe(ly|ty|r|st)?\b.{0,30}/gi) || []))];
  check(`${tag}: never the word "safe" (Microsoft's product name "Safe Links" aside)`, !safe.length, safe);
  const us = [...new Set((text.match(/\b(color\w*|organiz\w*|gray|center(ed|s)?|favorite\w*|behavior\w*|analyz\w*|customiz\w*|recogniz\w*)\b/gi) || []))];
  check(`${tag}: British spelling`, !us.length, us);
}

// ---- Scenarios -------------------------------------------------------------------------
try {
  for (const [w, h, share] of [[360, 780, true], [1280, 900, false]]) {
    const p = await openPage(w, h, { init: shareStub({ share, clipboard: true, open: true }) });
    const tag = `w${w}`;

    // Load.
    const head = await p.ev(`(() => {
      const first = document.head.firstElementChild;
      return { first: first && first.getAttribute('http-equiv'), csp: first && first.getAttribute('content'), result: document.getElementById('result').hidden,
        rules: document.getElementById('rules-date').textContent, rulesShown: !document.getElementById('rules-date').hidden,
        title: document.title, canonical: document.querySelector('link[rel=canonical]').href, inputLabel: document.getElementById('link-input').labels[0]?.textContent };
    })()`);
    check(`${tag} page loads without errors`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} the page policy is the first element in head and forbids every request; stage 2 adds only WebAssembly and its own worker`, head.first === 'Content-Security-Policy' && /connect-src 'none'/.test(head.csp) && /script-src 'self' 'wasm-unsafe-eval';/.test(head.csp) && /style-src 'self';/.test(head.csp) && /worker-src 'self'(;|$)/.test(head.csp) && !/unsafe-inline|unsafe-eval'|blob:|data:/.test(head.csp.replace("'wasm-unsafe-eval'", '')), head);
    check(`${tag} title, canonical address and the input's label`, head.title === 'CheckLink | Stormberry Labs' && head.canonical === 'https://check.stormberry.as/' && head.inputLabel === 'Paste or type a link, or text that contains one', head);
    check(`${tag} nothing is shown before a link is given`, head.result === true, head);
    check(`${tag} the footer says "Rules dated ${RULES_DATE}"`, head.rulesShown && head.rules === `Rules dated ${RULES_DATE}`, head);
    if (w === 360) {
      // Inter's disambiguation set must survive in the bundled font: the same letters with
      // and without ss02 must draw differently.
      const ids = await p.ev(`(() => {
        const mk = (id, off) => { const s = document.createElement('span'); s.id = id; s.className = 'cl-addr'; s.textContent = 'Il1O0'; s.style.fontSize = '40px'; s.style.position = 'absolute'; s.style.left = '8px'; s.style.top = (off) + 'px'; s.style.background = '#000'; s.style.color = '#fff'; if (id === 'ss-off') s.style.fontFeatureSettings = 'normal'; document.body.append(s); return s.getBoundingClientRect(); };
        scrollTo(0, 0);
        return [mk('ss-on', 10), mk('ss-off', 70)].map((r) => [r.left, r.top, Math.ceil(r.width), Math.ceil(r.height)]);
      })()`);
      await sleep(300);
      const grab = async (b) => (await p.s('Page.captureScreenshot', { format: 'png', clip: { x: b[0], y: b[1], width: Math.max(b[2], 1), height: Math.max(b[3], 1), scale: 1 } })).data;
      const on = await grab(ids[0]);
      const off = await grab(ids[1]);
      check(`${tag} addresses use Inter's ss02 (l, I, 1, 0 and O drawn apart), and the bundled font keeps it`, on !== off, { on: on.length, off: off.length });
      await p.ev("document.getElementById('ss-on').remove(); document.getElementById('ss-off').remove();");
    }

    // 1. Google search, pasted.
    let ms;
    try {
      ms = await p.paste(GOOGLE);
      check(`${tag} paste: the link lands in the box and is analysed at once (${ms} ms)`, ms < 1000, ms);
    } catch (err) {
      check(`${tag} paste through the clipboard works`, false, String(err.message || err));
      await p.type(GOOGLE);
      await p.waitFor(`document.getElementById('full-link').textContent === ${J(GOOGLE)}`, 3000);
    }
    let st = await p.state();
    let ex = expected(GOOGLE);
    check(`${tag} Google: the summary says nothing was opened and where it goes`, st.summary === `A web address. ${TEXT.nothingOpened}` && st.goes === 'Goes to www.google.com.', { summary: st.summary, goes: st.goes });
    check(`${tag} Google: the full link is shown whole`, st.full === GOOGLE, st.full);
    check(`${tag} Google: the red, struck-through segments are exactly the engine's removed segments`, J(st.fullDel) === J(ex.outer), { page: st.fullDel, engine: ex.outer });
    check(`${tag} Google: removed parts are struck through and red`, /line-through/.test(st.delDecoration) && st.delColour === 'rgb(253, 164, 164)', { deco: st.delDecoration, colour: st.delColour });
    check(`${tag} Google: who owns the address (google.com, from the Public Suffix List) is bold and underlined`, st.host === 'google.com' && st.hostBold && /underline/.test(st.hostUnderline), { host: st.host, bold: st.hostBold, u: st.hostUnderline });
    check(`${tag} Google: one row per part, ticked as the rules say, each labelled and described`, J(st.rows.map((r) => [r.id, r.checked])) === J(ex.a.parts.map((x) => [x.id, x.defaultRemove])) && st.rows.every((r) => r.labelled && r.described), st.rows.map((r) => [r.id, r.checked, r.labelled, r.described]));
    // The label drops the name "Who learns it" already gives (batch 3 interface review finding 6).
    check(`${tag} Google: each row names the provider, says "Who learns it: Google", what it tells, and has its badge`, st.rows.every((r, i) => r.provider === (rowLabel(ex.a.parts[i]) || null) && r.who === 'Who learns it: Google' && r.told === ex.a.parts[i].reveals && r.badge === (ex.a.parts[i].unique ? TEXT.unique : TEXT.same)), st.rows.map((r) => [r.provider, r.who, r.told && r.told.slice(0, 30), r.badge]));
    check(`${tag} Google: no row repeats the engine name in its label`, st.rows.every((r) => !r.provider || !/^Google\b/.test(r.provider)), st.rows.map((r) => r.provider));
    const heard = await p.waitFor(`document.getElementById('announcer').textContent === ${J(`Link checked: ${ex.a.parts.length} parts found, ${ex.a.defaultRemoved.length} ticked to remove.`)}`, 2000);
    check(`${tag} Google: a screen reader hears that the link was checked, with the count`, heard, await p.ev("document.getElementById('announcer').textContent"));
    check(`${tag} Google: the clean link is the engine's, in a polite live region`, st.clean === ex.clean && st.cleanLive === 'polite', { page: st.clean, engine: ex.clean });
    check(`${tag} Google: no warning signs, said in the agreed words`, st.noWarnings && !st.warnings.length, st.warnings);
    check(`${tag} Google: Copy is the main button; Share ${share ? 'shown (the browser can share)' : 'hidden (the browser cannot share)'}`, st.copy && st.copyPrimary && st.share === share, { copy: st.copy, primary: st.copyPrimary, share: st.share });
    check(`${tag} Google: Go to is offered, labelled with the host`, st.go === 'Go to www.google.com', st.go);
    await noLinkTo(p, `${tag} Google`, [GOOGLE]);
    await p.shot(`${tag}-1-google`);

    // Untick oq with the mouse: the clean link keeps it.
    const oq = ex.a.parts.find((x) => x.name === 'oq');
    await p.click(`label.cl-part[data-part="${oq.id}"] .cl-part-name`);
    st = await p.state();
    ex = expected(GOOGLE, ex.a.defaultRemoved.filter((id) => id !== oq.id));
    check(`${tag} Google: unticking oq keeps it in the clean link and takes it out of red`, st.clean === ex.clean && st.clean.includes('&oq=bergen+wea') && J(st.fullDel) === J(ex.outer) && !st.rows.find((r) => r.id === oq.id).checked, { clean: st.clean, dels: st.fullDel.length });
    check(`${tag} Google: the count follows`, st.count === `${ex.a.parts.length} parts found, ${ex.a.parts.length - 1} ticked to remove.`, st.count);
    // Tick it again from the keyboard.
    await p.ev(`document.getElementById('part-${oq.id}').focus()`);
    await p.key('Space');
    st = await p.state();
    check(`${tag} Google: Space on the focused tick box removes it again`, st.clean === expected(GOOGLE).clean, st.clean);

    // Copy and Share.
    await p.click('#copy-btn');
    await p.waitFor(`document.getElementById('action-status').textContent !== ''`, 3000);
    st = await p.state();
    check(`${tag} Copy puts exactly the clean link on the clipboard and says so`, st.clips.length === 1 && st.clips[0].text === expected(GOOGLE).clean && st.clips[0].via === 'writeText' && st.status === TEXT.copied, { clips: st.clips, status: st.status });
    if (share) {
      await p.click('#share-btn');
      await sleep(100);
      st = await p.state();
      check(`${tag} Share hands exactly the clean link to the share sheet, as text`, st.shares.length === 1 && st.shares[0].text === expected(GOOGLE).clean && !st.shares[0].url, st.shares);
      await p.ev("window.__share.mode = 'abort'");
      await p.click('#share-btn');
      await sleep(100);
      st = await p.state();
      check(`${tag} closing the share sheet says nothing`, st.status === '', st.status);
      await p.ev("window.__share.mode = 'ok'");
    }

    // Go to: no confirmation for a link with nothing to check.
    await noLinkTo(p, `${tag} before Go to`, [GOOGLE]);
    await p.click('#go-btn');
    st = await p.state();
    check(`${tag} Go to opens the clean link in a new tab, without opener or referrer`, st.opened.length === 1 && st.opened[0].url === expected(GOOGLE).clean && st.opened[0].target === '_blank' && st.opened[0].features === 'noopener,noreferrer' && !st.dialog, st.opened);

    // 2. Amazon, typed in pieces: the analysis waits for the pause.
    await p.clearBox();
    await p.type(AMAZON);
    const early = await p.ev("document.getElementById('result').hidden");
    await p.waitFor(`document.getElementById('full-link').textContent === ${J(AMAZON)}`, 3000);
    st = await p.state();
    ex = expected(AMAZON);
    check(`${tag} typing: the analysis waits for a short pause, then follows`, early === true && st.full === AMAZON, { early, full: st.full && st.full.slice(0, 40) });
    check(`${tag} Amazon: the path part /ref=... is red and struck through, like the query parts`, st.fullDel[0] && st.fullDel[0].part === 'p0' && st.fullDel[0].text.startsWith('/ref=') && J(st.fullDel) === J(ex.outer), st.fullDel.slice(0, 2));
    check(`${tag} Amazon: psc stays (it picks the size) and the clean link is the engine's`, st.clean === ex.clean && /\?psc=1$/.test(st.clean), st.clean);
    await p.shot(`${tag}-2-amazon`);

    // 3. Apple Music: "ask" parts start unticked; the affiliate token is labelled.
    await p.clearBox();
    await p.paste(APPLE).catch(async () => { await p.type(APPLE); await sleep(400); });
    st = await p.state();
    ex = expected(APPLE);
    const ask = ex.a.parts.filter((x) => !x.defaultRemove).map((x) => x.id);
    check(`${tag} Apple: parts the rules only ask about start unticked`, ask.length === 2 && ask.every((id) => st.rows.find((r) => r.id === id && !r.checked)), st.rows.map((r) => [r.id, r.checked]));
    check(`${tag} Apple: the parts kept are still marked in the full link, with a dotted underline the legend explains`, ask.every((id) => st.fullKept.some((k) => k.part === id)) && st.keptMarkDecoration === 'dotted', { kept: st.fullKept, deco: st.keptMarkDecoration });
    check(`${tag} Apple: the affiliate token says it pays the sharer`, st.rows.some((r) => r.aff === 'Affiliate: pays the sharer, through Apple Performance Partners.'), st.rows.map((r) => r.aff));
    check(`${tag} Apple: red segments and clean link match the engine`, J(st.fullDel) === J(ex.outer) && st.clean === ex.clean, { dels: st.fullDel, clean: st.clean });
    await p.click(`label.cl-part[data-part="${ask[0]}"] .cl-part-name`);
    st = await p.state();
    ex = expected(APPLE, [...ex.a.defaultRemoved, ask[0]]);
    check(`${tag} Apple: ticking an asked part removes it`, st.clean === ex.clean && J(st.fullDel) === J(ex.outer), { clean: st.clean, engine: ex.clean });
    await p.shot(`${tag}-3-apple`);

    // 4. Safe Links around a Google redirect: the wrapper red as a whole, where it really
    // goes below it, coloured the same way.
    await p.clearBox();
    await p.paste(SAFE_LINKS).catch(async () => { await p.type(SAFE_LINKS); await sleep(400); });
    st = await p.state();
    ex = expected(SAFE_LINKS);
    check(`${tag} Safe Links: the wrapper is one red segment`, st.fullDel.length === 1 && st.fullDel[0].text === SAFE_LINKS && st.fullDel[0].part === 'w0', st.fullDel.map((d) => d.part));
    check(`${tag} Safe Links: "Where it really goes" shows the inner address, its own parts red, its host marked`, st.target === INNER && J(st.targetDel) === J(ex.inner) && st.host === 'example.org', { target: st.target, dels: st.targetDel, host: st.host });
    check(`${tag} Safe Links: the clean link goes straight to the address inside, with a note`, st.clean === 'https://example.org/page?a=1' && st.warnings.includes('safelinks') && st.goes === 'Goes to example.org.', { clean: st.clean, warnings: st.warnings, goes: st.goes });
    await p.click('label.cl-part[data-part="w0"] .cl-part-name');
    st = await p.state();
    check(`${tag} Safe Links: keeping the wrapper keeps the link exactly as written, and locks the parts inside`, st.clean === SAFE_LINKS && st.rows.filter((r) => r.id !== 'w0').every((r) => r.disabled) && st.go === 'Go to eur01.safelinks.protection.outlook.com' && /first, then to example\.org/.test(st.goes), { clean: st.clean && st.clean.slice(0, 50), rows: st.rows.map((r) => [r.id, r.disabled]), go: st.go, goes: st.goes });
    check(`${tag} Safe Links: the locked boxes show unticked, and the count says nothing is removed`, st.rows.every((r) => !r.checked) && st.count === `${ex.a.parts.length} parts found, 0 ticked to remove.`, { rows: st.rows.map((r) => [r.id, r.checked]), count: st.count });
    await p.shot(`${tag}-4-safelinks-kept`);
    await p.click('label.cl-part[data-part="w0"] .cl-part-name');
    st = await p.state();
    check(`${tag} Safe Links: ticking the wrapper again brings back the choices made inside it`, J(st.rows.map((r) => [r.id, r.checked])) === J(ex.a.parts.map((x) => [x.id, x.defaultRemove])) && st.clean === 'https://example.org/page?a=1', st.rows.map((r) => [r.id, r.checked]));

    // 5. An unencrypted link: Go to asks first, repeating the host and the reason.
    await p.clearBox();
    await p.paste(HTTP_LINK).catch(async () => { await p.type(HTTP_LINK); await sleep(400); });
    await p.click('#go-btn');
    await p.waitFor("document.getElementById('go-dialog').open", 2000);
    const dlg = await p.ev(`({ open: document.getElementById('go-dialog').open, title: document.getElementById('go-dialog-title').textContent, items: [...document.querySelectorAll('#go-dialog-list .cl-note')].map((li) => li.dataset.warning), confirm: document.getElementById('go-confirm').textContent, focus: document.activeElement.id })`);
    check(`${tag} http: Go to asks first, naming the host and the reason, with Cancel focused`, dlg.open && dlg.title === 'Go to example.com?' && J(dlg.items) === J(['not-encrypted']) && dlg.confirm === 'Go to example.com' && dlg.focus === 'go-cancel', dlg);
    await p.shot(`${tag}-5-confirm`);
    await p.key('Escape');
    st = await p.state();
    const focusAfter = await p.ev('document.activeElement.id');
    check(`${tag} http: Escape cancels; nothing is opened and focus returns to Go to`, !st.dialog && st.opened.length === 1 && focusAfter === 'go-btn', { dialog: st.dialog, opened: st.opened.length, focus: focusAfter });
    await p.click('#go-btn');
    await p.waitFor("document.getElementById('go-dialog').open", 2000);
    await p.click('#go-confirm');
    st = await p.state();
    check(`${tag} http: confirming opens the clean link`, !st.dialog && st.opened.length === 2 && st.opened[1].url === 'http://example.com/a?id=7', st.opened);

    // 6. A short link: the notice, and no Go to.
    await p.clearBox();
    await p.paste(SHORT).catch(async () => { await p.type(SHORT); await sleep(400); });
    st = await p.state();
    check(`${tag} short link: the notice, led by its tier word, says where it ends up only shows when opened, and Go to is absent`, st.short === "Check: This is a short link through bit.ly. Where it ends up is stored on bit.ly's server and only shows when opened; CheckLink never opens it." && st.go === null && st.clean === 'https://bit.ly/3abcDEF' && st.goes === 'Goes to bit.ly first.', { short: st.short, go: st.go, clean: st.clean, goes: st.goes });
    check(`${tag} short link: no empty "Things to know" card`, st.warnCard === false, st.warnCard);

    // 7. A signed link: left exactly as it is; Go to only after a confirmation.
    await p.clearBox();
    await p.paste(SIGNED).catch(async () => { await p.type(SIGNED); await sleep(400); });
    st = await p.state();
    check(`${tag} signed link: untouched, with its notice led by "Check:", under "The link, left as it is"`, !!st.untouched && /^Check: .*leaves it exactly as it is/.test(st.untouched) && st.clean === SIGNED && st.cleanTitle === 'The link, left as it is' && !st.rows.length && st.warnCard === true && J(st.warnings) === J(['shared-domain']), { untouched: st.untouched, title: st.cleanTitle, warnCard: st.warnCard, warnings: st.warnings });
    check(`${tag} signed link: Go to is offered (a Check, not a Stop) and asks first`, st.go === 'Go to bucket.s3.amazonaws.com', st.go);
    await p.click('#go-btn');
    await p.waitFor("document.getElementById('go-dialog').open", 2000);
    const signedDlg = await p.ev("[...document.querySelectorAll('#go-dialog-list .cl-note')].map((li) => li.dataset.warning)");
    check(`${tag} signed link: the confirmation repeats why it was left alone`, J(signedDlg) === J(['untouched']), signedDlg);
    await p.key('Escape');
    st = await p.state();
    check(`${tag} signed link: cancelling opens nothing`, !st.dialog && st.opened.length === 2, st.opened.length);

    // 7b. A reset link: the page says do not share it, so Share is held back.
    await p.clearBox();
    await p.paste(RESET).catch(async () => { await p.type(RESET); await sleep(400); });
    st = await p.state();
    check(`${tag} reset link: left as it is, ${share ? 'Share held back with the reason' : 'and no Share (this browser cannot share)'}`, st.clean === RESET && st.cleanTitle === 'The link, left as it is' && st.share === false && (share ? /^Share is not offered for this link: whoever opens it may get into the account/.test(st.shareNote || '') : st.shareNote === null), { share: st.share, note: st.shareNote });
    // SC-9: under that line the QR line is short; where the browser cannot share, that line is not
    // shown, so the QR line gives the reason in full.
    const rq = await p.ev(QR_STATE);
    check(`${tag} reset link (SC-9): ${share ? 'the QR line is the short one, under the line that gives the reason' : 'no line above, so the QR line gives the reason in full'}`, !rq.button && (share ? rq.shareNote === TEXT.shareHeldAuth && rq.note === TEXT.qrSameReason : rq.shareNote === null && rq.note === QR_REFUSED.auth), { shareNote: rq.shareNote, note: rq.note });

    // 7c. A wrapper written without https://: Go to opens the address inside, once.
    await p.clearBox();
    await p.paste(BARE_WRAPPER).catch(async () => { await p.type(BARE_WRAPPER); await sleep(400); });
    st = await p.state();
    check(`${tag} bare wrapper: Go to names the real host`, st.go === 'Go to example.com' && st.clean === 'https://example.com/page', { go: st.go, clean: st.clean });
    await p.click('#go-btn');
    st = await p.state();
    check(`${tag} bare wrapper: Go to opens https://example.com/page, with no second scheme in front`, st.opened.at(-1).url === 'https://example.com/page', st.opened.at(-1));

    // 7d. A right-to-left override before @: drawn as a mark, never applied.
    await p.clearBox();
    await p.paste(RLO).catch(async () => { await p.type(RLO); await sleep(400); });
    st = await p.state();
    check(`${tag} direction override: shown as a "U+202E" mark, named in a Check note, the real host in bold`, st.invisible.includes('U+202E') && !st.full.includes('\u202E') && st.host === 'elgoog.ac' && st.warnings.includes('invisible'), { marks: st.invisible, host: st.host, warnings: st.warnings });

    // 7e. Copy pressed before the pause after typing: it copies what is in the box now.
    await p.clearBox();
    await p.paste(QUICK_A).catch(async () => { await p.type(QUICK_A); await sleep(400); });
    await p.ev("(() => { const t = document.getElementById('link-input'); t.focus(); t.select(); })()");
    await p.s('Input.insertText', { text: QUICK_B });
    await p.ev("document.getElementById('copy-btn').click()");
    await p.waitFor(`document.getElementById('action-status').textContent === ${J(TEXT.copied)}`, 2000);
    st = await p.state();
    check(`${tag} quick typing: Copy right after typing copies the new link's clean form, not the old one`, st.clips.at(-1).text === expected(QUICK_B).clean && st.clean === expected(QUICK_B).clean, { copied: st.clips.at(-1), clean: st.clean });

    // 7f. Marcos's Instagram link with a name on no list: it is Unrecognised, marked apart, ticked and red.
    await p.clearBox();
    await p.paste(INSTAGRAM).catch(async () => { await p.type(INSTAGRAM); await sleep(400); });
    st = await p.state();
    ex = expected(INSTAGRAM);
    const mdxt = ex.a.parts.find((x) => x.name === 'unknownid');
    const utm = ex.a.parts.find((x) => x.name === 'utm_source');
    const mRow = st.rows.find((r) => r.id === mdxt.id);
    const uRow = st.rows.find((r) => r.id === utm.id);
    check(`${tag} Instagram: the clean link is the bare post address, as the engine gives it`, st.clean === 'https://www.instagram.com/p/DeTqc0NDifd/' && st.clean === ex.clean, st.clean);
    check(`${tag} Instagram: the unknown parameter is ticked and red, struck through in the full link like the tracker`, mRow && mRow.checked && mRow.ticked && J(st.fullDel) === J(ex.outer) && st.fullDel.some((d) => d.part === mdxt.id && d.text.includes('unknownid=NTc4MTIwNjQ2YQ==')), { row: mRow, dels: st.fullDel });
    check(`${tag} Instagram: the unknown parameter carries the word "Unrecognised", read out first, and a dashed edge; utm_source keeps its own label`, mRow && mRow.unrec === 'Unrecognised' && mRow.firstDescription === 'Unrecognised' && mRow.edge === 'dashed' && uRow && uRow.unrec === null && uRow.edge === 'solid' && uRow.provider === utm.provider, { m: mRow && [mRow.unrec, mRow.firstDescription, mRow.edge], u: uRow && [uRow.unrec, uRow.edge, uRow.provider] });
    check(`${tag} Instagram: the row names the platform, says who learns it and that the page opens without it, and calls its uniqueness a guess`, mRow && mRow.provider === 'Instagram' && mRow.who === 'Who learns it: Meta' && mRow.told === 'Not on the verified lists for this kind of page. This page opens without it.' && mRow.badge === TEXT.looksUnique && uRow && uRow.badge !== TEXT.looksUnique, mRow);
    check(`${tag} Instagram: a line under the intro explains Unrecognised`, /^Parts marked Unrecognised are not on CheckLink's verified lists for this kind of page, so CheckLink cannot say what they tell\./.test(st.unrecognisedHelp || ''), st.unrecognisedHelp);
    check(`${tag} Instagram: the badges and the Unrecognised word stay inside their rows`, await p.ev("[...document.querySelectorAll('.cl-badge, .cl-tag')].every((b) => b.getBoundingClientRect().right <= b.closest('.cl-part').getBoundingClientRect().right + 0.5)"), null);
    check(`${tag} Instagram: the word Unrecognised sits straight after the name (or under it on a narrow line), not across the row`, await p.ev(`(() => {
      const row = document.querySelector('label.cl-part[data-part="${mdxt.id}"]');
      const n = row.querySelector('.cl-part-name').getBoundingClientRect();
      const t = row.querySelector('.cl-tag').getBoundingClientRect();
      const sameLine = Math.abs(t.top - n.top) < n.height && t.left >= n.right && t.left - n.right < 24;
      const under = t.top >= n.bottom - 1 && Math.abs(t.left - n.left) < 2;
      return sameLine || under;
    })()`), null);
    await p.shot(`${tag}-7f-instagram`);
    await p.click(`label.cl-part[data-part="${mdxt.id}"] .cl-part-name`);
    st = await p.state();
    ex = expected(INSTAGRAM, ex.a.defaultRemoved.filter((id) => id !== mdxt.id));
    check(`${tag} Instagram: unticking the unknown parameter keeps it byte for byte, and takes it out of red`, st.clean === 'https://www.instagram.com/p/DeTqc0NDifd/?unknownid=NTc4MTIwNjQ2YQ==' && st.clean === ex.clean && J(st.fullDel) === J(ex.outer) && !st.rows.find((r) => r.id === mdxt.id).ticked, { clean: st.clean, dels: st.fullDel });
    await p.click('#copy-btn');
    await p.waitFor(`document.getElementById('action-status').textContent === ${J(TEXT.copied)}`, 2000);
    st = await p.state();
    check(`${tag} Instagram: Copy copies the choice as shown`, st.clips.at(-1).text === 'https://www.instagram.com/p/DeTqc0NDifd/?unknownid=NTc4MTIwNjQ2YQ==', st.clips.at(-1));
    await p.clearBox();
    await p.paste(IG_PROFILE).catch(async () => { await p.type(IG_PROFILE); await sleep(400); });
    st = await p.state();
    check(`${tag} Instagram profile: nothing to remove, the link stays as written, no Unrecognised line`, st.clean === IG_PROFILE && !st.rows.length && st.unrecognisedHelp === null, { clean: st.clean, rows: st.rows.length, help: st.unrecognisedHelp });

    // 7g. TikTok s on a video: a protected short name, so Unrecognised but unticked.
    await p.clearBox();
    await p.paste(TIKTOK_S).catch(async () => { await p.type(TIKTOK_S); await sleep(400); });
    st = await p.state();
    ex = expected(TIKTOK_S);
    const sPart = ex.a.parts.find((x) => x.name === 's');
    const tsRow = st.rows.find((r) => r.id === sPart.id);
    let myRow = st.rows.find((r) => r.id === ex.a.parts.find((x) => x.name === 'mystery').id);
    check(`${tag} TikTok: s is Unrecognised but unticked, with its own explanation and the "kept unless you tick it" note; mystery is ticked`, tsRow && !tsRow.checked && !tsRow.ticked && tsRow.unrec === 'Unrecognised' && tsRow.edge === 'dashed' && tsRow.told === 'Not on the verified lists for this kind of page. Short names like this one often choose what a page shows.' && tsRow.note === 'Kept unless you tick it: the page may need it.' && myRow && myRow.checked && myRow.ticked, { s: tsRow, mystery: myRow });
    check(`${tag} TikTok: the clean link keeps s byte for byte, as the engine gives it, and the help line is shown`, st.clean === 'https://www.tiktok.com/@stormberry/video/7420000000000000000?s=2' && st.clean === ex.clean && !!st.unrecognisedHelp, { clean: st.clean, help: st.unrecognisedHelp });
    await p.click(`label.cl-part[data-part="${sPart.id}"] .cl-part-name`);
    st = await p.state();
    check(`${tag} TikTok: one tick removes s`, st.clean === 'https://www.tiktok.com/@stormberry/video/7420000000000000000' && st.clean === expected(TIKTOK_S, [...ex.a.defaultRemoved, sPart.id]).clean, st.clean);

    // TikTok t on a video (spec decision 23): ticked by default, under its own plain label,
    // not Unrecognised; one click keeps it byte for byte.
    await p.clearBox();
    await p.paste(TIKTOK_T).catch(async () => { await p.type(TIKTOK_T); await sleep(400); });
    st = await p.state();
    ex = expected(TIKTOK_T);
    const tPart = ex.a.parts.find((x) => x.name === 't');
    const tRow = st.rows.find((r) => r.id === tPart.id);
    myRow = st.rows.find((r) => r.id === ex.a.parts.find((x) => x.name === 'mystery').id);
    check(`${tag} TikTok: t is ticked, labelled "Timestamp" with its own explanation, solid and not Unrecognised; mystery is ticked`, tRow && tRow.checked && tRow.ticked && tRow.unrec === null && tRow.edge === 'solid' && tRow.provider === 'Timestamp' && tRow.told === tPart.reveals && tRow.who === 'Who learns it: TikTok' && tRow.note === null && myRow && myRow.checked && myRow.ticked, { t: tRow, mystery: myRow });
    check(`${tag} TikTok: the clean link drops t, as the engine gives it`, st.clean === 'https://www.tiktok.com/@stormberry/video/7420000000000000000' && st.clean === ex.clean, st.clean);
    await p.click(`label.cl-part[data-part="${tPart.id}"] .cl-part-name`);
    st = await p.state();
    check(`${tag} TikTok: unticking t keeps it byte for byte`, st.clean === 'https://www.tiktok.com/@stormberry/video/7420000000000000000?t=1700000000' && st.clean === expected(TIKTOK_T, ex.a.defaultRemoved.filter((id) => id !== tPart.id)).clean, st.clean);

    // 7h. Kept on purpose (spec 8): Marcos's YouTube link. t=354 stays, marked with a grey
    // dotted underline, explained as a start time, with an unticked "Remove anyway" box.
    await p.clearBox();
    await p.paste(YT).catch(async () => { await p.type(YT); await sleep(400); });
    st = await p.state();
    ex = expected(YT);
    const tKept = ex.a.kept.find((k) => k.name === 't');
    let kRow = st.keptRows.find((r) => r.id === tKept.id);
    check(`${tag} YouTube: t=354 stays in the clean link and has a "Kept on purpose" row`, st.clean === 'https://youtu.be/WgewEn1mFPs?t=354' && st.keptBlock && st.keptRows.length === 1 && !!kRow, { clean: st.clean, rows: st.keptRows });
    check(`${tag} YouTube: the row says "Start time: opens the video at 5:54. It does not identify you."`, kRow && kRow.explain === 'Start time: opens the video at 5:54. It does not identify you.' && kRow.name === 't' && kRow.value === '=\u00A0354', kRow);
    check(`${tag} YouTube: its box is unticked, reads "Remove anyway", and is labelled and described`, kRow && !kRow.checked && !kRow.ticked && kRow.anyway === TEXT.removeAnyway && kRow.label === 'Remove anyway t' && kRow.labelled && kRow.described && kRow.edge === 'dotted', kRow);
    check(`${tag} YouTube: t=354 has a grey dotted underline in the full link, apart from the amber of unticked parts`, J(st.fullFunc) === J([{ text: 't=354', part: tKept.id }]) && st.funcDecoration === 'dotted' && st.funcColour === 'rgb(154, 145, 174)' && !st.fullKept.length, { func: st.fullFunc, deco: st.funcDecoration, colour: st.funcColour });
    // The legend lists only the marks the link carries (batch 3 interface review finding 10):
    // no unticked part yet, so no boxed line.
    check(`${tag} YouTube: the legend gains the third style and leaves out the mark the link does not have`, st.legend.length === 4 && st.legend.includes('Dotted underline, no box: kept on purpose, because the page needs it. Each one is explained under Kept on purpose.') && !st.legend.some((x) => x.startsWith('Dotted underline in a dashed box: ')), st.legend);
    await p.shot(`${tag}-7h-youtube-kept`);
    // Unticking si adds the boxed mark and its legend line; the two marks differ in shape
    // (a dashed box) as well as colour (finding 1, WCAG 1.4.1).
    const siPart = ex.a.parts.find((x) => x.name === 'si');
    await p.click(`label.cl-part[data-part="${siPart.id}"] .cl-part-name`);
    st = await p.state();
    const marks = await p.ev(`(() => { const k = document.querySelector('#full-link .cl-kept-part'); const f = document.querySelector('#full-link .cl-func-part'); const o = (el) => el ? { style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth } : null; return { kept: o(k), func: o(f) }; })()`);
    check(`${tag} YouTube: an unticked si is boxed, t=354 is not, and the legend gains the boxed line`, !!marks.kept && marks.kept.style === 'dashed' && !!marks.func && marks.func.style === 'none' && st.legend.length === 5 && st.legend.some((x) => x.startsWith('Dotted underline in a dashed box: ')), { marks, legend: st.legend });
    await p.click(`label.cl-part[data-part="${siPart.id}"] .cl-part-name`);
    st = await p.state();
    check(`${tag} YouTube: ticking si again takes the boxed line away`, st.legend.length === 4 && !st.fullKept.length, st.legend);
    await p.click(`label.cl-part[data-kept="${tKept.id}"] .cl-part-name`);
    st = await p.state();
    ex = expected(YT, [...ex.a.defaultRemoved, tKept.id]);
    kRow = st.keptRows.find((r) => r.id === tKept.id);
    check(`${tag} YouTube: ticking "Remove anyway" takes t out, red and struck through, and the row turns red`, st.clean === 'https://youtu.be/WgewEn1mFPs' && st.clean === ex.clean && J(st.fullDel) === J(ex.outer) && st.fullDel.some((d) => d.part === tKept.id) && !st.fullFunc.length && kRow.checked && kRow.ticked, { clean: st.clean, dels: st.fullDel, row: kRow });
    // The count follows Remove anyway too (finding 15).
    check(`${tag} YouTube: the count says a kept part was removed anyway`, st.count === '1 part found, 1 ticked to remove. 1 kept part removed anyway.', st.count);
    await p.click('#copy-btn');
    await p.waitFor(`document.getElementById('action-status').textContent === ${J(TEXT.copied)}`, 2000);
    st = await p.state();
    check(`${tag} YouTube: Copy copies the choice as shown`, st.clips.at(-1).text === 'https://youtu.be/WgewEn1mFPs', st.clips.at(-1));
    // C: the report line sits under Go to, and its message follows the choice.
    let mail = st.report && readMailto(st.report.href);
    check(`${tag} report: "Did CheckLink break your link? Email us" sits under "Opens in a new tab, in this browser."`, !!st.report && st.report.line === TEXT.reportLine && await p.ev("document.getElementById('go-help').nextElementSibling.id === 'report-line'"), st.report);
    check(`${tag} report: the message names the original as written and the clean link as shown, and the rules date`, !!mail && mail.subject === 'CheckLink: a cleaned link broke' && mail.body.includes(`\r\nOriginal link: ${YT}\r\n`) && mail.body.includes("\r\nCheckLink's clean link: https://youtu.be/WgewEn1mFPs\r\n") && mail.body.includes('What went wrong (optional):') && mail.body.endsWith(`Rules dated ${RULES_DATE}`) && mail.body.startsWith('Before you send: the original link may hold personal parts'), mail);
    await p.click(`label.cl-part[data-kept="${tKept.id}"] .cl-part-name`);
    st = await p.state();
    mail = readMailto(st.report.href);
    check(`${tag} YouTube: unticking brings t back, in the link, the row and the message`, st.clean === 'https://youtu.be/WgewEn1mFPs?t=354' && st.fullFunc.length === 1 && !st.keptRows[0].checked && mail.body.includes("CheckLink's clean link: https://youtu.be/WgewEn1mFPs?t=354\r\n"), { clean: st.clean, body: mail.body });
    await noLinkTo(p, `${tag} YouTube with the report line`, [YT]);

    // 7i. A recipient token: kept on purpose with its own warning words; the message leaves
    // the original out; removing it anyway lets Share back in and the clean link into the message.
    await p.clearBox();
    await p.paste(UNSUB).catch(async () => { await p.type(UNSUB); await sleep(400); });
    st = await p.state();
    ex = expected(UNSUB);
    const tok = ex.a.kept.find((k) => k.name === 'mkt_tok');
    mail = readMailto(st.report.href);
    check(`${tag} recipient token: kept on purpose, explained as identifying you, never "does not identify you"`, st.keptRows.length === 1 && st.keptRows[0].explain === 'Kept because this unsubscribe or preferences page needs it. This part identifies you; do not share this link.', st.keptRows);
    check(`${tag} recipient token: the message leaves both links out and says why`, /^Original link: left out, because it holds a part that identifies the person it was sent to\./m.test(mail.body) && /^CheckLink's clean link: left out, because/m.test(mail.body) && !mail.body.includes('abc123zz'), mail.body);
    await p.click(`label.cl-part[data-kept="${tok.id}"] .cl-part-name`);
    st = await p.state();
    mail = readMailto(st.report.href);
    check(`${tag} recipient token removed anyway: the clean link drops it, ${share ? 'Share comes back, ' : ''}and goes into the message`, st.clean === 'https://example.com/unsubscribe' && st.share === share && st.shareNote === null && mail.body.includes("CheckLink's clean link: https://example.com/unsubscribe\r\n") && !mail.body.includes('abc123zz'), { clean: st.clean, share: st.share, note: st.shareNote, body: mail.body });

    // 7j. A reset link is left untouched, so nothing is removed and the report line is not
    // offered (finding 15: CheckLink changed nothing that could break); the engine keeps both
    // links out of the message anyway (tests/batch3-security.test.mjs F1).
    await p.clearBox();
    await p.paste(RESET).catch(async () => { await p.type(RESET); await sleep(400); });
    st = await p.state();
    check(`${tag} reset link: nothing is removed, so the report line is not offered`, st.report === null && st.clean === RESET, { report: st.report, clean: st.clean });

    // 7k. Maps (spec 10 and 18): the neutral note, Pin only as a second copy option and
    // Place only as a third.
    for (const [label, link, note, pinLink, placeLink] of [
      ['Maps category', MAPS_A, "Good to know: This map address also holds something Maps picked up on the way to this place: a category or search words ('Vacation rentals'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.", 'https://www.google.com/maps/@60.4211807,5.2337099,17z', PLACE_A],
      ['Maps earlier place', MAPS_B, "Good to know: This map address also holds something Maps picked up on the way to this place: a place viewed earlier ('Kleppest\u00F8'). Cutting it could break the link, so CheckLink leaves it in. Pin only and Place only, under the clean link, leave it out.", 'https://www.google.com/maps/@60.4103774,5.2268809,17z', PLACE_B],
    ]) {
      await p.clearBox();
      await p.paste(link).catch(async () => { await p.type(link); await sleep(400); });
      st = await p.state();
      ex = expected(link);
      const li = await p.ev(`(() => { const li = document.querySelector('#warn-list [data-warning="maps-context"]'); return li ? { text: li.textContent, tier: li.dataset.tier || null } : null; })()`);
      check(`${tag} ${label}: a neutral "Good to know" note names the context, never "your search"`, !!li && li.text === note && li.tier === null && !/your search/i.test(li.text) && st.noWarnings, li);
      check(`${tag} ${label}: the place link stays the clean link`, st.clean === ex.clean && !st.clean.includes('?'), st.clean);
      check(`${tag} ${label}: "Pin only" offers the place's own coordinates, as text, not a link`, !!st.pin && st.pin.link === pinLink && await p.ev("!document.querySelector('#pin-card a')"), st.pin);
      check(`${tag} ${label}: the Pin only help is in plain words`, await p.ev("document.getElementById('pin-help').textContent") === "A second link to the same spot. It opens the map at this location, without the place's own page and without the context above.", await p.ev("document.getElementById('pin-help').textContent"));
      await p.click('#pin-copy');
      await p.waitFor(`document.getElementById('pin-status').textContent !== ''`, 2000);
      st = await p.state();
      check(`${tag} ${label}: Copy pin only copies exactly that link and says so`, st.clips.at(-1).text === pinLink && st.pin.status === TEXT.pinCopied, { clip: st.clips.at(-1), status: st.pin.status });
      check(`${tag} ${label}: "Place only" offers the place's own cid link, as text, not a link`, !!st.place && st.place.link === placeLink && st.place.status === '' && await p.ev("!document.querySelector('#place-card a')"), st.place);
      check(`${tag} ${label}: the Place only card is titled and worded plainly`, !!st.place && st.place.title === 'Place only' && st.place.help === PLACE_HELP && st.place.button === 'Copy place only', st.place);
      check(`${tag} ${label}: the three options come in order: clean link, Pin only, Place only`, await p.ev("(() => { const c = document.getElementById('clean-card'), pin = document.getElementById('pin-card'), pl = document.getElementById('place-card'); return !!(c.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(pin.compareDocumentPosition(pl) & Node.DOCUMENT_POSITION_FOLLOWING) && pl.getBoundingClientRect().top >= pin.getBoundingClientRect().bottom; })()"));
      await p.click('#place-copy');
      await p.waitFor(`document.getElementById('place-status').textContent !== ''`, 2000);
      st = await p.state();
      check(`${tag} ${label}: Copy place only copies exactly that link and says so`, st.clips.at(-1).text === placeLink && st.place.status === TEXT.placeCopied && st.clean === ex.clean, { clip: st.clips.at(-1), status: st.place.status, clean: st.clean });
      await p.shot(`${tag}-7k-${label.replace(/\s+/g, '-').toLowerCase()}`);
    }
    // Place only is offered only when a feature ID pairs with the final coordinates.
    await p.clearBox();
    await p.paste(MAPS_PIN_ONLY).catch(async () => { await p.type(MAPS_PIN_ONLY); await sleep(400); });
    st = await p.state();
    check(`${tag} Maps with no feature ID paired with the final coordinates: Pin only stays, Place only is not offered`, !!st.pin && st.pin.link === 'https://www.google.com/maps/@60.4,5.2,17z' && st.place === null && await p.ev("document.getElementById('place-link').textContent === ''"), { pin: st.pin, place: st.place });
    await p.clearBox();
    await p.paste(MAPS_NO_ID).catch(async () => { await p.type(MAPS_NO_ID); await sleep(400); });
    st = await p.state();
    check(`${tag} Maps with no feature ID at all: only the clean link, no Pin only and no Place only`, st.clean === MAPS_NO_ID && st.pin === null && st.place === null, { clean: st.clean, pin: st.pin, place: st.place });
    await p.clearBox();
    await p.paste(MAPS_B).catch(async () => { await p.type(MAPS_B); await sleep(400); });
    // The page-wide wording check reads the full link too, and a Maps data= blob is full of
    // '!' separators, so the Place only card's own words are checked on their own here.
    const placeWords = await p.ev(`(() => { const c = document.getElementById('place-card').cloneNode(true); for (const el of c.querySelectorAll('.cl-addr')) el.remove(); return c.textContent.replace(/\\s+/g, ' ').trim(); })()`);
    check(`${tag} Place only words: no dashes or double hyphens, no exclamation marks, never "safe", British spelling`, placeWords.includes('Place only') && !/[–—!]|--/.test(placeWords) && !/\bsafe/i.test(placeWords) && !/\b(color|organiz|gray|center|favorite|behavior|analyz|customiz|recogniz)/i.test(placeWords), placeWords);
    await p.clearBox();
    await p.paste(PLAIN).catch(async () => { await p.type(PLAIN); await sleep(400); });
    st = await p.state();
    check(`${tag} Maps: Place only goes away for a link that is not a Maps place`, st.place === null && st.pin === null, { pin: st.pin, place: st.place });
    await noLinkTo(p, `${tag} Maps`, [MAPS_A, MAPS_B, MAPS_PIN_ONLY, MAPS_NO_ID, 'https://www.google.com/maps/@60.4103774,5.2268809,17z', PLACE_A, PLACE_B]);

    // 7l. The address disguise (build 1): no "Who learns it", a Check badge, the explanation.
    await p.clearBox();
    await p.paste(DISGUISE).catch(async () => { await p.type(DISGUISE); await sleep(400); });
    st = await p.state();
    ex = expected(DISGUISE);
    const dRow = st.rows.find((r) => r.id === 'u0');
    check(`${tag} disguise: one ticked row named "Address disguise", with a Check badge and no "Who learns it" line`, st.rows.length === 1 && dRow && dRow.checked && dRow.name === 'Address disguise' && dRow.badge === TEXT.disguiseBadge && dRow.kind === 'check' && dRow.who === null && dRow.provider === null && dRow.value === null && dRow.labelled && dRow.described, dRow);
    check(`${tag} disguise: the row explains it in the agreed words, and the clean link drops it`, dRow && dRow.told === ex.a.parts[0].reveals && /^Everything before @ is not where this goes\. It is there to make the address look like convincing-business-related-page-name-pretending-to-be-on-google\.com\. The link goes to kaspersky\.com\.$/.test(dRow.told) && st.clean === 'http://kaspersky.com/blog/' && st.warnings.includes('at-trick') && st.warnings.includes('not-encrypted'), { told: dRow && dRow.told, clean: st.clean, warnings: st.warnings });
    await p.shot(`${tag}-7l-disguise`);

    // 7m. A sharer ID (build 1): its own badge.
    await p.clearBox();
    await p.paste(SHARER).catch(async () => { await p.type(SHARER); await sleep(400); });
    st = await p.state();
    const sRow = st.rows.find((r) => r.name === 'mdxt');
    check(`${tag} sharer ID: mdxt says "Tied to the sharer" and "Who learns it: Meta"`, sRow && sRow.badge === TEXT.sharer && sRow.kind === 'sharer' && sRow.sharer && sRow.who === 'Who learns it: Meta' && sRow.provider === 'Instagram sharer ID' && sRow.checked, sRow);
    await p.shot(`${tag}-7m-sharer`);

    // 7n. Search engines (build 1): rows as the engine gives them, the search words kept on purpose.
    for (const link of SEARCHES) {
      await p.clearBox();
      await p.paste(link).catch(async () => { await p.type(link); await sleep(400); });
      st = await p.state();
      ex = expected(link);
      const host = new URL(link).hostname;
      check(`${tag} ${host}: one ticked row per part, named, with who learns it, and the clean link`, J(st.rows.map((r) => [r.id, r.checked])) === J(ex.a.parts.map((x) => [x.id, x.defaultRemove])) && st.rows.every((r, i) => r.provider === (rowLabel(ex.a.parts[i]) || null) && r.who && r.who.startsWith('Who learns it: ') && r.told === ex.a.parts[i].reveals) && st.clean === ex.clean, { rows: st.rows.map((r) => [r.id, r.checked, r.who]), clean: st.clean });
      check(`${tag} ${host}: q is kept on purpose as the search itself`, st.keptRows.some((r) => r.name === 'q' && r.explain === 'The search itself. Everyone who gets this link can read what was searched for.' && !r.checked), st.keptRows);
    }
    await p.shot(`${tag}-7n-search`);

    // 7o. Batch 3 interface review fixes (10 October 2026).
    // Sign-in details before @ (finding 5): their own name and badge, never "look like admin".
    await p.clearBox();
    await p.paste(SIGNIN).catch(async () => { await p.type(SIGNIN); await sleep(400); });
    st = await p.state();
    ex = expected(SIGNIN);
    const siRow = st.rows.find((r) => r.id === 'u0');
    check(`${tag} sign-in details: named as such, badged "${TEXT.signinBadge}", explained without "look like", and dropped from the clean link`, !!siRow && siRow.name === 'Sign-in details in the address' && siRow.badge === TEXT.signinBadge && siRow.who === null && siRow.told === ex.a.parts[0].reveals && !/look like/.test(siRow.told) && siRow.checked && st.clean === 'https://login.example.com/', siRow);
    // Empty pairs (finding 8): "Empty part", no "Who learns it", no badge.
    await p.clearBox();
    await p.paste(NAVER_EMPTY).catch(async () => { await p.type(NAVER_EMPTY); await sleep(400); });
    st = await p.state();
    const empties = st.rows.filter((r) => r.empty);
    check(`${tag} Naver: empty parts read "Empty part" with no "Who learns it" line and no badge, and still describe the box`, empties.length === 2 && empties.every((r) => r.provider === TEXT.emptyLabel && r.who === null && !r.badge && r.told === 'It holds nothing, so the page opens the same without it.' && r.described && r.checked), empties);
    // A run of identical rows (finding 6): the later ones say "Same kind as the part above",
    // and keep the full text for a screen reader.
    await p.clearBox();
    await p.paste(BAIDU_RUN).catch(async () => { await p.type(BAIDU_RUN); await sleep(400); });
    st = await p.state();
    ex = expected(BAIDU_RUN);
    const [firstRun, ...restRun] = st.rows;
    check(`${tag} Baidu: the first row explains, the next three say "Same kind as the part above" and keep the words for screen readers`, st.rows.length === 4 && firstRun.same === null && firstRun.shownTold === ex.a.parts[0].reveals && restRun.every((r) => r.same === TEXT.sameKind && r.shownTold === null && r.shownWho === null && r.told === ex.a.parts[0].reveals && r.who === 'Who learns it: Baidu' && r.described), st.rows.map((r) => [r.name, r.same, r.shownTold, r.described]));
    const runAx = await p.ev(`document.getElementById('part-${ex.a.parts[1].id}').getAttribute('aria-describedby').split(' ').map((x) => document.getElementById(x).textContent).join(' | ')`);
    check(`${tag} Baidu: a folded row is still described by its label, who learns it and what it tells`, runAx.includes(ex.a.parts[1].reveals) && runAx.includes('Who learns it: Baidu') && !runAx.includes(TEXT.sameKind), runAx);
    // Four kept parts CheckLink can vouch for (finding 9): said once in the intro.
    await p.clearBox();
    await p.paste(PLAYLIST).catch(async () => { await p.type(PLAYLIST); await sleep(400); });
    st = await p.state();
    const intro = await p.ev("document.getElementById('kept-intro').textContent");
    check(`${tag} playlist: "None of these identify you." once in the intro, not on each of the four rows`, intro.endsWith('None of these identify you.') && st.keptRows.length === 4 && st.keptRows.every((r) => !r.explain.includes('It does not identify you.')) && st.keptRows.some((r) => r.explain === 'Start time: opens the video at 0:30.'), { intro, rows: st.keptRows.map((r) => r.explain) });
    // "Remove anyway" sits next to the name, not at the far end of the row (finding 3).
    const gap = await p.ev(`(() => { const row = document.querySelector('#kept-list .cl-kept-row'); const n = row.querySelector('.cl-part-name').getBoundingClientRect(); const a = row.querySelector('.cl-anyway').getBoundingClientRect(); return Math.round(a.top >= n.bottom - 1 ? a.left - n.left : a.left - n.right); })()`);
    check(`${tag} playlist: "Remove anyway" sits within 24 pixels of the name (${gap})`, gap >= 0 && gap <= 24, gap);
    // An address the page needs (finding 15): only good to know.
    await p.clearBox();
    await p.paste(GOGGLE).catch(async () => { await p.type(GOGGLE); await sleep(400); });
    const gog = await p.ev(`(() => { const li = document.querySelector('#warn-list [data-warning="hidden-address"]'); return li ? { text: li.textContent, tier: li.dataset.tier || null } : null; })()`);
    check(`${tag} Brave Goggle: the address goggles_id holds is "Good to know", not something to check`, !!gog && gog.tier === null && gog.text.startsWith('Good to know: ') && /which the page needs/.test(gog.text), gog);
    // Nothing removed: no report line (finding 15).
    await p.clearBox();
    await p.paste(PLAIN).catch(async () => { await p.type(PLAIN); await sleep(400); });
    st = await p.state();
    check(`${tag} a link with nothing to remove: the report line is not offered`, st.report === null && st.clean === PLAIN, st.report);
    // The page follows the browser's own text size, and badges are not full pills (findings 13 and 14).
    const sizing = await p.ev(`(() => { let root = null; for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) if (r.selectorText === 'html' && r.style.fontSize) root = r.style.fontSize; } catch {} } return { root, computed: getComputedStyle(document.documentElement).fontSize }; })()`);
    check(`${tag} the root text size is 100% (the browser's setting), 16 pixels by default`, sizing.root === '100%' && sizing.computed === '16px', sizing);
    await p.clearBox();
    await p.paste(GOOGLE).catch(async () => { await p.type(GOOGLE); await sleep(400); });
    const radius = await p.ev("getComputedStyle(document.querySelector('.cl-badge')).borderTopLeftRadius");
    check(`${tag} badges have rounded corners rather than a pill that clips wrapped words (${radius})`, parseFloat(radius) > 0 && parseFloat(radius) < 20, radius);

    // 8. Text with two links: the first is analysed, the other listed and checkable.
    await p.clearBox();
    await p.paste(TWO).catch(async () => { await p.type(TWO); await sleep(400); });
    st = await p.state();
    check(`${tag} text with two links: the first is analysed and the second listed`, st.summary === `A web address, found in your text. ${TEXT.nothingOpened}` && st.full === 'https://example.com/a?utm_source=x&id=2' && J(st.others) === J(['www.example.no/side?fbclid=abc']), { summary: st.summary, full: st.full, others: st.others });
    await p.click('#others-block button[data-use="other"]');
    st = await p.state();
    const boxValue = await p.ev("document.getElementById('link-input').value");
    check(`${tag} "Check this link" checks the second one, read as https://`, boxValue === 'www.example.no/side?fbclid=abc' && st.clean === 'www.example.no/side' && st.go === 'Go to www.example.no' && st.warnings.includes('no-scheme'), { boxValue, clean: st.clean, go: st.go });
    await p.click('#go-btn');
    st = await p.state();
    check(`${tag} Go to opens a link written without a scheme as https://`, st.opened.at(-1).url === 'https://www.example.no/side', st.opened.at(-1));

    // 9. Not a web address at all.
    await p.clearBox();
    await p.type('javascript:alert(1)');
    await p.waitFor("document.getElementById('summary-line').textContent.startsWith('Not a web address')", 3000);
    st = await p.state();
    check(`${tag} javascript: a Stop notice, no link, no clean link, no buttons`, !!st.stop && /never opens it/.test(st.stop) && st.clean === null && st.go === null && !st.copy, { stop: st.stop, clean: st.clean, go: st.go, copy: st.copy });
    await p.clearBox();
    await p.type('hello there');
    await p.waitFor("document.getElementById('summary-line').textContent.startsWith('No web address')", 3000);
    st = await p.state();
    check(`${tag} plain text: "No web address found"`, st.summary === 'No web address found. Paste a link that starts with http://, https:// or www.' && st.clean === null, st.summary);

    // 10. Clear empties everything.
    await p.click('#clear-btn');
    st = await p.state();
    const afterClear = await p.ev("({ value: document.getElementById('link-input').value, focus: document.activeElement.id })");
    check(`${tag} Clear empties the box, hides the result and leaves focus in the box`, !st.result && afterClear.value === '' && afterClear.focus === 'link-input', afterClear);

    // 11. The longest input the box takes, with 4,994 parts: the page stays usable. The
    // text is put in the box as a paste would put it, then one box is ticked and unticked.
    const many = await p.ev(`(() => {
      const t = document.getElementById('link-input');
      t.value = ${J(MANY)};
      const t0 = performance.now();
      t.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
      return new Promise((res) => setTimeout(() => {
        const shown = performance.now() - t0;
        const boxes = document.querySelectorAll('#parts-list .cl-check');
        const t1 = performance.now();
        boxes[1].click();
        const tick = performance.now() - t1;
        boxes[1].click();
        res({ shown: Math.round(shown), tick: Math.round(tick), rows: boxes.length });
      }, 0));
    })()`);
    check(`${tag} 20,000 characters and ${many.rows} parts: shown in ${many.shown} ms, a tick takes ${many.tick} ms (limits 2,500 and 500)`, many.rows === analyse(MANY).parts.length && many.shown < 2500 && many.tick < 500, many);
    await p.clearBox();

    // 12. Text twice the size: nothing spills sideways, the badges wrap.
    await p.paste(GOOGLE).catch(async () => { await p.type(GOOGLE); await sleep(400); });
    const big = await p.ev(`(() => {
      document.documentElement.style.fontSize = '200%';
      const vw = document.documentElement.clientWidth;
      const sw = document.documentElement.scrollWidth;
      const bad = [...document.querySelectorAll('.cl-badge')].filter((b) => b.getBoundingClientRect().right > b.closest('.cl-part').getBoundingClientRect().right + 0.5).length;
      document.documentElement.style.fontSize = '';
      return { vw, sw, bad };
    })()`);
    check(`${tag} with text at 200%, no sideways scrolling and no badge outside its row`, big.sw <= big.vw && big.bad === 0, big);
    if (w === 360) {
      // The narrowest phones: 320 pixels at the normal text size, for the Google link and
      // for every new kind of row: kept on purpose, Maps and Pin only, the disguise, the
      // sharer ID and the search engines.
      await p.s('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
      await sleep(200);
      const narrowCheck = `(() => {
        const vw = document.documentElement.clientWidth;
        const out = [...document.querySelectorAll('main *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > vw + 0.5 || b.left < -0.5); }).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0]).slice(0, 6);
        const bad = [...document.querySelectorAll('.cl-badge, .cl-tag, .cl-anyway')].filter((b) => b.getBoundingClientRect().right > b.closest('.cl-part').getBoundingClientRect().right + 0.5).length;
        return { vw, sw: document.documentElement.scrollWidth, bad, out };
      })()`;
      for (const [label, link] of [['Google', GOOGLE], ['YouTube kept', YT], ['Maps', MAPS_B], ['disguise', DISGUISE], ['sharer', SHARER], ...SEARCHES.map((l) => [new URL(l).hostname, l]), ['hidden address with a long host', HIDDEN_LONG], ['sign-in details', SIGNIN], ['Baidu run', BAIDU_RUN], ['Naver empty parts', NAVER_EMPTY]]) {
        if (link !== GOOGLE) {
          await p.clearBox();
          await p.paste(link).catch(async () => { await p.type(link); await sleep(400); });
        }
        const narrow = await p.ev(narrowCheck);
        check(`${tag} at 320 pixels wide (${label}), no sideways scrolling, nothing wider than the screen and no badge outside its row`, narrow.sw <= narrow.vw && narrow.bad === 0 && !narrow.out.length, narrow);
      }
      // 390 pixels with text at 200%: Brave's Goggle address inside its card (finding 2).
      await p.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
      await sleep(200);
      await p.clearBox();
      await p.paste(GOGGLE).catch(async () => { await p.type(GOGGLE); await sleep(400); });
      const bigGoggle = await p.ev(`(() => {
        document.documentElement.style.fontSize = '200%';
        const vw = document.documentElement.clientWidth;
        const r = { vw, sw: document.documentElement.scrollWidth, out: [...document.querySelectorAll('main *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && b.right > vw + 0.5; }).map((el) => el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]).slice(0, 6) };
        document.documentElement.style.fontSize = '';
        return r;
      })()`);
      check(`${tag} at 390 pixels with text at 200% (Brave Goggle), no sideways scrolling`, bigGoggle.sw <= bigGoggle.vw && !bigGoggle.out.length, bigGoggle);
      await p.s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(200);
    }
    await p.clearBox();

    // Whole-page checks.
    await p.paste(GOOGLE).catch(async () => { await p.type(GOOGLE); await sleep(400); });
    await textChecks(p, `${tag} with a result`);
    const layout = await p.ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      for (const el of document.querySelectorAll('main *, .site-footer *')) {
        const b = el.getBoundingClientRect();
        if (!b.width) continue;
        if (b.right > vw + 0.5 || b.left < -0.5) bad.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ')[0]);
      }
      return { sw: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 6) };
    })()`);
    check(`${tag} no sideways scrolling, nothing wider than the screen`, layout.sw <= layout.vw && !layout.bad.length, layout);
    await noLinkTo(p, `${tag} after every scenario`, ALL_LINKS);
    // Stage 5: the one thing stored is the first-run notice's flag, the time it was closed.
    const stored = await p.ev("({ keys: Object.keys(localStorage), flag: localStorage.getItem('sb-gate:checklink:v2'), session: sessionStorage.length, cookie: document.cookie })");
    check(`${tag} the first-run notice showed on this first visit, and closing it stored its one flag and nothing else: no other localStorage, no sessionStorage, no cookies`, p.gateShown && J(stored.keys) === J(['sb-gate:checklink:v2']) && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(stored.flag) && stored.session === 0 && stored.cookie === '', stored);
    const csp = await p.ev('window.__csp');
    check(`${tag} no policy violations`, csp.length === 0, csp);
    check(`${tag} no errors in the console`, p.log.errors.length === 0, p.log.errors);
    check(`${tag} nothing fetched from elsewhere`, p.log.offsite.length === 0, p.log.offsite);
    const fetched = [...new Set(p.log.requests.map((r) => new URL(r.url).pathname))].sort();
    // (The ecosystem carousel's icons are the page's own files too: /switcher-icons/*.svg.)
    // Stage 2 adds the Public Suffix List, the inspector, the decoder worker and the vendored
    // decoder, all loaded with the page.
    const OWN = ['/', '/app.js', '/style.css', '/favicon.svg', '/fonts/inter/inter.css', '/fonts/inter/InterVariable.woff2', '/src/link-core.js', '/src/rules.js', '/src/row-words.js',
      '/src/domain.js', '/src/psl.js', '/src/qr-inspect.js', '/src/payload-codecs.js', '/src/bip39.js', '/src/wordlists.js', '/src/image-check.js', '/src/qr-worker.js', '/src/worker-lockdown.js', '/src/qr-decode.js',
      '/vendor/zxing-wasm-3.1.4/es/reader/index.js', '/vendor/zxing-wasm-3.1.4/es/share.js', '/vendor/zxing-wasm-3.1.4/zxing_reader.wasm.js',
      // Stage 3: the look-alike checks and their two tables.
      '/src/lookalike.js', '/src/confusables.js', '/src/brands.js',
      // Stage 4b: the QR code of the clean link and its encoder, loaded with the page.
      '/src/qr-make.js', '/vendor/qrcodegen-8329a71/qrcodegen.js',
      // Stage 5: the first-run notice.
      '/gate.js', '/gate.css'];
    check(`${tag} only the page's own files were requested`, fetched.every((f) => OWN.includes(f) || /^\/switcher-icons\/[a-z]+\.svg$/.test(f)), fetched);
    check(`${tag} the decoder worker's own files were recorded (its session is watched too)`, fetched.includes('/vendor/zxing-wasm-3.1.4/zxing_reader.wasm.js'), fetched);
    const scripted = p.log.requests.filter((r) => ['Fetch', 'XHR', 'EventSource', 'WebSocket', 'Ping'].includes(r.type));
    check(`${tag} no fetch, XHR, beacon or socket`, !scripted.length, scripted);
    await p.shot(`${tag}-6-final`);
    await p.close();
  }

  // ---- Stage 2: pictures -----------------------------------------------------------------
  const QR_LINK = 'https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&utm_campaign=autumn&id=42';
  for (const [w, h] of [[360, 780], [1280, 900]]) {
    const p = await openPage(w, h, { init: shareStub({ share: false, clipboard: true, open: true }) });
    const tag = `w${w} picture`;
    await sleep(600);
    const settled = p.log.requests.length;
    let st = await p.choose('link.png');
    let page = await p.state();
    const ex = expected(QR_LINK);
    check(`${tag}: a QR code’s link goes in the box and gets the full analysis, said to come from the picture`, st.card && st.summary === TEXT.picOne && st.box === QR_LINK && page.summary === TEXT.fromPicture && page.clean === ex.clean, { st: st.summary, box: st.box, summary: page.summary, clean: page.clean });
    check(`${tag}: the code’s card says what it is, with no live link`, st.codes.length === 1 && st.codes[0].title === 'A web address' && st.codes[0].format === 'QR code' && st.codes[0].anchors === 0, st.codes);
    await noLinkTo(p, `${tag} link`, [QR_LINK]);
    st = await p.choose('wifi.png');
    const pw = () => st.codes[0].fields.find((f) => f.label === 'Password');
    check(`${tag}: Wi-Fi details, the password hidden behind Show, and the warning that anyone with the code can join`, st.codes[0].kind === 'wifi' && pw().hidden && st.codes[0].noteTexts.some((x) => x.includes('can join this network')) && st.box === '', st.codes[0]);
    await p.click('#code-0 .cl-show');
    st = await p.ev(PICTURE_STATE);
    check(`${tag}: Show reveals the password and is announced as pressed`, !pw().hidden && pw().value === 'correct horse battery' && pw().buttons[0].pressed === 'true', pw());
    await p.click('#code-0 button[data-use="copy"][data-field="0"]');
    await sleep(120);
    page = await p.state();
    check(`${tag}: Copy network name copies the name`, page.clips.at(-1)?.text === 'Kleppesto Guest', page.clips);
    if (w === 360) {
      const n = await p.ev(`(() => { const vw = document.documentElement.clientWidth; return { vw, sw: document.documentElement.scrollWidth }; })()`);
      check(`${tag}: no sideways scrolling with a Wi-Fi card`, n.sw <= n.vw, n);
    }
    await textChecks(p, `${tag} Wi-Fi`);
    st = await p.choose('otp.png');
    check(`${tag}: a 2FA code is Stop, its secret hidden, its picture not drawn again`, st.codes[0].tier === 'red' && st.codes[0].fields.find((f) => f.label === 'Secret').hidden && !st.canvas.shown && st.notice === `Stop: ${TEXT.picNotShown}`, st);
    const clips = (await p.state()).clips.length;
    await p.click('#code-0 button[data-use="copy"]');
    const open = await p.ev("document.getElementById('copy-dialog').open");
    await p.click('#copy-cancel');
    page = await p.state();
    check(`${tag}: copying the secret asks first, and Cancel copies nothing`, open && page.clips.length === clips, { open, clips: page.clips.length });
    st = await p.choose('two-codes.png');
    check(`${tag}: two codes, two cards, and the sticker notice`, st.codes.length === 2 && st.notice === `Check: ${TEXT.picSeveral}` && st.box === '', st);
    await p.click('#code-1 button[data-use="code-link"]');
    st = await p.ev(PICTURE_STATE);
    check(`${tag}: Check this link on code 2 checks that link`, st.box === 'https://evil.example/login?utm_source=sticker' && st.card, st.box);
    st = await p.choose('not-image.png');
    check(`${tag}: a file that is not a picture gets a plain reason`, !st.card && st.status === TEXT.picNotImage, st.status);
    st = await p.choose('nocode.png');
    check(`${tag}: a picture with no code says so`, !st.card && st.status === TEXT.picNone, st.status);
    // A pasted image (a screenshot) is read as a picture.
    const bytes = [...readFileSync(join(ROOT, 'tests', 'fixtures', 'qr', 'wifi.png'))];
    await p.ev(`(async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(${J(bytes)})], { type: 'image/png' }) })]); })()`);
    await p.ev("document.getElementById('link-input').focus()");
    await p.s('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
    await p.s('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
    await p.waitFor("document.getElementById('picture-card').hidden === false", 8000);
    st = await p.ev(PICTURE_STATE);
    check(`${tag}: a pasted image is read as a picture`, st.card && st.codes[0].kind === 'wifi' && st.box === '', { card: st.card, kind: st.codes[0] && st.codes[0].kind });
    await p.shot(`${tag.replace(' ', '-')}-wifi`);
    const after = p.log.requests.slice(settled);
    check(`${tag}: reading seven pictures made no request at all (${after.length})`, after.length === 0, after);
    check(`${tag}: no errors in the page or the worker`, p.log.errors.length === 0, p.log.errors);
    check(`${tag}: no policy violations`, (await p.ev('window.__csp')).length === 0, await p.ev('window.__csp'));
    await p.close();
  }

  // Text at 200% on the narrowest phone (UI review, finding H1): the notes and details inside a
  // code's card stay readable, at least 160 pixels wide, and a square picture stays square
  // (finding H2). Root font size at 200%, as the other 200% checks set it.
  {
    const p = await openPage(320, 700, { init: shareStub({ share: false, clipboard: true, open: true }) });
    await sleep(600);
    await p.ev("document.documentElement.style.fontSize = '200%', true");
    for (const file of ['wifi.png', 'epc.png', 'otp.png', 'two-codes.png', 'link-wifi.png']) {
      await p.choose(file);
      await sleep(300);
      const m = await p.ev(`(() => {
        const vw = document.documentElement.clientWidth;
        const sw = document.documentElement.scrollWidth;
        // The room each note's text and each detail has: a note's content box, a detail's own
        // column (a short value such as "No" is narrow itself, which is fine).
        const room = (el) => {
          const box = el.classList.contains('cl-field-value') ? el.parentElement : el;
          const cs = getComputedStyle(box);
          return Math.round(box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
        };
        const narrow = [...document.querySelectorAll('#code-list .cl-note, #code-list .cl-field-value')].map(room).filter((wd) => wd < 160);
        const c = document.getElementById('picture-view');
        const r = c.getBoundingClientRect();
        return { vw, sw, narrow, canvas: c.hidden ? null : { w: Math.round(r.width), h: Math.round(r.height), ratio: c.width / c.height } };
      })()`);
      check(`320 pixels, text at 200% (${file}): notes and details at least 160 pixels wide, no sideways scrolling`, m.sw <= m.vw && !m.narrow.length, m);
      if (m.canvas) check(`320 pixels, text at 200% (${file}): the picture keeps its shape and is at most 180 pixels tall`, Math.abs(m.canvas.w / m.canvas.h - m.canvas.ratio) < 0.03 && m.canvas.h <= 181, m.canvas);
    }
    await p.shot('w320-text200-picture');
    await p.close();
  }

  // Stage 3: Scan with camera at 320 pixels, with two fake cameras.
  {
    const p = await openPage(320, 640, { init: shareStub({ share: true, clipboard: true, open: true }) + cameraStub(), camera: true });
    let c = await p.ev(CAMERA_STATE);
    check('camera: Scan with camera is offered at 320 pixels with its help line, and nothing has asked for the camera yet', c.button && c.help === TEXT.camHelp && c.calls === 0 && c.enumerations === 0 && !c.card, c);
    const btn = await p.ev("(() => { const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { h: Math.round(b.height), right: Math.round(b.right) }; }; return { pic: r('pic-btn'), cam: r('cam-btn'), vw: document.documentElement.clientWidth }; })()");
    check('camera: Choose a picture and Scan with camera are each at least 44 pixels tall and inside the screen', btn.pic.h >= 44 && btn.cam.h >= 44 && btn.cam.right <= btn.vw, btn);
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on'", 10000);
    c = await p.ev(CAMERA_STATE);
    check('camera: on, the preview playing, focus on Stop camera; with two cameras, Switch camera is offered', c.card && c.playing && c.focus === 'cam-stop' && c.switchShown && c.status === TEXT.camLooking && c.expanded === 'true', c);
    const fit = async () => p.ev(`(() => {
      const vw = document.documentElement.clientWidth;
      const card = document.getElementById('camera-card').getBoundingClientRect();
      const frame = document.querySelector('.cl-cam-frame').getBoundingClientRect();
      const out = [...document.querySelectorAll('#camera-card *')].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > vw + 0.5 || b.left < -0.5); }).map((el) => el.id || el.className);
      const stop = document.getElementById('cam-stop').getBoundingClientRect();
      return { vw, sw: document.documentElement.scrollWidth, out, frameH: Math.round(frame.height), vh: innerHeight, inCard: frame.left >= card.left && frame.right <= card.right, stopH: Math.round(stop.height) };
    })()`);
    let m = await fit();
    check('camera: at 320 pixels the camera card fits the screen, the preview stays inside it and at most half the screen tall, Stop camera at least 44 pixels', m.sw <= m.vw && !m.out.length && m.inCard && m.frameH <= m.vh / 2 + 1 && m.stopH >= 44, m);
    await p.shot('w320-camera-on');
    await p.ev("document.documentElement.style.fontSize = '200%', true");
    await sleep(200);
    m = await fit();
    check('camera: with text at 200% the camera card still fits the screen', m.sw <= m.vw && !m.out.length, m);
    await p.ev("document.documentElement.style.fontSize = '', true");
    await p.click('#cam-switch');
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on' && (window.__cam.streams.length === 2)", 10000);
    c = await p.ev(CAMERA_STATE);
    check('camera: Switch camera asks for the other camera by its own id, and the first one is off', c.calls === 2 && /"deviceId":\{"exact":"[^"]+"/.test(c.constraints[1]) && c.tracks === 2 && c.live === 1 && c.status === TEXT.camLooking, c);
    await sleep(3500);
    c = await p.ev(CAMERA_STATE);
    check('camera: a moving camera picture is not mistaken for a hidden one, and with no code in it the camera stays on', c.card && c.state === 'on' && c.picStatus === '' && c.live === 1, c);
    await p.key('Escape');
    c = await p.ev(CAMERA_STATE);
    check('camera: Escape turns it off, every track has ended, and focus goes back to Scan with camera', !c.card && c.live === 0 && !c.srcObject && c.picStatus === TEXT.camStopped && c.focus === 'cam-btn' && c.recorders === 0, c);
    await textChecks(p, 'camera');
    check('camera: no errors and no request to any other address', p.log.errors.length === 0 && p.log.offsite.length === 0, { errors: p.log.errors, offsite: p.log.offsite });
    await p.close();
  }
  // Stage 3 fixes (11 October 2026), interface review of stage 3. A camera that fails at once (none
  // on the device) used to leave the page showing the footer: two smooth scrolls raced (H1). Now
  // the message and Scan with camera are in view, with focus on the button, and the button is
  // described by the message while it shows (L2).
  for (const [w, hgt] of [[390, 844], [1280, 900], [320, 640]]) {
    const p = await openPage(w, hgt, { init: shareStub({ share: true, clipboard: true, open: true }) + cameraStub({ mode: 'none' }), camera: true });
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('pic-status').textContent !== ''", 8000);
    await sleep(900);
    const m = await p.ev(`(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
      return { status: r(document.getElementById('pic-status')), btn: r(document.getElementById('cam-btn')), vh: innerHeight,
        focus: document.activeElement && document.activeElement.id, text: document.getElementById('pic-status').textContent,
        described: document.getElementById('cam-btn').getAttribute('aria-describedby') };
    })()`);
    check(`camera fails at once, ${w} by ${hgt}: the message and Scan with camera are in view, focus on the button (H1)`, m.text === TEXT.camNone && m.focus === 'cam-btn' && m.status.top >= 0 && m.status.bottom <= m.vh && m.btn.top >= 0 && m.btn.bottom <= m.vh, m);
    check(`camera fails at once, ${w} by ${hgt}: Scan with camera is described by the message while it shows (L2)`, m.described === 'pic-status', m.described);
    if (w === 320) await p.shot('w320-camera-none');
    await p.close();
  }
  // Starting the camera shows the card's heading and the top of the preview (M2), and the preview
  // takes the shape of what the camera sends, so nothing the decoder reads is cropped away (L4).
  for (const [w, hgt, big] of [[320, 568, false], [1280, 900, false], [844, 390, false], [320, 640, true]]) {
    const p = await openPage(w, hgt, { init: shareStub({ share: true, clipboard: true, open: true }) + cameraStub(), camera: true });
    if (big) await p.ev("document.documentElement.style.fontSize = '200%', true");
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('camera-card').dataset.state === 'on' && document.getElementById('cam-video').videoWidth > 0", 10000);
    await sleep(500);
    const m = await p.ev(`(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), w: b.width, h: b.height }; };
      const v = document.getElementById('cam-video');
      return { card: r(document.getElementById('camera-card')), title: r(document.getElementById('camera-title')), frame: r(document.querySelector('.cl-cam-frame')),
        stop: r(document.getElementById('cam-stop')), vh: innerHeight, vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth,
        video: { w: v.videoWidth, h: v.videoHeight }, fit: getComputedStyle(v).objectFit, focus: document.activeElement && document.activeElement.id };
    })()`);
    const label = `camera on, ${w} by ${hgt}${big ? ' with text at 200%' : ''}`;
    check(`${label}: the card's heading and the top of the preview are in view, focus on Stop camera (M2)`, m.title.top >= 0 && m.frame.top >= 0 && m.focus === 'cam-stop' && (big || m.stop.bottom <= m.vh), m);
    check(`${label}: the preview has the camera's own shape and shows all of it, inside the screen (L4)`, m.fit === 'contain' && Math.abs(m.frame.w / m.frame.h - m.video.w / m.video.h) < 0.03 && m.sw <= m.vw, { frame: m.frame, video: m.video, fit: m.fit });
    if (w === 844) await p.shot('w844x390-camera-on');
    await p.key('Escape');
    await p.close();
  }
  // A look-alike address in a picture (p, then the Cyrillic a, then ypal.com): the first screen
  // says so (H2), the code's card is at the Check tier, the Cyrillic letter is boxed in the full
  // link with a line in the legend (M1), and a screen reader hears it with the count (M5).
  for (const [w, hgt] of [[390, 844], [320, 640]]) {
    const p = await openPage(w, hgt, { init: shareStub({ share: true, clipboard: true, open: true }) });
    await sleep(600);
    await p.choose('lookalike.png');
    await sleep(900);
    const m = await p.ev(`(() => {
      const n = document.getElementById('lookalike-notice');
      const card = document.querySelector('#code-list .cl-code');
      const nb = n.getBoundingClientRect();
      return { notice: n.hidden ? null : n.textContent, noticeTop: Math.round(nb.top), noticeBottom: Math.round(nb.bottom), vh: innerHeight,
        tier: card && card.dataset.tier, summary: card && card.querySelector('.cl-code-summary').textContent,
        boxes: [...document.querySelectorAll('#full-link .cl-foreign')].map((b) => b.textContent),
        clean: [...document.querySelectorAll('#clean-link .cl-foreign')].map((b) => b.textContent),
        goes: [...document.querySelectorAll('#goes-line .cl-foreign')].map((b) => b.textContent),
        code: [...document.querySelectorAll('#code-list .cl-link .cl-foreign')].map((b) => b.textContent),
        cleanText: document.getElementById('clean-link').textContent,
        legend: !document.getElementById('legend-foreign').hidden,
        note: (document.querySelector('#warn-list [data-warning="look-alike-letters"]') || {}).textContent || null,
        announcer: document.getElementById('announcer').textContent,
        sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth };
    })()`);
    const tag = `look-alike picture, ${w} pixels`;
    check(`${tag}: the summary card says it in one sentence, in view after the picture is read (H2)`, m.notice === 'Check: This address is made to look like paypal.com. Details under Things to know.' && m.noticeTop >= 0 && m.noticeBottom <= m.vh, m);
    check(`${tag}: the code's card is at the Check tier and says what to check (H2)`, m.tier === 'amber' && m.summary === 'Check: This address is made to look like paypal.com. Details below, under Things to know.', { tier: m.tier, summary: m.summary });
    check(`${tag}: the Cyrillic letter is boxed in the full link, the clean link (which still reads as written), the Goes to line and the code's card, and the legend explains the box (M1)`, J(m.boxes) === J(['а']) && J(m.clean) === J(['а']) && J(m.goes) === J(['а']) && J(m.code) === J(['а']) && m.cleanText === 'https://pаypal.com/signin' && m.legend, m);
    check(`${tag}: the note names the letter, so the address in it does not look like paypal.com (M1)`, !!m.note && m.note.includes('p[Cyrillic а]ypal.com'), m.note);
    check(`${tag}: a screen reader hears the look-alike with the count (M5)`, m.announcer.endsWith('1 thing to check: this address is made to look like paypal.com.'), m.announcer);
    check(`${tag}: no sideways scrolling`, m.sw <= m.vw, m);
    check(`${tag}: no errors and no request to any other address`, p.log.errors.length === 0 && p.log.offsite.length === 0, { errors: p.log.errors, offsite: p.log.offsite });
    await p.shot(`w${w}-lookalike-picture`);
    await p.close();
  }

  // ---- Stage 4b: a QR code of the clean link --------------------------------------------------
  const vis = (sel) => `(() => { const el = document.querySelector(${J(sel)}); return !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0; })()`;
  const QR_GOOGLE = expectedQr(GOOGLE);
  const blackOnWhite = (q) => q.frameBg === 'rgb(255, 255, 255)' && q.svg && q.svg.pathFill === 'rgb(0, 0, 0)' && q.svg.rectFill === 'rgb(255, 255, 255)';
  for (const [w, hgt, big] of [[1280, 900, false], [390, 844, false], [320, 640, false], [320, 640, true]]) {
    const phone = w < 600;
    const tag = `QR code, ${w} pixels${big ? ', text at 200%' : ''}`;
    const p = await openPage(w, hgt, { init: shareStub({ share: phone, clipboard: true, open: true, files: true, pictures: true }) });
    if (big) await p.ev("document.documentElement.style.fontSize = '200%', true");
    await p.paste(GOOGLE);
    let q = await p.ev(QR_STATE);
    check(`${tag}: Make a QR code sits with Copy${phone ? ' and Share' : ''}, with no reason line`, q.button && q.buttonText === TEXT.qrButton && !q.note && q.expanded === null && J(q.actions) === J(phone ? ['copy-btn', 'share-btn', 'qr-btn'] : ['copy-btn', 'qr-btn']) && !q.card, q);
    await p.click('#qr-btn');
    const shown = await p.waitFor(vis('#qr-card'), 15000);
    q = await p.ev(QR_STATE);
    check(`${tag}: the card opens after the read-back, focus on its heading`, shown && q.title === TEXT.qrTitle && q.focus === 'qr-title' && q.expanded === null && q.status === '', { shown, title: q.title, focus: q.focus, status: q.status });
    check(`${tag}: the code is one SVG path on a white square, with presentation attributes only, and exactly the code Node makes`, J(q.svg.children) === J(['rect', 'path']) && q.svg.d === QR_GOOGLE.path && q.svg.fill === '#000000' && q.svg.bg === '#ffffff' && q.svg.viewBox === QR_GOOGLE.viewBox && !q.svg.styled, { ...q.svg, d: q.svg.d && q.svg.d.slice(0, 60) });
    check(`${tag}: a screen reader hears a picture named after the host only`, q.svg.role === 'img' && q.svg.label === TEXT.qrLabel(QR_GOOGLE.host) && q.svg.label === 'QR code of the clean link to www.google.com', { role: q.svg.role, label: q.svg.label });
    check(`${tag}: always black on white, whatever the page's colours`, blackOnWhite(q), { frame: q.frameBg, path: q.svg.pathFill, rect: q.svg.rectFill });
    check(`${tag}: under it the line about scanning and the exact text it holds`, q.scan === TEXT.qrScan && q.text === QR_GOOGLE.text && !q.ascii, { scan: q.scan, text: q.text });
    check(`${tag}: Save picture, Copy picture where the clipboard takes a PNG, and Share picture only where the browser can share files`, q.save && q.copy && q.share === phone && !q.screen, { save: q.save, share: q.share, copy: q.copy, screen: q.screen });
    check(`${tag}: the code is square and inside its card, and nothing makes the page scroll sideways`, Math.abs(q.svg.width - q.svg.height) <= 1 && q.svg.left >= q.cardLeft && q.svg.right <= q.cardRight && q.sw <= q.vw && q.svg.width >= Math.min(200, w - 80), { svg: q.svg.width, h: q.svg.height, left: q.svg.left, right: q.svg.right, card: [q.cardLeft, q.cardRight], sw: q.sw, vw: q.vw });
    if (!big) await textChecks(p, tag);
    if (w === 1280) {
      for (const features of [[{ name: 'prefers-color-scheme', value: 'dark' }], [{ name: 'prefers-color-scheme', value: 'light' }], [{ name: 'forced-colors', value: 'active' }]]) {
        await p.s('Emulation.setEmulatedMedia', { features });
        await sleep(150);
        const c = await p.ev(QR_STATE);
        check(`${tag}: with ${features[0].name} ${features[0].value}, still black on white`, blackOnWhite(c), { frame: c.frameBg, path: c.svg.pathFill, rect: c.svg.rectFill });
      }
      await p.s('Emulation.setEmulatedMedia', { features: [] });
      // Copy picture hands over the same PNG Save makes.
      await p.click('#qr-copy');
      await p.waitFor("document.getElementById('qr-status').textContent !== ''", 5000);
      const pics = await p.ev('({ pictures: window.__clip.pictures, status: document.getElementById("qr-status").textContent })');
      check(`${tag}: Copy picture puts exactly the PNG on the clipboard, and says so`, pics.pictures.length === 1 && J(pics.pictures[0].types) === J(['image/png']) && pics.pictures[0].type === 'image/png' && pics.pictures[0].base64 === QR_GOOGLE.png.toString('base64') && pics.status === TEXT.qrCopied, { n: pics.pictures.length, status: pics.status });
      await p.ev("window.__clip.mode = 'fail'");
      await p.click('#qr-copy');
      await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrCopyFailed)}`, 5000);
      check(`${tag}: a refused Copy picture says so plainly`, (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrCopyFailed);
      await p.ev("window.__clip.mode = 'ok'");
    }
    if (phone && !big) {
      await p.click('#qr-share');
      await p.waitFor('window.__share.files.length > 0', 5000);
      const sh = await p.ev('({ calls: window.__share.calls, files: window.__share.files })');
      check(`${tag}: Share picture hands over qr-code.png alone, with no text or title, byte for byte the PNG`, sh.calls.length === 1 && sh.calls[0].files === 1 && sh.calls[0].text === undefined && sh.calls[0].title === undefined && sh.calls[0].url === undefined && sh.files[0].name === 'qr-code.png' && sh.files[0].type === 'image/png' && sh.files[0].base64 === QR_GOOGLE.png.toString('base64'), { calls: sh.calls, file: sh.files[0] && { name: sh.files[0].name, type: sh.files[0].type, size: sh.files[0].size } });
      await p.ev("window.__share.mode = 'abort'");
      await p.click('#qr-share');
      await sleep(300);
      check(`${tag}: closing the share sheet says nothing`, (await p.ev("document.getElementById('qr-status').textContent")) === '');
      await p.ev("window.__share.mode = 'fail'");
      await p.click('#qr-share');
      await p.waitFor(`document.getElementById('qr-status').textContent === ${J(TEXT.qrShareFailed)}`, 5000);
      check(`${tag}: a failed Share picture says so plainly`, (await p.ev("document.getElementById('qr-status').textContent")) === TEXT.qrShareFailed);
    }
    // The card itself, in view (a full-page picture leaves cards below the screen unpainted).
    await p.ev("document.getElementById('qr-card').scrollIntoView({ block: 'start', behavior: 'instant' })");
    await sleep(250);
    writeFileSync(join(OUT, `qr-card-w${w}${big ? '-text200' : ''}.png`), Buffer.from((await p.s('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    // Any change closes the card: a tick, then typing.
    await p.click('#parts-list .cl-check');
    q = await p.ev(QR_STATE);
    check(`${tag}: unticking a part closes the card at once`, !q.card && q.expanded === null && q.button, { card: q.card, expanded: q.expanded });
    await p.click('#parts-list .cl-check');
    await p.click('#qr-btn');
    await p.waitFor(vis('#qr-card'), 15000);
    // Stage 4b review S8: the card goes with the first key press, not after the typing pause, so a
    // press of Save picture in between can never hand on the code of the link before.
    await p.ev("document.getElementById('link-input').focus()");
    await p.s('Input.insertText', { text: 'x' });
    q = await p.ev(QR_STATE);
    const pending = await p.ev('document.getElementById("link-input").value !== document.getElementById("clean-link").textContent');
    check(`${tag}: typing in the box closes the card at once, before the pause after typing`, !q.card && q.expanded === null && pending, { card: q.card, pending });
    check(`${tag}: no errors, no CSP violation and no request to any other address`, p.log.errors.length === 0 && p.log.offsite.length === 0 && !(await p.ev('window.__csp.length')), { errors: p.log.errors, offsite: p.log.offsite, csp: await p.ev('window.__csp') });
    await p.close();
  }
  // Stage 4b review SC-7: a picture pasted while focus is on Save picture closes the card, and focus
  // goes to Make a QR code for the new link instead of falling to the page itself.
  {
    const p = await openPage(1280, 900, { init: shareStub({ share: false, clipboard: true, open: true, files: true, pictures: true }) });
    await p.paste(GOOGLE);
    await p.click('#qr-btn');
    await p.waitFor(vis('#qr-card'), 15000);
    await p.ev("document.getElementById('qr-save').focus()");
    const bytes = [...readFileSync(join(ROOT, 'tests', 'fixtures', 'qr', 'link.png'))];
    // Ctrl+V on a button runs no paste command in headless Chromium, so the paste event a browser
    // sends there is made by hand, with the picture as its file, at the focused button.
    await p.ev(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(${J(bytes)})], 'link.png', { type: 'image/png' }));
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return document.activeElement.id;
    })()`);
    await p.waitFor("document.getElementById('picture-card').hidden === false && document.getElementById('qr-card').hidden", 10000);
    await sleep(100);
    const q = await p.ev(QR_STATE);
    check('SC-7: a picture pasted with focus on Save picture closes the card and puts focus on Make a QR code, not on the page', !q.card && q.focus === 'qr-btn' && q.button, { card: q.card, focus: q.focus });
    await p.close();
  }
  // Links with letters outside English: the host in its ASCII form, said in one line under the text.
  {
    const IDN = 'https://www.blåbærturer.no/tur/kløvsteinen?år=2026&utm_source=x';
    const want = expectedQr(IDN);
    const p = await openPage(390, 844, { init: shareStub({ share: true, clipboard: true, open: true, files: true }) });
    await p.paste(IDN);
    await p.click('#qr-btn');
    await p.waitFor(vis('#qr-card'), 15000);
    const q = await p.ev(QR_STATE);
    check('QR code of a link with æ, ø and å: only the host is in its ASCII form, the rest as written, and one line says so', q.card && q.text === want.text && q.text === 'https://www.xn--blbrturer-62am.no/tur/kløvsteinen?år=2026' && q.svg.d === want.path && !!q.ascii && /plain-letter form/.test(q.ascii) && q.svg.label === 'QR code of the clean link to www.blåbærturer.no', { text: q.text, ascii: q.ascii, label: q.svg.label });
    await p.close();
  }
  // A link written without https:// gets it, and says so.
  {
    const BARE = 'www.example.no/side?fbclid=abc';
    const p = await openPage(390, 844, { init: shareStub({ share: true, clipboard: true, open: true }) });
    await p.paste(BARE);
    await p.click('#qr-btn');
    await p.waitFor(vis('#qr-card'), 15000);
    const q = await p.ev(QR_STATE);
    check('QR code of a link written without https://: the code holds it with https:// in front, and one line says so', q.text === 'https://www.example.no/side' && q.svg.d === expectedQr(BARE).path && /https:\/\/ is added/.test(q.ascii || ''), { text: q.text, ascii: q.ascii });
    await p.close();
  }
  // No code, with one plain line, for each kind of link that gets none; PD-1's line above Copy and
  // Share for a link with personal details, whose Share stays offered.
  {
    const EMAIL = 'https://shop.example.com/confirm?email=someone%40example.no&utm_source=x';
    const SESSION = 'https://app.example.com/dash?session_id=abc123';
    const p = await openPage(390, 844, { init: shareStub({ share: true, clipboard: true, open: true, files: true }) });
    // The box shows the new link's analysis once its clean link is on screen.
    const analysed = (link) => p.waitFor(`document.getElementById('clean-link').textContent === ${J(expected(link).clean)}`, 5000);
    // Stage 4b fixes: a session name in another spelling, a phone number, a reset link with its
    // token in the path, and a link to a device (review findings S1, S2 and S7).
    // above: the line on show above the QR line that gives the same reason ('held' or 'personal'),
    // and with it the short QR line (SC-9); null: none, so the QR line gives the reason in full.
    for (const [link, id, above] of [[RESET, 'auth', 'held'], [SHORT, 'short', null], [HTTP_LINK, 'notes', null], [EMAIL, 'email', 'personal'], [SESSION, 'signin', 'personal'], ['https://p\u0430ypal.com/login', 'notes', null], [DISGUISE, 'notes', null],
      ['https://shop.example.com/cart?PHPSESSID=9f8e7d6c5b4a39281706f5e4d3&utm_source=x', 'signin', 'personal'], ['https://shop.example.com/order?phone=%2B4791234567&utm_source=x', 'phone', 'personal'],
      ['https://example.com/password/reset/9f8e7d6c5b4a39281706f5e4d3c2b1a0?utm_source=x', 'signin', 'personal'], ['https://192.168.1.1/admin?utm_source=x', 'device', null]]) {
      await p.paste(link);
      await analysed(link);
      const q = await p.ev(QR_STATE);
      const lineAbove = above === 'held' ? !!q.shareNote && !q.warn : above === 'personal' ? !!q.warn && !q.shareNote : !q.warn && !q.shareNote;
      check(`QR refusal (${id}, ${link.slice(0, 40)}): no button, and one plain line instead${above ? ', the short one under the line that gives the reason (SC-9)' : ''}`, !q.button && lineAbove && q.note === (above ? TEXT.qrSameReason : QR_REFUSED[id]) && !q.card, { button: q.button, note: q.note, warn: q.warn, shareNote: q.shareNote });
    }
    // SC-9: a line above that gives another reason keeps the QR line in full. A short link refuses
    // before anything else, so its own reason stands under a PD-1 line or a held-share line.
    for (const [link, above] of [['https://bit.ly/3xYz?email=someone%40example.no&utm_source=x', 'personal'], ['https://t.co/abc?token=abcdef123456', 'held']]) {
      await p.paste(link);
      await analysed(link);
      const q = await p.ev(QR_STATE);
      check(`SC-9: a short link (${link.slice(8, 30)}) under the ${above === 'held' ? 'held-share' : 'PD-1'} line keeps the full QR line`, !q.button && (above === 'held' ? !!q.shareNote : q.warn === TEXT.personalEmail) && q.note === QR_REFUSED.short, { warn: q.warn, shareNote: q.shareNote, note: q.note });
    }
    // SC-9: a recipient part the page needs (Share held back): the short line under that line.
    {
      const UNSUB = 'https://example.com/unsubscribe?mc_eid=abc123&utm_source=x';
      await p.paste(UNSUB);
      await analysed(UNSUB);
      const q = await p.ev(QR_STATE);
      check('SC-9: a recipient part the page needs: Share held back with its line, and the short QR line under it', !q.button && q.shareNote === TEXT.shareHeldRecipient && !q.warn && q.note === TEXT.qrSameReason, { shareNote: q.shareNote, warn: q.warn, note: q.note });
    }
    // SC-9: the QR line follows the line above when a tick takes that line away and brings it back.
    {
      const HTTP_EMAIL = 'http://shop.example.com/confirm?email=someone%40example.no&utm_source=x';
      const part = analyse(HTTP_EMAIL).parts.find((x) => x.name === 'email');
      await p.paste(HTTP_EMAIL);
      await analysed(HTTP_EMAIL);
      let q = await p.ev(QR_STATE);
      check('SC-9: an http:// link with an email address: the PD-1 line, and the short QR line under it', q.warn === TEXT.personalEmail && q.note === TEXT.qrSameReason && !q.button, { warn: q.warn, note: q.note });
      await p.click(`label.cl-part[data-part="${part.id}"] .cl-part-name`);
      await p.waitFor("document.getElementById('share-warn').hidden", 3000);
      q = await p.ev(QR_STATE);
      check('SC-9: the email address ticked out: the PD-1 line goes, and the QR line gives its own reason in full', !q.warn && q.note === QR_REFUSED.notes && !q.button, { warn: q.warn, note: q.note });
      await p.click(`label.cl-part[data-part="${part.id}"] .cl-part-name`);
      await p.waitFor("!document.getElementById('share-warn').hidden", 3000);
      q = await p.ev(QR_STATE);
      check('SC-9: ticked back in: the PD-1 line and the short QR line return together', q.warn === TEXT.personalEmail && q.note === TEXT.qrSameReason, { warn: q.warn, note: q.note });
      const a11y = await p.ev("(() => { const n = document.getElementById('qr-note'); return { role: n.getAttribute('role'), live: n.getAttribute('aria-live'), attrs: [...n.attributes].map((x) => x.name).sort() }; })()");
      check('SC-9: the QR line keeps its markup: no role, no live region', a11y.role === null && a11y.live === null && J(a11y.attrs) === J(['class', 'id']), a11y);
    }
    await p.paste(EMAIL);
    await analysed(EMAIL);
    let q = await p.ev(QR_STATE);
    let st = await p.state();
    check('PD-1: a link with an email address gets one line above Copy and Share, and Share stays offered', q.warn === TEXT.personalEmail && st.share && !q.shareNote, { warn: q.warn, share: st.share, shareNote: q.shareNote });
    const order = await p.ev("(() => { const w = document.getElementById('share-warn'); const a = document.querySelector('#clean-card .cl-actions'); return !!(w.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) && w.getBoundingClientRect().bottom <= a.getBoundingClientRect().top + 1; })()");
    check('PD-1: the line sits above the buttons', order, order);
    await p.paste(SESSION);
    await analysed(SESSION);
    q = await p.ev(QR_STATE);
    check('PD-1: a session value gets its own line', q.warn === TEXT.personalSignin, q.warn);
    await p.paste(RESET);
    await analysed(RESET);
    q = await p.ev(QR_STATE);
    st = await p.state();
    check('PD-1: a sign-in link Share is held back for keeps its own line only, below the buttons', !q.warn && st.shareNote && !st.share, { warn: q.warn, shareNote: st.shareNote });
    await p.paste(GOOGLE);
    await analysed(GOOGLE);
    q = await p.ev(QR_STATE);
    check('PD-1: an ordinary link gets no such line', !q.warn && q.button, q.warn);
    // Stage 4b review EMU-3: something that is not a web address takes the last link's lines with it.
    await p.paste(EMAIL);
    await analysed(EMAIL);
    await p.paste('javascript:alert(document.cookie)');
    await p.waitFor("document.getElementById('clean-card').hidden", 3000);
    const stale = await p.ev("['share-warn', 'share-note', 'qr-note'].map((id) => [document.getElementById(id).hidden, document.getElementById(id).textContent])");
    check('EMU-3: after a script, no line about the last web link is left in the hidden card', stale.every(([hidden, t]) => hidden && t === ''), stale);
    await textChecks(p, 'QR refusals and PD-1');
    check('QR refusals: no errors and no request to any other address', p.log.errors.length === 0 && p.log.offsite.length === 0, { errors: p.log.errors, offsite: p.log.offsite });
    await p.close();
  }
  // No worker can start (a browser that refuses it): no code, a plain line, and the link still works.
  {
    const p = await openPage(390, 844, { init: `${shareStub({ share: true, clipboard: true, open: true })}\nwindow.Worker = function () { throw new Error('no workers here'); };` });
    await p.paste(GOOGLE);
    await p.click('#qr-btn');
    await p.waitFor(`document.getElementById('action-status').textContent === ${J(TEXT.qrNoReader)}`, 15000);
    const q = await p.ev(QR_STATE);
    check('QR code without the picture reader: no code is shown, and the page says so plainly', !q.card && q.status === TEXT.qrNoReader && !q.svg, { card: q.card, status: q.status });
    await p.close();
  }

  // The live site before the camera rule exists: the zone's camera=() turns the camera off for the
  // page, and Scan with camera says so without asking for it.
  permMode = 'zone';
  {
    const p = await openPage(390, 844, { init: shareStub({ share: true, clipboard: true, open: true }) + cameraStub(), camera: true });
    await p.click('#cam-btn');
    await p.waitFor("document.getElementById('pic-status').textContent !== ''", 8000);
    const c = await p.ev(CAMERA_STATE);
    check('zone camera policy: Scan with camera says the site does not allow the camera, and never asks for it', c.picStatus === TEXT.camBlocked && c.picError && c.calls === 0 && !c.card, c);
    await p.paste(GOOGLE);
    const page = await p.state();
    check('zone camera policy: links are still checked', page.clean === expected(GOOGLE).clean, page.clean);
    await p.close();
  }
  permMode = 'host';

  // ---- Stage 5: the first-run notice, the privacy page and the disclaimer -------------------------
  const tryEv = async (p, expression) => { try { return await p.ev(expression); } catch { return undefined; } };
  const arrive = async (p, path) => {
    for (let i = 0; i < 100; i++) {
      if (await tryEv(p, `location.pathname === ${J(path)} && document.readyState === 'complete'`)) return true;
      await sleep(100);
    }
    return false;
  };
  for (const [w, hgt, big, how] of [[1280, 900, false, 'Escape'], [390, 844, false, 'the backdrop'], [320, 640, false, 'a press on Got it'], [320, 640, true, 'the keyboard (Tab to Got it, Enter)']]) {
    const tag = `first-run notice, ${w} pixels${big ? ', text at 200%' : ''}`;
    const p = await openPage(w, hgt, { init: shareStub({ share: w < 600, clipboard: true, open: true }), gate: 'keep' });
    if (big) await p.ev("document.documentElement.style.fontSize = '200%', true");
    await sleep(300);
    let g = await p.ev(GATE_STATE);
    check(`${tag}: shown on a first visit, as a modal dialog named by its heading, in the dismissible tier`, g.open && g.tier === 'dismissible' && g.role === 'dialog' && g.modal === 'true' && g.titleIsHeading && g.title === GATE.title && g.kicker === GATE.kicker, g);
    check(`${tag}: its words, word for word`, J(g.paragraphs) === J(GATE.paragraphs) && g.ack === GATE.ack && g.button === GATE.button && g.link === GATE.link && g.linkHref === GATE.linkHref && g.linkTarget === null, { paragraphs: g.paragraphs, ack: g.ack, button: g.button, link: g.link });
    check(`${tag}: the page behind it cannot be used: every other part is inert and hidden from screen readers, and focus starts on the notice`, g.othersInert && g.mainInert && g.htmlClass && g.focusInside, { inert: g.othersInert, focus: g.focus });
    if (!big) {
      check(`${tag}: the notice fits the screen: Got it and the disclaimer link are on screen, and nothing scrolls sideways`, g.buttonBox.bottom <= g.vh && g.buttonBox.right <= g.vw && g.buttonBox.left >= 0 && g.linkBox.bottom <= g.vh && g.sw <= g.vw && g.dialog.width <= g.vw, { button: g.buttonBox, link: g.linkBox, vw: g.vw, vh: g.vh, sw: g.sw });
    } else {
      // At 200% text on a small screen the notice is taller than the screen: the notice itself
      // scrolls (style.css, FIRST-RUN NOTICE), so Got it and the link can still be reached.
      // scrollTop is a whole number of pixels, so a link scrolled to the bottom edge can stand
      // out by a fraction of a pixel: 0.09 px measured on 12 October 2026, once CheckLink's
      // own, shorter acknowledgement moved the text. Less than one pixel counts as in view.
      const reach = await p.ev("(() => { const o = document.querySelector('.sb-gate-overlay'); const top = o.scrollTop; document.querySelector('.sb-gate-link').scrollIntoView({ block: 'end', behavior: 'instant' }); const b = document.querySelector('.sb-gate-btn').getBoundingClientRect(); const l = document.querySelector('.sb-gate-link').getBoundingClientRect(); const d = document.querySelector('.sb-gate-dialog').getBoundingClientRect(); return { scrolls: o.scrollHeight > o.clientHeight, moved: o.scrollTop > top, btn: b.bottom < innerHeight + 1 && b.top > -1, link: l.bottom < innerHeight + 1 && l.top > -1, linkBottom: l.bottom, vh: innerHeight, dialogTop: d.top + o.scrollTop, sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }; })()");
      check(`${tag}: taller than the screen, the notice scrolls: its top is reachable, and Got it and the disclaimer link come into view; nothing scrolls sideways`, reach.scrolls && reach.btn && reach.link && reach.dialogTop >= 0 && reach.sw <= reach.vw, reach);
      await p.ev("document.querySelector('.sb-gate-overlay').scrollTop = 0, true");
    }
    check(`${tag}: nothing is stored while it is open`, g.stored === null && J(g.keys) === '[]', { stored: g.stored, keys: g.keys });
    const words = copyProblems([GATE.title, ...g.paragraphs, g.ack].join('\n'));
    check(`${tag}: plain British English, no dashes, never "safe" or "verified"`, !words.length, words);
    if (!big) {
      for (let i = 0; i < 6; i++) await p.key('Tab');
      const inside = await p.ev("!!document.activeElement && !!document.activeElement.closest('.sb-gate-dialog')");
      check(`${tag}: Tab stays inside the notice`, inside, await p.ev('document.activeElement && document.activeElement.className'));
    }
    await p.shot(`5-notice-${w}${big ? '-big' : ''}`);
    if (how === 'Escape') await p.key('Escape');
    else if (how === 'the backdrop') {
      await p.s('Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 4, button: 'left', clickCount: 1 });
      await p.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 4, y: 4, button: 'left', clickCount: 1 });
      await sleep(150);
    } else if (how === 'a press on Got it') await p.click('.sb-gate-btn');
    else {
      await p.ev("document.querySelector('.sb-gate-dialog').focus(), true");
      for (let i = 0; i < 6 && !(await p.ev("document.activeElement === document.querySelector('.sb-gate-btn')")); i++) await p.key('Tab');
      await p.key('Enter');
    }
    await p.waitFor("!document.querySelector('.sb-gate-overlay')", 3000);
    g = await p.ev(GATE_STATE);
    check(`${tag}: ${how} closes it, the page can be used again, and the one flag is stored: the time it was closed`, !g.open && !g.mainInert && !g.htmlClass && FLAG_VALUE.test(g.stored) && J(g.keys) === J([GATE.key]), g);
    if (w === 1280) {
      const stored = g.stored;
      await p.s('Page.reload', {});
      await sleep(900);
      await p.waitFor("document.readyState === 'complete' && !!document.getElementById('rules-date') && !document.getElementById('rules-date').hidden", 10000);
      await sleep(300);
      g = await p.ev(GATE_STATE);
      check(`${tag}: after a reload it does not show again, and the flag is unchanged`, !g.open && g.stored === stored && !g.mainInert, g);
    }
    const csp = await p.ev('window.__csp');
    check(`${tag}: no policy violations (the notice adds no inline style or script)`, csp.length === 0, csp);
    check(`${tag}: no uncaught errors and nothing requested from another site`, !p.log.errors.length && !p.log.offsite.length, { errors: p.log.errors, offsite: p.log.offsite });
    await p.close();
  }

  const indexCsp = metaCsp(readFileSync(join(ROOT, 'index.html'), 'utf8'));
  for (const [w, hgt] of [[1280, 900], [320, 640]]) {
    for (const scheme of ['dark', 'light']) {
      const tag = `legal pages, ${w} pixels, ${scheme}`;
      const p = await openPage(w, hgt, { init: shareStub({ share: false, clipboard: true, open: true }) });
      await p.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      const foot = await p.ev("[...document.querySelectorAll('a[href=\"privacy.html\"], a[href=\"disclaimer.html\"]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent, target: a.getAttribute('target'), footer: !!a.closest('.site-footer') }))");
      check(`${tag}: the footer has one Privacy and one Disclaimer link, both opening in place`, J(foot) === J([{ href: 'privacy.html', text: 'Privacy', target: null, footer: true }, { href: 'disclaimer.html', text: 'Disclaimer', target: null, footer: true }]), foot);
      await p.click('.site-footer a[href="privacy.html"]');
      let arrived = await arrive(p, '/privacy.html');
      let st = await p.ev(LEGAL_STATE);
      const cspSeen = [...(await p.ev('window.__csp'))];
      check(`${tag}: Privacy opens privacy.html, with no first-run notice on it`, arrived && st.h1 === 'Privacy' && !st.gate, { arrived, path: st.path, gate: st.gate });
      check(`${tag}: privacy.html carries exactly the page's own policy, has no scripts and no inline styles`, st.csp === indexCsp && st.scripts === 0 && st.styleElements === 0 && st.styleAttrs === 0, { csp: st.csp, scripts: st.scripts, styles: st.styleElements, attrs: st.styleAttrs });
      check(`${tag}: privacy.html has the site's chrome, a dated last line, the Back link, Privacy marked as the current page and the Disclaimer link`, J(st.sheets.map((h) => h.split('?')[0])) === J(['fonts/inter/inter.css', 'style.css']) && /^Last updated: \d{1,2} [A-Z][a-z]+ \d{4}$/.test(st.updated) && st.back === './' && J(st.privacyLinks) === J([{ current: 'page', target: null }]) && st.disclaimerLinks.length === 1, st);
      check(`${tag}: privacy.html fits the screen`, st.sw <= st.vw, { sw: st.sw, vw: st.vw });
      const pw = copyProblems(st.text);
      check(`${tag}: privacy.html is plain British English, with no dashes and never "safe" or "verified"`, !pw.length, pw);
      if (w === 1280 && scheme === 'dark') await p.shot('5-privacy');
      if (w === 320 && scheme === 'light') await p.shot('5-privacy-320-light');
      await p.click('.site-footer a[href="disclaimer.html"]');
      arrived = await arrive(p, '/disclaimer.html');
      st = await p.ev(LEGAL_STATE);
      cspSeen.push(...(await p.ev('window.__csp')));
      const bg = scheme === 'dark' ? 'rgb(13, 17, 23)' : 'rgb(251, 250, 247)';
      check(`${tag}: Disclaimer opens disclaimer.html, styled by its own style sheet (no style block, which the policy would refuse)`, arrived && st.h1 === 'Disclaimer and terms of use' && st.styleElements === 0 && st.styleAttrs === 0 && st.scripts === 0 && J(st.sheets.map((h) => h.split('?')[0])) === J(['fonts/inter/inter.css', 'disclaimer.css']) && st.mainMaxWidth === '736px' && st.h2Transform === 'uppercase' && st.bodyBg === bg, st);
      check(`${tag}: the disclaimer links back to CheckLink and to CheckLink's own privacy page, and fits the screen`, st.back === './' && J(st.privacyLinks) === J([{ current: null, target: null }]) && st.sw <= st.vw && /^Back to CheckLink/.test(st.text.trim().replace(/^\W+/, '')), { back: st.back, privacy: st.privacyLinks, sw: st.sw, vw: st.vw });
      check(`${tag}: the disclaimer has CheckLink's own section`, st.text.includes('SPECIFIC TO CHECKLINK') || st.text.includes('Specific to CheckLink'), st.text.slice(0, 200));
      const dw = copyProblems(st.text);
      check(`${tag}: the disclaimer has no dashes and never "safe" or "verified"`, !dw.length, dw);
      if (w === 1280) await p.shot(`5-disclaimer-${scheme}`);
      await p.click('a.back');
      arrived = await arrive(p, '/');
      await p.waitFor("!!document.getElementById('rules-date') && !document.getElementById('rules-date').hidden", 10000);
      const back = await p.ev("({ gate: !!document.querySelector('.sb-gate-overlay'), box: !!document.getElementById('link-input') })");
      check(`${tag}: Back to CheckLink returns to the page, without the first-run notice`, arrived && back.box && !back.gate, back);
      cspSeen.push(...(await p.ev('window.__csp')));
      check(`${tag}: no policy violations on any of the three pages`, cspSeen.length === 0, cspSeen);
      check(`${tag}: no uncaught errors and nothing requested from another site`, !p.log.errors.length && !p.log.offsite.length, { errors: p.log.errors, offsite: p.log.offsite });
      await p.close();
    }
  }

  // Without the Cloudflare rule (the zone's own policy, which lacks 'wasm-unsafe-eval'), the
  // worker may not compile WebAssembly: pictures get a plain reason, links still work.
  cspMode = 'zone';
  {
    const p = await openPage(360, 780, { init: shareStub({ share: false, clipboard: true, open: true }) });
    await sleep(600);
    const st = await p.choose('link.png');
    check('zone policy only: a picture says the reader cannot start here, and nothing breaks', !st.card && st.status === TEXT.picNoReader, st.status);
    await p.paste(GOOGLE);
    const page = await p.state();
    check('zone policy only: links are still checked', page.clean === expected(GOOGLE).clean, page.clean);
    // Stage 4b: the read-back needs the decoder, so no code is shown here, and the page says why.
    await p.click('#qr-btn');
    await p.waitFor(`document.getElementById('action-status').textContent === ${J(TEXT.qrNoReader)}`, 15000);
    const q = await p.ev(QR_STATE);
    check('zone policy only: Make a QR code shows no code, because CheckLink cannot read it back here, and says so', !q.card && !q.svg && q.status === TEXT.qrNoReader, { card: q.card, status: q.status });
    check('zone policy only: no uncaught errors in the page', p.log.errors.filter((e) => !/WebAssembly|wasm|Content Security|CompileError|Aborted/i.test(e)).length === 0, p.log.errors);
    await p.close();
  }
  cspMode = 'host';
} catch (err) {
  failures += 1;
  console.log(`FAIL harness: ${err.stack || err}`);
} finally {
  ws.close();
  chrome.kill();
  server.close();
  await sleep(300);
  // The screenshots stay in OUT for a person to look at; the browser profile goes unless --keep.
  if (!KEEP) rmSync(profile, { recursive: true, force: true });
}

const missing = requests.filter((r) => !existsSync(join(ROOT, r)) && r !== '/');
console.log(`\n${passes} passed, ${failures} failed. Screenshots in ${OUT}${missing.length ? `\nMissing files requested: ${[...new Set(missing)].join(', ')}` : ''}`);
process.exit(failures ? 1 : 0);
