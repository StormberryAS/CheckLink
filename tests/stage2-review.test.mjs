// Stage 2 review, 11 October 2026: security, privacy and accuracy of the picture reader, the
// decoder worker and the QR inspector. Each test failed when the review wrote it (as a todo);
// the fixes of 11 October 2026 made them pass, and they are ordinary tests now, guarding those
// fixes. Tests added with the fixes say so.
//
// Groups, most serious first:
//   1. pictures that hold a secret are drawn again on the page (a screenshot gives the Wi-Fi
//      password back)
//   2. secrets the inspector does not recognise, shown in full (WireGuard keys, Lightning node
//      macaroons, ecash, vouchers, recovery phrases outside the English list, passwords in links)
//   3. the picture size limit can be walked round (JPEG header tricks, AVIF and HEIC sizes)
//   4. payments shown differently from how a wallet or bank app reads them
//   5. the decoder worker: a restart after a slow picture fetches files; network ways left open
//   6. other hostile or misleading content
//
// The browser tests drive headless Chromium over the DevTools protocol, as browser-core.test.mjs
// does, and are skipped when Chromium or python3 is missing (CHROMIUM=/path overrides).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspect } from '../src/qr-inspect.js';
import { crc16 } from '../src/payload-codecs.js';
import { DecodeError, decodePicture } from '../src/qr-decode.js';
import { sniffImage } from '../src/image-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'qr');
const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const HAVE_PYTHON = spawnSync('python3', ['--version']).status === 0;
const NO_BROWSER = !existsSync(CHROMIUM) ? `Chromium not found at ${CHROMIUM}` : !HAVE_PYTHON ? 'python3 not found' : false;

const amountOf = (p) => p.fields.find((f) => f.label === 'Amount');
// A secret is kept out of the page by default when no field shown in full contains it, and the
// payload or one of its fields is marked secret (so "The text in the code" is not offered either).
function hides(p, secret) {
  const plain = p.fields.filter((f) => !f.secret).filter((f) => f.value.includes(secret)).map((f) => f.label);
  assert.deepEqual(plain, [], `shown in full under: ${plain.join(', ')}`);
  assert.ok(p.secret || p.fields.some((f) => f.secret && f.value.includes(secret)), 'marked as a secret, so the code’s own text is not offered');
}

// ---------------------------------------------------------------------------------------------
// Small generators for hostile pictures

// A flat grey baseline JPEG of any size, written by hand: every 8x8 block is "DC difference 0,
// end of block", two bits each, so the whole scan is zero bytes (250 KB for 64 megapixels, and
// almost nothing once zipped). fill puts one 0xFF fill byte before SOF0, which JPEG allows and
// stb_image skips; padMarkers puts that many empty comment segments before it.
function flatJpeg(width, height, { fill = false, padMarkers = 0 } = {}) {
  const head = [0xff, 0xd8];
  for (let k = 0; k < padMarkers; k++) head.push(0xff, 0xfe, 0x00, 0x02);
  head.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(1));
  if (fill) head.push(0xff);
  head.push(0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00);
  for (const cls of [0, 1]) head.push(0xff, 0xc4, 0x00, 0x14, cls << 4, 1, ...new Array(15).fill(0), 0x00);
  head.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const out = new Uint8Array(head.length + Math.ceil(blocks / 4) + 2);
  out.set(head);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

// The start of an AVIF or HEIC file: ftyp, then meta > iprp > ipco > ispe, the box that carries
// the picture's size.
function heifHeader(brand, width, height) {
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const box = (type, body) => [...u32(8 + body.length), ...Buffer.from(type), ...body];
  const ispe = box('ispe', [0, 0, 0, 0, ...u32(width), ...u32(height)]);
  return new Uint8Array([
    ...box('ftyp', [...Buffer.from(brand), 0, 0, 0, 0, ...Buffer.from(brand), ...Buffer.from('mif1')]),
    ...box('meta', [0, 0, 0, 0, ...box('iprp', box('ipco', ispe))]),
  ]);
}

const emvCode = (body) => `${body}6304${crc16(`${body}6304`)}`;

