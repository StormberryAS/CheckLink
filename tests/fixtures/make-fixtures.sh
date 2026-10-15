#!/bin/sh
# Makes the picture fixtures in tests/fixtures/qr/ that the tests read. Run by a person, once;
# the pictures are kept in the repository, so the tests never need these tools.
#
#   sh tests/fixtures/make-fixtures.sh [ZXING_PACKAGE_DIR]
#
# Needs qrencode (QR codes), ImageMagick 7 (JPEG, GIF, BMP, AVIF, HEIC, rotation, photo-like
# blur and noise) and exiftool (an EXIF orientation). ZXING_PACKAGE_DIR, optional, is an unpacked
# zxing-wasm npm package (the same version the app vendors); its writer makes the Aztec, Data
# Matrix, PDF417 and EAN-13 pictures.
# Every payload is made up for testing: no real account, card, key or person.
set -eu
cd "$(dirname "$0")/qr"
Q() { qrencode -l M -s 8 -m 4 -o "$1" "$2"; }

Q link.png 'https://www.example.com/shop/item?utm_source=qr&utm_medium=poster&utm_campaign=autumn&id=42'
magick link.png -quality 85 link.jpg
magick link.png link.gif
magick link.png -type Palette BMP3:link.bmp
magick link.png -quality 60 link.avif
magick link.png link.heic
# A photo-like JPEG: the code tilted, blurred and noisy on a grey background, as a phone takes it.
magick -size 1200x900 plasma:grey50-grey70 -blur 0x3 \( link.png -rotate 9 -background none \) -gravity center -geometry +40+20 -composite -attenuate 0.4 +noise Gaussian -blur 0x1.2 -quality 80 link-photo.jpg
# The same code stored sideways, with EXIF orientation 6 (turn 90 degrees clockwise to view).
magick link.png -rotate -90 -quality 90 link-exif6.jpg
exiftool -q -overwrite_original -n -Orientation=6 link-exif6.jpg
Q upper.png 'HTTPS://EXAMPLE.COM/A?UTM_SOURCE=QR&ID=7'
Q wifi.png 'WIFI:T:WPA;S:Kleppesto Guest;P:correct horse battery;H:false;;'
Q otp.png 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example'
Q seed.png 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
Q epc.png "$(printf 'BCD\n002\n1\nSCT\nBPOTBEB1\nRed Cross Belgium\nBE72000000001616\nEUR12.50\nCHAR\n\nTest payment\n')"
Q bitcoin.png 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4?amount=0.001&label=Test'
Q vcard.png "$(printf 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Nordmann;Ola;;;\r\nFN:Ola Nordmann\r\nTEL;TYPE=cell:+47 123 45 678\r\nEMAIL:ola@example.no\r\nURL:https://example.no/ola?utm_source=card\r\nEND:VCARD\r\n')"
Q intent.png 'intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;S.browser_fallback_url=https%3A%2F%2Fexample.org%2Fapp%3Futm_source%3Dqr;end'
Q script.png 'javascript:alert(document.domain)'
Q rlo.png "$(printf 'Pay here: https://example.com/\342\200\256gpj.exe')"
Q second.png 'https://evil.example/login?utm_source=sticker'
# A look-alike address: p, then the Cyrillic small a (U+0430), then ypal.com (stage 3 fixes,
# interface review H2). Never opened by any test.
Q lookalike.png "$(printf 'https://p\320\260ypal.com/signin?utm_source=qr')"
# Two codes in one picture, as with a sticker put next to (or over) a real code.
magick link.png second.png +append -bordercolor white -border 20 two-codes.png
# A link next to a Wi-Fi code: the Wi-Fi code is painted over when the picture is drawn.
magick link.png wifi.png +append -bordercolor white -border 20 link-wifi.png
# No code at all.
magick -size 400x300 gradient:white-grey60 nocode.png
# Broken and hostile files.
head -c 300 link.png > truncated.png
printf 'This is not a picture, only text with a .png name.\n' > not-image.png
: > empty.png
# A PNG whose header claims 30000 by 30000 pixels (900 megapixels) but holds almost nothing.
python3 - <<'PY'
import struct, zlib
def chunk(t, d):
    return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
ihdr = struct.pack('>IIBBBBB', 30000, 30000, 8, 0, 0, 0, 0)
open('huge-header.png', 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b'\x00' * 64)) + chunk(b'IEND', b''))
PY
if [ "${1:-}" ]; then
  node - "$1" <<'JS'
const dir = process.argv[2];
const { readFileSync, writeFileSync } = await import('node:fs');
const z = await import(`${dir}/dist/es/writer/index.js`);
const wasm = readFileSync(`${dir}/dist/writer/zxing_writer.wasm`);
z.prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }, fireImmediately: true });
const make = async (file, text, format, extra = {}) => {
  const r = await z.writeBarcode(text, { format, scale: 6, ...extra });
  if (r.error) throw new Error(`${file}: ${r.error}`);
  writeFileSync(file, Buffer.from(await r.image.arrayBuffer()));
};
await make('aztec.png', 'M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100', 'Aztec');
await make('datamatrix.png', 'mailto:info@example.com?subject=Hello&bcc=hidden@example.org', 'DataMatrix');
await make('pdf417.png', 'tel:*21*12345678#', 'PDF417');
await make('ean13.png', '7038010001895', 'EAN13');
JS
fi
ls -la
