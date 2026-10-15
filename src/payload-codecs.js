// Small decoders the QR inspector (src/qr-inspect.js) needs to read what a code holds: SHA-256,
// Base58Check, Bech32 and Bech32m, IBAN and creditor-reference check digits, CRC-16/CCITT,
// CRC-32, quoted-printable text, a protocol-buffer reader and a small CBOR reader. Pure ES module with no DOM and no network;
// runs in browsers and in Node 24. Written for CheckLink; every function is bounded by the size
// of its input and never throws on bad input (it returns null or false instead).

// == SHA-256 (FIPS 180-4), synchronous ==

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const utf8 = (s) => new TextEncoder().encode(s);

// == Base58Check (Bitcoin addresses, WIF keys, extended keys) ==

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s) {
  if (typeof s !== 'string' || !s || s.length > 200 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return null;
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

// The payload of a Base58Check string (version byte first), or null when the checksum fails.
export function base58Check(s) {
  const b = base58Decode(s);
  if (!b || b.length < 5) return null;
  const body = b.subarray(0, b.length - 4);
  const sum = sha256(sha256(body));
  for (let i = 0; i < 4; i++) if (sum[i] !== b[body.length + i]) return null;
  return body;
}

// == Bech32 and Bech32m (BIP 173, BIP 350) ==

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [...Array.from(hrp, (c) => c.charCodeAt(0) >> 5), 0, ...Array.from(hrp, (c) => c.charCodeAt(0) & 31)];

// { hrp, data (5-bit groups, checksum removed), variant: 'bech32' | 'bech32m' } or null. Long
// strings are allowed (Lightning invoices pass BIP 173's 90 characters); mixed case is refused.
export function bech32Decode(str, maxLength = 7089) {
  if (typeof str !== 'string' || str.length < 8 || str.length > maxLength) return null;
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) return null;
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  if (!/^[\x21-\x7e]+$/.test(hrp)) return null;
  const data = [];
  for (const ch of s.slice(pos + 1)) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const pm = polymod([...hrpExpand(hrp), ...data]);
  const variant = pm === 1 ? 'bech32' : pm === 0x2bc830a3 ? 'bech32m' : null;
  if (!variant) return null;
  return { hrp, data: data.slice(0, -6), variant };
}

// Regroups bits (8 to 5, 5 to 8); null when the padding is not zero.
export function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || ((acc << (to - bits)) & max)) return null;
  return out;
}

// A segwit address (bc1..., tb1...): { hrp, version, program } or null.
export function segwitDecode(addr) {
  const d = bech32Decode(addr, 90);
  if (!d || !['bc', 'tb', 'bcrt'].includes(d.hrp) || !d.data.length) return null;
  const version = d.data[0];
  const program = convertBits(d.data.slice(1), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40 || version > 16) return null;
  if ((version === 0) !== (d.variant === 'bech32')) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  return { hrp: d.hrp, version, program };
}

// == account numbers ==

// ISO 13616 IBAN check digits (mod 97 = 1). Spaces are ignored.
export function ibanValid(iban) {
  const s = String(iban || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  return mod97(s.slice(4) + s.slice(0, 4)) === 1;
}

// ISO 11649 creditor reference (RF + 2 check digits + up to 21 characters).
export function rfValid(ref) {
  const s = String(ref || '').replace(/\s+/g, '').toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(s)) return false;
  return mod97(s.slice(4) + s.slice(0, 4)) === 1;
}

