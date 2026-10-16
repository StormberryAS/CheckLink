// CheckLink's QR inspector: says in plain words what a code holds, before anything else
// happens. Pure ES module with no DOM and no network; runs in browsers and in Node 24. It never
// opens, joins, dials, sends, pays or starts anything: it only describes.
//
//   inspect(text, { bytes, format, contentType })   one decoded code -> Payload (below)
//   formatLabel(format)                             'QRCode' -> 'QR code'
//   MAX_TEXT                                        the longest text shown (longer is cut)
//
// Payload: {
//   kind:     'web' | 'text' | 'wifi' | 'contact' | 'event' | 'email' | 'phone' | 'sms' | 'geo' |
//             'payment' | 'app' | 'secret' | 'account-link' | 'script' | 'product' |
//             'boarding-pass' | 'health' | 'nostr' | 'binary' | 'empty',
//   tier:     'stop' | 'check' | 'info'   (the spec's three tiers: Stop, Check, Good to know)
//   title:    a short name for what it is ("Wi-Fi network details")
//   summary:  one sentence in CheckLink's own words. It never quotes the code's own text: names,
//             messages and addresses from the code go in fields, which the page shows as data.
//   fields:   [{ label, value, secret, copy, note, mono }]
//             secret: true -> shown hidden until the person asks (Show), copied only after a
//                     confirmation when the payload is Stop tier
//             copy:   the label of a Copy button for this value, or null
//             note:   a plain remark about this value (a checksum that passes or fails)
//   links:    web addresses inside it, each to be checked with the full link analysis
//   warnings: [{ id, tier, text }]
//   secret:   true when the code's own text must stay hidden until the person asks
//   text:     the code's text, cut to MAX_TEXT characters; truncated says whether it was cut
//   scheme:   the scheme or kind word it was recognised by (WIFI, mailto, bitcoin, ...), or null
// }
//
// Wording follows the spec: calm British English, no "safe", payment details "shown, never
// paid", and a secret is never shown in full by default.

import { findLinks, invisibleChunks, pctDecode } from './link-core.js?v=d248ac28';
import { domainInfo } from './domain.js?v=f1bcd492';
import { BIP39_ENGLISH } from './bip39.js?v=cdee66f2';
import { BIP39_LISTS, MONERO_ENGLISH, MONERO_LISTS, MONERO_PREFIX, SLIP39_WORDS } from './wordlists.js?v=24516436';
import {
  base32Length, base58Check, base64Bytes, bech32Decode, cborDecode, convertBits, crc16, crc32, gs1Valid, ibanValid,
  protoFields, quotedPrintable, rfValid, segwitDecode, sha256, toHex, utf8,
} from './payload-codecs.js?v=c65b0a72';

export const MAX_TEXT = 8000;

/** @typedef {'stop' | 'check' | 'info'} Tier */
/**
 * @typedef {'web' | 'text' | 'wifi' | 'contact' | 'event' | 'email' | 'phone' | 'sms' | 'geo' | 'payment' | 'app' |
 *   'secret' | 'account-link' | 'script' | 'product' | 'boarding-pass' | 'health' | 'nostr' | 'binary' | 'empty'} Kind
 */
/**
 * One detail of a payload, shown as data.
 * @typedef {object} PayloadField
 * @property {string} label
 * @property {string} value
 * @property {boolean} secret      shown hidden until the person asks (Show)
 * @property {string | null} copy  the label of a Copy button for this value, or null
 * @property {string | null} note  a plain remark about this value
 * @property {boolean} mono
 * @property {string} [copyValue]  what Copy puts on the clipboard, when it is not the value as shown
 */
/** @typedef {{ secret?: boolean, copy?: string | null, note?: string | null, mono?: boolean, copyValue?: string }} FieldExtra */
/** @typedef {{ id: string, tier: Tier, text: string }} PayloadWarning */
/**
 * What one reader below makes of a code, before inspect() adds what every payload carries.
 * @typedef {object} Draft
 * @property {Kind} kind
 * @property {Tier} tier
 * @property {string} title
 * @property {string} summary
 * @property {string | null} scheme
 * @property {PayloadField[]} fields
 * @property {string[]} links
 * @property {PayloadWarning[]} warnings
 * @property {boolean} secret
 * @property {number} [binaryLength]
 */
/**
 * What a code holds, in plain words (the header above).
 * @typedef {object} Payload
 * @property {Kind} kind
 * @property {Tier} tier
 * @property {string} title
 * @property {string} summary
 * @property {string | null} scheme
 * @property {PayloadField[]} fields
 * @property {string[]} links
 * @property {PayloadWarning[]} warnings
 * @property {boolean} secret
 * @property {string} text          the code's text, cut to MAX_TEXT characters
 * @property {boolean} truncated    whether text was cut
 * @property {number} length        the length of the code's whole text
 * @property {string | null} format
 * @property {string} formatLabel
 */
/** @typedef {{ bytes?: Uint8Array | null, format?: string | null, contentType?: string | null }} InspectOptions */
/** @typedef {{ bytes: Uint8Array | null, format: string | null, contentType: string | null }} ClassifyOptions */
/** @typedef {[string, string]} Pair */
// A table made with __proto__: null, so that a word from the code finds only its own names. The
// checker counts __proto__ as one more name, with the value null, hence the null.
/** @typedef {Record<string, string | null>} Names */

// == words ==

const NEVER_PAID = 'CheckLink shows payment details and never pays anything.';
const COMPARE_INVOICE = 'Compare the name, account and amount with the invoice or the person you expected, in your own bank or wallet app, before you pay.';
const WRITTEN_BY_MAKER = 'text written by whoever made this code';
const ANYONE_JOINS = 'Anyone who has this code, or a picture of it, can join this network.';
const OWNER_SEES = 'Joining a network lets its owner see which sites you visit.';
const NOT_SENT = 'CheckLink never sends it: your own app would, only if you choose to.';
const NOT_STARTED = 'CheckLink never starts it.';
const NEVER_SHARE = 'never share a picture of it';

/** @type {Record<string, string>} */
const FORMAT_LABELS = {
  QRCode: 'QR code', MicroQRCode: 'Micro QR code', RMQRCode: 'rMQR code', rMQRCode: 'rMQR code', QRCodeModel1: 'QR code', QRCodeModel2: 'QR code',
  Aztec: 'Aztec code', AztecCode: 'Aztec code', AztecRune: 'Aztec rune', DataMatrix: 'Data Matrix code', PDF417: 'PDF417 code', CompactPDF417: 'PDF417 code',
  MicroPDF417: 'MicroPDF417 code', MaxiCode: 'MaxiCode', EAN13: 'EAN-13 barcode', EAN8: 'EAN-8 barcode', UPCA: 'UPC-A barcode', UPCE: 'UPC-E barcode',
  ISBN: 'ISBN barcode', EANUPC: 'EAN/UPC barcode', Code128: 'Code 128 barcode', Code39: 'Code 39 barcode', Code39Std: 'Code 39 barcode', Code39Ext: 'Code 39 barcode',
  Code93: 'Code 93 barcode', Codabar: 'Codabar barcode', ITF: 'ITF barcode', ITF14: 'ITF-14 barcode', DataBar: 'GS1 DataBar', DataBarOmni: 'GS1 DataBar',
  DataBarStk: 'GS1 DataBar', DataBarStkOmni: 'GS1 DataBar', DataBarExp: 'GS1 DataBar Expanded', DataBarExpStk: 'GS1 DataBar Expanded', DataBarLtd: 'GS1 DataBar Limited',
  Code32: 'Code 32 barcode', PZN: 'pharmacy barcode (PZN)', Telepen: 'Telepen barcode', TelepenAlpha: 'Telepen barcode', TelepenNumeric: 'Telepen barcode',
};
/** @type {(f: string) => string} */
export const formatLabel = (f) => FORMAT_LABELS[f] || 'code';
const LINEAR = /^(EAN|UPC|ISBN|Code|Codabar|ITF|DataBar|PZN|Telepen)/;

// == small helpers ==

/** @type {(label: string, value: unknown, extra?: FieldExtra) => PayloadField} */
const field = (label, value, extra = {}) => ({ label, value: String(value ?? ''), secret: false, copy: null, note: null, mono: false, ...extra });
/** @type {(id: string, tier: Tier, text: string) => PayloadWarning} */
const warn = (id, tier, text) => ({ id, tier, text });
/** @type {Record<Tier, number>} */
const TIER = { stop: 0, check: 1, info: 2 };
/** @type {(a: Tier, b: Tier) => Tier} */
const higher = (a, b) => (TIER[a] <= TIER[b] ? a : b);
/** @type {(s: string) => string[]} */
const lines = (s) => s.split(/\r\n|\r|\n/);
/** @type {(s: string) => string} */
const safeDecode = (s) => {
  try {
    return pctDecode(s);
  } catch {
    return s;
  }
};
/** @type {(s: unknown) => string} */
const formDecode = (s) => safeDecode(String(s).replace(/\+/g, ' '));

/**
 * @param {unknown} q
 * @returns {Pair[]}
 */
