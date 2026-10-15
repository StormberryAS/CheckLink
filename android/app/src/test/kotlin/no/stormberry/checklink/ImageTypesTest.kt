package no.stormberry.checklink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageTypesTest {
    @Test fun threeTypesMayBeSharedIn() {
        assertEquals(listOf("image/png", "image/jpeg", "image/webp"), ImageTypes.SHARE_TYPES)
        assertTrue(ImageTypes.isShareable("image/png"))
        assertTrue(ImageTypes.isShareable("IMAGE/JPEG; charset=binary"))
        assertTrue(ImageTypes.isShareable("image/jpg"))
        assertFalse(ImageTypes.isShareable("image/heic"))
        assertFalse(ImageTypes.isShareable("image/heif"))
        assertFalse(ImageTypes.isShareable("image/gif"))
        assertFalse(ImageTypes.isShareable(null))
    }

    @Test fun thePickerOffersThePagesTypesWithoutHeic() {
        assertEquals(listOf("image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/avif"), ImageTypes.PICK_TYPES)
        assertFalse(ImageTypes.PICK_TYPES.any { it.contains("heic") || it.contains("heif") })
    }

    @Test fun mimeToExtension() {
        assertEquals("jpg", ImageTypes.extensionFor("image/jpeg"))
        assertEquals("png", ImageTypes.extensionFor("image/png"))
        assertEquals("webp", ImageTypes.extensionFor("image/webp"))
        assertEquals("jpg", ImageTypes.extensionFor("image/pjpeg"))
        assertNull(ImageTypes.extensionFor("image/heic"))
        assertNull(ImageTypes.extensionFor("application/octet-stream"))
        assertNull(ImageTypes.extensionFor(""))
    }

    @Test fun nameToMime() {
        assertEquals("image/jpeg", ImageTypes.mimeForName("a.JPG"))
        assertEquals("image/jpeg", ImageTypes.mimeForName("a.jpe"))
        assertEquals("image/webp", ImageTypes.mimeForName("shot.webp"))
        assertNull(ImageTypes.mimeForName("a.heic"))
        assertNull(ImageTypes.mimeForName("jpg"))
        assertNull(ImageTypes.mimeForName(null))
    }

    @Test fun sharedTypeComesFromTheProviderThenTheName() {
        assertEquals("image/png", ImageTypes.resolveShared("image/png", "a.jpg"))
        assertEquals("image/jpeg", ImageTypes.resolveShared("application/octet-stream", "a.jpeg"))
        assertEquals("image/webp", ImageTypes.resolveShared(null, "Screenshot.webp"))
        // A provider that says HEIC is believed: renaming the file does not get it in.
        assertNull(ImageTypes.resolveShared("image/heic", "IMG_1.jpg"))
        assertNull(ImageTypes.resolveShared(null, "IMG_1.HEIC"))
        assertNull(ImageTypes.resolveShared("image/gif", "a.gif"))
        assertNull(ImageTypes.resolveShared("video/mp4", null))
        assertNull(ImageTypes.resolveShared("text/plain", "a.png"))
    }
}
