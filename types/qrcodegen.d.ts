// Type declarations for the vendored QR code generator (vendor/qrcodegen-8329a71/qrcodegen.js, Nayuki's
// QR Code generator library, MIT), as src/qr-make.js uses it. Type checking only: never served.
// Written by hand from upstream's TypeScript source (third_party/qrcodegen/qrcodegen.ts); only what
// CheckLink calls is declared. The configurations use noResolve, so the vendored file itself is never
// read by the checker and this pattern stands for it.

declare module '*/vendor/qrcodegen-8329a71/qrcodegen.js' {
  namespace qrcodegen {
    /** A QR code symbol: a square grid of dark and light modules. */
    class QrCode {
      /** Encodes text at the given error correction level or higher, in the smallest version that fits. */
      static encodeText(text: string, ecl: QrCode.Ecc): QrCode;
      /** Encodes the segments, in the smallest version from minVersion to maxVersion that fits. */
      static encodeSegments(segs: readonly QrSegment[], ecl: QrCode.Ecc, minVersion?: number, maxVersion?: number,
        mask?: number, boostEcl?: boolean): QrCode;
      /** The version, 1 to 40. */
      readonly version: number;
      /** The width and height in modules: version * 4 + 17. */
      readonly size: number;
      /** The error correction level actually used. */
      readonly errorCorrectionLevel: QrCode.Ecc;
      /** The mask pattern, 0 to 7. */
      readonly mask: number;
      /** Whether the module at (x, y) is dark; false outside the grid. */
      getModule(x: number, y: number): boolean;
    }
    namespace QrCode {
      /** An error correction level. */
      class Ecc {
        static readonly LOW: Ecc;
        static readonly MEDIUM: Ecc;
        static readonly QUARTILE: Ecc;
        static readonly HIGH: Ecc;
        /** 0 for LOW to 3 for HIGH. */
        readonly ordinal: number;
        /** The two-bit value in the format information. */
        readonly formatBits: number;
      }
    }
    /** A segment of data in one encoding mode. */
    class QrSegment {
      /** A segment of bytes, each 0 to 255. */
      static makeBytes(data: readonly number[]): QrSegment;
      /** An Extended Channel Interpretation designator with the given assignment number. */
      static makeEci(assignVal: number): QrSegment;
    }
  }
  export default qrcodegen;
}