function queryParams(q) {
  /** @type {Pair[]} */
  const out = [];
  for (const pair of String(q || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    out.push([formDecode(eq < 0 ? pair : pair.slice(0, eq)), eq < 0 ? '' : formDecode(pair.slice(eq + 1))]);
  }
  return out;
}
/** @type {(params: Pair[], ...names: string[]) => string | null} */
const param = (params, ...names) => {
  for (const n of names) {
    const hit = params.find(([k]) => k.toLowerCase() === n.toLowerCase());
    if (hit) return hit[1];
  }
  return null;
};
// Every value given for a name, in order: a code that gives the same name twice is read
// differently by different apps (some take the first, some the last).
/** @type {(params: Pair[], name: string, options?: { exact?: boolean }) => string[]} */
const paramsAll = (params, name, { exact = false } = {}) => params.filter(([k]) => (exact ? k === name : k.toLowerCase() === name.toLowerCase())).map(([, v]) => v);
/** @type {<T>(values: T[]) => T[]} */
const distinct = (values) => [...new Set(values)];

/** @type {Map<string, Intl.NumberFormat>} */
const money = new Map();
/**
 * @param {string | number | null} amount
 * @param {string | null | undefined} currency
 * @returns {string}
 */
function amountText(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${currency || ''} ${amount}`.trim();
  try {
    if (!currency) return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 8 }).format(n);
    let f = money.get(currency);
    if (!f) {
      f = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 8 });
      money.set(currency, f);
    }
    return f.format(n).replace(/\u00A0/g, ' ');
  } catch {
    return `${currency} ${amount}`;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** @type {(n: number) => string} */
const two = (n) => String(n).padStart(2, '0');
/**
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @returns {string | null}
 */
function dateText(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
// An iCalendar date or date-time (20261010, 20261010T180000, 20261010T180000Z) in words.
/**
 * @param {string} value
 * @param {string | null} tzid
 * @returns {string | null}
 */
function icalDate(value, tzid) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value || '').trim());
  if (!m) return value ? String(value) : null;
  const day = dateText(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!day) return String(value);
  if (!m[4]) return day;
  const zone = m[7] ? 'UTC' : tzid ? tzid : 'local time, no time zone given';
  return `${day}, ${m[4]}:${m[5]} (${zone})`;
}
/**
 * @param {number} seconds
 * @returns {string | null}
 */
function unixDate(seconds) {
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

// Text split on a separator that a backslash can escape (MECARD, WIFI, MATMSG).
/**
 * @param {string} s
 * @param {string} sep
 * @returns {string[]}
 */
function splitEscaped(s, sep) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
/** @type {(s: string) => string} */
const unescapeDocomo = (s) => s.replace(/\\(.)/g, '$1');

// key:value pairs of a DoCoMo-style body (MECARD, MATMSG, MEBKM, WIFI): [[KEY, value]].
/**
 * @param {string} body
 * @returns {Pair[]}
 */
function docomoPairs(body) {
  /** @type {Pair[]} */
  const out = [];
  for (const part of splitEscaped(body, ';')) {
    if (!part) continue;
    const c = part.indexOf(':');
    if (c <= 0) continue;
    out.push([part.slice(0, c).trim().toUpperCase(), part.slice(c + 1)]);
  }
  return out;
}

// == phone numbers ==

/**
 * @param {string} number
 * @param {{ sms?: boolean }} [options]
 * @returns {PayloadWarning[]}
 */
function phoneNotes(number, { sms = false } = {}) {
  /** @type {PayloadWarning[]} */
  const out = [];
  const digits = number.replace(/[\s().\-\u00A0]/g, '');
  if (/[*#]/.test(digits)) {
    out.push(warn('service-code', 'check', 'This number contains * or #. Dialled, it can run a phone service code instead of calling someone, for example one that forwards your calls to another number. Do not dial it unless you know what it does.'));
  } else if (/^\d{3,6}$/.test(digits)) {
    out.push(sms
      ? warn('short-number', 'check', 'This is a short number. Texts to short numbers can cost extra or sign you up to a paid service.')
      : warn('short-number', 'info', 'This is a short number. Calls to some short numbers cost extra.'));
  }
  return out;
}

// == Wi-Fi ==

/**
 * @param {string} text
 * @returns {Draft}
 */
function wifi(text) {
  const body = text.replace(/^WIFI:/i, '');
  // filter(Boolean) takes out the nulls, which the type of filter does not follow.
  const pairs = /** @type {Pair[]} */ (splitEscaped(body, ';').filter(Boolean).map((p) => {
    const c = p.indexOf(':');
    return c <= 0 ? null : [p.slice(0, c).trim().toUpperCase(), p.slice(c + 1)];
  }).filter(Boolean));
  /** @type {(k: string) => string | null} */
  const get = (k) => {
    const hit = pairs.find(([key]) => key === k);
    if (!hit) return null;
    let v = hit[1];
    // A value in double quotes is taken literally (a name that looks like hex).
    if (/^".*"$/s.test(v) && v.length >= 2) v = v.slice(1, -1);
    return unescapeDocomo(v);
  };
  const ssid = get('S');
  const type = (get('T') || '').trim();
  const pass = get('P');
  const hidden = /^true$/i.test(get('H') || '');
  const t = type.toUpperCase();
  let security;
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (!t && pass) {
    // No type, yet a password: phones that read this treat it as a protected network.
    security = 'Not stated in the code. It has a password, so it is probably WPA or WPA2';
  } else if (!t || t === 'NOPASS' || t === 'NONE') {
    security = 'Open: no password';
    warnings.push(warn('wifi-open', 'info', 'This network has no password, so others nearby can see what you send, unless a site encrypts it itself.'));
  } else if (t === 'WEP') {
    security = 'WEP (an old method)';
    warnings.push(warn('wifi-wep', 'info', 'This network uses WEP, an old method that others can break in minutes, so it is not really protected.'));
  } else if (t === 'SAE' || t === 'WPA3') security = 'WPA3 password';
  else if (/EAP/.test(t)) security = 'WPA2 Enterprise: sign-in with a user name';
  else if (t === 'WPA' || t === 'WPA2' || t === 'WPA/WPA2') security = 'WPA or WPA2 password';
  else security = `Other (${type})`;
  const fields = [
    field('Network name', ssid ?? '', { copy: 'Copy network name' }),
    field('Security', security),
    field('Hidden network', hidden ? 'Yes: it does not announce its name' : 'No'),
  ];
  if (pass) fields.push(field('Password', pass, { secret: true, copy: 'Copy password', mono: true }));
  const eap = get('E');
  if (eap) fields.push(field('Sign-in method', eap));
  const ident = get('I');
  if (ident) fields.push(field('User name', ident, { copy: 'Copy user name' }));
  const anon = get('A');
  if (anon) fields.push(field('Anonymous identity', anon));
  const ph2 = get('PH2');
  if (ph2) fields.push(field('Second sign-in step', ph2));
  warnings.unshift(warn('wifi-join', 'info', `${ANYONE_JOINS} ${OWNER_SEES}`));
  if (pass) warnings.push(warn('wifi-password', 'info', 'The password is hidden until you choose Show. CheckLink does not join the network.'));
  return {
    kind: 'wifi', tier: 'info', title: 'Wi-Fi network details', scheme: 'WIFI',
    summary: 'A Wi-Fi network: its name, the kind of security and, if it has one, the password. Nothing has been joined.',
    fields, warnings, secret: false, links: [],
  };
}

// == contacts ==

// What a contact card or event calls its web address may be something else: a script, or a link
// that starts an app. Each gets its own label and a warning, never "Web address".
/**
 * @param {string} v
 * @param {string[]} links
 * @param {PayloadWarning[]} warnings
 * @returns {PayloadField}
 */
function addressField(v, links, warnings) {
  const squeezed = v.trim().replace(/[\t\n\r]/g, '');
  const sch = (SCHEME.exec(squeezed) || [])[1];
  const hostPort = sch && /^\d{1,5}(?:[/?#]|$)/.test(squeezed.slice(sch.length + 1));
  if (SCRIPT.test(squeezed)) {
    warnings.push(warn('card-script', 'stop', 'Its web address is not a web address but a script or a file on the device. There is no reason to open it.'));
    return field('Link (a script, not a web address)', v);
  }
  if (sch && !hostPort && !/^https?$/i.test(sch)) {
    warnings.push(warn('card-app', 'check', `Its web address is not a web address: it is a ${sch.toLowerCase()}: link, which starts an app.`));
    return field('Link (starts an app, not a web address)', v);
  }
  links.push(...linksIn(v));
  return field('Web address', v);
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function mecard(text) {
  const pairs = docomoPairs(text.replace(/^MECARD:/i, ''));
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {string[]} */
  const links = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  for (const [k, raw] of pairs) {
    const v = unescapeDocomo(raw);
    if (!v) continue;
    if (k === 'N') fields.push(field('Name', v.includes(',') ? v.split(',').reverse().map((x) => x.trim()).join(' ') : v));
    else if (k === 'SOUND') fields.push(field('Name (how it sounds)', v));
    else if (k === 'TEL' || k === 'TEL-AV') fields.push(field('Phone', v, { copy: 'Copy number' }));
    else if (k === 'EMAIL') fields.push(field('Email', v, { copy: 'Copy address' }));
    else if (k === 'URL') fields.push(addressField(v, links, warnings));
    else if (k === 'ADR') fields.push(field('Address', v.split(',').map((x) => x.trim()).filter(Boolean).join(', ')));
    else if (k === 'ORG') fields.push(field('Organisation', v));
    else if (k === 'BDAY') fields.push(field('Birthday', /^\d{8}$/.test(v) ? dateText(Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6))) || v : v));
    else if (k === 'NOTE') {
      fields.push(field('Note', v));
      links.push(...linksIn(v));
    } else if (k === 'NICKNAME') fields.push(field('Nickname', v));
  }
  return contactPayload(fields, links, 'MECARD', warnings);
}

// vCard 2.1 to 4.0: folded lines joined, quoted-printable read, escapes undone.
/**
 * @param {string} text
 * @returns {VLine[]}
 */
function vcardLines(text) {
  const raw = lines(text);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    // A quoted-printable value ends a line with = to continue it.
    while (/QUOTED-PRINTABLE/i.test(line) && line.endsWith('=') && i + 1 < raw.length) line = line.slice(0, -1) + raw[++i];
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  // filter(Boolean) takes out the nulls, which the type of filter does not follow.
  return /** @type {VLine[]} */ (out.map((l) => {
    const colon = l.indexOf(':');
    if (colon <= 0) return null;
    const head = l.slice(0, colon).split(';');
    const name = head[0].replace(/^[^.]*\./, '').toUpperCase();
    const params = head.slice(1).map((p) => p.toUpperCase());
    let value = l.slice(colon + 1);
    if (params.some((p) => p === 'QUOTED-PRINTABLE' || p === 'ENCODING=QUOTED-PRINTABLE')) {
      const cs = (params.find((p) => p.startsWith('CHARSET=')) || 'CHARSET=UTF-8').slice(8).toLowerCase();
      value = quotedPrintable(value, cs);
    }
    return { name, params, value };
  }).filter(Boolean));
}
/** @type {(s: string) => string} */
const vUnescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;:\\])/g, '$1');
/** @type {(s: string) => string[]} */
const vParts = (s) => splitEscaped(s, ';').map(vUnescape);
/** @type {(params: string[]) => string} */
const typeOf = (params) => {
  const t = params.flatMap((p) => p.replace(/^TYPE=/, '').split(',')).map((x) => x.toLowerCase()).filter((x) => ['cell', 'mobile', 'home', 'work', 'fax'].includes(x)).map((x) => (x === 'cell' ? 'mobile' : x));
  return t.length ? ` (${[...new Set(t)].join(', ')})` : '';
};

/** @typedef {{ name: string, params: string[], value: string }} VLine */
/**
 * @param {string} text
 * @returns {Draft}
 */
function vcard(text) {
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {string[]} */
  const links = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  let name = null;
  for (const { name: n, params, value } of vcardLines(text)) {
    if (!value || n === 'BEGIN' || n === 'END' || n === 'VERSION' || n === 'PRODID' || n === 'REV' || n === 'UID') continue;
    if (n === 'FN') name = vUnescape(value);
    else if (n === 'N' && !name) name = vParts(value).slice(0, 3).reverse().filter(Boolean).join(' ') || null;
    else if (n === 'TEL') fields.push(field(`Phone${typeOf(params)}`, vUnescape(value).replace(/^tel:/i, ''), { copy: 'Copy number' }));
    else if (n === 'EMAIL') fields.push(field(`Email${typeOf(params)}`, vUnescape(value), { copy: 'Copy address' }));
    else if (n === 'ORG') fields.push(field('Organisation', vParts(value).filter(Boolean).join(', ')));
    else if (n === 'TITLE' || n === 'ROLE') fields.push(field('Job title', vUnescape(value)));
    else if (n === 'ADR') fields.push(field(`Address${typeOf(params)}`, vParts(value).filter(Boolean).join(', ')));
    else if (n === 'URL') fields.push(addressField(vUnescape(value), links, warnings));
    else if (n === 'X-SOCIALPROFILE' || n === 'IMPP') {
      const v = vUnescape(value);
      fields.push(field('Profile', v));
      links.push(...linksIn(v));
    } else if (n === 'NOTE') {
      const v = vUnescape(value);
      fields.push(field('Note', v));
      links.push(...linksIn(v));
    } else if (n === 'BDAY') {
      const v = vUnescape(value);
      const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
      fields.push(field('Birthday', m ? dateText(Number(m[1]), Number(m[2]), Number(m[3])) || v : v));
    } else if (n === 'NICKNAME') fields.push(field('Nickname', vUnescape(value)));
    else if (n === 'PHOTO' || n === 'LOGO') {
      fields.push(field(n === 'PHOTO' ? 'Photo' : 'Logo', /^https?:|^www\./i.test(value) ? 'A link to a picture. CheckLink does not load it.' : 'A picture inside the card. CheckLink does not show it.'));
    }
  }
  if (name) fields.unshift(field('Name', name));
  return contactPayload(fields, links, 'vCard', warnings);
}

/**
 * @param {PayloadField[]} fields
 * @param {string[]} links
 * @param {string} scheme
 * @param {PayloadWarning[]} [warnings]
 * @returns {Draft}
 */
function contactPayload(fields, links, scheme, warnings = []) {
  return {
    kind: 'contact', tier: 'info', title: 'A contact card', scheme,
    summary: 'A contact card: the details someone wants you to save. Nothing has been saved.',
    fields, links, warnings, secret: false,
  };
}

// == calendar events ==

/**
 * @param {string} text
 * @returns {Draft}
 */
function vevent(text) {
  const all = vcardLines(text);
  const start = all.findIndex((l) => l.name === 'BEGIN' && /^VEVENT$/i.test(l.value.trim()));
  const end = all.findIndex((l, i) => i > start && l.name === 'END' && /^VEVENT$/i.test(l.value.trim()));
  const props = start >= 0 ? all.slice(start + 1, end > start ? end : undefined) : all;
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {string[]} */
  const links = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  /** @type {(params: string[]) => string | null} */
  const tz = (params) => {
    const p = params.find((x) => x.startsWith('TZID='));
    return p ? p.slice(5) : null;
  };
  /** @type {(n: string) => string | null} */
  const tzRaw = (n) => {
    // Time zone names keep their capitals (Europe/Oslo): read them from the text itself.
    const m = new RegExp(`^${n}(?:;[^:]*)?;TZID=([^;:]+)`, 'im').exec(text);
    return m ? m[1] : null;
  };
  for (const { name, params, value } of props) {
    const v = vUnescape(value);
    if (!v) continue;
    if (name === 'SUMMARY') fields.push(field('Title', v));
    else if (name === 'DTSTART') fields.push(field('Starts', icalDate(v, tz(params) && tzRaw('DTSTART'))));
    else if (name === 'DTEND') fields.push(field('Ends', icalDate(v, tz(params) && tzRaw('DTEND'))));
    else if (name === 'LOCATION') {
      fields.push(field('Where', v));
      links.push(...linksIn(v));
    } else if (name === 'DESCRIPTION') {
      fields.push(field('Description', v));
      links.push(...linksIn(v));
    } else if (name === 'URL') fields.push(addressField(v, links, warnings));
    else if (name === 'ORGANIZER') fields.push(field('Organiser', v.replace(/^mailto:/i, '')));
    else if (name === 'RRULE') fields.push(field('Repeats', v));
  }
  return {
    kind: 'event', tier: 'info', title: 'A calendar event', scheme: 'iCalendar',
    summary: 'A calendar event: its title, time and place. Nothing has been added to a calendar.',
    fields, links, warnings, secret: false,
  };
}

// == email, phone, text messages ==

/**
 * @param {string} text
 * @returns {Draft}
 */
function email(text) {
  /** @type {string[]} */
  let to = [];
  let cc = null;
  let bcc = null;
  let subject = null;
  let body = null;
  /** @type {string[]} */
  let attach = [];
  if (/^mailto:/i.test(text)) {
    const rest = text.slice(7);
    const q = rest.indexOf('?');
    to = (q < 0 ? rest : rest.slice(0, q)).split(',').map(safeDecode).map((x) => x.trim()).filter(Boolean);
    const params = q < 0 ? [] : String(rest.slice(q + 1)).split('&').map((p) => {
      const eq = p.indexOf('=');
      return /** @type {Pair} */ ([safeDecode(eq < 0 ? p : p.slice(0, eq)), eq < 0 ? '' : safeDecode(p.slice(eq + 1))]);
    });
    const extraTo = param(params, 'to');
    if (extraTo) to.push(...extraTo.split(',').map((x) => x.trim()).filter(Boolean));
    cc = param(params, 'cc');
    bcc = param(params, 'bcc');
    subject = param(params, 'subject');
    body = param(params, 'body');
    // Not part of the mailto standard, but some email apps attach the file named here, from
    // the device, without asking (Mueller and others, "Mailto: Me Your Secrets", 2020).
    attach = params.filter(([k]) => /^attach(?:ment)?s?$/i.test(k.trim())).map(([, v]) => v).filter(Boolean);
  } else if (/^MATMSG:/i.test(text)) {
    const pairs = docomoPairs(text.slice(7));
    /** @type {(k: string) => string | null} */
    const g = (k) => {
      const hit = pairs.find(([key]) => key === k);
      return hit ? unescapeDocomo(hit[1]) : null;
    };
    to = (g('TO') || '').split(',').map((x) => x.trim()).filter(Boolean);
    subject = g('SUB');
    body = g('BODY');
  } else {
    // SMTP:to:subject:body
    const parts = text.slice(5).split(':');
    to = [parts[0]].filter(Boolean);
    subject = parts[1] || null;
    body = parts.slice(2).join(':') || null;
  }
  /** @type {PayloadField[]} */
  const fields = [];
  for (const t of to) fields.push(field('To', t, { copy: 'Copy address' }));
  if (cc) fields.push(field('Copy to (cc)', cc));
  if (bcc) fields.push(field('Hidden copy (bcc)', bcc));
  if (subject) fields.push(field('Subject', subject));
  if (body) fields.push(field('Message', body, { copy: 'Copy message' }));
  for (const a of attach) fields.push(field('File it asks to attach', a, { mono: true }));
  const warnings = [warn('not-sent', 'info', `An email ready to send. ${NOT_SENT}`)];
  /** @type {Tier} */
  let tier = 'info';
  if (bcc) {
    tier = 'check';
    warnings.push(warn('bcc', 'check', 'This email would also go, as a hidden copy, to the address under Hidden copy. The other recipients would not see that.'));
  }
  if (attach.length) {
    tier = 'check';
    warnings.push(warn('attach', 'check', 'This email asks your email app to attach a file from your device, under File it asks to attach. Some email apps have attached such files without asking. Do not send it.'));
  }
  return {
    kind: 'email', tier, title: 'An email to send', scheme: /^mailto:/i.test(text) ? 'mailto' : /^MATMSG:/i.test(text) ? 'MATMSG' : 'SMTP',
    summary: 'An email someone has written for you to send: who it goes to, the subject and the message. Nothing has been sent.',
    fields, links: [...linksIn(body || ''), ...linksIn(subject || '')], warnings, secret: false,
  };
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function phone(text) {
  const raw = safeDecode(text.replace(/^tel:/i, ''));
  const number = raw.split(';')[0].trim();
  const ext = (/;ext=([^;]+)/i.exec(raw) || [])[1];
  const fields = [field('Number', number, { copy: 'Copy number' })];
  if (ext) fields.push(field('Extension', ext));
  const notes = phoneNotes(number);
  const tier = notes.reduce((t, w) => higher(t, w.tier), /** @type {Tier} */ ('info'));
  return {
    kind: 'phone', tier, title: /[*#]/.test(number) ? 'A phone service code' : 'A phone number to call', scheme: 'tel',
    summary: 'A phone number to call. Nothing has been dialled.',
    fields, links: [], warnings: [warn('not-called', 'info', 'CheckLink never calls it: your phone would, only if you choose to.'), ...notes], secret: false,
  };
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function sms(text) {
  let number;
  let body = null;
  const m = /^(?:sms|mms)to:([^:]*):?(.*)$/is.exec(text);
  if (m) {
    number = m[1];
    body = m[2] || null;
  } else {
    const rest = text.replace(/^(?:sms|mms):/i, '');
    const q = rest.search(/[?]|;\?|&body=/i);
    number = safeDecode(q < 0 ? rest : rest.slice(0, q)).replace(/;$/, '');
    const query = q < 0 ? '' : rest.slice(q).replace(/^;?\??&?/, '');
    body = param(query.split('&').map((p) => {
      const eq = p.indexOf('=');
      return /** @type {Pair} */ ([safeDecode(eq < 0 ? p : p.slice(0, eq)), eq < 0 ? '' : safeDecode(p.slice(eq + 1))]);
    }), 'body');
  }
  const numbers = number.split(',').map((x) => x.trim()).filter(Boolean);
  const fields = numbers.map((n) => field('To', n, { copy: 'Copy number' }));
  if (body) fields.push(field('Message', body, { copy: 'Copy message' }));
  const notes = numbers.flatMap((n) => phoneNotes(n, { sms: true }));
  const tier = notes.reduce((t, w) => higher(t, w.tier), /** @type {Tier} */ ('info'));
  return {
    kind: 'sms', tier, title: 'A text message to send', scheme: 'sms',
    summary: 'A text message someone has written for you to send: the number and the message. Nothing has been sent.',
    fields, links: linksIn(body || ''), warnings: [warn('not-sent', 'info', `A text message ready to send. ${NOT_SENT}`), ...dedupe(notes)], secret: false,
  };
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function geo(text) {
  const rest = text.replace(/^geo:/i, '');
  const q = rest.indexOf('?');
  const head = q < 0 ? rest : rest.slice(0, q);
  const [coords, ...opts] = head.split(';');
  const [lat, lng, alt] = coords.split(',').map((x) => x.trim());
  const params = queryParams(q < 0 ? '' : rest.slice(q + 1));
  /** @type {PayloadField[]} */
  const fields = [];
  const nLat = Number(lat);
  const nLng = Number(lng);
  const ok = /^-?\d{1,3}(\.\d+)?$/.test(lat || '') && /^-?\d{1,3}(\.\d+)?$/.test(lng || '') && Math.abs(nLat) <= 90 && Math.abs(nLng) <= 180;
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (ok && !(nLat === 0 && nLng === 0)) {
    fields.push(field('Latitude', lat), field('Longitude', lng));
    fields.push(field('Coordinates', `${lat}, ${lng}`, { copy: 'Copy coordinates' }));
  } else if (!(nLat === 0 && nLng === 0)) {
    warnings.push(warn('geo-bad', 'info', 'These coordinates are not a place on Earth: latitude goes to 90 and longitude to 180.'));
    fields.push(field('Coordinates as written', coords));
  }
  if (alt && /^-?\d+(\.\d+)?$/.test(alt)) fields.push(field('Height', `${alt} metres`));
  const u = opts.map((o) => /^u=([\d.]+)$/i.exec(o)).find(Boolean);
  if (u) fields.push(field('Accuracy', `about ${u[1]} metres`));
  const label = param(params, 'q');
  if (label) fields.push(field('Label or search', label, { copy: 'Copy label' }));
  return {
    kind: 'geo', tier: 'info', title: 'A place on a map', scheme: 'geo',
    summary: 'A place on a map, given by its coordinates. Nothing has been opened.',
    fields, links: [], warnings, secret: false,
  };
}

// == payments ==

// Who gets paid and how much come first in a payment card; the rest keeps its order.
/** @type {(f: PayloadField) => number} */
const PAY_ORDER = (f) => (/^Pay to/.test(f.label) ? 0 : /^Amount/.test(f.label) ? 1 : 2);

/**
 * @param {string} scheme
 * @param {string} title
 * @param {PayloadField[]} fields
 * @param {PayloadWarning[]} warnings
 * @param {{ amount?: string | null, links?: string[], tier?: Tier }} [options]
 * @returns {Draft}
 */
function paymentPayload(scheme, title, fields, warnings, { amount = null, links = [], tier = 'check' } = {}) {
  const lead = amount ? `A request to pay ${amount}.` : 'A payment request.';
  const ordered = fields.map((f, i) => /** @type {[PayloadField, number]} */ ([f, i])).sort((a, b) => PAY_ORDER(a[0]) - PAY_ORDER(b[0]) || a[1] - b[1]).map(([f]) => f);
  return {
    kind: 'payment', tier, title, scheme,
    summary: `${lead} ${NEVER_PAID}`,
    fields: ordered, links, secret: false,
    warnings: [warn('never-paid', 'check', COMPARE_INVOICE), ...warnings],
  };
}

// The length of an IBAN in each country (SWIFT's IBAN registry): check digits can pass on a
// number of the wrong length, so the length is checked too.
/** @type {Record<string, number>} */
const IBAN_LENGTH = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18,
  DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23,
  IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27,
  MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27,
  ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/**
 * @param {string} iban
 * @param {string} [label]
 * @returns {[PayloadField, boolean]}
 */
function ibanField(iban, label = 'Account (IBAN)') {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  const want = IBAN_LENGTH[s.slice(0, 2)];
  const badLength = want && s.length !== want;
  const ok = !badLength && ibanValid(s);
  const note = badLength
    ? `It has ${s.length} characters, but account numbers from ${s.slice(0, 2)} have ${want}, so it is mistyped or changed.`
    : ok ? 'Its check digits pass, so a typing mistake is unlikely. That does not show whose account it is.' : 'Its check digits do not pass: it may be mistyped or changed.';
  return [field(label, s.replace(/(.{4})/g, '$1 ').trim(), { copy: 'Copy account number', mono: true, note }), ok];
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function epc(text) {
  const L = lines(text);
  const version = (L[1] || '').trim();
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  const bic = (L[4] || '').trim();
  const name = (L[5] || '').trim();
  const iban = (L[6] || '').trim();
  const amt = (L[7] || '').trim();
  const purpose = (L[8] || '').trim();
  const ref = (L[9] || '').trim();
  const msg = (L[10] || '').trim();
  const info = (L[11] || '').trim();
  if (name) fields.push(field('Pay to', name));
  if (iban) {
    const [f, ok] = ibanField(iban);
    fields.push(f);
    if (!ok) warnings.push(warn('iban-check', 'check', 'The account number does not pass its own check digits: it may be mistyped or changed.'));
  }
  if (bic) fields.push(field('Bank (BIC)', bic, { mono: true }));
  let amount = null;
  const am = /^([A-Z]{3})(\d{1,9}(?:\.\d{1,2})?)$/.exec(amt);
  if (am) {
    amount = amountText(am[2], am[1]);
    fields.push(field('Amount', amount, { copy: 'Copy amount' }));
  } else if (amt) fields.push(field('Amount as written', amt));
  if (ref) fields.push(field('Reference', ref, { copy: 'Copy reference', mono: true, note: /^RF/i.test(ref) ? (rfValid(ref) ? 'A structured creditor reference; its check digits pass.' : 'Its check digits do not pass: it may be mistyped.') : null }));
  if (msg) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, msg));
  if (purpose) fields.push(field('Purpose code', purpose));
  if (info) fields.push(field(`Note to the payer (${WRITTEN_BY_MAKER})`, info));
  if (!['001', '002'].includes(version)) warnings.push(warn('epc-version', 'info', 'This payment code says it follows a version of the European payment code format that CheckLink does not know.'));
  return paymentPayload('EPC', 'A SEPA bank transfer (EPC payment code)', fields, warnings, { amount });
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function swissBill(text) {
  const L = lines(text);
  /** @type {(i: number) => string} */
  const at = (i) => (L[i] || '').trim();
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (at(5)) fields.push(field('Pay to', at(5)));
  const addr = [at(6), at(7), [at(8), at(9)].filter(Boolean).join(' '), at(10)].filter(Boolean).join(', ');
  if (addr) fields.push(field('Their address', addr));
  if (at(3)) {
    const [f, ok] = ibanField(at(3));
    fields.push(f);
    if (!ok) warnings.push(warn('iban-check', 'check', 'The account number does not pass its own check digits: it may be mistyped or changed.'));
  }
  let amount = null;
  if (at(18) && /^\d{1,9}(\.\d{1,2})?$/.test(at(18))) {
    amount = amountText(at(18), /^(CHF|EUR)$/.test(at(19)) ? at(19) : null);
    fields.push(field('Amount', amount, { copy: 'Copy amount' }));
  } else fields.push(field('Amount', 'Not given: you would type it yourself'));
  if (at(21)) fields.push(field('Payer named in the bill', at(21)));
  if (at(28)) fields.push(field('Reference', at(28), { copy: 'Copy reference', mono: true }));
  if (at(29)) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, at(29)));
  if (at(31)) fields.push(field('Billing information', at(31)));
  return paymentPayload('SPC', 'A Swiss QR-bill', fields, warnings, { amount });
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function czechSpd(text) {
  // filter(Boolean) takes out the nulls, which the type of filter does not follow.
  const pairs = /** @type {Pair[]} */ (text.split('*').slice(2).map((p) => {
    const c = p.indexOf(':');
    return c <= 0 ? null : [p.slice(0, c).toUpperCase(), p.slice(c + 1)];
  }).filter(Boolean));
  /** @type {(k: string) => string | null} */
  const g = (k) => (pairs.find(([key]) => key === k) || [])[1] ?? null;
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (g('RN')) fields.push(field('Pay to', g('RN')));
  // Below, a value read again after a test that it is there is cast to string: g gives the same
  // answer each time.
  if (g('ACC')) {
    const [iban, bic] = /** @type {string} */ (g('ACC')).split('+');
    const [f, ok] = ibanField(iban);
    fields.push(f);
    if (bic) fields.push(field('Bank (BIC)', bic, { mono: true }));
    if (!ok) warnings.push(warn('iban-check', 'check', 'The account number does not pass its own check digits: it may be mistyped or changed.'));
  }
  // ALT-ACC: other accounts a bank app may pay to instead of ACC. Shown, so none is hidden.
  const alt = (g('ALT-ACC') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
  for (const a of alt) {
    const [iban, bic] = a.split('+');
    const [f, ok] = ibanField(iban, 'Other account the bank app may pay to');
    fields.push(f);
    if (bic) fields.push(field('Its bank (BIC)', bic, { mono: true }));
    if (!ok) warnings.push(warn('iban-check', 'check', 'An account number does not pass its own check digits: it may be mistyped or changed.'));
  }
  if (alt.length) warnings.push(warn('alt-account', 'check', 'This code names more than one account. A bank app may pay to any of them, so check them all against the invoice.'));
  let amount = null;
  if (g('AM') && /^\d+(\.\d{1,2})?$/.test(/** @type {string} */ (g('AM')))) {
    amount = amountText(g('AM'), /^[A-Z]{3}$/.test(g('CC') || '') ? g('CC') : null);
    fields.push(field('Amount', amount, { copy: 'Copy amount' }));
  }
  if (g('X-VS')) fields.push(field('Variable symbol (reference)', g('X-VS'), { copy: 'Copy reference', mono: true }));
  if (g('MSG')) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, g('MSG')));
  if (g('DT')) {
    const dt = /** @type {string} */ (g('DT'));
    fields.push(field('Due', /^\d{8}$/.test(dt) ? dateText(Number(dt.slice(0, 4)), Number(dt.slice(4, 6)), Number(dt.slice(6))) || dt : dt));
  }
  return paymentPayload('SPD', 'A bank transfer (Czech short payment descriptor)', fields, warnings, { amount });
}

// Bitcoin addresses: base58 (1..., 3..., m/n/2 on test networks) or segwit (bc1...).
/**
 * @param {unknown} addr
 * @returns {{ ok: boolean, network: string | null }}
 */
function btcAddress(addr) {
  const a = String(addr || '');
  const seg = /^(bc|tb|bcrt)1/i.test(a) ? segwitDecode(a) : null;
  if (seg) return { ok: true, network: seg.hrp === 'bc' ? 'Bitcoin' : 'a Bitcoin test network' };
  const b = base58Check(a);
  if (b && b.length === 21 && [0x00, 0x05].includes(b[0])) return { ok: true, network: 'Bitcoin' };
  if (b && b.length === 21 && [0x6f, 0xc4].includes(b[0])) return { ok: true, network: 'a Bitcoin test network' };
  return { ok: false, network: null };
}

/**
 * @param {string} btc
 * @returns {string | null}
 */
function btcAmount(btc) {
  if (!/^\d{1,8}(\.\d{1,8})?$/.test(btc)) return null;
  const [w, f = ''] = btc.split('.');
  const sats = BigInt(w) * 100000000n + BigInt((f + '00000000').slice(0, 8));
  return `${btc} BTC (${new Intl.NumberFormat('en-GB').format(sats)} sats)`;
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function bitcoin(text) {
  const rest = text.replace(/^bitcoin:/i, '');
  const q = rest.indexOf('?');
  const addr = q < 0 ? rest : rest.slice(0, q);
  const params = queryParams(q < 0 ? '' : rest.slice(q + 1));
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  /** @type {string[]} */
  const links = [];
  let amount = null;
  if (addr) {
    const v = btcAddress(addr);
    fields.push(field('Pay to (address)', addr, { copy: 'Copy address', mono: true, note: v.ok ? `A ${v.network} address; its checksum passes, so a typing mistake is unlikely. That does not show who owns it.` : 'This is not a valid Bitcoin address: its checksum does not pass.' }));
    if (!v.ok) warnings.push(warn('address-check', 'check', 'The address does not pass its own checksum: it may be mistyped or changed.'));
  }
  // BIP 21: "the rest of the URI is case-sensitive, including the query parameter keys", so
  // AMOUNT= is not the amount. A key given twice is read differently by different wallets
  // (Bitcoin Core takes the last), so every value is shown.
  /** @type {(name: string) => string | null} */
  const one = (name) => paramsAll(params, name, { exact: true }).at(-1) ?? null;
  const amounts = distinct(paramsAll(params, 'amount', { exact: true }));
  if (amounts.length === 1) {
    amount = btcAmount(amounts[0]);
    fields.push(field('Amount', amount || amounts[0], { copy: 'Copy amount' }));
  } else if (amounts.length > 1) {
    fields.push(field('Amount', amounts.map((a) => btcAmount(a) || a).join(' or ')));
    warnings.push(warn('amount-twice', 'check', 'The amount is given more than once, with different values, and wallets do not agree on which one counts. Check the amount your wallet shows before you pay.'));
  }
  const label = one('label');
  if (label) fields.push(field(`Label (${WRITTEN_BY_MAKER})`, label));
  const message = one('message');
  if (message) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, message));
  const ln = one('lightning');
  if (ln) {
    const inv = bolt11(ln);
    fields.push(field('Lightning payment request', ln, { copy: 'Copy payment request', mono: true, note: inv ? 'The same payment, for a Lightning wallet; its details are below.' : 'Not a readable Lightning payment request.' }));
    if (inv) fields.push(...inv.fields.map((f) => ({ ...f, label: `Lightning: ${f.label}` })));
  }
  const pj = one('pj');
  if (pj) {
    fields.push(field('Payjoin address', pj));
    links.push(...linksIn(pj));
  }
  warnings.push(warn('irreversible', 'check', 'A Bitcoin payment cannot be undone once sent. Compare the address with the one you expected, character by character.'));
  return paymentPayload('bitcoin', 'A Bitcoin payment request', fields, warnings, { amount, links });
}

// BOLT 11 Lightning payment requests: amount, description, times and payee from the request
// itself (the signature is not checked; CheckLink only describes).
/**
 * @param {unknown} raw
 * @returns {{ fields: PayloadField[], amount: string | null, expired: boolean, network: string, badAmount: boolean } | null}
 */
function bolt11(raw) {
  const inv = String(raw || '').trim();
  const d = bech32Decode(inv);
  if (!d || d.variant !== 'bech32') return null;
  const m = /^ln(bcrt|tbs|bc|tb|sb)(\d+)?([munp])?$/.exec(d.hrp);
  if (!m || d.data.length < 7 + 104) return null;
  const data = d.data;
  let ts = 0;
  for (let i = 0; i < 7; i++) ts = ts * 32 + data[i];
  /** @type {PayloadField[]} */
  const fields = [];
  let msat = null;
  let badAmount = false;
  if (m[2]) {
    const n = BigInt(m[2]);
    const mult = { m: 100000000n, u: 100000n, n: 100n, p: null }[m[3] || ''] ?? 100000000000n;
    if (m[3] === 'p') {
      // A pico-bitcoin amount must be whole millisatoshis.
      if (n % 10n === 0n) msat = n / 10n;
      else badAmount = true;
    } else msat = n * mult;
  }
  let desc = null;
  let expiry = 3600;
  let payee = null;
  let descHash = false;
  for (let i = 7; i + 3 <= data.length - 104;) {
    const type = data[i];
    const len = data[i + 1] * 32 + data[i + 2];
    const val = data.slice(i + 3, i + 3 + len);
    if (i + 3 + len > data.length - 104) break;
    if (type === 13) {
      const bytes = convertBits(val, 5, 8, false) || convertBits(val, 5, 8, true);
      try {
        desc = bytes ? new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) : null;
      } catch {
        desc = null;
      }
    } else if (type === 6) {
      expiry = val.reduce((a, v) => a * 32 + v, 0);
    } else if (type === 19) {
      const b = convertBits(val, 5, 8, false);
      if (b && b.length === 33) payee = toHex(b);
    } else if (type === 23) descHash = true;
    i += 3 + len;
  }
  // The pattern above lets m[1] be only one of these names.
  const network = /** @type {Record<string, string>} */ ({ bc: 'Bitcoin', tb: 'Bitcoin test network', tbs: 'Bitcoin signet', bcrt: 'Bitcoin regtest', sb: 'Bitcoin simnet' })[m[1]];
  let amount = null;
  if (msat !== null) {
    const sats = msat / 1000n;
    const rem = msat % 1000n;
    const fmt = new Intl.NumberFormat('en-GB').format(sats);
    const btc = (Number(msat) / 1e11).toLocaleString('en-GB', { maximumFractionDigits: 11 });
    amount = `${fmt}${rem ? `.${String(rem).padStart(3, '0').replace(/0+$/, '')}` : ''} sats (${btc} BTC)`;
    fields.push(field('Amount', amount));
  } else if (badAmount) fields.push(field('Amount', 'Not readable: written finer than a payment can be'));
  else fields.push(field('Amount', 'Not given: your wallet would ask you'));
  if (desc) fields.push(field(`Description (${WRITTEN_BY_MAKER})`, desc));
  else if (descHash) fields.push(field('Description', 'Not in the request itself (only a fingerprint of it)'));
  const created = unixDate(ts);
  if (created) fields.push(field('Created', created));
  const expires = unixDate(ts + expiry);
  if (expires) fields.push(field('Expires', expires));
  if (payee) fields.push(field('Payee node', payee, { mono: true }));
  fields.push(field('Network', network));
  const expired = (ts + expiry) * 1000 < Date.now();
  return { fields, amount, expired, network, badAmount };
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function lightning(text) {
  const raw = text.replace(/^lightning:/i, '').trim();
  const lower = raw.toLowerCase();
  if (/^lnurl1/.test(lower) || /^lnurl[pwc]?:\/\//.test(lower) || /^keyauth:\/\//.test(lower)) return lnurl(raw);
  if (/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) {
    const host = raw.split('@')[1].toLowerCase();
    const info = domainInfo(host);
    const own = info && info.domain ? info.domain : host;
    const where = own === host || host === `www.${own}` ? own : `${own} (at ${host})`;
    return paymentPayload('lightning', 'A Lightning address', [field('Lightning address', raw, { copy: 'Copy address', mono: true })], [
      warn('lightning-address', 'info', `Your wallet would ask ${where} for a payment request; the amount is up to you.`),
    ]);
  }
  const inv = bolt11(raw);
  if (!inv) {
    return paymentPayload('lightning', 'A Lightning payment request', [field('Request as written', raw, { mono: true })], [
      warn('unreadable', 'check', 'CheckLink cannot read this as a Lightning payment request: it may be damaged or made up.'),
    ]);
  }
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (inv.badAmount) warnings.push(warn('unreadable', 'check', 'The amount in this request is written finer than a payment can be, so a wallet would refuse it.'));
  if (inv.expired) warnings.push(warn('expired', 'info', 'This payment request has expired, so a wallet would refuse it.'));
  return paymentPayload('lightning', 'A Lightning payment request', [...inv.fields, field('Payment request', raw, { copy: 'Copy payment request', mono: true })], warnings, { amount: inv.amount });
}

/**
 * @param {string} raw
 * @returns {Draft}
 */
function lnurl(raw) {
  let url = null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('lnurl1')) {
    const d = bech32Decode(lower);
    const bytes = d && d.hrp === 'lnurl' ? convertBits(d.data, 5, 8, false) : null;
    try {
      url = bytes ? new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)) : null;
    } catch {
      url = null;
    }
  } else {
    // LUD-17: lnurlp://, lnurlw://, lnurlc://, keyauth:// stand for https:// (http:// for .onion).
    url = (/\.onion(?:[:/]|$)/i.test(raw) ? 'http://' : 'https://') + raw.replace(/^[a-z]+:\/\//i, '');
  }
  const links = url ? linksIn(url) : [];
  const login = /[?&]tag=login\b/i.test(url || '') || /^keyauth:/i.test(raw);
  // A withdraw link (LUD-03, LUD-08, LUD-17) is a voucher: the address itself is what lets its
  // holder claim the money, so nothing of it is shown in full. Withdraw services put the word
  // in the path (LNbits: /withdraw/api/...) when the tag is not in the address.
  const withdraw = !login && (/[?&]tag=withdrawRequest\b/i.test(url || '') || /^lnurlw:/i.test(raw) || /\/withdraw\b/i.test(url || ''));
  const host = links.length ? safeHost(links[0]) : null;
  if (withdraw) {
    /** @type {PayloadField[]} */
    const fields = [];
    if (host) fields.push(field('Service', host));
    fields.push(field('Voucher (LNURL)', raw, { secret: true, mono: true, copy: 'Copy voucher' }));
    if (url) fields.push(field('Address inside', url, { secret: true, mono: true }));
    return secretPayload('lnurl', 'A Lightning voucher (LNURL-withdraw)',
      `A Lightning voucher: whoever uses it first receives the money it offers${host ? `, from ${host}` : ''}. Nothing has been claimed.`, fields, [
        warn('voucher', 'stop', `Whoever has this code, or a picture of it, can claim the money first, from anywhere. Only scan it with your own wallet, and ${NEVER_SHARE}.`),
        ...(url ? [] : [warn('unreadable', 'check', 'CheckLink cannot read the address inside this LNURL.')]),
      ]);
  }
  const fields = [field('LNURL', raw, { mono: true, copy: 'Copy LNURL' })];
  if (url) fields.push(field('Address inside', url));
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (!url) warnings.push(warn('unreadable', 'check', 'CheckLink cannot read the address inside this LNURL.'));
  if (login) {
    return {
      kind: 'account-link', tier: 'check', title: 'A sign-in with a Lightning wallet (LNURL-auth)', scheme: 'lnurl',
      summary: `This would sign you in to ${host || 'a site'} with your Lightning wallet. Nothing has been opened.`,
      fields, links, secret: false,
      warnings: [warn('lnurl-login', 'check', `Your wallet would contact ${host || 'the site'} and sign you in there. Only do that on a site you opened yourself.`), ...warnings],
    };
  }
  return paymentPayload('lnurl', withdraw ? 'A Lightning withdrawal (LNURL)' : 'A Lightning payment link (LNURL)', fields, [
    warn('lnurl', 'check', `Your wallet would contact ${host || 'the address inside'} to get ${withdraw ? 'the money offered' : 'a payment request'}. Where that leads is decided there.`),
    ...warnings,
  ], { links });
}

/** @type {Record<string, string>} */
const CHAINS = { 1: 'Ethereum', 10: 'Optimism', 56: 'BNB Smart Chain', 100: 'Gnosis', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum One', 11155111: 'Sepolia (test network)' };
// Each network's own coin, in which value= is counted (in its smallest unit, 10^-18).
/** @type {Record<string, string>} */
const CHAIN_COIN = { 1: 'ETH', 10: 'ETH', 56: 'BNB', 100: 'xDAI', 137: 'POL', 8453: 'ETH', 42161: 'ETH', 11155111: 'Sepolia ETH' };

/**
 * @param {string} text
 * @returns {Draft}
 */
function ethereum(text) {
  const m = /^ethereum:(?:pay-)?([^@/?]+)(?:@(\d+))?(?:\/([^?]+))?(?:\?(.*))?$/is.exec(text.trim());
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (!m) return paymentPayload('ethereum', 'An Ethereum payment request', [field('Request as written', text, { mono: true })], [warn('unreadable', 'check', 'CheckLink cannot read this Ethereum request.')]);
  const [, target, chain, fn, query] = m;
  const params = queryParams(query || '');
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(target);
  if (chain) fields.push(field('Network', CHAINS[chain] ? `${CHAINS[chain]} (chain ${chain})` : `Chain ${chain}`));
  let amount = null;
  const wei = param(params, 'value');
  // No chain given: the wallet's own network, Ethereum by default.
  const coin = chain ? CHAIN_COIN[chain] || null : 'ETH';
  /** @type {(v: string) => string | null} */
  const ethText = (v) => {
    if (!/^\d+(\.\d+)?(e\d+)?$/i.test(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const value = (n / 1e18).toLocaleString('en-GB', { maximumFractionDigits: 18 });
    return coin ? `${value} ${coin}` : `${value} (in that network\u2019s own coin)`;
  };
  if (fn) {
    fields.push(field('Contract (token or app)', target, { mono: true, copy: 'Copy address', note: isAddr ? null : 'Not an address: a name the wallet would look up.' }));
    fields.push(field('Action it asks for', fn));
    const to = param(params, 'address');
    const units = param(params, 'uint256');
    if (to) fields.push(field('Sends to', to, { mono: true, copy: 'Copy address' }));
    if (units) fields.push(field('Amount in the token\u2019s smallest units', units));
    warnings.push(warn('contract-call', 'check', 'This asks your wallet to call a contract, for example to send tokens. Check every detail in your wallet before you approve anything.'));
  } else {
    fields.push(field('Pay to (address)', target, { mono: true, copy: 'Copy address', note: isAddr ? null : 'Not an address: a name the wallet would look up.' }));
  }
  if (wei) {
    amount = ethText(wei);
    fields.push(field('Amount', amount || wei));
  }
  warnings.push(warn('irreversible', 'check', 'A payment on Ethereum cannot be undone once sent. Compare the address with the one you expected.'));
  return paymentPayload('ethereum', 'An Ethereum payment request', fields, warnings, { amount });
}

// Looked up with a word taken from the code (its scheme), so made with __proto__: null: it holds
// only its own names, never "constructor", "toString" or another name every plain object inherits.
/** @type {Names} */
const CRYPTO = { __proto__: null, litecoin: 'Litecoin', dogecoin: 'Dogecoin', bitcoincash: 'Bitcoin Cash', dash: 'Dash', zcash: 'Zcash', monero: 'Monero', solana: 'Solana', tron: 'TRON', ripple: 'XRP', xrp: 'XRP', cardano: 'Cardano', 'web+cardano': 'Cardano' };

/**
 * @param {string} text
 * @param {string} scheme
 * @returns {Draft}
 */
function crypto(text, scheme) {
  const name = CRYPTO[scheme];
  const rest = text.slice(scheme.length + 1);
  const q = rest.indexOf('?');
  const addr = safeDecode(q < 0 ? rest : rest.slice(0, q)).replace(/^\/\//, '');
  const params = queryParams(q < 0 ? '' : rest.slice(q + 1));
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {string[]} */
  const links = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  if (/^https?:\/\//i.test(addr)) {
    // Solana Pay transaction request: the wallet fetches the transaction from this address.
    fields.push(field('Address the wallet would contact', addr));
    links.push(...linksIn(addr));
    warnings.push(warn('tx-request', 'check', 'Your wallet would fetch the payment from this address and ask you to approve it. Check every detail in your wallet before you approve.'));
  } else if (addr) fields.push(field('Pay to (address)', addr, { mono: true, copy: 'Copy address' }));
  const am = param(params, 'amount', 'tx_amount');
  // Solana Pay: with spl-token= the amount is in that token (such as a stablecoin), not SOL.
  const token = scheme === 'solana' ? param(params, 'spl-token') : null;
  let amount = null;
  if (am) {
    const unit = token ? '' : /** @type {Names} */ ({ __proto__: null, litecoin: 'LTC', dogecoin: 'DOGE', bitcoincash: 'BCH', dash: 'DASH', zcash: 'ZEC', monero: 'XMR', solana: 'SOL' })[scheme] || '';
    amount = /^\d+(\.\d+)?$/.test(am) ? (token ? `${am} of the token below, not Solana\u2019s own coin` : `${am} ${unit}`.trim()) : am;
    fields.push(field('Amount', amount));
  }
  if (token) fields.push(field('Token (its address)', token, { mono: true, copy: 'Copy token address', note: 'The token is named only by this address. Your wallet shows which token it is.' }));
  const label = param(params, 'label', 'recipient_name');
  if (label) fields.push(field(`Label (${WRITTEN_BY_MAKER})`, label));
  const message = param(params, 'message', 'tx_description', 'memo');
  if (message) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, message));
  warnings.push(warn('irreversible', 'check', `A ${name} payment cannot be undone once sent. Compare the address with the one you expected.`));
  return paymentPayload(scheme, `A ${name} payment request`, fields, warnings, { amount, links });
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function upi(text) {
  const q = text.indexOf('?');
  const action = text.slice(6, q < 0 ? undefined : q).replace(/\/$/, '').toLowerCase();
  const params = queryParams(q < 0 ? '' : text.slice(q + 1));
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  // A name given twice is read differently by different payment apps, so every value is shown.
  /** @type {string[]} */
  const twice = [];
  /** @type {(name: string) => string[]} */
  const all = (name) => {
    const v = distinct(paramsAll(params, name).filter(Boolean));
    if (v.length > 1) twice.push(name);
    return v;
  };
  const pn = all('pn');
  if (pn.length) fields.push(field('Pay to', pn.join(' or ')));
  const pa = all('pa');
  if (pa.length) fields.push(field('UPI ID', pa.join(' or '), { mono: true, copy: pa.length === 1 ? 'Copy UPI ID' : null }));
  let amount = null;
  const am = all('am');
  if (am.length === 1) {
    amount = amountText(am[0], param(params, 'cu') || 'INR');
    fields.push(field('Amount', amount));
  } else if (am.length > 1) fields.push(field('Amount', am.map((a) => amountText(a, param(params, 'cu') || 'INR')).join(' or ')));
  if (param(params, 'tn')) fields.push(field(`Note (${WRITTEN_BY_MAKER})`, param(params, 'tn')));
  if (twice.length) {
    const what = twice.map((n) => (/** @type {Record<string, string>} */ ({ pa: 'UPI ID', am: 'amount', pn: 'name' })[n])).join(' and ');
    warnings.push(warn('given-twice', 'check', `The ${what} ${twice.length > 1 ? 'are' : 'is'} given more than once, with different values. A payment app may use either one, so check what your app shows before you pay.`));
  }
  if (action === 'mandate') warnings.push(warn('mandate', 'check', 'This sets up repeated payments (a mandate), not a single one.'));
  return paymentPayload('upi', 'A UPI payment request', fields, warnings, { amount });
}

/** @type {Names} */
const ISO4217 = {
  __proto__: null, // only its own names (see CRYPTO): the currency field is text from the code
  '032': 'ARS', '036': 'AUD', '050': 'BDT', '104': 'MMK', '116': 'KHR', '124': 'CAD', '144': 'LKR', '152': 'CLP', '156': 'CNY', '170': 'COP',
  '203': 'CZK', '208': 'DKK', '344': 'HKD', '348': 'HUF', '352': 'ISK', '356': 'INR', '360': 'IDR', '376': 'ILS', '392': 'JPY', '404': 'KES',
  '410': 'KRW', '414': 'KWD', '418': 'LAK', '458': 'MYR', '484': 'MXN', '496': 'MNT', '524': 'NPR', '554': 'NZD', '566': 'NGN', '578': 'NOK',
  '586': 'PKR', '604': 'PEN', '608': 'PHP', '634': 'QAR', '643': 'RUB', '682': 'SAR', '702': 'SGD', '704': 'VND', '710': 'ZAR', '752': 'SEK',
  '756': 'CHF', '764': 'THB', '784': 'AED', '818': 'EGP', '826': 'GBP', '840': 'USD', '901': 'TWD', '936': 'GHS', '946': 'RON', '949': 'TRY',
  '978': 'EUR', '980': 'UAH', '985': 'PLN', '986': 'BRL',
};

// EMVCo merchant-presented codes (Pix, PayNow, PromptPay and others): tag, length, value.
/**
 * @param {string} s
 * @returns {{ id: string, value: string, at: number }[] | null}
 */
function tlv(s) {
  /** @type {{ id: string, value: string, at: number }[]} */
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (i + 4 > s.length) return null;
    const id = s.slice(i, i + 2);
    const len = s.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(len)) return null;
    const n = Number(len);
    if (i + 4 + n > s.length) return null;
    out.push({ id, value: s.slice(i + 4, i + 4 + n), at: i });
    i += 4 + n;
    if (out.length > 100) return null;
  }
  return out;
}

// What the parts of a merchant account template hold, for the schemes CheckLink names.
/** @type {Record<string, Record<string, string>>} */
const EMV_ACCOUNT = {
  A000000677010111: { '01': 'PromptPay mobile number', '02': 'PromptPay national ID or tax ID', '03': 'PromptPay e-wallet ID' },
  A000000677010112: { '01': 'PromptPay biller ID', '02': 'Reference 1', '03': 'Reference 2' },
  'SG.PAYNOW': { '01': 'PayNow proxy type (0 mobile number, 2 company UEN)', '02': 'PayNow mobile number or UEN', '03': 'Amount can be changed (1 yes, 0 no)', '04': 'Expires' },
};

/**
 * @param {string} text
 * @returns {Draft}
 */
function emv(text) {
  const items = tlv(text);
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  /** @type {string[]} */
  const links = [];
  if (!items) return paymentPayload('emv', 'A shop payment code', [field('Code as written', text, { mono: true })], [warn('unreadable', 'check', 'CheckLink cannot read this payment code: it may be damaged.')]);
  /** @type {(id: string) => string | null} */
  const get = (id) => (items.find((x) => x.id === id) || {}).value ?? null;
  let scheme = null;
  for (const it of items.filter((x) => Number(x.id) >= 26 && Number(x.id) <= 51)) {
    const sub = tlv(it.value);
    if (!sub) continue;
    const gui = (sub.find((x) => x.id === '00') || {}).value || '';
    if (/^br\.gov\.bcb\.pix$/i.test(gui)) {
      scheme = 'Pix';
      const key = (sub.find((x) => x.id === '01') || {}).value;
      if (key) fields.push(field('Pix key', key, { mono: true, copy: 'Copy Pix key' }));
      const dyn = (sub.find((x) => x.id === '25') || {}).value;
      if (dyn) {
        const url = /^https?:\/\//i.test(dyn) ? dyn : `https://${dyn}`;
        fields.push(field('Address the bank app would contact', url));
        links.push(...linksIn(url));
      }
      const desc = (sub.find((x) => x.id === '02') || {}).value;
      if (desc) fields.push(field(`Description (${WRITTEN_BY_MAKER})`, desc));
    } else if (gui) {
      if (!scheme) scheme = gui;
      // The account inside any other scheme's template: PromptPay's mobile number or ID,
      // PayNow's proxy, a bank's merchant account. Shown, so the card never asks to compare an
      // account it does not show.
      const names = EMV_ACCOUNT[gui.toUpperCase()] || {};
      for (const x of sub.filter((y) => y.id !== '00')) {
        fields.push(field(names[x.id] || `Merchant account (${gui}, part ${x.id})`, x.value, { mono: true }));
      }
    }
  }
  if (scheme) fields.unshift(field('Payment scheme', scheme));
  if (get('59')) fields.push(field('Pay to', get('59')));
  if (get('60')) fields.push(field('City', get('60')));
  if (get('58')) fields.push(field('Country', get('58')));
  let amount = null;
  const code = get('53');
  // A code with no currency field looks up the name "null", which is not in the table.
  const cur = ISO4217[/** @type {string} */ (code)] || null;
  if (get('54')) {
    amount = amountText(get('54'), cur) + (!cur && code ? ` (currency number ${code})` : '');
    fields.push(field('Amount', amount, { copy: 'Copy amount' }));
  } else fields.push(field('Amount', 'Not given: you would type it yourself'));
  const add = get('62') && tlv(/** @type {string} */ (get('62')));
  const ref = add && (add.find((x) => x.id === '05') || {}).value;
  if (ref) fields.push(field('Reference', ref, { mono: true }));
  const crc = items.find((x) => x.id === '63');
  if (crc) {
    const want = crc16(text.slice(0, crc.at + 4));
    if (want !== crc.value.toUpperCase()) warnings.push(warn('crc', 'check', 'The code\u2019s own check does not pass: it may be damaged or changed.'));
  }
  if (get('01') === '12') fields.push(field('Kind', 'For one payment only'));
  return paymentPayload('emv', scheme === 'Pix' ? 'A Pix payment code' : 'A shop payment code (EMV)', fields, warnings, { amount, links });
}

