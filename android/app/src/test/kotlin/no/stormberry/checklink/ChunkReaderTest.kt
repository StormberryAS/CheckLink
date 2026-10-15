package no.stormberry.checklink

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.io.encoding.Base64
import kotlin.random.Random

class ChunkReaderTest {
    private val chunk = ChunkReader.CHUNK_BYTES

    /** Reads everything the way the page pulls it, through base64 as the bridge carries it. */
    private fun pullAll(reader: ChunkReader): Pair<ByteArray, Int> {
        val out = ByteArrayOutputStream()
        var i = 0
        while (true) {
            val c = reader.read(i)
            out.write(Base64.decode(Base64.encode(c.bytes)))
            i++
            if (c.last) break
        }
        return out.toByteArray() to i
    }

    @Test fun aThirtyMegabytePictureArrivesWhole() {
        val original = Random(42).nextBytes(30 * 1024 * 1024 + 123)
        val (bytes, chunks) = pullAll(ChunkReader(ByteArrayInputStream(original)))
        assertArrayEquals(original, bytes)
        assertEquals(original.size / chunk + 1, chunks)
    }

    @Test fun anExactMultipleEndsWithAnEmptyLastChunk() {
        val original = Random(7).nextBytes(2 * chunk)
        val reader = ChunkReader(ByteArrayInputStream(original))
        assertFalse(reader.read(0).last)
        assertFalse(reader.read(1).last)
        val end = reader.read(2)
        assertTrue(end.last)
        assertEquals(0, end.bytes.size)
    }

    @Test fun aSmallPictureIsOneChunk() {
        val c = ChunkReader(ByteArrayInputStream(byteArrayOf(1, 2, 3))).read(0)
        assertTrue(c.last)
        assertArrayEquals(byteArrayOf(1, 2, 3), c.bytes)
    }

    @Test fun aStreamThatTricklesIsStillReadInFullChunks() {
        val original = Random(3).nextBytes(chunk + 10)
        val trickle = object : InputStream() {
            private val inner = ByteArrayInputStream(original)
            override fun read(): Int = inner.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, minOf(len, 1000))
        }
        val reader = ChunkReader(trickle)
        assertEquals(chunk, reader.read(0).bytes.size)
        val last = reader.read(1)
        assertTrue(last.last)
        assertEquals(10, last.bytes.size)
    }

    @Test(expected = IllegalStateException::class)
    fun anEmptyFileIsRefused() {
        ChunkReader(ByteArrayInputStream(ByteArray(0))).read(0)
    }

    @Test(expected = IllegalArgumentException::class)
    fun chunksOutOfOrderAreRefused() {
        ChunkReader(ByteArrayInputStream(ByteArray(10))).read(1)
    }

    @Test(expected = IllegalArgumentException::class)
    fun aRepeatedChunkIsRefused() {
        val reader = ChunkReader(ByteArrayInputStream(ByteArray(chunk + 1)))
        reader.read(0)
        reader.read(0)
    }

    @Test(expected = IllegalStateException::class)
    fun readingPastTheEndIsRefused() {
        val reader = ChunkReader(ByteArrayInputStream(ByteArray(5)))
        reader.read(0)
        reader.read(1)
    }

    @Test(expected = IllegalStateException::class)
    fun aFileLargerThanTheCapIsRefusedWhileReading() {
        val reader = ChunkReader(ByteArrayInputStream(ByteArray(3000)), maxBytes = 2500, chunkBytes = 1000)
        reader.read(0)
        reader.read(1)
        reader.read(2)
    }

    @Test fun theDefaultCapIsThePagesOwn() {
        val reader = ChunkReader(ByteArrayInputStream(ByteArray(1)))
        assertTrue(reader.read(0).last)
        assertEquals(40L * 1024 * 1024, IncomingPolicy.MAX_BYTES)
    }
}
