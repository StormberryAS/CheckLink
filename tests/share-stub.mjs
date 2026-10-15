// Stand-ins for the Web Share API, the async clipboard and window.open, for the browser
// tests (tests/ui-smoke.mjs and tests/e2e.mjs). Desktop Chromium on Linux has no share
// sheet, a headless browser has no clipboard a test can read back, and Go to must never
// really leave the machine, so the tests replace all three before the page loads and
// record what the page hands them. Nothing is sent anywhere: the stand-ins only keep the
// text in the page for the test to read back.
//
//   shareStub({ share: true, clipboard: true, open: true, files: false, pictures: false })
//   returns the source for Page.addScriptToEvaluateOnNewDocument.
//
// share: true      navigator.canShare says yes to text or a URL (not files), as Chrome on
//                  Android does, and navigator.share records each call, then resolves, or
//                  rejects when window.__share.mode is 'abort' (AbortError) or 'fail'.
// share: false     navigator.canShare and navigator.share do not exist.
// clipboard: true  Clipboard.prototype.writeText records the text and resolves, or
//                  rejects when window.__clip.mode is 'fail'. The real one is kept as
//                  window.__realWriteText, for a test that pastes through the clipboard.
// clipboard: false navigator.clipboard.writeText does not exist, so the page falls back to
//                  document.execCommand('copy'), which is recorded the same way.
// open: true       window.open records the address and features and opens nothing.
// files: true      (stage 4b, with share) navigator.canShare also says yes to a list of files, as
//                  Chrome on Android does, and navigator.share records each file it is handed:
//                  name, type, size and its bytes as base64, in window.__share.files.
// pictures: true   (stage 4b) Clipboard.prototype.write records each item it is handed (its types,
//                  and the bytes of an image/png as base64) in window.__clip.pictures and resolves,
//                  or rejects when window.__clip.mode is 'fail'; ClipboardItem.supports says yes to
//                  image/png. The real write is kept as window.__realWrite. Without it, write is the
//                  browser's own (the picture tests paste through it).
//
// The names the stand-ins create: window.__share = { mode, calls: [{ text, url, title, files }],
// files: [{ name, type, size, base64 }] }, window.__clip = { mode, calls: [{ via, text }],
// pictures: [{ types, type, size, base64 }] } and window.__opened = [{ url, target, features }].

import { analyse } from '../src/link-core.js';
import { QUIET, makeQr, qrPath, qrPng, qrText } from '../src/qr-make.js';

// Stage 4b: what the page's QR code of a link must be, from the engine and src/qr-make.js run in
// Node: the text it holds, the host the screen reader hears, the SVG path, its viewBox and the
// PNG's bytes. removed: the ids removed (the default choice when left out).
export function expectedQr(link, removed) {
  const a = analyse(link);
  const set = removed ? new Set(removed) : new Set(a.defaultRemoved);
  const payload = qrText(a.openUrl(set));
  const qr = makeQr(payload.text);
  const side = qr.size + 2 * QUIET;
  return { text: payload.text, host: payload.host, path: qrPath(qr), viewBox: `0 0 ${side} ${side}`, png: Buffer.from(qrPng(qr)) };
}

