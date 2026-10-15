// Stage 3: the live camera, the parts that can be checked without a browser. The vendored decoder
// reads one camera frame (RGBA pixels, as the page draws it from the preview) in Node, exactly as
// the worker does; the test helpers that make the fake camera's video for tests/e2e.mjs are
// checked; and the page's camera code is read as text to prove what it may and may not do. The
// camera itself, with Chromium's fake camera, is in tests/e2e.mjs and tests/ui-smoke.mjs.
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DecodeError, FRAME_SIDE, decodeFrame } from '../src/qr-decode.js';
import { frameWith, pngPixels, y4m } from './png-pixels.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT));
const text = (f) => read(f).toString('utf8');
const code = (f) => text(f).replace(/^\s*\/\/.*$/gm, '');
const LINK = 'https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&utm_campaign=autumn&id=42';
const fails = async (input, want) => {
  try {
    await decodeFrame(input);
  } catch (err) {
    assert.ok(err instanceof DecodeError, String(err));
    assert.equal(err.code, want);
    return;
  }
  assert.fail(`expected ${want}`);
};

describe('one camera frame through the vendored decoder', () => {
  const link = pngPixels(read('tests/fixtures/qr/link.png'));

  test('a 1280 by 720 frame with the code in the middle is read, as the worker reads it', async () => {
    const f = frameWith(link, { width: 1280, height: 720, size: 360, seed: 7 });
    const r = await decodeFrame(f);
    assert.deepEqual(r.image, { type: 'frame', width: 1280, height: 720, orientation: 1 });
    assert.equal(r.codes.length, 1);
    assert.equal(r.codes[0].text, LINK);
    assert.equal(r.codes[0].format, 'QRCode');
  });

  test('a small, noisy frame (480 by 360, the fake camera of the browser tests) is read too', async () => {
    const f = frameWith(link, { width: 480, height: 360, size: 280, seed: 101 });
    const r = await decodeFrame(f);
    assert.equal(r.codes[0] && r.codes[0].text, LINK);
  });

  test('a frame with no code gives no codes and no error, so scanning goes on', async () => {
    const f = frameWith(null, { width: 640, height: 480, seed: 3 });
    const r = await decodeFrame(f);
    assert.deepEqual(r.codes, []);
  });

  test('two codes in one frame are both read (the page then warns about stickers)', async () => {
    const two = pngPixels(read('tests/fixtures/qr/two-codes.png'));
    const f = frameWith(two, { width: 1280, height: 960, size: 900, seed: 5 });
    const r = await decodeFrame(f);
    assert.equal(r.codes.length, 2);
  });

  test('a frame of the wrong size, a missing frame, or one larger than the limit is refused as not a picture', async () => {
    await fails({ data: new Uint8ClampedArray(10), width: 2, height: 2 }, 'not-image');
    await fails({ data: new Uint8ClampedArray(16), width: 2.5, height: 2 }, 'not-image');
    await fails({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 'not-image');
    await fails({ width: 2, height: 2 }, 'not-image');
    await fails(undefined, 'not-image');
    await fails({ data: { length: (FRAME_SIDE + 1) * 4 }, width: FRAME_SIDE + 1, height: 1 }, 'not-image');
  });

  test('the decoder reads a frame with fetch and XMLHttpRequest taken away first: a frame never needs the network', () => {
    const script = `
      await import(${JSON.stringify(new URL('src/worker-lockdown.js', ROOT).href)});
      globalThis.fetch !== undefined && process.exit(3);
      const { decodeFrame } = await import(${JSON.stringify(new URL('src/qr-decode.js', ROOT).href)});
      const { pngPixels, frameWith } = await import(${JSON.stringify(new URL('tests/png-pixels.mjs', ROOT).href)});
      const { readFileSync } = await import('node:fs');
      const code = pngPixels(readFileSync(new URL('tests/fixtures/qr/link.png', ${JSON.stringify(ROOT.href)})));
      const r = await decodeFrame(frameWith(code, { width: 640, height: 480, size: 300, seed: 9 }));
      console.log(r.codes[0].text);`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), LINK);
  });
});

