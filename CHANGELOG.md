# Changelog

Every released version of CheckLink for Android, newest first. Each release's store note
(`fastlane/metadata/android/en-US/changelogs/<versionCode>.txt`) names the main updates and links
here. The APK, its `.sha256` file and its build provenance attestation are on the
[releases page](https://github.com/StormberryAS/CheckLink/releases). Every release is signed with
the same key, certificate SHA-256 `12dec5ac5eda5500ec233bd10f58515fd99d9a82480ed56445418b164f28a5d5`.

## 0.0.2 (versionCode 2)

A maintenance release. How CheckLink works does not change: still one permission, the camera, used
only while you scan, and no internet access.

- **QR code reader:** zxing-wasm moves from 3.1.4 to 3.1.6. It brings zxing-cpp `2c3dcfef` (bounds
  checks in Matrix, and an out-of-bounds fix that applies only when tryDenoise and tryDownscale are
  both on; CheckLink does not set tryDenoise), Emscripten 6.0.12, and result vectors freed after each
  read. The decoder still makes no request, and freed memory is still cleared. The package was
  checked against the registry's integrity value and its SLSA provenance before it was vendored.
- **Android WebView library:** androidx.webkit moves from 1.17.0 to 1.17.1, whose one change removes
  Kotlin from the library.
- **Also in the app since 0.0.1:** an Apple touch icon (`apple-touch-icon.png`) for pages added to an
  iPhone's Home Screen, and a Bible verse in the head of each page.
- **Development only, not shipped:** the page's JavaScript is now type-checked with TypeScript 6.0.3.
  Dependencies follow a written rule: stable releases only, a routine update waits until it is 3
  days old, and a security fix goes in at once.
- **Website only:** the Zapstore link is shown on the website (the app hides it), and the Labs
  carousel uses the canonical order.

## 0.0.1 (versionCode 1), 15 October 2026

The first release, on Zapstore the same day (tag `android-v0.0.1`, `checklink-v0.0.1.apk`, SHA-256
`412c87866bb97e2362fe66adce4ec941333f21b21370ee58cf879dae1780aed3`). A functioning prototype.

- Shows what a link or a QR code holds, and marks the tracking parts its dated rules name with who
  learns them.
- Gives a clean link to copy, share or open, or a QR code of it.
- Reads QR codes from a picture, a share or the camera.
- One permission, the camera, used only while you scan. No internet access.