// Swish (Sweden). Two forms are recognised, both labelled "looks like": a prefilled code
// C<number>;<amount>;<message>;<locks> and the app link swish://payment?data=<JSON>.
/**
 * @param {string} text
 * @returns {Draft}
 */
function swishC(text) {
  // classify() calls this only for text that matches the same pattern.
  const m = /** @type {RegExpExecArray} */ (/^C(\+?\d{6,15});([\d.,]*);([^;]*);(\d*)$/.exec(text.trim()));
  const fields = [field('Swish number', m[1], { mono: true, copy: 'Copy number' })];
  let amount = null;
  if (m[2]) {
    amount = amountText(m[2].replace(',', '.'), 'SEK');
    fields.push(field('Amount', amount));
  }
  if (m[3]) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, m[3]));
  return paymentPayload('swish', 'Looks like a Swish payment code', fields, [warn('swish', 'info', 'This looks like a prefilled Swish payment. The Swish app shows the recipient before you confirm; check it there.')], { amount });
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function swishLink(text) {
  const q = text.indexOf('?');
  const params = queryParams(q < 0 ? '' : text.slice(q + 1));
  /** @type {PayloadField[]} */
  const fields = [];
  let amount = null;
  const data = param(params, 'data');
  if (data) {
    try {
      const j = JSON.parse(data);
      /** @type {(x: unknown) => unknown} */
      const val = (x) => (x && typeof x === 'object' ? /** @type {{ value?: unknown }} */ (x).value : x);
      if (val(j.payee)) fields.push(field('Swish number', String(val(j.payee)), { mono: true }));
      if (val(j.amount) !== undefined && val(j.amount) !== null) {
        amount = amountText(String(val(j.amount)), 'SEK');
        fields.push(field('Amount', amount));
      }
      if (val(j.message)) fields.push(field(`Message (${WRITTEN_BY_MAKER})`, String(val(j.message))));
    } catch { /* not JSON: shown as written below */ }
  }
  if (!fields.length) fields.push(field('Link as written', text, { mono: true }));
  return paymentPayload('swish', 'Looks like a Swish payment link', fields, [warn('swish', 'info', 'This opens the Swish app with a payment. The app shows the recipient before you confirm; check it there.')], { amount });
}

