package no.stormberry.checklink

import android.content.Intent

/**
 * Which shares the app reads, and which shared pictures. Pure Kotlin, unit tested.
 *
 * Only content: URIs are read. A file: URI in a share intent is the classic way to trick an
 * app into reading its OWN private files and handing them to whoever sent the intent, so it
 * is refused outright. A content: URI from one of this app's own authorities is refused for
 * the same reason. CheckLink's own FileProvider (stage 4b: the picture of a QR code for Share,
 * authority <package>.outgoing) and the one androidx.startup adds (InitializationProvider,
 * authority <package>.androidx-startup) are both refused, so MainActivity passes them
 * ([ownAuthorities]). A provider added later must be listed there too.
 */
object IncomingPolicy {
    /** One picture per share, as the spec says: the page reads one picture at a time. */
    const val MAX_FILES = 1

    /**
     * Largest picture read from a share, in bytes. The same as MAX_PICTURE_BYTES in app.js,
     * which refuses anything bigger in any case, so nothing larger is ever handed over.
     */
    const val MAX_BYTES: Long = 40L * 1024 * 1024

    fun accept(scheme: String?, authority: String?, ownAuthorities: Set<String>): Boolean {
        if (scheme?.lowercase() != "content") return false
        val a = authority?.lowercase()
        if (a.isNullOrEmpty()) return false
        return ownAuthorities.none { it.equals(a, ignoreCase = true) }
    }

    /** False for a size the provider reports above the cap. An unknown size (-1) is read, and capped while reading. */
    fun sizeAllowed(reported: Long): Boolean = reported <= MAX_BYTES

    /** The content authorities this app's own manifest carries, for [accept]. */
    fun ownAuthorities(packageName: String): Set<String> =
        setOf("$packageName.androidx-startup", OutgoingFiles.authority(packageName))

    /**
     * Whether onCreate reads the intent that started the activity as a new share. Not when the
     * activity is recreated from saved state (a rotation, or a process Android stopped and
     * brought back), and not when Android reopens it from Recents
     * (FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) with the intent that first started its task, for
     * example a card Android kept across a restart of the phone: the old link or picture must
     * not be read again. Since SEC-8 (autoRemoveFromRecents="true" in the manifest) Back takes
     * the task out of Recents, so no reopen follows Back.
     */
    fun isNewShare(intentFlags: Int, restored: Boolean): Boolean =
        !restored && (intentFlags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
}