export function shareStub({ share = true, clipboard = true, open = true, files = false, pictures = false } = {}) {
  return `(() => {
  window.__share = { mode: 'ok', calls: [], files: [] };
  window.__clip = { mode: 'ok', calls: [], pictures: [] };
  window.__opened = [];
  const b64 = async (blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  if (${share ? 'true' : 'false'}) {
    const filesToo = ${files ? 'true' : 'false'};
    Object.defineProperty(Navigator.prototype, 'canShare', { configurable: true, writable: true, value: function (d) {
      if (!d) return false;
      if (d.files) return filesToo && Array.isArray(d.files) && d.files.length > 0 && d.files.every((f) => f instanceof File);
      return typeof d.text === 'string' || typeof d.url === 'string';
    } });
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, writable: true, value: async function (d) {
      window.__share.calls.push({ text: d && d.text, url: d && d.url, title: d && d.title, files: d && d.files ? d.files.length : 0 });
      if (d && d.files) {
        if (!filesToo) throw new TypeError('files are not shared here');
        for (const f of d.files) window.__share.files.push({ name: f.name, type: f.type, size: f.size, base64: await b64(f) });
      }
      if (window.__share.mode === 'abort') throw new DOMException('Share canceled', 'AbortError');
      if (window.__share.mode === 'fail') throw new DOMException('Share failed', 'DataError');
    } });
  } else {
    delete Navigator.prototype.canShare;
    delete Navigator.prototype.share;
  }
  if (typeof Clipboard === 'function' && ${pictures ? 'true' : 'false'}) {
    window.__realWrite = Clipboard.prototype.write;
    Clipboard.prototype.write = async function (items) {
      for (const item of items) {
        const rec = { types: [...item.types], type: null, size: 0, base64: null };
        if (item.types.includes('image/png')) {
          const blob = await item.getType('image/png');
          Object.assign(rec, { type: blob.type, size: blob.size, base64: await b64(blob) });
        }
        window.__clip.pictures.push(rec);
      }
      if (window.__clip.mode === 'fail') throw new DOMException('Write blocked', 'NotAllowedError');
    };
    if (typeof ClipboardItem === 'function') ClipboardItem.supports = (type) => type === 'image/png' || type === 'text/plain';
  }
  if (typeof Clipboard === 'function') {
    window.__realWriteText = Clipboard.prototype.writeText;
    if (${clipboard ? 'true' : 'false'}) {
      Clipboard.prototype.writeText = async function (text) {
        window.__clip.calls.push({ via: 'writeText', text: String(text) });
        if (window.__clip.mode === 'fail') throw new DOMException('Write blocked', 'NotAllowedError');
      };
    } else {
      delete Clipboard.prototype.writeText;
    }
  }
  if (${clipboard ? 'false' : 'true'}) {
    const exec = Document.prototype.execCommand;
    Document.prototype.execCommand = function (cmd, ...rest) {
      if (String(cmd).toLowerCase() !== 'copy') return exec.call(this, cmd, ...rest);
      const el = document.activeElement;
      const text = el && typeof el.value === 'string' ? el.value.slice(el.selectionStart, el.selectionEnd) : String(getSelection());
      window.__clip.calls.push({ via: 'execCommand', text });
      return window.__clip.mode !== 'fail';
    };
  }
  if (${open ? 'true' : 'false'}) {
    window.open = function (url, target, features) {
      window.__opened.push({ url: String(url), target: target === undefined ? null : String(target), features: features === undefined ? null : String(features) });
      return null;
    };
  }
})();`;
}

