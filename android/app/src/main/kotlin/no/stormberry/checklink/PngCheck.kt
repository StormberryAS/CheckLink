package no.stormberry.checklink

import java.util.zip.Adler32
import java.util.zip.CRC32

/**
 * Accepts only the picture CheckLink's own page makes of a QR code (src/qr-make.js, qrPng),
 * before the app saves or shares anything (stage 4b). Pure Kotlin, unit tested.
 *
 * The page is the app's own bundled code, so another picture would mean a fault, not an
 * attack; but what the app writes into a person's files or hands to another app must hold
 * nothing but what the page draws. The check is therefore much stricter than the template
 * app's, which had to take any canvas picture:
 *  - the PNG signature, then exactly three chunks in this order: IHDR (the picture's size),
 *    IDAT (its pixels) and IEND (the end marker), each with a correct checksum, and nothing
 *    after IEND. So no text, dates, EXIF, colour profiles (iCCP, sRGB), gamma, pixel size
 *    (pHYs), palette, transparency, private chunk or any other chunk at all;
 *  - IHDR: square, 1 bit a pixel, greyscale, the standard compression and filter method, not
 *    interlaced, and a side the page can actually make ([SIDES]: 232 to 1,000 pixels);
 *  - IDAT: one zlib stream of stored (uncompressed) deflate blocks only, as the page writes it,
 *    with no preset dictionary, no stray bits in a block header and a correct Adler-32, that
 *    holds exactly one row per pixel line, each starting with filter type 0, and nothing after;
 *  - the pixels (stage 4b review S9): the bits after the last pixel of each row are 1, a white
 *    quiet zone of [QUIET] modules surrounds the rest, and every module is one even square of
 *    black or white, of the size the page draws for that side. So the bytes a person saves or
 *    shares are a picture of a grid of modules and nothing else: no hidden pixels, no bits
 *    outside the picture and no second way to write the same picture.
 * It does not check that the grid is a valid QR code, or which link it holds: the page reads
 * every code back with its own reader before it shows it, and the app has no QR reader of its own.
 */
object PngCheck {
    const val MIME = "image/png"

