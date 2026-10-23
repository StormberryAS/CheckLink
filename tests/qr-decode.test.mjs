// Stage 2: the vendored decoder (zxing-wasm 3.1.6) run in Node on real pictures made with
// qrencode and ImageMagick (tests/fixtures/make-fixtures.sh), the picture header reader, and
// broken, hostile and oversized files. The browser runs the same src/qr-decode.js in its worker.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DecodeError, FORMATS, LIMITS, decodePicture, wasmAllowed } from '../src/qr-decode.js';
import { DECODES_DIRECTLY, orientPoint, orientedSize, sniffImage } from '../src/image-check.js';
import { inspect } from '../src/qr-inspect.js';

const FIX = new URL('./fixtures/qr/', import.meta.url);
const read = (f) => readFileSync(new URL(f, FIX));
const LINK = 'https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&utm_campaign=autumn&id=42';
const fails = async (bytes, code) => {
  try {
    await decodePicture(bytes);
  } catch (err) {
    assert.ok(err instanceof DecodeError, String(err));
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}`);
};

describe('the vendored decoder', () => {
  test('the shipped wasm module is the pinned zxing_reader.wasm, byte for byte', () => {
    const src = readFileSync(new URL('../vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js', import.meta.url), 'utf8');
    const b64 = /^export default '([A-Za-z0-9+/=]+)';$/m.exec(src)[1];
    const wasm = Buffer.from(b64, 'base64');
    assert.equal(wasm.length, 946860);
    assert.equal(createHash('sha256').update(wasm).digest('hex'), '5003fb4b88c4fbd1fd518a2fd8c8ad365c519e183a08c03a322dddfea3cea84e');
    const lock = JSON.parse(readFileSync(new URL('../tools/upstream.lock.json', import.meta.url), 'utf8'));
    const z = lock.vendored.find((v) => v.id === 'zxing-wasm');
    assert.equal(z.version, '3.1.6');
    assert.equal(z.integrity, 'sha512-mU7UNuvl+hOT+nlSOQTMHZ2tM8lRMsbjDIp5IO/+HmBl/FOq77q0OSZPJ3cm42A9c1MKU6Uve67FiGdkhsrT9g==');
  });
  test('WebAssembly is allowed here, and the decoder reads every format it was asked for', () => {
    assert.equal(wasmAllowed(), true);
    assert.ok(FORMATS.includes('QRCode') && FORMATS.includes('DataMatrix') && FORMATS.includes('EAN13'));
  });
  test('the decoder never fetches: it reads a picture with fetch and XMLHttpRequest taken away first', () => {
    const script = `
      await import(${JSON.stringify(new URL('../src/worker-lockdown.js', import.meta.url).href)});
      globalThis.fetch !== undefined && process.exit(3);
      const { decodePicture } = await import(${JSON.stringify(new URL('../src/qr-decode.js', import.meta.url).href)});
      const { readFileSync } = await import('node:fs');
      const r = await decodePicture(readFileSync(new URL('link.png', ${JSON.stringify(FIX.href)})));
      console.log(r.codes[0].text);`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), LINK);
  });
  test('the decoder module and the worker contain no network calls of their own', () => {
    for (const f of ['qr-decode.js', 'qr-worker.js', 'image-check.js']) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
      for (const banned of ['fetch(', 'XMLHttpRequest(', 'new WebSocket', 'new EventSource', 'sendBeacon', 'importScripts(']) assert.ok(!src.includes(banned), `${f}: ${banned}`);
    }
  });
});

describe('real pictures (made locally with qrencode and ImageMagick)', () => {
  test('the same link from PNG, JPEG, GIF, BMP, a photo-like JPEG and a JPEG stored sideways', async () => {
    for (const f of ['link.png', 'link.jpg', 'link.gif', 'link.bmp', 'link-photo.jpg', 'link-exif6.jpg']) {
      const { image, codes } = await decodePicture(read(f));
      assert.equal(codes.length, 1, f);
      assert.equal(codes[0].text, LINK, f);
      assert.equal(codes[0].format, 'QRCode', f);
      assert.ok(codes[0].position && codes[0].position.topLeft, f);
      assert.ok(DECODES_DIRECTLY.has(image.type), f);
    }
    assert.equal((await decodePicture(read('link-exif6.jpg'))).image.orientation, 6);
  });
  test('every kind of code in the fixtures reads to the payload the inspector expects', async () => {
    const want = {
      'wifi.png': ['wifi', 'info'], 'otp.png': ['secret', 'stop'], 'seed.png': ['secret', 'stop'], 'epc.png': ['payment', 'check'], 'bitcoin.png': ['payment', 'check'],
      'vcard.png': ['contact', 'info'], 'intent.png': ['app', 'check'], 'script.png': ['script', 'stop'], 'rlo.png': ['text', 'check'], 'upper.png': ['web', 'info'],
      'aztec.png': ['boarding-pass', 'check'], 'datamatrix.png': ['email', 'check'], 'pdf417.png': ['phone', 'check'], 'ean13.png': ['product', 'info'], 'second.png': ['web', 'info'],
    };
    for (const [f, [kind, tier]] of Object.entries(want)) {
      const { codes } = await decodePicture(read(f));
      assert.equal(codes.length, 1, f);
      const p = inspect(codes[0].text, { bytes: codes[0].bytes, format: codes[0].format, contentType: codes[0].contentType });
      assert.equal(p.kind, kind, f);
      assert.equal(p.tier, tier, f);
    }
  });
  test('two codes in one picture each come back, with their own positions', async () => {
    const { codes } = await decodePicture(read('two-codes.png'));
    assert.deepEqual(codes.map((c) => c.text).sort(), [LINK, 'https://evil.example/login?utm_source=sticker'].sort());
    assert.notDeepEqual(codes[0].position, codes[1].position);
  });
  test('a picture with no code gives no code', async () => {
    assert.equal((await decodePicture(read('nocode.png'))).codes.length, 0);
  });
});

describe('broken, hostile and oversized files', () => {
  test('text, an empty file and junk are not pictures', async () => {
    await fails(read('not-image.png'), 'not-image');
    await fails(read('empty.png'), 'not-image');
    await fails(new Uint8Array(1000).fill(65), 'not-image');
  });
  test('a header that claims 900 megapixels is refused before anything is decoded', async () => {
    const t0 = performance.now();
    const err = await fails(read('huge-header.png'), 'too-many-pixels');
    assert.deepEqual(err.detail, { width: 30000, height: 30000 });
    assert.ok(performance.now() - t0 < 200);
  });
  test('a file over 40 MB is refused before it is read', async () => {
    const big = new Uint8Array(LIMITS.bytes + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fails(big, 'too-large');
  });
  test('a truncated picture gives no code and no crash', async () => {
    assert.equal((await decodePicture(read('truncated.png'))).codes.length, 0);
  });
  test('AVIF and HEIC need the browser’s own picture decoder; without one they are refused plainly', async () => {
    await fails(read('link.avif'), 'unsupported');
    await fails(read('link.heic'), 'unsupported');
  });
  test('fuzz: 300 files of random bytes behind real picture headers never escape as anything but a DecodeError', async () => {
    let seed = 20261011;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const heads = [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], [0xff, 0xd8, 0xff, 0xe0], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], [0x42, 0x4d]];
    const t0 = performance.now();
    for (let n = 0; n < 300; n++) {
      const head = heads[n % heads.length];
      const body = new Uint8Array(16 + Math.floor(rand() * 4000));
      for (let i = 0; i < body.length; i++) body[i] = Math.floor(rand() * 256);
      body.set(head);
      try {
        const r = await decodePicture(body);
        assert.ok(Array.isArray(r.codes));
      } catch (err) {
        assert.ok(err instanceof DecodeError, String(err));
      }
    }
    assert.ok(performance.now() - t0 < 30000);
  });
});

describe('the picture header reader', () => {
  test('kinds and sizes from the first bytes, never from the name', () => {
    assert.deepEqual(sniffImage(read('link.png')), { type: 'png', width: 392, height: 392, orientation: 1 });
    assert.deepEqual(sniffImage(read('link.jpg')), { type: 'jpeg', width: 392, height: 392, orientation: 1 });
    assert.deepEqual(sniffImage(read('link.gif')), { type: 'gif', width: 392, height: 392, orientation: 1 });
    assert.deepEqual(sniffImage(read('link.bmp')), { type: 'bmp', width: 392, height: 392, orientation: 1 });
    assert.equal(sniffImage(read('link.avif')).type, 'avif');
    assert.equal(sniffImage(read('link.heic')).type, 'heic');
    assert.equal(sniffImage(read('not-image.png')).type, null);
    assert.equal(sniffImage(new Uint8Array(0)).type, null);
    assert.equal(sniffImage(read('link.jpg').subarray(0, 40)).type, 'jpeg', 'a cut JPEG is still a JPEG, with no size');
    const webp = new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x03, 0, 0xdf, 0x01, 0]);
    assert.deepEqual(sniffImage(webp), { type: 'webp', width: 1024, height: 480, orientation: 1 });
  });
  test('EXIF orientation: points and sizes turned the way the camera meant, for all eight values', () => {
    const w = 400;
    const h = 300;
    const corner = { x: 10, y: 20 };
    const expect = { 1: [10, 20], 2: [390, 20], 3: [390, 280], 4: [10, 280], 5: [20, 10], 6: [280, 10], 7: [280, 390], 8: [20, 390] };
    for (const [o, [x, y]] of Object.entries(expect)) {
      const p = orientPoint(corner, w, h, Number(o));
      assert.deepEqual([p.x, p.y], [x, y], `orientation ${o}`);
      const size = orientedSize(w, h, Number(o));
      assert.ok(p.x >= 0 && p.x <= size.width && p.y >= 0 && p.y <= size.height, `inside the turned picture for ${o}`);
    }
  });
  test('every fixture’s header is read without a throw', () => {
    for (const f of readdirSync(FIX)) assert.doesNotThrow(() => sniffImage(read(f)), f);
  });
});