// The page's own words, so both tests check the same text.
export const TEXT = {
  copy: 'Copy clean link',
  share: 'Share clean link',
  copied: 'Copied the clean link.',
  copyFailed: 'The link could not be copied. Select the clean link above and copy it yourself.',
  shareFailed: 'The link could not be shared. Copy it instead.',
  noWarnings: 'No warning signs found. That does not prove the site is genuine: check that this is the address you expected.',
  unique: 'Unique to this click',
  looksUnique: 'Looks unique to this click',
  same: 'Same for everyone who got this link',
  nothingOpened: 'Nothing has been opened.',
  sharer: 'Tied to the sharer',
  disguiseBadge: 'Misleading',
  signinBadge: 'Readable by anyone',
  sameKind: 'Same kind as the part above.',
  emptyLabel: 'Empty part',
  removeAnyway: 'Remove anyway',
  pinCopied: 'Copied the pin link.',
  placeCopied: 'Copied the place link.',
  reportLine: 'Did CheckLink break your link? Email us. Your email app opens with a message for you to check before you send it.',
  // Stage 2: pictures.
  picReading: 'Reading the picture on this device.',
  picNone: 'No QR code or barcode found in this picture. Try a sharper picture, with the code larger in it.',
  picNotImage: 'This file is not a picture CheckLink can read. Choose a PNG, JPEG, GIF, BMP, WebP or AVIF picture.',
  picNoReader: 'This browser does not let CheckLink start its picture reader, so it cannot read pictures here. Paste the link instead.',
  picSeveral: 'More than one code in a picture can mean a sticker has been put over or next to the real one. Make sure you pick the one you meant.',
  // Since the stage 2 fixes (11 October 2026) this is a notice in the picture card, not the
  // status line, and it covers any hidden detail, not only Stop secrets.
  picNotShown: 'The picture is not shown here, because a code in it holds private details: a screenshot of this page would carry them.',
  // One code holding a web address: the link's own summary says nothing has been opened, so the
  // picture card does not say it again (interface review M3 of the stage 3 fixes).
  picOne: 'This picture holds one QR code.',
  picChecked: 'Checked below.',
  fromPicture: 'A web address, read from your picture. Nothing has been opened.',
  // Stage 3: the live camera.
  camHelp: 'The camera is used only after you press Scan with camera, and only until a code is found. Nothing is recorded or sent.',
  camLooking: 'Camera on. Point it at a QR code or barcode.',
  camStopped: 'Camera stopped.',
  camHidden: 'The camera stopped because you left this page. Press Scan with camera to start it again.',
  camDenied: "CheckLink was not allowed to use the camera, so it cannot scan. To scan, allow the camera for this site in your browser's settings and press Scan with camera again, or choose a picture of the code instead.",
  camNone: 'No camera was found on this device. Choose a picture of the code instead.',
  camBlocked: 'This site does not allow the camera at the moment, so CheckLink cannot scan here. Choose a picture of the code instead.',
  camMadeUp: 'This browser does not let CheckLink see the camera picture (its fingerprinting protection hides it), so codes cannot be read live here. Choose a picture of the code instead; on a phone, that can take a photo.',
  camFound: 'The camera found one QR code.',
  camTitle: 'From the camera',
  fromCamera: 'A web address, read by the camera. Nothing has been opened.',
  // Stage 4b: a QR code of the clean link.
  qrButton: 'Make a QR code',
  qrTitle: 'QR code of the clean link',
  qrScan: 'Anyone who scans it can open this link.',
  qrMaking: 'Making the QR code on this device and reading it back.',
  qrNoReader: 'CheckLink could not check the QR code in this browser. Copy or share the link instead.',
  // Inside the app (stage 4b review SC-3): no browser to name.
  qrNoReaderApp: 'CheckLink could not start its picture reader, so it cannot check a QR code. Copy or share the link instead.',
  qrScreen: 'Scan it from this screen, or take a screenshot.',
  qrCopied: 'Copied the picture of the QR code.',
  qrCopyFailed: 'The picture could not be copied. Save it instead.',
  qrShareFailed: 'The picture could not be shared. Save it instead.',
  qrSaveFailed: 'The picture could not be saved.',
  qrLabel: (host) => `QR code of the clean link to ${host}`,
  personalEmail: 'This link holds an email address. Anyone you send it to can read it.',
  personalSignin: 'This link carries a sign-in, key or session value. Anyone you send it to may be able to use it.',
  // SC-9 (Marcos, 2026-10-12): the QR line when the line above already gives the same reason.
  qrSameReason: 'No QR code for this link, for the same reason.',
  shareHeldAuth: 'Share is not offered for this link: whoever opens it may get into the account. Copy it only to open it yourself.',
  shareHeldRecipient: 'Share is not offered for this link: it keeps a part that identifies you, because the page needs it. Copy it only to open it yourself.',
};

