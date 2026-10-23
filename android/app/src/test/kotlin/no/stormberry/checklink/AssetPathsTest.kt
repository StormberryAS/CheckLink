package no.stormberry.checklink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetPathsTest {
    @Test fun plainPathsMapIntoTheWebFolder() {
        assertEquals("web/index.html", AssetPaths.resolve(""))
        assertEquals("web/index.html", AssetPaths.resolve("index.html"))
        assertEquals("web/src/qr-worker.js", AssetPaths.resolve("src/qr-worker.js"))
        assertEquals("web/vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js", AssetPaths.resolve("vendor/zxing-wasm-3.1.6/zxing_reader.wasm.js"))
        assertEquals("web/switcher-icons/check.svg", AssetPaths.resolve("switcher-icons/check.svg"))
        assertEquals("web/licences/zxing-wasm-MIT.txt", AssetPaths.resolve("licences/zxing-wasm-MIT.txt"))
        assertEquals("web/fonts/inter/index.html", AssetPaths.resolve("fonts/inter/"))
    }

    @Test fun nothingClimbsOutOrReachesHiddenFiles() {
        assertNull(AssetPaths.resolve("../AndroidManifest.xml"))
        assertNull(AssetPaths.resolve("src/../../x.js"))
        assertNull(AssetPaths.resolve("./index.html"))
        assertNull(AssetPaths.resolve("/index.html"))
        assertNull(AssetPaths.resolve("src//link-core.js"))
        assertNull(AssetPaths.resolve("a\\b.js"))
        assertNull(AssetPaths.resolve(".git/config.txt"))
        assertNull(AssetPaths.resolve("src/.hidden.js"))
        assertNull(AssetPaths.resolve("app.js\u0000.txt"))
        assertNull(AssetPaths.resolve(null))
    }

    @Test fun onlyKnownTypesAreServed() {
        assertNull(AssetPaths.resolve("dexopt/baseline.prof"))
        assertNull(AssetPaths.resolve("vendor/zxing-wasm-3.1.6/LICENSE"))
        assertNull(AssetPaths.resolve("README"))
        assertNull(AssetPaths.resolve("tools/vendor.mjs.bak"))
    }

    @Test fun contentTypes() {
        assertEquals("text/javascript", AssetPaths.mimeType("web/app.js"))
        assertEquals("text/javascript", AssetPaths.mimeType("web/src/qr-worker.js"))
        assertEquals("text/javascript", AssetPaths.mimeType("web/x.mjs"))
        assertEquals("text/html", AssetPaths.mimeType("web/index.html"))
        assertEquals("text/css", AssetPaths.mimeType("web/style.css"))
        assertEquals("image/svg+xml", AssetPaths.mimeType("web/favicon.svg"))
        assertEquals("font/woff2", AssetPaths.mimeType("web/fonts/inter/InterVariable.woff2"))
        assertEquals("application/wasm", AssetPaths.mimeType("web/vendor/x/zxing_reader.wasm"))
        assertEquals("application/json", AssetPaths.mimeType("web/x.json"))
        assertEquals("text/plain", AssetPaths.mimeType("web/licences/Unicode-3.0.txt"))
        assertEquals("utf-8", AssetPaths.encoding("web/app.js"))
        assertNull(AssetPaths.encoding("web/og-image.png"))
        assertNull(AssetPaths.encoding("web/x.wasm"))
        assertNull(AssetPaths.encoding("web/fonts/inter/Inter-Regular.woff2"))
    }

    /**
     * Stage 5: the privacy page, the disclaimer with its style sheet and the first-run notice are
     * bundled (WebAssets.INCLUDES) and served from the APK like the page itself, so the footer's
     * links work offline.
     */
    @Test fun theLegalPagesAndTheNoticeAreServedFromTheApk() {
        for (name in listOf("privacy.html", "disclaimer.html", "disclaimer.css", "gate.js", "gate.css")) {
            val path = AssetPaths.resolve(name)
            assertEquals("web/$name", path)
            assertEquals("utf-8", AssetPaths.encoding(path!!))
        }
        assertEquals("text/html", AssetPaths.mimeType("web/privacy.html"))
        assertEquals("text/html", AssetPaths.mimeType("web/disclaimer.html"))
        assertEquals("text/css", AssetPaths.mimeType("web/disclaimer.css"))
        assertEquals("text/css", AssetPaths.mimeType("web/gate.css"))
        assertEquals("text/javascript", AssetPaths.mimeType("web/gate.js"))
    }

    /** The build bundles only these types (WebAssets.ALLOWED_EXTENSIONS in app/build.gradle.kts). */
    @Test fun everyTypeTheBuildMayBundleIsServed() {
        val bundled = setOf("html", "js", "css", "svg", "png", "woff2", "md", "txt", "json", "wasm")
        assertTrue(AssetPaths.extensions.containsAll(bundled))
    }
}