describe('the fake camera video for the browser tests', () => {
  test('pngPixels reads the fixture, and frameWith puts it in a frame of the asked size', () => {
    const p = pngPixels(read('tests/fixtures/qr/link.png'));
    assert.ok(p.width > 20 && p.height === p.width && p.data.length === p.width * p.height * 4);
    const f = frameWith(p, { width: 320, height: 240, size: 200, seed: 1 });
    assert.ok(f.width === 320 && f.height === 240 && f.data.length === 320 * 240 * 4);
    const g = frameWith(null, { width: 320, height: 240, seed: 1 });
    assert.equal(g.data.length, 320 * 240 * 4);
    assert.notDeepEqual(f.data, g.data);
  });

  test('y4m writes a 4:2:0 video Chromium can play: one header, then a FRAME line and Y, U and V planes per frame', () => {
    const frames = [frameWith(null, { width: 64, height: 48, seed: 1 }), frameWith(null, { width: 64, height: 48, seed: 2 })];
    const v = y4m(frames, { width: 64, height: 48, fps: 10 });
    const head = v.toString('latin1', 0, v.indexOf(0x0a) + 1);
    assert.match(head, /^YUV4MPEG2 W64 H48 F10:1 .*C420.*\n$/);
    const per = 'FRAME\n'.length + 64 * 48 + 2 * (32 * 24);
    assert.equal(v.length, head.length + 2 * per);
    assert.equal(v.toString('latin1', head.length, head.length + 6), 'FRAME\n');
  });
});

