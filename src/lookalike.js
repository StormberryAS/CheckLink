// CheckLink's look-alike checks (stage 3): addresses written to pass for another one. Pure ES
// module with no DOM dependencies; it runs in browsers and in Node 24, and it never makes a
// network request. src/link-core.js turns what it finds into warnings.
//
//   lettersFinding(host), symbolFinding(host)   the letters and symbol findings alone
//   lookAlike(host)        { letters, symbol, brand } for a host as the browser's URL parser
//                          gives it (small letters, xn-- for international names); each is null
//                          or a finding, described below
//   brandMatch(host)       the brand finding alone
//   skeleton(text)         text reduced to what it looks like: Unicode's confusables (src/confusables.js)
//                          map every character that can pass for plain ASCII to that ASCII, accents
//                          and other marks are dropped, small letters throughout (a Cyrillic a ->
//                          a, the digit 0 -> o, m -> rn, a slashed o -> o)
//   decodeLabel(label)     one xn-- label as the letters it stands for (RFC 3492), or the label
//   decodeHost(host)       every label decoded
//   punyDecode(text)       RFC 3492 decoding of a label without its xn--, or null
//   brandText(finding, placeName), lettersText(finding, brand), symbolText(finding, brand)
//                          the warning sentences, in CheckLink's words; placeName is link-core's
//                          "evil.io (full name: paypal.com.evil.io)"
//   brandShort(finding), lettersShort(finding, brand), symbolShort(finding, brand)
//                          the same in one short sentence, for the first screen and for screen
//                          readers ("This address is made to look like paypal.com.")
//   bothForms(host)        a host as a person reads it, then the form the browser uses
//   markedHost(host)       a host as a person reads it, with each letter from another alphabet
//                          named: p[Cyrillic \u0430]ypal.com, so the note never shows a name that
//                          looks exactly like the real one
//
// letters (spec warning 4): a part of the name that mixes alphabets (Latin with Cyrillic, Greek,
// Armenian, Cherokee or any other, beyond the mixes Japanese, Chinese and Korean names use), or is
// written wholly in one other alphabet using only letters that look Latin (coco.com in four Cyrillic letters).
// Under an ending in that same alphabet (a Russian word under .rf in Cyrillic) a whole-alphabet name
// is ordinary, as browsers treat it, unless it passes for a listed brand (apple in Cyrillic letters
// under the same ending). The Norwegian letters ae, o-slash and a-ring, and every other
// accented Latin letter, are Latin and never count here; the brand check below still compares
// names without their accents. { scripts: [names], whole, reads, host }, reads being the name as
// it looks once the look-alike letters are read as Latin ones (null when they are not all
// look-alikes). foreign lists the letters from another alphabet in those parts, each as
// { char, script }, so the page can box them where it shows the address.
//
// symbol: a character inside a name that looks like a hyphen, a full stop, a slash or other
// punctuation but is not that character (U+2010 hyphen, U+2215 division slash, U+00B7 middle dot),
// so norsk<U+2010>tipping.no reads as norsk-tipping.no. Characters from Japanese, Chinese and
// Korean that look like a hyphen or a slash (the katakana long vowel mark U+30FC, the Chinese one
// U+4E00, the katakana no U+30CE) count too, but only inside a name that is otherwise plain Latin
// letters and digits: between Japanese characters they are spelling. Left alone: the Catalan
// l<U+00B7>l (as in col<U+00B7>legi.cat) and the katakana middle dot in a Japanese name.
// { chars: [{ char, code, looks }], reads, host }.
//
// brand (spec warning 5): the registrable domain (the part of the name its owner registered, from
// the Public Suffix List) imitates a brand in src/brands.js, or the brand's own domain is written
// inside a longer address. how is one of:
//   letters    the name is the brand's written with letters that only look the same: another
//              alphabet, an accent or mark added, a look-alike Latin letter (the script g, U+0261, for g),
//              or such letters and one typing slip together (paypa<dotless i>.com); detail names the
//              letters put in when there are one or two ("\u00F8 in place of o")
//   ascii      the same, in plain ASCII: digits for letters (paypa1, g00gle, vipp5), rn for m
//   hyphen     the brand's name with hyphens put in (pay-pal.com)
//   typo       one slip from a distinct mark of five letters or more: a letter doubled, a letter
//              left out (not the first; in a mark under eight letters only one of a doubled pair),
//              two letters swapped, one changed to its neighbour on the keyboard (not the first),
//              or a small l and an i swapped (linkedln)
//   combo      the brand's name joined to other words (paypal-secure-login.com, dnb-sikkerhet.no),
//              or followed by the rest of its own domain (dnb-no.com), split by hyphens
//              (pay-pal-login.com), or with a typing slip or digits in it next to a lure word
//              (paypall-login.com, vipp5-refusjon.com)
//   free-host  any of the above, or the brand's name alone, under a name anyone can create
//              (paypal.pages.dev, posten.firebaseapp.com)
//   written    the brand's own domain written at the start of, or inside, a longer address
//              (paypal.com.evil.io, www.dnb.no.secure-login.ru, paypal-com.evil.io), split across
//              the last dot (www.dnb.no-sikkerhet.com), or its name followed by a country ending
//              (www.amazon.co.uk.evil.io; shown says what is written)
//   mentions   a distinct mark (or a word mark with a lure word in its part or the next) in the
//              part before the registrable domain (paypal.com-account-verify.io,
//              amazon.signin.evil.io), also split by hyphens, run together with a lure word or
//              its ending, or with a typing slip before its ending (gooogle.com.evil.io)
// Never a look-alike: a host under one of a listed brand's domains or platforms, or under a
// name on a free hosting address that the brand itself holds (google.github.io), a name that
// is exactly one of the marks under an ordinary ending (amazon.co.uk, dnb.com, posten.se), which
// is often the same company and otherwise a namesake CheckLink cannot tell apart, and the real
// names in rules/brands.json (correos.es, d-nb.info). Word marks (ordinary words and short names:
// apple, amazon, posten, dnb) need more before they count; see rules/brands.json.
// { brand, own, how, detail, domain, suffix, private, host, written, shown }.

