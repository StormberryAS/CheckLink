# R8 is on for release, and these are the reasons it is safe.
#
# 1. Nothing in this app is reached by reflection or from JavaScript by name. The page
#    talks to Kotlin through WebViewCompat.addWebMessageListener: the WebView injects a
#    `CLBridge` object whose only method is postMessage, and messages arrive in an
#    ordinary Kotlin callback. There is no @JavascriptInterface class, which is the usual
#    thing R8 strips from WebView apps.
# 2. androidx.webkit reaches the WebView APK through its support-library boundary
#    interfaces, and ships consumer rules that keep them. AGP keeps every class the
#    manifest names. CheckLink declares no content provider; androidx.startup adds its
#    InitializationProvider (not exported), which the merged manifest keeps.
# 3. The web app itself is in assets/, which R8 never touches.
#
# Obfuscation is off so stack traces from users stay readable; shrinking and
# optimisation still apply.
-dontobfuscate