// == secrets and account linking ==

/**
 * @param {string} scheme
 * @param {string} title
 * @param {string} summary
 * @param {PayloadField[]} fields
 * @param {PayloadWarning[]} warnings
 * @param {Partial<Draft>} [extra]
 * @returns {Draft}
 */
function secretPayload(scheme, title, summary, fields, warnings, extra = {}) {
  return { kind: 'secret', tier: 'stop', title, scheme, summary, fields, warnings, links: [], secret: true, ...extra };
}

const OTP_KEEP = 'Whoever has this code can make the same sign-in codes as you, for as long as this setup stays on the account. Scan it only with your own authenticator app, and never share a picture of it.';

/**
 * @param {string} text
 * @returns {Draft}
 */
function otpauth(text) {
  const m = /^otpauth:\/\/(totp|hotp)\/([^?]*)(?:\?(.*))?$/is.exec(text.trim());
  /** @type {PayloadField[]} */
  const fields = [];
  if (!m) {
    return secretPayload('otpauth', 'A 2FA setup code', 'A two-factor sign-in setup code. It holds a secret.', [field('Code as written', text, { secret: true, mono: true, copy: 'Copy the code' })], [warn('otp-secret', 'stop', OTP_KEEP)]);
  }
  const params = queryParams(m[3] || '');
  const label = safeDecode(m[2]);
  const issuerParam = param(params, 'issuer');
  const colon = label.indexOf(':');
  const issuer = issuerParam || (colon > 0 ? label.slice(0, colon) : null);
  const account = colon > 0 ? label.slice(colon + 1).trim() : label;
  if (issuer) fields.push(field('Service', issuer));
  if (account) fields.push(field('Account', account));
  fields.push(field('Kind', m[1].toLowerCase() === 'totp' ? 'Codes that change every few seconds (TOTP)' : 'Codes that change each time one is used (HOTP)'));
  const secret = param(params, 'secret');
  if (secret) {
    const bytes = base32Length(secret);
    fields.push(field('Secret', secret, { secret: true, mono: true, copy: 'Copy secret', note: bytes ? null : 'Not written the usual way (base32).' }));
  } else fields.push(field('Secret', 'Missing: this setup code cannot work'));
  const alg = param(params, 'algorithm');
  if (alg && alg.toUpperCase() !== 'SHA1') fields.push(field('Algorithm', alg.toUpperCase()));
  const digits = param(params, 'digits');
  if (digits && digits !== '6') fields.push(field('Digits', digits));
  const period = param(params, 'period');
  if (period && period !== '30') fields.push(field('Changes every', `${period} seconds`));
  return secretPayload('otpauth', 'A 2FA setup code', 'A two-factor sign-in setup code: it holds the secret your authenticator app uses to make sign-in codes. Nothing has been added anywhere.', fields, [
    warn('otp-secret', 'stop', OTP_KEEP),
  ]);
}