// ---------------------------------------------------------------------------------------------
// The DevTools-protocol harness for the browser tests

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBrowser() {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'checklink-review-'));
  const proc = spawn(CHROMIUM, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'xdg'), XDG_CACHE_HOME: path.join(profile, 'cache') } });
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
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  const close = async () => {
    try { ws.close(); } catch { /* closing */ }
    proc.kill('SIGKILL');
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { send, sessionId, evaluate, listeners, close };
}

// CheckLink itself, served by tests/serve.py with the recommended host header.
async function openApp({ width = 390, height = 844, workers = null, shortTimeout = false } = {}) {
  const srv = spawn('python3', [path.join(ROOT, 'tests', 'serve.py'), '--quiet'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const origin = await new Promise((resolve, reject) => {
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
  const b = await startBrowser();
  const s = b.sessionId;
  for (const domain of ['Page', 'Runtime', 'DOM', 'Network']) await b.send(`${domain}.enable`, {}, s);
  if (workers) {
    b.listeners.push(async (m) => {
      if (m.method !== 'Target.attachedToTarget' || m.params.targetInfo.type !== 'worker') return;
      workers.push(m.params.sessionId);
      await b.send('Network.enable', {}, m.params.sessionId).catch(() => {});
      await b.send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId).catch(() => {});
    });
    await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s);
  }
  await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true }, s);
  // The page gives a picture 20 s (DECODE_TIMEOUT_MS in app.js); the restart test shortens that
  // one timer to 3 s from outside the page instead of waiting.
  if (shortTimeout) {
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: 'const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms === 20000 ? 3000 : ms, ...a);' }, s);
  }
  await b.send('Page.navigate', { url: origin }, s);
  for (let i = 0; i < 100 && (await b.evaluate('document.readyState')) !== 'complete'; i++) await sleep(100);
  await sleep(1000);
  const choose = async (file) => {
    const { root } = await b.send('DOM.getDocument', {}, s);
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#pic-input' }, s);
    await b.send('DOM.setFileInputFiles', { nodeId, files: [file] }, s);
  };
  // Waits until the picture card shows a code, or the status line says why not.
  const read = async (file) => {
    await b.evaluate("document.getElementById('clear-btn').hidden || document.getElementById('clear-btn').click(), document.getElementById('pic-status').textContent = '', true");
    await choose(file);
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      const st = await b.evaluate(`(() => { const card = document.getElementById('picture-card'); const view = document.getElementById('picture-view');
        return { shown: !card.hidden, codes: document.querySelectorAll('#code-list > li').length, canvasHidden: view.hidden, canvasWidth: view.width,
          status: document.getElementById('pic-status').textContent }; })()`);
      if ((st.shown && st.codes && (st.canvasHidden === false || st.status)) || (!st.shown && st.status && !/^Reading/.test(st.status))) return st;
      if (st.shown && st.codes && i > 25) return st;
    }
    return null;
  };
  const close = async () => {
    await b.close();
    srv.kill();
  };
  return { b, s, origin, choose, read, close };
}

// ---------------------------------------------------------------------------------------------
// 1. Pictures holding a secret are drawn again

