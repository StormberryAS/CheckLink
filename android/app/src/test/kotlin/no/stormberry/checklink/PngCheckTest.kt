package no.stormberry.checklink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.Adler32
import java.util.zip.CRC32
import java.util.zip.Deflater

/**
 * Only the picture CheckLink's page makes of a QR code passes. The three fixtures in
 * src/test/resources/qr/ are what src/qr-make.js writes (tests/android-app.test.mjs checks
 * they still are); everything else here is built by hand, the way qrPng does, and then spoilt
 * one way at a time.
 */
class PngCheckTest {
    private fun fixture(name: String): ByteArray =
        requireNotNull(javaClass.getResourceAsStream("/qr/$name")) { "missing fixture $name" }.use { it.readBytes() }

    private fun chunk(type: String, data: ByteArray = ByteArray(0), badCrc: Boolean = false): ByteArray {
        val out = ByteArrayOutputStream()
        val d = DataOutputStream(out)
        d.writeInt(data.size)
        val t = type.toByteArray(Charsets.US_ASCII)
        d.write(t)
        d.write(data)
        val crc = CRC32()
        crc.update(t)
        crc.update(data)
        d.writeInt(crc.value.toInt() xor (if (badCrc) 1 else 0))
        return out.toByteArray()
    }

    private val sig = byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10)

    private fun ihdr(width: Int, height: Int = width, depth: Int = 1, colour: Int = 0, interlace: Int = 0): ByteArray {
        val out = ByteArrayOutputStream()
        val d = DataOutputStream(out)
        d.writeInt(width)
        d.writeInt(height)
        d.write(byteArrayOf(depth.toByte(), colour.toByte(), 0, 0, interlace.toByte()))
        return chunk("IHDR", out.toByteArray())
    }

    /** All-white rows of a [side] by [side] 1-bit picture, each with filter byte [filter]. */
    private fun rows(side: Int, filter: Int = 0, rowsCount: Int = side): ByteArray {
        val stride = 1 + (side + 7) / 8
        val raw = ByteArray(stride * rowsCount) { -1 }
        for (y in 0 until rowsCount) raw[y * stride] = filter.toByte()
        return raw
    }

    /** A zlib stream of stored blocks, written the way qrPng writes it (0x78 0x01, blocks of at most 65,535 bytes). */
    private fun stored(raw: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0x78)
        out.write(0x01)
        val blocks = maxOf(1, (raw.size + 65534) / 65535)
        for (i in 0 until blocks) {
            val from = i * 65535
            val len = minOf(65535, raw.size - from)
            out.write(if (i == blocks - 1) 1 else 0)
            out.write(len and 0xFF)
            out.write(len shr 8)
            out.write(len.inv() and 0xFF)
            out.write((len.inv() shr 8) and 0xFF)
            out.write(raw, from, len)
        }
        val adler = Adler32().apply { update(raw) }.value.toInt()
        DataOutputStream(out).writeInt(adler)
        return out.toByteArray()
    }

    /** Sets pixel [x], [y] of 1-bit rows of a [side] by [side] picture to black. */
    private fun black(raw: ByteArray, side: Int, x: Int, y: Int): ByteArray {
        val stride = 1 + (side + 7) / 8
        val at = y * stride + 1 + (x shr 3)
        raw[at] = (raw[at].toInt() and (0x80 shr (x and 7)).inv()).toByte()
        return raw
    }

    private fun zlib(raw: ByteArray, level: Int = Deflater.NO_COMPRESSION): ByteArray {
        val def = Deflater(level)
        def.setInput(raw)
        def.finish()
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (!def.finished()) out.write(buf, 0, def.deflate(buf))
        def.end()
        return out.toByteArray()
    }

    private fun png(vararg parts: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(sig)
        parts.forEach { out.write(it) }
        return out.toByteArray()
    }

    private val side = 232
    private val good = png(ihdr(side), chunk("IDAT", stored(rows(side))), chunk("IEND"))
    private fun picture(side: Int, raw: ByteArray) = png(ihdr(side), chunk("IDAT", stored(raw)), chunk("IEND"))

    @Test fun thePagesOwnPicturesPass() {
        // Version 2: 25 modules and the quiet zone, 8 pixels a module.
        assertEquals((25 + 8) * 8, PngCheck.check(fixture("qr-short.png")))
        assertEquals(1000, PngCheck.check(fixture("qr-v25.png")))
        assertEquals(925, PngCheck.check(fixture("qr-v40.png")))
        assertTrue(PngCheck.isQrPicture(fixture("qr-v25.png")))
    }

    @Test fun theLargestPictureFitsWellInsideTheCap() {
        assertEquals(126_073, fixture("qr-v25.png").size)
        assertTrue(fixture("qr-v25.png").size <= OutgoingRequest.MAX_IMAGE_BYTES / 2)
    }

    @Test fun aHandBuiltPictureOfTheSameKindPasses() {
        assertEquals(side, PngCheck.check(good))
        // A whole module in black, inside the quiet zone, is a picture the page can make.
        val raw = rows(side)
        for (y in 32 until 40) for (x in 32 until 40) black(raw, side, x, y)
        assertTrue(PngCheck.isQrPicture(picture(side, raw)))
    }

    @Test fun onlyStoredBlocksAsThePageWritesThem() {
        // The same rows compressed are another way of writing the picture: refused (review S9).
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", zlib(rows(side), Deflater.BEST_COMPRESSION)), chunk("IEND"))))
        val z = stored(rows(side))
        // A block header with stray bits, a length that does not check, a preset dictionary.
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", z.copyOf().also { it[2] = 0x09 }), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", z.copyOf().also { it[5] = (it[5] + 1).toByte() }), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", z.copyOf().also { it[1] = 0x3F }), chunk("IEND"))))
        // Split into two stored blocks instead of one is still stored, as the page splits large pictures.
        val raw = rows(side)
        val split = ByteArrayOutputStream().apply {
            write(byteArrayOf(0x78, 0x01))
            for ((i, part) in listOf(raw.copyOfRange(0, 100), raw.copyOfRange(100, raw.size)).withIndex()) {
                write(if (i == 1) 1 else 0); write(part.size and 0xFF); write(part.size shr 8); write(part.size.inv() and 0xFF); write((part.size.inv() shr 8) and 0xFF); write(part)
            }
            DataOutputStream(this).writeInt(Adler32().apply { update(raw) }.value.toInt())
        }.toByteArray()
        assertTrue(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", split), chunk("IEND"))))
    }

    @Test fun thePixelsMustBeAGridOfModulesInAWhiteQuietZone() {
        // A black pixel in the quiet zone.
        assertFalse(PngCheck.isQrPicture(picture(side, black(rows(side), side, 0, 0))))
        assertFalse(PngCheck.isQrPicture(picture(side, black(rows(side), side, side - 1, side / 2))))
        // One pixel of a module that differs from the rest of it.
        assertFalse(PngCheck.isQrPicture(picture(side, black(rows(side), side, 33, 32))))
        // Version 26 at 903 pixels (7 a module) leaves a bit after the last pixel of each row: it must be 1.
        val wide = 903
        assertTrue(903 in PngCheck.SIDES)
        assertTrue(PngCheck.isQrPicture(picture(wide, rows(wide))))
        val padded = rows(wide)
        val stride = 1 + (wide + 7) / 8
        padded[stride - 1] = (padded[stride - 1].toInt() and 0xFE).toByte()
        assertFalse(PngCheck.isQrPicture(picture(wide, padded)))
    }

    @Test fun theSidesAreExactlyTheOnesThePageMakes() {
        assertEquals(40, PngCheck.SIDES.size)
        assertEquals(232, PngCheck.SIDES.min())
        assertEquals(1000, PngCheck.SIDES.max())
        assertTrue(925 in PngCheck.SIDES)
        assertFalse(PngCheck.isQrPicture(png(ihdr(233), chunk("IDAT", stored(rows(233))), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(1001), chunk("IDAT", stored(rows(1001))), chunk("IEND"))))
    }

    @Test fun textDatesExifProfilesAndHintsAreRefused() {
        val idat = chunk("IDAT", stored(rows(side)))
        listOf(
            chunk("tEXt", "Comment\u0000hello".toByteArray()),
            chunk("zTXt", byteArrayOf(65, 0, 0, 120, -100, 3, 0, 0, 0, 0, 1)),
            chunk("iTXt", "XML:com.adobe.xmp\u0000\u0000\u0000\u0000\u0000x".toByteArray()),
            chunk("tIME", byteArrayOf(7, -22, 10, 11, 12, 0, 0)),
            chunk("eXIf", "MM\u0000*".toByteArray()),
            chunk("iCCP", "icc\u0000\u0000x".toByteArray()),
            chunk("sRGB", byteArrayOf(0)),
            chunk("gAMA", byteArrayOf(0, 0, -79, -113)),
            chunk("pHYs", byteArrayOf(0, 0, 11, 19, 0, 0, 11, 19, 1)),
            chunk("PLTE", byteArrayOf(0, 0, 0, -1, -1, -1)),
            chunk("tRNS", byteArrayOf(0, 0)),
            chunk("prVt", byteArrayOf(1, 2, 3)),
        ).forEach { extra ->
            assertFalse("before IDAT", PngCheck.isQrPicture(png(ihdr(side), extra, idat, chunk("IEND"))))
            assertFalse("after IDAT", PngCheck.isQrPicture(png(ihdr(side), idat, extra, chunk("IEND"))))
        }
    }

    @Test fun anythingAfterTheEndIsRefused() {
        assertFalse(PngCheck.isQrPicture(good + byteArrayOf(0)))
        assertFalse(PngCheck.isQrPicture(good + chunk("tEXt", "a\u0000b".toByteArray())))
        assertFalse(PngCheck.isQrPicture(good + good))
    }

    @Test fun theHeaderMustDescribeA1BitGreySquare() {
        val idat = chunk("IDAT", stored(rows(side)))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side, side + 1), idat, chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side, depth = 8), idat, chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side, colour = 2), idat, chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side, colour = 3), idat, chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side, interlace = 1), idat, chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(chunk("IHDR", ByteArray(14)), idat, chunk("IEND"))))
    }

    @Test fun aBadChecksumAnywhereIsRefused() {
        val idat = stored(rows(side))
        assertFalse(PngCheck.isQrPicture(png(chunk("IHDR", ihdr(side).copyOfRange(8, 21), badCrc = true), chunk("IDAT", idat), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", idat, badCrc = true), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", idat), chunk("IEND", badCrc = true))))
        // A broken Adler-32 inside the zlib stream, with the chunk's own CRC right.
        val spoilt = idat.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", spoilt), chunk("IEND"))))
    }

    @Test fun theChunksMustComeOnceEachAndInOrder() {
        val idat = chunk("IDAT", stored(rows(side)))
        assertFalse(PngCheck.isQrPicture(png(idat, ihdr(side), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), idat)))
        // The page writes one IDAT; two halves of the same stream are not its picture.
        val z = stored(rows(side))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", z.copyOfRange(0, 100)), chunk("IDAT", z.copyOfRange(100, z.size)), chunk("IEND"))))
    }

    @Test fun thePixelDataMustBeExactlyTheRowsWithoutFilters() {
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", stored(rows(side, rowsCount = side - 1))), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", stored(rows(side, rowsCount = side + 1))), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", stored(rows(side, filter = 1))), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", stored(rows(side)) + byteArrayOf(0)), chunk("IEND"))))
        assertFalse(PngCheck.isQrPicture(png(ihdr(side), chunk("IDAT", byteArrayOf(1, 2, 3)), chunk("IEND"))))
    }

    @Test fun notAPngOrTooLargeIsRefused() {
        assertFalse(PngCheck.isQrPicture(ByteArray(0)))
        assertFalse(PngCheck.isQrPicture(sig))
        assertFalse(PngCheck.isQrPicture("GIF89a".toByteArray()))
        assertFalse(PngCheck.isQrPicture(byteArrayOf(-1, -40, -1, -32) + good))
        assertFalse(PngCheck.isQrPicture(good.copyOf(good.size - 1)))
        assertFalse(PngCheck.isQrPicture(good + ByteArray(OutgoingRequest.MAX_IMAGE_BYTES)))
    }
}
