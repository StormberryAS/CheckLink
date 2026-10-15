package no.stormberry.checklink

import java.io.OutputStream

/**
 * Writes the picture of a QR code into the document Android's save screen returned, and tidies
 * up after a failure without ever deleting a file CheckLink did not write (stage 4b review S4 and
 * S10). Pure Kotlin over [Document], unit tested with a stand-in.
 *
 *  - The save screen can return an existing file that the person chose to replace. Such a file is
 *    deleted after a failure only once CheckLink has opened it for writing, when its old content
 *    is gone anyway. Before that (the waiting picture gone after Android stopped CheckLink, or a
 *    picture that fails [PngCheck]) only an empty document is removed: the one the save screen
 *    has just made. A document of unknown or non-zero size is left exactly as it was.
 *  - A provider that refuses "wt" (write and truncate) gets plain "w", which some providers do
 *    not truncate. The size is then checked after writing, so the end of an older, larger file,
 *    with its own metadata, can never follow the picture's end marker: a size that differs fails
 *    the save, and the file is deleted.
 */
object SaveTarget {
    interface Document {
        /** A stream that writes the document in [mode] ("wt" or "w"); null or an exception when refused. */
        fun open(mode: String): OutputStream?

        /** The document's size in bytes, or null when the provider does not say. */
        fun size(): Long?

        /** Deletes the document, best effort. */
        fun delete()
    }

    /**
     * Writes [png] into [doc], or only tidies up when [png] is null (nothing may be written).
     * True only when the document holds the picture.
     */
    fun save(doc: Document, png: ByteArray?): Boolean {
        if (png == null) {
            dropIfEmpty(doc)
            return false
        }
        var opened = false
        val ok = try {
            val truncated = try {
                doc.open("wt")
            } catch (_: Exception) {
                null
            }
            val out = truncated ?: doc.open("w") ?: error("no stream")
            opened = true
            out.use { it.write(png) }
            if (truncated == null) {
                val size = doc.size()
                check(size == null || size == png.size.toLong()) { "an older file's end is left after the picture" }
            }
            true
        } catch (_: Exception) {
            false
        }
        if (!ok) {
            if (opened) doc.delete() else dropIfEmpty(doc)
        }
        return ok
    }

    /** Removes the document only when it is empty: one the save screen made and nothing filled. */
    private fun dropIfEmpty(doc: Document) {
        val size = try {
            doc.size()
        } catch (_: Exception) {
            null
        }
        if (size == 0L) doc.delete()
    }
}