import { CONFUSABLES } from './confusables.js?v=01615527';
import { BRANDS, LURES, REAL_NAMES } from './brands.js?v=a389c3ea';
import { domainInfo, publicSuffix } from './domain.js?v=e177a464';

const norm = (h) => String(h || '').toLowerCase().replace(/\.$/, '');

// == punycode ==

// RFC 3492 decoding of one xn-- label (without the xn--), enough to read it back as the letters
// it stands for; null when it is not valid.
export function punyDecode(text) {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const input = String(text).toLowerCase();
  const out = [];
  const d = input.lastIndexOf('-');
  for (const ch of d > 0 ? input.slice(0, d) : '') {
    if (ch.charCodeAt(0) >= 0x80) return null;
    out.push(ch.charCodeAt(0));
  }
  let n = 128;
  let i = 0;
  let bias = 72;
  let pos = d > 0 ? d + 1 : 0;
  while (pos < input.length) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (pos >= input.length) return null;
      const c = input.charCodeAt(pos++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 97 && c <= 122 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
      if (i > 0x7fffffff || w > 0x7fffffff) return null;
    }
    const len = out.length + 1;
    let delta = oldi === 0 ? Math.floor((i - oldi) / 700) : (i - oldi) >> 1;
    delta += Math.floor(delta / len);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    bias = k + Math.floor(((base - tMin + 1) * delta) / (delta + 38));
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10FFFF) return null;
    out.splice(i, 0, n);
    i++;
  }
  try {
    return String.fromCodePoint(...out);
  } catch {
    return null;
  }
}

export function decodeLabel(label) {
  if (!label.startsWith('xn--')) return label;
  const text = punyDecode(label.slice(4));
  return text || label;
}

export const decodeHost = (host) => norm(host).split('.').map(decodeLabel).join('.');

// == what a name looks like ==

const MARK = /\p{M}/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

// One character as the ASCII it can pass for, or itself.
const looksAs = (ch) => CONFUSABLES[ch.codePointAt(0)] ?? ch;

export function skeleton(text) {
  let out = '';
  for (const ch of String(text).toLowerCase().normalize('NFD')) {
    if (MARK.test(ch) || IGNORABLE.test(ch)) continue;
    out += looksAs(ch);
  }
  return out.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// The digits that stand in for letters in look-alike names, beyond the two (0 and 1) that
// Unicode's confusables already give. 1 can stand for l (skeleton) or i (here).
const DIGIT_FOR = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'b', 7: 't', 8: 'b', 9: 'g' };
const digitsRead = (s) => s.replace(/[0-9]/g, (d) => DIGIT_FOR[d]);
// Plain letters that pass for another letter in many typefaces, beyond rn for m, which Unicode's
// confusables already give: vv for w, cl for d and q for g (vvhatsapp, cliscord, gooqle).
// Typosquatting tools try them too (dnstwist's homoglyph list). Like the digits, they count for
// a whole name, a name next to a lure word or a name before the brand's own ending
// (gooqle.com.evil.io), never inside a longer word (decision L2 of 11 October 2026, accepted
// after a run over the Tranco top million and the real names found no new false alarm).
const LETTERS_FOR = [['vv', 'w'], ['cl', 'd'], ['q', 'g']];
const LETTER_PAIR = /vv|cl|q/;
const lettersRead = (s) => LETTERS_FOR.reduce((out, [from, to]) => out.split(from).join(to), s);
// A name read with both: digits for letters, then these letters for the one they pass for.
const looksRead = (s) => lettersRead(digitsRead(s));
// Whether name t is mark m's name with digits (vipp5, only for a mark with none), these letters
// (gooqle), or both (g00qle) put in. The digits alone are tried first, so a mark that has cl, q
// or vv itself (icloud) is still found behind digits (1cloud).
function readsAs(t, m) {
  if (m.flat.length < 4) return false;
  const digits = /\d/.test(t);
  if (digits && /\d/.test(m.flat)) return false;
  return (digits && digitsRead(t) === m.flat) || (LETTER_PAIR.test(t) && looksRead(t) === m.flat);
}

// Characters from Japanese, Chinese and Korean that look like a hyphen, a slash or a small l but
// are outside the ASCII part of Unicode's table (their prototypes there are not ASCII): the
// katakana long vowel mark, the Chinese one, the Hangul eu (which the browser writes as U+1173),
// the Chinese upright line and the Hangul i (written as U+1175). The katakana no (a slash) and
// U+4E36 (a backslash) are in the table already. They count only inside a name that is otherwise
// plain Latin letters and digits (norsk<U+30FC>tipping.no); in a Japanese word they are spelling.
const CJK_LOOKS = {
  '\u30FC': '-', '\u4E00': '-', '\u3161': '-', '\u1173': '-',
  '\u4E28': 'l', '\u3163': 'l', '\u1175': 'l',
  '\u30CE': '/', '\u4E36': '\\',
};
const cjkLook = (ch) => CJK_LOOKS[ch] ?? null;
// Every character of the label is plain ASCII (letters, digits, hyphen, underscore) or one of
// the characters above, and at least one is a Latin letter.
const plainWith = (arr) => arr.some((c) => /[a-z]/.test(c)) && arr.every((c) => /[a-z0-9_-]/.test(c) || cjkLook(c) !== null);
// A label read with those characters as what they look like, when it is a plain Latin name with
// them in it (norsk<U+30FC>tipping -> norsk-tipping, paypa<U+4E28> -> paypal); otherwise as it is.
function latinised(label) {
  const arr = Array.from(label);
  if (!arr.some((c) => cjkLook(c) !== null) || !plainWith(arr)) return label;
  return arr.map((c) => (cjkLook(c) && /^[a-z-]$/.test(cjkLook(c)) ? cjkLook(c) : c)).join('');
}

