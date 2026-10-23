# CheckLink

A second look at links and QR codes, on your own device. CheckLink shows what a link holds before you share or open it: the parts that tell Google, Meta, Amazon and others about your click are marked in red, each with who learns it and what it tells. Untick anything you want to keep, and copy the clean link. It reads QR codes too, from a picture or the camera, and says in plain words what a code holds. It never opens the link it checks, and it never connects to anything.

CheckLink is a functioning prototype, published by Stormberry AS to show what it builds, so expect gaps and changes. It points out signs worth checking; it does not give a verdict on a link (see [What it cannot do](#what-it-cannot-do)).

**Android:** [CheckLink on Zapstore](https://zapstore.dev/apps/no.stormberry.checklink), or the APK from this repository's releases page (see [Android app](#android-app)). What changed in each release: [CHANGELOG.md](CHANGELOG.md).

## What it does

- **Paste, scan or share in.** Paste or type a link, or text with a link in it. Choose, drop or paste a picture of a QR code, or press **Scan with camera**. On Android, share a link or a picture into CheckLink from any app.
- **The full link, with its tracking parts marked.** Parts that are removed are red and struck through, so colour is not the only signal. Each one gets a line saying who learns it and what it tells, and whether it is unique to this click or the same for everyone who got the link.
- **You choose.** Ticked parts are removed from the clean link; untick one to keep it, for example an affiliate tag that pays someone you want to support. Parts the page needs, such as a YouTube start time or the size of a product, are kept and explained, with **Remove anyway**.
- **Signs worth checking.** Calm notes for an address disguised with a part before `@`, a bare number in place of a name, a name that looks like a known brand's, a short link whose destination CheckLink cannot see, an address hidden inside another, a link that is not encrypted, and more. "No warning signs found" is never presented as proof that a site is genuine.
- **QR codes in plain words.** A web address in a code gets the full link check. Wi-Fi networks, contacts, payment requests, app links and secrets (two-factor seeds, recovery phrases) are described. A secret, such as a Wi-Fi password, stays hidden until you press **Show**, and copying a two-factor seed or a recovery phrase asks first. Payment requests are shown, never paid.
- **Copy, Share and Go to.** Copy the clean link, share it, or open it in your browser with **Go to**, after a confirmation when there is something to check.
- **A QR code of the clean link.** **Make a QR code** draws one on your device, reads it back to check it, and lets you save or share the picture. It is not offered for links that should not travel as a code, such as short links, sign-in links and links with personal details.
- **Dated rules.** The rules are tables with a date (`rules/`), built into `src/rules.js` by `tools/build-rules.mjs`. The page shows the date in its footer as "Rules dated".

## What it cannot do

- **It removes only what its rules name.** A tracking part it does not know stays in the link.
- **It never opens a link,** so it cannot follow a short link or a redirect to see where it ends up. It says so when it finds one.
- **It cannot tell whether a site, a sender or an offer is genuine.** It points out signs worth checking, and a link with nothing to point out can still lead somewhere harmful.
- **Cleaning can break a link.** Every removal can be undone, and the original is always there.

The full terms are in [DISCLAIMER.md](DISCLAIMER.md).

## Privacy

- **On your device.** Links, text and pictures are read in the page, on your device. Nothing is sent anywhere, and there is no server side.
- **Enforced by the page's own policy.** `index.html` and `privacy.html` carry this Content Security Policy as the first element in `<head>`:

  ```
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self';
  font-src 'self'; connect-src 'none'; form-action 'none'; object-src 'none';
  base-uri 'none'; worker-src 'self'
  ```

  The page may load only its own files: `connect-src 'none'` blocks every connection its code could open (fetch, WebSocket and the like), and `form-action 'none'` every form submission. `'wasm-unsafe-eval'` lets the QR decoder (zxing-wasm, compiled to WebAssembly) run; it allows WebAssembly only, not `eval()`. The Android app sends the same policy, plus `frame-ancestors 'none'` and `upgrade-insecure-requests`, as a header on every file it serves to its page.
- **One thing stored.** Closing the first-run notice stores the time it was closed in `localStorage` (key `sb-gate:checklink:v2`), so that it does not show again. Nothing else: no cookies, no history.
- **The privacy page.** `privacy.html` says the same in plain words, and the app opens it offline from the footer, with the disclaimer.

## Android app

The Android app (package `no.stormberry.checklink`) runs the same files as the web page, bundled inside it, offline, in a WebView. Each `android-v*` tag runs the release workflow, which publishes `checklink-v<version>.apk` on this repository's releases page with a `.sha256` file and a build provenance attestation. The release is then listed on Zapstore.

### One permission: the camera

```bash
aapt dump permissions checklink-v0.0.2.apk
# package: no.stormberry.checklink
# uses-permission: name='android.permission.CAMERA'
```

The camera is used only for **Scan with camera**, and Android asks for it only when you press that button, never at start-up. Everything else works without it. The camera is declared as not required, so a phone or tablet without one can still install the app. The page gets the camera only for its own address, and only while the app keeps the screen out of screenshots and the recent-apps view.

There is no internet permission and no storage permission. Pictures come in through Android's file picker or a share, and the picture of a QR code goes out through Android's save screen or a share. Backup is off, and the WebView's usage statistics and Safe Browsing lookups are switched off.

If you turn off JIT (the fast compiler) for CheckLink, for example in GrapheneOS's Exploit protection settings, scanning still works, only more slowly.

### Verify a release

```bash
sha256sum -c checklink-v0.0.2.apk.sha256
apksigner verify --print-certs checklink-v0.0.2.apk
gh attestation verify checklink-v0.0.2.apk -R StormberryAS/CheckLink
```

**Signing certificate SHA-256:** `12dec5ac5eda5500ec233bd10f58515fd99d9a82480ed56445418b164f28a5d5`

The release workflow (`.github/workflows/android-release.yml`, started by `android-v*` tags only) builds the APK unsigned in a job that holds no key. A second job, which runs no Gradle, checks that APK before the key is decoded: exactly the permissions in `android/expected-permissions.txt`, the camera optional, not debuggable, the version the tag names, and every bundled web file byte for byte the tagged commit's. Only then does it align the APK and sign it with apksigner, and it refuses to publish unless there is exactly one signer, with the certificate above.

### Reproducible build

The build is reproducible: the same commit gives the same APK, byte for byte. To check a release against its tag, build it unsigned, sign it with a key of your own the way the workflow signs, and compare the two with their signatures taken out (`android/tools/apk-without-signature.py`):

```bash
git clone https://github.com/StormberryAS/CheckLink.git
cd CheckLink && git checkout android-v0.0.2
cd android && ./gradlew --no-daemon -PunsignedRelease=true :app:assembleRelease
BT="$ANDROID_HOME/build-tools/36.0.0"
"$BT/zipalign" -f 4 app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
keytool -genkeypair -keystore mine.p12 -storetype PKCS12 -alias mine -keyalg RSA -keysize 2048 -validity 1 -dname CN=mine
"$BT/apksigner" sign --ks mine.p12 --ks-key-alias mine \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --out mine.apk aligned.apk
python3 tools/apk-without-signature.py mine.apk
python3 tools/apk-without-signature.py /path/to/checklink-v0.0.2.apk
```

The two lines must show the same SHA-256. Sign with apksigner rather than only align: apksigner places some files a few bytes differently from zipalign, so an unsigned build does not compare directly. Use JDK 21, as the workflow does (Temurin 21).

### Build from source

Requirements: JDK 21 and the Android SDK with platform 37.1 and build-tools 36.0.0. From `android/`:

```bash
./gradlew :app:testDebugUnitTest :app:assembleDebug   # unit tests and a debug APK
./gradlew :app:verifyWebAssets                         # prove the bundled web files match
```

The app bundles an explicit list of web files (`WebAssets.INCLUDES` in `android/app/build.gradle.kts`): the page, its scripts and style sheets, the privacy page, the disclaimer and the first-run notice, the fonts, the carousel icons and the licence texts. Every build checks that each bundled file is byte for byte the one in this repository (apart from one line in `index.html` that loads `android/web-overlay/android-bridge.js`), that every file the page refers to is bundled, and that nothing else is. A release build also checks them against the commit `HEAD` points at. Repository files such as this README, `DISCLAIMER.md`, `fastlane/` and `zapstore.yaml` are never bundled.

A signed release needs the release key, which never enters this repository. The release workflow signs with apksigner from the `release` environment's secrets; `android/keystore.properties` (not committed) names the key for a local release build, and the passwords come from the environment.

Licences travel inside the APK: the web page's licence texts in `assets/web/licences/`, and under `assets/licences/` CheckLink's own MIT licence, the Apache License 2.0 and `THIRD-PARTY.txt`, which lists the AndroidX and Kotlin libraries the release build compiles in.

## The web page

The same files run in a browser. Serve the repository root over HTTP, because browsers do not run ES modules from `file://` addresses; `tests/serve.py` does that with the security headers the page is built for:

```bash
python3 tests/serve.py --port 8000
```

The web page does not register itself as a share target (the Web Share Target API). Its simple form would send the shared link to the server in the page's address, and its private form needs a service worker, a background script that sees every request the page makes. On Android, share into the app instead.

## Tests

You need Node 24 or later, Python 3, Chromium and `openssl`; LibreWolf for its own smoke test. From the repository root:

```bash
node --test tests/                          # the engine, the rules, the decoder and the static checks
node tests/ui-smoke.mjs --out /tmp/cl-ui     # the interface in headless Chromium
node tests/e2e.mjs --out /tmp/cl-e2e         # end to end over HTTPS, with the page's headers
node tests/librewolf-smoke.mjs              # pictures, the camera and the QR code in LibreWolf
node tests/app-mode-smoke.mjs               # the page as the Android app loads it
python3 bump_assets.py --check              # cache stamps current
node tools/build-rules.mjs --check          # src/rules.js current with rules/
node tools/vendor.mjs --check               # vendored files match tools/upstream.lock.json
node tools/brands.mjs --check               # the brand list current
```

And for the app, from `android/`: `./gradlew :app:testDebugUnitTest :app:lintDebug :app:lintRelease`.

Local CSS and JavaScript addresses carry a content hash, so browsers pick up changes: run `python3 bump_assets.py` after editing any of them.

## Type checking

The JavaScript is checked as it is by the TypeScript compiler: the types live in JSDoc comments, the page and the app still get plain JavaScript with no build step, and the compiler writes nothing (`noEmit`). You need Node and npm. From the repository root:

```bash
npm ci --ignore-scripts && npm run typecheck
```

- `jsconfig.json` checks the page (`app.js` and `src/`) with the browser's page types, and `jsconfig.worker.json` the decoder worker (`src/qr-worker.js`, `src/worker-lockdown.js`, `src/qr-decode.js`) with the worker's. Both are `strict`.
- Vendored code (`vendor/`, `third_party/`) is not checked. Both configurations use `noResolve`, so the compiler reads only the files they list; `types/qrcodegen.d.ts` and `types/zxing-wasm.d.ts` describe the two vendored modules as the page uses them, and `types/page.d.ts` the Android app's bridge and the few browser extras the page asks for. `gate.js` is left out too: the shared `build-gates.py` writes it.
- The page imports its modules with a content stamp (`./src/link-core.js?v=...`), which the compiler cannot follow. `npm run typecheck` first runs `tools/typecheck-stamps.mjs`, which writes `types/stamps.d.ts` and `types/stamps.worker.d.ts` from the stamps `bump_assets.py` wrote.
- `package.json`, `package-lock.json` (TypeScript 6.0.3 and nothing else), `node_modules/`, the two configurations and `types/` are never published (`_config.yml`) and never bundled into the app (`APK_EXCLUDES` in `android/app/build.gradle.kts`).
## Generated files

- `gate.js` and `gate.css` (the first-run notice), and `disclaimer.html` and `disclaimer.css` (rendered from `DISCLAIMER.md`), are written by Stormberry's shared generators, `build-gates.py` and `build-disclaimers.py`, which keep the notice and the disclaimer the same across the Labs apps. Do not edit these four by hand.
- `src/rules.js` comes from `rules/` (`tools/build-rules.mjs`), `src/brands.js` from `rules/brands.json` (`tools/brands.mjs`), and `src/psl.js`, `src/bip39.js`, `src/wordlists.js` and `src/confusables.js` from `third_party/` (`tools/vendor.mjs`).
- `favicon.svg` is the icon's source. `android/tools/make_icons.py` writes the launcher icon from it, and `android/tools/build-store-icon.py` the store icon in `fastlane/`.

## Credits

Built by [Stormberry AS](https://stormberry.as). Proudly powered by sovereign AI agents.

## Disclaimer

Supplied free of charge, **as is**, with no warranty of any kind. Using it creates no client or advisory relationship with Stormberry AS, and nothing it produces is professional advice.

**It is a second look, not a verdict.** CheckLink removes only the tracking parts its rules name and points out signs worth checking. It cannot see where a short link ends up, and it cannot tell whether a site is genuine.

This is a **functioning prototype**, not a certified instrument and not a professional service. Stormberry AS reimburses no cost or loss arising from use of this application.

Full terms: [DISCLAIMER.md](DISCLAIMER.md).

## Licence

Published under the MIT licence, see `LICENSE`. Third-party notices are in `NOTICE`: the QR decoder (zxing-wasm), the QR code generator, the Public Suffix List, the recovery-phrase word lists, Unicode's look-alike data and the Inter typeface. Their licence texts are in `licences/`, which ships with the page and with the app.
