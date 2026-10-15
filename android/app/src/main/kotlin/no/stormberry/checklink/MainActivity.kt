package no.stormberry.checklink

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.graphics.createBitmap
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.io.encoding.Base64

/**
 * One screen: a WebView running the bundled web app, which is the same set of files that
 * check.stormberry.as serves. Kotlin adds only what a browser would otherwise provide, and
 * checks everything the page asks of it (OutgoingRequest, NavigationPolicy, CameraPermission):
 *  - the system file picker for "Choose a picture of a QR code";
 *  - text and pictures shared in from other apps (SEND text/plain, image/png, image/jpeg,
 *    image/webp), handed to the page, which analyses them as if pasted or chosen;
 *  - Copy (Android's clipboard), Share clean link (Android's share sheet, CheckLink left out)
 *    and Go to (the browser, on a tap only), through window.CLAndroid;
 *  - Save and Share for the picture of a QR code of the clean link (stage 4b): Android's save
 *    screen, and Android's share sheet with the picture alone, after PngCheck;
 *  - the camera for Scan with camera: video only, only for the app's own pages, Android's
 *    CAMERA permission asked on the first press, never at start-up;
 *  - FLAG_SECURE while the camera card or a secret is on screen, and, best effort, while a
 *    sign-in link or a link with personal details is (stage 4b, SEC-10).
 * The checking of links and codes happens in the page, exactly as on the website. The app
 * has no INTERNET permission, so nothing can leave the device whatever the page did.
 */
class MainActivity : ComponentActivity() {

    private lateinit var container: FrameLayout
    private var webView: WebView? = null
    private lateinit var assetLoader: WebViewAssetLoader

    private val main = Handler(Looper.getMainLooper())
    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    private var replyProxy: JavaScriptReplyProxy? = null
    private var bridgeSupported = false

    // File picking for the page's <input type="file">.
    private var pendingChooser: ValueCallback<Array<Uri>>? = null

    // A picture shared into the app, waiting for the page to pull it, and shared text waiting
    // for the page to say it has it.
    private var nextBatchId = 1
    private var incoming: IncomingBatch? = null
    private var pendingText: String? = null

    // The picture of a QR code on its way out (stage 4b): the transfer under way, and the file
    // waiting while Android's save screen is open (kept across a stop by Android, STATE_OUT_PATH).
    private lateinit var outgoingFiles: OutgoingFiles
    private var outTransfer: OutTransfer? = null
    private var pendingOut: File? = null
    private val outIdle = Runnable { onOutIdle() }

    // Scan with camera: the WebView's request waits here while Android asks the person.
    private var pendingCamera: PermissionRequest? = null
    private var askingCamera = false
    // True after a refusal when Android will not ask again ("Don't ask again", or refused
    // twice): the page then offers a button to Android's settings for CheckLink.
    private var cameraBlocked = false

    // FLAG_SECURE (SecureScreen): set while the page shows the camera or a secret.
    private val secure = SecureScreen()
    private var resumed = false

    // The last finger lifted or Enter-like key, for TapWindow (Go to on a tap only).
    private var lastInputAt = 0L

