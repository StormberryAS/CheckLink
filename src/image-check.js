// Reads what a picture file says about itself before anything decodes it: the kind of picture
// (from its first bytes, never from its name), its size in pixels and, for a JPEG, which way
// up the camera meant it. Pure ES module, no DOM, no network; used by the decoder worker
// (src/qr-worker.js) to refuse oversized or broken pictures early, and by the page to mark
// where each code sits. Every read is bounds-checked; bad input gives null fields, not errors.
//
//   sniffImage(bytes)   { type, width, height, orientation }
//                       type: 'png' | 'jpeg' | 'gif' | 'bmp' | 'webp' | 'avif' | 'heic' | null
//                       width, height: from the header, or null when it cannot be read
//                       orientation: the EXIF orientation 1 to 8 of a JPEG, otherwise 1
//   orientPoint(p, w, h, orientation)   a point from the stored picture moved to where it
//                       appears once turned the way the camera meant (EXIF orientation)
//   orientedSize(w, h, orientation)     the picture's width and height once turned
//   DECODES_DIRECTLY    the kinds the decoder reads from the file bytes itself

export const DECODES_DIRECTLY = new Set(['png', 'jpeg', 'gif', 'bmp']);

const u16be = (b, i) => (i + 2 <= b.length ? (b[i] << 8) | b[i + 1] : null);
const u16le = (b, i) => (i + 2 <= b.length ? b[i] | (b[i + 1] << 8) : null);
const u32be = (b, i) => (i + 4 <= b.length ? ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3] : null);
const i32le = (b, i) => (i + 4 <= b.length ? b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24) : null);
const ascii = (b, i, n) => (i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '');

function jpeg(b) {
  let width = null;
  let height = null;
  let orientation = 1;
  let i = 2;
  // Every step moves forward by at least two bytes, so the loop ends with the file; there is no
  // cap on the number of segments (a cap let a file with more segments than that skip the size
  // check). Any number of 0xFF fill bytes may come before a marker (JPEG allows it, and the
  // decoder skips them), so they are skipped here too.
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    while (i + 1 < b.length && b[i + 1] === 0xff) i++;
    if (i + 4 > b.length) break;
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = u16be(b, i + 2);
    if (len === null || len < 2) break;
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') orientation = exifOrientation(b, i + 10, i + 2 + len) || orientation;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      // The largest size any frame header declares, so a second header cannot hide a bigger
      // picture behind a small first one.
      const fh = u16be(b, i + 5);
      const fw = u16be(b, i + 7);
      if (fh !== null && fw !== null && (width === null || fw * fh > width * height)) {
        height = fh;
        width = fw;
      }
    }
    i += 2 + len;
  }
  return { type: 'jpeg', width, height, orientation };
}

// The orientation tag (0x0112) of the first image directory of a TIFF block.
function exifOrientation(b, start, end) {
  const order = ascii(b, start, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const r16 = (i) => (i + 2 <= end ? (le ? u16le(b, i) : u16be(b, i)) : null);
  const r32 = (i) => (i + 4 <= end ? (le ? i32le(b, i) >>> 0 : u32be(b, i)) : null);
  const ifd = r32(start + 4);
  if (ifd === null) return null;
  const at = start + ifd;
  const count = r16(at);
  if (count === null || count > 512) return null;
  for (let k = 0; k < count; k++) {
    const e = at + 2 + k * 12;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

function webp(b) {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return { type: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, orientation: 1 };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, orientation: 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { type: 'webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), orientation: 1 };
  }
  return { type: 'webp', width: null, height: null, orientation: 1 };
}

// AVIF and HEIC: the picture's size is in an ispe box (meta > iprp > ipco > ispe), which every
// image item must have. A file can hold several (a thumbnail, the tiles of a grid and the grid
// itself), so the largest is taken: the limit then holds for whatever the browser decodes.
function heifSize(b) {
  let width = null;
  let height = null;
  let boxes = 0;
  const walk = (start, end, depth) => {
    for (let i = start; i + 8 <= end && boxes < 10000;) {
      boxes++;
      let size = u32be(b, i);
      const type = ascii(b, i + 4, 4);
      let head = 8;
      if (size === 1) {
        // A 64-bit size: anything above 2^32 is far beyond the 40 MB limit anyway.
        const hi = u32be(b, i + 8);
        const lo = u32be(b, i + 12);
        if (hi === null || lo === null || hi !== 0) return;
        size = lo;
        head = 16;
      } else if (size === 0) size = end - i;
      if (size < head || i + size > end) return;
      if (type === 'meta' && depth === 0) walk(i + head + 4, i + size, 1);
      else if ((type === 'iprp' && depth === 1) || (type === 'ipco' && depth === 2)) walk(i + head, i + size, depth + 1);
      else if (type === 'ispe' && depth === 3 && size >= head + 12) {
        const w = u32be(b, i + head + 4);
        const h = u32be(b, i + head + 8);
        if (w !== null && h !== null && (width === null || w * h > width * height)) {
          width = w;
          height = h;
        }
      }
      i += size;
    }
  };
  walk(0, b.length, 0);
  return { width, height };
}

export function sniffImage(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  const none = { type: null, width: null, height: null, orientation: 1 };
  if (b.length < 12) return none;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    const ok = ascii(b, 12, 4) === 'IHDR';
    return { type: 'png', width: ok ? u32be(b, 16) : null, height: ok ? u32be(b, 20) : null, orientation: 1 };
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { type: 'gif', width: u16le(b, 6), height: u16le(b, 8), orientation: 1 };
  if (ascii(b, 0, 2) === 'BM' && b.length >= 26) {
    const h = i32le(b, 22);
    return { type: 'bmp', width: i32le(b, 18), height: h === null ? null : Math.abs(h), orientation: 1 };
  }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    const type = /^avi[fs]$/.test(brand) ? 'avif' : /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand) ? 'heic' : null;
    if (type) return { type, ...heifSize(b), orientation: 1 };
  }
  return none;
}

export function orientedSize(w, h, orientation) {
  return orientation >= 5 ? { width: h, height: w } : { width: w, height: h };
}

export function orientPoint(p, w, h, orientation) {
  const { x, y } = p;
  switch (orientation) {
    case 2: return { x: w - x, y };
    case 3: return { x: w - x, y: h - y };
    case 4: return { x, y: h - y };
    case 5: return { x: y, y: x };
    case 6: return { x: h - y, y: x };
    case 7: return { x: h - y, y: w - x };
    case 8: return { x: y, y: w - x };
    default: return { x, y };
  }
}
