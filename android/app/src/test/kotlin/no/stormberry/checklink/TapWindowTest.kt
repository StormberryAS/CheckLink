package no.stormberry.checklink

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TapWindowTest {
    @Test fun aPressJustNowCounts() {
        assertTrue(TapWindow.allows(10_000, 10_050, false))
        assertTrue(TapWindow.allows(10_000, 10_000 + TapWindow.WINDOW_MS, false))
    }

    @Test fun anOldPressDoesNot() {
        assertFalse(TapWindow.allows(10_000, 10_001 + TapWindow.WINDOW_MS, false))
        assertFalse(TapWindow.allows(10_000, 60_000, false))
    }

    @Test fun noPressAtAllDoesNot() {
        assertFalse(TapWindow.allows(0, 5_000, false))
        assertFalse(TapWindow.allows(-1, 5_000, false))
    }

    @Test fun aClockThatRunsBackwardsDoesNot() {
        assertFalse(TapWindow.allows(10_000, 9_000, false))
    }

    @Test fun withAnAccessibilityServiceOnThePageSideLockDecides() {
        assertTrue(TapWindow.allows(0, 5_000, true))
        assertTrue(TapWindow.allows(10_000, 60_000, true))
    }
}