// Google Authenticator's export (otpauth-migration://offline?data=...): a protocol buffer with
// one entry per account. Only names are shown; the secrets stay hidden.
/**
 * @param {string} text
 * @returns {Draft}
 */
function otpMigration(text) {
  const params = queryParams((text.split('?')[1]) || '');
  const bytes = base64Bytes(param(params, 'data') || '');
  /** @type {PayloadField[]} */
  const fields = [];
  let count = 0;
  const top = bytes ? protoFields(bytes) : null;
  if (top) {
    for (const f of top.filter((x) => x.field === 1 && x.wire === 2)) {
      // A field with wire type 2 holds bytes.
      const p = protoFields(/** @type {Uint8Array} */ (f.value));
      if (!p) continue;
      count++;
      /** @type {(n: number) => string} */
      const str = (n) => {
        const x = p.find((y) => y.field === n && y.wire === 2);
        try {
          return x ? new TextDecoder('utf-8', { fatal: true }).decode(/** @type {Uint8Array} */ (x.value)) : '';
        } catch {
          return '';
        }
      };
      const issuer = str(3);
      const name = str(2);
      if (count <= 50) fields.push(field(`Account ${count}`, [issuer, name].filter(Boolean).join(': ') || '(no name)'));
    }
  }
  if (count > 50) fields.push(field('More accounts', String(count - 50)));
  fields.push(field('Secrets', count ? `${count} hidden` : 'Could not be read'));
  fields.push(field('The whole code', text, { secret: true, mono: true, copy: 'Copy the code' }));
  const whose = count === 1 ? 'one account' : count ? `${count.toLocaleString('en-GB')} accounts` : 'some accounts';
  return secretPayload('otpauth-migration', '2FA secrets exported from an authenticator app', `An export from an authenticator app (Google Authenticator's format) with the two-factor sign-in setups of ${whose}. ${count === 1 ? 'It holds that account\u2019s secret.' : 'Each setup holds a secret.'}`, fields, [
    warn('otp-export', 'stop', 'Whoever has this code can make the sign-in codes for every account in it. Only scan it with your own authenticator app when you move it to a new phone, and never share a picture of it.'),
  ]);
}

// == recovery phrases ==
//
// BIP-39 (12 to 24 words) in English, Spanish, Portuguese, French, Italian, Czech, Japanese,
// Korean and Chinese (simplified and traditional), Monero seeds (25 words) in all 13 of
// Monero's languages, and SLIP-39 shares (20 or 33 words). A word in a Latin or Cyrillic list is
// matched without its accents and case, as the lists are designed to allow; a Japanese word
// keeps its marks (the two dots of \u304C are not an accent). Words may be separated by spaces,
// the ideographic space Japanese phrases use (U+3000), commas or semicolons; Chinese may be
// written with no spaces at all, one character per word. Numbering such as "1. word" or
// "1 word 2 word" is read past. Not recognised: Monero seeds typed with only the first letters
// of each word, and Polyseed's 16-word phrases.

/** @type {(w: string) => string} */
const fold = (w) => w.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
/** @type {(w: string) => string} */
const foldKeepingMarks = (w) => w.normalize('NFKD').toLowerCase();
/** @type {Record<string, string>} */
const LIST_NAMES = { chinese_simplified: 'Chinese (simplified)', chinese_traditional: 'Chinese (traditional)', english_old: 'English (old)' };
/** @type {(key: string) => string} */
const listName = (key) => LIST_NAMES[key] || `${key[0].toUpperCase()}${key.slice(1)}`;
/**
 * A word list a recovery phrase can be written in.
 * @typedef {object} PhraseList
 * @property {string} id
 * @property {'bip39' | 'monero' | 'slip39'} kind
 * @property {string} name
 * @property {string[]} words
 * @property {number[]} counts       the phrase lengths it allows
 * @property {(w: string) => string} fold
 * @property {Map<string, number>} index
 * @property {boolean} [keepMarks]
 * @property {number} [prefix]       Monero: how many first letters the checksum reads
 */
/** @type {PhraseList[] | null} */
let phraseLists = null;
/** @returns {PhraseList[]} */
function lists() {
  if (phraseLists) return phraseLists;
  /** @type {(id: string, kind: PhraseList['kind'], name: string, words: string[], counts: number[], extra?: { keepMarks?: boolean, prefix?: number }) => PhraseList} */
  const make = (id, kind, name, words, counts, extra = {}) => {
    const f = extra.keepMarks ? foldKeepingMarks : fold;
    return { id, kind, name, words, counts, fold: f, index: new Map(words.map((w, i) => [f(w), i])), ...extra };
  };
/** @type {(key: string) => { keepMarks: boolean }} */
  const japanese = (key) => ({ keepMarks: key === 'japanese' });
  phraseLists = [
    make('bip39-english', 'bip39', 'BIP-39, English', BIP39_ENGLISH, [12, 15, 18, 21, 24]),
    ...Object.entries(BIP39_LISTS).map(([key, words]) => make(`bip39-${key}`, 'bip39', `BIP-39, ${listName(key)}`, words, [12, 15, 18, 21, 24], japanese(key))),
    make('monero-english', 'monero', 'Monero, English', MONERO_ENGLISH, [24, 25], { prefix: MONERO_PREFIX.english }),
    ...Object.entries(MONERO_LISTS).map(([key, words]) => make(`monero-${key}`, 'monero', `Monero, ${listName(key)}`, words, [24, 25], { prefix: /** @type {Record<string, number>} */ (MONERO_PREFIX)[key], ...japanese(key) })),
    make('slip39', 'slip39', 'SLIP-39 (Shamir backup)', SLIP39_WORDS, [20, 33]),
  ];
  return phraseLists;
}

// Chinese characters written one after another: in a Chinese phrase each is a word.
const HAN_RUN = /^\p{Script=Han}{2,}$/u;

// The words of a text that could be a phrase, with any numbering read past; null when the text
// holds anything else. joined says a run of Chinese characters was read as one word each, as a
// phrase written without spaces; ordinary Chinese text is written that way too, so such a
// phrase counts only when its own check passes.
/**
 * @param {string} text
 * @returns {(string[] & { joined?: boolean }) | null}
 */
function phraseTokens(text) {
  let joined = false;
  const raw = text.trim().split(/[\s,;\u3001\uFF0C\uFF1B]+/u).filter(Boolean).flatMap((t) => {
    if (!HAN_RUN.test(t)) return [t];
    joined = true;
    return Array.from(t);
  });
  if (raw.length < 12 || raw.length > 70) return null;
  /** @type {string[] & { joined?: boolean }} */
  const out = [];
  let next = 1;
  for (const t of raw) {
    const m = /^(\d{1,2})[.):-]?(.*)$/.exec(t);
    if (m) {
      // "1." or "1" on its own, or "1.word": a label, but only when it counts up from 1.
      if (Number(m[1]) !== next) return null;
      next++;
      if (m[2]) out.push(m[2]);
    } else out.push(t);
  }
  out.joined = joined;
  return out;
}

// Whether a BIP-39 phrase passes its own checksum (the last bits are the start of SHA-256 of the rest).
/**
 * @param {number[]} indices
 * @returns {boolean}
 */
function bip39Checksum(indices) {
  const bits = indices.map((i) => i.toString(2).padStart(11, '0')).join('');
  const csLen = bits.length / 33;
  const entBits = bits.slice(0, bits.length - csLen);
  const ent = new Uint8Array(entBits.length / 8);
  for (let i = 0; i < ent.length; i++) ent[i] = parseInt(entBits.slice(i * 8, i * 8 + 8), 2);
  const hash = sha256(ent);
  const hashBits = Array.from(hash, (b) => b.toString(2).padStart(8, '0')).join('');
  return hashBits.slice(0, csLen) === bits.slice(bits.length - csLen);
}

// Monero (src/mnemonics/electrum-words.cpp): the 25th word repeats the word at CRC-32 of the
// first letters of each of the other 24 as the list writes them (three in English, one in
// Chinese, four in most others; MONERO_PREFIX), modulo 24. The words are compared without
// regard to case, as Monero does (German nouns have a capital letter).
/**
 * @param {string[]} words
 * @param {number} prefix
 * @returns {boolean}
 */
function moneroChecksum(words, prefix) {
  const head = words.slice(0, 24).map((w) => Array.from(w).slice(0, prefix).join('')).join('');
  const want = words[crc32(utf8(head)) % 24];
  return Array.from(want).slice(0, prefix).join('').toLowerCase() === Array.from(words[24]).slice(0, prefix).join('').toLowerCase();
}

// SLIP-39: an RS1024 checksum over the share, keyed by "shamir" (or "shamir_extendable" when the
// share says so in its first two words).
const RS1024_GEN = [0xe0e040, 0x1c1c080, 0x3838100, 0x7070200, 0xe0e0009, 0x1c0c2412, 0x38086c24, 0x3090fc48, 0x21b1f890, 0x3f3f120];
/**
 * @param {number[]} indices
 * @returns {boolean}
 */
function slip39Checksum(indices) {
  const ext = ((indices[0] * 1024 + indices[1]) >> 4) & 1;
  let chk = 1;
  for (const v of [...Array.from(ext ? 'shamir_extendable' : 'shamir', (c) => c.charCodeAt(0)), ...indices]) {
    const b = chk >>> 20;
    chk = ((chk & 0xfffff) << 10) ^ v;
    for (let i = 0; i < 10; i++) if ((b >>> i) & 1) chk ^= RS1024_GEN[i];
  }
  return chk === 1;
}

// The phrase a text holds, or null: { list, words (as the list writes them), indices, checksum }.
/**
 * @param {string} text
 * @returns {{ list: PhraseList, words: string[], indices: number[], checksum: boolean | null } | null}
 */