// Stage 4b: the QR code card, its button, its reason line and the PD-1 line above Copy and Share,
// read from the DOM only.
export const QR_STATE = `(() => {
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const txt = (id) => (vis(document.getElementById(id)) ? document.getElementById(id).textContent : null);
  const card = document.getElementById('qr-card');
  const svg = card.querySelector('svg');
  const path = svg ? svg.querySelector('path') : null;
  const rect = svg ? svg.querySelector('rect') : null;
  const frame = document.getElementById('qr-code');
  const box = svg ? svg.getBoundingClientRect() : null;
  const cb = card.getBoundingClientRect();
  return {
    button: vis(document.getElementById('qr-btn')), expanded: document.getElementById('qr-btn').getAttribute('aria-expanded'),
    buttonText: document.getElementById('qr-btn').textContent,
    note: txt('qr-note'), warn: txt('share-warn'), shareNote: txt('share-note'),
    card: vis(card), title: document.getElementById('qr-title').textContent,
    focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName.toLowerCase() : null,
    svg: svg ? {
      children: [...svg.children].map((c) => c.tagName.toLowerCase()), role: svg.getAttribute('role'), label: svg.getAttribute('aria-label'),
      viewBox: svg.getAttribute('viewBox'), styled: svg.hasAttribute('style') || !!svg.querySelector('[style]'),
      d: path && path.getAttribute('d'), fill: path && path.getAttribute('fill'), bg: rect && rect.getAttribute('fill'),
      pathFill: path && getComputedStyle(path).fill, rectFill: rect && getComputedStyle(rect).fill,
      width: Math.round(box.width), height: Math.round(box.height), left: Math.round(box.left), right: Math.round(box.right),
    } : null,
    cardLeft: Math.round(cb.left), cardRight: Math.round(cb.right),
    frameBg: frame ? getComputedStyle(frame).backgroundColor : null,
    text: document.getElementById('qr-text').textContent,
    scan: txt('qr-scan'), ascii: txt('qr-ascii'),
    save: vis(document.getElementById('qr-save')), share: vis(document.getElementById('qr-share')), copy: vis(document.getElementById('qr-copy')),
    screen: txt('qr-screen'),
    qrStatus: document.getElementById('qr-status').textContent,
    status: document.getElementById('action-status').textContent,
    actions: [...document.querySelectorAll('#clean-card .cl-actions button:not([hidden])')].map((b) => b.id),
    sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
  };
})()`;

// The "Goes to" line the page should show for an analysis (stage 2: the registrable domain
// first, with the full name after it when the host is a longer address under it; www. adds
// nothing). keptIndex is the wrapper the person kept, or -1.
export function goesText(a, keptIndex = -1) {
  const place = (host, site, written) => {
    const lower = String(host).toLowerCase().replace(/\.$/, '');
    const d = site && site.domain;
    const w = written && written.toLowerCase() !== lower ? written : null;
    if (d && d !== lower && lower !== `www.${d}`) return `${d} (full name: ${host}${w ? `, written as ${w}` : ''})`;
    return `${host}${w ? ` (written as ${w})` : ''}`;
  };
  if (keptIndex >= 0) {
    const w = a.wrappers[keptIndex];
    return `Goes to ${place(w.host, w.site, null)} first, then to ${place(a.host, a.site, a.hostAsWritten)}.`;
  }
  return `Goes to ${place(a.host, a.site, a.hostAsWritten)}${a.shortLink ? ' first' : ''}.`;
}

// The bold, underlined part of a link as the page should show it: the registrable domain as
// written, or the whole host when there is none.
export const boldText = (a) => a.domainAsWritten ?? a.hostAsWritten;

