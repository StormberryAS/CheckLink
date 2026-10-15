/* CheckLink for Android: the bridge between the page and the app.
 *
 * This file exists ONLY inside the APK. The build copies the web app byte for byte and
 * adds one line to index.html that loads this script before app.js; nothing else in the
 * page is changed. On the website this file is never loaded, window.CLAndroid never exists,
 * and the page behaves exactly as it always has.
 *
 * Everything here keeps the page's own Content Security Policy intact (connect-src 'none'):
 * no fetch, no XHR, nothing leaves the device. It does five jobs.
 *
 *  0. WEBSITE-ONLY PARTS. Every element marked data-web-only (the "Get the Android app on
 *     Zapstore" section) is hidden: the ones in the page once it has been parsed, and the
 *     ones the page adds later as soon as they are added.
 *
 *  1. window.CLAndroid, what the page asks of the app (app.js uses each one only when it
 *     exists). Every call returns a Promise that settles when the app answers, or false
 *     after a few seconds without an answer, so the page never hangs:
 *       copyText(text, sensitive)  Android's clipboard; sensitive hides it in the preview
 *       shareText(text)            Android's share sheet, CheckLink left out
 *       open(url)                  the browser (Go to), only while the page has the user
 *                                  activation a real press gives; http and https only
 *       openAppSettings()          Android's settings page for CheckLink
 *       secure(reason, on)         'camera' or 'secret' starts (true) or stops (false)
 *                                  showing; the app keeps screenshots and the recent-apps
 *                                  thumbnail out while any reason holds, and answers only
 *                                  once the window is protected. app.js shows nothing
 *                                  unless this resolves true (no answer means false).
 *                                  'link' (stage 4b, SEC-10): a sign-in link or a link with
 *                                  personal details is on screen; best effort, the page
 *                                  shows the link whatever the answer
 *       cameraBlocked()            true when Android refused the camera and will not ask
 *                                  again, so only its settings page can allow it
 *       saveImage(png)             (stage 4b) the picture of a QR code of the clean link:
 *       shareImage(png)            Android's save screen, or Android's share sheet with the
 *                                  picture alone. png is a Blob of type image/png, at most
 *                                  MAX_IMAGE bytes, starting with the PNG signature; the
 *                                  app checks it again (PngCheck.kt) before it writes a
 *                                  byte. true once the save screen or the share sheet is
 *                                  open; the app itself says when the picture is saved
 *
 *  2. TEXT AND PICTURES SHARED INTO THE APP. Shared text arrives whole; a shared picture
 *     arrives in chunks and is rebuilt here as a File. Each is handed to the page, once the
 *     page is ready, as a window event: 'clandroid:shared-text' (detail.text) and
 *     'clandroid:shared-picture' (detail.file). app.js treats them as a paste and a chosen
 *     picture, and makes Share clean link the main button.
 *
 *  3. THE APP LEAVING THE SCREEN. The app says 'camera-stop' when it stops; this script
 *     turns it into the window event 'clandroid:camera-stop', and app.js turns the camera
 *     off, a second guard behind the hidden page.
 *
 *  4. THE PICTURE OF A QR CODE, OUT (stage 4b). saveImage and shareImage hand the PNG to the
 *     app in chunks the app pulls one at a time (out-begin, out-pull, out-chunk), one
 *     picture at a time; the same picture asked for the same thing while it is on its way
 *     gets the answer already coming, so a second tap never sends it twice.
 *
 * The channel is window.CLBridge, injected by the app through
 * WebViewCompat.addWebMessageListener and ONLY into pages from
 * https://appassets.androidplatform.net, the bundled app's own origin. window.CLAndroid is
 * plain JavaScript on top of that channel: it adds no Java object to the page (no
 * addJavascriptInterface), and the app checks every request again (OutgoingRequest.kt,
 * NavigationPolicy.kt, TapWindow.kt) before it acts.
 *
 * THE MESSAGES (all JSON text; t is the type):
 *   page to app
 *     { t: 'hello' }                                  the page has loaded (or reloaded)
 *     { t: 'copy', id, text, sensitive }              id: a positive whole number
 *     { t: 'share', id, text }
 *     { t: 'open', id, url }                          url: new URL(url).href
 *     { t: 'settings', id }
 *     { t: 'secure', id, reason, on }                 reason: 'camera' | 'secret' | 'link'
 *     { t: 'camera-state', id }
 *     { t: 'out-begin', id, action, mime, size, chunks }   action: 'save-image' | 'share-image',
 *                                                     mime: 'image/png', chunks: size / CHUNK
 *                                                     rounded up; no name, address or path
 *     { t: 'out-chunk', id, index, data }             data: base64 of bytes
 *                                                     [index * CHUNK, (index + 1) * CHUNK)
 *     { t: 'in-pull', batch, file: 0, index }         the next chunk of a shared picture
 *     { t: 'in-done', batch }                         the picture is here, or given up
 *     { t: 'text-done' }                              the shared text is in the page
 *   app to page
 *     { t: 'reply', id, ok, blocked? }                the answer to one request
 *     { t: 'incoming', batch, files: [{ mime, size }] }   a shared picture is waiting
 *     { t: 'in-chunk', batch, file: 0, index, data, last }  data: base64
 *     { t: 'in-error', batch, file: 0 }
 *     { t: 'shared-text', text }
 *     { t: 'camera-stop' }
 *     { t: 'out-pull', id, index }                    send chunk index of picture id
 *     { t: 'out-done', id, ok }                       ok true: the save screen or the share
 *                                                     sheet is open
 *     { t: 'out-error', id }                          the picture was refused or not taken
 */
