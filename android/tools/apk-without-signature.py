#!/usr/bin/env python3
"""Print the SHA-256 of an APK with its signature taken out, so two builds can be compared.

A signed APK is a zip file plus one APK Signing Block, which apksigner puts between the last
file and the zip's central directory. The signature differs with the key (and a release signed by
CheckLink's key cannot be made by anyone else), but everything around it is the same for any key.
This script removes that block, moves the central directory's offset back by the block's size
(the only number in the zip that the block changes) and prints the SHA-256 of what is left.

So, to check that a release is built from the source it claims, build the tag yourself, align and
sign your build exactly as the release workflow does but with a key of your own, and compare:

    python3 android/tools/apk-without-signature.py checklink-v0.0.1.apk
    python3 android/tools/apk-without-signature.py my-build-signed-with-my-key.apk

The two lines must show the same SHA-256. Sign with apksigner, as the workflow does, and not
only align: apksigner places some files a few bytes differently from zipalign, so an aligned
but unsigned build does not compare. README.md, "Reproducible build", has the steps. An APK with
no signing block is hashed as it is.

    python3 android/tools/apk-without-signature.py APK [--out FILE]

--out also writes the stripped zip. Python 3 standard library only.
"""
import hashlib
import struct
import sys

EOCD_SIG = b"PK\x05\x06"
BLOCK_MAGIC = b"APK Sig Block 42"


def strip(data: bytes) -> bytes:
    # The end of central directory record: 22 bytes plus a comment of up to 65,535 bytes.
    at = data.rfind(EOCD_SIG, max(0, len(data) - 22 - 65535))
    if at < 0 or at + 22 > len(data):
        raise SystemExit("not a zip file: no end of central directory record")
    cd_size, cd_offset = struct.unpack_from("<II", data, at + 12)
    if cd_offset + cd_size != at:
        raise SystemExit("unexpected zip layout: the central directory does not end where its record begins")
    # The block ends with its size (8 bytes) and the magic (16 bytes), right before the directory.
    if cd_offset < 32 or data[cd_offset - 16:cd_offset] != BLOCK_MAGIC:
        return data  # unsigned (or signed with v1 only): nothing to take out
    size = struct.unpack_from("<Q", data, cd_offset - 24)[0]
    start = cd_offset - (size + 8)
    if start < 0 or struct.unpack_from("<Q", data, start)[0] != size:
        raise SystemExit("the APK Signing Block's two size fields do not agree")
    eocd = bytearray(data[at:])
    struct.pack_into("<I", eocd, 16, start)
    return data[:start] + data[cd_offset:at] + bytes(eocd)


def main(argv):
    if len(argv) not in (2, 4) or (len(argv) == 4 and argv[2] != "--out"):
        raise SystemExit(__doc__)
    with open(argv[1], "rb") as handle:
        data = handle.read()
    out = strip(data)
    if len(argv) == 4:
        with open(argv[3], "wb") as handle:
            handle.write(out)
    removed = len(data) - len(out)
    print("%s  %s (%s)" % (hashlib.sha256(out).hexdigest(), argv[1],
                           "signing block of %d bytes taken out" % removed if removed else "no signing block"))


if __name__ == "__main__":
    main(sys.argv)