// What the picture card shows (stage 2), read from the DOM only.
export const PICTURE_STATE = `(() => {
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const card = document.getElementById('picture-card');
  const canvas = document.getElementById('picture-view');
  return {
    card: vis(card),
    status: document.getElementById('pic-status').textContent,
    summary: document.getElementById('picture-summary').textContent,
    notice: vis(document.getElementById('picture-notice')) ? document.getElementById('picture-notice').textContent : null,
    canvas: { shown: vis(canvas), width: canvas.width, height: canvas.height, label: canvas.getAttribute('aria-label') },
    box: document.getElementById('link-input').value,
    codes: [...document.querySelectorAll('#code-list > .cl-code')].map((li) => ({
      id: li.id, kind: li.dataset.kind, tier: li.dataset.tier || null,
      title: li.querySelector('.cl-code-title').textContent,
      format: li.querySelector('.cl-code-format') ? li.querySelector('.cl-code-format').textContent : null,
      goes: [...li.querySelectorAll('.cl-code-goes')].map((g) => g.textContent),
      // Since the stage 3 fixes the card's own summary says so (it no longer has a separate line).
      checkedBelow: /checked below|Details below/.test(li.querySelector('.cl-code-summary').textContent),
      summary: li.querySelector('.cl-code-summary').textContent,
      fields: [...li.querySelectorAll('.cl-field-row')].map((r) => ({
        label: r.querySelector('.cl-field-label').textContent,
        value: r.querySelector('.cl-field-value').textContent,
        hidden: r.querySelector('.cl-secret') ? r.querySelector('.cl-secret').dataset.shown !== 'true' : false,
        note: r.querySelector('.cl-field-note') ? r.querySelector('.cl-field-note').textContent : null,
        buttons: [...r.querySelectorAll('button')].map((b) => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label') })),
      })),
      notes: [...li.querySelectorAll('.cl-notes .cl-note')].map((n) => n.dataset.warning),
      noteTexts: [...li.querySelectorAll('.cl-notes .cl-note')].map((n) => n.textContent),
      links: [...li.querySelectorAll('.cl-code-links .cl-link')].map((l) => l.textContent),
      raw: li.querySelector('details.cl-code-text p.cl-addr') ? li.querySelector('details.cl-code-text p.cl-addr').textContent : null,
      status: li.querySelector('.cl-status').textContent,
      anchors: li.querySelectorAll('a').length,
    })),
  };
})()`;

// The one mailto: anchor the page may carry ("Did CheckLink break your link? Email us").
export const REPORT_PREFIX = 'mailto:info@stormberry.as?subject=CheckLink%3A%20a%20cleaned%20link%20broke&body=';

// Reads a mailto: address back into { to, params: [names], subject, body }.
export function readMailto(href) {
  const m = /^mailto:([^?]*)\?(.*)$/.exec(href || '');
  if (!m) return null;
  const params = m[2].split('&').map((x) => x.split('='));
  const get = (n) => { const x = params.find((q) => q[0] === n); return x ? decodeURIComponent(x[1]) : null; };
  return { to: m[1], params: params.map((x) => x[0]), subject: get('subject'), body: get('body') };
}

