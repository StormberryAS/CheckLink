package no.stormberry.checklink

/**
 * Whether a request to open an address follows a real tap or key press closely enough to
 * count as the person's own. Pure Kotlin, unit tested.
 *
 * Go to may open the clean link only when the person presses it (spec section 5: "Open: on
 * a tap only"). Two locks check that:
 *  1. the page side: android-bridge.js sends an open request only while the page has the
 *     browser's user activation (navigator.userActivation.isActive), which only a real
 *     press gives and which a script cannot fake;
 *  2. the app side, here: MainActivity notes the time of the last finger lifted from the
 *     screen and of the last Enter, Space or D-pad centre key, and an open request more than
 *     [WINDOW_MS] later is refused.
 * While an accessibility service is on (TalkBack, Switch Access), a press can reach the page
 * as an accessibility action with no touch event at all, so the app side would refuse every
 * Go to for those people; then the page-side lock alone decides ([accessibilityOn]).
 */
object TapWindow {
    /** Long enough for a slow phone to run the page's click handler, short enough to mean "just now". */
    const val WINDOW_MS = 3_000L

    /** Times are SystemClock.uptimeMillis() values; 0 means "no input yet". */
    fun allows(lastInputMs: Long, nowMs: Long, accessibilityOn: Boolean): Boolean {
        if (accessibilityOn) return true
        if (lastInputMs <= 0L || nowMs < lastInputMs) return false
        return nowMs - lastInputMs <= WINDOW_MS
    }
}
