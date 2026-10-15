// CheckLink: a QR code of the clean link (stage 4b, decisions QR-1 to QR-6 of 11 October 2026).
// Pure ES module with no DOM dependencies; it runs in browsers and in Node 24, and it never makes
// a network request. app.js shows what it makes; the page reads every code back with its own
// decoder before showing it (the read-back), and shows none when that reading differs.
//
//   qrRefusal(analysis, removedIds)  { id, text } when no code may be made for that choice, or
//       null. text is the one plain line the page shows instead of the button. A code reaches
//       people who never see CheckLink's notes, so the rule is strict: web links only, never a
//       short link, a link Share is held back for, a link the personal-data test of the Email us
//       line flags (src/link-core.js personalReasons), a link with any Stop or Check note, or a
//       link to a device rather than a site (an IP address of any kind, localhost, or a name
//       kept for local networks such as printer.local). Secrets from a code never get this far:
//       only the clean link of a web address does.
//   qrNote(refusal, above)  the line the page shows for a refusal: QR_SAME_REASON when the line
//       above it gives the same reason (SC-9), else refusal.text. above is the line on show above
//       the QR line, as { line, reason }: line 'held' for the line saying why Share is held back
//       (#share-note, reason from heldReason) or 'personal' for the PD-1 line (#share-warn, reason
//       from personalReasons); null when neither shows. QR_SAME_AS decides, by reason code only.
//   qrText(link)  { text, host, ascii } or null. link is the clean link as Go to opens it
//       (analysis.openUrl: https:// in front of a link written without a scheme, such as
//       www.example.no, so a scanner reads it as a link). text is exactly what the code holds: that
//       link with only its host written in the ASCII form every scanner reads (xn--, decision
//       QR-5); the path and the query stay exactly as written. host is the host as written, for
//       the screen-reader label; ascii says whether it was rewritten. null for anything but an
//       http or https address.
//   makeQr(text)  { size, version, ecc, mask, eci, dark(x, y) } from the vendored encoder
//       (Nayuki, error correction M, raised when that costs no extra size), or null when it does
//       not fit. A text that is plain ASCII is encoded as it is; one with other letters left (in
//       its path or query: the host is ASCII by then) is UTF-8 with the ECI marker that says so
//       (eci: true), because a scanner that has to guess the character set can read UTF-8 as
//       Shift JIS or GBK (ZBar 0.23.93 did, for two of four such links, on 11 October 2026)
//   qrPng(qr)  the code as a PNG file (Uint8Array): 1-bit greyscale, square, with a white quiet
//       zone of four modules, holding only IHDR, IDAT and IEND (no text, date or colour profile).
//       The pixel data is stored, not compressed (deflate blocks of type 0), so the same link
//       gives the same bytes in every browser, with no canvas involved. Eight pixels a module, fewer
//       for the largest codes, so a side is never more than MAX_SIDE pixels.
//   qrPath(qr)  the dark modules as one SVG path, for viewBox 0 0 (size + 8) (size + 8)
//   pngScale(size), crc32(bytes), adler32(bytes), QUIET, MODULE_PX, MAX_SIDE, MAX_BYTES, QR_FILE

import qrcodegen from '../vendor/qrcodegen-8329a71/qrcodegen.js';
import { heldReason, personalReasons, splitLink } from './link-core.js?v=108881e2';

// The picture's file name: neutral, so no address shows up in a gallery, a backup listing or a
// recent-files list (decision QR-6).
export const QR_FILE = 'qr-code.png';
// White modules around the code: ISO/IEC 18004 asks for four.
export const QUIET = 4;
// Pixels a module, and the largest side a picture may have (decision QR-4: about 1,000 pixels,
// so the largest code, version 40, is about 108 KB).
export const MODULE_PX = 8;
export const MAX_SIDE = 1000;
// What one code holds at error correction level M, version 40, in byte mode.
export const MAX_BYTES = 2331;

// The plain line shown instead of Make a QR code, by reason. Never "safe" or "verified": a code
// of the clean link is only that. Approved word for word by Marcos on 12 October 2026 (SC-1).
export const QR_REFUSED = {
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
};

// SC-9 (Marcos, 2026-10-12): when the line above already gives the reason, the QR line says only
// this, so the same reason is not read twice.
export const QR_SAME_REASON = 'No QR code for this link, for the same reason.';

