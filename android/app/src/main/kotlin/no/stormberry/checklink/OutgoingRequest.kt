package no.stormberry.checklink

import kotlin.io.encoding.Base64

/**
 * Checks every request the page sends the app over the CLBridge channel before the app
 * acts on it. Pure Kotlin, unit tested.
 *
 * The page is the app's own bundled code, but the text it hands over (a clean link, a code's
 * contents) comes from links and QR codes nobody vouches for, so every field is checked for
 * type, size and shape, and anything unexpected is refused whole. The message fields arrive
 * as whatever org.json found (String, Boolean, Integer, JSONObject.NULL...); MainActivity
 * passes them in untouched, and only the exact types named here are accepted.
 *
 * The requests (android-bridge.js builds them; the full contract is in that file):
 *   copy      { id, text, sensitive? }  put plain text on Android's clipboard
 *   share     { id, text }              Android's share sheet with the text, CheckLink left out
 *   open      { id, url }               the address in the browser (Go to); http and https only
 *   settings  { id }                    Android's settings page for CheckLink
 *   secure    { id, reason, on }        the page starts or stops showing the camera, a secret or
 *                                       (stage 4b, SEC-10) a link with personal details
 *   camera-state { id }                 whether Android will still ask for the camera
 *   out-begin { id, action, mime, size, chunks }  (stage 4b) the picture of a QR code for Save
 *                                       or Share follows in chunks ([parseImageBegin])
 *   out-chunk { id, index, data }       one chunk of it, base64 ([decodeChunk])
 */
object OutgoingRequest {
    /** Far above any clean link (the page's box holds 20,000 characters) or code (a QR code holds at most 7,089). */
    const val MAX_TEXT_CHARS = 65_536

    /** An address as the browser writes it (URL.href), so even a 20,000-character link percent-encoded fits. */
    const val MAX_URL_CHARS = 200_000

    /**
     * Why the page wants the window kept out of screenshots. LINK (stage 4b, SEC-10) is best
     * effort and never stands in for the other two: the camera is granted only for CAMERA
     * (CameraPermission), and the page shows a secret only after SECRET is confirmed.
     */
    enum class Reason(val wire: String) { CAMERA("camera"), SECRET("secret"), LINK("link") }

    sealed interface Request { val id: Int }
    data class Copy(override val id: Int, val text: String, val sensitive: Boolean) : Request
    data class Share(override val id: Int, val text: String) : Request
    data class Open(override val id: Int, val url: String) : Request
    data class Settings(override val id: Int) : Request
    data class Secure(override val id: Int, val reason: Reason, val on: Boolean) : Request
    data class CameraState(override val id: Int) : Request

    /**
     * Returns the checked request, or null when the message must be ignored. [t] is the
     * message type; the other arguments are the raw field values, null when absent.
     */
    fun parse(
        t: Any?,
        id: Any?,
        text: Any? = null,
        sensitive: Any? = null,
        url: Any? = null,
        reason: Any? = null,
        on: Any? = null,
    ): Request? {
        val n = validId(id) ?: return null
        return when (t) {
            "copy" -> {
                val s = validText(text) ?: return null
                val flag = when (sensitive) {
                    null -> false
                    is Boolean -> sensitive
                    else -> return null
                }
                Copy(n, s, flag)
            }
            "share" -> Share(n, validText(text) ?: return null)
            "open" -> Open(n, validUrl(url) ?: return null)
            "settings" -> Settings(n)
            "secure" -> {
                val r = Reason.entries.firstOrNull { it.wire == reason } ?: return null
                if (on !is Boolean) return null
                Secure(n, r, on)
            }
            "camera-state" -> CameraState(n)
            else -> null
        }
    }

    // ---- the picture of a QR code (stage 4b, decisions QR-1 to QR-6)

    /**
     * What the page may do with the picture of a QR code: Android's save screen, or Android's
     * share sheet with the picture alone. There is no field for a name, an address or a path:
     * the app always names the file qr-code.png (OutgoingFiles.QR_FILE) and writes it into its
     * own cache/outgoing/ folder first.
     */
    enum class ImageAction(val wire: String) { SAVE("save-image"), SHARE("share-image") }

    /** An out-begin that passed every check: [size] bytes follow in [chunks] chunks. */
    data class ImageBegin(val id: Int, val action: ImageAction, val size: Int, val chunks: Int)

    /** The one type accepted: the PNG the page writes itself (src/qr-make.js, qrPng). */
    const val IMAGE_MIME = "image/png"

    /**
     * Largest picture accepted: twice the largest the page makes (126,073 bytes, version 25 at
     * 1,000 pixels a side). Must match MAX_IMAGE in android-bridge.js.
     */
    const val MAX_IMAGE_BYTES = 262_144

    /** Raw bytes per chunk. Must match CHUNK in android-bridge.js. */
    const val IMAGE_CHUNK_BYTES = 65_536

