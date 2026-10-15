package no.stormberry.checklink

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ChunkAssemblerTest {
    private val chunk = OutgoingRequest.IMAGE_CHUNK_BYTES

    private fun bytes(n: Int, from: Int = 0) = ByteArray(n) { ((it + from) % 251).toByte() }

    @Test fun putsTheChunksBackTogetherInOrder() {
        val whole = bytes(chunk * 2 + 1000)
        val a = ChunkAssembler(whole.size, 3)
        assertEquals(0, a.next)
        assertEquals(chunk, a.expectedLength(0))
        assertEquals(1000, a.expectedLength(2))
        a.append(0, whole.copyOfRange(0, chunk))
        assertEquals(1, a.next)
        a.append(1, whole.copyOfRange(chunk, 2 * chunk))
        a.append(2, whole.copyOfRange(2 * chunk, whole.size))
        assertNull(a.next)
        assertArrayEquals(whole, a.finish())
    }

    @Test fun aSmallPictureIsOneChunk() {
        val whole = bytes(9044)
        val a = ChunkAssembler(whole.size, 1)
        a.append(0, whole)
        assertArrayEquals(whole, a.finish())
    }

    @Test fun anExactMultipleHasNoEmptyLastChunk() {
        val a = ChunkAssembler(chunk * 2, 2)
        assertEquals(chunk, a.expectedLength(1))
        assertThrows(IllegalArgumentException::class.java) { ChunkAssembler(chunk * 2, 3) }
    }

    @Test fun outOfOrderShortOrLongChunksAreRefused() {
        val a = ChunkAssembler(chunk + 10, 2)
        assertThrows(IllegalArgumentException::class.java) { a.append(1, bytes(10)) }
        assertThrows(IllegalArgumentException::class.java) { a.append(0, bytes(chunk - 1)) }
        assertThrows(IllegalArgumentException::class.java) { a.append(0, bytes(chunk + 1)) }
        a.append(0, bytes(chunk))
        assertThrows(IllegalArgumentException::class.java) { a.append(0, bytes(chunk)) }
        assertThrows(IllegalArgumentException::class.java) { a.append(1, bytes(11)) }
        assertThrows(IllegalArgumentException::class.java) { a.append(2, bytes(10)) }
    }

    @Test fun finishingEarlyOrTwiceFails() {
        val a = ChunkAssembler(20, 1)
        assertThrows(IllegalStateException::class.java) { a.finish() }
        a.append(0, bytes(20))
        a.finish()
        assertThrows(IllegalStateException::class.java) { a.finish() }
        assertThrows(IllegalStateException::class.java) { a.append(0, bytes(20)) }
    }

    @Test fun cappedAt256KiBAndAtLeastOneByte() {
        assertEquals(262_144, OutgoingRequest.MAX_IMAGE_BYTES)
        ChunkAssembler(OutgoingRequest.MAX_IMAGE_BYTES, 4)
        assertThrows(IllegalArgumentException::class.java) { ChunkAssembler(OutgoingRequest.MAX_IMAGE_BYTES + 1, 5) }
        assertThrows(IllegalArgumentException::class.java) { ChunkAssembler(0, 0) }
        assertThrows(IllegalArgumentException::class.java) { ChunkAssembler(-1, 0) }
    }
}