// Which refusal gives the same reason as the line above, by that line and its reason code: the
// held-share line by heldReason ('auth', 'recipient'), the PD-1 line by personalReasons (the keys
// of PERSONAL_NOTE in app.js). Decided from the codes, never from the words. A pair not written
// here is not the same reason, and the full refusal line stays. heldReason's 'recipient' (a part
// that identifies you, kept because the page needs it) and the PD-1 line's 'recipient' (a part
// that identifies the person it was sent to) are different reasons, with different refusals.
export const QR_SAME_AS = Object.freeze({
  held: Object.freeze({ auth: 'auth', recipient: 'recipient-held' }),
  personal: Object.freeze({
    signin: 'signin', signed: 'signed', wrapped: 'wrapped', recipient: 'recipient',
    email: 'email', phone: 'phone', id: 'id', password: 'password',
  }),
});

const own = (o, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(o, key);

export function qrNote(refusal, above) {
  if (!refusal) return null;
  const same = above && own(QR_SAME_AS, above.line) ? QR_SAME_AS[above.line] : null;
  return same && own(same, above.reason) && same[above.reason] === refusal.id ? QR_SAME_REASON : refusal.text;
}

const refused = (id) => ({ id, text: QR_REFUSED[id] });
const utf8 = (s) => new TextEncoder().encode(s);

// Names kept for one device or one local network, which never lead to a site on the internet
// (RFC 6761 localhost, RFC 6762 .local, RFC 8375 .home.arpa, and .internal, reserved by ICANN in
// 2024). Someone who scans a code of one lands on their own device or router (security review S7).
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|home\.arpa|internal)\.?$/i;

export function qrRefusal(a, removedIds) {
  if (!a || !a.found || a.kind !== 'web') return refused('not-web');
  if (a.shortLink) return refused('short');
  const held = heldReason(a, removedIds);
  if (held === 'auth') return refused('auth');
  if (held === 'recipient') return refused('recipient-held');
  const personal = personalReasons(a, removedIds).clean;
  if (personal) return refused(personal);
  if (a.warnings.some((w) => w.tier === 'stop' || w.tier === 'check')) return refused('notes');
  // An IP address of any kind: a public one is a Check note above, a private or loopback one only
  // Good to know, but a code of it still leads whoever scans it to a device.
  if (a.warnings.some((w) => w.id === 'ip-address')) return refused('device');
  const payload = qrText(a.openUrl(removedIds));
  if (!payload) return refused('not-web');
  if (LOCAL_NAME.test(webHost(payload.text) || '')) return refused('device');
  // Near the limit the ECI marker can tip it over, so the encoder decides there.
  const n = utf8(payload.text).length;
  if (n > MAX_BYTES || (n > MAX_BYTES - 8 && !makeQr(payload.text))) return refused('too-long');
  return null;
}

// The host in the ASCII form a browser gives it (xn--), as the address parser computes it.
function asciiHost(host) {
  try {
    const u = new URL(`https://${host}/`);
    return u.hostname && /^[\x21-\x7e]+$/.test(u.hostname) ? u.hostname : null;
  } catch {
    return null;
  }
}

function webHost(link) {
  try {
    const u = new URL(link);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : null;
  } catch {
    return null;
  }
}

