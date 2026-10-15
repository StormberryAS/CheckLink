package no.stormberry.checklink

import android.content.res.AssetManager
import android.util.Log
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the bundled web app from assets/web/ at https://appassets.androidplatform.net/.
 *
 * Registered at "/" rather than the usual "/assets/", because the page refers to some
 * files from the site root (the app switcher's /switcher-icons/...), exactly as it does on
 * check.stormberry.as. AssetPaths decides what may be served; anything else is a 404.
 *
 * Every answer carries ResponseHeaders.ALL, the full Content-Security-Policy included: the
 * decoder worker has no other source of a policy (see ResponseHeaders).
 *
 * [logMisses] is true in debug builds only: a path the page asked for that the APK does not
 * hold is written to logcat (tag CheckLinkAssets), so a test run on the emulator shows at once
 * when the list of bundled files is short. Only the path is logged, never a query string.
 */
class WebAssetHandler(
    private val assets: AssetManager,
    private val logMisses: Boolean = false,
) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse {
        val assetPath = AssetPaths.resolve(path) ?: return miss(path)
        val mime = AssetPaths.mimeType(assetPath) ?: return miss(path)
        return try {
            WebResourceResponse(mime, AssetPaths.encoding(assetPath), 200, "OK", ResponseHeaders.ALL, assets.open(assetPath))
        } catch (_: IOException) {
            miss(path)
        }
    }

    private fun miss(path: String): WebResourceResponse {
        if (logMisses) Log.w(TAG, "not in the APK: /$path")
        return notFound()
    }

    companion object {
        private const val TAG = "CheckLinkAssets"

        fun notFound(): WebResourceResponse = empty(404, "Not Found")

        /** The answer to every request outside the app's own origin. */
        fun forbidden(): WebResourceResponse = empty(403, "Forbidden")

        private fun empty(code: Int, reason: String) =
            WebResourceResponse("text/plain", "utf-8", code, reason, ResponseHeaders.ALL, ByteArrayInputStream(ByteArray(0)))
    }
}
