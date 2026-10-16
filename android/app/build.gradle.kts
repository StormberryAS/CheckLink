import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.util.Properties
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
}

// Signing credentials never live in this repo. android/keystore.properties (gitignored)
// names the key file, its type and the alias, and deliberately holds NO passwords: those
// come from the RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD Gradle properties, which
// Gradle also reads from ORG_GRADLE_PROJECT_* env vars (CI) and which a local build passes
// as env vars read from the keyring. Missing credentials must not break assembleDebug, so
// everything below is optional.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) FileInputStream(keystorePropertiesFile).use { load(it) }
}

fun signingValue(propKey: String, gradleKey: String): String? =
    keystoreProperties.getProperty(propKey)
        ?: providers.gradleProperty(gradleKey).orNull
        ?: providers.environmentVariable(gradleKey).orNull

val releaseStoreFile = signingValue("storeFile", "RELEASE_STORE_FILE")
val releaseStoreType = signingValue("storeType", "RELEASE_STORE_TYPE")
val releaseStorePassword = signingValue("storePassword", "RELEASE_STORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "RELEASE_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "RELEASE_KEY_PASSWORD")
val canSignRelease = releaseStoreFile != null && file(releaseStoreFile).exists() &&
    releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null

// SEC-6 (stage 4b): the release workflow builds the release APK UNSIGNED, in a job that never
// sees the key or its passwords, and a separate job that runs no Gradle signs it with Google's
// apksigner. That unsigned APK is asked for explicitly with -PunsignedRelease=true. Without the
// switch, a release task that would produce an unsigned APK still fails (below); with it, a
// build that has a signing password in reach fails here, so a signed and an unsigned build can
// never be mixed up, and the switch can never be used next to the key by mistake.
val unsignedRelease = providers.gradleProperty("unsignedRelease").orNull == "true"
if (unsignedRelease && (releaseStorePassword != null || releaseKeyPassword != null)) {
    error(
        "-PunsignedRelease=true builds the release unsigned, for CI's separate signing job; " +
            "unset RELEASE_STORE_PASSWORD and RELEASE_KEY_PASSWORD first.",
    )
}

// The passwords are read while Gradle configures the build, and gradle.properties turns the
// configuration cache on. A cached configuration stores those values (encrypted) under
// android/.gradle/configuration-cache, which breaks the rule that the password is never
// written anywhere. So the build refuses to configure, before any cache entry exists,
// whenever a password is set and the cache is in use.
abstract class BuildFeaturesHolder @Inject constructor(val features: org.gradle.api.configuration.BuildFeatures)

val configurationCacheRequested =
    objects.newInstance<BuildFeaturesHolder>().features.configurationCache.requested.getOrElse(false)
if (configurationCacheRequested && (releaseStorePassword != null || releaseKeyPassword != null)) {
    error(
        "Signing passwords are set, so this build must run with " +
            "--no-configuration-cache; otherwise Gradle would store them in its configuration cache.",
    )
}

// Guards on the RESOLVED TASK GRAPH, not on the command line, because the command line lies:
// `build`, `assemble` and Gradle's `bR` abbreviation reach a release artefact without
// containing "bundleRelease" or "assembleRelease". packageRelease (APK) and signReleaseBundle
// (AAB) are the two tasks that consume a signing config, so the checks belong on them.
//
// CheckLink v1 ships APKs only (Zapstore and GitHub Releases); Google Play is out of scope,
// so unlike the template app there is no Play build and no Play upload key. A release bundle
// would carry this app's ID signed with the release key, and uploading it anywhere would
// enrol the release certificate where it must never go, so bundles are refused outright. A
// release task that would silently produce an UNSIGNED apk is refused too: an
// app-release-unsigned.apk next to a signed one from an earlier run is exactly the kind of
// mix-up that ends with the wrong file uploaded. The one exception is the explicit
// -PunsignedRelease=true above, for CI (SEC-6): AGP then names the file
// app-release-unsigned.apk, and only the signing job's apksigner makes it a release.
tasks.matching { it.name == "packageRelease" || it.name == "signReleaseBundle" }.configureEach {
    val isBundle = name == "signReleaseBundle"
    val signed = canSignRelease
    val unsigned = unsignedRelease
    // An input, so dropping the switch reruns the task and the check below, instead of
    // leaving the APK of an earlier unsigned build in place as "up to date".
    inputs.property("unsignedRelease", unsigned)
    doFirst {
        if (isBundle) {
            error(
                "Refusing to build a release bundle. CheckLink ships APKs only (Zapstore and " +
                    "GitHub Releases); Google Play is not part of version 1, and a bundle signed " +
                    "with the release key must never exist.",
            )
        }
        if (!signed && !unsigned) {
            error(
                "Release signing is not configured. Set RELEASE_STORE_PASSWORD and " +
                    "RELEASE_KEY_PASSWORD (see android/keystore.properties) for a local release, " +
                    "or pass -PunsignedRelease=true for CI's unsigned build, which its signing " +
                    "job signs with apksigner. Use assembleDebug for a test build.",
            )
        }
    }
}

