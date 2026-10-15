// CheckLink's decoder worker. The page starts it while the page itself loads, so every file it
// needs (this module, the decoder and its WebAssembly) arrives with the page and nothing is
// fetched later: reading a picture, even offline, never makes a request. The page sends the
// picture's bytes; the worker answers with the codes it finds. A picture that takes too long is
// stopped by the page, which ends this worker.
//
// Messages
//   worker -> page  { type: 'ready', wasm }                 once, when it has started
//   page -> worker  { type: 'decode', id, buffer, mime }    buffer is transferred, not copied
//   worker -> page  { type: 'result', id, image, codes }
//   page -> worker  { type: 'frame', id, width, height, buffer }   stage 3: one live camera frame
//                   as RGBA pixels, transferred; read once, then cleared and dropped, never kept
//   worker -> page  { type: 'error', id, code, detail }     code as in src/qr-decode.js

import './worker-lockdown.js?v=dd7a164b';
import { DecodeError, decodeFrame, decodePicture, wasmAllowed } from './qr-decode.js?v=88ce72fb';

postMessage({ type: 'ready', wasm: wasmAllowed() });

const bitmap = typeof createImageBitmap === 'function' ? (blob) => createImageBitmap(blob) : null;

let queue = Promise.resolve();
onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'decode' && msg.type !== 'frame') return;
  queue = queue.then(async () => {
    try {
      const { image, codes } = msg.type === 'frame'
        ? await decodeFrame({ data: new Uint8ClampedArray(msg.buffer), width: msg.width, height: msg.height })
        : await decodePicture(new Uint8Array(msg.buffer), { mime: String(msg.mime || ''), createBitmap: bitmap });
      postMessage({ type: 'result', id: msg.id, image, codes }, codes.map((c) => c.bytes.buffer));
    } catch (err) {
      const code = err instanceof DecodeError ? err.code : 'failed';
      postMessage({ type: 'error', id: msg.id, code, detail: err instanceof DecodeError ? err.detail : null });
    } finally {
      // The frame or picture handed over is cleared before it is let go (camera review C2).
      try {
        if (msg.buffer && msg.buffer.byteLength) new Uint8Array(msg.buffer).fill(0);
      } catch { /* already gone */ }
    }
  });
};
