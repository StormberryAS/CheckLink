// Reads the QR codes and barcodes in one picture with the vendored zxing-wasm decoder. Used by
// the decoder worker (src/qr-worker.js) in the browser and by the tests in Node. It never makes
// a network request: the decoder's WebAssembly comes from a module on the page's own site
// (vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js) and is handed over as wasmBinary, and
// locateFile is replaced, so the decoder's default address (a CDN) is never used.
//
//   decodePicture(bytes, { mime, createBitmap })  ->  { image, codes }
//       bytes: the picture file as a Uint8Array (never its name or address)
//       createBitmap: optional (blob) => ImageBitmap, for picture kinds the decoder cannot read
//                     from the file itself (WebP, AVIF, HEIC); the worker passes the browser's
//       image: { type, width, height, orientation }   (src/image-check.js)
//       codes: [{ format, text, bytes, contentType, position, ecLevel, symbologyIdentifier }]
//   throws DecodeError with code 'not-image' | 'too-large' | 'too-many-pixels' | 'unsupported' |
//       'no-wasm' | 'failed'
//   decodeFrame({ data, width, height })  ->  { image, codes }   (stage 3, the live camera)
//       one camera frame as RGBA pixels (data: width * height * 4 bytes) that the page drew from
//       the camera on its own canvas; image is { type: 'frame', width, height, orientation: 1 }.
//       The frame is read once and dropped: nothing keeps it, and the copy the decoder makes in
//       its WebAssembly memory is cleared as it is freed (clearingModule). Throws DecodeError 'not-image'
//       for a frame of the wrong size or larger than FRAME_SIDE on either side, 'no-wasm' or
//       'failed', like a picture.
//   wasmAllowed()  whether this context may compile WebAssembly at all (a page policy without
//                  'wasm-unsafe-eval', iOS Lockdown Mode or Tor Browser's Safer level say no)
//   LIMITS

import { prepareZXingModule, readBarcodes } from '../vendor/zxing-wasm-3.1.6/es/reader/index.js';
import WASM_BASE64 from '../vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js';
import { DECODES_DIRECTLY, sniffImage } from './image-check.js?v=8ceb003a';

/** @import { ReadResult, ZXingPosition } from '../vendor/zxing-wasm-3.1.6/es/reader/index.js' */
/** @typedef {import('./image-check.js').ImageInfo} ImageInfo */
/** @typedef {'not-image' | 'too-large' | 'too-many-pixels' | 'unsupported' | 'no-wasm' | 'failed'} DecodeCode */
/**
 * One code found, as the worker sends it to the page.
 * @typedef {{ format: string, text: string, bytes: Uint8Array<ArrayBuffer>, contentType: string, position: ZXingPosition, ecLevel: string | null, symbologyIdentifier: string | null }} DecodedCode
 */
/** @typedef {{ type: 'frame', width: number, height: number, orientation: number }} FrameImage */
/** @typedef {{ image: ImageInfo | FrameImage, codes: DecodedCode[] }} DecodeResult */
/** @typedef {{ data: Uint8ClampedArray, width: number, height: number }} Frame */
// What a catch block holds, as the code reads it: usually an Error. Anything can be thrown,
// null included; `err && err.message` below copes with that, so the type leaves it out.
/** @typedef {{ message?: unknown }} Thrown */

// A picture larger than this is refused before decoding: a phone photo is 2 to 12 MB and 12 to
// 50 megapixels; a decompression bomb declares far more.
export const LIMITS = { bytes: 40 * 1024 * 1024, pixels: 60_000_000, codes: 16 };

// Every 2D code and the common barcodes. Left out: DX film edge marks and Telepen, which carry
// nothing a person would check and add false readings on busy photos.
export const FORMATS = [
  'QRCode', 'MicroQRCode', 'RMQRCode', 'Aztec', 'DataMatrix', 'PDF417', 'MaxiCode',
  'EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF', 'DataBar', 'DataBarExp', 'DataBarLtd',
];

const OPTIONS = { formats: FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: LIMITS.codes, textMode: 'HRI', characterSet: 'Unknown' };
// A live frame is one of many: the person turns the phone, so trying every rotation of every
// frame only costs time (about 55 ms against 15 ms for a 1280 by 720 frame on the Dell).
const FRAME_OPTIONS = { ...OPTIONS, tryRotate: false };
// The largest camera frame read, on either side; the page sends at most 1280 on the longer side.
export const FRAME_SIDE = 4096;

export class DecodeError extends Error {
  /**
   * @param {DecodeCode} code
   * @param {Record<string, unknown> | null} [detail]
   */
  constructor(code, detail = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// The smallest valid WebAssembly module (magic number and version): compiling it shows whether
// WebAssembly is allowed here, without a CSP report for anything bigger.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
export function wasmAllowed() {
  try {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.Module !== 'function') return false;
    return new WebAssembly.Module(EMPTY_WASM) instanceof WebAssembly.Module;
  } catch {
    return false;
  }
}

let prepared = false;
function prepare() {
  if (prepared) return;
  const bin = atob(WASM_BASE64);
  const wasm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) wasm[i] = bin.charCodeAt(i);
  prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer,
      // Never used while wasmBinary is set; replaced so that the decoder's own default, an
      // address on a CDN, cannot be reached even by mistake.
      locateFile: (/** @type {string} */ path) => `./${path}`,
    },
    fireImmediately: true,
  });
  prepared = true;
}