function recoveryPhrase(text) {
  const tokens = phraseTokens(text);
  if (!tokens) return null;
  let found = null;
  for (const list of lists()) {
    if (!list.counts.includes(tokens.length)) continue;
    // A word missing from the list gives undefined, and the next line skips the list.
    const indices = /** @type {number[]} */ (tokens.map((w) => list.index.get(list.fold(w))));
    if (indices.some((i) => i === undefined)) continue;
    const words = indices.map((i) => list.words[i]);
    let checksum = null;
    if (list.kind === 'bip39') checksum = bip39Checksum(indices);
    else if (list.kind === 'monero') checksum = words.length === 25 ? moneroChecksum(words, /** @type {number} */ (list.prefix)) : null;
    else if (list.kind === 'slip39') checksum = slip39Checksum(indices);
    const hit = { list, words, indices, checksum };
    if (checksum) return hit;
    if (!tokens.joined) found = found || hit;
  }
  return found;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
function entropyWords(bytes) {
  const hash = sha256(bytes);
  const bits = Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join('') + Array.from(hash, (b) => b.toString(2).padStart(8, '0')).join('').slice(0, (bytes.length * 8) / 32);
  const out = [];
  for (let i = 0; i < bits.length; i += 11) out.push(BIP39_ENGLISH[parseInt(bits.slice(i, i + 11), 2)]);
  return out;
}

const SEED_KEEP = 'Whoever has these words has the wallet: they can take everything in it, from anywhere. A real wallet never asks you to scan or type them anywhere else. Never share a picture of this code.';

/**
 * @param {string[]} words
 * @param {string} how
 * @param {boolean | null} checksum
 * @param {PhraseList | null} [list]
 * @returns {Draft}
 */
function seedPayload(words, how, checksum, list = null) {
  const fields = [
    field('Words', `${words.length} words`),
    ...(list && list.id !== 'bip39-english' ? [field('Word list', list.name)] : []),
    field('The words', words.map((w, i) => `${i + 1}. ${w}`).join('  '), { secret: true, copy: 'Copy the words', copyValue: words.join(' ') }),
    field('Checksum', checksum === null ? 'This phrase has no checksum word, so CheckLink cannot check it. Its words are all from the list.' : checksum ? 'The words pass the phrase\u2019s own check, so this is very likely a real recovery phrase.' : 'The words are all from the recovery-phrase list, but the phrase\u2019s own check does not pass.'),
  ];
  if (list && list.kind === 'slip39') {
    return secretPayload(how, 'A share of a wallet backup (SLIP-39)', 'One share of a Shamir wallet backup (SLIP-39). With enough of the other shares, it rebuilds the wallet.', fields, [
      warn('seed', 'stop', `Whoever has these words and enough of the backup\u2019s other shares has the wallet: they can take everything in it, from anywhere. A real wallet never asks you to scan or type a share anywhere else. Never share a picture of this code.`),
    ]);
  }
  const coin = list && list.kind === 'monero' ? 'A Monero wallet recovery phrase' : 'A wallet recovery phrase';
  return secretPayload(how, coin, `${coin} (seed words). It is the key to a ${list && list.kind === 'monero' ? 'Monero' : 'crypto'} wallet.`, fields, [warn('seed', 'stop', SEED_KEEP)]);
}

/**
 * @param {string} text
 * @returns {Draft | null}
 */
function seedQr(text) {
  // classify() calls this only for 48 or 96 digits, so there are groups.
  const groups = /** @type {RegExpMatchArray} */ (text.match(/\d{4}/g));
  if (!groups.every((g) => Number(g) < 2048)) return null;
  const idx = groups.map(Number);
  const p = seedPayload(idx.map((i) => BIP39_ENGLISH[i]), 'SeedQR', bip39Checksum(idx));
  p.title = 'A wallet recovery phrase written as numbers (SeedQR)';
  return p;
}

/**
 * @param {string} kind
 * @param {string} text
 * @param {PayloadField[]} [extra]
 * @returns {Draft}
 */
function privateKey(kind, text, extra = []) {
  return secretPayload('key', `A private key (${kind})`, `A private key (${kind}). Whoever has it controls what it protects.`, [
    field('Kind', kind),
    field('Key', text.trim(), { secret: true, mono: true, copy: 'Copy key' }),
    ...extra,
  ], [warn('private-key', 'stop', 'Whoever has this code has the key: they can sign in, sign or spend as its owner. Never share a picture of it.')]);
}

// Tokens and keys with a recognisable shape. Each: [name, pattern].
/** @type {[string, RegExp][]} */
const TOKENS = [
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['Stripe secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['PyPI token', /\bpypi-AgE[A-Za-z0-9_-]{50,}\b/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['SendGrid key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/],
  ['Twilio key', /\bSK[0-9a-f]{32}\b/],
  ['JWT sign-in token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
];

/**
 * @param {string} text
 * @param {string[]} found
 * @returns {Draft}
 */
function tokenPayload(text, found) {
  return secretPayload('token', found.length === 1 ? `Looks like a secret key (${found[0]})` : 'Looks like secret keys', `This code holds what looks like a secret key or sign-in token (${found.join(', ')}).`, [
    field('Looks like', found.join(', ')),
    field('The text', text, { secret: true, mono: true, copy: 'Copy the text' }),
  ], [warn('token', 'stop', 'Whoever has this code has the key: it can be used to get into the account or service it belongs to. If it is yours, treat it as leaked: cancel it and make a new one.')]);
}

/**
 * @param {string} scheme
 * @param {string} title
 * @param {string} summary
 * @param {string} text
 * @param {string} warning
 * @param {{ fields?: PayloadField[], tier?: Tier, links?: string[] }} [options]
 * @returns {Draft}
 */
function accountLink(scheme, title, summary, text, warning, { fields = [], tier = 'stop', links = [] } = {}) {
  return {
    kind: 'account-link', tier, title, scheme, summary, links,
    fields: [...fields, field('The whole code', text, { secret: true, mono: true })],
    warnings: [warn('account-link', tier, warning)], secret: true,
  };
}

// == more secrets: VPN keys, node credentials, sign-in codes, ecash, eSIM ==

// A WireGuard configuration, as the WireGuard apps import it from a QR code: its PrivateKey is
// the device's key to the VPN.
/**
 * @param {string} text
 * @returns {Draft}
 */
function wireguard(text) {
  /** @type {(name: string) => string | null} */
  const get = (name) => (new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'im').exec(text) || [])[1] || null;
  /** @type {PayloadField[]} */
  const fields = [];
  const endpoint = get('Endpoint');
  if (endpoint) fields.push(field('VPN server', endpoint, { mono: true }));
  const address = get('Address');
  if (address) fields.push(field('This device\u2019s address in the VPN', address, { mono: true }));
  const dns = get('DNS');
  if (dns) fields.push(field('Name servers (DNS)', dns, { mono: true }));
  const allowed = get('AllowedIPs');
  if (allowed) fields.push(field('Traffic sent through it', /(^|,\s*)(0\.0\.0\.0\/0|::\/0)/.test(allowed) ? `${allowed} (everything)` : allowed, { mono: true }));
  fields.push(field('Private key', get('PrivateKey') || '', { secret: true, mono: true, copy: 'Copy private key' }));
  const psk = get('PresharedKey');
  if (psk) fields.push(field('Shared key', psk, { secret: true, mono: true }));
  fields.push(field('The whole configuration', text.trim(), { secret: true, mono: true, copy: 'Copy the configuration' }));
  return secretPayload('wireguard', 'A WireGuard VPN configuration', 'A WireGuard VPN configuration, with the private key that lets a device join the VPN. Nothing has been added anywhere.', fields, [
    warn('vpn-key', 'stop', `Whoever has this code can join this VPN as this device, for as long as its key stays on the server, and use whatever it reaches. Only scan it with your own WireGuard app, and ${NEVER_SHARE}.`),
  ]);
}

// Lightning node connections (lndconnect, Core Lightning's clnrest and kin): node packages such
// as Umbrel show these to connect a wallet app. The macaroon or rune in them is the right to
// run the node and spend its money.
const NODE_SCHEMES = /^(lndconnect|clnrest|c-lightning-rest|cln-grpc|clightning):\/\//i;
/**
 * @param {string} text
 * @returns {Draft}
 */
function lightningNode(text) {
  // classify() calls this only for text that matches NODE_SCHEMES.
  const scheme = /** @type {RegExpExecArray} */ (NODE_SCHEMES.exec(text))[1].toLowerCase();
  const rest = text.slice(scheme.length + 3);
  const q = rest.indexOf('?');
  const node = q < 0 ? rest : rest.slice(0, q);
  const params = queryParams(q < 0 ? '' : rest.slice(q + 1));
  const fields = [field('Node address', node.replace(/\/$/, ''), { mono: true })];
  for (const name of ['macaroon', 'rune']) {
    const v = param(params, name);
    if (v) fields.push(field(name === 'rune' ? 'Rune (the right to use the node)' : 'Macaroon (the right to use the node)', v, { secret: true, mono: true }));
  }
  return accountLink(scheme, 'A connection to a Lightning node', 'A connection to a Lightning node, with the credential that lets an app control it. Nothing has been connected.', text,
    `Whoever has this code can control the node and spend its money, up to what the credential allows. Only scan it with your own wallet app, and ${NEVER_SHARE}.`, { fields });
}

// Nextcloud's sign-in code: nc://login/user:<name>&password:<app password>&server:<address>.
/**
 * @param {string} text
 * @returns {Draft}
 */
function nextcloud(text) {
  const body = text.replace(/^nc:\/\/login\/?/i, '');
  /** @type {(k: string) => string | null} */
  const get = (k) => (new RegExp(`(?:^|&)${k}:(.*?)(?=&(?:user|password|server):|$)`, 'i').exec(body) || [])[1] || null;
  /** @type {PayloadField[]} */
  const fields = [];
  // Each value is read twice: the test above it shows it is not null.
  if (get('server')) fields.push(field('Server', safeDecode(/** @type {string} */ (get('server')))));
  if (get('user')) fields.push(field('User name', safeDecode(/** @type {string} */ (get('user')))));
  if (get('password')) fields.push(field('App password', safeDecode(/** @type {string} */ (get('password'))), { secret: true, mono: true }));
  return accountLink('nc', 'A Nextcloud sign-in code', 'A Nextcloud sign-in code: it holds an app password for the account named below. Nothing has been signed in.', text,
    `Whoever has this code can sign in to this Nextcloud account and read its files. Only scan it with your own Nextcloud app, and ${NEVER_SHARE}.`, { fields });
}

// Cashu ecash: the token is money itself. cashuA is base64url JSON, cashuB base64url CBOR.
/**
 * @param {string} text
 * @returns {Draft}
 */
function cashu(text) {
  const token = text.replace(/^cashu:/i, '').trim();
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {unknown[]} */
  let mints = [];
  /** @type {number | null} */
  let total = null;
  /** @type {string | null} */
  let unit = null;
  /** @type {string | null} */
  let memo = null;
  const bytes = base64Bytes(token.slice(6));
  try {
    if (bytes && token[5] === 'A') {
      // The shape a cashuA token should have. It is untrusted JSON: anything else makes a line
      // below throw, and the catch keeps the token hidden with nothing read from it.
      /** @type {{ token?: ({ mint?: unknown, proofs?: { amount?: unknown }[] } | null)[], unit?: unknown, memo?: unknown }} */
      const j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      mints = (j.token || []).map((t) => t && t.mint).filter((m) => typeof m === 'string');
      total = (j.token || []).flatMap((t) => (t && t.proofs) || []).reduce((a, x) => a + (Number.isSafeInteger(x && x.amount) ? /** @type {number} */ (x.amount) : 0), 0);
      unit = typeof j.unit === 'string' ? j.unit : null;
      memo = typeof j.memo === 'string' ? j.memo : null;
    } else if (bytes && token[5] === 'B') {
      const c = cborDecode(bytes);
      if (c instanceof Map) {
        if (typeof c.get('m') === 'string') mints = [c.get('m')];
        // Each value read again after its test is cast to what the test showed: a Map gives the
        // same answer each time.
        unit = typeof c.get('u') === 'string' ? /** @type {string} */ (c.get('u')) : null;
        memo = typeof c.get('d') === 'string' ? /** @type {string} */ (c.get('d')) : null;
        const t = /** @type {unknown[]} */ (Array.isArray(c.get('t')) ? c.get('t') : []);
        total = t.flatMap((x) => (x instanceof Map && Array.isArray(x.get('p')) ? x.get('p') : [])).reduce((/** @type {number} */ a, /** @type {unknown} */ x) => a + (x instanceof Map && Number.isSafeInteger(x.get('a')) ? /** @type {number} */ (x.get('a')) : 0), 0);
      }
    }
  } catch { /* not readable: the token is still hidden */ }
  for (const m of distinct(mints).slice(0, 5)) fields.push(field('Mint (the service that issued it)', m));
  if (total) fields.push(field('Amount', `${total.toLocaleString('en-GB')} ${unit || 'sat'}`));
  if (memo) fields.push(field(`Note (${WRITTEN_BY_MAKER})`, memo));
  fields.push(field('Token', token, { secret: true, mono: true, copy: 'Copy token' }));
  return secretPayload('cashu', 'Ecash (a Cashu token)', 'A Cashu ecash token: it is the money itself, not a request for it. Nothing has been claimed.', fields, [
    warn('ecash', 'stop', `Whoever has this code, or a picture of it, can claim this money first, from anywhere. Only scan it with your own wallet, and ${NEVER_SHARE}.`),
  ]);
}

// eSIM activation codes (GSMA SGP.22): LPA:1$<server>$<matching ID>[$<OID>[$<1 if a
// confirmation code is needed>]].
/**
 * @param {string} text
 * @returns {Draft}
 */
function esim(text) {
  const parts = text.trim().slice(4).split('$');
  const [, server, matching = '', , confirm] = parts;
  const fields = [field('Server (SM-DP+)', server || '', { mono: true })];
  if (matching) fields.push(field('Activation code', matching, { secret: true, mono: true, copy: 'Copy activation code' }));
  if (confirm === '1') fields.push(field('Confirmation code needed', 'Yes: the phone company gives it to you separately'));
  const p = secretPayload('esim', 'An eSIM activation code', 'An eSIM activation code: it puts a mobile plan (a phone line) on a phone. Nothing has been installed.', fields, [
    warn('esim', 'stop', `Whoever has this code, or a picture of it, may get the phone line by scanning it first, and it often works only once. Only scan it with your own phone, and ${NEVER_SHARE}.`),
  ]);
  if (!matching) {
    p.tier = 'check';
    p.secret = false;
    p.warnings = [warn('esim', 'check', 'This eSIM code names only the server; the phone line is tied to one phone by the phone company.')];
  }
  return p;
}

// A key inside other text: the whole text is hidden, since the key cannot be cut out of it
// safely (a wallet descriptor, a note with an nsec in it, a key file after a line of text).
/**
 * @param {string} text
 * @returns {string | null}
 */
function embeddedKey(text) {
  const nsec = /\bnsec1[02-9ac-hj-np-z]{58}\b/i.exec(text);
  if (nsec) {
    const d = bech32Decode(nsec[0].toLowerCase());
    if (d && d.hrp === 'nsec') return 'Nostr secret key, nsec';
  }
  if (/\bncryptsec1[02-9ac-hj-np-z]{50,}\b/i.test(text)) return 'password-protected Nostr secret key';
  const xprv = /(?<![1-9A-HJ-NP-Za-km-z])[xyztuv]prv[1-9A-HJ-NP-Za-km-z]{107}(?![1-9A-HJ-NP-Za-km-z])/.exec(text);
  if (xprv && base58Check(xprv[0])) return 'wallet master key, extended private key';
  if (/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/.test(text)) return /PGP/.test(text) ? 'PGP' : /OPENSSH/.test(text) ? 'SSH' : 'PEM';
  if (/\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/.test(text)) return 'age';
  for (const m of text.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/g)) {
    const b = base58Check(m[0]);
    if (b && (b[0] === 0x80 || b[0] === 0xef) && (b.length === 33 || (b.length === 34 && b[33] === 1))) return 'Bitcoin, WIF';
  }
  if (/\botpauth(?:-migration)?:\/\/\S+[?&]secret=|\botpauth-migration:\/\//i.test(text)) return '2FA setup secret';
  return null;
}

// == app launchers ==

/** @type {Names} */
const APPS = {
  __proto__: null, // only its own names (see CRYPTO): the scheme is text from the code
  whatsapp: 'WhatsApp', tg: 'Telegram', fb: 'Facebook', instagram: 'Instagram', twitter: 'X (Twitter)', snapchat: 'Snapchat', zoommtg: 'Zoom', zoomus: 'Zoom',
  msteams: 'Microsoft Teams', slack: 'Slack', discord: 'Discord', spotify: 'Spotify', skype: 'Skype', viber: 'Viber', line: 'LINE', weixin: 'WeChat',
  alipay: 'Alipay', alipays: 'Alipay', vipps: 'Vipps', mobilepay: 'MobilePay', revolut: 'Revolut', paypal: 'PayPal', steam: 'Steam', waze: 'Waze',
  comgooglemaps: 'Google Maps', maps: 'Apple Maps', uber: 'Uber', threema: 'Threema', element: 'Element', matrix: 'a Matrix chat app', xmpp: 'a chat app (XMPP)',
  sgnl: 'Signal', signal: 'Signal', youtube: 'YouTube', vnd: 'an app', linkedin: 'LinkedIn', pinterest: 'Pinterest', reddit: 'Reddit', twitch: 'Twitch',
  shortcuts: 'Apple Shortcuts', facetime: 'FaceTime', 'facetime-audio': 'FaceTime', ssh: 'a remote login (SSH) app', sftp: 'a file transfer app',
  ftp: 'a file transfer app', smb: 'Windows file sharing', rtsp: 'a video player', magnet: 'a BitTorrent app', ipfs: 'an IPFS app', ipns: 'an IPFS app',
};

/**
 * @param {string} text
 * @returns {Draft}
 */
function intentUri(text) {
  const hash = text.indexOf('#Intent;');
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {string[]} */
  const links = [];
  let pkg = null;
  if (hash >= 0) {
    const body = text.slice(hash + 8).replace(/;end;?$/, '');
    for (const part of body.split(';')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const k = part.slice(0, eq);
      const v = safeDecode(part.slice(eq + 1));
      if (k === 'package') {
        pkg = v;
        fields.push(field('App (package)', v, { mono: true }));
      } else if (k === 'scheme') fields.push(field('Kind of link', `${v}:`));
      else if (k === 'action') fields.push(field('Action', v));
      else if (k === 'component') fields.push(field('Part of the app', v, { mono: true }));
      else if (k === 'S.browser_fallback_url') {
        fields.push(field('Backup address', v));
        links.push(...linksIn(v));
      } else if (/^[SBbilfds]\./.test(k)) fields.push(field(`Extra value ${k.slice(2)}`, v));
    }
  }
  fields.push(field('Address part', text.slice(0, hash < 0 ? undefined : hash), { mono: true }));
  return {
    kind: 'app', tier: 'check', title: 'Starts an Android app', scheme: 'intent',
    summary: pkg ? 'This asks Android to start the app named below, with what the code gives it. Nothing has been started.' : 'This asks Android to start an app. Nothing has been started.',
    fields, links, secret: false,
    warnings: [warn('app', 'check', `${NOT_STARTED} If you start it yourself, the app gets everything in this code.${links.length ? ' The backup address is the web page Android would open if the app is missing. Check this link looks at it without opening it.' : ''}`)],
  };
}

/**
 * @param {string} text
 * @param {string} scheme
 * @returns {Draft}
 */
function appLauncher(text, scheme) {
  const lower = scheme.toLowerCase();
  /** @type {PayloadField[]} */
  const fields = [];
  /** @type {PayloadWarning[]} */
  const warnings = [];
  const links = linksIn(text.slice(scheme.length + 1));
  let title = 'Opens an app';
  let summary;
  if (lower === 'market') {
    const id = (/[?&]id=([^&]+)/.exec(text) || [])[1];
    title = 'Opens the Play Store';
    summary = 'This opens the Play Store page of the app named below. Nothing has been opened.';
    if (id) fields.push(field('App (package)', safeDecode(id), { mono: true }));
  } else if (lower === 'itms-services') {
    title = 'Installs an iPhone app from outside the App Store';
    summary = 'This asks an iPhone to install an app from outside the App Store. Nothing has been installed.';
    warnings.push(warn('sideload', 'check', 'Install apps from the App Store instead. An app installed this way has not been checked by Apple.'));
  } else if (lower === 'itms-apps' || lower === 'itms-appss') {
    title = 'Opens the App Store';
    summary = 'This opens a page in the App Store. Nothing has been opened.';
  } else if (lower === 'smb') {
    summary = 'This opens a Windows file share. Nothing has been opened.';
    warnings.push(warn('smb', 'check', 'Opening a Windows file share can send your computer\u2019s sign-in details to that server. Only open shares you know.'));
  } else if (lower === 'magnet') {
    const dn = (/[?&]dn=([^&]+)/.exec(text) || [])[1];
    summary = 'This starts a download through BitTorrent. Nothing has been downloaded.';
    if (dn) fields.push(field('File name it gives', formDecode(dn)));
  } else if (APPS[lower]) {
    summary = `This opens ${APPS[lower]}, with what the code gives it. Nothing has been opened.`;
  } else {
    summary = `This opens whichever app on your device has claimed ${lower}: links. Nothing has been opened.`;
  }
  // A user name and password in the link (rtsp://admin:pass@camera, ssh://, ftp://): the
  // password is hidden behind Show and left out of the link as shown.
  const cred = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s]*)@/i.exec(text);
  const colon = cred ? cred[2].indexOf(':') : -1;
  if (cred && colon >= 0 && colon < cred[2].length - 1) {
    const user = cred[2].slice(0, colon);
    const password = safeDecode(cred[2].slice(colon + 1));
    fields.unshift(
      field('Kind of link', `${lower}:`),
      field('Full link, password left out', `${cred[1]}${user ? `${user}@` : ''}${text.slice(cred[0].length)}`, { mono: true }),
      field('User name', safeDecode(user), { mono: true }),
      field('Password', password, { secret: true, mono: true, copy: 'Copy password' }),
    );
    warnings.push(warn('link-password', 'check', 'This link has a password in it, hidden until you choose Show. Whoever has this code can use it.'));
  } else fields.unshift(field('Kind of link', `${lower}:`), field('Full link', text, { mono: true }));
  warnings.unshift(warn('app', 'check', `${NOT_STARTED} If you open it yourself, the app gets everything in this code.`));
  return { kind: 'app', tier: 'check', title, scheme: lower, summary, fields, links, warnings, secret: false };
}