// == alphabets ==

const SCRIPT_NAMES = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Cherokee', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo', 'Arabic', 'Hebrew', 'Thai', 'Lao', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Tibetan', 'Myanmar', 'Khmer', 'Ethiopic', 'Mongolian', 'Coptic', 'Canadian_Aboriginal', 'Tifinagh', 'Glagolitic', 'Runic', 'Ogham', 'Nko', 'Vai', 'Lisu', 'Syriac', 'Thaana', 'Adlam', 'Osage', 'Deseret', 'Yi', 'Javanese', 'Balinese', 'Sundanese', 'Old_Italic', 'Gothic'];
const SCRIPTS = SCRIPT_NAMES.map((n) => [n, new RegExp(`\\p{Script=${n}}`, 'u')]);
const SHOWN_SCRIPT = { Han: 'Chinese', Canadian_Aboriginal: 'Canadian syllabics', Nko: "N'Ko", Old_Italic: 'Old Italic', Other: 'another alphabet' };
const scriptWord = (s) => SHOWN_SCRIPT[s] || s;
const LETTER = /\p{L}/u;
// Letters shared by several alphabets (the katakana long vowel mark, for one) belong to none.
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u;
const scriptOf = (ch) => {
  if (!LETTER.test(ch) || SHARED.test(ch)) return null;
  for (const [n, rx] of SCRIPTS) if (rx.test(ch)) return n;
  return 'Other';
};
// The mixes that Japanese, Chinese and Korean names use, with or without Latin (UTS #39,
// "highly restrictive").
const MIXES = [['Latin', 'Han', 'Hiragana', 'Katakana'], ['Latin', 'Han', 'Bopomofo'], ['Latin', 'Han', 'Hangul']];
const allowedMix = (set) => set.size <= 1 || MIXES.some((m) => [...set].every((s) => m.includes(s)));
const CJK = new Set(['Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo']);

// Whether one character passes for a plain small Latin letter or digit.
const passesLatin = (ch) => /^[a-z0-9]+$/.test(skeleton(ch));

// How many labels at the end of a host are its public suffix (com, co.uk, the Cyrillic .rf): those are the
// registries' own names, never a look-alike made by whoever owns the address.
function suffixLabels(host) {
  const ps = publicSuffix(host);
  return ps ? ps.suffix.split('.').length : 1;
}

export function lettersFinding(host) {
  const labels = norm(host).split('.');
  const decoded = labels.map(decodeLabel);
  const own = labels.length - suffixLabels(norm(host));
  const tld = decoded[decoded.length - 1];
  const tldScripts = new Set(Array.from(tld, scriptOf).filter(Boolean));
  const hits = [];
  decoded.forEach((label, i) => {
    if (label === labels[i] || i >= own) return; // plain ASCII, an xn-- label that does not decode, or the ending
    const letters = Array.from(label).filter((ch) => scriptOf(ch));
    const scripts = new Set(letters.map(scriptOf));
    if (!allowedMix(scripts)) {
      const foreign = letters.filter((ch) => scriptOf(ch) !== 'Latin');
      hits.push({ i, scripts: [...scripts].filter((s) => s !== 'Latin'), mixed: true, lookLatin: foreign.every(passesLatin) });
      return;
    }
    if (scripts.size === 1) {
      const only = [...scripts][0];
      if (only !== 'Latin' && !CJK.has(only) && letters.length && letters.every(passesLatin)) {
        hits.push({ i, scripts: [only], mixed: false, lookLatin: true, sameEnding: tldScripts.size === 1 && tldScripts.has(only) });
      }
    }
  });
  if (!hits.length) return null;
  const names = [...new Set(hits.flatMap((x) => x.scripts))].filter((s) => s !== 'Latin');
  const allLook = hits.every((x) => x.lookLatin);
  const foreign = [];
  for (const x of hits) {
    for (const ch of decoded[x.i]) {
      const sc = scriptOf(ch);
      if (sc && sc !== 'Latin' && !foreign.some((f) => f.char === ch)) foreign.push({ char: ch, script: scriptWord(sc) });
    }
  }
  const reads = allLook
    ? decoded.map((label, i) => (hits.some((x) => x.i === i) ? Array.from(label, (ch) => (/[\x00-\x7f]/.test(ch) ? ch : skeleton(ch))).join('') : label)).join('.')
    : null;
  return {
    scripts: names.length ? names : ['Latin'],
    whole: hits.every((x) => !x.mixed),
    // Every hit is a whole-alphabet name under an ending in the same alphabet: ordinary there.
    ordinary: hits.every((x) => !x.mixed && x.sameEnding),
    reads,
    foreign,
    host: norm(host),
  };
}

// == symbols that look like punctuation ==