// A snapshot of the result as the page shows it, for page.evaluate. Everything is read
// from the DOM, never from the page's own variables.
//
// RESULT_WORDS is the visible wording of the result (#result), closed sections and hidden
// rows included, with the addresses and parameter names themselves (.cl-addr) left out:
// those are the link's own text, not the page's words.
export const PAGE_STATE = `(() => {
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  // Seen on screen, not only read by a screen reader (hidden but named by aria-describedby,
  // or .visually-hidden).
  const seen = (el) => vis(el) && !el.closest('.visually-hidden');
  const txt = (id) => { const el = document.getElementById(id); return el ? el.textContent : null; };
  const rows = [...document.querySelectorAll('#parts-list .cl-check')].map((b) => {
    const row = b.closest('.cl-part');
    return {
      id: b.dataset.part, checked: b.checked, disabled: b.disabled, ticked: row.classList.contains('is-ticked'),
      labelled: !!b.getAttribute('aria-labelledby') && b.getAttribute('aria-labelledby').split(' ').every((x) => !!document.getElementById(x)),
      described: !!b.getAttribute('aria-describedby') && b.getAttribute('aria-describedby').split(' ').every((x) => !!document.getElementById(x)),
      name: row.querySelector('.cl-part-name')?.textContent, badge: row.querySelector('.cl-badge')?.textContent,
      provider: row.querySelector('.cl-part-provider')?.textContent || null, who: row.querySelector('.cl-part-who')?.textContent || null,
      told: row.querySelector('.cl-part-told')?.textContent || null,
      aff: row.querySelector('.cl-part-aff')?.textContent || null,
      note: row.querySelector('.cl-part-note[id$="-n"]')?.textContent || null,
      unrec: row.querySelector('.cl-tag')?.textContent || null,
      edge: getComputedStyle(row).borderLeftStyle,
      firstDescription: (() => { const d = (b.getAttribute('aria-describedby') || '').split(' ')[0]; const el = d && document.getElementById(d); return el ? el.textContent : null; })(),
      kind: row.querySelector('.cl-badge')?.dataset.kind || null, sharer: row.dataset.sharer === 'true',
      value: row.querySelector('.cl-part-value')?.textContent ?? null,
      same: row.querySelector('.cl-part-same')?.textContent || null, empty: row.dataset.empty === 'true',
      shownProvider: seen(row.querySelector('.cl-part-provider')) ? row.querySelector('.cl-part-provider').textContent : null,
      shownWho: seen(row.querySelector('.cl-part-who')) ? row.querySelector('.cl-part-who').textContent : null,
      shownTold: seen(row.querySelector('.cl-part-told')) ? row.querySelector('.cl-part-told').textContent : null,
    };
  });
  const keptRows = [...document.querySelectorAll('#kept-list .cl-check')].map((b) => {
    const row = b.closest('.cl-part');
    return {
      id: b.dataset.kept, checked: b.checked, disabled: b.disabled, ticked: row.classList.contains('is-ticked'),
      labelled: !!b.getAttribute('aria-labelledby') && b.getAttribute('aria-labelledby').split(' ').every((x) => !!document.getElementById(x)),
      described: !!b.getAttribute('aria-describedby') && b.getAttribute('aria-describedby').split(' ').every((x) => !!document.getElementById(x)),
      label: (b.getAttribute('aria-labelledby') || '').split(' ').map((x) => document.getElementById(x)?.textContent).join(' '),
      name: row.querySelector('.cl-part-name')?.textContent, value: row.querySelector('.cl-part-value')?.textContent,
      explain: row.querySelector('.cl-part-told')?.textContent, anyway: row.querySelector('.cl-anyway')?.textContent,
      edge: getComputedStyle(row).borderLeftStyle, reason: row.dataset.reason,
    };
  });
  const dels = (id) => [...document.querySelectorAll('#' + id + ' del.cl-removed')].map((d) => ({ text: d.textContent, part: d.dataset.part || null }));
  const keptMarks = (id) => [...document.querySelectorAll('#' + id + ' .cl-kept-part')].map((d) => ({ text: d.textContent, part: d.dataset.part || null }));
  const funcMarks = (id) => [...document.querySelectorAll('#' + id + ' .cl-func-part')].map((d) => ({ text: d.textContent, part: d.dataset.part || null }));
  const firstFunc = document.querySelector('#full-link .cl-func-part, #target-link .cl-func-part');
  const report = document.getElementById('report-link');
  const deco = (el) => el ? getComputedStyle(el).textDecorationLine : null;
  const firstDel = document.querySelector('#full-link del.cl-removed, #target-link del.cl-removed');
  const host = document.querySelector('#full-link .cl-host, #target-link .cl-host');
  return {
    result: vis(document.getElementById('result')),
    summary: txt('summary-line'), goes: vis(document.getElementById('goes-line')) ? txt('goes-line') : null,
    full: txt('full-link'), fullDel: dels('full-link'), fullKept: keptMarks('full-link'), fullFunc: funcMarks('full-link'),
    funcDecoration: firstFunc ? getComputedStyle(firstFunc).textDecorationStyle : null,
    funcColour: firstFunc ? getComputedStyle(firstFunc).textDecorationColor : null,
    keptColour: (() => { const k = document.querySelector('#full-link .cl-kept-part'); return k ? getComputedStyle(k).textDecorationColor : null; })(),
    keptRows, keptBlock: vis(document.getElementById('kept-block')),
    legend: [...document.querySelectorAll('#legend li')].filter(vis).map((li) => li.textContent),
    report: vis(document.getElementById('report-line')) ? { line: txt('report-line'), href: report.getAttribute('href') } : null,
    pin: vis(document.getElementById('pin-card')) ? { link: txt('pin-link'), status: txt('pin-status') } : null,
    place: vis(document.getElementById('place-card')) ? { link: txt('place-link'), status: txt('place-status'), help: txt('place-help'), title: txt('place-title'), button: txt('place-copy') } : null,
    target: vis(document.getElementById('target-block')) ? txt('target-link') : null, targetDel: dels('target-link'),
    invisible: [...document.querySelectorAll('#full-link .cl-invis, #target-link .cl-invis, #clean-link .cl-invis')].map((x) => x.textContent),
    keptMarkDecoration: (() => { const k = document.querySelector('#full-link .cl-kept-part'); return k ? getComputedStyle(k).textDecorationStyle : null; })(),
    host: host ? host.textContent : null, hostBold: host ? Number(getComputedStyle(host).fontWeight) >= 700 : null, hostUnderline: host ? deco(host) : null,
    delDecoration: deco(firstDel), delColour: firstDel ? getComputedStyle(firstDel).color : null,
    rows, count: vis(document.getElementById('parts-count')) ? txt('parts-count') : null,
    unrecognisedHelp: vis(document.getElementById('parts-unrecognised')) ? txt('parts-unrecognised') : null,
    clean: vis(document.getElementById('clean-link')) ? txt('clean-link') : null,
    cleanTitle: txt('clean-title'),
    shareNote: vis(document.getElementById('share-note')) ? txt('share-note') : null,
    warnCard: vis(document.getElementById('warn-card')),
    announcer: txt('announcer'),
    cleanLive: document.getElementById('clean-link').getAttribute('aria-live'),
    copy: vis(document.getElementById('copy-btn')), copyPrimary: document.getElementById('copy-btn').matches('.btn-primary'),
    share: vis(document.getElementById('share-btn')),
    go: vis(document.getElementById('go-btn')) ? txt('go-btn') : null,
    warnings: [...document.querySelectorAll('#warn-list .cl-note')].map((li) => li.dataset.warning),
    noWarnings: vis(document.getElementById('no-warnings')),
    short: vis(document.getElementById('short-notice')) ? txt('short-notice') : null,
    untouched: vis(document.getElementById('untouched-notice')) ? txt('untouched-notice') : null,
    stop: vis(document.getElementById('stop-notice')) ? txt('stop-notice') : null,
    others: [...document.querySelectorAll('#others-block .cl-link')].map((p) => p.textContent),
    status: txt('action-status'),
    rules: txt('rules-date'),
    dialog: document.getElementById('go-dialog').open,
    shares: window.__share ? window.__share.calls : null, clips: window.__clip ? window.__clip.calls : null, opened: window.__opened || null,
  };
})()`;