    private val pickOne = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        deliverChosen(uri?.let { arrayOf(it) })
    }
    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        onCameraAnswer(granted)
    }
    private val saveDocument = registerForActivityResult(ActivityResultContracts.CreateDocument(PngCheck.MIME)) { uri ->
        onSaveTarget(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val page = ContextCompat.getColor(this, R.color.page_background)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(page),
            navigationBarStyle = SystemBarStyle.dark(page),
        )
        super.onCreate(savedInstanceState)

        // A fresh start empties cache/outgoing/: whatever an earlier session left for saving or
        // sharing goes now. That includes a reopen from Recents with no saved state (the E1 rule
        // below), for example a card Android kept across a restart of the phone: nothing can be
        // waiting for a save screen then. A start FROM saved state keeps the folder: Android
        // may have stopped CheckLink while its save screen was open, and the picture waiting
        // for that screen's answer must still be there when it comes.
        outgoingFiles = OutgoingFiles(cacheDir)
        if (savedInstanceState == null) {
            io.execute { outgoingFiles.clear() }
        } else {
            restorePendingOut(savedInstanceState)
        }

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        assetLoader = WebViewAssetLoader.Builder()
            .setDomain(NavigationPolicy.ASSET_HOST)
            .setHttpAllowed(false)
            .addPathHandler("/", WebAssetHandler(assets, logMisses = debuggable))
            .build()

        // Debugging the page from a desktop browser is for debug builds only.
        WebView.setWebContentsDebuggingEnabled(debuggable)
        CookieManager.getInstance().setAcceptCookie(false)

        container = FrameLayout(this).apply { setBackgroundColor(page) }
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        createWebView()

        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) view.goBack() else finish()
            }
        })

        // A share is read once: not again on a rotation or a start from saved state, and not when
        // Android reopens CheckLink from Recents with the intent that first started its task (for
        // example a card Android kept across a restart of the phone). Since SEC-8
        // (autoRemoveFromRecents) Back takes the card out of Recents, so no reopen follows Back.
        val restored = savedInstanceState?.getBoolean(STATE_INTENT_HANDLED) == true
        if (IncomingPolicy.isNewShare(intent?.flags ?: 0, restored)) {
            handleShareIntent(intent)
        } else if (intent?.action == Intent.ACTION_SEND) {
            setIntent(Intent(Intent.ACTION_MAIN))
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        webView?.onResume()
        applySecure()
    }

    override fun onPause() {
        resumed = false
        // The page sees the WebView paused as a hidden page and turns the camera off at once
        // (spec section 5, step 4). Not while Android's own camera question is on screen:
        // that question pauses this activity too, and stopping then would throw away the very
        // camera the person is about to allow.
        if (!askingCamera) webView?.onPause()
        super.onPause()
    }

    override fun onStop() {
        // The second guard: the page is told to stop the camera even if it missed the pause.
        send(JSONObject().put("t", "camera-stop"))
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_INTENT_HANDLED, true)
        pendingOut?.let { outState.putString(STATE_OUT_PATH, it.absolutePath) }
    }

    override fun onDestroy() {
        pendingCamera?.deny()
        pendingCamera = null
        incoming?.close()
        abortOut()
        webView?.let { destroyWebView(it) }
        webView = null
        io.shutdown()
        super.onDestroy()
    }

    // A finger lifted from the screen is a "tap" for Go to. (A key that presses a button is
    // noted by the WebView's key listener in createWebView: androidx restricts overriding
    // dispatchKeyEvent here.)
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_UP) lastInputAt = SystemClock.uptimeMillis()
        return super.dispatchTouchEvent(ev)
    }

    // ---------------------------------------------------------------- WebView

    // SEC-7 (decided 11 October 2026: leave off): filterTouchesWhenObscured is not set. On Android 7
    // to 11 it also drops every tap while a screen dimmer, a blue-light filter or a chat head draws
    // over CheckLink, with no message, and a trick tap here can only press a button the person could
    // press anyway; CheckLink holds no account, money or password. Android 12 and later already
    // block taps through untrusted overlays.
    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val view = WebView(this)
        view.setBackgroundColor(ContextCompat.getColor(this, R.color.page_background))
        view.settings.apply {
            javaScriptEnabled = true
            // The first-run notice (gate.js) keeps its one flag here; the page stores nothing else.
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_NO_CACHE
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            // The default. The camera preview is a muted, inline video, which plays without a
            // press (spec section 5, step 6).
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = Client()
        view.webChromeClient = Chrome()
        // Enter, Space or a D-pad centre on a hardware keyboard or remote counts as a press for
        // Go to (TapWindow). The listener runs before the page gets the key and lets it through.
        view.setOnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_UP && keyCode in PRESS_KEYS) lastInputAt = SystemClock.uptimeMillis()
            false
        }

        bridgeSupported = false
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            bridgeSupported = true
            WebViewCompat.addWebMessageListener(
                view,
                BRIDGE_NAME,
                setOf(NavigationPolicy.ASSET_ORIGIN),
            ) { _, message, sourceOrigin, isMainFrame, proxy ->
                onBridgeMessage(message, sourceOrigin, isMainFrame, proxy)
            }
        }

        container.addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = view
        replyProxy = null
        view.loadUrl(START_URL)
        if (!bridgeSupported) toast(R.string.webview_too_old)
    }

    private fun destroyWebView(view: WebView) {
        container.removeView(view)
        view.stopLoading()
        view.destroy()
    }

    // onRenderProcessGone IS implemented below. The androidx.webkit lint check also fires
    // on any direct `WebViewClient()` constructor call, and in Kotlin the superclass call in
    // this class header is one, so the warning is a false positive here and only here.
    @SuppressLint("MissingOnRenderProcessGone")
    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url.toString()
            if (!NavigationPolicy.isAssetRequest(url)) return WebAssetHandler.forbidden()
            return assetLoader.shouldInterceptRequest(request.url) ?: WebAssetHandler.notFound()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // Leaving the app needs a press. A navigation the page starts on its own (a script
            // setting location, a meta refresh) without a recent press never opens the browser
            // or another app. hasGesture() is Chromium's user activation, so, as in any browser,
            // a navigation started within a few seconds of a real press counts as pressed even
            // when the press was elsewhere on the page; only a fault in the bundled page could
            // start one (its policy blocks any injected script). Go to itself goes through
            // CLAndroid.open, which the app checks again (OutgoingRequest, TapWindow).
            val userTapped = request.isForMainFrame && request.hasGesture()
            return when (NavigationPolicy.decide(request.url.toString())) {
                NavigationPolicy.Decision.IN_APP -> false
                NavigationPolicy.Decision.EXTERNAL -> {
                    if (userTapped) openInBrowser(request.url)
                    true
                }
                NavigationPolicy.Decision.EXTERNAL_APP -> {
                    if (userTapped) openInOtherApp(request.url)
                    true
                }
                NavigationPolicy.Decision.BLOCK -> true
            }
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            // The page's renderer died, usually from memory pressure on a very large
            // picture. Without this the whole app would be killed with it.
            if (view != null && view === webView) {
                webView = null
                destroyWebView(view)
                incoming?.close()
                incoming = null
                abortOut()
                pendingCamera?.deny()
                pendingCamera = null
                secure.reset()
                applySecure()
                createWebView()
                toast(R.string.page_crashed)
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = filePathCallback
            return try {
                // One picture, from the system picker only: no camera-app route (spec
                // section 5, "What this changes elsewhere"), so no capture folder exists.
                pickOne.launch(ImageTypes.PICK_TYPES.toTypedArray())
                true
            } catch (_: ActivityNotFoundException) {
                pendingChooser = null
                toast(R.string.no_app_for_files)
                false
            }
        }

        override fun onGeolocationPermissionsShowPrompt(
            origin: String?,
            callback: android.webkit.GeolocationPermissions.Callback,
        ) {
            callback.invoke(origin, false, false)
        }

        override fun onPermissionRequest(request: PermissionRequest) = onWebPermission(request)

        // While the camera starts, the WebView would draw its default poster (a grey picture
        // with a play button that does nothing) in the preview. A blank one instead.
        override fun getDefaultVideoPoster(): Bitmap = createBitmap(1, 1)

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingCamera === request) pendingCamera = null
        }
    }

    private fun deliverChosen(uris: Array<Uri>?) {
        val cb = pendingChooser ?: return
        pendingChooser = null
        cb.onReceiveValue(uris)
    }

    // Any failure to start the other app (none installed, one guarded by a permission
    // CheckLink lacks, an address too long to pass) is a short message, never a crash.
    private fun openInBrowser(uri: Uri): Boolean =
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
            true
        } catch (_: Exception) {
            toast(R.string.no_app_for_link)
            false
        }

    /**
     * mailto: goes to a mail app, nostr: to a Nostr client, as they would from a browser: a
     * nostr: link only to apps that accept being opened from a web link (BROWSABLE).
     */
    private fun openInOtherApp(uri: Uri) {
        val intent = if (uri.scheme.equals("mailto", ignoreCase = true)) {
            Intent(Intent.ACTION_SENDTO, uri)
        } else {
            Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        }
        try {
            startActivity(intent)
        } catch (_: Exception) {
            toast(R.string.no_app_for_link)
        }
    }

    // ---------------------------------------------------------------- camera

    /**
     * The page asked for a device (spec section 5, steps 1 to 3). CameraPermission decides
     * what may be granted at all: video capture for the app's own pages, and only while the
     * page has the window protected for the camera (FLAG_SECURE; never on a WebView without
     * the bridge), nothing else. If the app does not hold Android's CAMERA permission yet,
     * Android asks the person first; a refusal denies the page's request, which the page sees
     * as NotAllowedError.
     */
    private fun onWebPermission(request: PermissionRequest) {
        val decision = CameraPermission.decide(
            request.origin?.toString(),
            request.resources?.toList(),
            screenProtected = secure.holds(OutgoingRequest.Reason.CAMERA),
        )
        if (decision != CameraPermission.Decision.GRANT_VIDEO) {
            request.deny()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            cameraBlocked = false
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            return
        }
        pendingCamera?.deny()
        pendingCamera = request
        askingCamera = true
        try {
            askCamera.launch(Manifest.permission.CAMERA)
        } catch (_: Exception) {
            askingCamera = false
            pendingCamera = null
            request.deny()
        }
    }

    private fun onCameraAnswer(granted: Boolean) {
        askingCamera = false
        val request = pendingCamera
        pendingCamera = null
        if (granted) {
            cameraBlocked = false
            // Still protected? The page may have dropped the camera while Android asked.
            if (secure.holds(OutgoingRequest.Reason.CAMERA)) {
                request?.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
            } else {
                request?.deny()
            }
        } else {
            // Android shows its question again unless the person chose "Don't ask again" (or
            // refused twice on Android 11 and later); then only the settings page can allow it.
            cameraBlocked = !ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.CAMERA)
            request?.deny()
        }
    }

    // ---------------------------------------------------------------- FLAG_SECURE

    private fun applySecure() {
        when (secure.applyNow(resumed)) {
            true -> window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            false -> window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            null -> Unit // cleared in onResume, so the thumbnail taken on the way out keeps it
        }
    }

    // ---------------------------------------------------------------- bridge

    private fun onBridgeMessage(message: WebMessageCompat, origin: Uri, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) {
        // The listener is registered for the asset origin only; this is the second lock.
        if (!isMainFrame || !NavigationPolicy.isAssetOrigin(origin.toString())) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val msg = try {
            JSONObject(message.data ?: return)
        } catch (_: Exception) {
            return
        }
        replyProxy = proxy
        when (msg.opt("t")) {
            "hello" -> {
                // A (re)loaded page has nothing on show and nothing half-received, in either
                // direction. A picture waiting for the save screen stays: that screen answers
                // the app, not the page.
                secure.reset()
                applySecure()
                abortOut()
                incoming?.let { it.close(); announce(it) }
                pendingText?.let { sendSharedText(it) }
            }
            "out-begin" -> onOutBegin(msg)
            "out-chunk" -> onOutChunk(msg)
            "in-pull" -> onInPull(msg)
            "in-done" -> {
                val batch = incoming
                if (batch != null && batch.id == msg.optInt("batch")) {
                    batch.close()
                    incoming = null
                }
            }
            "text-done" -> pendingText = null
            else -> onRequest(msg)
        }
    }

    /**
     * copy, share, open, settings, secure and camera-state: checked by OutgoingRequest first.
     * secure covers 'link' too (SEC-10): the flag is set exactly as for the other reasons, but
     * only CAMERA lets the camera in (onWebPermission), and the page keeps the link on screen
     * whatever the answer.
     */
    private fun onRequest(msg: JSONObject) {
        val request = OutgoingRequest.parse(
            msg.opt("t"), msg.opt("id"),
            text = msg.opt("text"), sensitive = msg.opt("sensitive"), url = msg.opt("url"),
            reason = msg.opt("reason"), on = msg.opt("on"),
        ) ?: return
        when (request) {
            is OutgoingRequest.Copy -> reply(request.id, copyText(request.text, request.sensitive))
            is OutgoingRequest.Share -> reply(request.id, shareText(request.text))
            is OutgoingRequest.Open -> reply(request.id, openWeb(request.url))
            is OutgoingRequest.Settings -> reply(request.id, openAppSettings())
            is OutgoingRequest.Secure -> {
                secure.set(request.reason, request.on)
                applySecure()
                // Answered only once the flag is on the window, so the page shows a secret
                // only after it can no longer be captured.
                reply(request.id, true)
            }
            is OutgoingRequest.CameraState -> send(JSONObject().put("t", "reply").put("id", request.id).put("ok", true).put("blocked", cameraBlocked))
        }
    }

    private fun reply(id: Int, ok: Boolean) {
        send(JSONObject().put("t", "reply").put("id", id).put("ok", ok))
    }

    private fun send(obj: JSONObject) {
        val text = obj.toString()
        main.post {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) replyProxy?.postMessage(text)
        }
    }

    /**
     * Plain text on Android's clipboard. A secret (a Wi-Fi password, a 2FA seed, a sign-in
     * link) is marked sensitive, so Android 13 and later hide it in the clipboard preview and
     * keyboards keep it out of their suggestions. A link is copied without expiry: the point is
     * to paste it elsewhere.
     */
    private fun copyText(text: String, sensitive: Boolean): Boolean =
        try {
            val clipboard = getSystemService(ClipboardManager::class.java)
            if (clipboard == null) {
                false
            } else {
                val clip = ClipData.newPlainText(CLIP_LABEL, text)
                if (sensitive) clip.description.extras = PersistableBundle().apply { putBoolean(EXTRA_IS_SENSITIVE, true) }
                clipboard.setPrimaryClip(clip)
                true
            }
        } catch (_: Exception) {
            false
        }

    /** Android's share sheet with the text, CheckLink itself left out (sharing back in would only start over). */
    private fun shareText(text: String): Boolean {
        if (isFinishing || isDestroyed) return false
        return try {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
            val chooser = Intent.createChooser(send, getString(R.string.share_chooser))
            chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this, MainActivity::class.java)))
            startActivity(chooser)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Go to: the browser, only right after a real press (TapWindow), only an http or https address. */
    private fun openWeb(url: String): Boolean {
        val a11y = getSystemService(AccessibilityManager::class.java)?.isEnabled == true
        if (!TapWindow.allows(lastInputAt, SystemClock.uptimeMillis(), a11y)) return false
        if (isFinishing || isDestroyed) return false
        return openInBrowser(url.toUri())
    }

    private fun openAppSettings(): Boolean =
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            true
        } catch (_: Exception) {
            toast(R.string.no_settings)
            false
        }

    // ---- page to app: the picture of a QR code, for Save or Share (stage 4b)

    /**
     * The page announces the picture (android-bridge.js, saveImage and shareImage). Everything
     * in the message comes from JavaScript: OutgoingRequest checks the action, type, size and
     * chunk count, and there is no field for a name, an address or a path. One transfer at a
     * time; a new one replaces any left half done.
     */
    private fun onOutBegin(msg: JSONObject) {
        abortOut()
        val begin = OutgoingRequest.parseImageBegin(msg.opt("id"), msg.opt("action"), msg.opt("mime"), msg.opt("size"), msg.opt("chunks"))
        if (begin == null) {
            OutgoingRequest.validId(msg.opt("id"))?.let { sendOutEnd(it, false) }
            return
        }
        val transfer = OutTransfer(begin.id, begin.action, ChunkAssembler(begin.size, begin.chunks))
        outTransfer = transfer
        pull(transfer, 0)
    }

    private fun pull(transfer: OutTransfer, index: Int) {
        // The page gives up after 8 s without a message from the app; the app drops a transfer
        // whose page has gone quiet for longer than that, so nothing is kept for it.
        main.removeCallbacks(outIdle)
        main.postDelayed(outIdle, OUT_IDLE_MS)
        send(JSONObject().put("t", "out-pull").put("id", transfer.id).put("index", index))
    }

    private fun onOutChunk(msg: JSONObject) {
        val transfer = outTransfer ?: return
        if (OutgoingRequest.validId(msg.opt("id")) != transfer.id) return
        val assembler = transfer.assembler
        val index = msg.opt("index")
        val expected = assembler.next
        val bytes = if (expected != null && index == expected) {
            OutgoingRequest.decodeChunk(msg.opt("data"), assembler.expectedLength(expected))
        } else {
            null
        }
        if (expected == null || bytes == null) {
            abortOut()
            sendOutEnd(transfer.id, false)
            return
        }
        assembler.append(expected, bytes)
        assembler.next?.let { pull(transfer, it); return }
        main.removeCallbacks(outIdle)
        val png = assembler.finish()
        io.execute {
            // Checked BEFORE anything is written: only CheckLink's own picture of a code
            // (PngCheck) ever reaches the device's storage, the save screen or another app.
            val file = try {
                if (PngCheck.isQrPicture(png)) outgoingFiles.newFile().also { it.writeBytes(png) } else null
            } catch (_: Exception) {
                null
            }
            main.post {
                if (outTransfer !== transfer) {
                    file?.let { io.execute { outgoingFiles.delete(it) } }
                    return@post
                }
                outTransfer = null
                if (file == null) sendOutEnd(transfer.id, false) else finishOut(transfer, file)
            }
        }
    }

    /** The whole picture is here and checked: do exactly what the page's button asked. */
    private fun finishOut(transfer: OutTransfer, file: File) {
        val ok = when (transfer.action) {
            OutgoingRequest.ImageAction.SAVE -> startSave(file)
            OutgoingRequest.ImageAction.SHARE -> shareImage(file)
        }
        if (!ok) io.execute { outgoingFiles.delete(file) }
        sendOutEnd(transfer.id, ok)
    }

    private fun sendOutEnd(id: Int, ok: Boolean) {
        send(JSONObject().put("t", if (ok) "out-done" else "out-error").put("id", id).put("ok", ok))
    }

    /** Drops a transfer under way. Nothing was written for it: the picture is still in memory. */
    private fun abortOut() {
        main.removeCallbacks(outIdle)
        outTransfer = null
    }

    private fun onOutIdle() {
        val transfer = outTransfer ?: return
        abortOut()
        sendOutEnd(transfer.id, false)
    }

    /**
     * Android's save screen, suggesting qr-code.png. The page hears "done" as the screen opens;
     * the app itself says whether the picture was saved once it has been written (onSaveTarget),
     * because only then is it known. A cancelled screen says nothing.
     */
    private fun startSave(file: File): Boolean {
        if (isFinishing || isDestroyed) return false
        val earlier = pendingOut
        pendingOut = file
        return try {
            saveDocument.launch(OutgoingFiles.QR_FILE)
            // A save screen that never answered (it cannot be open now) leaves its picture behind.
            earlier?.let { io.execute { outgoingFiles.delete(it) } }
            true
        } catch (_: Exception) {
            pendingOut = earlier
            false
        }
    }

    /**
     * The document the save screen returned. What is written there, and what is removed after a
     * failure, is decided by [SaveTarget]: a file the person chose to replace is never deleted
     * unless CheckLink has opened it for writing (stage 4b review S4).
     */
    private fun onSaveTarget(target: Uri?) {
        val file = pendingOut
        pendingOut = null
        if (target == null) {
            file?.let { io.execute { outgoingFiles.delete(it) } }
            return
        }
        io.execute {
            // The picture is checked again: after a stop the file comes back from saved state, and
            // Android may have trimmed the cache meanwhile (file null or gone).
            val png = try {
                checkNotNull(file) { "gone" }
                check(file.isFile && outgoingFiles.owns(file) && file.length() <= OutgoingRequest.MAX_IMAGE_BYTES) { "gone" }
                file.readBytes().takeIf { PngCheck.isQrPicture(it) }
            } catch (_: Exception) {
                null
            }
            val ok = SaveTarget.save(documentAt(target), png)
            file?.let { outgoingFiles.delete(it) }
            main.post { toast(if (ok) R.string.qr_saved else R.string.qr_save_failed) }
        }
    }

    /** The save screen's document, as [SaveTarget] reads and writes it. */
    private fun documentAt(uri: Uri) = object : SaveTarget.Document {
        override fun open(mode: String): OutputStream? = contentResolver.openOutputStream(uri, mode)

        // The descriptor's own size first; a provider that serves a pipe has none, so then the size
        // it reports for the document.
        override fun size(): Long? =
            try {
                contentResolver.openFileDescriptor(uri, "r")?.use { pfd -> pfd.statSize.takeIf { it >= 0 } }
            } catch (_: Exception) {
                null
            } ?: try {
                contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                    val i = c.getColumnIndex(OpenableColumns.SIZE)
                    if (c.moveToFirst() && i >= 0 && !c.isNull(i)) c.getLong(i) else null
                }
            } catch (_: Exception) {
                null
            }

        override fun delete() {
            try {
                DocumentsContract.deleteDocument(contentResolver, uri)
            } catch (_: Exception) {
                // Some providers do not allow it; the file stays then.
            }
        }
    }

    /**
     * Android's share sheet with the picture alone: no text, no subject, a one-off read grant
     * for its address in CheckLink's FileProvider (not exported), its own title, and CheckLink
     * left out (sharing it back in would only start over).
     */
    private fun shareImage(file: File): Boolean {
        if (isFinishing || isDestroyed) return false
        return try {
            val uri = FileProvider.getUriForFile(this, OutgoingFiles.authority(packageName), file)
            val send = Intent(Intent.ACTION_SEND)
                .setType(PngCheck.MIME)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(OutgoingFiles.QR_FILE, uri)
            val chooser = Intent.createChooser(send, getString(R.string.share_qr_chooser))
            chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this, MainActivity::class.java)))
            startActivity(chooser)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun restorePendingOut(state: Bundle) {
        val path = state.getString(STATE_OUT_PATH) ?: return
        val file = File(path)
        if (file.name == OutgoingFiles.QR_FILE && file.isFile && outgoingFiles.owns(file)) pendingOut = file
    }

    // ---- app to page: what another app shares

    private fun handleShareIntent(intent: Intent?) {
        if (intent == null || intent.action != Intent.ACTION_SEND) return
        val type = ImageTypes.normalise(intent.type)
        // Consume it, so a configuration change or a re-delivered intent never reads it twice.
        setIntent(Intent(Intent.ACTION_MAIN))
        when {
            type == "text/plain" -> handleSharedText(intent)
            type != null && type.startsWith("image/") -> handleSharedPicture(intent)
        }
    }

    private fun handleSharedText(intent: Intent) {
        val raw = try {
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
        } catch (_: Exception) {
            null // a malformed extra from the sending app
        }
        intent.removeExtra(Intent.EXTRA_TEXT)
        val result = SharedText.intake(raw)
        if (result == null) {
            toast(R.string.shared_text_empty)
            return
        }
        if (result.cut) toast(R.string.shared_text_cut)
        pendingText = result.text
        sendSharedText(result.text)
    }

    private fun sendSharedText(text: String) {
        if (replyProxy == null) return // the page's "hello" will trigger it
        send(JSONObject().put("t", "shared-text").put("text", text))
    }

    private fun handleSharedPicture(intent: Intent) {
        val uri = sharedUri(intent) ?: return
        val resolver = contentResolver
        val own = IncomingPolicy.ownAuthorities(packageName)
        val batchId = nextBatchId++
        io.execute {
            var problem = 0
            var type: String? = null
            var size = -1L
            if (!IncomingPolicy.accept(uri.scheme, uri.authority, own)) {
                problem = R.string.shared_picture_type
            } else {
                var name: String? = null
                try {
                    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                        if (c.moveToFirst()) {
                            val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val s = c.getColumnIndex(OpenableColumns.SIZE)
                            if (n >= 0 && !c.isNull(n)) name = c.getString(n)
                            if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                        }
                    }
                } catch (_: Exception) {
                    // Some providers refuse the query; the name and size are optional.
                }
                val mime = try { resolver.getType(uri) } catch (_: Exception) { null }
                type = ImageTypes.resolveShared(mime ?: intent.type, name)
                problem = when {
                    type == null -> R.string.shared_picture_type
                    !IncomingPolicy.sizeAllowed(size) -> R.string.shared_picture_large
                    else -> 0
                }
            }
            main.post {
                val mime = type
                if (problem != 0 || mime == null) {
                    toast(if (problem != 0) problem else R.string.shared_picture_type)
                    return@post
                }
                incoming?.close()
                val batch = IncomingBatch(batchId, uri, mime, size)
                incoming = batch
                announce(batch)
            }
        }
    }

    private fun sharedUri(intent: Intent): Uri? {
        val extra = try {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        } catch (_: Exception) {
            null
        }
        if (extra != null) return extra
        val clip = intent.clipData ?: return null
        return if (clip.itemCount > 0) clip.getItemAt(0).uri else null
    }

    /** Tells the page a picture is waiting. The page pulls it once it is ready. */
    private fun announce(batch: IncomingBatch) {
        if (replyProxy == null) return // the page's "hello" will trigger it
        val files = JSONArray().put(JSONObject().put("mime", batch.mime).put("size", batch.size))
        send(JSONObject().put("t", "incoming").put("batch", batch.id).put("files", files))
    }

    private fun onInPull(msg: JSONObject) {
        val batch = incoming ?: return
        val batchId = msg.optInt("batch")
        if (batchId != batch.id) return
        val fileIndex = msg.optInt("file", -1)
        val index = msg.optInt("index", -1)
        val resolver = contentResolver
        io.execute {
            val reply = try {
                require(fileIndex == 0) { "one picture per share" }
                val chunk = batch.read(resolver, index)
                JSONObject().put("t", "in-chunk").put("batch", batchId).put("file", 0).put("index", index)
                    .put("data", Base64.encode(chunk.bytes)).put("last", chunk.last)
            } catch (_: Exception) {
                batch.close()
                main.post { toast(R.string.read_failed) }
                JSONObject().put("t", "in-error").put("batch", batchId).put("file", 0)
            }
            main.post { if (incoming === batch) send(reply) }
        }
    }

    private fun toast(res: Int) {
        Toast.makeText(this, res, Toast.LENGTH_LONG).show()
    }

    // ---------------------------------------------------------------- types

    /** The picture of a QR code the page is handing over, gathered in memory (ChunkAssembler). */
    private class OutTransfer(val id: Int, val action: OutgoingRequest.ImageAction, val assembler: ChunkAssembler)

    /** A shared picture, read one chunk at a time, in order, on the IO thread (ChunkReader). */
    private class IncomingBatch(val id: Int, val uri: Uri, val mime: String, val size: Long) {
        private var stream: InputStream? = null
        private var reader: ChunkReader? = null

        @Synchronized
        fun read(resolver: android.content.ContentResolver, index: Int): ChunkReader.Chunk {
            if (index == 0) {
                close()
                val s = resolver.openInputStream(uri) ?: throw IllegalStateException("no stream")
                stream = s
                reader = ChunkReader(s)
            }
            val r = reader ?: throw IllegalStateException("chunk $index asked before chunk 0")
            val chunk = r.read(index)
            if (chunk.last) close()
            return chunk
        }

        @Synchronized
        fun close() {
            try { stream?.close() } catch (_: Exception) {}
            stream = null
            reader = null
        }
    }

    companion object {
        private const val START_URL = "https://${NavigationPolicy.ASSET_HOST}/index.html"
        private const val BRIDGE_NAME = "CLBridge"
        private const val CLIP_LABEL = "CheckLink"
        // ClipDescription.EXTRA_IS_SENSITIVE (API 33), written out so older versions get the
        // same key, which some keyboards honour there too.
        private const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
        private const val STATE_INTENT_HANDLED = "intent_handled"
        private const val STATE_OUT_PATH = "out_path"

        // A little longer than the page's 8 s: by then the page has given up on the transfer.
        private const val OUT_IDLE_MS = 10_000L

        private val PRESS_KEYS = setOf(
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER, KeyEvent.KEYCODE_SPACE,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_BUTTON_A,
        )
    }
}
