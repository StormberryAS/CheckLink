package no.stormberry.checklink

/**
 * Puts the picture of a QR code back together from the chunks the page sends for Save or
 * Share (stage 4b). Pure Kotlin, unit tested.
 *
 * The page announces the size and the number of chunks first (out-begin, checked by
 * OutgoingRequest.parseImageBegin), then the app pulls the chunks one at a time, in order
 * (out-pull, out-chunk). Each chunk must be the one asked for and exactly as long as its place
 * in the picture says: a whole chunk, or what is left for the last one. Anything out of order,
 * short, long or past the announced size is an error rather than a silently wrong picture.
 *
 * The picture is at most OutgoingRequest.MAX_IMAGE_BYTES (256 KiB), so it is kept in memory and
 * nothing reaches the device's storage until the whole picture has passed PngCheck. A transfer
 * that stops half way therefore leaves nothing behind.
 *
 * The template app's assembler wrote straight to a file and allowed 512 MB; CheckLink only ever
 * receives its own small PNG, so this one is capped far lower.
 */
class ChunkAssembler(
    val size: Int,
    val chunks: Int,
    private val chunkBytes: Int = OutgoingRequest.IMAGE_CHUNK_BYTES,
    maxBytes: Int = OutgoingRequest.MAX_IMAGE_BYTES,
) {
    private val buffer: ByteArray
    private var nextIndex = 0
    private var written = 0
    private var finished = false

    init {
        require(chunkBytes > 0) { "chunk size must be positive" }
        require(size in 1..maxBytes) { "size $size is outside 1..$maxBytes" }
        require(chunks == (size + chunkBytes - 1) / chunkBytes) { "$chunks chunks do not fit $size bytes" }
        buffer = ByteArray(size)
    }

    /** The index of the chunk to ask for next, or null once all have arrived. */
    val next: Int? get() = if (nextIndex < chunks) nextIndex else null

    /** How many bytes chunk [index] must hold. */
    fun expectedLength(index: Int): Int {
        require(index in 0 until chunks) { "no chunk $index" }
        return if (index < chunks - 1) chunkBytes else size - chunkBytes * (chunks - 1)
    }

    fun append(index: Int, bytes: ByteArray) {
        check(!finished) { "already finished" }
        require(index == nextIndex) { "chunk $index arrived, expected $nextIndex" }
        require(bytes.size == expectedLength(index)) { "chunk $index holds ${bytes.size} bytes, expected ${expectedLength(index)}" }
        bytes.copyInto(buffer, written)
        written += bytes.size
        nextIndex += 1
    }

    /** The whole picture. Throws if anything is missing; can be called once. */
    fun finish(): ByteArray {
        check(!finished) { "already finished" }
        check(nextIndex == chunks && written == size) { "only $written of $size bytes arrived" }
        finished = true
        return buffer
    }
}
