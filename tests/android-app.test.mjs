// Stage 4: the Android app's files checked against the website's (no Android tools needed). The
// Kotlin logic has its own unit tests (android/app/src/test, ./gradlew :app:testDebugUnitTest) and
// the bridge runs in a browser in tests/app-mode-smoke.mjs; this file holds what ties the two
// worlds together, so a change on one side that the other does not follow fails here:
//   * the policy the app's asset handler sends equals NOTICE's recommended header, which is the
//     page's own meta policy plus frame-ancestors 'none' and upgrade-insecure-requests;
//   * the permissions: exactly CAMERA, optional camera features, expected-permissions.txt;
//   * the bridge: window.CLBridge only through addWebMessageListener, never addJavascriptInterface;
//     the message names the bridge script sends are the ones OutgoingRequest.kt accepts;
//   * app.js reaches window.CLAndroid only through android(), so the website path is unchanged;
//   * the web-only Zapstore section (stage 5 removes hidden) and its permission line;
//   * the release workflow pins CheckLink's own certificate and reads expected-permissions.txt;
// and, since stage 4b:
//   * the picture of a QR code: the bridge's chunk size and cap equal the app's, the PNG fixtures
//     of the Kotlin check are what src/qr-make.js makes today, and the FileProvider is not
//     exported, reaches cache/outgoing/ only and is refused as a share into CheckLink;
//   * SEC-8 (option A of 12 October 2026: taskAffinity="" only with autoRemoveFromRecents="true"),
//     SEC-10 (secure 'link' never stands in for the camera) and the Q4 toasts, word for word;
//   * SEC-6: the release workflow builds unsigned in a read-only job and signs with apksigner in
//     a job that runs no Gradle, with the secrets in the tag-only "release" environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeQr, qrPng } from '../src/qr-make.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const KT = 'android/app/src/main/kotlin/no/stormberry/checklink';
const CERT = '12dec5ac5eda5500ec233bd10f58515fd99d9a82480ed56445418b164f28a5d5';

const directives = (policy) => new Map(policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
  const [name, ...values] = d.split(/\s+/);
  return [name, values.join(' ')];
}));

function noticeCsp() {
  const notice = read('NOTICE');
  const at = notice.indexOf('action Set, header Content-Security-Policy:');
  assert.ok(at > 0, 'NOTICE no longer names the recommended Content-Security-Policy');
  return notice.slice(at).split('\n').map((l) => l.trim()).find((l) => l.startsWith("default-src 'self'"));
}

function appCsp() {
  const src = read(`${KT}/ResponseHeaders.kt`);
  const block = src.match(/CONTENT_SECURITY_POLICY =\s*([\s\S]*?)\n\n/);
  assert.ok(block, 'ResponseHeaders.kt has no CONTENT_SECURITY_POLICY');
  return block[1].match(/"([^"]*)"/g).map((s) => s.slice(1, -1)).join('');
}

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (['build', '.gradle', '.kotlin'].includes(name)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

test('the app sends NOTICE\'s recommended Content-Security-Policy, character for character', () => {
  assert.equal(appCsp(), noticeCsp());
});

test('that policy is the page\'s meta policy plus the two directives a meta tag cannot carry', () => {
  const meta = read('index.html').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const page = directives(meta);
  const app = directives(appCsp());
  assert.deepEqual([...app.keys()].filter((k) => !page.has(k)).sort(), ['frame-ancestors', 'upgrade-insecure-requests']);
  for (const [k, v] of page) assert.equal(app.get(k), v, `${k} differs between the page and the app`);
  assert.equal(app.get('connect-src'), "'none'");
  assert.equal(app.get('script-src'), "'self' 'wasm-unsafe-eval'");
});

test('the asset handler sends no Permissions-Policy, so the camera stays the page\'s own', () => {
  // Code only: the comments explain why camera=() must never be added.
  const src = (read(`${KT}/ResponseHeaders.kt`) + read(`${KT}/WebAssetHandler.kt`)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/"Permissions-Policy"|"Feature-Policy"/i.test(src));
  assert.ok(!src.includes('camera=()'));
  assert.ok(read(`${KT}/WebAssetHandler.kt`).includes('ResponseHeaders.ALL'));
});

test('the manifest asks for the camera and nothing else, and the camera is optional', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const asked = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"\s*(tools:node="remove")?\s*\/>/g)]
    .filter((m) => !m[2]).map((m) => m[1]);
  assert.deepEqual(asked, ['android.permission.CAMERA']);
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.camera\.any" android:required="false" \/>/);
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/);
  assert.match(manifest, /android\.permission\.INTERNET" tools:node="remove"/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /EnableSafeBrowsing"\s+android:value="false"/);
  assert.match(manifest, /MetricsOptOut"\s+android:value="true"/);
});

