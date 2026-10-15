package no.stormberry.checklink

import java.io.InputStream

/**
 * Reads a shared picture in numbered chunks, for the page to pull one at a time. Pure
 * Kotlin, unit tested.
 *
 * The page asks for chunk 0, then 1, and so on (android-bridge.js, in-pull); each answer
 * says whether it was the last. Anything out of order, an empty file, or a file that grows
 * past [maxBytes] while it is read is an error rather than a silently wrong picture. The
 * bytes cross the WebView boundary as base64 text inside a JSON message.
 *
 * The other direction, the picture of a QR code the page hands over for Save or Share
 * (stage 4b), is ChunkAssembler's.
 */
class ChunkReader(
    private val input: InputStream,
    private val maxBytes: Long = IncomingPolicy.MAX_BYTES,
    private val chunkBytes: Int = CHUNK_BYTES,
) {
    private var nextIndex = 0
    private var total = 0L
    private var done = false

    class Chunk(val bytes: ByteArray, val last: Boolean)

    init {
        require(chunkBytes > 0) { "chunk size must be positive" }
        require(maxBytes > 0) { "the cap must be positive" }
    }

    /** Reads chunk [index], which must be the next one. Throws on anything unexpected. */
    fun read(index: Int): Chunk {
        check(!done) { "the file has already been read to its end" }
        require(index == nextIndex) { "chunk $index requested, expected $nextIndex" }
        val buf = ByteArray(chunkBytes)
        var n = 0
        while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
        }
        if (index == 0 && n == 0) throw IllegalStateException("empty file")
        total += n
        if (total > maxBytes) throw IllegalStateException("larger than $maxBytes bytes")
        nextIndex += 1
        // A file whose size is an exact multiple of the chunk size ends with one empty chunk
        // marked last, which the page simply adds nothing from.
        val last = n < buf.size
        if (last) done = true
        return Chunk(if (n == buf.size) buf else buf.copyOf(n), last)
    }

    companion object {
        /** Raw bytes per chunk. android-bridge.js does not need to know it. */
        const val CHUNK_BYTES = 256 * 1024
    }
}