export const RESULT_WORDS = `(() => {
  const words = [];
  for (const id of ['result', 'picture-card']) {
    const copy = document.getElementById(id).cloneNode(true);
    for (const el of copy.querySelectorAll('.cl-addr, .cl-invis')) el.remove();
    words.push(copy.textContent.replace(/\\s+/g, ' '));
  }
  return words.join(' ');
})()`;

// Every element that could take a person, or the browser, to an address: anchors and
// areas with an href, and anything else carrying href, src, action, formaction, ping or
// srcset. Returns the attribute values, for checking that none of them is the analysed
// link (the page may only open it through Go to). The one exception the tests allow is the
// report line's mailto: (id report-link), which carries the links only as text in a
// message body; the tests check it on its own.
export const LINKISH = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('[href], [src], [action], [formaction], [ping], [srcset], [data]')) {
    for (const attr of ['href', 'src', 'action', 'formaction', 'ping', 'srcset', 'data']) {
      if (el.hasAttribute(attr)) out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, attr, value: el.getAttribute(attr), resolved: el[attr] && typeof el[attr] === 'string' ? el[attr] : null });
    }
  }
  return out;
})()`;

// The web addresses a code's card lists in its own block: those not already shown, whole, as
// one of its details (those get their Check this link button beside the detail). The same rule
// as linkPlaces() in app.js.
export function linksOutsideFields(p) {
  const used = new Set();
  return p.links.filter((link) => {
    const f = p.fields.findIndex((x, k) => !used.has(k) && !x.secret && (x.value === link || `https://${x.value}` === link));
    if (f >= 0) {
      used.add(f);
      return false;
    }
    return true;
  });
}