const DOTS = new Set(['\u00B7', '\u0387', '\u2022', '\u2024', '\u2027', '\u2219', '\u22C5', '\u30FB', '\uFF65', '\u16EB', '\u2E31', '\u1427', '\u0701', '\u0702', '\uA4F8', '\u05C5', '\u02D9']);
const ASCII_PUNCT = /^[!-/:-@[-`{-~]+$/;
const PD = /\p{Pd}/u;
const SYMBOL_WORDS = { '-': 'a hyphen', '.': 'a full stop', '/': 'a slash', '\\': 'a backslash', ':': 'a colon', '@': 'an at sign', _: 'an underscore', "'": 'an apostrophe', ',': 'a comma' };

export function symbolFinding(host) {
  const labels = norm(host).split('.');
  const decoded = labels.map(decodeLabel);
  const own = labels.length - suffixLabels(norm(host));
  const chars = [];
  const readsLabels = decoded.map((label, i) => {
    if (label === labels[i] || i >= own) return label;
    const arr = Array.from(label);
    const latin = arr.some((ch) => scriptOf(ch) === 'Latin');
    const japanese = arr.some((ch) => ['Han', 'Hiragana', 'Katakana'].includes(scriptOf(ch)));
    const plain = plainWith(arr);
    return arr.map((ch, j) => {
      if (/[\x00-\x7f]/.test(ch) || MARK.test(ch) || /\p{N}/u.test(ch)) return ch;
      const t = CONFUSABLES[ch.codePointAt(0)];
      let looks = null;
      const cjk = cjkLook(ch);
      if (cjk !== null) {
        // A Japanese, Chinese or Korean character that looks like punctuation, in a name that is
        // otherwise plain Latin; the ones that look like a small l are for the brand check.
        if (!plain || /^[a-z]$/.test(cjk)) return ch;
        looks = cjk;
      } else if (LETTER.test(ch)) {
        return ch;
      } else if (DOTS.has(ch)) looks = '.';
      else if (t && ASCII_PUNCT.test(t)) looks = t;
      else if (PD.test(ch)) looks = '-';
      if (!looks) return ch;
      // The Catalan l<U+00B7>l, and the katakana middle dot between Japanese words, are spelling.
      if (ch === '\u00B7' && /l/i.test(arr[j - 1] || '') && /l/i.test(arr[j + 1] || '')) return ch;
      if ((ch === '\u30FB' || ch === '\uFF65') && japanese) return ch;
      // In a name with no Latin letters, only what can split it (a hyphen, dot or slash) counts.
      if (!latin && !['-', '.', '/'].includes(looks[0])) return ch;
      chars.push({ char: ch, code: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`, looks });
      return looks;
    }).join('');
  });
  if (!chars.length) return null;
  return { chars, reads: readsLabels.join('.'), host: norm(host) };
}

// == brands ==

let index = null;
function brandIndex() {
  if (index) return index;
  const official = new Map();
  const platforms = [];
  const marks = [];
  const runs = [];
  for (const b of BRANDS) {
    for (const d of b.domains) {
      official.set(d, b);
      runs.push({ brand: b, domain: d, labels: d.split('.').map((l) => skeleton(decodeLabel(l))) });
    }
    for (const p of b.platforms || []) platforms.push(p);
    // A name under a free hosting address that the brand holds (google.github.io, checked as the
    // GitHub account of Google itself): its own, like its domains, but never written into a
    // longer address as one of them.
    for (const h of b.hosted || []) official.set(h, b);
    for (const [label, kind, own] of b.marks) {
      const flat = label.replace(/-/g, '');
      const skel = skeleton(flat);
      // The rest of each of the brand's own domains that starts with this mark (no, for dnb.no),
      // so the mark followed by it counts as a mention of the brand (dnb-no.com).
      const tails = b.domains.map((d) => d.split('.')).filter((ls) => ls.length > 1 && skeleton(decodeLabel(ls[0])) === skel).map((ls) => ls.slice(1).map(skeleton));
      marks.push({ brand: b, label, flat, kind, own, skel, parts: label.split('-').map(skeleton), tails });
    }
  }
  // A run whose first label is one of the brand's own marks (dnb.no, paypal.com; not t.co or
  // s.team) can also count when it is split across a dot, joined by hyphens or run together.
  for (const r of runs) {
    r.mark = r.labels.length > 1 ? marks.find((m) => m.brand === r.brand && m.skel === r.labels[0]) || null : null;
  }
  // Longer runs first, so www.paypal.com.evil.io names paypal.com, not a shorter domain inside it.
  runs.sort((a, b) => b.labels.length - a.labels.length || b.domain.length - a.domain.length);
  index = {
    official, platforms, marks, runs,
    exact: new Set(marks.flatMap((m) => [m.label, m.flat])),
    strong: new Set(LURES.strong.map((w) => skeleton(w.replace(/-/g, '')))),
    weak: new Set(LURES.weak.map((w) => skeleton(w))),
    concat: LURES.concat.map((w) => skeleton(w)),
    realWords: new Set(REAL_NAMES.words),
    realDomains: new Set(REAL_NAMES.domains),
  };
  return index;
}

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const KEY = {};
ROWS.forEach((row, y) => Array.from(row).forEach((c, x) => { KEY[c] = [x + y * 0.5, y]; }));
const neighbours = (a, b) => {
  const p = KEY[a];
  const q = KEY[b];
  return !!p && !!q && a !== b && Math.abs(p[1] - q[1]) <= 1 && Math.abs(p[0] - q[0]) <= 1;
};

