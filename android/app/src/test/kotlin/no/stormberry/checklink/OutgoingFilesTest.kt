package no.stormberry.checklink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class OutgoingFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun eachPictureGetsItsOwnFolderInsideTheCache() {
        val out = OutgoingFiles(tmp.root)
        val a = out.newFile()
        val b = out.newFile()
        assertEquals("qr-code.png", a.name)
        assertNotEquals(a.parentFile, b.parentFile)
        assertEquals(File(tmp.root, "outgoing").canonicalFile, a.parentFile!!.parentFile!!.canonicalFile)
        assertTrue(out.owns(a))
        assertFalse(out.owns(File(tmp.root, "elsewhere.png")))
        assertFalse(out.owns(File(out.root, "../escape.png")))
    }

    @Test fun theNameAndTheProviderMatchTheManifestAndThePage() {
        assertEquals("qr-code.png", OutgoingFiles.QR_FILE)
        assertEquals("outgoing", OutgoingFiles.DIR)
        assertEquals("no.stormberry.checklink.outgoing", OutgoingFiles.authority("no.stormberry.checklink"))
        assertEquals("no.stormberry.checklink.debug.outgoing", OutgoingFiles.authority("no.stormberry.checklink.debug"))
    }

    @Test fun clearRemovesEverything() {
        val out = OutgoingFiles(tmp.root)
        out.newFile().writeBytes(byteArrayOf(1))
        out.newFile().writeBytes(byteArrayOf(2))
        assertEquals(2, out.clear())
        assertEquals(0, out.root.listFiles()!!.size)
        assertEquals(0, out.clear())
    }

    @Test fun deleteRemovesOnlyThatPicturesFolder() {
        val out = OutgoingFiles(tmp.root)
        val saved = out.newFile().apply { writeBytes(byteArrayOf(1)) }
        val shared = out.newFile().apply { writeBytes(byteArrayOf(2)) }
        assertTrue(out.delete(saved))
        assertFalse(saved.exists())
        assertFalse(saved.parentFile!!.exists())
        assertTrue(shared.isFile)
        assertTrue(out.root.isDirectory)
        assertEquals(1, out.root.listFiles()!!.size)
    }

    @Test fun deleteLeavesFilesThatAreNotOursAlone() {
        val out = OutgoingFiles(tmp.root)
        out.newFile().writeBytes(byteArrayOf(1))
        val outside = File(tmp.root, "keep/me.png").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(3)) }
        assertFalse(out.delete(outside))
        assertTrue(outside.isFile)
        // A file sitting directly in the root has no folder of its own; the root must stay.
        val loose = File(out.root, "loose.png").apply { writeBytes(byteArrayOf(4)) }
        assertFalse(out.delete(loose))
        assertTrue(out.root.isDirectory)
        assertTrue(loose.isFile)
    }

    @Test(expected = IllegalArgumentException::class)
    fun unsafeNamesAreRefused() {
        OutgoingFiles(tmp.root).newFile("../x.png")
    }
}