export function qrText(link) {
  if (typeof link !== 'string' || !/^https?:\/\//i.test(link)) return null;
  const sp = splitLink(link);
  if (!sp) return null;
  const authority = link.slice(sp.authStart, sp.authEnd);
  const start = sp.authStart + authority.lastIndexOf('@') + 1;
  let end = sp.authEnd;
  const hostPort = link.slice(start, end);
  if (!hostPort.startsWith('[')) {
    const colon = hostPort.lastIndexOf(':');
    if (colon >= 0 && /^\d*$/.test(hostPort.slice(colon + 1))) end = start + colon;
  }
  const host = link.slice(start, end);
  if (!host) return null;
  // Only a host with letters outside ASCII is rewritten: one written in ASCII stays as written.
  // eslint-disable-next-line no-control-regex
  const ascii = /[^\x00-\x7f]/.test(host) ? asciiHost(host) : host;
  if (!ascii) return null;
  const text = `${link.slice(0, start)}${ascii}${link.slice(end)}`;
  // The rewrite never changes where the link goes: the address parser must read the same host.
  const before = webHost(link);
  if (!before || webHost(text) !== before) return null;
  return { text, host, ascii: ascii !== host };
}

// ECI assignment number 26: UTF-8 (ISO/IEC 18004, AIM ECI).
const ECI_UTF8 = 26;

export function makeQr(text) {
  const { QrCode, QrSegment } = qrcodegen;
  const bytes = utf8(String(text));
  const eci = bytes.some((b) => b > 0x7f);
  let qr;
  try {
    qr = eci
      ? QrCode.encodeSegments([QrSegment.makeEci(ECI_UTF8), QrSegment.makeBytes(Array.from(bytes))], QrCode.Ecc.MEDIUM)
      : QrCode.encodeText(String(text), QrCode.Ecc.MEDIUM);
  } catch {
    return null;
  }
  return {
    size: qr.size,
    version: qr.version,
    ecc: ['L', 'M', 'Q', 'H'][qr.errorCorrectionLevel.ordinal],
    mask: qr.mask,
    eci,
    dark: (x, y) => qr.getModule(x, y),
  };
}

export const pngScale = (size) => Math.max(1, Math.min(MODULE_PX, Math.floor(MAX_SIDE / (size + 2 * QUIET))));

// == PNG ==

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  // Sums are reduced every 3,800 bytes, well before b could pass 2^32.
  for (let i = 0; i < bytes.length;) {
    const stop = Math.min(bytes.length, i + 3800);
    for (; i < stop; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const put32 = (out, at, v) => {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
};

// One chunk: length, type, data and the CRC of type and data.
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  put32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  put32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

// A zlib stream (RFC 1950) of stored deflate blocks (RFC 1951, block type 0): the bytes as they
// are, at most 65,535 to a block, then the Adler-32 of the whole.
function zlibStored(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  // CMF 0x78 (deflate, 32 KB window), FLG 0x01: no dictionary, and 0x7801 is a multiple of 31.
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const from = i * 65535;
    const len = Math.min(65535, raw.length - from);
    out[o] = i === blocks - 1 ? 1 : 0;
    out[o + 1] = len & 0xff;
    out[o + 2] = len >>> 8;
    out[o + 3] = ~len & 0xff;
    out[o + 4] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(from, from + len), o + 5);
    o += 5 + len;
  }
  put32(out, o, adler32(raw));
  return out;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function qrPng(qr) {
  const scale = pngScale(qr.size);
  const side = (qr.size + 2 * QUIET) * scale;
  const stride = 1 + Math.ceil(side / 8);
  // Each row: filter byte 0, then one bit a pixel, 1 white and 0 black; the bits after the last
  // pixel of a row stay 1.
  const raw = new Uint8Array(stride * side).fill(0xff);
  for (let y = 0; y < side; y += 1) raw[y * stride] = 0;
  for (let my = 0; my < qr.size; my += 1) {
    const row = new Uint8Array(stride).fill(0xff);
    row[0] = 0;
    for (let mx = 0; mx < qr.size; mx += 1) {
      if (!qr.dark(mx, my)) continue;
      const x0 = (mx + QUIET) * scale;
      for (let x = x0; x < x0 + scale; x += 1) row[1 + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
    const y0 = (my + QUIET) * scale;
    for (let y = y0; y < y0 + scale; y += 1) raw.set(row, y * stride);
  }
  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, side);
  put32(ihdr, 4, side);
  // Bit depth 1, colour type 0 (greyscale), deflate, filter method 0, not interlaced.
  ihdr.set([1, 0, 0, 0, 0], 8);
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// == SVG ==

// Each run of dark modules in a row as one rectangle, all in one path: a version 40 code has
// 31,329 modules, too many for one element each on an old phone.
export function qrPath(qr) {
  const out = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size;) {
      if (!qr.dark(x, y)) {
        x += 1;
        continue;
      }
      let n = 1;
      while (x + n < qr.size && qr.dark(x + n, y)) n += 1;
      out.push(`M${x + QUIET},${y + QUIET}h${n}v1h-${n}z`);
      x += n;
    }
  }
  return out.join('');
}