    private val SIGNATURE = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)
    private val ORDER = listOf("IHDR", "IDAT", "IEND")

    /** QUIET, MODULE_PX and MAX_SIDE in src/qr-make.js. */
    private const val QUIET = 4
    private const val MODULE_PX = 8
    private const val MAX_SIDE = 1000

    /**
     * Pixels a module for every side the page can draw: a version v code has 17 + 4v modules,
     * plus a quiet zone of [QUIET] on each side, at the most pixels a module (up to [MODULE_PX])
     * that keeps the picture within [MAX_SIDE] (pngScale in src/qr-make.js). 232 for version 1,
     * 1,000 for version 25, 925 for version 40. Each side belongs to one version only.
     */
    private val SCALE: Map<Int, Int> = (1..40).associate { version ->
        val modules = 17 + 4 * version + 2 * QUIET
        val scale = maxOf(1, minOf(MODULE_PX, MAX_SIDE / modules))
        modules * scale to scale
    }

    /** Every side the page can draw. */
    val SIDES: Set<Int> = SCALE.keys

    /** True when [png] is one whole picture of the kind described above. */
    fun isQrPicture(png: ByteArray): Boolean =
        try {
            check(png)
            true
        } catch (_: Exception) {
            false
        }

    /** The side in pixels of a picture that passes; throws on any other. */
    fun check(png: ByteArray): Int {
        require(png.size <= OutgoingRequest.MAX_IMAGE_BYTES) { "too large" }
        require(png.size > SIGNATURE.size && png.copyOfRange(0, SIGNATURE.size).contentEquals(SIGNATURE)) { "not a PNG" }
        var at = SIGNATURE.size
        var side = 0
        var pixels: ByteArray? = null
        for (expected in ORDER) {
            require(at + 12 <= png.size) { "the picture ends inside a chunk" }
            val length = int32(png, at)
            require(length in 0..(png.size - at - 12)) { "chunk longer than the picture" }
            val type = String(png, at + 4, 4, Charsets.ISO_8859_1)
            require(type == expected) { "chunk $type where $expected belongs" }
            val crc = CRC32()
            crc.update(png, at + 4, 4 + length)
            require((int32(png, at + 8 + length).toLong() and 0xFFFFFFFFL) == crc.value) { "bad checksum in $type" }
            val data = at + 8
            when (type) {
                "IHDR" -> {
                    require(length == 13) { "bad IHDR" }
                    val width = int32(png, data)
                    val height = int32(png, data + 4)
                    require(width == height) { "not square" }
                    require(width in SIDES) { "a side of $width pixels is not one the page makes" }
                    // Bit depth 1, colour type 0 (greyscale), compression 0, filter 0, no interlace.
                    require(png[data + 8].toInt() == 1 && png[data + 9].toInt() == 0) { "not 1-bit greyscale" }
                    require(png[data + 10].toInt() == 0 && png[data + 11].toInt() == 0 && png[data + 12].toInt() == 0) { "unusual compression, filter or interlace" }
                    side = width
                }
                "IDAT" -> pixels = stored(png, data, length, side * (1 + (side + 7) / 8))
                "IEND" -> require(length == 0) { "bad IEND" }
            }
            at = data + length + 4
        }
        require(at == png.size) { "data after IEND" }
        checkPixels(pixels ?: error("no pixels"), side)
        return side
    }

    /**
     * Reads one zlib stream of stored deflate blocks (RFC 1950 and RFC 1951, block type 0) that
     * must hold exactly [expected] bytes and end where the chunk ends.
     */
    private fun stored(png: ByteArray, offset: Int, length: Int, expected: Int): ByteArray {
        val end = offset + length
        require(length >= 2 + 5 + 4) { "the pixel data is cut short" }
        val cmf = png[offset].toInt() and 0xFF
        val flg = png[offset + 1].toInt() and 0xFF
        // Deflate with a window of at most 32 KB, no preset dictionary, and a header check that holds.
        require(cmf and 0x0F == 8 && cmf shr 4 <= 7 && flg and 0x20 == 0 && (cmf * 256 + flg) % 31 == 0) { "not a plain zlib stream" }
        val out = ByteArray(expected)
        var n = 0
        var at = offset + 2
        while (true) {
            require(at + 5 <= end) { "the pixel data is cut short" }
            // A stored block's header is a whole byte: the final-block bit, block type 0, then
            // zero bits up to the byte's end. Anything else is another way of writing the data.
            val head = png[at].toInt() and 0xFF
            require(head == 0 || head == 1) { "not a stored block" }
            val len = (png[at + 1].toInt() and 0xFF) or ((png[at + 2].toInt() and 0xFF) shl 8)
            val nlen = (png[at + 3].toInt() and 0xFF) or ((png[at + 4].toInt() and 0xFF) shl 8)
            require(len xor 0xFFFF == nlen) { "a stored block's length does not check" }
            at += 5
            require(at + len <= end && n + len <= expected) { "the pixel data is too long" }
            System.arraycopy(png, at, out, n, len)
            n += len
            at += len
            if (head == 1) break
        }
        require(n == expected) { "$n bytes of pixel data, expected $expected" }
        require(at + 4 == end) { "data after the pixel data" }
        val adler = Adler32()
        adler.update(out, 0, n)
        require((int32(png, at).toLong() and 0xFFFFFFFFL) == adler.value) { "bad Adler-32" }
        return out
    }

    /** The rows: filter 0, padding bits 1, a white quiet zone and modules of one colour each. */
    private fun checkPixels(rows: ByteArray, side: Int) {
        val stride = 1 + (side + 7) / 8
        val scale = SCALE.getValue(side)
        val modules = side / scale
        val white = { x: Int, y: Int -> (rows[y * stride + 1 + (x shr 3)].toInt() shr (7 - (x and 7))) and 1 == 1 }
        for (y in 0 until side) {
            require(rows[y * stride].toInt() == 0) { "row $y uses a filter" }
            for (x in side until (stride - 1) * 8) require(white(x, y)) { "row $y has bits after its last pixel" }
        }
        for (my in 0 until modules) {
            for (mx in 0 until modules) {
                val quiet = mx < QUIET || my < QUIET || mx >= modules - QUIET || my >= modules - QUIET
                val colour = white(mx * scale, my * scale)
                require(colour || !quiet) { "the quiet zone is not white" }
                for (y in my * scale until (my + 1) * scale) {
                    for (x in mx * scale until (mx + 1) * scale) require(white(x, y) == colour) { "module $mx,$my is not one colour" }
                }
            }
        }
    }

    private fun int32(b: ByteArray, at: Int): Int =
        ((b[at].toInt() and 0xFF) shl 24) or ((b[at + 1].toInt() and 0xFF) shl 16) or
            ((b[at + 2].toInt() and 0xFF) shl 8) or (b[at + 3].toInt() and 0xFF)
}