android {
    namespace = "no.stormberry.checklink"
    // compileSdk 37.1 because androidx core-ktx 1.19.0 requires compiling against API 37 or
    // later. targetSdk stays at 36; the two are deliberately independent.
    compileSdk = 37
    compileSdkMinor = 1

    defaultConfig {
        // Permanent from the first Zapstore release.
        applicationId = "no.stormberry.checklink"
        minSdk = 24
        targetSdk = 36
        // 0.0.1 (code 1): the first Android build (stage 4, 11 October 2026): the web app
        // bundled byte for byte, share in (text and pictures), Copy, Share clean link and Go to
        // through the app, Scan with camera with the one CAMERA permission. Not released yet.
        versionCode = 1
        versionName = "0.0.1"

        // Density PNGs generated from vectors are a source of build nondeterminism, and the
        // app ships vector icons only.
        vectorDrawables.generatedDensities()
    }

    signingConfigs {
        if (canSignRelease) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                if (releaseStoreType != null) storeType = releaseStoreType
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                // Pinned explicitly so an AGP upgrade cannot change what the APK carries.
                // minSdk 24 makes v1 JAR signing dead weight; v2 covers 7.0+, v3 allows key
                // rotation later.
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = false
            }
        }
    }

    buildTypes {
        release {
            // R8 is on. The app reaches nothing by reflection itself: the page talks to
            // Kotlin through WebViewCompat.addWebMessageListener, so there is no
            // @JavascriptInterface class for R8 to strip, and androidx.webkit ships its own
            // consumer keep rules for the WebView boundary interfaces. See proguard-rules.pro.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Conditional so a clean checkout can still assembleDebug, and never in CI's
            // unsigned build (SEC-6), which can hold no key in any case.
            if (canSignRelease && !unsignedRelease) signingConfig = signingConfigs.getByName("release")
            // No META-INF/version-control-info.textproto. The gradle.properties switch alone
            // did not stop AGP writing it, and once AGP finds the repository it would carry
            // the commit hash, which differs per checkout.
            vcsInfo {
                include = false
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = false
        resValues = false
        shaders = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources {
            excludes += setOf(
                "/META-INF/{AL2.0,LGPL2.1}",
                "DebugProbesKt.bin",
                "kotlin-tooling-metadata.json",
            )
        }
    }

    androidResources {
        // The fonts are already compressed (woff2) and the page reads every file through
        // the asset loader; leaving them stored keeps the copy byte-identical and cheap to open.
        noCompress += listOf("woff2", "png")
    }

    dependenciesInfo {
        // Strips the encrypted, non-reproducible dependency blob from the APK.
        includeInApk = false
        includeInBundle = false
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        disable += setOf(
            // Version bumps are a deliberate, reviewed act, not something lint should fail on.
            "GradleDependency",
            "AndroidGradlePluginVersion",
            "ObsoleteLintCustomCheck",
            "NewerVersionAvailable",
            // targetSdk 36 is intentional; compileSdk is already 37.1.
            "OldTargetApi",
        )
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

kotlin {
    // The JDK that compiles is pinned to 21, the one the release workflow installs, so a
    // rebuild from a tag uses the same compiler. Bytecode stays at 17.
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// =====================================================================================
// THE WEB APP, COPIED AT BUILD TIME
//
// The APK runs the same files that GitHub Pages serves at check.stormberry.as. They are
// never committed twice: this task copies them from the repository root into generated
// assets on every build, then a check task proves the copy is byte-identical to its source.
// The ONE permitted difference is a single line in index.html that loads
// android-bridge.js (android/web-overlay/) before the app module.
//
// WHICH files: an explicit list (WebAssets.INCLUDES), taken from what the page actually
// loads, not "everything in the folder". The repository lives in a synced notes vault, where
// a pasted screenshot, a note or a sync-conflict copy can appear next to the web files at any
// time, and CheckLink is not under git yet (stage 5), so git cannot vouch for the folder.
// Two checks prove the list is right on every build:
//   * missingReferences: every local file any copied page, style sheet or script refers to
//     (HTML src/href, CSS url(), JS import, export from, import(), and the decoder worker's
//     new URL(..., import.meta.url)) was copied;
//   * unreferencedFiles: every copied file is reached from index.html through those same
//     references, except the licence texts in licences/, which ship for their own sake.
// A stray file inside src/ or vendor/ therefore fails the build instead of reaching the APK.
//
// Logic lives in an `object` so the task actions capture no reference to this script,
// which keeps the configuration cache working.
// =====================================================================================

object WebAssets {
    const val INJECTED_TAG = "<script src=\"android-bridge.js\"></script>"
    const val BRIDGE_FILE = "android-bridge.js"

    // What the app bundles, as Ant patterns relative to the repository root. Derived from
    // index.html, app.js and the decoder worker (src/qr-worker.js); checked by the two
    // reference checks above and by loading the app on the emulator.
    //   index.html, app.js, style.css  the page, its module and its style sheet
    //   favicon.svg                    the page's icon and the picture beside the title
    //   src/**/*.js                    the engine, the QR inspector, the decoder worker and
    //                                  (stage 4b) qr-make.js, which makes a QR code of the
    //                                  clean link and its PNG
    //   vendor/**/*.js                 zxing-wasm 3.1.4: reader, shared code and the .wasm as
    //                                  a JavaScript module (no .wasm file is needed); and
    //                                  (stage 4b) Nayuki's QR Code generator, converted to
    //                                  JavaScript (vendor/qrcodegen-8329a71/qrcodegen.js)
    //   fonts/**/*.css, *.woff2        Inter, self-hosted
    //   switcher-icons/*.svg           the footer carousel, referenced from the site root
    //   licences/*.txt                 every third-party licence NOTICE names
    //   privacy.html, disclaimer.html, the privacy page and the disclaimer, linked from the
    //   disclaimer.css                 footer and opened offline inside the app; the disclaimer
    //                                  and its style sheet are generated by build-disclaimers.py
    //   gate.js, gate.css              the first-run notice, generated by build-gates.py
    // Deliberately left out, though Pages publishes them: robots.txt (no meaning in an
    // app), og-image.png (only for link previews of the website), vendor/zxing-wasm-3.1.4/LICENSE
    // (the same text ships as licences/zxing-wasm-MIT.txt). rules/, tools/, tests/ and
    // third_party/ are not part of the website at all (_config.yml), and neither are
    // DISCLAIMER.md (the source of disclaimer.html), README.md and the store files.
    val INCLUDES = listOf(
        "index.html", "app.js", "style.css", "favicon.svg",
        "privacy.html", "disclaimer.html", "disclaimer.css", "gate.js", "gate.css",
        "src/**/*.js", "vendor/**/*.js",
        "fonts/**/*.css", "fonts/**/*.woff2",
        "switcher-icons/*.svg",
        "licences/*.txt",
    )

    /** Copied files that need no reference from the page: the licence texts. */
    fun shippedForItsOwnSake(rel: String): Boolean = rel.startsWith("licences/") && rel.endsWith(".txt")

    // Every type the asset loader in the app knows how to serve (AssetPaths.TYPES). Anything
    // else among the included files fails the build, so a stray file cannot slip into the APK
    // unnoticed.
    val ALLOWED_EXTENSIONS = setOf("html", "js", "css", "svg", "png", "woff2", "md", "txt", "json", "wasm")

    // Jekyll never publishes these, whatever _config.yml says, and neither does the APK.
    val JEKYLL_DEFAULT_EXCLUDES = listOf("**/.*", "**/.*/**", "**/_*", "**/_*/**", "**/#*", "**/*~")

    // Repository files that are never part of the web app, as a second fence around the
    // include list: the Android project, the store files (fastlane/, zapstore.yaml), the
    // repository's own documents (README.md, DISCLAIMER.md, LICENSE, NOTICE; the app carries its
    // licence texts under assets/licences/ instead), the website's own files (CNAME, robots.txt,
    // og-image.png, _config.yml) and the tooling, including the type checking's (package.json,
    // package-lock.json, node_modules/, jsconfig.json, jsconfig.worker.json and types/, none of
    // which the page reads). Store files added later cannot change the APK.
    val APK_EXCLUDES = listOf(
        "android/**", "fastlane/**", "tests/**", "tools/**", "rules/**", "third_party/**", ".github/**",
        "zapstore.yaml", "README*", "DISCLAIMER.md", "LICENSE", "NOTICE", "CNAME", "robots.txt",
        "og-image.png", "_config.yml", "bump_assets.py", "package.json", "package-lock.json",
        "**/__pycache__/**", "**/*.pyc", "**/*.bak*", "**/.DS_Store", "**/*sync-conflict*", "node_modules/**",
        "jsconfig.json", "jsconfig.worker.json", "types/**",
    )

    /** Runs git in [dir]; returns its exit code and standard output. */
    fun gitRun(dir: File, vararg args: String): Pair<Int, ByteArray> {
        val process = try {
            ProcessBuilder(listOf("git", "-C", dir.path) + args).start()
        } catch (e: java.io.IOException) {
            error("git is needed to build the app, because the bundled web files are checked against the repository: ${e.message}")
        }
        process.outputStream.close()
        val errReader = Thread { process.errorStream.readBytes() }.apply { start() }
        val out = process.inputStream.readBytes()
        val code = process.waitFor()
        errReader.join()
        return code to out
    }

    /** Runs git in [dir] and returns its standard output; fails with the exit code. */
    fun git(dir: File, vararg args: String): ByteArray {
        val (code, out) = gitRun(dir, *args)
        if (code != 0) error("git ${args.joinToString(" ")} failed (exit $code)")
        return out
    }

    /** True when [root] is inside a git work tree. */
    fun inGitRepository(root: File): Boolean {
        val (code, out) = gitRun(root, "rev-parse", "--is-inside-work-tree")
        return code == 0 && String(out, Charsets.UTF_8).trim() == "true"
    }

    /** True on a CI runner, where the web root must always be a git checkout. */
    fun onCi(): Boolean =
        System.getenv("CI").equals("true", ignoreCase = true) || System.getenv("GITHUB_ACTIONS").equals("true", ignoreCase = true)

    /** Every path git tracks under [root], relative to it, with forward slashes. */
    fun trackedFiles(root: File): Set<String> =
        String(git(root, "ls-files", "-z", "--cached", "--", "."), Charsets.UTF_8)
            .split('\u0000').filter { it.isNotEmpty() }.toSet()

    /** The bytes of [rel] in the commit HEAD points at, or null if HEAD has no such file. */
    fun committedBytes(root: File, rel: String): ByteArray? {
        val spec = "HEAD:./$rel" // ./ makes the path relative to the web root, not the repository top
        val (code, typeOut) = gitRun(root, "cat-file", "-t", spec)
        if (code != 0 || String(typeOut, Charsets.UTF_8).trim() != "blob") return null
        return git(root, "cat-file", "blob", spec)
    }

    /** True when [rel] or any folder on the way to it under [root] is a symbolic link. */
    fun throughSymlink(root: File, rel: String): Boolean {
        var f = root
        for (part in rel.split('/')) {
            f = File(f, part)
            if (Files.isSymbolicLink(f.toPath())) return true
        }
        return false
    }

    /**
     * The copied index.html with the injected line taken out again, or a description of
     * what is wrong with the injection.
     */
    fun removeInjected(text: String): Result<String> {
        val count = Regex(Regex.escape(INJECTED_TAG)).findAll(text).count()
        if (count != 1) return Result.failure(IllegalStateException("expected the bridge tag exactly once, found $count"))
        val at = text.indexOf(INJECTED_TAG)
        val lineStart = text.lastIndexOf('\n', at) + 1
        val lineEnd = text.indexOf('\n', at)
        if (lineEnd < 0 || text.substring(lineStart, at).isNotBlank() ||
            text.substring(at + INJECTED_TAG.length, lineEnd).isNotEmpty()
        ) {
            return Result.failure(IllegalStateException("the bridge tag is not alone on its own line"))
        }
        return Result.success(text.substring(0, lineStart) + text.substring(lineEnd + 1))
    }

    /** Inserts the bridge tag on its own line directly before the first script tag. */
    fun inject(source: String): String {
        val first = source.indexOf("<script")
        require(first >= 0) { "index.html has no <script> tag to inject the Android bridge before" }
        require(!source.contains(BRIDGE_FILE)) { "index.html already mentions $BRIDGE_FILE" }
        val lineStart = source.lastIndexOf('\n', first) + 1
        val indent = source.substring(lineStart, first)
        require(indent.isBlank()) { "the first <script> in index.html does not start its own line" }
        return source.substring(0, lineStart) + indent + INJECTED_TAG + "\n" + source.substring(lineStart)
    }

    private val HTML_REF = Regex("""(?:src|href)\s*=\s*"([^"]*)"""")
    private val CSS_REF = Regex("""url\(\s*['"]?([^'")]+)['"]?\s*\)""")
    private val JS_FROM = Regex("""(?:^|[;\s])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]""")
    private val JS_BARE = Regex("""(?:^|[;\s])import\s*['"]([^'"]+)['"]""")
    private val JS_DYNAMIC = Regex("""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")
    // The decoder worker: new Worker(new URL('./src/qr-worker.js?v=...', import.meta.url)).
    private val JS_URL = Regex("""new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)""")

    private val SCHEME = Regex("^[a-z][a-z0-9+.-]*:")

    /** Not a file of the site: a fragment, a protocol-relative address or any scheme
     *  (https:, mailto:, nostr:, data:, and node: built-ins the engine imports only under Node). */
    private fun isExternal(ref: String): Boolean {
        val r = ref.trim().lowercase()
        return r.isEmpty() || r.startsWith("#") || r.startsWith("//") || SCHEME.containsMatchIn(r)
    }

    /** Resolves [ref] found in [from] (path relative to the web root) to a web-root path. */
    private fun resolve(from: String, ref: String): String {
        val clean = ref.substringBefore('#').substringBefore('?')
        val base = if (clean.startsWith("/")) "" else from.substringBeforeLast('/', "")
        val parts = mutableListOf<String>()
        (if (base.isEmpty()) clean else "$base/$clean").split('/').forEach {
            when (it) {
                "", "." -> Unit
                ".." -> require(parts.isNotEmpty()) { "$from references $ref, which climbs out of the web root" }
                    .also { parts.removeAt(parts.size - 1) }
                else -> parts += it
            }
        }
        val joined = parts.joinToString("/")
        return if (joined.isEmpty() || clean.endsWith("/")) (if (joined.isEmpty()) "" else "$joined/") + "index.html" else joined
    }

    /** The local files [rel] (a copied page, style sheet or script) refers to, resolved. */
    private fun references(webDir: File, rel: String, problems: MutableSet<String>): List<String> {
        val f = File(webDir, rel)
        val text = when (f.extension) { "html", "css", "js" -> f.readText() else -> return emptyList() }
        val refs = mutableListOf<String>()
        if (f.extension == "html" || f.extension == "js") {
            HTML_REF.findAll(text).forEach { refs += it.groupValues[1] }
        }
        if (f.extension == "html" || f.extension == "css") {
            CSS_REF.findAll(text).forEach { refs += it.groupValues[1] }
        }
        if (f.extension == "js") {
            listOf(JS_FROM, JS_BARE, JS_DYNAMIC, JS_URL).forEach { re -> re.findAll(text).forEach { refs += it.groupValues[1] } }
        }
        val out = mutableListOf<String>()
        for (ref in refs) {
            if (isExternal(ref)) continue
            if (f.extension == "js" && !(ref.startsWith("./") || ref.startsWith("../") || ref.startsWith("/") ||
                    ref.endsWith(".html"))) {
                problems += "$rel: bare module specifier '$ref' (there is no bundler)"
                continue
            }
            out += resolve(rel, ref)
        }
        return out
    }

    /** Every local file the copied site references, checked against what was copied. */
    fun missingReferences(webDir: File): List<String> {
        val missing = sortedSetOf<String>()
        webDir.walkTopDown().filter { it.isFile }.forEach { f ->
            val rel = f.relativeTo(webDir).invariantSeparatorsPath
            for (target in references(webDir, rel, missing)) {
                if (!File(webDir, target).isFile) missing += "$rel references $target, which was not copied"
            }
        }
        return missing.toList()
    }

    /** Copied files that nothing reaches from index.html (licence texts apart). */
    fun unreferencedFiles(webDir: File): List<String> {
        val reached = mutableSetOf<String>()
        val queue = ArrayDeque(listOf("index.html", BRIDGE_FILE))
        val ignored = mutableSetOf<String>()
        while (queue.isNotEmpty()) {
            val rel = queue.removeFirst()
            if (!reached.add(rel) || !File(webDir, rel).isFile) continue
            references(webDir, rel, ignored).forEach { queue.addLast(it) }
        }
        return webDir.walkTopDown().filter { it.isFile }
            .map { it.relativeTo(webDir).invariantSeparatorsPath }
            .filter { it !in reached && !shippedForItsOwnSake(it) }
            .sorted().toList()
    }
}

val webRootDir: File = rootProject.projectDir.parentFile
val webOverlayDir: File = rootProject.file("web-overlay")
val webAssetsOutDir = layout.buildDirectory.dir("generated/webAssets")
val webSourceTree = fileTree(webRootDir) {
    include(WebAssets.INCLUDES)
    exclude(WebAssets.JEKYLL_DEFAULT_EXCLUDES + WebAssets.APK_EXCLUDES)
}

// Once the repository is under git, the website is what git holds, not whatever sits in
// this folder: each bundled file must be tracked and must not come in through a symbolic
// link. CheckLink is not under git yet (stage 5 runs git init), so outside a git work tree
// this check only refuses symbolic links and says plainly that git could not vouch for the
// files; the include list and the two reference checks still fence the copy. On a CI runner
// the web root must be a git checkout, and the build fails otherwise. (It has no outputs, so
// Gradle never skips it as up to date.)
abstract class CheckWebSourcesTracked : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty
}

val checkWebSourcesTracked = tasks.register<CheckWebSourcesTracked>("checkWebSourcesTracked") {
    description = "Fails unless every web file the APK would bundle is tracked by git (once the repository is under git) and is not a symbolic link."
    group = "verification"
    sources.from(webSourceTree)
    webRoot.set(webRootDir)
    doLast {
        val root = webRoot.get().asFile
        val problems = mutableListOf<String>()
        val inGit = WebAssets.inGitRepository(root)
        if (!inGit && WebAssets.onCi()) {
            error("The web root is not a git checkout, so the bundled web files cannot be checked against the repository.")
        }
        val tracked = if (inGit) WebAssets.trackedFiles(root) else emptySet()
        for (f in sources.files) {
            val rel = f.relativeTo(root).invariantSeparatorsPath
            if (WebAssets.throughSymlink(root, rel)) problems += "symbolic link: $rel"
            else if (inGit && rel !in tracked) problems += "not tracked by git: $rel"
        }
        if (problems.isNotEmpty()) {
            error(
                "These files in the web root would be bundled into the APK, but they are not part " +
                    "of the website git holds. Commit them, remove them or exclude them:\n  " +
                    problems.sorted().joinToString("\n  "),
            )
        }
        if (!inGit) {
            logger.warn(
                "checkWebSourcesTracked: ${root.path} is not a git work tree yet, so git could not vouch " +
                    "for the ${sources.files.size} web files. They are limited to WebAssets.INCLUDES and " +
                    "proven by the reference checks in prepareWebAssets.",
            )
        }
    }
}

abstract class PrepareWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val overlay: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:Internal
    abstract val overlayRoot: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val prepareWebAssets = tasks.register<PrepareWebAssets>("prepareWebAssets") {
    description = "Copies the web app from the repository root into generated assets and injects the Android bridge."
    group = "build"
    sources.from(webSourceTree)
    overlay.from(webOverlayDir)
    webRoot.set(webRootDir)
    overlayRoot.set(webOverlayDir)
    outputDir.set(webAssetsOutDir)
    dependsOn(checkWebSourcesTracked)
    doLast {
        val root = webRoot.get().asFile
        val out = outputDir.get().asFile.resolve("web")
        outputDir.get().asFile.deleteRecursively()
        out.mkdirs()
        val unexpected = mutableListOf<String>()
        val files = sources.files.sortedBy { it.relativeTo(root).invariantSeparatorsPath }
        for (src in files) {
            val rel = src.relativeTo(root).invariantSeparatorsPath
            if (src.extension.lowercase() !in WebAssets.ALLOWED_EXTENSIONS) {
                unexpected += rel
                continue
            }
            val dest = out.resolve(rel)
            dest.parentFile.mkdirs()
            if (rel == "index.html") {
                dest.writeText(WebAssets.inject(src.readText()))
            } else {
                src.copyTo(dest, overwrite = false)
            }
        }
        if (unexpected.isNotEmpty()) {
            error(
                "These files match the web include list but have a type the app does not serve, so " +
                    "they would break or bloat the APK. Remove them or narrow WebAssets.INCLUDES:\n  " +
                    unexpected.joinToString("\n  "),
            )
        }
        val bridge = overlayRoot.get().asFile.resolve(WebAssets.BRIDGE_FILE)
        require(bridge.isFile) { "missing ${bridge.path}" }
        val bridgeDest = out.resolve(WebAssets.BRIDGE_FILE)
        require(!bridgeDest.exists()) { "${WebAssets.BRIDGE_FILE} collides with a file of the web app" }
        bridge.copyTo(bridgeDest)

        require(out.resolve("index.html").isFile) { "index.html was not copied; is the web root right? ($root)" }
        val missing = WebAssets.missingReferences(out)
        if (missing.isNotEmpty()) {
            error(
                "The copied web app references files that were not copied. Add them to " +
                    "WebAssets.INCLUDES:\n  " + missing.joinToString("\n  "),
            )
        }
        val stray = WebAssets.unreferencedFiles(out)
        if (stray.isNotEmpty()) {
            error(
                "These copied files are not reached from index.html, so the app does not need " +
                    "them. Remove them from the web root or narrow WebAssets.INCLUDES:\n  " +
                    stray.joinToString("\n  "),
            )
        }
    }
}

abstract class VerifyWebAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val webRoot: DirectoryProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val bridgeSource: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val copied: DirectoryProperty

    @get:OutputFile
    abstract val report: RegularFileProperty
}

val verifyWebAssets = tasks.register<VerifyWebAssets>("verifyWebAssets") {
    description = "Asserts every bundled web file is byte-identical to its source, except the one injected line in index.html."
    group = "verification"
    sources.from(webSourceTree)
    webRoot.set(webRootDir)
    bridgeSource.set(webOverlayDir.resolve(WebAssets.BRIDGE_FILE))
    copied.set(prepareWebAssets.flatMap { it.outputDir })
    report.set(layout.buildDirectory.file("reports/webAssets/verify.txt"))
    doLast {
        val root = webRoot.get().asFile
        val web = copied.get().asFile.resolve("web")
        val problems = mutableListOf<String>()
        val expected = sources.files.associateBy { it.relativeTo(root).invariantSeparatorsPath }
        val actual = web.walkTopDown().filter { it.isFile }.associateBy { it.relativeTo(web).invariantSeparatorsPath }

        val extra = actual.keys - expected.keys - WebAssets.BRIDGE_FILE
        val absent = expected.keys - actual.keys
        extra.sorted().forEach { problems += "in the APK copy but not in the web root: $it" }
        absent.sorted().forEach { problems += "in the web root but missing from the APK copy: $it" }

        val lines = StringBuilder()
        for ((rel, src) in expected.toSortedMap()) {
            val dst = actual[rel] ?: continue
            if (rel == "index.html") {
                val s = src.readBytes()
                val text = String(dst.readBytes(), Charsets.UTF_8)
                val restored = WebAssets.removeInjected(text).getOrElse {
                    problems += "index.html: ${it.message}"
                    continue
                }
                val at = text.indexOf(WebAssets.INJECTED_TAG)
                if (!restored.toByteArray(Charsets.UTF_8).contentEquals(s)) {
                    problems += "index.html: differs from its source by more than the injected line"
                }
                // The bridge must run before the app module and before the first-run notice
                // (gate.js), so the website-only parts are hidden before anything paints and
                // window.CLAndroid exists when app.js starts.
                val module = text.indexOf("type=\"module\"")
                val gate = text.indexOf("src=\"gate.js")
                if (module < 0 || gate < 0 || at > module || at > gate) {
                    problems += "index.html: the bridge must load before gate.js and the app module"
                }
                lines.append("MODIFIED  ").append(rel).append(" (one injected line, otherwise identical)\n")
            } else if (!src.readBytes().contentEquals(dst.readBytes())) {
                problems += "$rel: bytes differ from the source"
            } else {
                lines.append("IDENTICAL ").append(rel).append('\n')
            }
        }
        val bridge = actual[WebAssets.BRIDGE_FILE]
        if (bridge == null || !bridge.readBytes().contentEquals(bridgeSource.get().asFile.readBytes())) {
            problems += "${WebAssets.BRIDGE_FILE}: missing from the copy or differs from android/web-overlay"
        } else {
            lines.append("ADDED     ").append(WebAssets.BRIDGE_FILE).append(" (android/web-overlay)\n")
        }
        if (problems.isNotEmpty()) {
            error("Bundled web app does not match its source:\n  " + problems.joinToString("\n  "))
        }
        val out = report.get().asFile
        out.parentFile.mkdirs()
        out.writeText(lines.toString())
        logger.lifecycle("verifyWebAssets: ${expected.size - 1} web files byte-identical to source, index.html identical apart from the one injected line, android-bridge.js added")
    }
}

// A RELEASE goes one step further: every bundled web file must equal the copy in the
// commit HEAD points at, so a signed APK can only carry what GitHub Pages serves from that
// commit. An uncommitted edit to app.js or src/*.js passes a debug build (useful while
// working on the page) but stops a release. index.html is compared after the injected line
// is taken out again; android-bridge.js is Android code and is not part of the website.
// Until stage 5's git init there is no commit to compare with: outside a git work tree the
// check says so and passes (a local release build of 0.0.1 for testing), and on a CI runner
// it fails.
abstract class VerifyWebAssetsCommitted : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val copied: DirectoryProperty

    @get:Internal
    abstract val webRoot: DirectoryProperty
}

val verifyWebAssetsCommitted = tasks.register<VerifyWebAssetsCommitted>("verifyWebAssetsCommitted") {
    description = "Asserts every bundled web file equals the committed copy at HEAD (release builds)."
    group = "verification"
    copied.set(prepareWebAssets.flatMap { it.outputDir })
    webRoot.set(webRootDir)
    doLast {
        val root = webRoot.get().asFile
        if (!WebAssets.inGitRepository(root)) {
            if (WebAssets.onCi()) error("The web root is not a git checkout, so a release cannot be checked against a commit.")
            logger.warn(
                "verifyWebAssetsCommitted: SKIPPED, ${root.path} is not a git work tree yet, so there is no " +
                    "commit to compare the bundled web files with. This APK is fit for testing only; a release " +
                    "for users is built by CI from a tagged commit.",
            )
            return@doLast
        }
        val web = copied.get().asFile.resolve("web")
        val problems = mutableListOf<String>()
        var count = 0
        web.walkTopDown().filter { it.isFile }.sortedBy { it.path }.forEach { f ->
            val rel = f.relativeTo(web).invariantSeparatorsPath
            if (rel == WebAssets.BRIDGE_FILE) return@forEach
            val committed = WebAssets.committedBytes(root, rel)
            if (committed == null) {
                problems += "$rel: not in the commit HEAD points at"
                return@forEach
            }
            val bundled = if (rel == "index.html") {
                WebAssets.removeInjected(String(f.readBytes(), Charsets.UTF_8)).getOrElse {
                    problems += "index.html: ${it.message}"
                    return@forEach
                }.toByteArray(Charsets.UTF_8)
            } else {
                f.readBytes()
            }
            if (!bundled.contentEquals(committed)) problems += "$rel: differs from the committed copy (uncommitted change?)"
            count++
        }
        if (problems.isNotEmpty()) {
            error(
                "A release must bundle exactly the committed website. Commit or revert these " +
                    "first:\n  " + problems.joinToString("\n  "),
            )
        }
        logger.lifecycle("verifyWebAssetsCommitted: $count web files equal the committed copies at HEAD")
    }
}

// Licences. The web app's own licence texts (licences/*.txt: zxing-wasm and everything
// compiled into its .wasm, the QR Code generator, the Public Suffix List, the word lists,
// Unicode, Inter) travel
// inside the bundled web copy, at assets/web/licences/, byte-identical to the website's, so
// the byte-identity checks above cover them. What only the app adds lives outside
// assets/web/, under assets/licences/: the Apache-2.0 text for the AndroidX and Kotlin
// libraries (android/licences/), CheckLink's own MIT licence copied from LICENSE at build
// time, and THIRD-PARTY.txt, which lists both. The list of bundled libraries is taken from
// what the release build actually resolves, and the build fails on a library whose licence
// is not accounted for, and on a licence file NOTICE names that the web copy lacks.
object Licences {
    // Every one of these groups publishes its artefacts under Apache-2.0.
    val APACHE_GROUPS = listOf("androidx.", "org.jetbrains.kotlin", "org.jetbrains.kotlinx", "org.jspecify", "com.google.guava")

    fun isApache(group: String): Boolean =
        APACHE_GROUPS.any { if (it.endsWith(".")) group.startsWith(it) else group == it || group.startsWith("$it.") } ||
            group == "org.jetbrains"

    /** The licence files NOTICE names, as "licences/<name>.txt". */
    fun namedInNotice(notice: String): Set<String> =
        Regex("""licences/[A-Za-z0-9._-]+\.txt""").findAll(notice).map { it.value }.toSortedSet()
}

abstract class PrepareLicenceAssets : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val texts: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val appLicence: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val notice: RegularFileProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val webCopy: DirectoryProperty

    @get:Input
    abstract val modules: ListProperty<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty
}

val licenceAssetsOutDir = layout.buildDirectory.dir("generated/licenceAssets")

val prepareLicenceAssets = tasks.register<PrepareLicenceAssets>("prepareLicenceAssets") {
    description = "Puts the app's own and the bundled Android libraries' licence texts into assets/licences/, and checks NOTICE's licences are in the web copy."
    group = "build"
    texts.from(rootProject.fileTree("licences"))
    appLicence.set(webRootDir.resolve("LICENSE"))
    notice.set(webRootDir.resolve("NOTICE"))
    webCopy.set(prepareWebAssets.flatMap { it.outputDir })
    outputDir.set(licenceAssetsOutDir)
    doLast {
        val out = outputDir.get().asFile.resolve("licences")
        outputDir.get().asFile.deleteRecursively()
        out.mkdirs()
        texts.files.sortedBy { it.name }.forEach { it.copyTo(out.resolve(it.name)) }
        appLicence.get().asFile.copyTo(out.resolve("CheckLink-MIT.txt"))

        // Every licence NOTICE names must be inside the APK, in the web copy's licences/.
        val web = webCopy.get().asFile.resolve("web")
        val named = Licences.namedInNotice(notice.get().asFile.readText())
        require(named.isNotEmpty()) { "NOTICE names no licences/*.txt file; has its format changed?" }
        val lacking = named.filter { !web.resolve(it).isFile }
        if (lacking.isNotEmpty()) {
            error("NOTICE names licence texts the APK would not carry:\n  " + lacking.joinToString("\n  "))
        }
        val webLicences = web.resolve("licences").listFiles()?.filter { it.isFile }?.map { it.name }?.sorted().orEmpty()

        val mods = modules.get()
        val unknown = mods.filter { !Licences.isApache(it.substringBefore(':')) }
        if (unknown.isNotEmpty()) {
            error(
                "These bundled libraries have no licence on record in assets/licences/. Check " +
                    "their licences and extend Licences in app/build.gradle.kts:\n  " + unknown.joinToString("\n  "),
            )
        }
        require(mods.isNotEmpty()) { "the release runtime classpath resolved to no libraries" }
        out.resolve("THIRD-PARTY.txt").writeText(
            buildString {
                append("CheckLink for Android: third-party components\n\n")
                append("The bundled web app (assets/web/, the same files check.stormberry.as serves)\n")
                append("ships the licence texts of everything third-party it contains in\n")
                append("assets/web/licences/: the zxing-wasm QR decoder and what is compiled into it,\n")
                append("the QR Code generator that makes a QR code of the clean link, the Public\n")
                append("Suffix List, the recovery-phrase word lists, Unicode's look-alike character\n")
                append("data and the Inter typeface. The repository's NOTICE file says which text\n")
                append("belongs to which component:\n\n")
                webLicences.forEach { append("  web/licences/").append(it).append('\n') }
                append("\nThe Android app's release build depends on the libraries below, all licensed\n")
                append("under the Apache License, Version 2.0, full text in Apache-2.0.txt. R8 leaves\n")
                append("out the parts the app does not use, so some of them add no code at all.\n\n")
                mods.forEach { append("  ").append(it).append('\n') }
                append("\nCheckLink itself: MIT licence, in CheckLink-MIT.txt.\n")
            },
        )
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(prepareWebAssets, PrepareWebAssets::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(prepareLicenceAssets, PrepareLicenceAssets::outputDir)
        if (variant.name == "release") {
            val resolved = variant.runtimeConfiguration.incoming.resolutionResult.rootComponent.map { rootComponent ->
                val seen = sortedSetOf<String>()
                val queue = ArrayDeque(listOf(rootComponent))
                val visited = mutableSetOf<org.gradle.api.artifacts.component.ComponentIdentifier>()
                while (queue.isNotEmpty()) {
                    val c = queue.removeFirst()
                    if (!visited.add(c.id)) continue
                    (c.id as? org.gradle.api.artifacts.component.ModuleComponentIdentifier)?.let {
                        seen += "${it.group}:${it.module}:${it.version}"
                    }
                    c.dependencies.filterIsInstance<org.gradle.api.artifacts.result.ResolvedDependencyResult>()
                        .forEach { queue.addLast(it.selected) }
                }
                seen.toList()
            }
            prepareLicenceAssets.configure { modules.set(resolved) }
        }
    }
}

// Every build that produces an APK proves the copy first, and so does `check`. A release
// also proves the copy matches the committed website.
tasks.named("preBuild") { dependsOn(verifyWebAssets) }
tasks.named("check") { dependsOn(verifyWebAssets) }
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn(verifyWebAssetsCommitted) }

dependencies {
    testImplementation(libs.junit)

    implementation(libs.androidx.activity)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.webkit)
}
