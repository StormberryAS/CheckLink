package no.stormberry.checklink

/**
 * The picture types the app takes in. Pure Kotlin, so it is unit tested on the JVM.
 *
 *  - SHARE_TYPES: what another app may share into CheckLink (the share filter in the
 *    manifest): PNG, JPEG and WebP, one at a time. HEIC and HEIF are not accepted, because
 *    the WebView cannot decode them.
 *  - PICK_TYPES: what the system file picker offers when the page's "Choose a picture of a
 *    QR code" is pressed: the page's own list (index.html, #pic-input accept) without HEIC
 *    and HEIF, for the same reason.
 */
object ImageTypes {
    /** MIME type to the extension the page sees on the file it is handed. */
    private val SHARE_EXTENSION = linkedMapOf(
        "image/png" to "png",
        "image/jpeg" to "jpg",
        "image/webp" to "webp",
    )

    /** Every extension recognised on the way in, to the MIME type it implies. */
    private val FROM_EXTENSION = mapOf(
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "jpe" to "image/jpeg",
        "webp" to "image/webp",
    )

    /** Declared in the manifest's share filter; keep the two in step. */
    val SHARE_TYPES: List<String> = SHARE_EXTENSION.keys.toList()

    /** Offered to the system file picker. */
    val PICK_TYPES: List<String> = listOf("image/png", "image/jpeg", "image/gif", "image/bmp", "image/webp", "image/avif")

    /** Lower-cases and strips parameters, so "Image/JPEG; q=1" becomes "image/jpeg". */
    fun normalise(mime: String?): String? {
        val m = mime?.substringBefore(';')?.trim()?.lowercase()
        if (m.isNullOrEmpty()) return null
        // Some galleries still send the never-registered image/jpg.
        return if (m == "image/jpg" || m == "image/pjpeg") "image/jpeg" else m
    }

    /** True for a type another app may share in. */
    fun isShareable(mime: String?): Boolean = normalise(mime) in SHARE_EXTENSION

    /** The extension for a shareable MIME type, or null. */
    fun extensionFor(mime: String?): String? = SHARE_EXTENSION[normalise(mime)]

    /** The MIME type a file name's extension implies, or null if it is not a shareable picture. */
    fun mimeForName(name: String?): String? {
        val ext = name?.substringAfterLast('.', "")?.lowercase().orEmpty()
        return FROM_EXTENSION[ext]
    }

    /**
     * The type to treat a shared file as. The provider's MIME type wins when it is one of
     * ours; a provider that names another picture type (HEIC, GIF) is believed and refused;
     * only a provider that says nothing useful (none, or application/octet-stream, which some
     * file managers report for every file) lets the name decide. Returns null when the file
     * is not a picture the app takes from a share.
     */
    fun resolveShared(reportedMime: String?, name: String?): String? {
        val m = normalise(reportedMime)
        if (m != null && m in SHARE_EXTENSION) return m
        if (m != null && m != "application/octet-stream") return null
        return mimeForName(name)
    }
}