describe('1. a picture whose code holds a secret is not drawn again on the page', () => {
  test('Wi-Fi: the password is hidden behind Show, so the picture is not drawn either, and a screenshot of the page holds no readable code', { skip: NO_BROWSER, timeout: 90000 }, async () => {
    // Found 2026-10-11: the page shows "hidden (21 characters)" while the canvas beside it
    // redraws the Wi-Fi code; decoding a screenshot of the page gives
    // WIFI:T:WPA;S:Kleppesto Guest;P:correct horse battery;H:false;;
    const app = await openApp();
    try {
      const st = await app.read(path.join(FIX, 'wifi.png'));
      assert.ok(st && st.shown && st.codes === 1, `the Wi-Fi code was read: ${JSON.stringify(st)}`);
      const shot = await app.b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, app.s);
      const { codes } = await decodePicture(new Uint8Array(Buffer.from(shot.data, 'base64')));
      assert.deepEqual(codes.map((c) => c.text), [], 'a screenshot of the page gives back a readable Wi-Fi code');
      assert.equal(st.canvasHidden, true, 'the picture with the Wi-Fi password is drawn on the page');
    } finally {
      await app.close();
    }
  });

  test('a boarding pass (booking reference hidden) and a health certificate (marked secret) are not drawn again either', { skip: NO_BROWSER, timeout: 120000 }, async () => {
    // Today only a Stop-tier secret hides the picture (app.js: p.secret && p.tier === 'stop'),
    // so the Aztec boarding pass, whose card says "Do not share pictures of a boarding pass",
    // is redrawn, and so is an EU health certificate.
    const files = [path.join(FIX, 'aztec.png')];
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'checklink-review-hc1-'));
    if (spawnSync('qrencode', ['-o', path.join(tmp, 'hc1.png'), 'HC1:NCFOXN%TS3DH3ZSUZK+.V0ETD%65NL-AH-R6IOOP-IZ0QSHD8H7*K4WFA*4F%EAM0SPJ*F0XMG0']).status === 0) files.push(path.join(tmp, 'hc1.png'));
    const app = await openApp();
    try {
      const drawn = [];
      for (const f of files) {
        const st = await app.read(f);
        assert.ok(st && st.shown && st.codes === 1, `${path.basename(f)} was read: ${JSON.stringify(st)}`);
        if (!st.canvasHidden) drawn.push(path.basename(f));
      }
      assert.deepEqual(drawn, [], 'pictures drawn again although their code holds private details');
    } finally {
      await app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('1b. added with the fixes: beside an ordinary code, a private one is painted over', () => {
  test('a link and a Wi-Fi code in one picture: the picture is drawn, the Wi-Fi code covered, and a screenshot gives back only the link', { skip: NO_BROWSER, timeout: 90000 }, async () => {
    const app = await openApp();
    try {
      const st = await app.read(path.join(FIX, 'link-wifi.png'));
      assert.ok(st && st.shown && st.codes === 2, `both codes were read: ${JSON.stringify(st)}`);
      assert.equal(st.canvasHidden, false, 'the picture is drawn, so the codes can be told apart');
      const notice = await app.b.evaluate("document.getElementById('picture-notice').textContent");
      assert.match(notice, /Code 2 holds private details, so it is covered in the picture/);
      const shot = await app.b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, app.s);
      const { codes } = await decodePicture(new Uint8Array(Buffer.from(shot.data, 'base64')));
      assert.ok(!codes.some((c) => /^WIFI:/i.test(c.text)), `a screenshot gives back the Wi-Fi code: ${codes.map((c) => c.text).join(' | ')}`);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Secrets the inspector does not recognise

describe('2. secrets the inspector does not recognise are shown in full', () => {
  test('a WireGuard configuration (the QR code the WireGuard apps import) hides its private key', () => {
    const key = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
    const p = inspect(`[Interface]\nPrivateKey = ${key}\nAddress = 10.0.0.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0\n`);
    // Today: kind text, Good to know, "Plain text. Nothing in it opens anything.", key in full.
    hides(p, key);
    assert.equal(p.tier, 'stop');
  });

  test('a Lightning node connection (lndconnect with an admin macaroon, Core Lightning rune) hides the credential', () => {
    // Umbrel and other node packages show these to connect a wallet app such as Zeus; whoever
    // holds the macaroon or rune controls the node and its money. Today: "Opens an app", Check,
    // with the macaroon in the "Full link" field.
    const macaroon = 'AgEDbG5kAvgBAwoQ3Ebmn0Hl8VZkUdkkR6x7YxIBMBoWCgdhZGRyZXNzEgRyZWFkEgV3cml0ZRoTCgRpbmZvEgRyZWFk';
    const lnd = inspect(`lndconnect://192.168.1.10:10009?cert=MIICJjCCAc2gAwIBAgIRAIkV&macaroon=${macaroon}`);
    hides(lnd, macaroon);
    assert.equal(lnd.tier, 'stop');
    const rune = 'tU-RLjMiDpY2U0o3W1oFowar36RFGpWloPbW9-RuZdo9MyZpZD0wMjRiOWExZmE4ZTAwNmYx';
    const cln = inspect(`clnrest://192.168.1.10:3010?rune=${rune}`);
    hides(cln, rune);
  });

  test('a Nextcloud sign-in code (nc://login) hides its app password', () => {
    const p = inspect('nc://login/user:alice&password:Abcde-Fghij-Klmno-Pqrst-Uvwxy&server:https://cloud.example.com');
    hides(p, 'Abcde-Fghij-Klmno-Pqrst-Uvwxy');
  });

  test('a password in a non-web link (camera stream, SSH, FTP) is hidden', () => {
    // IP cameras print rtsp://user:password@... codes. Today the "Full link" field shows it.
    for (const [text, secret] of [
      ['rtsp://admin:hunter22@192.168.1.64:554/Streaming/Channels/101', 'hunter22'],
      ['ssh://root:toor@10.0.0.5', 'toor'],
      ['ftp://user:pa55word@ftp.example.com/', 'pa55word'],
    ]) hides(inspect(text), secret);
  });

  test('a Cashu ecash token is money: whoever has the code can take it, so it is hidden and Stop', () => {
    const a = 'cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vODMzMy5zcGFjZTozMzM4IiwicHJvb2ZzIjpbeyJhbW91bnQiOjIsImlkIjoiMDA5YTFmMjkzMjUzZTQxZSIsInNlY3JldCI6IjQwNzkxNWJjMjEyYmU2MWE3N2UzZTZkMmFlYjRjNzI3OTgwYmRhNTFjZDA2YTZhZmMyOWUyODYxNzY4YTc4MzcifV19XX0';
    const b = 'cashuBo2FteCJodHRwczovL25vZmVlcy50ZXN0bnV0LmNhc2h1LnNwYWNlYXVjc2F0YXSBomFpSAC0zSfYhhpEYXCCpGFhAmFzeEAzYjk5NGEyNmY5Y2VmNTRkYTZhNjhiM2JhMzk1MGYwYjBlYmRmNDI4NDI2M2Y3OGI3NzdmYjBlYTg2YmRlZjM1';
    for (const text of [a, b, `cashu:${a}`]) {
      const p = inspect(text);
      hides(p, text.replace(/^cashu:/, ''));
      assert.equal(p.tier, 'stop', text.slice(0, 12));
    }
  });

  test('an LNURL-withdraw code is a voucher: whoever has it can claim the money, so it is hidden and says so', () => {
    // Today: "A Lightning withdrawal (LNURL)", Check, the k1 in full twice, and no word that
    // anyone with a picture of it can take the money first.
    const p = inspect('lnurlw://withdraw.example.com/api/v1/lnurl/cb/AbCdEf123?k1=8f7b2c3d4e5f60718293a4b5c6d7e8f9');
    hides(p, '8f7b2c3d4e5f60718293a4b5c6d7e8f9');
    assert.ok(p.warnings.some((w) => /whoever has|anyone (who has|with)/i.test(w.text)), 'a warning that whoever has the code can claim it');
  });

  test('an eSIM activation code (LPA:1$...) is hidden: whoever installs it first gets the phone line', () => {
    const p = inspect('LPA:1$smdp.example.com$K2-1A2B3C-4D5E6F');
    hides(p, 'K2-1A2B3C-4D5E6F');
  });

  test('recovery phrases outside the English BIP-39 list are recognised and hidden', () => {
    // Each passes its own checksum (zero entropy) or is a published example. Today all are
    // "Plain text" shown in full.
    const phrases = {
      'BIP-39 Spanish': 'ábaco ábaco ábaco ábaco ábaco ábaco ábaco ábaco ábaco ábaco ábaco abierto',
      'BIP-39 Portuguese': 'abacate abacate abacate abacate abacate abacate abacate abacate abacate abacate abacate abater',
      'Monero, 25 words (getmonero.org example)': 'sequence atlas unveil summon pebbles tuesday beer rudely snake rockets different fuselage woven tagged bested dented vegan hover rapid fawns obvious muppet randomly seasons randomly',
      'SLIP-39 share, 20 words (Trezor)': 'academic acid acne acquire acrobat activity actress adapt adequate adjust admit adorn adult advance advocate afraid again agency agree aide',
    };
    const missed = Object.entries(phrases).filter(([, words]) => inspect(words).kind !== 'secret').map(([name]) => name);
    assert.deepEqual(missed, []);
  });

  test('an English phrase numbered without full stops ("1 abandon 2 abandon ...") is recognised', () => {
    const text = Array.from({ length: 12 }, (_, i) => `${i + 1} ${i === 11 ? 'about' : 'abandon'}`).join(' ');
    assert.equal(inspect(text).kind, 'secret');
  });

  test('a key inside other text is hidden: an nsec in a sentence, an xprv in a wallet descriptor, a PEM block after a line', () => {
    const nsec = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
    hides(inspect(`My key: ${nsec} keep it`), nsec);
    const xprv = 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
    hides(inspect(`wpkh([d34db33f/84h/0h/0h]${xprv}/0/*)`), xprv);
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----';
    hides(inspect(`Here is my key:\n${pem}`), 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The picture size limit

describe('3. the 60-megapixel limit holds for every picture kind', () => {
  test('a JPEG with a fill byte (0xFF) before its size marker still has its size read', () => {
    // JPEG allows any number of 0xFF fill bytes before a marker and stb_image skips them; the
    // header reader reads the fill byte as a marker and gives up with no size.
    assert.deepEqual(sniffImage(flatJpeg(8000, 8000, { fill: true })), { type: 'jpeg', width: 8000, height: 8000, orientation: 1 });
  });

  test('a JPEG with more than 4,096 segments before its size marker still has its size read, or is refused', async () => {
    // 50,000 x 50,000 so that, today, stb_image itself gives up at once instead of decoding.
    const pic = flatJpeg(50000, 50000, { padMarkers: 4096 });
    const s = sniffImage(pic);
    if (s.width === 50000) return;
    let code = null;
    try {
      await decodePicture(pic);
    } catch (err) {
      code = err instanceof DecodeError ? err.code : String(err);
    }
    assert.ok(['too-many-pixels', 'not-image'].includes(code), `decoded with no size check (header gave ${JSON.stringify(s)}, result ${code})`);
  });

  test('a 64-megapixel JPEG behind a fill byte is refused before decoding, not decoded for seconds', async () => {
    // Measured 2026-10-11 in Node: this 250 KB file decodes for 4.2 s using 400 MB; the same
    // trick at 16,000 x 16,000 (1 MB) took 16 s and 1.4 GB, just under the page's 20 s limit.
    const t0 = performance.now();
    let code = null;
    try {
      await decodePicture(flatJpeg(8000, 8000, { fill: true }));
    } catch (err) {
      code = err instanceof DecodeError ? err.code : String(err);
    }
    assert.equal(code, 'too-many-pixels');
    assert.ok(performance.now() - t0 < 500, 'refused at once');
  });

  test('AVIF and HEIC sizes are read from their ispe box, as for the other kinds', () => {
    assert.deepEqual([sniffImage(readFileSync(path.join(FIX, 'link.avif'))).width, sniffImage(readFileSync(path.join(FIX, 'link.heic'))).width], [392, 392]);
    assert.equal(sniffImage(heifHeader('avif', 20000, 20000)).width, 20000);
  });

  test('a 400-megapixel AVIF is refused before the browser decodes it', async () => {
    // Today the browser's decoder (createImageBitmap) decodes the whole picture in the worker,
    // and only then is its size checked.
    const had = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class {
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) };
      }
    };
    let decoded = 0;
    let code = null;
    try {
      await decodePicture(heifHeader('avif', 20000, 20000), {
        mime: 'image/avif',
        createBitmap: async () => {
          decoded++;
          return { width: 20000, height: 20000, close() {} };
        },
      });
    } catch (err) {
      code = err instanceof DecodeError ? err.code : String(err);
    } finally {
      if (had === undefined) delete globalThis.OffscreenCanvas;
      else globalThis.OffscreenCanvas = had;
    }
    assert.equal(code, 'too-many-pixels');
    assert.equal(decoded, 0, 'the browser was asked to decode it first');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Payments

describe('4. payment details are shown as a wallet or bank app reads them', () => {
  const ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

  test('BIP 21: an amount given twice is not shown as only the first one', () => {
    // Bitcoin Core reads query items in order and the last amount wins; CheckLink shows the
    // first, so "0.001 BTC" is shown for a request a wallet fills in as 5 BTC.
    const p = inspect(`bitcoin:${ADDR}?amount=0.001&amount=5`);
    const amounts = p.fields.filter((f) => /^Amount/.test(f.label));
    const warned = p.warnings.some((w) => /more than once|twice|two amounts|different amounts/i.test(w.text));
    assert.ok(warned || amounts.length >= 2, `shown: ${amounts.map((f) => f.value).join(' | ')}`);
  });

  test('BIP 21: keys are case-sensitive, so AMOUNT= is not the amount; amount= is', () => {
    // BIP 21: "The rest of the URI is case-sensitive, including the query parameter keys."
    const p = inspect(`bitcoin:${ADDR}?AMOUNT=0.001&amount=5`);
    assert.match((amountOf(p) || {}).value || '', /^5 BTC/);
  });

  test('Ethereum: a value on BNB Smart Chain or Polygon is not called ETH', () => {
    for (const chain of ['56', '137']) {
      const a = amountOf(inspect(`ethereum:0x52908400098527886E0F7030069857D2E4169EE7@${chain}?value=2e18`));
      assert.ok(a, `an amount is shown on chain ${chain}`);
      assert.doesNotMatch(a.value, /\bETH\b/, `chain ${chain}: ${a.value}`);
    }
  });

  test('Solana Pay: an amount in an SPL token (spl-token=) is not called SOL, and the token is named', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const p = inspect(`solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU?amount=100&spl-token=${mint}&label=Shop`);
    assert.doesNotMatch((amountOf(p) || {}).value || '', /\bSOL\b/);
    assert.ok(p.fields.some((f) => f.value.includes(mint)), 'the token is shown');
  });

  test('UPI: a payee address or amount given twice is not shown as only the first one', () => {
    for (const [text, name] of [
      ['upi://pay?pa=legit@okbank&pn=Legit%20Shop&am=10&pa=attacker@okbank', 'UPI ID'],
      ['upi://pay?pa=legit@okbank&pn=Legit&am=10&am=10000', 'Amount'],
    ]) {
      const p = inspect(text);
      const warned = p.warnings.some((w) => /more than once|twice|two /i.test(w.text));
      assert.ok(warned || p.fields.filter((f) => f.label === name).length >= 2, text);
    }
  });

  test('EMV codes other than Pix show who is paid: the PromptPay number is not left out', () => {
    // Today the card shows "Payment scheme: A000000677010111", the country and the amount, and
    // asks to compare the account, which it never shows.
    const p = inspect(emvCode('00020101021129370016A000000677010111011300669999999995802TH530376454041.00'));
    assert.ok(p.fields.some((f) => f.value.replace(/\s/g, '').includes('0066999999999')), p.fields.map((f) => `${f.label}: ${f.value}`).join(' | '));
  });

  test('EMV: a currency missing from the short ISO 4217 table is still named (949 is TRY)', () => {
    const p = inspect(emvCode('00020101021229300012D156000000000510A93FO3230Q5204581253039495406100.005802TR5912Ornek Magaza6008ISTANBUL'));
    assert.match((amountOf(p) || {}).value || '', /TRY|949/);
  });

  test('Czech SPD: the alternative accounts (ALT-ACC) a bank app may pay to are shown', () => {
    const p = inspect('SPD*1.0*ACC:CZ6508000000192000145399*ALT-ACC:CZ9455000000005000123456,CZ6107100000001234567890*AM:1500.00*CC:CZK*MSG:Platba');
    const all = p.fields.map((f) => f.value.replace(/\s/g, '')).join(' ');
    assert.ok(all.includes('CZ9455000000005000123456') && all.includes('CZ6107100000001234567890'), all);
  });

  test('IBAN: check digits that pass on a number of the wrong length for its country are not called "not mistyped"', () => {
    // NO37 8601 1117 9470 has 16 characters; Norwegian IBANs have 15. mod 97 passes.
    const p = inspect('BCD\n002\n1\nSCT\n\nKleppesto Senter\nNO37860111179470\nEUR10.00\n\n\n\n');
    const iban = p.fields.find((f) => f.label === 'Account (IBAN)');
    assert.doesNotMatch(iban.note || '', /check digits pass/);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The decoder worker

describe('5. the decoder worker never reaches the network', () => {
  test('after a picture takes too long, the next picture is still read and nothing is fetched', { skip: NO_BROWSER, timeout: 90000 }, async () => {
    // stopDecoder() ends the worker and the next picture starts a new one, which fetches
    // src/qr-worker.js, the decoder and its 1.27 MB WebAssembly module again: seven requests
    // after load (seen 2026-10-11), and none possible offline once the cache has expired.
    // The worker is held in the debugger here, which is how a slow picture looks to the page.
    const workers = [];
    const app = await openApp({ workers, shortTimeout: true });
    const after = [];
    try {
      for (let i = 0; i < 50 && !workers.length; i++) await sleep(100);
      assert.ok(workers.length, 'the decoder worker started with the page');
      app.b.listeners.push((m) => {
        if (m.method === 'Network.requestWillBeSent') after.push(new URL(m.params.request.url).pathname);
      });
      await app.b.send('Debugger.enable', {}, workers[0]);
      await app.b.send('Debugger.pause', {}, workers[0]);
      await app.choose(path.join(FIX, 'link.png'));
      let status = '';
      for (let i = 0; i < 150 && !/too long/.test(status); i++) {
        await sleep(200);
        status = await app.b.evaluate("document.getElementById('pic-status').textContent");
      }
      assert.match(status, /too long/, 'the page gave up on the held picture');
      const st = await app.read(path.join(FIX, 'link.png'));
      assert.ok(st && st.shown && st.codes === 1, `the next picture was read: ${JSON.stringify(st)}`);
      assert.deepEqual(after, [], 'requests after load');
      // Added with the fixes: the spare is now in use and there is no other. A second picture
      // that takes too long stops the reader, which says so, and still nothing is fetched.
      assert.ok(workers.length >= 2, 'the spare worker started with the page');
      await app.b.send('Debugger.enable', {}, workers[1]);
      await app.b.send('Debugger.pause', {}, workers[1]);
      await app.b.evaluate("document.getElementById('clear-btn').click(), true");
      await app.choose(path.join(FIX, 'wifi.png'));
      status = '';
      for (let i = 0; i < 150 && !/load this page again/.test(status); i++) {
        await sleep(200);
        status = await app.b.evaluate("document.getElementById('pic-status').textContent");
      }
      assert.match(status, /stopped its picture reader\. To read another picture, load this page again/);
      await app.choose(path.join(FIX, 'link.png'));
      await sleep(600);
      status = await app.b.evaluate("document.getElementById('pic-status').textContent");
      assert.match(status, /^CheckLink stopped its picture reader after a picture took too long/);
      assert.deepEqual(after, [], 'requests after load, with the reader stopped');
    } finally {
      await app.close();
    }
  });

  test('the lockdown also takes away caches, nested workers, FontFace and WebSocketStream', { skip: !existsSync(CHROMIUM) && `Chromium not found at ${CHROMIUM}`, timeout: 60000 }, async () => {
    // The worker's only network guard when no Content-Security-Policy header comes with it
    // (an onion mirror or an app shell that sends none). Seen 2026-10-11 with
    // src/worker-lockdown.js loaded first: Cache.add, new Worker() and FontFace.load() each
    // reached the server. (import() cannot be taken away; only the header stops that.)
    const served = [];
    const WORKER = `import '/src/worker-lockdown.js';
      const out = { WebSocketStream: typeof WebSocketStream };
      try { const c = await caches.open('x'); await c.add('/canary-cache').catch(() => {}); } catch {}
      try { new Worker('/canary-worker.js'); } catch {}
      try { const f = new FontFace('x', 'url(/canary-font.woff2)'); fonts.add(f); await f.load().catch(() => {}); } catch {}
      await new Promise((r) => setTimeout(r, 400));
      postMessage(out);`;
    const files = {
      '/': ['text/html', '<!doctype html><meta charset="utf-8"><title>lockdown probe</title><script type="module" src="/page.js"></script>'],
      '/page.js': ['text/javascript', "const w = new Worker('/probe-worker.js', { type: 'module' }); w.onmessage = (e) => { window.__out = JSON.stringify(e.data); };"],
      '/probe-worker.js': ['text/javascript', WORKER],
      '/src/worker-lockdown.js': ['text/javascript', readFileSync(path.join(ROOT, 'src', 'worker-lockdown.js'))],
      '/canary-worker.js': ['text/javascript', '// canary'],
    };
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      served.push(url);
      const f = files[url];
      res.writeHead(f ? 200 : 404, { 'content-type': f ? f[0] : 'text/plain', 'cache-control': 'no-store' });
      res.end(f ? f[1] : 'not here');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const b = await startBrowser();
    try {
      await b.send('Runtime.enable', {}, b.sessionId);
      await b.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, b.sessionId);
      let out = null;
      for (let i = 0; i < 100 && !out; i++) {
        await sleep(100);
        out = await b.evaluate('window.__out || null');
      }
      assert.ok(out, 'the probe worker answered');
      await sleep(300);
      assert.deepEqual(served.filter((u) => u.startsWith('/canary')), [], 'requests the locked-down worker could still make');
      assert.equal(JSON.parse(out).WebSocketStream, 'undefined');
    } finally {
      await b.close();
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Other hostile or misleading content

describe('6. other hostile or misleading content', () => {
  test('a line separator (U+2028) in a payee name is marked: it can fake a second labelled line', () => {
    // Rendered with white-space: pre-wrap, "Pay to" showed a made-up "Account (IBAN) NO93 ..."
    // on its own line above the real account. U+2028 is neither Cf nor Default_Ignorable, so it
    // gets no mark and no warning.
    const p = inspect('BCD\n002\n1\nSCT\n\nKleppesto Senter AS Account (IBAN)  NO93 8601 1117 947\nNO9386011117947\nEUR10.00\n\n\nInvoice 2026-114\n');
    assert.ok(p.warnings.some((w) => w.id === 'invisible' || /line break|line separator|new line/i.test(w.text)), p.warnings.map((w) => w.id).join(', '));
  });

  test('a contact card whose web address is a script or an app launcher is flagged, not shown as a plain web address', () => {
    for (const url of ['javascript:alert(document.domain)', 'intent://pay#Intent;scheme=evil;package=com.evil;end']) {
      const p = inspect(`BEGIN:VCARD\nVERSION:3.0\nFN:Bank Support\nURL:${url}\nEND:VCARD`);
      assert.notEqual(p.tier, 'info', url);
    }
  });

  test('mailto: an attach= parameter (a local file some email apps attach) is shown and flagged', () => {
    // Mailto attachment parameters were abused against several desktop email apps (Mueller et
    // al., "Mailto: Me Your Secrets", 2020). Today the parameter is not shown at all.
    const p = inspect('mailto:support@example.com?subject=Invoice&body=See%20attached&attach=file:///home/user/.ssh/id_rsa');
    assert.ok(p.fields.some((f) => f.value.includes('id_rsa')), 'the file it asks to attach is shown');
    assert.notEqual(p.tier, 'info');
  });

  test('java<tab>script: and java<newline>script: are scripts: browsers drop tabs and newlines from addresses', () => {
    // The URL standard removes every ASCII tab and newline before parsing; today these read as
    // "Plain text. Nothing in it opens anything."
    for (const text of ['java\tscript:alert(document.cookie)', 'java\nscript:alert(document.cookie)']) assert.equal(inspect(text).tier, 'stop', JSON.stringify(text));
  });

  test('Wi-Fi: a code with a password but no security type does not say "no password"', () => {
    const p = inspect('WIFI:S:Home;P:hunter22;;');
    const security = p.fields.find((f) => f.label === 'Security').value;
    assert.ok(!/no password/i.test(security) && !p.warnings.some((w) => w.id === 'wifi-open'), `Security: ${security}`);
  });

  test('a code of invisible characters only is not called empty ("This code holds no text")', () => {
    const p = inspect('​​​​');
    assert.doesNotMatch(p.summary, /holds no text/);
  });

  test('a Lightning address warning names the owning domain first, as link warnings do', () => {
    const p = inspect('lightning:pay@pay.paypal.com.evil.co.uk');
    const w = p.warnings.find((x) => x.id === 'lightning-address');
    const own = w.text.indexOf('evil.co.uk');
    const full = w.text.indexOf('pay.paypal.com');
    assert.ok(own >= 0 && (full < 0 || own < full), w.text);
  });
});
