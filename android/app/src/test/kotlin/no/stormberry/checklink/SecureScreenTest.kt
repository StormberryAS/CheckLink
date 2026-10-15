package no.stormberry.checklink

import no.stormberry.checklink.OutgoingRequest.Reason.CAMERA
import no.stormberry.checklink.OutgoingRequest.Reason.LINK
import no.stormberry.checklink.OutgoingRequest.Reason.SECRET
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureScreenTest {
    @Test fun nothingOnShowNothingSet() {
        val s = SecureScreen()
        assertFalse(s.wanted)
        assertEquals(false, s.applyNow(resumed = true))
    }

    @Test fun theFlagHoldsWhileAnyReasonDoes() {
        val s = SecureScreen()
        s.set(CAMERA, true)
        assertEquals(true, s.applyNow(resumed = true))
        s.set(SECRET, true)
        s.set(CAMERA, false)
        assertTrue(s.holds(SECRET))
        assertFalse(s.holds(CAMERA))
        assertEquals(true, s.applyNow(resumed = true))
        s.set(SECRET, false)
        assertEquals(false, s.applyNow(resumed = true))
    }

    @Test fun setTwiceAndClearOnce() {
        val s = SecureScreen()
        s.set(SECRET, true)
        s.set(SECRET, true)
        s.set(SECRET, false)
        assertFalse(s.wanted)
    }

    @Test fun neverClearedWhileTheAppIsLeavingTheScreen() {
        val s = SecureScreen()
        s.set(CAMERA, true)
        assertEquals(true, s.applyNow(resumed = false))
        // The page stops the camera as the app goes to the background: the flag stays until
        // the app is back, so the recent-apps thumbnail never catches the camera.
        s.set(CAMERA, false)
        assertNull(s.applyNow(resumed = false))
        assertEquals(false, s.applyNow(resumed = true))
    }

    @Test fun aLinkOnScreenSetsTheFlagButNeverStandsInForTheCamera() {
        // SEC-10 (stage 4b): a sign-in link or a link with personal details on screen.
        val s = SecureScreen()
        s.set(LINK, true)
        assertEquals(true, s.applyNow(resumed = true))
        assertTrue(s.holds(LINK))
        // The camera is granted only while CAMERA itself holds (MainActivity.onWebPermission).
        assertFalse(s.holds(CAMERA))
        assertFalse(s.holds(SECRET))
        assertEquals(
            CameraPermission.Decision.DENY,
            CameraPermission.decide(NavigationPolicy.ASSET_ORIGIN, listOf(CameraPermission.VIDEO_CAPTURE), screenProtected = s.holds(CAMERA)),
        )
        s.set(CAMERA, true)
        s.set(LINK, false)
        assertTrue(s.holds(CAMERA))
        assertEquals(true, s.applyNow(resumed = true))
        s.set(CAMERA, false)
        assertEquals(false, s.applyNow(resumed = true))
    }

    @Test fun aLinkLeavingTheScreenWhileTheAppIsAwayClearsOnlyOnReturn() {
        val s = SecureScreen()
        s.set(LINK, true)
        s.set(LINK, false)
        assertNull(s.applyNow(resumed = false))
        assertEquals(false, s.applyNow(resumed = true))
    }

    @Test fun aReloadedPageHasNothingOnShow() {
        val s = SecureScreen()
        s.set(CAMERA, true)
        s.set(SECRET, true)
        s.set(LINK, true)
        s.reset()
        assertFalse(s.wanted)
        assertEquals(false, s.applyNow(resumed = true))
    }
}