    /**
     * Checks an out-begin before a single byte is accepted. Every field comes from JavaScript:
     * the id is a positive whole number, the action one of two exact words, the type exactly
     * image/png, the size 1 to [MAX_IMAGE_BYTES] and the chunk count exactly the one that size
     * gives at [IMAGE_CHUNK_BYTES] a chunk. Anything else gives null and the page hears out-error.
     */
    fun parseImageBegin(id: Any?, action: Any?, mime: Any?, size: Any?, chunks: Any?): ImageBegin? {
        val n = validId(id) ?: return null
        val a = ImageAction.entries.firstOrNull { it.wire == action } ?: return null
        if (mime != IMAGE_MIME) return null
        val s = wholeNumber(size)?.takeIf { it in 1..MAX_IMAGE_BYTES } ?: return null
        val c = wholeNumber(chunks) ?: return null
        if (c != chunksFor(s)) return null
        return ImageBegin(n, a, s, c)
    }

    fun chunksFor(size: Int): Int = (size + IMAGE_CHUNK_BYTES - 1) / IMAGE_CHUNK_BYTES

    /**
     * The bytes of one out-chunk: [data] must be standard, padded base64 of exactly [expected]
     * bytes (a whole chunk, or what is left for the last one), with no space, line break or
     * other character. Anything else gives null.
     */
    fun decodeChunk(data: Any?, expected: Int): ByteArray? {
        if (data !is String || expected <= 0 || expected > IMAGE_CHUNK_BYTES) return null
        if (data.length != 4 * ((expected + 2) / 3)) return null
        val bytes = try {
            Base64.Default.decode(data)
        } catch (_: IllegalArgumentException) {
            return null
        }
        return bytes.takeIf { it.size == expected }
    }

    /** A whole number that fits an Int, as org.json reads a JavaScript number without a fraction. */
    private fun wholeNumber(x: Any?): Int? = when (x) {
        is Int -> x
        is Long -> x.takeIf { it in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() }?.toInt()
        else -> null
    }

    /** A positive whole number that fits an Int, as the bridge counts its requests. */
    fun validId(id: Any?): Int? = when (id) {
        is Int -> id.takeIf { it > 0 }
        is Long -> id.takeIf { it in 1..Int.MAX_VALUE.toLong() }?.toInt()
        else -> null
    }

    /**
     * Text to copy or share: a String of 1 to MAX_TEXT_CHARS characters, with no NUL and no
     * broken surrogate pair. Line breaks, tabs and any other character stay as they are, so
     * what lands on the clipboard is exactly what the page shows, as on the website.
     */
    fun validText(text: Any?): String? {
        if (text !is String) return null
        if (text.isEmpty() || text.length > MAX_TEXT_CHARS) return null
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '\u0000') return null
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= text.length || !Character.isLowSurrogate(text[i + 1])) return null
                i += 2
                continue
            }
            if (Character.isLowSurrogate(c)) return null
            i++
        }
        return text
    }

    /**
     * An address for Go to: the browser's own written form of it (the bridge sends
     * new URL(url).href), so it is plain printable ASCII with no space, and NavigationPolicy
     * must call it an http or https address on another host. Sign-in details before an @, a
     * missing host, the app's own origin and every other scheme are refused.
     */
    fun validUrl(url: Any?): String? {
        if (url !is String) return null
        if (url.isEmpty() || url.length > MAX_URL_CHARS) return null
        if (url.any { it.code < 0x21 || it.code > 0x7E }) return null
        val lower = url.lowercase()
        if (!lower.startsWith("https://") && !lower.startsWith("http://")) return null
        return url.takeIf { NavigationPolicy.isWebAddressToOpen(decisionForm(it)) }
    }

    private const val HEX = "0123456789ABCDEF"
    private const val LENIENT = "{}|^`\\[]\"<>"

    /**
     * The address in a form java.net.URI can read, for the decision only; the browser still
     * gets the address exactly as the page sent it. The browser's written form leaves a few
     * characters as they are after the host ({ } | ^ ` \ [ ] in a query, a % not followed by
     * two hex digits, a second # in the fragment) that java.net.URI refuses, which would wrongly refuse Go to for a real
     * link such as https://example.com/?a=1|2. Those are percent-encoded after the host; the
     * scheme and the host, which the decision is about, are left untouched.
     */
    fun decisionForm(url: String): String {
        val start = url.indexOf("://").takeIf { it >= 0 }?.plus(3) ?: return url
        val end = url.indexOfAny(charArrayOf('/', '?', '#'), start).let { if (it < 0) url.length else it }
        val out = StringBuilder(url.length + 16).append(url, 0, end)
        var i = end
        var inFragment = false
        while (i < url.length) {
            val c = url[i]
            val strayPercent = c == '%' && !(i + 2 < url.length && isHex(url[i + 1]) && isHex(url[i + 2]))
            // A fragment may hold a second #, which java.net.URI refuses.
            val laterHash = c == '#' && inFragment
            if (c == '#') inFragment = true
            if (c in LENIENT || strayPercent || laterHash) {
                out.append('%').append(HEX[c.code shr 4]).append(HEX[c.code and 0xF])
            } else {
                out.append(c)
            }
            i++
        }
        return out.toString()
    }

    private fun isHex(c: Char): Boolean = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'
}