// == other kinds ==

/**
 * @param {string} text
 * @returns {Draft}
 */
function boardingPass(text) {
  const s = text;
  const name = s.slice(2, 22).trim();
  const pnr = s.slice(23, 30).trim();
  const from = s.slice(30, 33);
  const to = s.slice(33, 36);
  const carrier = s.slice(36, 39).trim();
  const flight = s.slice(39, 44).trim().replace(/^0+(?=\d)/, '');
  const day = s.slice(44, 47);
  const seat = s.slice(48, 52).trim().replace(/^0+(?=\d)/, '');
  const fields = [
    field('Passenger', name.replace('/', ', ')),
    field('Booking reference', pnr, { secret: true, mono: true }),
    field('From', from),
    field('To', to),
    field('Flight', `${carrier} ${flight}`.trim()),
  ];
  if (/^\d{3}$/.test(day) && Number(day) >= 1 && Number(day) <= 366) {
    // The code holds the day of the year but not the year: read in a year that is not a leap
    // year, so "about".
    const d = new Date(Date.UTC(2025, 0, Number(day)));
    fields.push(field('Flight date', `about ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} (day ${Number(day)} of the year; the year is not in the code)`));
  }
  if (seat) fields.push(field('Seat', seat));
  return {
    kind: 'boarding-pass', tier: 'check', title: 'A boarding pass', scheme: 'BCBP',
    summary: 'A boarding pass: the passenger\u2019s name, booking reference and flight.',
    fields, links: [], secret: false,
    warnings: [warn('boarding-pass', 'check', 'Whoever has this code can read the name and booking reference on it. With those two, an airline\u2019s website often lets anyone see or change the booking. Do not share pictures of a boarding pass.')],
  };
}

/**
 * @param {string} text
 * @returns {Draft}
 */
function nostr(text) {
  const raw = text.replace(/^nostr:/i, '').trim();
  const lower = raw.toLowerCase();
  const d = bech32Decode(lower, 5000);
  if (lower.startsWith('nsec1')) {
    return privateKey('Nostr secret key, nsec', raw, [field('Checksum', d && d.hrp === 'nsec' ? 'Its checksum passes.' : 'Its checksum does not pass.')]);
  }
  if (lower.startsWith('ncryptsec1')) {
    return secretPayload('nostr', 'A password-protected Nostr secret key', 'A Nostr secret key, locked with a password (ncryptsec). It is still a key.', [field('Key', raw, { secret: true, mono: true, copy: 'Copy key' })], [
      warn('private-key', 'stop', 'Whoever has this code and guesses the password has the account. Keep it private, as you would the key itself.'),
    ]);
  }
  // d && d.hrp is null for an address that does not decode: the name "null", which is not in the table.
  const what = /** @type {Names} */ ({ __proto__: null, npub: 'a Nostr profile (public key)', nprofile: 'a Nostr profile', note: 'a Nostr post', nevent: 'a Nostr post or event', naddr: 'a Nostr article or list', nrelay: 'a Nostr relay' })[/** @type {string} */ (d && d.hrp)] || 'a Nostr address';
  return {
    kind: 'nostr', tier: 'info', title: 'A Nostr address', scheme: 'nostr',
    summary: `This is ${what}. It is public by design and holds nothing secret.`,
    fields: [field('Address', raw, { mono: true, copy: 'Copy address', note: d ? 'Its checksum passes.' : 'Its checksum does not pass: it may be damaged.' })],
    links: [], warnings: [], secret: false,
  };
}

/**
 * @param {string} text
 * @param {string | null} format
 * @returns {Draft}
 */
function product(text, format) {
  const digits = text.trim();
  const book = /^97[89]\d{10}$/.test(digits);
  const ok = /^\d+$/.test(digits) && digits.length >= 8 ? gs1Valid(digits) : null;
  return {
    kind: 'product', tier: 'info', title: book ? 'A book number (ISBN)' : 'A product number', scheme: format || 'GTIN',
    summary: book ? 'A book number (ISBN). It identifies the book, not you.' : 'A product barcode number. It identifies the product, not you.',
    fields: [field('Number', digits, { copy: 'Copy number', mono: true, note: ok === null ? null : ok ? 'Its check digit is right.' : 'Its check digit is wrong: the code may be damaged.' })],
    links: [], warnings: [], secret: false,
  };
}

/** @type {Record<string, string>} */
const GS1_AI = { '00': 'Shipping container code (SSCC)', '01': 'Product number (GTIN)', '02': 'Product number of contents', 10: 'Batch or lot', 11: 'Production date', 13: 'Packaging date', 15: 'Best before', 17: 'Use by or expiry', 21: 'Serial number', 30: 'Count', 37: 'Count of trade items' };
/**
 * @param {string} text
 * @returns {Draft}
 */
