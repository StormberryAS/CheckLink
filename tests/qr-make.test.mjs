// Stage 4b: a QR code of the clean link (decisions QR-1 to QR-6 and PD-1 of 11 October 2026).
//   * the vendored encoder: Nayuki's QR Code generator, pinned by commit, converted once to plain
//     JavaScript, recorded in the lock, licensed and named in NOTICE;
//   * the refusal rule: every warning id and tier, short links, sign-in and recipient links, and
//     every reason of the Email us line's personal-data test, one of them hidden inside another
//     address;
//   * what the code holds: the clean link with only its host in the ASCII form, the rest exactly
//     as written;
//   * the PNG CheckLink writes itself: only IHDR, IDAT and IEND, 1-bit greyscale, square, stored
//     (uncompressed) deflate blocks, correct CRC and Adler-32, the same bytes for the same link,
//     and never more than MAX_SIDE pixels a side;
//   * the read-back: every link of the provider corpus and Marcos's regression links that may get a
//     code is made, written as a PNG and read back by the vendored decoder (src/qr-decode.js, as the
//     page's worker does) to exactly the text it holds, plus links with ø, æ, å and Japanese;
//   * what the page does with it, read as text (app.js, index.html, style.css);
//   * since 12 October 2026: the QR wording Marcos approved word for word (SC-1), and SC-9, the
//     short QR line when the line above Copy and Share already gives the same reason, decided
//     from reason codes for every pair.
// Run from the repository root with: node --test tests/
//
// Node 24 built-ins only.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 as zlibCrc32, inflateSync } from 'node:zlib';

import { analyse, heldReason, personalReasons, reportMail } from '../src/link-core.js';
import { MAX_BYTES, MAX_SIDE, MODULE_PX, QR_FILE, QR_REFUSED, QR_SAME_AS, QR_SAME_REASON, QUIET, adler32, crc32, makeQr, pngScale, qrNote, qrPath, qrPng, qrRefusal, qrText } from '../src/qr-make.js';
import { decodePicture } from '../src/qr-decode.js';
import qrcodegen from '../vendor/qrcodegen-8329a71/qrcodegen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const lock = JSON.parse(text('tools/upstream.lock.json'));
const entry = lock.vendored.find((v) => v.id === 'qrcodegen');

// The refusal for the default choice of a link, as its id (null: a code may be made).
const refusalOf = (link, removed) => {
  const a = analyse(link);
  const r = qrRefusal(a, removed ?? a.defaultRemoved);
  return r ? r.id : null;
};

// The PNG's chunks, each with its type, data and stored CRC.
function chunks(png) {
  const b = Buffer.from(png);
  const out = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    out.push({ type: b.toString('latin1', o + 4, o + 8), data: b.subarray(o + 8, o + 8 + len), crc: b.readUInt32BE(o + 8 + len), typeAndData: b.subarray(o + 4, o + 8 + len) });
    o += 12 + len;
  }
  return out;
}

// The stored deflate blocks of a zlib stream: [{ final, type, len }], and the data they hold.
function storedBlocks(z) {
  const blocks = [];
  const parts = [];
  let o = 2;
  for (;;) {
    const head = z[o];
    const type = (head >> 1) & 3;
    const len = z[o + 1] | (z[o + 2] << 8);
    const nlen = z[o + 3] | (z[o + 4] << 8);
    blocks.push({ final: head & 1, type, len, nlenOk: ((~len) & 0xffff) === nlen });
    parts.push(z.subarray(o + 5, o + 5 + len));
    o += 5 + len;
    if (head & 1) break;
  }
  return { blocks, data: Buffer.concat(parts), adler: Buffer.from(z).readUInt32BE(o), end: o + 4 };
}

const makePng = (t) => qrPng(makeQr(t));

