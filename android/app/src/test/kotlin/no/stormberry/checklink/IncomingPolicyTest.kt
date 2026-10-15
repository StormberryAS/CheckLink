package no.stormberry.checklink

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingPolicyTest {
    private val own = setOf("no.stormberry.checklink.files")

    @Test fun contentUrisFromOtherAppsAreRead() {
        assertTrue(IncomingPolicy.accept("content", "media", own))
        assertTrue(IncomingPolicy.accept("content", "com.google.android.apps.photos.contentprovider", own))
        assertTrue(IncomingPolicy.accept("content", "media", emptySet()))
    }

    @Test fun fileUrisAreNeverRead() {
        assertFalse(IncomingPolicy.accept("file", "", own))
        assertFalse(IncomingPolicy.accept("FILE", null, own))
    }

    @Test fun ourOwnAuthoritiesAreRefused() {
        assertFalse(IncomingPolicy.accept("content", "no.stormberry.checklink.files", own))
        assertFalse(IncomingPolicy.accept("content", "NO.STORMBERRY.CHECKLINK.FILES", own))
    }

    @Test fun theAndroidxStartupProviderAndOurFileProviderCountAsOurOwn() {
        // The merged manifest carries androidx.startup's InitializationProvider and (stage 4b)
        // CheckLink's FileProvider for the picture of a QR code under the app's package, debug
        // suffix included. A share of CheckLink's own picture back into CheckLink is refused.
        val release = IncomingPolicy.ownAuthorities("no.stormberry.checklink")
        val debug = IncomingPolicy.ownAuthorities("no.stormberry.checklink.debug")
        assertEquals(setOf("no.stormberry.checklink.androidx-startup", "no.stormberry.checklink.outgoing"), release)
        assertFalse(IncomingPolicy.accept("content", "no.stormberry.checklink.androidx-startup", release))
        assertFalse(IncomingPolicy.accept("content", "no.stormberry.checklink.debug.androidx-startup", debug))
        assertFalse(IncomingPolicy.accept("content", "no.stormberry.checklink.outgoing", release))
        assertFalse(IncomingPolicy.accept("content", "NO.STORMBERRY.CHECKLINK.OUTGOING", release))
        assertFalse(IncomingPolicy.accept("content", "no.stormberry.checklink.debug.outgoing", debug))
        assertTrue(IncomingPolicy.accept("content", "media", release))
        // Another app's provider of the same shape is not ours.
        assertTrue(IncomingPolicy.accept("content", "com.example.outgoing", release))
    }

    @Test fun aShareIsReadOnceNotFromRecentsOrSavedState() {
        assertEquals(0x00100000, Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        // A share from another app: new task, maybe a grant flag.
        assertTrue(IncomingPolicy.isNewShare(Intent.FLAG_ACTIVITY_NEW_TASK, restored = false))
        assertTrue(IncomingPolicy.isNewShare(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION, restored = false))
        assertTrue(IncomingPolicy.isNewShare(0, restored = false))
        // Reopened from Recents with no saved state (the emulator logged flg=0x10100000 and
        // 0x10100001 for a reopen after Back, before SEC-8 took the card out of Recents on Back).
        assertFalse(IncomingPolicy.isNewShare(0x10100000, restored = false))
        assertFalse(IncomingPolicy.isNewShare(0x10100001, restored = false))
        // Recreated after a rotation or a stopped process.
        assertFalse(IncomingPolicy.isNewShare(Intent.FLAG_ACTIVITY_NEW_TASK, restored = true))
        assertFalse(IncomingPolicy.isNewShare(0x10100000, restored = true))
    }

    @Test fun anythingElseIsRefused() {
        assertFalse(IncomingPolicy.accept("http", "example.com", own))
        assertFalse(IncomingPolicy.accept(null, null, own))
        assertFalse(IncomingPolicy.accept("content", "", own))
    }

    @Test fun onePictureOfAtMost40Megabytes() {
        assertEquals(1, IncomingPolicy.MAX_FILES)
        assertEquals(40L * 1024 * 1024, IncomingPolicy.MAX_BYTES)
        assertTrue(IncomingPolicy.sizeAllowed(-1))
        assertTrue(IncomingPolicy.sizeAllowed(40L * 1024 * 1024))
        assertFalse(IncomingPolicy.sizeAllowed(40L * 1024 * 1024 + 1))
    }
}
