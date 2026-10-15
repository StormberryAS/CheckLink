package no.stormberry.checklink

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * The save screen's document after a save (stage 4b review S4 and S10): a file the person chose to
 * replace is never deleted unless CheckLink opened it for writing, an empty one the save screen
 * made is removed, and a write through plain "w" that leaves an older file's end behind fails.
 */
class SaveTargetTest {
    /**
     * A document in a stand-in provider. [content] null: deleted. [truncates]: whether "wt" is
     * allowed; "w" overwrites from the start without truncating, as some providers do.
     */
    private class FakeDocument(
        var content: ByteArray?,
        val truncates: Boolean = true,
        val sayssize: Boolean = true,
        val failWrite: Boolean = false,
    ) : SaveTarget.Document {
        val modes = mutableListOf<String>()

        override fun open(mode: String): OutputStream? {
            modes += mode
            if (mode == "wt" && !truncates) throw IllegalArgumentException("wt refused")
            val start = if (mode == "wt") ByteArray(0) else content ?: ByteArray(0)
            if (mode == "wt") content = ByteArray(0)
            return object : ByteArrayOutputStream() {
                override fun write(b: ByteArray, off: Int, len: Int) {
                    if (failWrite) throw IOException("disk full")
                    super.write(b, off, len)
                }

                override fun close() {
                    val written = toByteArray()
                    content = if (written.size >= start.size) written else written + start.copyOfRange(written.size, start.size)
                }
            }
        }

        override fun size(): Long? = if (sayssize) content?.size?.toLong() else null

        override fun delete() {
            content = null
        }
    }

    private val png = ByteArray(300) { (it * 7).toByte() }
    private val photo = ByteArray(5000) { 1 }

    @Test fun aNewDocumentGetsThePicture() {
        val doc = FakeDocument(ByteArray(0))
        assertTrue(SaveTarget.save(doc, png))
        assertArrayEquals(png, doc.content)
        assertEquals(listOf("wt"), doc.modes)
    }

    @Test fun aFileChosenToReplaceIsKeptWhenThePictureIsGone() {
        // The waiting picture is gone (Android trimmed the cache while CheckLink was stopped), or
        // failed PngCheck: nothing is written, and the person's own file stays as it was.
        val doc = FakeDocument(photo.copyOf())
        assertFalse(SaveTarget.save(doc, null))
        assertArrayEquals(photo, doc.content)
        assertTrue(doc.modes.isEmpty())
    }

    @Test fun theEmptyDocumentTheSaveScreenMadeIsRemovedWhenThePictureIsGone() {
        val doc = FakeDocument(ByteArray(0))
        assertFalse(SaveTarget.save(doc, null))
        assertNull(doc.content)
    }

    @Test fun aDocumentOfUnknownSizeIsLeftAlone() {
        val doc = FakeDocument(photo.copyOf(), sayssize = false)
        assertFalse(SaveTarget.save(doc, null))
        assertArrayEquals(photo, doc.content)
    }

    @Test fun aReplacedFileIsOverwrittenWhole() {
        val doc = FakeDocument(photo.copyOf())
        assertTrue(SaveTarget.save(doc, png))
        assertArrayEquals(png, doc.content)
    }

    @Test fun plainWThatLeavesAnOlderFilesEndFailsAndRemovesTheMix() {
        // "wt" refused, and "w" does not truncate: the picture would be followed by the end of the
        // older, larger file (its metadata included). That fails, and the mixed file goes.
        val doc = FakeDocument(photo.copyOf(), truncates = false)
        assertFalse(SaveTarget.save(doc, png))
        assertNull(doc.content)
        assertEquals(listOf("wt", "w"), doc.modes)
    }

    @Test fun plainWIntoANewDocumentIsFine() {
        val doc = FakeDocument(ByteArray(0), truncates = false)
        assertTrue(SaveTarget.save(doc, png))
        assertArrayEquals(png, doc.content)
    }

    @Test fun aWriteThatFailsAfterOpeningRemovesTheBrokenFile() {
        val doc = FakeDocument(photo.copyOf(), failWrite = true)
        assertFalse(SaveTarget.save(doc, png))
        assertNull(doc.content)
    }

    @Test fun aProviderThatOpensNothingLeavesAFilledFileAlone() {
        val refusing = object : SaveTarget.Document {
            var deleted = false
            override fun open(mode: String): OutputStream? = null
            override fun size(): Long? = 5000
            override fun delete() {
                deleted = true
            }
        }
        assertFalse(SaveTarget.save(refusing, png))
        assertFalse(refusing.deleted)
    }
}