function mod97(s) {
  let r = 0;
  for (const ch of s) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

// GS1 check digit (EAN-8, EAN-13, UPC-A, GTIN-14): true when the last digit is right.
export function gs1Valid(digits) {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

// == CRC-16/CCITT-FALSE (EMV merchant QR codes) ==

export function crc16(text) {
  let crc = 0xffff;
  for (const b of utf8(text)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// == CRC-32 (ISO-HDLC, as zlib and Monero's seed checksum use it) ==

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// == text encodings ==

// Quoted-printable (vCard 2.1): =XX bytes, soft line breaks (= at the end of a line).
export function quotedPrintable(s, charset = 'utf-8') {
  const bytes = [];
  const text = String(s).replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const m = text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3));
    if (m) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else for (const b of utf8(text[i])) bytes.push(b);
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  }
}

// Base64 or base64url to bytes; null when it is not base64.
export function base64Bytes(s) {
  let t = String(s || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  t = t.replace(/=+$/, '');
  if (t.length % 4 === 1) return null;
  while (t.length % 4) t += '=';
  try {
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Base32 (RFC 4648, as 2FA secrets are written): the number of bytes it holds, or null.
export function base32Length(s) {
  const t = String(s || '').replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (!t || !/^[A-Z2-7]+$/.test(t)) return null;
  return Math.floor((t.length * 5) / 8);
}

// == protocol buffers (Google Authenticator's export) ==

// The fields of one message: [{ field, wire, value }] where value is a BigInt (varint) or a
// Uint8Array (length-delimited). Null on anything malformed. At most maxFields fields.
export function protoFields(bytes, maxFields = 2000) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0n;
    let shift = 0n;
    for (let n = 0; n < 10; n++) {
      if (i >= bytes.length) return null;
      const b = bytes[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
    return null;
  };
  while (i < bytes.length) {
    if (out.length >= maxFields) return null;
    const key = varint();
    if (key === null) return null;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const v = varint();
      if (v === null) return null;
      out.push({ field, wire, value: v });
    } else if (wire === 2) {
      const len = varint();
      if (len === null || len > BigInt(bytes.length - i)) return null;
      out.push({ field, wire, value: bytes.subarray(i, i + Number(len)) });
      i += Number(len);
    } else if (wire === 5) {
      if (i + 4 > bytes.length) return null;
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > bytes.length) return null;
      i += 8;
    } else return null;
  }
  return out;
}

// == CBOR (RFC 8949), enough to read a Cashu token (cashuB) ==

// One CBOR item: unsigned and negative integers (as Numbers, or null when too large), byte
// strings (Uint8Array), text, arrays, maps (as a Map), true, false and null. Definite lengths
// only, at most maxItems items and 16 levels deep. Null on anything malformed or larger.
export function cborDecode(bytes, maxItems = 5000) {
  let i = 0;
  let items = 0;
  const fail = Symbol('fail');
  const arg = (info) => {
    if (info < 24) return info;
    const n = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!n || i + n > bytes.length) return fail;
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + bytes[i++];
    return v;
  };
  const item = (depth) => {
    if (depth > 16 || ++items > maxItems || i >= bytes.length) return fail;
    const head = bytes[i++];
    const major = head >> 5;
    const info = head & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      return fail;
    }
    const n = arg(info);
    if (n === fail) return fail;
    if (major === 0) return Number.isSafeInteger(n) ? n : null;
    if (major === 1) return Number.isSafeInteger(n) ? -1 - n : null;
    if (major === 2 || major === 3) {
      if (n > bytes.length - i) return fail;
      const b = bytes.subarray(i, i + n);
      i += n;
      if (major === 2) return b;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(b);
      } catch {
        return fail;
      }
    }
    if (major === 4) {
      if (n > maxItems) return fail;
      const out = [];
      for (let k = 0; k < n; k++) {
        const v = item(depth + 1);
        if (v === fail) return fail;
        out.push(v);
      }
      return out;
    }
    if (major === 5) {
      if (n > maxItems) return fail;
      const out = new Map();
      for (let k = 0; k < n; k++) {
        const key = item(depth + 1);
        if (key === fail) return fail;
        const v = item(depth + 1);
        if (v === fail) return fail;
        out.set(key, v);
      }
      return out;
    }
    return fail;
  };
  const v = item(0);
  return v === fail ? null : v;
}
