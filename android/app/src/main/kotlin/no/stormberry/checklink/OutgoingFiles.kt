package no.stormberry.checklink

import java.io.File
import java.util.UUID

/**
 * The folder for the picture of a QR code on its way out (stage 4b): cache/outgoing/<random>/
 * qr-code.png. Each picture gets its own random folder, so a picture still waiting for Android's
 * save screen and one just shared never overwrite each other. Plain java.io, so it is unit
 * tested on the JVM.
 *
 * This is the only folder the app's FileProvider can hand out (res/xml/file_paths.xml). The
 * whole folder is emptied when the app starts fresh; a saved picture's own folder goes as soon
 * as it is written, and a shared one stays until the next fresh start, because the app it went
 * to may read it later. A start from saved state (Android stopped CheckLink while its save
 * screen was open) keeps the folder, so the picture waiting for that screen is still there.
 */
class OutgoingFiles(cacheDir: File) {
    val root: File = File(cacheDir, DIR)

    /** A new, empty file for [safeName] in its own random folder. */
    fun newFile(safeName: String = QR_FILE): File {
        require(safeName.isNotEmpty() && !safeName.contains('/') && !safeName.contains('\\') &&
            safeName != "." && safeName != "..") { "unsafe name" }
        val dir = File(root, UUID.randomUUID().toString())
        check(dir.mkdirs()) { "could not create $dir" }
        return File(dir, safeName)
    }

    /** True when [file] is inside the folder, so it is ours to read or hand out. */
    fun owns(file: File): Boolean {
        val r = root.canonicalFile
        var f: File? = file.canonicalFile.parentFile
        while (f != null) {
            if (f == r) return true
            f = f.parentFile
        }
        return false
    }

    /**
     * Deletes [file] and its own random folder, and nothing else. Returns false when the file
     * is not one of ours, in which case nothing is touched.
     */
    fun delete(file: File): Boolean {
        if (!owns(file)) return false
        val dir = file.canonicalFile.parentFile ?: return false
        // Only a direct child of the root is a per-file folder; never remove the root itself.
        if (dir.parentFile != root.canonicalFile) return false
        return dir.deleteRecursively()
    }

    /** Deletes everything in the folder. Returns how many files were removed. */
    fun clear(): Int {
        var n = 0
        root.listFiles()?.forEach { child ->
            child.walkBottomUp().forEach { if (it.isFile) n++; it.delete() }
        }
        return n
    }

    companion object {
        /** Must match the cache-path in res/xml/file_paths.xml. */
        const val DIR = "outgoing"

        /** The one file name the app writes (decision QR-6; QR_FILE in src/qr-make.js). */
        const val QR_FILE = "qr-code.png"

        /** The FileProvider's authority: "${applicationId}.outgoing" in AndroidManifest.xml. */
        fun authority(packageName: String): String = "$packageName.$DIR"
    }
}
