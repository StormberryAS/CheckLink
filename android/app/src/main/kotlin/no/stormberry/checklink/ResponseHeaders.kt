package no.stormberry.checklink

/**
 * The headers on every response the asset loader gives the WebView: pages, scripts, the
 * decoder worker and its imports, style sheets, fonts, licence texts, and the empty 403 and
 * 404 answers. Pure Kotlin, unit tested.
 *
 * WebViewAssetLoader sends no headers of its own. A page still has its meta policy, but a
 * Web Worker never reads the page's meta tag: it takes its Content-Security-Policy from its
 * own response only. Without a header here the decoder worker inside the APK would run with
 * no policy at all. So every response carries the full policy that NOTICE recommends for
 * check.stormberry.as (section "Deploy-time headers"): the page's meta policy plus
 * frame-ancestors 'none' and upgrade-insecure-requests, which a meta tag cannot carry. The
 * worker then keeps connect-src 'none', as on the website, and may compile its WebAssembly
 * ('wasm-unsafe-eval') but never eval a string. tests/android-app.test.mjs checks that this
 * string equals NOTICE's, character for character.
 *
 * upgrade-insecure-requests is kept although it changes nothing in the app: every file comes
 * from https://appassets.androidplatform.net, the loader refuses plain http
 * (setHttpAllowed(false)), and the directive never touches navigations to other sites. It
 * stays so that the APK and the website run under one and the same policy string.
 *
 * There is deliberately NO Permissions-Policy header. Without one the camera's default
 * applies, which is the page itself, so Scan with camera can ask for it. Never add one with
 * camera=() here: it would switch the camera off for the app's own page.
 */
object ResponseHeaders {
    const val CONTENT_SECURITY_POLICY =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; " +
            "font-src 'self'; connect-src 'none'; worker-src 'self'; form-action 'none'; object-src 'none'; " +
            "base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests"

    /** The same map for every response, success or refusal. */
    val ALL: Map<String, String> = mapOf(
        "Content-Security-Policy" to CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options" to "nosniff",
        "Cache-Control" to "no-store",
        "Referrer-Policy" to "no-referrer",
    )
}
