// Test helpers for the stage 3 camera tests: read the pixels of a PNG fixture, put a code into a
// camera-sized frame, and write frames as a Y4M video for Chromium's fake camera
// (--use-file-for-fake-video-capture). Test code only; the app never reads PNG files itself.
//
//   pngPixels(bytes)                 { width, height, data } with data RGBA (Uint8ClampedArray);
//                                    non-interlaced PNGs of colour types 0, 2, 3, 4 and 6
//   frameWith(code, { width, height, size, background, noise, seed })
//                                    an RGBA frame with the code scaled to size pixels in the
//                                    middle of a grey, slightly noisy background (null: no code)
//   y4m(frames, { width, height, fps })  a Y4M video (4:2:0) of RGBA frames, as a Buffer
//
// Node 24 built-ins only.

import { inflateSync } from 'node:zlib';

export function pngPixels(buf) {
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('latin1', off + 4, off + 8);
    const body = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || ihdr.interlace) throw new Error('only non-interlaced PNGs');
  const { width, height, depth, colour } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[x] = v & 255;
    }
    rows.set(cur, y * stride);
    prev = cur;
  }
  const sample = (y, i) => {
    if (depth === 8) return rows[y * stride + i];
    if (depth === 16) return rows[y * stride + i * 2];
    const per = 8 / depth;
    const byte = rows[y * stride + Math.floor(i / per)];
    const shift = 8 - depth * ((i % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colour === 3) {
        const i = sample(y, x);
        data[o] = palette[i * 3];
        data[o + 1] = palette[i * 3 + 1];
        data[o + 2] = palette[i * 3 + 2];
        data[o + 3] = trns && i < trns.length ? trns[i] : 255;
      } else if (colour === 0 || colour === 4) {
        const g = sample(y, x * channels) * scale;
        data[o] = g;
        data[o + 1] = g;
        data[o + 2] = g;
        data[o + 3] = colour === 4 ? sample(y, x * channels + 1) * scale : 255;
      } else {
        data[o] = sample(y, x * channels);
        data[o + 1] = sample(y, x * channels + 1);
        data[o + 2] = sample(y, x * channels + 2);
        data[o + 3] = colour === 6 ? sample(y, x * channels + 3) : 255;
      }
    }
  }
  return { width, height, data };
}

export function frameWith(code, { width = 640, height = 480, size = 300, background = 150, noise = 12, seed = 7 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < width * height; i++) {
    const g = background + (rnd() - 0.5) * 2 * noise;
    data[i * 4] = g;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = g;
    data[i * 4 + 3] = 255;
  }
  if (code) {
    const x0 = Math.round((width - size) / 2);
    const y0 = Math.round((height - size) / 2);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const sx = Math.min(code.width - 1, Math.floor((x * code.width) / size));
        const sy = Math.min(code.height - 1, Math.floor((y * code.height) / size));
        const si = (sy * code.width + sx) * 4;
        const di = ((y0 + y) * width + (x0 + x)) * 4;
        data[di] = code.data[si];
        data[di + 1] = code.data[si + 1];
        data[di + 2] = code.data[si + 2];
      }
    }
  }
  return { width, height, data };
}

export function y4m(frames, { width, height, fps = 10 }) {
  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`, 'latin1')];
  const cw = width >> 1;
  const ch = height >> 1;
  for (const f of frames) {
    const Y = Buffer.alloc(width * height);
    const U = Buffer.alloc(cw * ch);
    const V = Buffer.alloc(cw * ch);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        Y[y * width + x] = Math.max(0, Math.min(255, Math.round(0.299 * f.data[o] + 0.587 * f.data[o + 1] + 0.114 * f.data[o + 2])));
      }
    }
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const o = ((y * 2) * width + x * 2) * 4;
        const r = f.data[o];
        const g = f.data[o + 1];
        const b = f.data[o + 2];
        U[y * cw + x] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
        V[y * cw + x] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
      }
    }
    parts.push(Buffer.from('FRAME\n', 'latin1'), Y, U, V);
  }
  return Buffer.concat(parts);
}
