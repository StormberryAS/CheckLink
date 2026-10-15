package no.stormberry.checklink

/**
 * Decides what the WebView may have when the page asks for a device (getUserMedia and the
 * like reach the app as WebChromeClient.onPermissionRequest). Pure Kotlin, unit tested.
 *
 * The rule, from the spec (section 5, steps 1 and 2): grant ONLY video capture, ONLY to the
 * app's own pages at https://appassets.androidplatform.net, and ONLY while the window is
 * protected for the camera (FLAG_SECURE, which the page asks for before it asks for the
 * camera; spec step 5). Without that, as on a WebView too old for the bridge, the camera is
 * refused, so its picture can never reach a screenshot. Everything else is denied whole:
 *  - audio capture (the page never asks for the microphone), protected media (DRM
 *    identifiers), MIDI and any resource Android adds later;
 *  - a mixed request, such as video and audio together: the page asks for video alone
 *    (audio: false), so a request for more is not CheckLink's own and gets nothing, not even
 *    the video part;
 *  - any other origin, plain http, another port, an empty or missing origin.
 *
 * Granting the WebView's request is not the same as holding Android's CAMERA permission;
 * MainActivity asks Android first when the app does not hold it yet (step 3).
 */
object CameraPermission {
    /** The value of android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE. */
    const val VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE"
    const val AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE"
    const val PROTECTED_MEDIA_ID = "android.webkit.resource.PROTECTED_MEDIA_ID"
    const val MIDI_SYSEX = "android.webkit.resource.MIDI_SYSEX"

    enum class Decision { GRANT_VIDEO, DENY }

    fun decide(origin: String?, resources: List<String?>?, screenProtected: Boolean): Decision {
        if (!screenProtected) return Decision.DENY
        if (!NavigationPolicy.isAssetOrigin(origin)) return Decision.DENY
        if (resources.isNullOrEmpty()) return Decision.DENY
        // Exactly one kind of resource, and it is video. Duplicates of it are tolerated.
        return if (resources.all { it == VIDEO_CAPTURE }) Decision.GRANT_VIDEO else Decision.DENY
    }
}