(function () {
  'use strict';

  /* ---------- 0. Website-only parts of the page ---------- */

  /* This runs before the check for window.CLBridge below, on purpose: it depends only on
     this file being loaded, which happens only inside the APK, so the website-only parts
     stay hidden even on a WebView too old for the message channel. The script loads at the
     end of the body, just before app.js, while the document is still loading (readyState
     'loading'), so it waits for the end of parsing: readyState leaves 'loading' before the
     app.js module runs, whereas DOMContentLoaded fires only after it.
     A MutationObserver hides any data-web-only element the page adds later; its callback
     runs before the browser paints, so such a part is never shown, not even briefly. */
  function hideWebOnly(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1 && root.hasAttribute('data-web-only')) root.hidden = true;
    var els = root.querySelectorAll('[data-web-only]');
    for (var i = 0; i < els.length; i++) els[i].hidden = true;
  }
  function watchWebOnly() {
    hideWebOnly(document);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function (records) {
      for (var r = 0; r < records.length; r++) {
        var rec = records[r];
        if (rec.type === 'attributes') {
          /* Something took the hidden attribute off a website-only part: put it back. */
          if (rec.target.nodeType === 1 && rec.target.hasAttribute('data-web-only') && !rec.target.hidden) rec.target.hidden = true;
          continue;
        }
        var added = rec.addedNodes;
        for (var n = 0; n < added.length; n++) hideWebOnly(added[n]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-web-only'] });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', function onState() {
      if (document.readyState === 'loading') return;
      document.removeEventListener('readystatechange', onState);
      watchWebOnly();
    });
  } else {
    watchWebOnly();
  }

  /* A WebView too old for the message channel (the app has also said so in a short message
     of its own): window.CLAndroid is an empty, frozen object. app.js then knows it is inside
     the app (inApp) but has no bridge (android() is null), so Copy, Share and Go to take the
     website's way, while a secret is never shown and the camera never started, because the
     app cannot confirm that screenshots are blocked (fail closed). The app refuses the camera
     too when nothing protects the screen. */
  var bridge = window.CLBridge;
  if (!bridge || typeof bridge.postMessage !== 'function') {
    Object.defineProperty(window, 'CLAndroid', { value: Object.freeze({}), writable: false, configurable: false, enumerable: false });
    return;
  }

  function post(msg) {
    bridge.postMessage(JSON.stringify(msg));
  }

  function fromBase64(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBase64(bytes) {
    var parts = [];
    var STEP = 0x8000;
    for (var i = 0; i < bytes.length; i += STEP) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + STEP, bytes.length))));
    }
    return btoa(parts.join(''));
  }

  /* ---------- 1. window.CLAndroid ---------- */

  /* Requests waiting for the app's answer, by id. */
  var nextId = 1;
  var waiting = new Map();
  /* An answer that has not come in this long counts as false. */
  var TIMEOUT_MS = 8000;
  /* The app refuses longer text (OutgoingRequest.MAX_TEXT_CHARS); refused here first. */
  var MAX_TEXT = 65536;

  function ask(msg) {
    return new Promise(function (resolve) {
      var id = nextId++;
      msg.id = id;
      var timer = window.setTimeout(function () {
        if (waiting.delete(id)) resolve(false);
      }, TIMEOUT_MS);
      waiting.set(id, function (reply) {
        window.clearTimeout(timer);
        resolve(reply);
      });
      try {
        post(msg);
      } catch (e) {
        window.clearTimeout(timer);
        waiting.delete(id);
        resolve(false);
      }
    });
  }

  function onReply(msg) {
    var settle = waiting.get(msg.id);
    if (!settle) return;
    waiting.delete(msg.id);
    settle(msg);
  }

  var okOf = function (reply) { return !!reply && reply.ok === true; };
  var isText = function (x) { return typeof x === 'string' && x.length > 0 && x.length <= MAX_TEXT; };

  /* A real press gives the page a few seconds of user activation; a script cannot make it.
     A WebView too old to say (no navigator.userActivation) leaves the decision to the app's
     own check (TapWindow.kt). */
  function pressedJustNow() {
    var ua = navigator.userActivation;
    return !ua || ua.isActive === true;
  }

  var api = {
    copyText: function (text, sensitive) {
      if (!isText(text)) return Promise.resolve(false);
      return ask({ t: 'copy', text: text, sensitive: sensitive === true }).then(okOf);
    },
    shareText: function (text) {
      if (!isText(text)) return Promise.resolve(false);
      return ask({ t: 'share', text: text }).then(okOf);
    },
    open: function (url) {
      if (typeof url !== 'string' || !pressedJustNow()) return Promise.resolve(false);
      var href;
      try {
        var u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.resolve(false);
        href = u.href;
      } catch (e) {
        return Promise.resolve(false);
      }
      return ask({ t: 'open', url: href }).then(okOf);
    },
    openAppSettings: function () {
      return ask({ t: 'settings' }).then(okOf);
    },
    secure: function (reason, on) {
      if (reason !== 'camera' && reason !== 'secret' && reason !== 'link') return Promise.resolve(false);
      return ask({ t: 'secure', reason: reason, on: on === true }).then(okOf);
    },
    cameraBlocked: function () {
      return ask({ t: 'camera-state' }).then(function (reply) { return okOf(reply) && reply.blocked === true; });
    },
    saveImage: function (png) {
      return sendImage(png, 'save-image');
    },
    shareImage: function (png) {
      return sendImage(png, 'share-image');
    }
  };
  Object.freeze(api);
  Object.defineProperty(window, 'CLAndroid', { value: api, writable: false, configurable: false, enumerable: false });

  /* ---------- 2. Text and pictures shared into the app ---------- */

  /* readyState turns 'interactive' BEFORE module scripts run, so it cannot say whether
     app.js has started listening yet. DOMContentLoaded fires only after app.js (a module)
     has run: by then it listens. This script loads first, so its listener runs before
     app.js's; nothing is delivered from inside that event. The first-run notice
     (.sb-gate-overlay, gate.js) must be dismissed first, so a share never arrives behind it. */
  var domReady = false;
  document.addEventListener('DOMContentLoaded', function () { domReady = true; }, { once: true });

  function pageReady() {
    return domReady && !!document.getElementById('link-input') && !document.querySelector('.sb-gate-overlay');
  }

  function whenReady(fn) {
    if (pageReady()) { fn(); return; }
    window.setTimeout(function () { whenReady(fn); }, 250);
  }

  function hand(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: Object.freeze(detail) }));
  }

  var textSeq = 0;
  function onSharedText(msg) {
    if (typeof msg.text !== 'string' || !msg.text) return;
    var seq = ++textSeq;
    whenReady(function () {
      if (seq !== textSeq) return; /* a newer share came in meanwhile */
      hand('clandroid:shared-text', { text: msg.text });
      post({ t: 'text-done' });
    });
  }

  var EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  var inBatch = null;

  function onIncoming(msg) {
    var files = Array.isArray(msg.files) ? msg.files : [];
    var meta = files[0];
    if (!meta || !EXT[meta.mime]) return;
    inBatch = { id: msg.batch, mime: meta.mime, parts: [] };
    var id = inBatch.id;
    whenReady(function () {
      if (inBatch && inBatch.id === id) post({ t: 'in-pull', batch: id, file: 0, index: 0 });
    });
  }

  function onInChunk(msg) {
    var b = inBatch;
    if (!b || msg.batch !== b.id || msg.file !== 0) return;
    if (msg.data) b.parts.push(fromBase64(msg.data));
    if (!msg.last) {
      post({ t: 'in-pull', batch: b.id, file: 0, index: msg.index + 1 });
      return;
    }
    inBatch = null;
    post({ t: 'in-done', batch: b.id });
    var file = new File(b.parts, 'shared.' + EXT[b.mime], { type: b.mime });
    hand('clandroid:shared-picture', { file: file });
  }

  function onInError(msg) {
    var b = inBatch;
    if (!b || msg.batch !== b.id) return;
    /* The app has already said why, in a short message of its own. */
    inBatch = null;
    post({ t: 'in-done', batch: b.id });
  }

  /* ---------- 4. The picture of a QR code, out (stage 4b) ---------- */

  /* Raw bytes a chunk (IMAGE_CHUNK_BYTES in OutgoingRequest.kt), and the largest picture
     handed over: twice the largest the page makes (MAX_IMAGE_BYTES there), so at most 4
     chunks. The app refuses anything else in any case. */
  var CHUNK = 65536;
  var MAX_IMAGE = 262144;
  var PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  /* Pictures waiting their turn, the one on its way, and every one of them (outJobs), so the
     same picture asked for the same thing again while it is still waiting or on its way gets
     that job's answer instead of being sent twice. */
  var outQueue = [];
  var outCurrent = null;
  var outJobs = [];

  function isPng(bytes) {
    if (bytes.length < PNG_SIGNATURE.length) return false;
    for (var i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    return true;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* Each job has one timer: TIMEOUT_MS without a message from the app for it (from when it
     is asked for, from out-begin, and again from each out-pull) and it gives false. */
  function armJob(job) {
    window.clearTimeout(job.timer);
    job.timer = window.setTimeout(function () { endJob(job, false); }, TIMEOUT_MS);
  }

  function endJob(job, ok) {
    if (job.done) return;
    job.done = true;
    window.clearTimeout(job.timer);
    var i = outJobs.indexOf(job);
    if (i >= 0) outJobs.splice(i, 1);
    i = outQueue.indexOf(job);
    if (i >= 0) outQueue.splice(i, 1);
    if (outCurrent === job) outCurrent = null;
    job.resolve(ok);
    startNextOut();
  }

  /* Only a Blob of type image/png, 1 to MAX_IMAGE bytes, starting with the PNG signature; the
     bytes are read from the Blob itself, never fetched. Resolves true once the app has the
     whole picture and its save screen or share sheet is open, false otherwise. */
  function sendImage(png, action) {
    if (typeof Blob !== 'function' || !(png instanceof Blob) || png.type !== 'image/png' || !(png.size > 0 && png.size <= MAX_IMAGE)) {
      return Promise.resolve(false);
    }
    for (var i = 0; i < outJobs.length; i++) {
      if (outJobs[i].blob === png && outJobs[i].action === action) return outJobs[i].promise;
    }
    return png.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length !== png.size || !isPng(bytes)) return false;
      for (var j = 0; j < outJobs.length; j++) {
        if (outJobs[j].action === action && sameBytes(outJobs[j].bytes, bytes)) return outJobs[j].promise;
      }
      var job = { blob: png, action: action, bytes: bytes, id: 0, timer: 0, done: false };
      job.promise = new Promise(function (resolve) { job.resolve = resolve; });
      outJobs.push(job);
      outQueue.push(job);
      armJob(job);
      startNextOut();
      return job.promise;
    }, function () {
      return false;
    });
  }

  function startNextOut() {
    if (outCurrent || !outQueue.length) return;
    var job = outQueue.shift();
    outCurrent = job;
    job.id = nextId++;
    armJob(job);
    try {
      post({ t: 'out-begin', id: job.id, action: job.action, mime: 'image/png', size: job.bytes.length, chunks: Math.ceil(job.bytes.length / CHUNK) });
    } catch (e) {
      endJob(job, false);
    }
  }

  function onOutPull(msg) {
    var job = outCurrent;
    if (!job || msg.id !== job.id) return;
    var index = msg.index;
    if (typeof index !== 'number' || Math.floor(index) !== index || index < 0 || index * CHUNK >= job.bytes.length) {
      endJob(job, false);
      return;
    }
    armJob(job);
    var piece = job.bytes.subarray(index * CHUNK, Math.min((index + 1) * CHUNK, job.bytes.length));
    try {
      post({ t: 'out-chunk', id: job.id, index: index, data: toBase64(piece) });
    } catch (e) {
      endJob(job, false);
    }
  }

  function onOutEnd(msg) {
    var job = outCurrent;
    if (!job || msg.id !== job.id) return;
    endJob(job, msg.t === 'out-done' && msg.ok === true);
  }
  /* ---------- Messages from the app ---------- */

  bridge.addEventListener('message', function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'reply': onReply(msg); break;
      case 'shared-text': onSharedText(msg); break;
      case 'incoming': onIncoming(msg); break;
      case 'in-chunk': onInChunk(msg); break;
      case 'in-error': onInError(msg); break;
      case 'camera-stop': window.dispatchEvent(new Event('clandroid:camera-stop')); break;
      case 'out-pull': onOutPull(msg); break;
      case 'out-done':
      case 'out-error': onOutEnd(msg); break;
      default: break;
    }
  });

  post({ t: 'hello' });
})();