// The one typing slip that turns mark m into name c, or null.
export function typoKind(c, m) {
  if (c === m) return null;
  if (c.length === m.length + 1) {
    for (let i = 0; i < c.length; i++) {
      if (c.slice(0, i) + c.slice(i + 1) === m) return c[i] === c[i - 1] || c[i] === c[i + 1] ? 'doubled' : null;
    }
    return null;
  }
  if (c.length === m.length - 1) {
    // A letter left out, never the first. Below eight letters only one of a doubled pair counts
    // (gogle for google): dropping another letter from a short name often spells an ordinary
    // word (revolt from revolut).
    for (let i = 1; i < m.length; i++) {
      if (m.slice(0, i) + m.slice(i + 1) !== c) continue;
      if (m.length >= 8 || m[i] === m[i - 1] || m[i] === m[i + 1]) return 'missing';
    }
    return null;
  }
  if (c.length !== m.length) return null;
  const diff = [];
  for (let i = 0; i < c.length; i++) if (c[i] !== m[i]) diff.push(i);
  if (diff.length === 2 && diff[1] === diff[0] + 1 && c[diff[0]] === m[diff[1]] && c[diff[1]] === m[diff[0]]) return 'swapped';
  if (diff.length === 1 && diff[0] > 0 && neighbours(c[diff[0]], m[diff[0]])) return 'neighbour';
  // A small l for an i, or the other way round: in many typefaces the two differ only by a dot
  // (linkedln for linkedin). Unicode's confusables pair l with I and 1, not with i.
  if (diff.length === 1 && LOOK_PAIR.has(c[diff[0]] + m[diff[0]])) return c[diff[0]] === 'l' ? 'l-for-i' : 'i-for-l';
  return null;
}
const LOOK_PAIR = new Set(['li', 'il']);

// What was swapped in, for an ASCII look-alike: "the digit 1 in place of the letter l", "vv in
// place of the letter w".
function asciiDetail(label, mark) {
  if (label.length !== mark.length) {
    const pairs = [['rn', 'm'], ...LETTERS_FOR.filter(([from]) => from.length > 1)].filter(([from, to]) => label.includes(from) && mark.includes(to) && !mark.includes(from));
    if (pairs.length && looksRead(label.split('rn').join('m')) === mark) return pairs.map(([from, to]) => (from === 'rn' ? 'rn in place of m' : `${from} in place of the letter ${to}`)).join(' and ');
  }
  if (label.length === mark.length) {
    const pairs = [];
    for (let i = 0; i < label.length; i++) {
      if (label[i] === mark[i]) continue;
      const what = /\d/.test(label[i]) ? `the digit ${label[i]}` : label[i];
      const key = `${what} in place of ${/[a-z]/.test(mark[i]) ? `the letter ${mark[i]}` : mark[i]}`;
      if (!pairs.includes(key)) pairs.push(key);
    }
    if (pairs.length && pairs.length <= 3) return pairs.join(' and ');
  }
  if (label.includes('rn') && mark.includes('m') && !mark.includes('rn')) return 'rn in place of m';
  return 'characters that look alike';
}

// What was put in, for a name written with letters that only look the same, when one or two
// letters were: "ø in place of o" (to a Norwegian reader ø does not look like o, so
// the note says which letter it is), "the Cyrillic letter а in place of a". Null when more
// were swapped, or the lengths differ.
function letterPairs(written, mark) {
  const a = Array.from(written.normalize('NFC'));
  const b = Array.from(mark);
  if (a.length !== b.length) return null;
  const pairs = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const sc = scriptOf(a[i]);
    const what = sc && sc !== 'Latin' ? `the ${scriptWord(sc)} letter ${a[i]}` : a[i];
    const key = `${what} in place of ${b[i]}`;
    if (!pairs.includes(key)) pairs.push(key);
  }
  return pairs.length && pairs.length <= 2 ? pairs.join(' and ') : null;
}

// Where the run of skeleton labels `want` sits inside `labels`, or -1.
function runAt(labels, want) {
  for (let i = 0; i + want.length <= labels.length; i++) {
    if (want.every((w, k) => labels[i + k] === w)) return i;
  }
  return -1;
}

// Whether a token stands for a single-word mark with a slip: digits or look-alike letters for
// letters (vipp5, n3tflix, vvhatsapp), or one typing slip from a distinct mark of five letters or
// more (paypall).
function slipFor(t, m) {
  if (m.parts.length !== 1 || t === m.skel) return false;
  if (readsAs(t, m)) return true;
  return m.kind === 'distinct' && m.flat.length >= 5 && /^[a-z]+$/.test(t) && !!typoKind(t, m.flat);
}

// The two-letter country endings that are also sold as words (.tv, .me, .io, .it), after which a
// word mark is often just a word (live.tv, office.it): a word mark needs a real country ending.
const VANITY = new Set(['tv', 'me', 'io', 'ai', 'co', 'fm', 'am', 'to', 'ly', 'gg', 'cc', 'ws', 'la', 'is', 'it', 'in', 'us', 'so', 'do', 'be', 'im', 'at', 'by', 'my', 'id', 'ac', 'sh', 'vc', 'ms', 'tk', 'gs', 'nu', 'cx', 'st', 're']);
// Labels that together are exactly a public suffix from the list's ICANN section (de, co.uk,
// com.br), or null.
function icannSuffix(labels) {
  const cand = labels.join('.');
  const ps = publicSuffix(cand);
  return ps && ps.known && !ps.private && ps.suffix === cand ? cand : null;
}

