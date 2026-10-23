// Hand-written declarations for the parts of the vendored zxing-wasm 3.1.6 reader that
// src/qr-decode.js uses. Type checking only: never served, never bundled. The vendored files
// themselves are not type-checked (the configurations use noResolve, so the compiler never reads
// vendor/). Checked against vendor/zxing-wasm-3.1.6/es/reader/index.js and es/share.js.

declare module '*/vendor/zxing-wasm-3.1.6/es/reader/index.js' {
  /** The Emscripten module, as far as qr-decode.js reaches into it to clear freed memory. */
  export interface ZXingModule {
    _malloc(size: number): number;
    _free(ptr: number): void;
    readonly HEAPU8: Uint8Array;
  }

  export interface ZXingModuleOverrides {
    wasmBinary?: ArrayBuffer;
    locateFile?: (path: string, prefix: string) => string;
  }

  export interface PrepareOptions {
    overrides?: ZXingModuleOverrides;
    equalityFn?: (a: object, b: object) => boolean;
    fireImmediately?: boolean;
  }

  /** With fireImmediately the module is instantiated and returned; without it, only configured. */
  export function prepareZXingModule(options: PrepareOptions & { fireImmediately: true }): Promise<ZXingModule>;
  export function prepareZXingModule(options?: PrepareOptions): void | Promise<ZXingModule>;

  export interface ReaderOptions {
    formats?: string[];
    tryHarder?: boolean;
    tryRotate?: boolean;
    tryInvert?: boolean;
    tryDownscale?: boolean;
    maxNumberOfSymbols?: number;
    textMode?: string;
    characterSet?: string;
  }

  export interface ZXingPoint {
    x: number;
    y: number;
  }

  export interface ZXingPosition {
    topLeft: ZXingPoint;
    topRight: ZXingPoint;
    bottomRight: ZXingPoint;
    bottomLeft: ZXingPoint;
  }

  export interface ReadResult {
    isValid: boolean;
    format: string;
    text: string;
    bytes: Uint8Array;
    contentType: string;
    position: ZXingPosition;
    ecLevel: string;
    symbologyIdentifier: string;
  }

  /** Pixels as RGBA: an ImageData, or anything with the same three fields. */
  export interface PixelsInput {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  export function readBarcodes(input: Uint8Array | Blob | PixelsInput, options?: ReaderOptions): Promise<ReadResult[]>;
}

declare module '*/vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js' {
  /** The decoder's WebAssembly, base64 encoded. */
  const WASM_BASE64: string;
  export default WASM_BASE64;
}