test('expected-permissions.txt is the package line and CAMERA, as aapt prints them', () => {
  assert.equal(read('android/expected-permissions.txt'), "package: no.stormberry.checklink\nuses-permission: name='android.permission.CAMERA'\n");
});

test('the share filters take text and the three picture types ImageTypes.kt accepts, never HEIC', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const types = [...manifest.matchAll(/android:mimeType="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(types, ['text/plain', 'image/png', 'image/jpeg', 'image/webp']);
  assert.match(read(`${KT}/ImageTypes.kt`), /"image\/png" to "png",\s*"image\/jpeg" to "jpg",\s*"image\/webp" to "webp",/);
  assert.ok(!/SEND_MULTIPLE|PROCESS_TEXT/.test(manifest));
});

test('names: CheckLink everywhere, nothing left of the template', () => {
  const files = walk('android').filter((f) => /\.(kt|kts|xml|js|properties|pro|toml|txt)$/.test(f) && !f.endsWith('gradle-wrapper.properties'));
  assert.ok(files.length > 20);
  for (const f of files) {
    const text = read(f);
    assert.ok(!/MetadataScrubber|metadatascrubber|MSBridge|MSAndroid|Theme\.Metadata/.test(text), `${f} still names the template`);
  }
  assert.match(read('android/app/build.gradle.kts'), /namespace = "no\.stormberry\.checklink"/);
  assert.match(read('android/app/build.gradle.kts'), /applicationId = "no\.stormberry\.checklink"/);
  assert.match(read('android/app/build.gradle.kts'), /versionCode = 2\s+versionName = "0\.0\.2"/);
  assert.match(read('android/app/build.gradle.kts'), /minSdk = 24\s+targetSdk = 36/);
  assert.match(read('android/app/src/main/res/values/themes.xml'), /name="Theme\.CheckLink"/);
});

test('the bridge is a web message listener for the app\'s own origin only, never addJavascriptInterface', () => {
  const kotlin = walk('android/app/src/main/kotlin').map(read).join('\n');
  assert.ok(!kotlin.includes('addJavascriptInterface'));
  assert.ok(!kotlin.includes('@JavascriptInterface'));
  assert.match(kotlin, /BRIDGE_NAME = "CLBridge"/);
  assert.match(kotlin, /addWebMessageListener\(\s*view,\s*BRIDGE_NAME,\s*setOf\(NavigationPolicy\.ASSET_ORIGIN\),/);
  assert.match(kotlin, /ASSET_ORIGIN = "https:\/\/\$ASSET_HOST"/);
});

test('the messages the bridge script sends are the ones the app accepts', () => {
  const bridge = read('android/web-overlay/android-bridge.js');
  const sent = new Set([...bridge.matchAll(/\bt: '([a-z-]+)'/g)].map((m) => m[1]));
  const kotlin = read(`${KT}/OutgoingRequest.kt`) + read(`${KT}/MainActivity.kt`);
  for (const t of sent) assert.ok(kotlin.includes(`"${t}"`), `the app does not handle "${t}"`);
  for (const t of ['copy', 'share', 'open', 'settings', 'secure', 'camera-state', 'hello', 'in-pull', 'in-done', 'text-done', 'out-begin', 'out-chunk']) assert.ok(sent.has(t), `the bridge never sends "${t}"`);
  const received = new Set([...bridge.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  assert.deepEqual([...received].sort(), ['camera-stop', 'in-chunk', 'in-error', 'incoming', 'out-done', 'out-error', 'out-pull', 'reply', 'shared-text']);
  for (const t of received) assert.ok(read(`${KT}/MainActivity.kt`).includes(`"${t}"`), `the app never sends "${t}"`);
});

test('the bridge script cannot reach the network and adds only window.CLAndroid', () => {
  const bridge = read('android/web-overlay/android-bridge.js');
  const code = bridge.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const word of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'eval(', 'new Function', 'innerHTML', 'document.write']) assert.ok(!code.includes(word), word);
  assert.match(code, /Object\.defineProperty\(window, 'CLAndroid', \{ value: api, writable: false, configurable: false, enumerable: false \}\)/);
  assert.match(code, /Object\.freeze\(api\)/);
  assert.match(code, /navigator\.userActivation/);
  // The page's own text must not name the bridge file: the APK build refuses such an index.html.
  assert.ok(!read('index.html').includes('android-bridge.js'));
});

test('app.js reaches window.CLAndroid only through android() and inApp(), so the website keeps its own path', () => {
  const app = read('app.js');
  const helpers = [
    "const android = () => (window.CLAndroid && typeof window.CLAndroid.copyText === 'function' ? window.CLAndroid : null);",
    'const inApp = () => !!window.CLAndroid;',
  ];
  const outside = app.split('\n').filter((l) => !l.trim().startsWith('//') && !helpers.includes(l.trim()) && l.includes('CLAndroid'));
  assert.deepEqual(outside, [], 'window.CLAndroid is used outside the android() and inApp() helpers');
  assert.match(app, /const android = \(\) => \(window\.CLAndroid && typeof window\.CLAndroid\.copyText === 'function' \? window\.CLAndroid : null\);/);
  // The website's own ways are all still there.
  assert.match(app, /navigator\.clipboard\.writeText\(text\)/);
  assert.match(app, /await navigator\.share\(\{ text: a\.clean\(state\.removed\) \}\)/);
  assert.match(app, /window\.open\(target\.url, '_blank', 'noopener,noreferrer'\)/);
  for (const ev of ['clandroid:shared-text', 'clandroid:shared-picture', 'clandroid:camera-stop']) assert.ok(app.includes(`'${ev}'`), ev);
});

test('screen protection fails closed: no confirmed FLAG_SECURE, no secret and no camera', () => {
  const app = read('app.js');
  // secureScreen resolves true for "on" only when the app answered true; in the app without a
  // bridge it resolves false.
  assert.match(app, /if \(!inApp\(\)\) return Promise\.resolve\(true\);\n  const app = android\(\);\n  if \(!app\) return Promise\.resolve\(!on\);/);
  assert.match(app, /\.then\(\(ok\) => ok === true, \(\) => false\)/);
  // Show and Scan with camera act on that answer.
  assert.match(app, /const ok = await secureScreen\('secret', true\);[\s\S]{0,300}if \(!ok\) \{\n      syncSecret\(\);\n      codeStatus\(i, APP_SECRET_UNPROTECTED\);\n      return;/);
  assert.match(app, /const protectedNow = await secureScreen\('camera', true\);\n    if \(run !== cam\.run\) return;\n    if \(!protectedNow\) \{\n      stopCamera\(CAM\.unprotectedApp/);
  // The protection is lifted only after the page without the secret or camera card is drawn.
  assert.match(app, /afterPaint\(\(\) => \{\n      if \(!appSecure\[reason\]\) app\.secure\(reason, false\);/);
  // Without the message channel the bridge leaves an empty, frozen window.CLAndroid.
  const bridge = read('android/web-overlay/android-bridge.js');
  assert.match(bridge, /if \(!bridge \|\| typeof bridge\.postMessage !== 'function'\) \{\n    Object\.defineProperty\(window, 'CLAndroid', \{ value: Object\.freeze\(\{\}\), writable: false, configurable: false, enumerable: false \}\);\n    return;/);
  // And the app grants the camera only while the window is protected for it.
  const main = read(`${KT}/MainActivity.kt`);
  assert.match(main, /screenProtected = secure\.holds\(OutgoingRequest\.Reason\.CAMERA\)/);
  assert.match(read(`${KT}/CameraPermission.kt`), /if \(!screenProtected\) return Decision\.DENY/);
});

test('in the app, the picture reader\'s messages never ask to load the page again', () => {
  const app = read('app.js');
  assert.match(app, /case 'slow-last': return inApp\(\) \? PIC\.slowLastApp : PIC\.slowLast;/);
  assert.match(app, /case 'stopped': return inApp\(\) \? PIC\.stoppedApp : PIC\.stopped;/);
  for (const key of ['slowLastApp', 'stoppedApp']) {
    const line = app.match(new RegExp(`  ${key}: '([^']+)'`));
    assert.ok(line && !/load this page again/.test(line[1]) && /close CheckLink and open it again/.test(line[1]), key);
  }
  assert.match(app, /camStatus\(inApp\(\) \? CAM\.startingApp : CAM\.starting\);/);
});

test('a share is read once: not on a rotation, nor when Android reopens CheckLink from Recents', () => {
  // Since SEC-8 (option A) Back takes CheckLink's card out of Recents, so no reopen follows Back;
  // this rule (E1) stays for a card Android brings back from Recents with no saved state, for
  // example one it kept across a restart of the phone, which starts the task's first intent again.
  const main = read(`${KT}/MainActivity.kt`);
  assert.match(main, /if \(IncomingPolicy\.isNewShare\(intent\?\.flags \?: 0, restored\)\) \{\n            handleShareIntent\(intent\)/);
  assert.match(read(`${KT}/IncomingPolicy.kt`), /\(intentFlags and Intent\.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY\) == 0/);
});

test('app toasts fit the two lines Android shows: 66 characters at most (decision Q4)', () => {
  const strings = read('android/app/src/main/res/values/strings.xml');
  const all = [...strings.matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)];
  assert.ok(all.length >= 10);
  for (const [, name, text] of all) assert.ok(text.replace(/\\'/g, "'").length <= 66, `${name} is too long for a toast`);
});

test('the toasts approved on 2026-10-11 (Q4) and the new ones of stage 4b, word for word', () => {
  const strings = Object.fromEntries([...read('android/app/src/main/res/values/strings.xml').matchAll(/<string name="([^"]+)">([^<]*)<\/string>/g)].map((m) => [m[1], m[2]]));
  assert.equal(strings.page_crashed, 'CheckLink stopped and reloaded. Share or paste your link again.');
  assert.equal(strings.shared_text_cut, 'The shared text was long, so only its first part was read.');
  assert.equal(strings.share_chooser, 'Share clean link');
  assert.equal(strings.share_qr_chooser, 'Share QR code');
  // "Picture", as on the page (stage 4b review SC-10): Save picture, 'The picture could not be saved.'
  assert.equal(strings.qr_saved, 'Saved the picture of the QR code.');
  assert.equal(strings.qr_save_failed, 'The picture could not be saved.');
  assert.match(read('app.js'), /saveFailed: 'The picture could not be saved\.',/);
  for (const text of Object.values(strings)) assert.ok(!/\b(safe|verified|trusted)\b/i.test(text) && !/clean QR code/i.test(text), text);
});

test('the web-only Zapstore section: shown on the website since the 0.0.1 release, and its permission line', () => {
  const html = read('index.html');
  const section = html.match(/<section class="android-app"[^>]*>[\s\S]*?<\/section>/);
  assert.ok(section, 'no android-app section');
  assert.match(section[0], /^<section class="android-app" id="android-app" aria-labelledby="android-app-title" data-web-only>/);
  assert.ok(section[0].includes('<p>One permission: the camera, used only while you scan. No internet access.</p>'));
  assert.ok(section[0].includes('href="https://zapstore.dev/apps/no.stormberry.checklink"'));
  const before = html.slice(0, section.index);
  assert.ok(before.slice(-600).includes('Shown on the website since 0.0.1 is on Zapstore'));
  assert.ok(!html.includes('STAGE 5:'), 'the stage 5 placeholder comment is still there');
  assert.ok(!html.includes('STAGE 4:'), 'the stage 4 placeholder comment is still there');
  // Hidden on the website; in the app it belongs to the refusal message above it.
  assert.match(html, /<button type="button" class="btn btn-secondary cl-btn-small cl-settings-btn" id="cam-settings" aria-describedby="pic-status" hidden>/);
});

test('the release workflow pins CheckLink\'s certificate and checks expected-permissions.txt', () => {
  const wf = read('.github/workflows/android-release.yml');
  assert.match(wf, new RegExp(`EXPECTED_CERT=${CERT}\\n`));
  assert.ok(wf.includes('EXPECTED_PERMISSIONS=$(cat expected-permissions.txt)'));
  assert.ok(wf.includes('"checklink-${VERSION}.apk"'));
  assert.ok(wf.includes('match: "checklink-.*\\\\.apk$"'));
  // The template's asset name, package and certificate are gone (its name stays only as credit in a comment).
  assert.ok(!/MetadataScrubber-|metadatascrubber|30e916e7d4/.test(wf));
  if (existsSync(join(ROOT, 'android/keystore.properties'))) {
    const ks = read('android/keystore.properties');
    assert.ok(ks.includes(`Certificate SHA-256: ${CERT}`));
    assert.ok(!/^[^#\n]*password[^=\n]*=/im.test(ks), 'keystore.properties must hold no password');
  }
});

test('Android licences: Apache-2.0 for the libraries, and NOTICE\'s licence texts are in the web copy', () => {
  assert.ok(read('android/licences/Apache-2.0.txt').includes('Apache License'));
  const named = new Set([...read('NOTICE').matchAll(/licences\/[A-Za-z0-9._-]+\.txt/g)].map((m) => m[0]));
  assert.ok(named.size >= 10);
  for (const f of named) assert.ok(existsSync(join(ROOT, f)), `${f} named in NOTICE is missing`);
  const gradle = read('android/app/build.gradle.kts');
  assert.ok(gradle.includes('"licences/*.txt"'), 'the web licences/ folder is not bundled');
  assert.ok(gradle.includes('CheckLink-MIT.txt'));
});

test('the new Android texts follow the writing rules: no em or en dashes, no double hyphen used as a dash', () => {
  const files = [...walk('android').filter((f) => /\.(kt|kts|xml|js|properties|pro|py)$/.test(f)), '.github/workflows/android-release.yml', 'tests/app-mode-smoke.mjs', 'tests/android-app.test.mjs'];
  for (const f of files) {
    const text = read(f);
    assert.ok(!/[\u2013\u2014]/.test(text), `${f} has an em or en dash`);
    assert.ok(!/(^|[\s(])--(?=[\s).,]|$)/m.test(text), `${f} uses a double hyphen as a dash`);
  }
});

// ---------------------------------------------------------------- stage 4b

test('the picture of a QR code: the bridge and the app agree on the chunk size and the cap', () => {
  const bridge = read('android/web-overlay/android-bridge.js');
  const req = read(`${KT}/OutgoingRequest.kt`);
  assert.match(bridge, /var CHUNK = 65536;/);
  assert.match(bridge, /var MAX_IMAGE = 262144;/);
  assert.match(req, /const val IMAGE_CHUNK_BYTES = 65_536/);
  assert.match(req, /const val MAX_IMAGE_BYTES = 262_144/);
  assert.match(req, /const val IMAGE_MIME = "image\/png"/);
  assert.match(req, /enum class ImageAction\(val wire: String\) \{ SAVE\("save-image"\), SHARE\("share-image"\) \}/);
  // The bridge sends a Blob's own bytes, never a name or an address, and only image/png.
  assert.match(bridge, /post\(\{ t: 'out-begin', id: job\.id, action: job\.action, mime: 'image\/png', size: job\.bytes\.length, chunks: Math\.ceil\(job\.bytes\.length \/ CHUNK\) \}\)/);
  assert.match(bridge, /png\.type !== 'image\/png'/);
  assert.match(bridge, /saveImage: function \(png\) \{\n      return sendImage\(png, 'save-image'\);/);
  assert.match(bridge, /shareImage: function \(png\) \{\n      return sendImage\(png, 'share-image'\);/);
  // The file name is the page's, and it is fixed (decision QR-6).
  assert.match(read('src/qr-make.js'), /export const QR_FILE = 'qr-code\.png';/);
  assert.match(read(`${KT}/OutgoingFiles.kt`), /const val QR_FILE = "qr-code\.png"/);
  assert.ok(!/name:/.test(bridge.match(/function startNextOut[\s\S]*?\n  \}/)[0]), 'out-begin must carry no name');
});

test('the PNG fixtures of the Kotlin check are exactly what src/qr-make.js makes today', () => {
  const cases = {
    'qr-short.png': 'https://example.com/a?id=7',
    'qr-v25.png': `https://example.com/${'a'.repeat(892)}`,
    'qr-v40.png': `https://example.com/${'a'.repeat(2194)}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const want = Buffer.from(qrPng(makeQr(text)));
    assert.ok(readFileSync(join(ROOT, 'android/app/src/test/resources/qr', name)).equals(want), `${name} is stale: regenerate it from src/qr-make.js`);
  }
  assert.equal(makeQr(cases['qr-v25.png']).version, 25);
  assert.equal(makeQr(cases['qr-v40.png']).version, 40);
});

test('the FileProvider: androidx\'s own, not exported, cache/outgoing/ only, and refused as a share in', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const providers = [...manifest.matchAll(/<provider\b[\s\S]*?<\/provider>/g)].map((m) => m[0]);
  assert.equal(providers.length, 1);
  const p = providers[0];
  assert.match(p, /android:name="androidx\.core\.content\.FileProvider"/);
  assert.match(p, /android:authorities="\$\{applicationId\}\.outgoing"/);
  assert.match(p, /android:exported="false"/);
  assert.match(p, /android:grantUriPermissions="true"/);
  assert.match(p, /android:resource="@xml\/file_paths"/);
  const paths = read('android/app/src/main/res/xml/file_paths.xml').replace(/<!--[\s\S]*?-->/g, '');
  assert.deepEqual([...paths.matchAll(/<([a-z-]+-path)\s+name="([^"]+)"\s+path="([^"]*)"\s*\/>/g)].map((m) => m.slice(1).join(' ')), ['cache-path outgoing outgoing/']);
  assert.ok(!/(root|files|external[a-z-]*)-path/.test(paths));
  assert.match(read(`${KT}/OutgoingFiles.kt`), /const val DIR = "outgoing"/);
  assert.match(read(`${KT}/OutgoingFiles.kt`), /fun authority\(packageName: String\): String = "\$packageName\.\$DIR"/);
  assert.match(read(`${KT}/IncomingPolicy.kt`), /setOf\("\$packageName\.androidx-startup", OutgoingFiles\.authority\(packageName\)\)/);
  // The share: the picture alone, a one-off read grant, CheckLink left out, its own title.
  const main = read(`${KT}/MainActivity.kt`);
  const share = main.match(/private fun shareImage\(file: File\): Boolean \{[\s\S]*?\n    \}/)[0];
  assert.ok(share.includes('Intent.EXTRA_STREAM') && share.includes('FLAG_GRANT_READ_URI_PERMISSION') && share.includes('EXTRA_EXCLUDE_COMPONENTS') && share.includes('R.string.share_qr_chooser'));
  assert.ok(!/EXTRA_TEXT|EXTRA_SUBJECT|EXTRA_HTML_TEXT|EXTRA_TITLE/.test(share), 'the picture goes alone, with no text or subject');
  // A picture is checked before it is written, and again before a save (it may come back from saved state).
  assert.match(main, /if \(PngCheck\.isQrPicture\(png\)\) outgoingFiles\.newFile\(\)\.also \{ it\.writeBytes\(png\) \} else null/);
  assert.match(main, /file\.readBytes\(\)\.takeIf \{ PngCheck\.isQrPicture\(it\) \}/);
  // What is written, and what goes after a failure, is SaveTarget's: never a file CheckLink did not
  // open for writing (stage 4b review S4), and never a plain "w" write left longer than the picture (S10).
  assert.match(main, /val ok = SaveTarget\.save\(documentAt\(target\), png\)/);
  assert.ok(!/deleteDocument\(target\)|openForWrite/.test(main), 'no delete or write outside SaveTarget');
  const save = read(`${KT}/SaveTarget.kt`);
  assert.match(save, /if \(opened\) doc\.delete\(\) else dropIfEmpty\(doc\)/);
  assert.match(save, /if \(size == 0L\) doc\.delete\(\)/);
  assert.match(save, /check\(size == null \|\| size == png\.size\.toLong\(\)\)/);
  // The folder is emptied on a fresh start only, never on a start from saved state.
  assert.match(main, /if \(savedInstanceState == null\) \{\n            io\.execute \{ outgoingFiles\.clear\(\) \}\n        \} else \{\n            restorePendingOut\(savedInstanceState\)/);
  assert.match(main, /pendingOut\?\.let \{ outState\.putString\(STATE_OUT_PATH, it\.absolutePath\) \}/);
});

// The manifest's elements, comments left out, each with its attributes read one by one: a quoted
// value is taken whole, so text inside a value is never mistaken for an attribute. Every opening
// tag must parse, or the count check fails rather than an element being skipped.
function manifestElements() {
  const body = read('android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');
  const elements = [...body.matchAll(/<([A-Za-z][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g)].map((tag) => ({
    name: tag[1],
    attrs: [...tag[2].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((a) => [a[1], a[2] ?? a[3]]),
  }));
  assert.equal(elements.length, body.match(/<[A-Za-z]/g).length, 'every element of the manifest parsed');
  return elements;
}

test('SEC-8 (Marcos, 2026-10-12, option A): taskAffinity="" with autoRemoveFromRecents="true", and the activity stays singleTask', () => {
  const elements = manifestElements();
  const activities = elements.filter((e) => e.name === 'activity');
  assert.equal(activities.length, 1, 'one activity');
  assert.ok(!elements.some((e) => e.name === 'activity-alias'), 'no activity-alias');
  const activity = Object.fromEntries(activities[0].attrs);
  assert.equal(Object.keys(activity).length, activities[0].attrs.length, 'no attribute twice');
  // An allow list, not a deny list: exactly these attributes, so nothing that moves CheckLink's
  // screen to another task or changes how it shows in Recents (allowTaskReparenting,
  // excludeFromRecents, documentLaunchMode, relinquishTaskIdentity, finishOnTaskLaunch,
  // maxRecents and the rest) can be added without this test failing.
  assert.deepEqual(Object.keys(activity).sort(), ['android:autoRemoveFromRecents', 'android:configChanges', 'android:exported',
    'android:launchMode', 'android:name', 'android:taskAffinity', 'android:theme', 'android:windowSoftInputMode']);
  assert.equal(activity['android:name'], '.MainActivity');
  assert.equal(activity['android:launchMode'], 'singleTask');
  assert.equal(activity['android:exported'], 'true');
  // The pair, both required. taskAffinity="" on its own left a second CheckLink card in Recents
  // after Back and a share-in, and that card started a second copy of the activity (emulator,
  // 11 October 2026); autoRemoveFromRecents beside it removed both (the emulator runs of 12 October
  // 2026). The cost Marcos accepted: CheckLink leaves Recents when the person presses Back.
  assert.equal(activity['android:taskAffinity'], '');
  assert.equal(activity['android:autoRemoveFromRecents'], 'true');
  // No other task affinity anywhere, the application element included, and no task or Recents
  // attribute on any other element.
  const task = /^android:(taskAffinity|allowTaskReparenting|autoRemoveFromRecents|excludeFromRecents|documentLaunchMode|alwaysRetainTaskState|clearTaskOnLaunch|finishOnTaskLaunch|relinquishTaskIdentity|maxRecents|launchMode)$/;
  for (const e of elements.filter((x) => x !== activities[0])) {
    assert.deepEqual(e.attrs.map(([n]) => n).filter((n) => task.test(n)), [], `nothing on <${e.name}>`);
  }
  assert.ok(elements.some((e) => e.name === 'application'));
});

test('SEC-10: secure \'link\' reaches the app, and only CAMERA ever lets the camera in', () => {
  assert.match(read('android/web-overlay/android-bridge.js'), /if \(reason !== 'camera' && reason !== 'secret' && reason !== 'link'\) return Promise\.resolve\(false\);/);
  assert.match(read(`${KT}/OutgoingRequest.kt`), /enum class Reason\(val wire: String\) \{ CAMERA\("camera"\), SECRET\("secret"\), LINK\("link"\) \}/);
  const main = read(`${KT}/MainActivity.kt`);
  assert.equal([...main.matchAll(/secure\.holds\(OutgoingRequest\.Reason\.([A-Z]+)\)/g)].map((m) => m[1]).filter((r) => r !== 'CAMERA').length, 0);
});

test('SEC-6: the release workflow builds unsigned without secrets and signs in a job that runs no Gradle', () => {
  const wf = read('.github/workflows/android-release.yml');
  const code = wf.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  // No manual runs: only android-v* tags start it.
  assert.ok(!code.includes('workflow_dispatch'));
  assert.match(code, /^on:\n  push:\n    tags: \["android-v\*"\]\n\n/m);
  assert.match(code, /^permissions: \{\}$/m);
  const jobs = code.slice(code.indexOf('\njobs:\n'));
  const build = jobs.slice(jobs.indexOf('\n  build:\n'), jobs.indexOf('\n  release:\n'));
  const release = jobs.slice(jobs.indexOf('\n  release:\n'));
  // The build job: read-only, no secret, no key, no signing token; Gradle builds unsigned.
  assert.match(build, /permissions:\n      contents: read\n/);
  assert.ok(!/secrets\.|id-token|attestations|contents: write|environment:|apksigner sign|KEYSTORE|RELEASE_STORE|RELEASE_KEY/.test(build), 'the build job must never see a secret or a write token');
  assert.match(build, /\.\/gradlew --no-daemon -PunsignedRelease=true :app:assembleRelease/);
  assert.match(build, /:app:verifyWebAssetsCommitted/);
  // The release job: no Gradle at all, the environment, apksigner after zipalign, the tokens.
  assert.ok(!/gradlew|gradle\/actions|setup-gradle/.test(release), 'the release job must run no Gradle');
  assert.match(release, /needs: build/);
  assert.match(release, /environment: release\n/);
  assert.match(release, /contents: write/);
  assert.match(release, /id-token: write/);
  assert.match(release, /attestations: write/);
  assert.ok(release.indexOf('zipalign" -f 4') > 0 && release.indexOf('zipalign" -f 4') < release.indexOf('apksigner" sign'));
  assert.match(release, /--ks-pass env:KEYSTORE_PASSWORD --key-pass env:KEY_PASSWORD/);
  assert.match(release, /--v1-signing-enabled false --v2-signing-enabled true \\\n\s+--v3-signing-enabled true --v4-signing-enabled false/);
  for (const name of ['KEYSTORE_BASE64', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) assert.ok(release.includes(`secrets.${name}`), name);
  assert.ok(release.indexOf('Remove keystore') < release.indexOf('Verify signature'));
  assert.match(release, /if: always\(\)\n        run: shred -u/);
  // The checks on the signed APK, then the attestation and the release.
  for (const part of ['Number of signers: 1', `EXPECTED_CERT=${CERT}`, 'EXPECTED_PERMISSIONS=$(cat expected-permissions.txt)', '^application-debuggable', 'zipalign" -c 4']) assert.ok(release.includes(part), part);
  assert.ok(release.indexOf('Verify signature') < release.indexOf('attest-build-provenance'));
  // Stage 4b review S6: what the APK holds is checked before the key is decoded, signing takes that
  // very file, and the signed APK must hold the same files; the build job reads no Gradle cache.
  assert.ok(release.indexOf('name: Check the unsigned APK') > 0 && release.indexOf('name: Check the unsigned APK') < release.indexOf('name: Decode keystore'));
  const before = release.slice(release.indexOf('name: Check the unsigned APK'), release.indexOf('name: Decode keystore'));
  for (const part of ['EXPECTED_PERMISSIONS=$(cat expected-permissions.txt)', '^application-debuggable', 'EXPECTED_WEB=', 'APK="$RUNNER_TEMP/handover/checklink-unsigned.apk"', 'sha256sum "$APK" > "$RUNNER_TEMP/checked.sha256"']) assert.ok(before.includes(part), part);
  assert.ok(release.indexOf('sha256sum -c --quiet "$RUNNER_TEMP/checked.sha256"') > 0 && release.indexOf('sha256sum -c --quiet "$RUNNER_TEMP/checked.sha256"') < release.indexOf('zipalign" -f 4'));
  assert.match(release, /signing changed the files of the APK that was checked/);
  assert.match(build, /setup-gradle@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}cache-disabled: true\n/);
  // Stage 4b review S5: the header names the two settings that keep a pushed tag from the key.
  assert.match(wf, /4\. In the release environment, "Required reviewers"/);
  assert.match(wf, /5\. Rules, Rulesets, New tag ruleset, for tags matching android-v\*/);
  assert.ok(release.indexOf('attest-build-provenance') < release.indexOf('gh release create'));
  // Every action is pinned to a full commit, and the artifact actions are the releases that had
  // passed the release-age rule when they were pinned.
  const uses = [...code.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.deepEqual(uses.map((u) => u.split('@')[0]), ['actions/checkout', 'actions/setup-java', 'gradle/actions/setup-gradle', 'actions/upload-artifact',
    'actions/checkout', 'actions/setup-java', 'actions/download-artifact', 'actions/attest-build-provenance']);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, u);
  assert.match(wf, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  assert.match(wf, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/);
});

test('SEC-6: the release job checks the web files against the include list the app is built from', () => {
  const wf = read('.github/workflows/android-release.yml');
  const gradle = read('android/app/build.gradle.kts');
  const includes = gradle.match(/val INCLUDES = listOf\(([\s\S]*?)\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  const loop = wf.match(/EXPECTED_WEB=\$\(cd \.\. && for f in ([\s\S]*?); do/)[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(loop, includes);
  // And the new web files of stage 4b are in the explicit list too.
  for (const f of ['web/src/qr-make.js', 'web/vendor/qrcodegen-8329a71/qrcodegen.js']) assert.ok(wf.includes(f), f);
  assert.ok(existsSync(join(ROOT, 'src/qr-make.js')) && existsSync(join(ROOT, 'vendor/qrcodegen-8329a71/qrcodegen.js')));
  assert.ok(read('NOTICE').includes('licences/QR-Code-generator-MIT.txt'));
});

test('the build refuses an unsigned release unless asked for, and the switch next to a password', () => {
  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /val unsignedRelease = providers\.gradleProperty\("unsignedRelease"\)\.orNull == "true"/);
  assert.match(gradle, /if \(unsignedRelease && \(releaseStorePassword != null \|\| releaseKeyPassword != null\)\) \{\n    error\(/);
  assert.match(gradle, /if \(!signed && !unsigned\) \{\n            error\(/);
  assert.match(gradle, /if \(canSignRelease && !unsignedRelease\) signingConfig = signingConfigs\.getByName\("release"\)/);
});
