package no.stormberry.checklink

import no.stormberry.checklink.CameraPermission.AUDIO_CAPTURE
import no.stormberry.checklink.CameraPermission.Decision.DENY
import no.stormberry.checklink.CameraPermission.Decision.GRANT_VIDEO
import no.stormberry.checklink.CameraPermission.MIDI_SYSEX
import no.stormberry.checklink.CameraPermission.PROTECTED_MEDIA_ID
import no.stormberry.checklink.CameraPermission.VIDEO_CAPTURE
import org.junit.Assert.assertEquals
import org.junit.Test

/** The decision table of spec section 5, steps 1 and 2: video only, the app's own pages only. */
class CameraPermissionTest {
    private val own = "https://appassets.androidplatform.net/"

    @Test fun theResourceNamesAreAndroids() {
        // The values of android.webkit.PermissionRequest.RESOURCE_*, which the WebView sends.
        assertEquals("android.webkit.resource.VIDEO_CAPTURE", VIDEO_CAPTURE)
        assertEquals("android.webkit.resource.AUDIO_CAPTURE", AUDIO_CAPTURE)
        assertEquals("android.webkit.resource.PROTECTED_MEDIA_ID", PROTECTED_MEDIA_ID)
        assertEquals("android.webkit.resource.MIDI_SYSEX", MIDI_SYSEX)
    }

    @Test fun videoForTheAppsOwnPagesIsGranted() {
        assertEquals(GRANT_VIDEO, CameraPermission.decide(own, listOf(VIDEO_CAPTURE), screenProtected = true))
        assertEquals(GRANT_VIDEO, CameraPermission.decide("https://appassets.androidplatform.net", listOf(VIDEO_CAPTURE), screenProtected = true))
        assertEquals(GRANT_VIDEO, CameraPermission.decide("https://appassets.androidplatform.net:443/", listOf(VIDEO_CAPTURE), screenProtected = true))
        assertEquals(GRANT_VIDEO, CameraPermission.decide(own, listOf(VIDEO_CAPTURE, VIDEO_CAPTURE), screenProtected = true))
    }

    @Test fun everyOtherResourceIsDenied() {
        assertEquals(DENY, CameraPermission.decide(own, listOf(AUDIO_CAPTURE), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf(PROTECTED_MEDIA_ID), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf(MIDI_SYSEX), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf("android.webkit.resource.SOMETHING_NEW"), screenProtected = true))
    }

    @Test fun mixedRequestsAreDeniedWhole() {
        assertEquals(DENY, CameraPermission.decide(own, listOf(VIDEO_CAPTURE, AUDIO_CAPTURE), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf(AUDIO_CAPTURE, VIDEO_CAPTURE), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf(VIDEO_CAPTURE, PROTECTED_MEDIA_ID), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf(VIDEO_CAPTURE, MIDI_SYSEX), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, listOf(VIDEO_CAPTURE, null), screenProtected = true))
    }

    @Test fun emptyRequestsAreDenied() {
        assertEquals(DENY, CameraPermission.decide(own, emptyList(), screenProtected = true))
        assertEquals(DENY, CameraPermission.decide(own, null, screenProtected = true))
    }

    @Test fun nothingIsGrantedWhileTheScreenIsUnprotected() {
        // The page asks the app to protect the window before it asks for the camera; a request
        // without that (a page fault, or a WebView with no bridge to ask through) is refused.
        assertEquals(DENY, CameraPermission.decide(own, listOf(VIDEO_CAPTURE), screenProtected = false))
        assertEquals(DENY, CameraPermission.decide("https://appassets.androidplatform.net", listOf(VIDEO_CAPTURE), screenProtected = false))
        assertEquals(DENY, CameraPermission.decide(own, listOf(VIDEO_CAPTURE, VIDEO_CAPTURE), screenProtected = false))
    }

    @Test fun anyOtherOriginIsDenied() {
        listOf(
            "http://appassets.androidplatform.net/",
            "https://appassets.androidplatform.net:8443/",
            "https://appassets.androidplatform.net.evil.example/",
            "https://evil.example/",
            "https://check.stormberry.as/",
            "file:///android_asset/web/index.html",
            "null",
            "",
            null,
        ).forEach { assertEquals("$it", DENY, CameraPermission.decide(it, listOf(VIDEO_CAPTURE), screenProtected = true)) }
    }
}
