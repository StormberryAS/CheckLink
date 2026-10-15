package no.stormberry.checklink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedTextTest {
    private fun take(s: CharSequence?) = SharedText.intake(s)

    @Test fun aBrowserShareArrivesAsSent() {
        val r = take("Example page https://example.com/a?utm_source=x&id=2")!!
        assertEquals("Example page https://example.com/a?utm_source=x&id=2", r.text)
        assertFalse(r.cut)
    }

    @Test fun lineBreaksAndTabsStayAndCarriageReturnsBecomeLineFeeds() {
        assertEquals("Title\nhttps://example.com/\tend\nx\ny", take("Title\r\nhttps://example.com/\tend\rx\ny")!!.text)
    }

    @Test fun controlCharactersAreTakenOut() {
        val r = take("https://exa\u0000mple.com/\u0007a\u001b[31m?b=\u007f1\u0085\u009f")!!
        assertEquals("https://example.com/a[31m?b=1", r.text)
    }

    @Test fun invisibleAndDirectionCharactersStaySoThePageCanWarnAboutThem() {
        // Zero-width space, right-to-left override, left-to-right mark, BOM: format characters.
        val s = "https://‮moc.elgoog@example.com/pa​th‎﻿"
        assertEquals(s, take(s)!!.text)
    }

    @Test fun internationalTextIsKept() {
        val s = "Se her: https://bøker.no/ø?q=æøå 日本語 😀"
        assertEquals(s, take(s)!!.text)
    }

    @Test fun nothingUsableIsNull() {
        assertNull(take(null))
        assertNull(take(""))
        assertNull(take("   \n\t "))
        assertNull(take("\u0000\u0001\u0002"))
    }

    @Test fun longTextIsCutAtTheLastSpaceBeforeTheCap() {
        val link = "https://example.com/" + "a".repeat(100)
        val text = "word ".repeat(1630) + link + " tail"
        val r = take(text)!!
        assertTrue(r.cut)
        assertTrue(r.text.toByteArray(Charsets.UTF_8).size <= SharedText.MAX_BYTES)
        // The cut falls at a space, so no link is ever cut in half.
        assertTrue(text.startsWith(r.text))
        assertFalse(r.text.endsWith(" "))
        assertTrue(r.text.endsWith("word") || r.text.endsWith(link))
    }

    @Test fun oneHugeLinkWithNoSpaceIsCutAtTheCap() {
        val r = take("https://example.com/?" + "x".repeat(20_000))!!
        assertTrue(r.cut)
        assertEquals(SharedText.MAX_BYTES, r.text.toByteArray(Charsets.UTF_8).size)
    }

    @Test fun theCapNeverSplitsACharacter() {
        // Each ø is two bytes of UTF-8, each emoji four (a surrogate pair).
        val r = take("ø".repeat(5000))!!
        assertEquals(SharedText.MAX_BYTES, r.text.toByteArray(Charsets.UTF_8).size)
        val e = take("😀".repeat(3000))!!
        assertEquals(0, e.text.length % 2)
        assertTrue(Character.isLowSurrogate(e.text.last()))
        assertEquals(SharedText.MAX_BYTES, e.text.toByteArray(Charsets.UTF_8).size)
    }

    @Test fun textExactlyAtTheCapIsNotCut() {
        val r = take("a".repeat(SharedText.MAX_BYTES))!!
        assertFalse(r.cut)
        assertEquals(SharedText.MAX_BYTES, r.text.length)
    }

    @Test fun aVeryLongShareIsStillCapped() {
        val r = take("x ".repeat(2_000_000))!!
        assertTrue(r.cut)
        assertTrue(r.text.toByteArray(Charsets.UTF_8).size <= SharedText.MAX_BYTES)
    }
}