describe('the vendored encoder: Nayuki’s QR Code generator', () => {
  test('the TypeScript source is the pinned upstream file, byte for byte', () => {
    const src = readFileSync(path.join(ROOT, entry.path));
    assert.equal(src.length, entry.bytes);
    assert.equal(sha256(src), entry.sha256);
    assert.equal(entry.sha256, '1dc03fb5a10e0e2318ea162755bbdb9977ca6ce52cff959e9c9b6deafdccda9c');
    const blob = createHash('sha1').update(`blob ${src.length}\0`).update(src).digest('hex');
    assert.equal(blob, entry.git_blob);
  });

  test('the pin is an exact commit, said plainly to be untagged, past the release-age rule (14 days when it was pinned on 2026-10-11, stricter than today\'s 3 days)', () => {
    assert.match(entry.commit, /^[0-9a-f]{40}$/);
    assert.equal(entry.commit, '8329a7108fc22be3e1eec0a9f9318978579e3621');
    assert.ok(entry.source.includes(entry.commit));
    assert.match(entry.tag, /^none: an untagged commit/);
    const days = (Date.parse('2026-10-11') - Date.parse(entry.commit_date)) / 86400000;
    assert.ok(days >= 14, `${days} days`);
    assert.ok(entry.converted.startsWith(`vendor/qrcodegen-${entry.commit.slice(0, 7)}/`), 'the folder is named with the commit');
  });

  test('the converted file is the recorded conversion: CheckLink’s header, the compiler’s output, one export line', () => {
    const js = readFileSync(path.join(ROOT, entry.converted));
    assert.equal(js.length, entry.converted_bytes);
    assert.equal(sha256(js), entry.converted_sha256);
    const s = js.toString('utf8');
    assert.ok(s.startsWith("// Nayuki's QR Code generator library (TypeScript), converted to plain JavaScript for CheckLink.\n"));
    assert.ok(s.endsWith('\nexport default qrcodegen;\n'));
    assert.equal(s.split('export ').length - 1, 1, 'one export, the last line');
    // The upstream licence travels inside the file too.
    assert.ok(s.includes(' * Copyright (c) Project Nayuki. (MIT License)'));
    // The conversion tool is pinned like everything else, and ships nothing.
    const tool = entry.conversion.tool;
    assert.equal(tool.package, 'typescript');
    assert.equal(tool.version, '5.9.3');
    assert.match(tool.integrity, /^sha512-/);
    assert.equal(tool.ships, false);
    assert.deepEqual(entry.conversion.compiler_options, { target: 'ES2015', strict: true, newLine: 'lf', removeComments: false });
  });

  test('the encoder cannot reach the network and runs nothing it builds from text', () => {
    const code = text(entry.converted).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts', 'import(', 'eval(', 'new Function', 'document.', 'window.']) assert.ok(!code.includes(banned), banned);
    assert.equal(typeof qrcodegen.QrCode.encodeText, 'function');
  });

  test('its licence ships in licences/, is recorded in the lock and named in NOTICE', () => {
    const lic = lock.licence_files.find((l) => l.path === 'licences/QR-Code-generator-MIT.txt');
    assert.ok(lic);
    assert.equal(sha256(readFileSync(path.join(ROOT, lic.path))), lic.sha256);
    const body = text(lic.path);
    assert.ok(body.includes('Copyright (c) Project Nayuki. (MIT License)'));
    assert.ok(body.includes('Permission is hereby granted, free of charge'));
    const notice = text('NOTICE');
    assert.ok(notice.includes('licences/QR-Code-generator-MIT.txt'));
    assert.ok(notice.includes(entry.commit));
    assert.ok(notice.includes(entry.converted_sha256));
  });

  test('the encoder gives the same code every time, error correction M or better, with a mask of its own choosing', () => {
    const a = makeQr('https://www.example.com/');
    const b = makeQr('https://www.example.com/');
    assert.equal(a.size, b.size);
    assert.equal(qrPath(a), qrPath(b));
    assert.ok(['M', 'Q', 'H'].includes(a.ecc));
    assert.equal(a.size, 17 + 4 * a.version);
    assert.equal(makeQr('x'.repeat(MAX_BYTES)).version, 40);
    assert.equal(makeQr('x'.repeat(MAX_BYTES + 1)), null, 'too long for one code');
  });

  test('plain ASCII is encoded as it is; letters outside English left in a path or query go in as UTF-8 with the ECI marker', () => {
    assert.equal(makeQr('https://www.example.com/a?b=c').eci, false);
    assert.equal(makeQr('https://xn--r8jz45g.jp/パス?q=値').eci, true);
    assert.equal(makeQr('https://www.example.no/blåbær').eci, true);
    // The marker takes room: near the limit the encoder decides, and says when it does not fit.
    // MAX_BYTES of plain ASCII fit; with the marker, one byte fewer.
    assert.ok(makeQr(`https://example.com/a?x=ø${'y'.repeat(MAX_BYTES - 27)}`));
    const near = `https://example.com/a?x=ø${'y'.repeat(MAX_BYTES - 26)}`;
    assert.equal(new TextEncoder().encode(near).length, MAX_BYTES);
    assert.equal(makeQr(near), null);
    assert.equal(refusalOf(near), 'too-long');
  });
});

describe('which links get a code (strict refusal, decision QR-2)', () => {
  const PLAIN = 'https://www.example.com/shop/item?utm_source=qr&id=42';
  const base = analyse(PLAIN);

  test('an ordinary web link gets a code, whose text is its clean link', () => {
    assert.equal(qrRefusal(base, base.defaultRemoved), null);
    assert.equal(qrText(base.openUrl(base.defaultRemoved)).text, 'https://www.example.com/shop/item?id=42');
  });

  test('every warning the engine can give: a Stop or Check note refuses, Good to know does not (but an IP address of any kind does)', () => {
    const src = text('src/link-core.js');
    const pairs = new Set([...src.matchAll(/warnings\.add\('([a-z-]+)', '(stop|check|info)'/g)].map((m) => `${m[1]}:${m[2]}`));
    // hidden-address takes its tier from where the address goes; a rule's own note is info.
    pairs.add('hidden-address:check');
    pairs.add('provider-note:info');
    assert.ok(pairs.size >= 22, `${pairs.size} pairs`);
    for (const tier of ['stop', 'check', 'info']) {
      for (const pair of pairs) {
        const id = pair.split(':')[0];
        const a = { ...base, warnings: [{ id, tier, text: 'x' }] };
        const r = qrRefusal(a, base.defaultRemoved);
        // An IP address leads whoever scans the code to a device, whatever its tier (stage 4b
        // review S7): Good to know for a private or loopback one, Check for a public one.
        if (tier === 'info') assert.equal(r ? r.id : null, id === 'ip-address' ? 'device' : null, `${id} as ${tier}`);
        else assert.equal(r && r.id, 'notes', `${id} as ${tier}`);
      }
    }
  });

  test('the engine’s own warnings, from real links: each Check note refuses, each Good to know note does not', () => {
    let deep = 'https://example.org/deep?utm_source=x&k=1';
    for (let i = 0; i < 7; i++) deep = `https://www.google.com/url?q=${encodeURIComponent(deep)}&sa=D`;
    const cases = [
      ['https://google.com@evil.example/login', 'at-trick', 'notes'],
      ['https://evil.example\\@www.google.com/', 'disguised', 'notes'],
      ['https://1.2.3.4/x', 'ip-address', 'notes'],
      ['https://pаypal.com/login', 'look-alike-letters', 'notes'],
      ['https://www.norsk‐tipping.no/', 'look-alike-symbol', 'notes'],
      ['https://paypal.com.evil.io/signin', 'look-alike-brand', 'notes'],
      ['https://example.com/a​b', 'invisible', 'notes'],
      ['https://example.com/r?next=https%3A%2F%2Fevil.example%2F', 'hidden-address', 'notes'],
      ['https://example.com/r?next=https%3A%2F%2Fp%D0%B0ypal.com%2F', 'hidden-look-alike', 'notes'],
      [deep, 'deep-wrapper', 'notes'],
      ['http://example.com/a?utm_source=x', 'not-encrypted', 'notes'],
      ['https://192.168.1.1/admin', 'ip-address', 'device'],
      ['https://127.0.0.1:8080/', 'ip-address', 'device'],
      ['https://example.com/r?next=https%3A%2F%2Fexample.com%2Fb', 'hidden-address', null],
      ['https://user.github.io/x', 'shared-domain', null],
      ['www.example.no/side?fbclid=abc', 'no-scheme', null],
    ];
    for (const [link, id, want] of cases) {
      const a = analyse(link);
      assert.ok(a.warnings.some((w) => w.id === id), `${link} gives ${id}: ${a.warnings.map((w) => w.id)}`);
      assert.equal(refusalOf(link), want, link);
    }
  });

  test('two destinations in one wrapper: a Check note (and a short link), so no code', () => {
    const link = 'https://www.google.com/url?q=https%3A%2F%2Fa.example%2F&q=https%3A%2F%2Fb.example%2F';
    const a = analyse(link);
    assert.ok(a.warnings.some((w) => w.id === 'two-destinations' && w.tier === 'check'));
    assert.notEqual(refusalOf(link), null);
  });

  test('short links never get a code: their end is unknown', () => {
    for (const link of ['https://bit.ly/3abcDEF?utm_source=x', 'https://t.co/abc', 'https://tinyurl.com/abc123']) assert.equal(refusalOf(link), 'short', link);
  });

  test('a sign-in or reset link left untouched never gets a code, whatever is ticked', () => {
    const link = 'https://example.com/reset-password?token=abc123def456&utm_source=email';
    const a = analyse(link);
    assert.equal(heldReason(a, a.defaultRemoved), 'auth');
    assert.equal(refusalOf(link), 'auth');
    assert.equal(refusalOf(link, []), 'auth');
    assert.equal(QR_REFUSED.auth, 'No QR code for this link: whoever opens it may get into the account.');
  });

  test('a recipient token the page needs: no code while it is kept; removed anyway, the code is offered', () => {
    const link = 'https://example.com/unsubscribe?mc_eid=abc123&utm_source=x';
    const a = analyse(link);
    const token = a.kept.find((k) => k.reason === 'recipient-token');
    assert.ok(token);
    assert.equal(heldReason(a, a.defaultRemoved), 'recipient');
    assert.equal(refusalOf(link), 'recipient-held');
    const anyway = [...a.defaultRemoved, token.id];
    assert.equal(heldReason(a, anyway), null);
    assert.equal(qrRefusal(a, anyway), null);
    assert.equal(a.clean(anyway), 'https://example.com/unsubscribe');
  });

  test('every reason of the Email us line’s personal-data test refuses, with its own line', () => {
    const cases = [
      ['https://shop.example.com/confirm?email=someone%40example.no', 'email'],
      ['https://shop.example.com/confirm?mail=someone@example.no&id=4', 'email'],
      // An email address written in base64.
      ['https://example.com/?d=YUBiLm5v', 'email'],
      ['https://app.example.com/dash?session_id=abc123', 'signin'],
      ['https://api.example.com/v1/data?apikey=abcdef', 'signin'],
      ['https://example.com/login?password=hunter2', 'signin'],
      ['https://bucket.s3.amazonaws.com/f.pdf?X-Amz-Signature=abc&utm_source=x', 'signed'],
      ['https://urldefense.proofpoint.com/v2/url?u=https-3A__example.com&d=DwMF&c=x', 'wrapped'],
    ];
    for (const [link, why] of cases) {
      const a = analyse(link);
      assert.equal(personalReasons(a, a.defaultRemoved).clean, why, link);
      assert.equal(refusalOf(link), why, link);
      assert.equal(reportMail(a, a.defaultRemoved).cleanReason, why, 'the same test as the Email us line');
      assert.match(QR_REFUSED[why], /^No QR code for this link: /);
    }
  });

  test('personal details hidden inside another address refuse too: an email address and a password', () => {
    const email = 'https://example.com/r?next=https%3A%2F%2Fexample.org%2F%3Fu%3Dme%2540example.no';
    const pass = 'https://example.com/r?next=https%3A%2F%2Fuser%3Apass%40example.org%2F';
    assert.equal(refusalOf(email), 'email');
    assert.equal(refusalOf(pass), 'password');
  });

  test('a recipient part kept by hand refuses; removed (the default), the code is offered', () => {
    const link = 'https://www.linkedin.com/comm/jobs/view/123?midToken=AQabc&trk=x';
    const a = analyse(link);
    const part = a.parts.find((p) => /midtoken/i.test(p.name));
    assert.ok(part, 'midToken is a part');
    assert.equal(qrRefusal(a, a.defaultRemoved), null);
    const kept = a.defaultRemoved.filter((id) => id !== part.id);
    assert.equal(personalReasons(a, kept).clean, 'recipient');
    assert.equal(qrRefusal(a, kept).id, 'recipient');
  });

  test('personal details only in the parts removed: the clean link gets its code', () => {
    const link = 'https://example.com/a?mc_eid=abc123&utm_source=x';
    const a = analyse(link);
    assert.equal(personalReasons(a, a.defaultRemoved).original, 'recipient');
    assert.equal(personalReasons(a, a.defaultRemoved).clean, null);
    assert.equal(qrRefusal(a, a.defaultRemoved), null);
  });

  test('Safe Links: the clean link (the address inside) may get a code, the wrapper kept never does', () => {
    const link = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://example.org/page?utm_source=x&a=1')}&data=05%7C01%7Cme%40corp.no%7Cabc&sdata=AbCdEf0123456789&reserved=0`;
    const a = analyse(link);
    assert.equal(qrRefusal(a, a.defaultRemoved), null);
    assert.equal(qrText(a.openUrl(a.defaultRemoved)).text, 'https://example.org/page?a=1');
    const keepWrapper = a.defaultRemoved.filter((id) => id !== 'w0');
    assert.equal(qrRefusal(a, keepWrapper).id, 'email');
  });

  test('nothing that is not a web link: a script, plain text, no link', () => {
    for (const input of ['javascript:alert(1)', 'just words', '']) assert.equal(refusalOf(input), 'not-web', input);
  });

  test('a link too long for one QR code says so', () => {
    const link = `https://example.com/a?x=${'y'.repeat(3000)}&utm_source=z`;
    assert.equal(refusalOf(link), 'too-long');
  });

  test('the refusal lines are plain: one sentence each, and never "safe", "verified" or "clean QR code"', () => {
    for (const [id, line] of Object.entries(QR_REFUSED)) {
      assert.match(line, /^No QR code for this( link)?: [^:]+\.$/, id);
      assert.ok(!/\bsafe|verified|trusted|clean QR code|\u2014|\u2013|--/i.test(line), id);
    }
  });
});

describe('what the code holds (decision QR-5: only the host in its ASCII form)', () => {
  // The xn-- forms here were worked out apart from the browser's parser, with Python's idna codec.
  test('a host with letters outside English becomes its xn-- form; the path and the query stay exactly as written', () => {
    assert.deepEqual(qrText('https://blåbær.no/sti/blåbær?år=2026#topp'), { text: 'https://xn--blbr-roah.no/sti/blåbær?år=2026#topp', host: 'blåbær.no', ascii: true });
    assert.deepEqual(qrText('https://例え.jp/パス?q=値'), { text: 'https://xn--r8jz45g.jp/パス?q=値', host: '例え.jp', ascii: true });
    // Percent-encoding, +, capitals and a port are left alone.
    assert.equal(qrText('https://tromsø.no:8443/A%20b+c?Q=%C3%B8').text, 'https://xn--troms-zua.no:8443/A%20b+c?Q=%C3%B8');
  });

  test('a host written in ASCII stays as written, capitals included', () => {
    assert.deepEqual(qrText('https://WWW.Example.COM/Path?x=Y'), { text: 'https://WWW.Example.COM/Path?x=Y', host: 'WWW.Example.COM', ascii: false });
    assert.equal(qrText('https://[2001:db8::1]:8080/a').text, 'https://[2001:db8::1]:8080/a');
  });

  test('the rewrite never changes where the link goes', () => {
    for (const link of ['https://blåbær.no/', 'https://例え。jp/', 'https://ÆØÅ.example/', 'http://xn--blbr-roa2a.no/a']) {
      const q = qrText(link);
      assert.ok(q, link);
      assert.equal(new URL(q.text).hostname, new URL(link).hostname, link);
      assert.ok(/^[\x21-\x7e]+$/.test(new URL(q.text).host), link);
    }
  });

  test('only http and https addresses', () => {
    for (const link of ['mailto:a@b.no', 'javascript:alert(1)', 'www.example.no/side', 'ftp://example.com/', '', null]) assert.equal(qrText(link), null, String(link));
  });

  test('a link written without a scheme gets https:// (Go to’s form), so a scanner reads it as a link', () => {
    const a = analyse('www.example.no/side?fbclid=abc');
    assert.equal(a.clean(a.defaultRemoved), 'www.example.no/side');
    assert.equal(qrText(a.openUrl(a.defaultRemoved)).text, 'https://www.example.no/side');
  });
});

describe('the PNG CheckLink writes itself (decision QR-4)', () => {
  const LINK = 'https://www.example.com/shop/item?id=42';
  const png = makePng(LINK);
  const list = chunks(png);

  test('the PNG signature, then IHDR, IDAT and IEND, and nothing else', () => {
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(list.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
    assert.equal(list[2].data.length, 0);
    const end = 8 + list.reduce((n, c) => n + 12 + c.data.length, 0);
    assert.equal(end, png.length, 'nothing after IEND');
  });

  test('IHDR: square, 1-bit greyscale, deflate, no filter method but 0, not interlaced', () => {
    const h = list[0].data;
    const qr = makeQr(LINK);
    const side = (qr.size + 2 * QUIET) * pngScale(qr.size);
    assert.equal(h.readUInt32BE(0), side);
    assert.equal(h.readUInt32BE(4), side);
    assert.deepEqual([...h.subarray(8)], [1, 0, 0, 0, 0]);
  });

  test('every chunk’s CRC is right (checked against Node’s own zlib)', () => {
    for (const c of list) {
      assert.equal(c.crc, zlibCrc32(c.typeAndData), c.type);
      assert.equal(c.crc, crc32(c.typeAndData), c.type);
    }
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  test('IDAT is a zlib stream of stored (uncompressed) blocks with the right Adler-32', () => {
    const z = list[1].data;
    assert.equal(z[0], 0x78);
    assert.equal(((z[0] << 8) | z[1]) % 31, 0);
    assert.equal(z[1] & 0x20, 0, 'no preset dictionary');
    const { blocks, data, adler, end } = storedBlocks(z);
    assert.ok(blocks.every((b) => b.type === 0 && b.nlenOk && b.len <= 65535));
    assert.equal(blocks.filter((b) => b.final).length, 1);
    assert.equal(end, z.length);
    assert.equal(adler, adler32(data));
    // Node's inflate checks the Adler-32 itself, and gives back the same rows.
    assert.ok(inflateSync(z).equals(data));
    assert.equal(adler32(Buffer.from('Wikipedia')), 0x11e60398);
  });

  test('the pixels are the code: four white modules around it, then each module as a square of black or white', () => {
    const qr = makeQr(LINK);
    const scale = pngScale(qr.size);
    const side = (qr.size + 2 * QUIET) * scale;
    const raw = inflateSync(list[1].data);
    const stride = 1 + Math.ceil(side / 8);
    assert.equal(raw.length, stride * side);
    const pixel = (x, y) => (raw[y * stride + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
    for (let y = 0; y < side; y++) {
      assert.equal(raw[y * stride], 0, 'filter 0 on every row');
      for (let x = 0; x < side; x++) {
        const mx = Math.floor(x / scale) - QUIET;
        const my = Math.floor(y / scale) - QUIET;
        const inside = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size;
        const dark = inside && qr.dark(mx, my);
        if (pixel(x, y) !== (dark ? 0 : 1)) assert.fail(`pixel ${x},${y}`);
      }
      // The bits after the last pixel of a row are white.
      for (let x = side; x < (stride - 1) * 8; x++) assert.equal(pixel(x, y), 1);
    }
  });

  test('the same link always gives the same bytes; another link gives others', () => {
    assert.ok(Buffer.from(makePng(LINK)).equals(Buffer.from(png)));
    assert.ok(!Buffer.from(makePng(`${LINK}3`)).equals(Buffer.from(png)));
    // Pinned, so a change to the writer or the encoder cannot pass unnoticed.
    assert.equal(sha256(png), '7f4ca1c08d9deb971766fb4d6f3c6db9616fd2c3e659e3ab791e55b61a746324');
  });

  test('eight pixels a module, and never more than MAX_SIDE pixels a side: the largest code is about 108 KB', () => {
    assert.equal(MODULE_PX, 8);
    assert.equal(MAX_SIDE, 1000);
    for (let size = 21; size <= 177; size += 4) {
      const scale = pngScale(size);
      assert.ok((size + 2 * QUIET) * scale <= MAX_SIDE, `size ${size}`);
      assert.ok(scale >= 1 && scale <= MODULE_PX);
      if ((size + 2 * QUIET) * MODULE_PX <= MAX_SIDE) assert.equal(scale, MODULE_PX);
    }
    const big = makeQr(`https://example.com/?${'a'.repeat(MAX_BYTES - 21)}`);
    assert.equal(big.version, 40);
    const bytes = qrPng(big);
    const side = chunks(bytes)[0].data.readUInt32BE(0);
    assert.equal(side, 925);
    assert.ok(bytes.length > 100000 && bytes.length < 112000, `${bytes.length} bytes`);
    // A short link is about 11 KB.
    assert.ok(png.length > 9000 && png.length < 14000, `${png.length} bytes`);
  });

  test('the SVG path covers exactly the dark modules, one rectangle per run, inside the quiet zone', () => {
    const qr = makeQr(LINK);
    const grid = new Set();
    for (const m of qrPath(qr).matchAll(/M(\d+),(\d+)h(\d+)v1h-(\d+)z/g)) {
      assert.equal(m[3], m[4]);
      for (let i = 0; i < Number(m[3]); i++) grid.add(`${Number(m[1]) + i - QUIET},${Number(m[2]) - QUIET}`);
    }
    assert.equal(qrPath(qr).replace(/M\d+,\d+h\d+v1h-\d+z/g, ''), '');
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) assert.equal(grid.has(`${x},${y}`), qr.dark(x, y), `${x},${y}`);
  });

  test('the file name is neutral: no address, no date', () => {
    assert.equal(QR_FILE, 'qr-code.png');
  });
});

describe('the read-back: every code made is read back by the vendored decoder to exactly the text it holds', () => {
  const readBack = async (link) => {
    const a = analyse(link);
    if (qrRefusal(a, a.defaultRemoved)) return { refused: true };
    const payload = qrText(a.openUrl(a.defaultRemoved));
    const qr = makeQr(payload.text);
    const { codes } = await decodePicture(qrPng(qr));
    const want = Buffer.from(new TextEncoder().encode(payload.text));
    return { refused: false, text: payload.text, ok: codes.length === 1 && codes[0].format === 'QRCode' && codes[0].text === payload.text && Buffer.from(codes[0].bytes).equals(want), got: codes.map((c) => c.text) };
  };

  test('the provider corpus (214 links): each one that may get a code reads back exactly', async () => {
    const { samples } = JSON.parse(text('rules/provider-test-corpus.json'));
    assert.equal(samples.length, 214);
    let made = 0;
    for (const s of samples) {
      const r = await readBack(s.dirty);
      if (r.refused) continue;
      made += 1;
      assert.ok(r.ok, `${s.id}: ${r.text} read back as ${JSON.stringify(r.got)}`);
    }
    assert.ok(made >= 150, `${made} of 214 made`);
  });

  test('Marcos’s regression links: each one that may get a code reads back exactly', async () => {
    const { cases } = JSON.parse(text('rules/marcos-regression.json'));
    let made = 0;
    for (const c of cases) {
      const r = await readBack(c.dirty);
      if (r.refused) continue;
      made += 1;
      assert.ok(r.ok, `${c.id}: ${r.text}`);
    }
    assert.ok(made >= 10, `${made} of ${cases.length} made`);
  });

  test('links with ø, æ, å and Japanese, in the host and in the path, read back exactly (text and bytes)', async () => {
    const links = [
      'https://www.blåbærturer.no/tur/kløvsteinen?år=2026&utm_source=x',
      'https://www.example.no/sti/blåbær-og-krøkebær?gård=Ås',
      'https://例え.jp/パス?q=値&utm_campaign=x',
      'https://www.example.jp/東京/駅?ref=x',
      'https://tromsø.no/',
    ];
    for (const link of links) {
      const r = await readBack(link);
      assert.equal(r.refused, false, link);
      assert.ok(r.ok, `${link}: ${r.text} read back as ${JSON.stringify(r.got)}`);
    }
  });

  test('the largest code (version 40) reads back too', async () => {
    const t = `https://example.com/?${'a'.repeat(MAX_BYTES - 21)}`;
    const { codes } = await decodePicture(qrPng(makeQr(t)));
    assert.equal(codes.length, 1);
    assert.equal(codes[0].text, t);
  });
});

describe('what the page does with it (app.js, index.html and style.css read as text)', () => {
  const app = text('app.js');
  const html = text('index.html');
  const css = text('style.css');
  const fn = (name) => new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(app)[0];

  test('the code is one SVG path with presentation attributes, built with createElementNS, never markup, a style attribute or a canvas', () => {
    const show = fn('showQr');
    assert.match(show, /svgEl\('path', \{ d: qrPath\(q\.qr\), fill: '#000000' \}\)/);
    assert.match(show, /svgEl\('rect', \{ width: side, height: side, fill: '#ffffff' \}\)/);
    assert.match(app, /document\.createElementNS\(SVG_NS, tag\)/);
    for (const name of ['showQr', 'makeQrCode', 'saveQr', 'shareQr', 'copyQr']) {
      const body = fn(name);
      for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', '.style', 'getContext', 'canvas', 'toDataURL', 'toBlob', 'fetch(']) assert.ok(!body.includes(banned), `${name}: ${banned}`);
    }
  });

  test('nothing is shown before the read-back matches exactly; without the reader, no code and a plain line', () => {
    const make = fn('makeQrCode');
    assert.match(make, /decodeWith\(\{ type: 'decode', mime: 'image\/png' \}, png\.slice\(\)\.buffer, DECODE_TIMEOUT_MS\)/);
    assert.match(make, /read\[0\]\.text === payload\.text/);
    assert.ok(make.indexOf('showQr()', make.indexOf('decodeWith')) > make.indexOf('const same'), 'shown only after the comparison');
    assert.match(make, /\['no-wasm', 'no-reader', 'stopped', 'slow', 'slow-last'\]\.includes\(reply\.code\) \? qrReaderLine\(reply\.code\) : QR\.noMatch/);
    assert.match(app, /noReader: 'CheckLink could not check the QR code in this browser\. Copy or share the link instead\.'/);
  });

  test('Save is a download of qr-code.png from a blob: address let go of straight after; in the app, the app saves', () => {
    const save = fn('saveQr');
    assert.match(save, /const url = URL\.createObjectURL\(qrBlob\(\)\);\n {2}const link = h\('a', \{ href: url, download: QR_FILE, hidden: true \}\);/);
    assert.match(save, /link\.click\(\);\n {2}\} finally \{\n {4}link\.remove\(\);\n {4}URL\.revokeObjectURL\(url\);/);
    assert.match(save, /app\.saveImage\(qrBlob\(\)\)/);
    assert.equal(app.split('URL.createObjectURL(').length - 1, 1, 'the only blob: address the page makes');
  });

  test('Share is the picture alone, only where the browser can share files; Copy picture is the website’s only, started inside the press', () => {
    assert.match(fn('shareQr'), /await navigator\.share\(\{ files: \[qrFile\(\)\] \}\);/);
    assert.match(fn('canShareFile'), /navigator\.canShare\(\{ files: \[qrFile\(\)\] \}\) === true/);
    const copy = fn('copyQr');
    assert.match(copy, /if \(!state\.qr \|\| inApp\(\)\) return;/);
    assert.match(copy, /await navigator\.clipboard\.write\(\[new ClipboardItem\(\{ 'image\/png': qrBlob\(\) \}\)\]\);/);
    assert.ok(!/await/.test(copy.slice(0, copy.indexOf('await navigator.clipboard.write'))), 'nothing awaited before the write');
    assert.match(fn('canCopyPicture'), /ClipboardItem\.supports\('image\/png'\)/);
  });

  test('a WebView too old for the bridge offers only the code on screen', () => {
    const show = fn('showQr');
    assert.match(show, /const web = !inApp\(\);/);
    assert.match(show, /\$\('qr-save'\)\.hidden = !\(web \|\| \(app && typeof app\.saveImage === 'function'\)\);/);
    assert.match(show, /\$\('qr-copy'\)\.hidden = !\(web && canCopyPicture\(\)\);/);
    assert.match(html, /<p class="cl-help" id="qr-screen" hidden>Scan it from this screen, or take a screenshot\.<\/p>/);
  });

  test('the card closes on any change to the box or the ticks', () => {
    assert.match(app, /state\.lastInput = text;\n {2}\/\/ Any change to the box makes a QR code on show out of date\.\n {2}closeQr\(\);/);
    assert.equal((app.match(/say\(''\);\n {4}(?:\/\/ Any change to the ticks makes a QR code on show out of date\.\n {4})?closeQr\(\);\n {4}renderChoice\(\);/g) || []).length, 2, 'both tick lists');
    assert.match(app, /if \(state\.qr && \(refusal \|\| state\.qr\.clean !== clean\)\) closeQr\(\);/);
  });

  test('the card: its words, the screen-reader label naming the host only, black on white whatever the page colours', () => {
    // Not a disclosure button: a second press does not close the card, so no aria-expanded (stage
    // 4b review SC-8); the card closes on any change to the link.
    assert.match(html, /<button type="button" class="btn btn-secondary cl-action-btn" id="qr-btn" aria-controls="qr-card" hidden>Make a QR code<\/button>/);
    assert.doesNotMatch(app, /qr-btn'\)\.setAttribute\('aria-expanded'/);
    assert.match(html, /<h2 class="cl-card-title" id="qr-title" tabindex="-1">QR code of the clean link<\/h2>/);
    assert.match(html, /<p class="cl-help" id="qr-scan">Anyone who scans it can open this link\.<\/p>/);
    assert.match(app, /label: \(host\) => `QR code of the clean link to \$\{host\}`/);
    assert.match(css, /\.cl-qr-frame \{[^}]*background: #ffffff;[^}]*forced-color-adjust: none;/);
    for (const words of [html.slice(html.indexOf('id="qr-card"'), html.indexOf('</section>', html.indexOf('id="qr-card"'))), /const QR = \{[\s\S]*?\n\};/.exec(app)[0]]) {
      assert.ok(!/\bsafe\b|verified|trusted|clean QR code/i.test(words));
    }
  });

  test('the page policy is unchanged: still no image source but the site, no inline style, no request', () => {
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    assert.equal(meta, "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; worker-src 'self'");
  });

  test('PD-1: Share and the sensitive Copy use the Email us line’s test; a held-back link keeps its own line', () => {
    assert.match(app, /const warn = !held && personal \? PERSONAL_NOTE\[personal\] : null;/);
    assert.match(app, /copyText\(a\.clean\(state\.removed\), !!shareHeld\(a\) \|\| !!personalReasons\(a, state\.removed\)\.clean\)/);
    const notes = /const PERSONAL_NOTE = \{[\s\S]*?\n\};/.exec(app)[0];
    for (const why of ['signin', 'signed', 'wrapped', 'recipient', 'email', 'password']) assert.match(notes, new RegExp(`\\n  ${why}: '[^']+'`), why);
    assert.match(html, /<p class="cl-help" id="share-warn" hidden><\/p>\n\s*<div class="cl-actions">/, 'above Copy and Share');
  });

  test('SEC-10: in the app, the same test asks for the screenshot block, best effort, and the link stays on screen', () => {
    const sync = fn('syncLinkSecure');
    assert.match(sync, /if \(!android\(\)\) return;/);
    assert.match(sync, /on = !!\(why\.original \|\| why\.clean\);/);
    assert.match(sync, /secureScreen\('link', on\);/);
    assert.ok(!/await|hidden = true|replaceChildren/.test(sync), 'nothing waits for the answer, and nothing is hidden');
    assert.match(app, /const appSecure = \{ camera: null, secret: null, link: null \};/);
  });

  test('Q4 and N9: the approved wording', () => {
    assert.match(app, /const APP_SECRET_UNPROTECTED = 'The secret is not shown, because CheckLink could not keep it out of screenshots\. Close CheckLink and open it again\. If that does not help, update Android System WebView\.';/);
    assert.match(app, /unprotectedApp: 'The camera did not start, because CheckLink could not keep the camera picture out of screenshots\. Close CheckLink and open it again\. If that does not help, update Android System WebView, or choose a picture of the code instead\.',/);
    assert.match(app, /hiddenApp: 'The camera stopped because you left CheckLink\. Press Scan with camera to start it again\.',/);
    assert.match(app, /hidden: 'The camera stopped because you left this page\. Press Scan with camera to start it again\.',/);
    assert.match(app, /stopCamera\(inApp\(\) \? CAM\.hiddenApp : CAM\.hidden, \{ focus: true \}\)/);
    assert.match(app, /'clandroid:camera-stop', \(\) => \{\n {4}if \(cameraOn\(\)\) stopCamera\(CAM\.hiddenApp, \{ focus: true \}\);/);
    // 0.0.3: the footer sentence credits the projects the function is built on (tests/footer-credits.test.mjs pins it).
    assert.match(html, /<p>Runs entirely on your device: our own code, <a href="https:\/\/github\.com\/zxing-cpp\/zxing-cpp"[\s\S]*? Nothing is sent\.<\/p>/);
    assert.ok(!html.includes('listed in NOTICE'));
    assert.ok(!html.includes('Powered by your own browser'));
  });
});

describe('SC-1: the QR wording Marcos approved on 12 October 2026, word for word', () => {
  // post-stage4b-out/fix/qr-wording-for-approval.txt, sections A to G ("QR coding yes"); the approved
  // copy, with the one SC-9 line added, is qr-wording-approved-2026-10-12.txt of stage 4c. A change
  // to any of these lines, or a new one, needs his approval again.
  const app = text('app.js');
  const html = text('index.html');
  const strings = text('android/app/src/main/res/values/strings.xml');

  test('A. the card and its buttons (index.html)', () => {
    for (const [id, words] of [['qr-btn', 'Make a QR code'], ['qr-title', 'QR code of the clean link'], ['qr-scan', 'Anyone who scans it can open this link.'],
      ['qr-holds', 'It holds exactly this text:'], ['qr-save', 'Save picture'], ['qr-share', 'Share picture'], ['qr-copy', 'Copy picture'],
      ['qr-screen', 'Scan it from this screen, or take a screenshot.']]) {
      assert.match(html, new RegExp(`id="${id}"[^>]*>${words.replace(/[.?]/g, '\\$&')}</`), id);
    }
  });

  test('B. the refusal lines (QR_REFUSED), all fifteen and no others', () => {
    assert.deepEqual(QR_REFUSED, {
      'not-web': 'No QR code for this: CheckLink makes QR codes of web links only.',
      short: 'No QR code for this link: it is a short link, and CheckLink cannot see where it ends up.',
      auth: 'No QR code for this link: whoever opens it may get into the account.',
      'recipient-held': 'No QR code for this link: it keeps a part that identifies you.',
      signin: 'No QR code for this link: it carries a sign-in, key or session value.',
      signed: 'No QR code for this link: it carries a signature that can give access to a file or an account.',
      wrapped: 'No QR code for this link: it is a wrapped link that can identify who it was sent to.',
      recipient: 'No QR code for this link: it holds a part that identifies the person it was sent to.',
      email: 'No QR code for this link: it holds an email address.',
      phone: 'No QR code for this link: it holds a phone number.',
      id: 'No QR code for this link: it holds an identity number or a date of birth.',
      password: 'No QR code for this link: it carries a password before the @.',
      notes: 'No QR code for this link: CheckLink found something to check in it, and people who scan a code would not see that.',
      device: 'No QR code for this link: it points to a device, not to a site on the internet.',
      'too-long': 'No QR code for this link: it is too long to fit in one QR code.',
    });
  });

  test('C. the PD-1 lines above Copy and Share (app.js PERSONAL_NOTE)', () => {
    const notes = /const PERSONAL_NOTE = \{\n([\s\S]*?)\n\};/.exec(app)[1];
    assert.equal(notes, [
      "  signin: 'This link carries a sign-in, key or session value. Anyone you send it to may be able to use it.',",
      "  signed: 'This link carries a signature that can give access to a file or an account. Anyone you send it to can use it.',",
      "  wrapped: 'This link is wrapped in a way that can identify who it was sent to. Anyone you send it to can see that.',",
      "  recipient: 'This link holds a part that identifies the person it was sent to. Anyone you send it to can see it.',",
      "  email: 'This link holds an email address. Anyone you send it to can read it.',",
      "  phone: 'This link holds a phone number. Anyone you send it to can read it.',",
      "  id: 'This link holds an identity number or a date of birth. Anyone you send it to can read it.',",
      "  password: 'This link carries a password before the @. Anyone you send it to can read it.',",
    ].join('\n'));
  });

  test('D. the QR card messages (app.js QR), all fourteen and no others', () => {
    const qr = /const QR = \{[\s\S]*?\n\};/.exec(app)[0];
    assert.deepEqual([...qr.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['making', 'noReader', 'noReaderApp', 'stopped', 'stoppedApp', 'slow',
      'noMatch', 'label', 'ascii', 'scheme', 'saveFailed', 'shareFailed', 'copied', 'copyFailed']);
    for (const line of [
      "  making: 'Making the QR code on this device and reading it back.',",
      "  noReader: 'CheckLink could not check the QR code in this browser. Copy or share the link instead.',",
      "  noReaderApp: 'CheckLink could not start its picture reader, so it cannot check a QR code. Copy or share the link instead.',",
      "  stopped: 'CheckLink stopped its picture reader after a picture took too long, so it cannot check a QR code. To make one, load this page again. Copy or share the link instead.',",
      "  stoppedApp: 'CheckLink stopped its picture reader after a picture took too long, so it cannot check a QR code. To make one, close CheckLink and open it again. Copy or share the link instead.',",
      "  slow: 'Checking the QR code took too long, so CheckLink shows none. Press Make a QR code to try again, or copy or share the link instead.',",
      "  noMatch: 'CheckLink could not read back the QR code it made, so it shows none. Copy or share the link instead.',",
      '  label: (host) => `QR code of the clean link to ${host}`,',
      `  ascii: "The site's name is written in the plain-letter form every scanner reads the same way. It is the same site.",`,
      "  scheme: 'https:// is added at the start, so that scanners read it as a link.',",
      "  saveFailed: 'The picture could not be saved.',",
      "  shareFailed: 'The picture could not be shared. Save it instead.',",
      "  copied: 'Copied the picture of the QR code.',",
      "  copyFailed: 'The picture could not be copied. Save it instead.',",
    ]) assert.ok(qr.includes(`\n${line}\n`), line);
  });

  test('E. why the Email us line leaves a link out (link-core.js LEFT_OUT), and G, the new note reason', () => {
    const core = text('src/link-core.js');
    assert.equal(/const LEFT_OUT = \{\n([\s\S]*?)\n\};/.exec(core)[1], [
      "  signin: 'it carries a sign-in, key or session value',",
      "  signed: 'it carries a signature that can give access to a file or an account',",
      "  wrapped: 'it is a wrapped link that can identify who it was sent to',",
      "  recipient: 'it holds a part that identifies the person it was sent to',",
      "  email: 'it holds an email address',",
      "  phone: 'it holds a phone number',",
      "  id: 'it holds an identity number or a date of birth',",
      "  password: 'it carries a password before the @',",
    ].join('\n'));
    assert.match(core, /reasons\.push\('a sign written as a letter'\)/);
  });

  test('F. the Android toasts and the share sheet heading (strings.xml)', () => {
    for (const [name, words] of [['share_qr_chooser', 'Share QR code'], ['qr_saved', 'Saved the picture of the QR code.'], ['qr_save_failed', 'The picture could not be saved.']]) {
      assert.ok(strings.includes(`<string name="${name}">${words}</string>`), name);
    }
  });

  test('SC-1a and SC-1b, kept: the ECI marker for letters outside English, and https:// added to a link written without it', () => {
    assert.equal(makeQr('https://www.example.no/sti/bl\u00e5b\u00e6r').eci, true);
    assert.equal(makeQr('https://www.example.no/sti/blabaer').eci, false);
    const bare = analyse('www.example.no/side');
    assert.equal(qrText(bare.openUrl(bare.defaultRemoved)).text, 'https://www.example.no/side');
  });
});

describe('SC-9: the short QR line when the line above gives the same reason (Marcos, 2026-10-12)', () => {
  const SHORT_LINE = 'No QR code for this link, for the same reason.';
  const app = text('app.js');
  const html = text('index.html');
  const refusal = (id) => ({ id, text: QR_REFUSED[id] });
  const keys = (block) => [...block.matchAll(/\n {2}(\w+): '/g)].map((m) => m[1]);
  // The reason codes of each line above: why Share is held back (heldReason) and the PD-1 line's
  // (personalReasons, the keys of LEFT_OUT and of PERSONAL_NOTE).
  const HELD = ['auth', 'recipient'];
  const PERSONAL = keys(/const LEFT_OUT = \{[\s\S]*?\n\};/.exec(text('src/link-core.js'))[0]);
  // The pairs that give the same reason, written out by hand: the line above, its reason code and
  // the refusal. Every other pair keeps the full refusal line.
  const SAME = new Set([
    'held auth auth',
    'held recipient recipient-held',
    'personal signin signin',
    'personal signed signed',
    'personal wrapped wrapped',
    'personal recipient recipient',
    'personal email email',
    'personal phone phone',
    'personal id id',
    'personal password password',
  ]);

  test('the new line, word for word, plain, and not one of the refusal lines', () => {
    assert.equal(QR_SAME_REASON, SHORT_LINE);
    assert.ok(!/\bsafe|verified|trusted|clean QR code|\u2014|\u2013|--/i.test(SHORT_LINE));
    assert.ok(!Object.values(QR_REFUSED).includes(SHORT_LINE));
  });

  test('the mapping is written out by reason code, for every reason of both lines above', () => {
    assert.deepEqual(QR_SAME_AS, {
      held: { auth: 'auth', recipient: 'recipient-held' },
      personal: { signin: 'signin', signed: 'signed', wrapped: 'wrapped', recipient: 'recipient', email: 'email', phone: 'phone', id: 'id', password: 'password' },
    });
    assert.ok(Object.isFrozen(QR_SAME_AS) && Object.isFrozen(QR_SAME_AS.held) && Object.isFrozen(QR_SAME_AS.personal));
    assert.deepEqual(PERSONAL, ['signin', 'signed', 'wrapped', 'recipient', 'email', 'phone', 'id', 'password']);
    assert.deepEqual(Object.keys(QR_SAME_AS.personal), PERSONAL, 'every PD-1 reason, and only those');
    assert.deepEqual(keys(/const PERSONAL_NOTE = \{[\s\S]*?\n\};/.exec(app)[0]), PERSONAL, 'PERSONAL_NOTE has the same keys');
    assert.deepEqual(Object.keys(QR_SAME_AS.held), HELD);
    for (const id of [...Object.values(QR_SAME_AS.held), ...Object.values(QR_SAME_AS.personal)]) assert.ok(id in QR_REFUSED, id);
  });

  test('every pair of reason codes: the same reason gives the short line, any other pair the full line', () => {
    const reasons = [...new Set([...HELD, ...PERSONAL, ...Object.keys(QR_REFUSED)])];
    let short = 0;
    for (const line of ['held', 'personal']) {
      for (const reason of reasons) {
        for (const id of Object.keys(QR_REFUSED)) {
          const want = SAME.has(`${line} ${reason} ${id}`) ? SHORT_LINE : QR_REFUSED[id];
          assert.equal(qrNote(refusal(id), { line, reason }), want, `${line} ${reason} ${id}`);
          if (want === SHORT_LINE) short += 1;
        }
      }
    }
    assert.equal(short, SAME.size);
    // The near misses, said plainly: a held recipient part is not the PD-1 recipient part, and a
    // sign-in link Share is held back for is not the PD-1 sign-in value.
    assert.equal(qrNote(refusal('recipient'), { line: 'held', reason: 'recipient' }), QR_REFUSED.recipient);
    assert.equal(qrNote(refusal('recipient-held'), { line: 'personal', reason: 'recipient' }), QR_REFUSED['recipient-held']);
    assert.equal(qrNote(refusal('signin'), { line: 'held', reason: 'auth' }), QR_REFUSED.signin);
    assert.equal(qrNote(refusal('auth'), { line: 'personal', reason: 'signin' }), QR_REFUSED.auth);
  });

  test('no line above, a hidden one, or anything that is not a known line and code: the full line; no refusal, no line', () => {
    for (const id of Object.keys(QR_REFUSED)) {
      for (const above of [null, undefined, {}, { line: 'held' }, { line: 'personal', reason: null }, { line: 'share-note', reason: 'auth' }, { line: 'share-warn', reason: id },
        { line: '__proto__', reason: id }, { line: 'held', reason: 'constructor' }, { line: 'personal', reason: 'toString' }, { line: 'personal', reason: 'hasOwnProperty' },
        { line: 'personal', reason: ['email'] }, { line: ['held'], reason: 'auth' }]) {
        assert.equal(qrNote(refusal(id), above), QR_REFUSED[id], `${id} ${JSON.stringify(above)}`);
      }
    }
    assert.equal(qrNote(null, { line: 'personal', reason: 'email' }), null);
  });

  test('real links, as the page decides: the held-share line only where the browser can share, the PD-1 line only when Share is not held back', () => {
    // What renderChoice puts above the QR line (app.js): #share-note shows only where Share is
    // offered at all; #share-warn only for a link Share is not held back for.
    const note = (link, canShare, removed) => {
      const a = analyse(link);
      const rm = removed ?? a.defaultRemoved;
      const held = heldReason(a, rm);
      const personal = personalReasons(a, rm).clean;
      let above = null;
      if (canShare && held) above = { line: 'held', reason: held };
      else if (!held && personal) above = { line: 'personal', reason: personal };
      return qrNote(qrRefusal(a, rm), above);
    };
    const RESET = 'https://example.com/reset-password?token=abc123def456&utm_source=email';
    const UNSUB = 'https://example.com/unsubscribe?mc_eid=abc123&utm_source=x';
    for (const canShare of [true, false]) {
      // PD-1 shows whether or not the browser can share: the short line.
      for (const link of ['https://shop.example.com/confirm?email=someone%40example.no&utm_source=x', 'https://app.example.com/dash?session_id=abc123',
        'https://shop.example.com/order?phone=%2B4791234567&utm_source=x', 'https://example.com/r?next=https%3A%2F%2Fuser%3Apass%40example.org%2F']) {
        assert.equal(note(link, canShare), SHORT_LINE, `${link} ${canShare}`);
      }
      // Share held back: the short line where its line shows, the full line where the browser
      // cannot share and that line is hidden.
      assert.equal(note(RESET, canShare), canShare ? SHORT_LINE : QR_REFUSED.auth);
      assert.equal(note(UNSUB, canShare), canShare ? SHORT_LINE : QR_REFUSED['recipient-held']);
      // A line above for another reason: a short link refuses first, so the full line.
      assert.equal(note('https://bit.ly/3xYz?email=someone%40example.no&utm_source=x', canShare), QR_REFUSED.short);
      assert.equal(note('https://t.co/abc?token=abcdef123456', canShare), QR_REFUSED.short);
      // No line above: the full line.
      assert.equal(note('http://example.com/a?utm_source=news&id=7', canShare), QR_REFUSED.notes);
      assert.equal(note('https://bit.ly/3abcDEF?utm_source=x', canShare), QR_REFUSED.short);
      assert.equal(note('https://www.example.com/shop/item?utm_source=qr&id=42', canShare), null);
    }
    // The ticks change both lines together: an http:// link with an email address gets the short
    // line; with the email address ticked out, the PD-1 line goes and the full Check line comes.
    const HTTP_EMAIL = 'http://shop.example.com/confirm?email=someone%40example.no&utm_source=x';
    const a = analyse(HTTP_EMAIL);
    const email = a.parts.find((p) => p.name === 'email');
    assert.ok(email && !a.defaultRemoved.includes(email.id));
    assert.equal(note(HTTP_EMAIL, true), SHORT_LINE);
    assert.equal(note(HTTP_EMAIL, true, [...a.defaultRemoved, email.id]), QR_REFUSED.notes);
    // A recipient part kept by hand: the PD-1 recipient line, and the short line.
    const LI = 'https://www.linkedin.com/comm/jobs/view/123?midToken=AQabc&trk=x';
    const li = analyse(LI);
    const mid = li.parts.find((p) => /midtoken/i.test(p.name));
    assert.equal(note(LI, true, li.defaultRemoved.filter((id) => id !== mid.id)), SHORT_LINE);
  });

  test('app.js: the line on show and its reason code decide, after both lines are set, every time the choice is drawn', () => {
    const render = /function renderChoice\(\) \{[\s\S]*?\n\}/.exec(app)[0];
    assert.match(render, /let above = null;\n {2}if \(!\$\('share-note'\)\.hidden\) above = \{ line: 'held', reason: heldReason\(a, removed\) \};\n {2}else if \(!\$\('share-warn'\)\.hidden\) above = \{ line: 'personal', reason: personal \};\n {2}\$\('qr-note'\)\.textContent = refusal \? qrNote\(refusal, above\) : '';/);
    const at = render.indexOf('let above');
    for (const set of ["$('share-note').hidden = ", "$('share-warn').hidden = ", "$('qr-note').hidden = "]) assert.ok(render.indexOf(set) >= 0 && render.indexOf(set) < at, set);
    // The decision never reads the words on screen.
    assert.ok(!/textContent ===|=== [^;]*textContent|innerText/.test(render.slice(at, render.indexOf('qrNote(refusal, above)'))));
    assert.equal((app.match(/\$\('qr-note'\)\.textContent = /g) || []).length, 1, 'qr-note is written in one place (and emptied with the card)');
    assert.match(app, /import \{ [^}]*\bqrNote\b[^}]* \} from '\.\/src\/qr-make\.js\?v=[0-9a-f]{8}';/);
  });

  test('qr-note keeps its markup: a plain help line, no role and no live region (as before SC-9)', () => {
    assert.match(html, /<p class="cl-help" id="share-note" hidden><\/p>\n\s*<!-- [^>]*-->\n\s*<p class="cl-help" id="qr-note" hidden><\/p>/);
    assert.ok(!/id="qr-note"[^>]*(role|aria-)/.test(html));
    assert.ok(!/qr-note'\)\.setAttribute|qr-note'\)\.role/.test(app));
  });
});