function gs1Elements(text) {
  /** @type {PayloadField[]} */
  const fields = [];
  for (const m of text.matchAll(/\((\d{2,4})\)([^(]*)/g)) {
    const label = GS1_AI[m[1]] || `Data (${m[1]})`;
    let v = m[2];
    if (['11', '13', '15', '17'].includes(m[1]) && /^\d{6}$/.test(v)) v = dateText(2000 + Number(v.slice(0, 2)), Number(v.slice(2, 4)), Number(v.slice(4)) || 1) || v;
    fields.push(field(label, v, { mono: /^\d+$/.test(v) }));
  }
  return {
    kind: 'product', tier: 'info', title: 'Product data (GS1)', scheme: 'GS1',
    summary: 'Product data from a package: numbers such as the product, batch and dates. It identifies the product, not you.',
    fields, links: [], warnings: [], secret: false,
  };
}

// == helpers that use the link engine ==

/**
 * @param {unknown} text
 * @returns {string[]}
 */
function linksIn(text) {
  if (!text) return [];
  return findLinks(String(text)).links.map((l) => (l.bare ? `https://${l.link}` : l.link));
}
/**
 * @param {string} link
 * @returns {string | null}
 */
function safeHost(link) {
  try {
    const h = new URL(link).hostname;
    const info = domainInfo(h);
    return info && info.domain ? info.domain : h;
  } catch {
    return null;
  }
}
/**
 * @param {PayloadWarning[]} ws
 * @returns {PayloadWarning[]}
 */
function dedupe(ws) {
  const seen = new Set();
  return ws.filter((w) => {
    const k = `${w.id}|${w.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// A web address on a host whose codes are known to lead somewhere only that service decides.
/**
 * @param {string} link
 * @returns {PayloadWarning[]}
 */
function webNotes(link) {
  /** @type {PayloadWarning[]} */
  const out = [];
  let host = '';
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return out;
  }
  // Vipps MobilePay: only codes on qr.vipps.no open in the Vipps or MobilePay app
  // (https://developer.vippsmobilepay.com/docs/APIs/qr-api/qr-api-guide).
  if (host === 'qr.vipps.no') {
    out.push(warn('vipps', 'check', 'This is a Vipps MobilePay code. Opened in the Vipps or MobilePay app it leads to a payment or a shop\u2019s page that Vipps MobilePay\u2019s server decides; the app shows the recipient and amount before you pay. CheckLink never opens it.'));
  }
  return out;
}

// == plain text ==

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * @param {string} text
 * @returns {Draft}
 */
function plainText(text) {
  const links = linksIn(text);
  return {
    kind: 'text', tier: 'info', title: 'Text', scheme: null,
    summary: links.length ? `Text with ${links.length === 1 ? 'a web address' : `${links.length} web addresses`} in it. Nothing has been opened.` : 'Plain text. Nothing in it opens anything.',
    fields: [], links, warnings: [], secret: false,
  };
}

// == the classifier ==

const SCRIPT = /^(javascript|vbscript|data|file|content|blob|about|chrome|chrome-extension|view-source|jar|filesystem|ms-msdt|search-ms|ms-officecmd):/i;
const SCHEME = /^([a-z][a-z0-9+.-]{1,40}):/i;

// The article for a scheme said aloud: "an about: link", "an ms-msdt: link", "a file: link".
/** @type {(scheme: string) => string} */
const article = (scheme) => (/^(about|ms-)/i.test(scheme) ? 'an' : 'a');

/**
 * @param {string} text
 * @param {ClassifyOptions} opts
 * @returns {Draft}
 */
function classify(text, opts) {
  const lead = text.replace(/^[\s\uFEFF\u200B-\u200F\u2060]+/, '');
  const trimmed = lead.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) {
    if (opts.bytes && opts.bytes.length && !/^[\s\u200B-\u200F\u2060\uFEFF]+$/.test(text)) return binary(opts.bytes, opts);
    if (/\S/.test(text)) {
      // Only invisible characters: it looks empty, but it is not (the warning below names them).
      return { kind: 'text', tier: 'check', title: 'Only invisible characters', scheme: null, summary: 'This code holds only invisible characters, so it looks empty but is not. Nothing in it opens anything.', fields: [], links: [], warnings: [], secret: false };
    }
    return { kind: 'empty', tier: 'info', title: 'An empty code', scheme: null, summary: 'This code holds no text.', fields: [], links: [], warnings: [], secret: false };
  }

  // Binary content (a CompactSeedQR is 16 or 32 raw bytes).
  if (opts.bytes && (opts.contentType === 'Binary' || (CONTROL.test(text) && opts.bytes.length <= 64)) && !/^[\x20-\x7e\s]*$/.test(text)) {
    if (opts.bytes.length === 16 || opts.bytes.length === 32) {
      const p = seedPayload(entropyWords(opts.bytes), 'CompactSeedQR', true);
      p.title = 'Possibly a wallet recovery phrase in compact form (CompactSeedQR)';
      p.summary = `This code holds exactly ${opts.bytes.length} bytes of raw data, the size of a wallet recovery phrase stored as a CompactSeedQR. If it is one, it is the key to a crypto wallet.`;
      p.fields[2] = field('Checksum', 'Any data of this size reads as valid words, so this is a guess from its size alone.');
      return p;
    }
    if (opts.contentType === 'Binary') return binary(opts.bytes, opts);
  }

  // Secrets and account linking (Stop), before anything that could look like a link.
  if (lower.startsWith('otpauth-migration://')) return otpMigration(trimmed);
  if (lower.startsWith('otpauth://')) return otpauth(trimmed);
  if (/^nostr:/i.test(trimmed) || /^(npub1|nsec1|nprofile1|note1|nevent1|naddr1|nrelay1|ncryptsec1)[02-9ac-hj-np-z]+$/.test(lower)) return nostr(trimmed);
  if (lower.startsWith('bunker://')) {
    return accountLink('bunker', 'A connection to a Nostr remote signer (bunker)', 'A connection to a Nostr remote signer. It lets an app sign posts and messages as you.', trimmed,
      'Whoever has this code can connect an app to the signer and sign as you, because the secret in it is the permission. Only use it in an app you set up yourself.');
  }
  if (lower.startsWith('nostrconnect://')) {
    return accountLink('nostrconnect', 'A request to connect your Nostr signer', 'An app asks your Nostr signer for permission to sign as you.', trimmed,
      'Scanning this with your signer would let the app that made the code sign posts and messages as you. Only scan it when you are setting up an app yourself.');
  }
  if (lower.startsWith('nostr+walletconnect://')) {
    return accountLink('nwc', 'A Lightning wallet connection (Nostr Wallet Connect)', 'A connection to a Lightning wallet. It holds a secret that allows payments.', trimmed,
      'Whoever has this code can spend from the connected wallet, up to the limits set for it. Never share a picture of it.');
  }
  if (lower.startsWith('sgnl://linkdevice')) {
    return accountLink('sgnl', 'Links your Signal account to another device', 'This links your Signal account to another device.', trimmed,
      'Whoever controls that device will read your future messages. Only scan it with Signal when you are setting up your own computer.');
  }
  if (lower.startsWith('tg://login')) {
    return accountLink('tg', 'Signs a device in to your Telegram account', 'This signs another device in to your Telegram account.', trimmed,
      'Scanning this with Telegram signs in the device that showed it, as you: it would read your chats. Only scan it on a device you are setting up yourself.');
  }
  if (lower.startsWith('fido:/')) {
    return accountLink('FIDO', 'A passkey sign-in from a nearby computer', 'A passkey sign-in request from a computer near you.', trimmed,
      'Your phone would sign that computer in with your passkey. Only continue if you started a sign-in on a computer next to you.');
  }
  if (/^wc:[0-9a-f-]+@\d/i.test(trimmed)) {
    return accountLink('wc', 'Connects a crypto wallet to a site or app (WalletConnect)', 'A request to connect a crypto wallet to a website or app.', trimmed,
      'Connecting lets the site or app that made this code ask your wallet to sign messages and send payments. Only connect to a site you opened yourself, and read every request in your wallet.');
  }
  if (/^bankid\.[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/i.test(trimmed)) {
    return accountLink('bankid', 'A BankID sign-in code from another screen', 'A BankID code shown by a website or app, to sign in or sign something as you.', trimmed,
      'Scanning this with the BankID app identifies you, or signs, on the screen that showed it. Only scan it on a site you opened yourself, never one someone sent you.');
  }
  if (/^bankid:/i.test(trimmed)) {
    return accountLink('bankid', 'Starts a BankID sign-in', 'This starts a BankID sign-in or signature that someone else began.', trimmed,
      'It would let the site that started it identify you, or have you sign something. Only continue if you started it yourself.');
  }
  if (/^\d@[A-Za-z0-9+/=_-]{16,},[A-Za-z0-9+/=_-]{20,},[A-Za-z0-9+/=_-]{20,}/.test(trimmed)) {
    return accountLink('whatsapp', 'Looks like a WhatsApp linking code', 'This looks like the code WhatsApp Web shows to link a computer to a phone.', trimmed,
      'Scanning it with WhatsApp would link the computer that showed it to your account, and it would read your chats. Only scan codes on your own computer\u2019s screen.');
  }
  if (/^\[Interface\]/i.test(trimmed) && /^\s*PrivateKey\s*=/im.test(trimmed)) return wireguard(trimmed);
  if (NODE_SCHEMES.test(trimmed)) return lightningNode(trimmed);
  if (/^nc:\/\/login\//i.test(trimmed)) return nextcloud(trimmed);
  if (/^(?:cashu:)?cashu[AB][A-Za-z0-9_\-+/=]{20,}$/.test(trimmed)) return cashu(trimmed);
  if (/^LPA:1\$[^$\s]+\$/i.test(trimmed)) return esim(trimmed);
  if (/^-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/.test(trimmed)) return privateKey(/PGP/.test(trimmed) ? 'PGP' : /OPENSSH/.test(trimmed) ? 'SSH' : 'PEM', trimmed);
  if (/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(trimmed)) return privateKey('age', trimmed);
  {
    // Bitcoin keys: WIF and extended private keys (xprv, yprv, zprv and test-network kin).
    if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(trimmed)) {
      const b = base58Check(trimmed);
      if (b && (b[0] === 0x80 || b[0] === 0xef) && (b.length === 33 || (b.length === 34 && b[33] === 1))) return privateKey('Bitcoin, WIF', trimmed, [field('Checksum', 'Its checksum passes.')]);
    }
    if (/^[xyztuv]prv[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(trimmed) && base58Check(trimmed)) return privateKey('wallet master key, extended private key', trimmed, [field('Checksum', 'Its checksum passes.')]);
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
      const p = privateKey('64 hexadecimal characters', trimmed);
      p.title = 'Possibly a private key';
      p.summary = 'This code holds 64 hexadecimal characters, the shape of an Ethereum or Bitcoin private key. It could also be a harmless checksum, but treat it as a key.';
      return p;
    }
  }
  const phrase = recoveryPhrase(trimmed);
  if (phrase) return seedPayload(phrase.words, { bip39: 'BIP-39', monero: 'Monero', slip39: 'SLIP-39' }[phrase.list.kind], phrase.checksum, phrase.list);
  if (/^(\d{48}|\d{96})$/.test(trimmed)) {
    const p = seedQr(trimmed);
    if (p) return p;
  }
  const found = TOKENS.filter(([, re]) => re.test(trimmed)).map(([name]) => name);
  if (found.length) return tokenPayload(trimmed, found);
  const embedded = embeddedKey(trimmed);
  if (embedded) {
    return secretPayload('key-in-text', `Text with a private key in it (${embedded})`, `This text holds a private key (${embedded}) among other words. Whoever has it controls what it protects.`, [
      field('Kind', embedded),
      field('The text', trimmed, { secret: true, mono: true, copy: 'Copy the text' }),
    ], [warn('private-key', 'stop', `Whoever has this code has the key: they can sign in, sign or spend as its owner. ${NEVER_SHARE[0].toUpperCase()}${NEVER_SHARE.slice(1)}.`)]);
  }

  // Scripts and local files (Stop). A browser drops leading control characters, and tabs and
  // line breaks anywhere, from an address before reading it, so "java<tab>script:" is a script.
  const squeezed = trimmed.replace(/^[\u0000-\u0020]+/, '').replace(/[\t\n\r]/g, '');
  if (SCRIPT.test(squeezed)) {
    const scheme = /** @type {RegExpExecArray} */ (SCRIPT.exec(squeezed))[1].toLowerCase();
    return {
      kind: 'script', tier: 'stop', title: 'Not an address: a script or a file on the device', scheme,
      summary: `This is ${article(scheme)} ${scheme}: link. It runs code or opens something on the device instead of going to a web address, so CheckLink never opens it.`,
      fields: [], links: [], secret: false,
      warnings: [warn('script', 'stop', 'Contains a script or a local file, not an address. There is no reason to open it from a code.')],
    };
  }

  // Web addresses.
  const bookmark = /^(?:URLTO:|MEBKM:)/i.test(trimmed);
  const linkText = bookmark ? (/^URLTO:/i.test(trimmed) ? trimmed.slice(6) : unescapeDocomo((docomoPairs(trimmed.slice(6)).find(([k]) => k === 'URL') || [])[1] || '')) : trimmed;
  const fl = findLinks(linkText).links;
  if (fl.length === 1 && fl[0].start === 0 && fl[0].end === linkText.trim().length) {
    const link = fl[0].link;
    const full = fl[0].bare ? `https://${link}` : link;
    try {
      const u = new URL(full);
      if (/^(?:www\.)?(?:discord|discordapp)\.com$/i.test(u.hostname) && /^\/ra\//i.test(u.pathname)) {
        return accountLink('discord', 'A Discord sign-in code', 'This is the code Discord shows to sign a computer in with your phone.', trimmed,
          'Scanning it with the Discord app signs in the computer that showed it, as you. Only scan the code on your own computer\u2019s screen, never one someone sent you.', { links: [] });
      }
    } catch { /* findLinks only returns addresses URL() can read */ }
    /** @type {PayloadField[]} */
    const fields = [];
    if (/^MEBKM:/i.test(trimmed)) {
      const title = (docomoPairs(trimmed.slice(6)).find(([k]) => k === 'TITLE') || [])[1];
      if (title) fields.push(field('Bookmark title', unescapeDocomo(title)));
    }
    const notes = webNotes(full);
    return {
      kind: 'web', tier: notes.reduce((t, w) => higher(t, w.tier), /** @type {Tier} */ ('info')), title: notes.some((w) => w.id === 'vipps') ? 'A Vipps MobilePay payment code' : 'A web address', scheme: bookmark ? 'bookmark' : 'web',
      summary: 'A web address. Nothing has been opened.',
      fields, links: [link], warnings: notes, secret: false,
    };
  }

  // Structured payloads.
  if (/^WIFI:/i.test(trimmed)) return wifi(trimmed);
  if (/^MECARD:/i.test(trimmed)) return mecard(trimmed);
  if (/^BEGIN:VCARD/i.test(trimmed)) return vcard(trimmed);
  if (/^BEGIN:(VEVENT|VCALENDAR)/i.test(trimmed)) return vevent(trimmed);
  if (/^(mailto:|MATMSG:|SMTP:)/i.test(trimmed)) return email(trimmed);
  if (/^tel:/i.test(trimmed)) return phone(trimmed);
  if (/^(sms|smsto|mms|mmsto):/i.test(trimmed)) return sms(trimmed);
  if (/^geo:/i.test(trimmed)) return geo(trimmed);
  if (/^BCD\r?\n/.test(trimmed)) return epc(trimmed);
  if (/^SPC\r?\n/.test(trimmed)) return swissBill(trimmed);
  if (/^SPD\*1\.0\*/i.test(trimmed)) return czechSpd(trimmed);
  if (/^bitcoin:/i.test(trimmed)) return bitcoin(trimmed);
  if (/^lightning:/i.test(trimmed) || /^ln(bc|tb|bcrt|tbs)[0-9a-z]{20,}$/i.test(trimmed) || /^lnurl1[02-9ac-hj-np-z]+$/i.test(trimmed) || /^(lnurl[pwc]|keyauth):\/\//i.test(trimmed)) return lightning(trimmed);
  if (/^ethereum:/i.test(trimmed)) return ethereum(trimmed);
  const sch = (SCHEME.exec(trimmed) || [])[1];
  if (sch && CRYPTO[sch.toLowerCase()]) return crypto(trimmed, sch.toLowerCase());
  if (/^upi:\/\//i.test(trimmed)) return upi(trimmed);
  if (/^000201/.test(trimmed) && /6304[0-9A-Fa-f]{4}$/.test(trimmed)) return emv(trimmed);
  if (/^C\+?\d{6,15};[\d.,]*;[^;]*;\d*$/.test(trimmed)) return swishC(trimmed);
  if (/^swish:/i.test(trimmed)) return swishLink(trimmed);
  if (/^M[1-4][A-Z/ .'-]{20}[E ][A-Z0-9 ]{7}[A-Z]{3}[A-Z]{3}[A-Z0-9 ]{3}[0-9A-Z ]{5}\d{3}/.test(trimmed)) return boardingPass(trimmed);
  if (/^HC1:/.test(trimmed)) {
    return {
      kind: 'health', tier: 'check', title: 'A health certificate (EU Digital COVID Certificate)', scheme: 'HC1',
      summary: 'An EU Digital COVID Certificate. CheckLink does not decode it further.',
      fields: [], links: [], secret: true,
      warnings: [warn('health', 'check', 'It holds the holder\u2019s name, date of birth and vaccination or test details. Whoever has this code can read them.')],
    };
  }
  if (/^intent:/i.test(trimmed)) return intentUri(trimmed);
  if (/^\(\d{2,4}\)/.test(trimmed)) return gs1Elements(trimmed);
  if ((LINEAR.test(opts.format || '') && /^\d{8,14}$/.test(trimmed)) || (/^\d{13}$/.test(trimmed) && gs1Valid(trimmed) && !opts.format)) return product(trimmed, opts.format);
  if (sch && !/^(https?|www)$/i.test(sch) && trimmed.length > sch.length + 1) {
    // A link for some app: name:// anything, a scheme CheckLink knows, or a scheme with the
    // characters ordinary words lack (ms-word:, web+foo:, com.example.app:). "Note: hello" and
    // "abc:xyz" stay plain text.
    const after = trimmed.slice(sch.length + 1);
    const known = APPS[sch.toLowerCase()] || /^(market|itms-services|itms-apps|itms-appss)$/i.test(sch);
    if (after.startsWith('//') || (known && !/^\s/.test(after)) || (/[+.\-\d]/.test(sch) && !/\s/.test(after))) return appLauncher(trimmed, sch);
  }
  return plainText(text);
}

/**
 * @param {Uint8Array} bytes
 * @param {ClassifyOptions} opts
 * @returns {Draft}
 */
function binary(bytes, opts) {
  return {
    kind: 'binary', tier: 'info', title: 'Data that is not text', scheme: null,
    summary: `This code holds ${bytes.length.toLocaleString('en-GB')} bytes of data that is not text. CheckLink cannot say more about it.`,
    fields: [field('First bytes (hexadecimal)', toHex(bytes.subarray(0, 48)).replace(/(..)/g, '$1 ').trim() + (bytes.length > 48 ? ' \u2026' : ''), { mono: true })],
    links: [], warnings: [], secret: false, binaryLength: bytes.length,
  };
}

// == the public function ==

/**
 * @param {unknown} input  the code's text (anything else reads as empty)
 * @param {InspectOptions} [opts]
 * @returns {Payload}
 */
export function inspect(input, opts = {}) {
  const raw = typeof input === 'string' ? input : '';
  const bytes = opts.bytes instanceof Uint8Array ? opts.bytes : null;
  const truncated = raw.length > MAX_TEXT;
  // Classification reads the code up to 20,000 characters: every 2D code fits in that many.
  const text = raw.length > 20000 ? raw.slice(0, 20000) : raw;
  let p;
  try {
    p = classify(text, { bytes, format: opts.format || null, contentType: opts.contentType || null });
  } catch {
    p = plainText(text);
  }
  const links = [...new Set(p.links || [])].slice(0, 20);
  const warnings = dedupe(p.warnings || []);
  // Invisible or direction-changing characters, anywhere in what is shown.
  const shown = [text, ...(p.fields || []).map((f) => f.value)];
  const marks = new Set();
  for (const s of shown) for (const c of invisibleChunks(s)) if (c.invisible) marks.add(c.label);
  // Line and paragraph separators are neither invisible nor controls in Unicode's terms, but
  // they break a line: in a payee's name they can fake a second, labelled line.
  for (const s of shown) for (const ch of String(s).match(/[\u2028\u2029]/g) || []) marks.add(ch === '\u2028' ? 'U+2028 line separator' : 'U+2029 paragraph separator');
  if (CONTROL.test(text)) marks.add('control characters');
  if (marks.size) {
    warnings.push(warn('invisible', 'check', `This code contains invisible, control or direction-changing characters (${[...marks].slice(0, 3).join(', ')}${marks.size > 3 ? ', and more' : ''}). CheckLink shows them as marks. They can make text read differently from what it holds.`));
  }
  // In a payment, a line break inside one detail (a name, an account) can make part of it look
  // like a separate line with its own label. Messages written by the code's maker may have them.
  if (p.kind === 'payment') {
    const broken = (p.fields || []).filter((f) => !f.label.includes(WRITTEN_BY_MAKER) && !/as written$/.test(f.label) && /[\r\n\u2028\u2029\u0085\v\f]/.test(f.value)).map((f) => f.label);
    if (broken.length) warnings.push(warn('line-break', 'check', `A line break inside ${broken.slice(0, 2).join(' and ')} can make part of it look like a separate line, with its own label. Read each detail to its end.`));
  }
  const tier = warnings.reduce((t, w) => higher(t, w.tier), p.tier);
  return {
    kind: p.kind, tier, title: p.title, summary: p.summary, scheme: p.scheme ?? null,
    fields: p.fields || [], links, warnings: warnings.sort((a, b) => TIER[a.tier] - TIER[b.tier]),
    secret: !!p.secret, text: truncated ? raw.slice(0, MAX_TEXT) : raw, truncated, length: raw.length,
    format: opts.format || null, formatLabel: formatLabel(opts.format || 'QRCode'),
  };
}

// For tests and the page: the payload kinds and what each is called.
/** @type {Kind[]} */
export const KINDS = ['web', 'text', 'wifi', 'contact', 'event', 'email', 'phone', 'sms', 'geo', 'payment', 'app', 'secret', 'account-link', 'script', 'product', 'boarding-pass', 'health', 'nostr', 'binary', 'empty'];
