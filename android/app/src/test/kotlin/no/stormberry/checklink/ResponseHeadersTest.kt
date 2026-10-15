package no.stormberry.checklink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseHeadersTest {
    private val csp = ResponseHeaders.ALL.getValue("Content-Security-Policy")

    private fun directive(name: String): List<String> =
        csp.split(';').map { it.trim() }.firstOrNull { it == name || it.startsWith("$name ") }?.split(' ')?.drop(1)
            ?: error("no $name directive")

    @Test fun everyResponseCarriesTheFullPolicy() {
        // NOTICE's recommended header, character for character (tests/android-app.test.mjs
        // compares the two files as well).
        assertEquals(
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; " +
                "font-src 'self'; connect-src 'none'; worker-src 'self'; form-action 'none'; object-src 'none'; " +
                "base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
            csp,
        )
    }

    @Test fun theWorkerMayCompileWebAssemblyButNeverEvalOrConnect() {
        assertEquals(listOf("'self'", "'wasm-unsafe-eval'"), directive("script-src"))
        assertFalse(csp.contains("'unsafe-eval'"))
        assertFalse(csp.contains("'unsafe-inline'"))
        assertEquals(listOf("'none'"), directive("connect-src"))
        assertEquals(listOf("'self'"), directive("worker-src"))
        assertEquals(listOf("'none'"), directive("frame-ancestors"))
    }

    @Test fun noPermissionsPolicyEverTurnsTheCameraOff() {
        assertFalse(ResponseHeaders.ALL.keys.any { it.equals("Permissions-Policy", ignoreCase = true) })
        assertFalse(ResponseHeaders.ALL.keys.any { it.equals("Feature-Policy", ignoreCase = true) })
        assertFalse(ResponseHeaders.ALL.values.any { it.contains("camera=()") })
    }

    @Test fun theOtherHeaders() {
        assertEquals("nosniff", ResponseHeaders.ALL["X-Content-Type-Options"])
        assertEquals("no-store", ResponseHeaders.ALL["Cache-Control"])
        assertTrue(ResponseHeaders.ALL.containsKey("Referrer-Policy"))
    }
}