// Stage 3: what a browser that hides the camera picture from pages gives back when the page reads a
// frame (mode 'random': random values, see-through ones among them, as LibreWolf and Tor Browser
// give), or a real camera with its lens covered (mode 'dark': every pixel opaque black). It
// replaces getImageData for canvases of more than 10,000 pixels only, which in CheckLink is the
// hidden canvas the camera frames are drawn on.
export function frameReadStub(mode) {
  return `(() => {
  const real = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (x, y, w, h, ...rest) {
    const img = real.call(this, x, y, w, h, ...rest);
    if (w * h <= 10000) return img;
    const d = img.data;
    if (${JSON.stringify(mode)} === 'dark') {
      for (let i = 0; i < d.length; i += 4) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; }
    } else {
      for (let i = 0; i < d.length; i += 32) { const v = (Math.random() * 4294967296) >>> 0; for (let k = 0; k < 32 && i + k < d.length; k++) d[i + k] = (v >>> ((k % 4) * 8)) & 255; }
    }
    return img;
  };
})();`;
}

// Stage 3: a recorder around the browser's camera interface, for the camera tests. It does not
// replace the camera (the tests use Chromium's fake camera, --use-fake-device-for-media-stream),
// except with mode 'none', which answers every request for a camera as a device with no camera
// does (NotFoundError). It records:
//   window.__cam = { calls, enumerations, constraints: [JSON], streams: [MediaStream], recorders }
// calls counts getUserMedia, enumerations enumerateDevices; recorders counts every MediaRecorder
// made (CheckLink makes none: nothing is recorded).
export function cameraStub({ mode = 'record' } = {}) {
  return `(() => {
  window.__cam = { calls: 0, enumerations: 0, constraints: [], streams: [], recorders: 0 };
  const md = window.MediaDevices && MediaDevices.prototype;
  if (md && md.getUserMedia) {
    const gum = md.getUserMedia;
    md.getUserMedia = async function (c) {
      window.__cam.calls += 1;
      window.__cam.constraints.push(JSON.stringify(c));
      if (${mode === 'none' ? 'true' : 'false'}) throw new DOMException('Requested device not found', 'NotFoundError');
      const s = await gum.call(this, c);
      window.__cam.streams.push(s);
      return s;
    };
    const en = md.enumerateDevices;
    md.enumerateDevices = async function () {
      window.__cam.enumerations += 1;
      return en.call(this);
    };
  }
  if (typeof window.MediaRecorder === 'function') {
    const MR = window.MediaRecorder;
    window.MediaRecorder = function (...a) { window.__cam.recorders += 1; return new MR(...a); };
    window.MediaRecorder.prototype = MR.prototype;
  }
})();`;
}

// What the camera parts of the page show (stage 3), read from the DOM, plus the recorder's view of
// every stream the page was given: whether any track is still live.
export const CAMERA_STATE = `(() => {
  const vis = (el) => !!el && !el.hidden && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const card = document.getElementById('camera-card');
  const video = document.getElementById('cam-video');
  const btn = document.getElementById('cam-btn');
  const cam = window.__cam || { calls: 0, enumerations: 0, streams: [], recorders: 0, constraints: [] };
  const tracks = cam.streams.flatMap((s) => s.getTracks());
  return {
    button: vis(btn), buttonText: btn.textContent, help: vis(document.getElementById('cam-help')) ? document.getElementById('cam-help').textContent : null,
    expanded: btn.getAttribute('aria-expanded'),
    card: vis(card), state: card.dataset.state || null,
    status: document.getElementById('cam-status').textContent,
    picStatus: document.getElementById('pic-status').textContent,
    picError: document.getElementById('pic-status').classList.contains('is-error'),
    switchShown: vis(document.getElementById('cam-switch')),
    playing: !!video.srcObject && video.videoWidth > 0,
    srcObject: !!video.srcObject,
    focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName.toLowerCase() : null,
    calls: cam.calls, enumerations: cam.enumerations, constraints: cam.constraints, recorders: cam.recorders,
    tracks: tracks.length, live: tracks.filter((t) => t.readyState === 'live').length,
    pictureTitle: document.getElementById('picture-title').textContent,
  };
})()`;
