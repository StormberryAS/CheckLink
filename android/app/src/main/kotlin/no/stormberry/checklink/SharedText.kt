package no.stormberry.checklink

/**
 * Takes in the text another app shares with CheckLink (ACTION_SEND, text/plain,
 * EXTRA_TEXT). Pure Kotlin, unit tested.
 *
 * The text is untrusted: any app can send anything. A browser sends the page title and the
 * address; a messenger, a whole message with a link in it. So:
 *  - it is capped at [MAX_BYTES] bytes of UTF-8. When it is longer, the cut falls at the
 *    last line break, space or tab before the cap (never inside a link, which has none), or
 *    at the cap itself when there is none, and never inside a character;
 *  - control characters are taken out, except line feed and tab, which separate words;
 *    a carriage return becomes a line feed;
 *  - nothing else is touched. Invisible and direction-changing characters (zero-width
 *    spaces, right-to-left overrides) are kept on purpose: they are format characters, not
 *    control characters, and the page's analysis looks for them in an address and warns
 *    about them. Taking them out here would hide the very trick CheckLink exists to show.
 *
 * The result is handed to the page as text in a JSON message; the page only ever writes it
 * into its text box and analyses it, never as HTML.
 */
object SharedText {
    /** 8 KB, as the spec says. A shared title plus a long tracking link fits easily. */
    const val MAX_BYTES = 8 * 1024

    class Result(val text: String, val cut: Boolean)

    /** Null when nothing usable was shared (missing, empty, or only controls and spaces). */
    fun intake(raw: CharSequence?): Result? {
        if (raw == null) return null
        val cleaned = StringBuilder(minOf(raw.length, MAX_BYTES + 16))
        var i = 0
        while (i < raw.length) {
            val c = raw[i]
            when {
                c == '\r' -> {
                    // CR LF and a lone CR both become one LF.
                    cleaned.append('\n')
                    if (i + 1 < raw.length && raw[i + 1] == '\n') i++
                }
                c == '\n' || c == '\t' -> cleaned.append(c)
                Character.getType(c) == Character.CONTROL.toInt() -> Unit
                else -> cleaned.append(c)
            }
            // Far more than the cap can ever keep: stop reading a huge share early.
            if (cleaned.length > MAX_BYTES * 2) break
            i++
        }
        val (text, cut) = capUtf8(cleaned.toString())
        if (text.isBlank()) return null
        return Result(text, cut || i < raw.length)
    }

    /** The longest start of [s] within MAX_BYTES of UTF-8, cut at whitespace where possible. */
    private fun capUtf8(s: String): Pair<String, Boolean> {
        var bytes = 0
        var end = 0
        while (end < s.length) {
            val cp = s.codePointAt(end)
            val size = utf8Size(cp)
            if (bytes + size > MAX_BYTES) break
            bytes += size
            end += Character.charCount(cp)
        }
        if (end >= s.length) return s to false
        val head = s.substring(0, end)
        val space = head.indexOfLast { it == ' ' || it == '\n' || it == '\t' }
        val kept = if (space > 0) head.substring(0, space) else head
        return kept to true
    }

    private fun utf8Size(cp: Int): Int = when {
        cp < 0x80 -> 1
        cp < 0x800 -> 2
        cp < 0x10000 -> 3
        else -> 4
    }
}