describe('what the page’s camera code may and may not do (read as text)', () => {
  const app = code('app.js');
  const html = text('index.html');

  test('the camera is asked for in one place only, for video and never sound, preferring the rear camera', () => {
    assert.equal(app.split('getUserMedia(').length - 1, 1, 'one call');
    assert.match(app, /getUserMedia\(\{ audio: false, video \}\)/);
    assert.match(app, /facingMode: \{ ideal: 'environment' \}/);
  });

  test('nothing is recorded, saved, sent or drawn where it can be seen: no MediaRecorder, no download, no image capture', () => {
    for (const banned of ['MediaRecorder', 'ImageCapture', 'takePhoto', 'toDataURL', 'toBlob', 'localStorage', 'indexedDB', 'sessionStorage', 'fetch(', 'sendBeacon', 'XMLHttpRequest']) {
      assert.ok(!app.includes(banned), banned);
    }
    // Stage 4b: the page's one download is Save picture of the QR code of the clean link, a PNG it
    // writes itself from the link's text (never from the camera or a canvas), let go of at once.
    assert.equal(app.split('createObjectURL(').length - 1, 1, 'one blob: address in the whole page');
    const save = /function saveQr\(\) \{[\s\S]*?\n\}/.exec(app)[0];
    assert.match(save, /URL\.createObjectURL\(qrBlob\(\)\)/);
    assert.match(save, /URL\.revokeObjectURL\(url\)/);
    assert.match(app, /const qrBlob = \(\) => new Blob\(\[state\.qr\.png\], \{ type: 'image\/png' \}\);/);
  });

  test('the camera stops on every way out: a code found, Stop camera, Escape, a hidden or left page, typing, a picture, Clear, the time limit and a lost camera', () => {
    for (const [what, rx] of [
      ['a code found', /reply\.codes\.length\) \{[\s\S]{0,200}?stopCamera\(\);/],
      ['Stop camera', /'cam-stop'\)\.addEventListener\('click', \(\) => stopCamera\(/],
      // Since the stage 3 fixes Escape is heard on the whole page while the camera is on (camera
      // review C4), and a hidden page brings focus back to Scan with camera (interface review M6).
      ['Escape', /document\.addEventListener\('keydown', \(ev\) => \{\n\s*if \(ev\.key === 'Escape'\) \{[\s\S]{0,400}?stopCamera\(CAM\.stopped/],
      // Stage 4b (Q4): inside the Android app the line says "you left CheckLink".
      ['a hidden page', /visibilitychange[\s\S]{0,160}?stopCamera\((?:inApp\(\) \? CAM\.hiddenApp : )?CAM\.hidden[,)]/],
      ['a left page', /'pagehide', \(\) => stopCamera\(\)/],
      ['typing', /input\.addEventListener\('input', \(ev\) => \{[\s\S]{0,240}?stopCamera\(CAM\.stopped\)/],
      ['a picture', /async function readPicture[\s\S]{0,80}?stopCamera\(\);/],
      ['Clear', /'clear-btn'\)\.addEventListener\('click', \(\) => \{\n\s*stopCamera\(\);/],
      ['the time limit', /Date\.now\(\) > cam\.until\) \{\n\s*stopCamera\(CAM\.timeout/],
      // The limit is also a timer of its own, set as soon as the camera is given (camera review C1).
      ['the time limit, even with no picture', /cam\.limit = setTimeout\(\(\) => \{\n\s*if \(run === cam\.run && cameraOn\(\)\) stopCamera\(CAM\.timeout/],
      ['a lost camera', /addEventListener\('ended', \(\) => \{\n\s*if \(cam\.stream === stream\) stopCamera\(CAM\.ended/],
    ]) assert.match(app, rx, what);
    assert.match(app, /const SCAN_FOR_MS = 120000;/, 'two minutes');
  });

  test('stopping ends every track and empties the preview and the frame canvas', () => {
    const stop = /function stopCamera\([\s\S]*?\n\}/.exec(app)[0];
    for (const want of ['stopTracks(cam.stream)', 'cam.stream = null', 'video.srcObject = null', 'cam.canvas.width = 0', 'cam.canvas.height = 0', 'card.hidden = true', 'clearTimeout(cam.limit)']) assert.ok(stop.includes(want), want);
    // The limit starts the moment the camera is given, before the preview is asked to play.
    assert.match(app, /startLimit\(run\);\n\s*if \(!\(await attachStream\(stream, run\)\)\) return;/);
  });

  test('frames are read at most four times a second, one at a time, at most 1280 pixels on the longer side', () => {
    assert.match(app, /const SCAN_INTERVAL_MS = 250;/);
    assert.match(app, /const FRAME_MAX = 1280;/);
    // The next frame is scheduled only after the last one's reply has come back.
    assert.match(app, /const reply = await decodeWith\(\{ type: 'frame'[\s\S]*?cam\.timer = setTimeout\(\(\) => scanFrame\(run\), SCAN_INTERVAL_MS\);\n\}/);
  });

  test('a frame the browser made up is told apart from a real one: see-through or pure white counts, dark or noisy does not', () => {
    const src = /function hiddenFrame\(data\) \{[\s\S]*?\n\}/.exec(app)[0];
    const hiddenFrame = new Function(`${src}; return hiddenFrame;`)();
    const frame = (fill) => { const d = new Uint8ClampedArray(320 * 240 * 4); for (let i = 0; i < d.length; i += 4) fill(d, i); return d; };
    // LibreWolf with fingerprinting protection: random values, a few colours repeated, alpha random.
    assert.equal(hiddenFrame(frame((d, i) => { const v = ((i >> 5) * 2654435761) >>> 0; d[i] = v & 255; d[i + 1] = (v >> 8) & 255; d[i + 2] = (v >> 16) & 255; d[i + 3] = v >>> 24; })), true);
    assert.equal(hiddenFrame(frame((d, i) => { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; })), true, 'transparent');
    assert.equal(hiddenFrame(frame((d, i) => { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255; })), true, 'blank white');
    assert.equal(hiddenFrame(frame((d, i) => { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; })), false, 'the lens covered');
    assert.equal(hiddenFrame(frame((d, i) => { d[i] = 40; d[i + 1] = 40; d[i + 2] = 40; d[i + 3] = 255; })), false, 'an even grey wall');
    assert.equal(hiddenFrame(frameWith(null, { width: 320, height: 240, seed: 4 }).data), false, 'a noisy camera picture');
  });

  test('a frame from the camera is never drawn on the page: showPicture draws only pictures', () => {
    assert.match(app, /const drawIt = !camera && /);
  });

  test('Scan with camera is hidden until the page finds a camera interface, and asks for nothing at load', () => {
    assert.match(html, /<button [^>]*id="cam-btn"[^>]*hidden>Scan with camera<\/button>/);
    assert.match(html, /<p class="cl-help" id="cam-help" hidden>/);
    assert.match(html, /<section class="card cl-card cl-camera" id="camera-card"[^>]*hidden>/);
    // The only code that runs at load is the interface check; the camera is asked for on a press.
    assert.match(app, /\$\('cam-btn'\)\.addEventListener\('click', \(\) => startCamera\(\)\)/);
    assert.ok(!/enumerateDevices[\s\S]*function startCamera/.test(app), 'cameras are listed only inside startCamera, after the camera is allowed');
  });

  test('the preview is muted, inline, hidden from screen readers, with a spoken status line instead', () => {
    assert.match(html, /<video class="cl-cam-video" id="cam-video" muted playsinline aria-hidden="true"><\/video>/);
    assert.match(html, /<p class="cl-status" id="cam-status" role="status" aria-live="polite"><\/p>/);
  });

  test('no file input asks the phone’s camera app for a photo: the live camera replaced that plan (Decision 2)', () => {
    assert.ok(!/\scapture=/.test(html));
  });

  test('the page policy is unchanged by the camera: still no connections and no media from elsewhere', () => {
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    assert.match(meta, /connect-src 'none'/);
    assert.match(meta, /default-src 'self'/);
    assert.ok(!/media-src/.test(meta), 'a MediaStream needs no media-src');
  });
});

describe('the deploy-time camera header', () => {
  const serve = text('tests/serve.py');
  const notice = text('NOTICE');
  const zone = /ZONE_PERMISSIONS = \(([\s\S]*?)\n\)/.exec(serve)[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).join('');
  const host = zone.replace('camera=()', 'camera=(self)');

  test('the test server sends the zone’s Permissions-Policy with camera=(self) and nothing else changed', () => {
    assert.ok(zone.includes('camera=()') && zone.includes('microphone=()'));
    assert.match(serve, /HOST_PERMISSIONS = ZONE_PERMISSIONS\.replace\("camera=\(\)", "camera=\(self\)"\)/);
    assert.match(serve, /\("Permissions-Policy", HOST_PERMISSIONS\)/);
  });

  test('NOTICE gives Marcos the exact header to set in Cloudflare, the same as the test server sends', () => {
    assert.ok(notice.includes(`    ${host}\n`), 'the header line');
    assert.match(notice, /Permissions-Policy \(from stage 3, for Scan with camera\)/);
    assert.match(notice, /action Set/);
  });

  test('NOTICE records the Unicode data and the brand list that stage 3 ships', () => {
    const lock = JSON.parse(text('tools/upstream.lock.json'));
    const cf = lock.vendored.find((v) => v.id === 'unicode-confusables');
    assert.ok(notice.includes(cf.sha256) && notice.includes(`Version:   ${cf.version}, dated ${cf.file_date}`));
    const brands = JSON.parse(text('rules/brands.json'));
    assert.ok(notice.includes(`version ${brands.version}, dated ${brands.date}`));
    assert.ok(notice.includes(`${brands.brands.length} brands`));
  });
});