export function brandMatch(host) {
  const h = norm(host);
  if (!h || h.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return null;
  const info = domainInfo(h);
  if (!info || !info.domain) return null;
  const ix = brandIndex();
  if (ix.official.has(info.domain) || ix.realDomains.has(info.domain)) return null;
  if (ix.platforms.some((p) => h === p || h.endsWith(`.${p}`))) return null;
  const reg = info.domain;
  const label = reg.slice(0, reg.length - info.suffix.length - 1);
  if (!info.private && ix.exact.has(label)) return null;
  const labelU = decodeLabel(label);
  const unicode = labelU !== label;
  // Read with the Japanese, Chinese and Korean characters that pass for a hyphen or an l in a
  // Latin name as what they look like.
  const labelL = latinised(labelU);
  const sk = skeleton(labelL);
  // An ordinary word or a shared name one slip from a mark (correos, applied): the slip, digit and
  // hyphen checks leave the whole name alone (rules/brands.json, real_names).
  const realWord = ix.realWords.has(label) || ix.realWords.has(sk);
  const sub = h.length > reg.length ? h.slice(0, h.length - reg.length - 1).split('.') : [];
  const base = { domain: reg, suffix: info.suffix, private: info.private, host: h, written: unicode ? decodeHost(h) : null };
  const found = (m, how, detail = null, extra = {}) => ({ brand: m.brand.name, own: m.own, mark: m.label, how: info.private ? 'free-host' : how, kind: how, detail, ...base, ...extra });

  // 1. The registrable name, whole.
  for (const m of ix.marks) {
    if (info.private && (label === m.label || label === m.flat)) return found(m, 'free-host');
  }
  for (const m of ix.marks) {
    if (sk === m.skel && labelU !== m.label && labelU !== m.flat) {
      if (unicode) return found(m, 'letters', letterPairs(labelU, m.flat));
      if (m.flat.length >= 4 && !realWord) return found(m, 'ascii', asciiDetail(label, m.flat));
    }
    if (realWord) continue;
    if (!unicode && readsAs(label, m)) return found(m, 'ascii', asciiDetail(label, m.flat));
    if (label.includes('-') && label !== m.label && sk.replace(/-/g, '') === m.skel) return found(m, unicode ? 'letters' : 'hyphen', unicode ? letterPairs(labelU, m.label) : null);
  }
  // 2. The brand's name joined to other words, with hyphens or (for a lure word) without.
  const tokens = labelL.split('-').filter(Boolean);
  const tokSk = tokens.map(skeleton);
  if (tokens.length > 1) {
    for (const m of ix.marks) {
      const at = runAt(tokSk, m.parts);
      if (at < 0 || tokens.length === m.parts.length) continue;
      const others = tokSk.filter((_, k) => k < at || k >= at + m.parts.length);
      // A word mark followed by the rest of the brand's own domain (dnb-no.com, amazon-com.net)
      // is the brand's address with a hyphen for the dot.
      const after = tokSk.slice(at + m.parts.length);
      const ownRest = m.tails.some((t) => t.every((w, k) => after[k] === w));
      if (m.kind === 'distinct' || ownRest || others.some((t) => ix.strong.has(t))) return found(m, 'combo');
    }
    // The name split by hyphens and joined to more, next to a lure word (pay-pal-login.com). A
    // lure is needed even for a distinct mark: split, some marks are two ordinary words
    // (web-start-page.com is not Startpage).
    for (const m of ix.marks) {
      if (m.parts.length !== 1) continue;
      for (let i = 0; i < tokSk.length; i++) {
        let joined = tokSk[i];
        for (let j = i + 1; j < tokSk.length && joined.length < m.skel.length; j++) {
          joined += tokSk[j];
          if (joined !== m.skel || (i === 0 && j === tokSk.length - 1)) continue;
          if (tokSk.some((t, k) => (k < i || k > j) && ix.strong.has(t))) return found(m, 'combo');
        }
      }
    }
    // A slip or digits in the name, next to a lure word (paypall-login.com, vipp5-refusjon.com).
    for (const m of ix.marks) {
      for (let k = 0; k < tokSk.length; k++) {
        if (ix.realWords.has(tokSk[k]) || !slipFor(tokSk[k], m)) continue;
        if (tokSk.some((t, x) => x !== k && ix.strong.has(t))) return found(m, 'combo');
      }
    }
  }
  for (const m of ix.marks) {
    for (const w of ix.concat) {
      if (sk === m.skel + w || sk === w + m.skel) return found(m, 'combo');
    }
  }
  // 3. One typing slip from a distinct mark; for an international name, once its letters are read
  // as the Latin ones they look like (paypa<dotless i>.com, p<Cyrillic a>yp<Cyrillic a>ll under .rf).
  if (!realWord) {
    if (!unicode && /^[a-z0-9]+$/.test(label)) {
      for (const m of ix.marks) {
        if (m.kind !== 'distinct' || m.flat.length < 5) continue;
        const kind = typoKind(label, m.flat);
        if (kind) return found(m, 'typo', kind);
      }
    }
    if (unicode && /^[a-z0-9]+$/.test(sk)) {
      for (const m of ix.marks) {
        if (m.kind !== 'distinct' || m.flat.length < 5) continue;
        if (typoKind(sk, m.flat)) return found(m, 'letters', letterPairs(labelU, m.flat));
      }
    }
  }
  // 4. The part before the registrable name: a brand's own domain written into it, or its name.
  if (sub.length) {
    const subSk = sub.map((l) => skeleton(latinised(decodeLabel(l))));
    const split = (l) => l.split(/[-_]/).filter(Boolean);
    // A hyphen or an underscore can stand in for the dot (paypal-com.evil.io, www.paypal_com.evil.io).
    const dotted = subSk.flatMap(split);
    const written = (r, at, extra = {}) => {
      const m = ix.marks.find((x) => x.brand === r.brand && x.own === r.domain) || ix.marks.find((x) => x.brand === r.brand);
      return { brand: r.brand.name, own: r.domain, mark: m ? m.label : null, how: 'written', kind: 'written', detail: at === 0 ? 'start' : 'inside', ...base, ...extra };
    };
    for (const r of ix.runs) {
      const at = runAt(subSk, r.labels);
      if (at >= 0) return written(r, at);
      const atD = runAt(dotted, r.labels);
      if (atD >= 0) return written(r, atD);
    }
    // Split across the last dot: www.dnb.no-sikkerhet.com reads as www.dnb.no and more, but
    // belongs to no-sikkerhet.com.
    const seq = [...dotted, ...tokSk];
    for (const r of ix.runs) {
      if (!r.mark) continue;
      for (let i = Math.max(0, dotted.length - r.labels.length + 1); i < dotted.length; i++) {
        if (r.labels.every((w, k) => seq[i + k] === w)) return written(r, i);
      }
    }
    // A mark followed by a country ending (www.amazon.co.uk.evil.io, amazon.de.evil.io). A word
    // mark counts only near the start of the address, where a reader looks for the name.
    for (let i = 0; i < subSk.length - 1; i++) {
      const m = ix.marks.find((x) => x.label === subSk[i] || x.skel === subSk[i]);
      if (!m || (m.kind !== 'distinct' && i > 1)) continue;
      for (let j = i + 1; j < subSk.length; j++) {
        const sfx = icannSuffix(subSk.slice(i + 1, j + 1));
        if (!sfx) continue;
        const last = sfx.slice(sfx.lastIndexOf('.') + 1);
        if (!/^[a-z]{2}$/.test(last) || (m.kind !== 'distinct' && VANITY.has(last))) continue;
        return { brand: m.brand.name, own: m.own, mark: m.label, how: 'written', kind: 'written', detail: i === 0 ? 'start' : 'inside', ...base, shown: `${m.label}.${sfx}` };
      }
    }
    // The name in one of these parts: a distinct mark, or a word mark with a lure word in its own
    // part or, near the start of the address, in the part right after it (amazon.signin.evil.io;
    // a lure before the name, as in secure.booking.example.com, is how sites name their pages).
    for (let li = 0; li < subSk.length; li++) {
      const parts = split(subSk[li]);
      const next = li <= 1 ? (li + 1 < subSk.length ? split(subSk[li + 1]) : tokSk) : [];
      for (const m of ix.marks) {
        const at = runAt(parts, m.parts);
        if (at < 0) continue;
        const others = parts.filter((_, k) => k < at || k >= at + m.parts.length);
        if (m.kind === 'distinct' || others.some((t) => ix.strong.has(t)) || next.some((t) => ix.strong.has(t))) return found(m, 'mentions');
      }
    }
    // The name written less plainly: split by hyphens (pay-pal.com.evil.io), run together with a
    // lure word or its own ending (paypallogin.evil.io, paypalcom.evil.io), or with a slip before
    // its ending (gooogle.com.evil.io).
    const flat = subSk.map((l) => l.replace(/[-_]/g, ''));
    for (const r of ix.runs) {
      if (r.mark && (runAt(flat, r.labels) >= 0 || flat.includes(r.labels.join('')))) return found(r.mark, 'mentions');
      if (!r.mark) continue;
      for (let i = 0; i + r.labels.length <= dotted.length; i++) {
        if (slipFor(dotted[i], r.mark) && !ix.realWords.has(dotted[i]) && r.labels.slice(1).every((w, k) => dotted[i + 1 + k] === w)) return found(r.mark, 'mentions');
      }
    }
    for (const l of flat) {
      for (const m of ix.marks) {
        if (ix.concat.some((w) => l === m.skel + w || l === w + m.skel)) return found(m, 'mentions');
      }
    }
  }
  return null;
}

export function lookAlike(host) {
  const h = norm(host);
  const brand = brandMatch(h);
  let letters = lettersFinding(h);
  // A whole-alphabet name under an ending in the same alphabet is ordinary there, unless it
  // passes for a listed brand.
  if (letters && letters.ordinary && !(brand && brand.kind === 'letters')) letters = null;
  return { letters, symbol: symbolFinding(h), brand };
}

// == the sentences ==

// British style: the possessive of a name ending in s takes 's too (Vipps's, Threads's).
const possessive = (name) => `${name}'s`;

// A host as a person reads it, with the form the browser uses after it when that differs:
// "p<Cyrillic a>ypal.com (in the browser's form, xn--pypal-4ve.com)".
export function bothForms(host) {
  const h = norm(host);
  const shown = decodeHost(h);
  return shown === h ? h : `${shown} (in the browser's form, ${h})`;
}

// A host as a person reads it, with every run of letters from another alphabet in the owner's
// part of the name (not the ending) named in brackets: p[Cyrillic а]ypal.com. Such a name
// looks exactly like the real one on screen; named, it no longer does.
export function markedHost(host) {
  const h = norm(host);
  const labels = h.split('.');
  const own = labels.length - suffixLabels(h);
  return labels.map((l, i) => {
    const d = decodeLabel(l);
    if (d === l || i >= own) return d;
    let out = '';
    let run = '';
    let runScript = null;
    const flush = () => {
      if (run) out += `[${runScript} ${run}]`;
      run = '';
      runScript = null;
    };
    for (const ch of d) {
      const sc = scriptOf(ch);
      const foreign = sc && sc !== 'Latin' && !CJK.has(sc) ? scriptWord(sc) : null;
      if (foreign && foreign === runScript) run += ch;
      else if (foreign) {
        flush();
        run = ch;
        runScript = foreign;
      } else {
        flush();
        out += ch;
      }
    }
    flush();
    return out;
  }).join('.');
}

// The same with the browser's form after it: "p[Cyrillic а]ypal.com (in the browser's form,
// xn--pypal-4ve.com)".
function markedForms(host) {
  const h = norm(host);
  const shown = markedHost(h);
  return shown === h ? h : `${shown} (in the browser's form, ${h})`;
}

// The registrable domain, decoded, with the full name after it when the host is longer, and the
// browser's form when the name is international.
function ownerText(f, placeName) {
  if (!f.written) return f.host === `www.${f.domain}` ? f.domain : placeName(f.host);
  const reg = decodeHost(f.domain);
  const full = decodeHost(f.host);
  const both = full === reg || full === `www.${reg}` ? reg : `${reg} (full name: ${full})`;
  return `${both}, in the browser's form ${f.host}`;
}

const TYPO = {
  doubled: 'with a letter doubled',
  missing: 'with a letter left out',
  swapped: 'with two letters swapped',
  neighbour: 'with a letter changed to the one next to it on the keyboard',
  'l-for-i': 'with a small l in place of an i',
  'i-for-l': 'with an i in place of a small l',
};

export function brandText(f, placeName) {
  const own = `${possessive(f.brand)} own address is ${f.own}.`;
  const owner = ownerText(f, placeName);
  switch (f.how) {
    case 'letters': return `This address is made to look like ${f.own}, ${f.detail ? `with ${f.detail}` : 'using letters that only look the same'}: it is ${owner}. ${own}`;
    case 'ascii': return `This address is made to look like ${f.own}, with ${f.detail}: it is ${owner}. ${own}`;
    case 'hyphen': return `This address is made to look like ${f.own}, with a hyphen put in: it is ${owner}. ${own}`;
    case 'typo': return `This address is one slip away from ${f.own}, ${TYPO[f.detail]}: it is ${owner}. ${own}`;
    case 'combo': return `This address mentions ${f.brand}, but it belongs to ${owner}, which is not one of ${possessive(f.brand)} addresses that CheckLink knows. ${own}`;
    case 'free-host': return `This address mentions ${f.brand}, but it belongs to ${owner}, a name under ${f.suffix} that anyone can create. ${own}`;
    case 'written': return `This address has ${f.shown || f.own} written ${f.detail === 'start' ? 'at its start' : 'inside it'}, but it belongs to ${owner}. ${own}`;
    case 'mentions':
    default: return `This address mentions ${f.brand}, but it belongs to ${owner}. ${own}`;
  }
}

// One short sentence for the first screen and for screen readers; the full note says the rest.
export function brandShort(f) {
  switch (f.how) {
    case 'letters':
    case 'ascii':
    case 'hyphen':
    case 'typo': return `This address is made to look like ${f.own}.`;
    case 'free-host': return `This address mentions ${f.brand}, but it is a name under ${f.suffix} that anyone can create.`;
    case 'written': return `This address has ${f.shown || f.own} written in it, but it belongs to ${decodeHost(f.domain)}.`;
    case 'combo': return `This address mentions ${f.brand}, but it is not one of ${possessive(f.brand)} addresses that CheckLink knows.`;
    case 'mentions':
    default: return `This address mentions ${f.brand}, but it belongs to ${decodeHost(f.domain)}.`;
  }
}

const listWords = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);