// zxing-wasm copies what it reads into its WebAssembly memory (a camera frame as a greyscale
// picture, a picture file as it is) and frees that block without clearing it, and the decoder
// lives on to read the next picture, so the last frame would stay readable there (camera review
// C2). Its glue code takes and frees that block through the module's own _malloc and _free, so
// those two are wrapped once: every block taken through them is cleared as it is freed. (Taking
// a block of the same size afterwards and clearing it is not enough: the allocator does not
// always hand back the same place.) The decoder's own working copies inside WebAssembly are not
// reached this way.
const guarded = new WeakSet();
async function clearingModule() {
  const mod = await prepareZXingModule({ fireImmediately: true });
  if (guarded.has(mod)) return;
  const malloc = mod._malloc;
  const free = mod._free;
  /** @type {Map<number, number>} */
  const sizes = new Map();
  mod._malloc = (/** @type {number} */ n) => {
    const ptr = malloc(n);
    if (ptr && n > 0) sizes.set(ptr, n);
    return ptr;
  };
  mod._free = (/** @type {number} */ ptr) => {
    const n = sizes.get(ptr);
    if (n) {
      mod.HEAPU8.fill(0, ptr, ptr + n);
      sizes.delete(ptr);
    }
    return free(ptr);
  };
  guarded.add(mod);
}

/**
 * @param {Uint8Array<ArrayBuffer> | ArrayBuffer | ArrayLike<number> | null | undefined} input
 * @param {{ mime?: string, createBitmap?: ((blob: Blob) => Promise<ImageBitmap>) | null }} [options]
 * @returns {Promise<DecodeResult>}
 */
export async function decodePicture(input, { mime = '', createBitmap = null } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  if (bytes.length > LIMITS.bytes) throw new DecodeError('too-large', { bytes: bytes.length });
  const image = sniffImage(bytes);
  if (!image.type) throw new DecodeError('not-image', { mime });
  // Every kind CheckLink reads states its size in its header (an AVIF or HEIC in its ispe box).
  // A picture whose size cannot be read is refused rather than decoded unchecked: a broken or
  // crafted header is how a picture far over the limit would get past it.
  if (image.width === null || image.height === null || !(image.width > 0 && image.height > 0)) throw new DecodeError('not-image', { mime });
  if (image.width * image.height > LIMITS.pixels) throw new DecodeError('too-many-pixels', { width: image.width, height: image.height });
  if (!wasmAllowed()) throw new DecodeError('no-wasm');
  try {
    prepare();
  } catch (err) {
    throw new DecodeError('no-wasm', { message: String(err && /** @type {Thrown} */ (err).message) });
  }
  /** @type {ReadResult[]} */
  let results;
  try {
    await clearingModule();
    if (DECODES_DIRECTLY.has(image.type)) {
      results = await readBarcodes(bytes, OPTIONS);
    } else {
      if (typeof createBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new DecodeError('unsupported', { type: image.type });
      let bitmap;
      try {
        bitmap = await createBitmap(new Blob([bytes], { type: mime || `image/${image.type}` }));
      } catch {
        throw new DecodeError('unsupported', { type: image.type });
      }
      if (bitmap.width * bitmap.height > LIMITS.pixels) throw new DecodeError('too-many-pixels', { width: bitmap.width, height: bitmap.height });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      // A new OffscreenCanvas always has a 2d context to give; if it ever did not, the TypeError
      // below would be caught and reported as 'failed', as before.
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(bitmap, 0, 0);
      image.width = bitmap.width;
      image.height = bitmap.height;
      image.orientation = 1;
      if (typeof bitmap.close === 'function') bitmap.close();
      results = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), OPTIONS);
    }
  } catch (err) {
    if (err instanceof DecodeError) throw err;
    const text = String(err && /** @type {Thrown} */ (err).message);
    if (/CompileError|WebAssembly|Content Security|unsafe-eval/i.test(text)) throw new DecodeError('no-wasm', { message: text });
    throw new DecodeError('failed', { message: text.slice(0, 200) });
  }
  return { image, codes: codesOf(results) };
}

// Stage 3: one frame from the live camera, as RGBA pixels.
// Called with no frame at all, every check below fails and it throws 'not-image'.
/**
 * @param {Frame} [frame]
 * @returns {Promise<DecodeResult>}
 */
export async function decodeFrame({ data, width, height } = /** @type {Frame} */ ({})) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > FRAME_SIDE || height > FRAME_SIDE) throw new DecodeError('not-image', { width, height });
  if (!data || typeof data.length !== 'number' || data.length !== width * height * 4) throw new DecodeError('not-image', { width, height });
  if (!wasmAllowed()) throw new DecodeError('no-wasm');
  try {
    prepare();
  } catch (err) {
    throw new DecodeError('no-wasm', { message: String(err && /** @type {Thrown} */ (err).message) });
  }
  /** @type {ReadResult[]} */
  let results;
  try {
    await clearingModule();
    results = await readBarcodes({ data, width, height }, FRAME_OPTIONS);
  } catch (err) {
    const text = String(err && /** @type {Thrown} */ (err).message);
    if (/CompileError|WebAssembly|Content Security|unsafe-eval/i.test(text)) throw new DecodeError('no-wasm', { message: text });
    throw new DecodeError('failed', { message: text.slice(0, 200) });
  }
  return { image: { type: 'frame', width, height, orientation: 1 }, codes: codesOf(results) };
}

/**
 * @param {ReadResult[]} results
 * @returns {DecodedCode[]}
 */
function codesOf(results) {
  return results.filter((r) => r.isValid !== false && (r.text || (r.bytes && r.bytes.length))).slice(0, LIMITS.codes).map((r) => ({
    format: r.format,
    text: r.text,
    bytes: r.bytes ? new Uint8Array(r.bytes) : new Uint8Array(0),
    contentType: r.contentType,
    position: r.position,
    ecLevel: r.ecLevel || null,
    symbologyIdentifier: r.symbologyIdentifier || null,
  }));
}
