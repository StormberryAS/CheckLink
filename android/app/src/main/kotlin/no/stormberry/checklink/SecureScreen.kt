package no.stormberry.checklink

/**
 * When the window must carry FLAG_SECURE, which keeps it out of screenshots, screen
 * recordings and the recent-apps thumbnail. Pure Kotlin, unit tested.
 *
 * The page says when it starts and stops showing something that must not be captured: the
 * camera card (a live picture of the room), a secret from a code shown in full (a 2FA seed,
 * recovery words, a Wi-Fi password) and, since stage 4b (SEC-10, best effort), a sign-in or
 * reset link or a link with personal details in it. Each is a separate reason; the flag stays
 * while any reason holds. The reasons never stand in for each other: the camera is granted
 * only while CAMERA holds ([holds]), whatever a link on screen has asked for.
 *
 * Clearing it is the delicate part. Android takes the recent-apps thumbnail as the app
 * leaves the screen, and on the way out the page stops the camera and says so. If the flag
 * went at that moment, the thumbnail could catch the last camera frame. So the flag is only
 * ever cleared while the app is in the foreground: a "stop" that arrives while it is paused
 * is remembered and applied when it comes back ([applyNow] answers false until then). A page
 * that reloads, or whose renderer dies, has nothing on show, so [reset] drops every reason.
 */
class SecureScreen {
    private val reasons = mutableSetOf<OutgoingRequest.Reason>()

    /** True while any reason holds. */
    val wanted: Boolean get() = reasons.isNotEmpty()

    fun set(reason: OutgoingRequest.Reason, on: Boolean) {
        if (on) reasons += reason else reasons -= reason
    }

    fun reset() = reasons.clear()

    /**
     * What to do with the window now: true to set the flag, false to clear it, null to leave
     * it as it is (a clear that must wait until the app is in the foreground again).
     */
    fun applyNow(resumed: Boolean): Boolean? = when {
        wanted -> true
        resumed -> false
        else -> null
    }

    fun holds(reason: OutgoingRequest.Reason): Boolean = reason in reasons
}