export function lettersText(f, brand = null) {
  const scripts = listWords(f.scripts.map(scriptWord));
  const shown = markedForms(f.host);
  const lead = f.reads !== null
    ? `This address ${f.whole ? 'is written in' : 'has'} ${scripts} letters that look like Latin ones. It reads like ${f.reads}, but it is a different address: ${shown}.`
    : `This address mixes letters from different alphabets (${listWords(['Latin', ...f.scripts.map(scriptWord)])}) in one name, which ordinary names do not do. It goes to ${shown}.`;
  const tail = brand && brand.kind === 'letters' ? ` It is made to look like ${possessive(brand.brand)} own address, ${brand.own}.` : '';
  return `${lead}${tail}`;
}

export function lettersShort(f, brand = null) {
  if (brand && brand.kind === 'letters') return `This address is made to look like ${brand.own}.`;
  if (f.reads !== null) return `This address uses letters from another alphabet to look like ${f.reads}.`;
  return 'This address mixes letters from different alphabets in one name.';
}

const symbolKinds = (f) => [...new Set(f.chars.map((c) => SYMBOL_WORDS[c.looks] || `"${c.looks}"`))];

export function symbolText(f, brand = null) {
  const kinds = symbolKinds(f);
  const codes = [...new Set(f.chars.map((c) => c.code))];
  // Where it belongs, when the name is longer than its registrable domain (a slash look-alike
  // U+2215 makes www.paypal.com<U+2215>signin.evil.io read as an address on paypal.com).
  const reg = domainInfo(f.host);
  const longer = reg && reg.domain && f.host !== reg.domain && f.host !== `www.${reg.domain}`;
  const goes = longer ? ` It belongs to ${bothForms(reg.domain)}.` : '';
  const tail = brand && brand.kind === 'letters' ? ` It is made to look like ${possessive(brand.brand)} own address, ${brand.own}.` : '';
  // The look-alike character is shown by its code, since on screen it cannot be told apart.
  const flagged = new Set(f.chars.map((c) => c.char));
  const marked = Array.from(decodeHost(f.host), (ch) => (flagged.has(ch) ? `[${f.chars.find((c) => c.char === ch).code}]` : ch)).join('');
  return `This address has a character that looks like ${listWords(kinds)} but is not one (${codes.join(', ')}), inside the name. It reads like ${f.reads}, but it is a different address: ${marked} (in the browser's form, ${f.host}).${goes}${tail}`;
}

export function symbolShort(f, brand = null) {
  if (brand && brand.kind === 'letters') return `This address is made to look like ${brand.own}.`;
  return `This address has a character that only looks like ${listWords(symbolKinds(f))}, so it reads like ${f.reads}.`;
}
