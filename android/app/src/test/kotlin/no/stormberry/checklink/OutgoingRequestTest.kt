package no.stormberry.checklink

import no.stormberry.checklink.OutgoingRequest.CameraState
import no.stormberry.checklink.OutgoingRequest.Copy
import no.stormberry.checklink.OutgoingRequest.ImageAction
import no.stormberry.checklink.OutgoingRequest.ImageBegin
import no.stormberry.checklink.OutgoingRequest.Open
import no.stormberry.checklink.OutgoingRequest.Reason
import no.stormberry.checklink.OutgoingRequest.Secure
import no.stormberry.checklink.OutgoingRequest.Settings
import no.stormberry.checklink.OutgoingRequest.Share
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class OutgoingRequestTest {
    private fun parse(
        t: Any?, id: Any? = 1, text: Any? = null, sensitive: Any? = null, url: Any? = null, reason: Any? = null, on: Any? = null,
    ) = OutgoingRequest.parse(t, id, text, sensitive, url, reason, on)

    // ---- copy and share

    @Test fun copyTakesTextAndAnOptionalSensitiveFlag() {
        assertEquals(Copy(1, "https://example.com/a", false), parse("copy", text = "https://example.com/a"))
        assertEquals(Copy(7, "hunter2", true), parse("copy", 7, text = "hunter2", sensitive = true))
        assertEquals(Copy(7, "x", false), parse("copy", 7, text = "x", sensitive = false))
    }

    @Test fun sensitiveMustBeARealBoolean() {
        assertNull(parse("copy", text = "x", sensitive = "true"))
        assertNull(parse("copy", text = "x", sensitive = 1))
        assertNull(parse("copy", text = "x", sensitive = Any()))
    }

    @Test fun shareTakesText() {
        assertEquals(Share(3, "https://example.com/"), parse("share", 3, text = "https://example.com/"))
    }

    @Test fun textIsCopiedExactlyAsThePageShowsIt() {
        val s = "WIFI password: æøå ‮​\n\ttab 😀"
        assertEquals(Copy(1, s, true), parse("copy", text = s, sensitive = true))
    }

    @Test fun textMustBeAStringOfSaneSize() {
        assertNull(parse("copy", text = null))
        assertNull(parse("copy", text = ""))
        assertNull(parse("copy", text = 42))
        assertNull(parse("share", text = listOf("a")))
        assertNull(parse("copy", text = "a".repeat(OutgoingRequest.MAX_TEXT_CHARS + 1)))
        assertEquals(OutgoingRequest.MAX_TEXT_CHARS, (parse("copy", text = "a".repeat(OutgoingRequest.MAX_TEXT_CHARS)) as Copy).text.length)
    }

    @Test fun textWithNulOrBrokenSurrogatesIsRefused() {
        assertNull(parse("copy", text = "a\u0000b"))
        assertNull(parse("copy", text = "a\uD83D"))
        assertNull(parse("copy", text = "\uDE00a"))
        assertNull(parse("share", text = "a\uD83Db"))
    }

    // ---- open (Go to)

    @Test fun openTakesAnHttpOrHttpsAddress() {
        assertEquals(Open(2, "https://example.com/a?id=2"), parse("open", 2, url = "https://example.com/a?id=2"))
        assertEquals(Open(2, "http://example.com/"), parse("open", 2, url = "http://example.com/"))
        assertEquals(Open(2, "https://xn--bcher-kva.example/"), parse("open", 2, url = "https://xn--bcher-kva.example/"))
    }

    @Test fun theBrowsersWrittenFormIsAcceptedWhereJavaNetUriIsStricter() {
        // new URL(...).href leaves these as they are in a query or fragment.
        listOf(
            "https://example.com/?a=1|2",
            "https://example.com/?q={x}&b=^`",
            "https://example.com/?a=%zz",
            "https://example.com/p#a#b",
            "https://example.com/?filters=ex1:\"ez5\"",
            "https://[2001:db8::1]/path",
            "https://a_b.example/",
            "https://my_shop.example.com/p?id=7|8",
        ).forEach { assertEquals(it, Open(1, it), parse("open", url = it)) }
    }

    @Test fun openRefusesEverythingElse() {
        listOf(
            "javascript:alert(1)",
            "intent://scan/#Intent;scheme=https;end",
            "file:///sdcard/x.html",
            "content://media/external/images/media/1",
            "data:text/html,x",
            "mailto:info@stormberry.as",
            "nostr:npub1x",
            "ftp://example.com/",
            "https://appassets.androidplatform.net/index.html",
            "https://google.com@evil.example/",
            "https://user:pass@example.com/",
            "https:///nohost",
            "https://",
            "https://example.com/a b",
            "https://bøker.no/",
            "  https://example.com/",
            "https://example.com/\n",
            "",
        ).forEach { assertNull(it, parse("open", url = it)) }
        assertNull(parse("open", url = null))
        assertNull(parse("open", url = 5))
        assertNull(parse("open", url = "https://example.com/" + "a".repeat(OutgoingRequest.MAX_URL_CHARS)))
    }

    @Test fun decisionFormOnlyTouchesWhatFollowsTheHost() {
        assertEquals("https://example.com/?a=1%7C2", OutgoingRequest.decisionForm("https://example.com/?a=1|2"))
        assertEquals("https://example.com/?a=%25zz%41", OutgoingRequest.decisionForm("https://example.com/?a=%zz%41"))
        assertEquals("https://[::1]/%5B%5D", OutgoingRequest.decisionForm("https://[::1]/[]"))
        assertEquals("https://example.com/p#a%23b", OutgoingRequest.decisionForm("https://example.com/p#a#b"))
        assertEquals("https://example.com", OutgoingRequest.decisionForm("https://example.com"))
    }

    // ---- settings, secure, camera-state

    @Test fun settingsAndCameraStateNeedOnlyAnId() {
        assertEquals(Settings(9), parse("settings", 9))
        assertEquals(CameraState(9), parse("camera-state", 9))
    }

    @Test fun secureNamesCameraSecretOrLinkAndOnOrOff() {
        assertEquals(Secure(4, Reason.CAMERA, true), parse("secure", 4, reason = "camera", on = true))
        assertEquals(Secure(4, Reason.SECRET, false), parse("secure", 4, reason = "secret", on = false))
        // SEC-10 (stage 4b): a sign-in link or a link with personal details on screen.
        assertEquals(Secure(5, Reason.LINK, true), parse("secure", 5, reason = "link", on = true))
        assertEquals(Secure(5, Reason.LINK, false), parse("secure", 5, reason = "link", on = false))
        assertNull(parse("secure", reason = "LINK", on = true))
        assertNull(parse("secure", reason = "microphone", on = true))
        assertNull(parse("secure", reason = "CAMERA", on = true))
        assertNull(parse("secure", reason = null, on = true))
        assertNull(parse("secure", reason = "camera", on = "true"))
        assertNull(parse("secure", reason = "camera", on = null))
    }

    // ---- the envelope

    @Test fun theIdMustBeAPositiveWholeNumber() {
        assertNull(parse("settings", 0))
        assertNull(parse("settings", -1))
        assertNull(parse("settings", "1"))
        assertNull(parse("settings", 1.0))
        assertNull(parse("settings", null))
        assertNull(parse("settings", Long.MAX_VALUE))
        assertEquals(Settings(Int.MAX_VALUE), parse("settings", Int.MAX_VALUE.toLong()))
    }

    @Test fun unknownTypesAreIgnored() {
        listOf("hello", "in-pull", "copyText", "COPY", "save", "out-begin", "out-chunk", "", null, 1).forEach { assertNull("$it", parse(it, text = "x", url = "https://example.com/")) }
    }

    // ---- out-begin and out-chunk: the picture of a QR code (stage 4b)

    private fun begin(id: Any? = 3, action: Any? = "save-image", mime: Any? = "image/png", size: Any? = 9044, chunks: Any? = 1) =
        OutgoingRequest.parseImageBegin(id, action, mime, size, chunks)

    @Test fun outBeginTakesSaveOrShareOfAPngWithTheRightChunkCount() {
        assertEquals(ImageBegin(3, ImageAction.SAVE, 9044, 1), begin())
        assertEquals(ImageBegin(3, ImageAction.SHARE, 9044, 1), begin(action = "share-image"))
        assertEquals(ImageBegin(3, ImageAction.SAVE, 126_073, 2), begin(size = 126_073, chunks = 2))
        assertEquals(ImageBegin(3, ImageAction.SAVE, 65_536, 1), begin(size = 65_536, chunks = 1))
        assertEquals(ImageBegin(3, ImageAction.SAVE, 65_537, 2), begin(size = 65_537, chunks = 2))
        assertEquals(ImageBegin(3, ImageAction.SAVE, 262_144, 4), begin(size = 262_144, chunks = 4))
        assertEquals(ImageBegin(3, ImageAction.SAVE, 1, 1), begin(size = 1, chunks = 1))
        assertEquals(ImageBegin(3, ImageAction.SAVE, 9044, 1), begin(size = 9044L, chunks = 1L))
    }

    @Test fun outBeginRefusesOtherActionsAndTypes() {
        listOf("save", "share", "copy", "copy-image", "SAVE-IMAGE", "", null, 1).forEach { assertNull("$it", begin(action = it)) }
        listOf("image/jpeg", "image/webp", "IMAGE/PNG", "image/png; charset=x", "", null, 1, "text/plain").forEach { assertNull("$it", begin(mime = it)) }
    }

    @Test fun outBeginCapsTheSizeAt256KiB() {
        assertNull(begin(size = 262_145, chunks = 5))
        assertNull(begin(size = 0, chunks = 0))
        assertNull(begin(size = -1, chunks = 1))
        assertNull(begin(size = Long.MAX_VALUE, chunks = 1))
        assertNull(begin(size = 9044.0, chunks = 1))
        assertNull(begin(size = "9044", chunks = 1))
        assertNull(begin(size = null, chunks = 1))
    }

    @Test fun outBeginNeedsExactlyTheChunkCountTheSizeGives() {
        assertNull(begin(size = 9044, chunks = 2))
        assertNull(begin(size = 9044, chunks = 0))
        assertNull(begin(size = 65_537, chunks = 1))
        assertNull(begin(size = 126_073, chunks = 3))
        assertNull(begin(size = 9044, chunks = 1.0))
        assertNull(begin(size = 9044, chunks = null))
        assertEquals(1, OutgoingRequest.chunksFor(1))
        assertEquals(1, OutgoingRequest.chunksFor(65_536))
        assertEquals(2, OutgoingRequest.chunksFor(65_537))
        assertEquals(4, OutgoingRequest.chunksFor(262_144))
    }

    @Test fun outBeginNeedsAPositiveWholeId() {
        assertNull(begin(id = 0))
        assertNull(begin(id = -2))
        assertNull(begin(id = "3"))
        assertNull(begin(id = 3.0))
        assertNull(begin(id = null))
    }

    @Test fun aChunkIsPaddedBase64OfExactlyTheExpectedBytes() {
        val bytes = ByteArray(1000) { (it * 7).toByte() }
        val data = Base64.getEncoder().encodeToString(bytes)
        assertArrayEquals(bytes, OutgoingRequest.decodeChunk(data, 1000))
        val full = ByteArray(OutgoingRequest.IMAGE_CHUNK_BYTES) { it.toByte() }
        assertArrayEquals(full, OutgoingRequest.decodeChunk(Base64.getEncoder().encodeToString(full), full.size))
        // One byte, two bytes: the padding is required.
        assertArrayEquals(byteArrayOf(1), OutgoingRequest.decodeChunk("AQ==", 1))
        assertNull(OutgoingRequest.decodeChunk("AQ", 1))
        assertArrayEquals(byteArrayOf(1, 2), OutgoingRequest.decodeChunk("AQI=", 2))
    }

    @Test fun aChunkOfTheWrongSizeOrBadBase64IsRefused() {
        val data = Base64.getEncoder().encodeToString(ByteArray(1000))
        assertNull(OutgoingRequest.decodeChunk(data, 999))
        assertNull(OutgoingRequest.decodeChunk(data, 1001))
        assertNull(OutgoingRequest.decodeChunk(data.substring(4), 1000))
        assertNull(OutgoingRequest.decodeChunk(data.dropLast(4) + "A=A=", 1000))
        assertNull(OutgoingRequest.decodeChunk(data.dropLast(1) + "!", 1000))
        assertNull(OutgoingRequest.decodeChunk(data.dropLast(4) + "AA\nA", 1000))
        assertNull(OutgoingRequest.decodeChunk(data.replace('A', '-'), 1000))
        assertNull(OutgoingRequest.decodeChunk(" " + data.drop(1), 1000))
        assertNull(OutgoingRequest.decodeChunk(null, 1000))
        assertNull(OutgoingRequest.decodeChunk(1000, 1000))
        assertNull(OutgoingRequest.decodeChunk("", 0))
        // Never more than one chunk's worth, whatever the caller expects.
        val big = Base64.getEncoder().encodeToString(ByteArray(OutgoingRequest.IMAGE_CHUNK_BYTES + 1))
        assertNull(OutgoingRequest.decodeChunk(big, OutgoingRequest.IMAGE_CHUNK_BYTES + 1))
    }
}
